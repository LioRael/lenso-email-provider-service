import { describe, expect, test } from "vitest";

import { DispatchEngine } from "../src/dispatch.js";
import { ingestAuthenticatedReceipt } from "../src/receipts.js";
import { FakeEmailTransport } from "../src/transports/fake.js";
import { dispatchFixture } from "./fixtures.js";
import { MemoryEmailLedger } from "./support/memory-ledger.js";

describe("authenticated receipt ingestion seam", () => {
  test("deduplicates verified evidence and fails closed on replay mutation", async () => {
    const ledger = new MemoryEmailLedger();
    await new DispatchEngine({ leaseMs: 1_000, ledger, providerName: "fixture", transport: new FakeEmailTransport(["accepted"]) }).dispatch(dispatchFixture());
    const receipt = {
      authentication: {
        keyReference: "secret/email/webhook-key-1",
        mechanism: "webhook_signature" as const,
        verified: true as const,
        verifiedAt: "2026-08-13T00:01:00Z",
      },
      businessAttemptId: "function-run-1",
      evidence: { eventType: "delivered" },
      kind: "delivered" as const,
      observedAt: "2026-08-13T00:01:00Z",
      remoteId: "receipt-1",
      source: "fixture-vendor",
    };
    const inserted = await ingestAuthenticatedReceipt(ledger, receipt);
    const replay = await ingestAuthenticatedReceipt(ledger, receipt);
    const conflict = await ingestAuthenticatedReceipt(ledger, { ...receipt, kind: "bounced" as const });
    expect(inserted.kind).toBe("inserted");
    expect(replay).toEqual({ ...inserted, kind: "replay" });
    expect(conflict.kind).toBe("conflict");
    await expect(ledger.getLatestReceipt("function-run-1")).resolves.toMatchObject({ kind: "delivered", remoteId: "receipt-1" });
  });

  test("rejects unverified or oversized receipt material", async () => {
    const ledger = new MemoryEmailLedger();
    const invalid = {
      authentication: {
        keyReference: "key",
        mechanism: "fixture" as const,
        verified: false,
        verifiedAt: "2026-08-13T00:01:00Z",
      },
      businessAttemptId: "attempt",
      evidence: {},
      kind: "delivered" as const,
      observedAt: "2026-08-13T00:01:00Z",
      remoteId: "remote",
      source: "fixture",
    };
    await expect(ingestAuthenticatedReceipt(ledger, invalid as never)).rejects.toThrow("verified");
  });
});
