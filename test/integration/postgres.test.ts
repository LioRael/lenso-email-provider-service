import { randomUUID } from "node:crypto";

import { verifyProviderInvocationStoreConformance } from "@lenso/service-kit";
import type { ProviderV1Outcome } from "@lenso/service-kit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DispatchEngine } from "../../src/dispatch.js";
import { migrate } from "../../src/migrate.js";
import { ingestAuthenticatedReceipt } from "../../src/receipts.js";
import { PostgresEmailLedger, PostgresProviderInvocationStore } from "../../src/store/postgres.js";
import { FakeEmailTransport } from "../../src/transports/fake.js";
import { dispatchFixture } from "../fixtures.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const postgres = databaseUrl ? describe : describe.skip;

postgres("Postgres durability", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => migrate(databaseUrl!));
  afterAll(async () => pool.end());

  test("passes the public Provider invocation Store conformance vector", async () => {
    const result = await verifyProviderInvocationStoreConformance({
      createStore: () => new PostgresProviderInvocationStore(pool),
      invocationId: `email-provider-conformance-${randomUUID()}`,
    });
    expect(result.outcomeDigest).toMatch(/^sha256:/u);
  }, 20_000);

  test("does not allow one durable pending outcome to be rebound", async () => {
    const store = new PostgresProviderInvocationStore(pool);
    const invocationId = `email-provider-pending-${randomUUID()}`;
    const outcome = (digest: string): ProviderV1Outcome => ({
      effectEvidence: [],
      error: null,
      hostEffects: { events: [], runtimeFunctionRequests: [] },
      invocationId,
      outcomeDigest: digest,
      protocol: "lenso.provider.v1",
      result: null,
      status: "pending",
    });
    const first = outcome(`sha256:${"1".repeat(64)}`);
    const second = outcome(`sha256:${"2".repeat(64)}`);
    const now = "2026-08-13T00:00:00.000Z";
    await store.claim({ invocationId, now, pendingOutcome: first, requestDigest: `sha256:${"3".repeat(64)}` });
    await store.complete({ invocationId, now, outcome: first, requestDigest: `sha256:${"3".repeat(64)}` });
    await expect(store.complete({ invocationId, now, outcome: second, requestDigest: `sha256:${"3".repeat(64)}` })).rejects.toThrow("pending outcome cannot be rebound");
    await expect(store.get(invocationId)).resolves.toMatchObject({ outcome: first, phase: "pending" });
  }, 20_000);

  test("recovers a committed transport observation and receipt through fresh adapters", async () => {
    const suffix = randomUUID();
    const request = dispatchFixture({
      attemptId: `attempt-${suffix}`,
      deliveryId: `delivery-${suffix}`,
      functionRunId: `function-${suffix}`,
      idempotencyKey: `invitation-${suffix}`,
    });
    const transport = new FakeEmailTransport(["accepted"]);
    const first = new DispatchEngine({
      leaseMs: 30_000,
      ledger: new PostgresEmailLedger(pool),
      providerName: "fixture",
      transport,
    });
    const observation = await first.dispatch(request);
    const restartedLedger = new PostgresEmailLedger(pool);
    const restarted = new DispatchEngine({
      leaseMs: 30_000,
      ledger: restartedLedger,
      providerName: "fixture",
      transport,
    });
    await expect(restarted.dispatch(request)).resolves.toEqual(observation);
    expect(transport.sends).toBe(1);

    const input = {
      authentication: {
        keyReference: "secret/test/email-receipt",
        mechanism: "fixture" as const,
        verified: true as const,
        verifiedAt: "2026-08-13T00:03:00Z",
      },
      businessAttemptId: request.functionRunId,
      evidence: { status: "delivered" },
      kind: "delivered" as const,
      observedAt: "2026-08-13T00:03:00Z",
      remoteId: `receipt-${suffix}`,
      source: "fixture",
    };
    const inserted = await ingestAuthenticatedReceipt(restartedLedger, input);
    await expect(ingestAuthenticatedReceipt(new PostgresEmailLedger(pool), input)).resolves.toEqual({ ...inserted, kind: "replay" });
    await expect(new PostgresEmailLedger(pool).getLatestReceipt(request.functionRunId)).resolves.toMatchObject({ kind: "delivered", remoteId: input.remoteId });
  }, 20_000);
});
