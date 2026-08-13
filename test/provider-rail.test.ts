import { createMemoryProviderInvocationStore, serveService } from "@lenso/service-kit";
import { afterEach, describe, expect, test } from "vitest";

import { DISPATCH_EVENT, DISPATCH_FUNCTION } from "../src/contracts.js";
import { DispatchEngine } from "../src/dispatch.js";
import { createHandlers } from "../src/handlers.js";
import {
  emailContractBundleDigest,
  manifestDigest,
  MODULE_ID,
  moduleReleaseDigest,
  providerV1Base,
  service,
  serviceReleaseDigest,
} from "../src/service.js";
import { FakeEmailTransport } from "../src/transports/fake.js";
import { dispatchFixture } from "./fixtures.js";
import { MemoryEmailLedger } from "./support/memory-ledger.js";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const invocation = (input: {
  invocationId: string;
  operationKind: "event_handler" | "runtime_function";
  operationName: string;
  payload: unknown;
}) => ({
  actor: { kind: "system" as const },
  attempt: 1,
  causationId: null,
  contentType: "application/json",
  correlationId: "correlation-1",
  deadline: "2099-01-01T00:00:00.000Z",
  exportKey: "email-delivery",
  inputContractDigest: emailContractBundleDigest,
  invocationId: input.invocationId,
  manifestDigest,
  mode: "durable" as const,
  moduleReleaseDigest,
  operationKind: input.operationKind,
  operationName: input.operationName,
  operationVersion: "1",
  outputContractDigest: emailContractBundleDigest,
  payload: input.payload,
  protocol: "lenso.provider.v1" as const,
  requestId: `request-${input.invocationId}`,
  serviceReleaseDigest,
  tenantId: "tenant-1",
  trace: {},
});

describe("real Provider V1 rail", () => {
  test("turns a Notification outbox Event into a Host function request and a durable observation Event", async () => {
    const ledger = new MemoryEmailLedger();
    const transport = new FakeEmailTransport(["delivered"]);
    const handlers = createHandlers(
      new DispatchEngine({ leaseMs: 30_000, ledger, providerName: "fixture", transport }),
      ledger,
    );
    const served = await serveService(service, {
      modules: { [MODULE_ID]: handlers },
      port: 0,
      providerV1: {
        ...providerV1Base,
        invocationStore: createMemoryProviderInvocationStore(),
        runtimeInstanceId: "email-provider-test",
      },
    });
    servers.push(served);
    const base = `${new URL(served.baseUrl).origin}/lenso/provider/v1`;
    const request = dispatchFixture();
    const eventPayload = {
      actor: { kind: "system" },
      aggregate_id: request.deliveryId,
      aggregate_type: "notification_delivery",
      causation_id: null,
      correlation_id: request.context.correlationId,
      event_name: DISPATCH_EVENT,
      event_version: 1,
      handler_name: "email.dispatch-requested.v1",
      headers: { tenant_id: "tenant-1" },
      occurred_at: "2026-08-13T00:00:00.000Z",
      outbox_event_id: "outbox-1",
      payload: request,
      request_id: "event-request-1",
      source_module: "lenso/notification",
      trace: {},
    };
    const eventResponse = await fetch(`${base}/exports/email-delivery/events:handle`, {
      body: JSON.stringify(invocation({ invocationId: "provider-event-1", operationKind: "event_handler", operationName: "email.dispatch-requested.v1", payload: eventPayload })),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(eventResponse.status).toBe(200);
    const eventOutcome = await eventResponse.json() as {
      hostEffects: { runtimeFunctionRequests: Array<{ functionName: string; input: unknown; requestId: string }> };
    };
    expect(eventOutcome.hostEffects.runtimeFunctionRequests).toHaveLength(1);
    expect(eventOutcome.hostEffects.runtimeFunctionRequests[0]).toMatchObject({
      functionName: DISPATCH_FUNCTION,
      input: request,
      requestId: request.functionRunId,
      tenantId: "tenant-1",
    });

    const runtimePayload = {
      actor: { kind: "system" },
      attempt: 1,
      correlation_id: request.context.correlationId,
      function_name: DISPATCH_FUNCTION,
      function_run_id: request.functionRunId,
      input: request,
      request_id: eventOutcome.hostEffects.runtimeFunctionRequests[0]!.requestId,
      trace: {},
    };
    const runtimeInvocation = invocation({ invocationId: "provider-runtime-1", operationKind: "runtime_function", operationName: DISPATCH_FUNCTION, payload: runtimePayload });
    const invokeRuntime = () => fetch(`${base}/exports/email-delivery/runtime:invoke`, {
      body: JSON.stringify(runtimeInvocation),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const runtimeResponse = await invokeRuntime();
    expect(runtimeResponse.status).toBe(200);
    const runtimeOutcome = await runtimeResponse.json() as {
      hostEffects: { events: Array<{ eventName: string; payload: unknown }> };
      outcomeDigest: string;
      result: { output: { outcome: string } };
    };
    expect(runtimeOutcome.result.output.outcome).toBe("accepted");
    expect(runtimeOutcome.hostEffects.events[0]).toMatchObject({
      eventName: "lenso.email.dispatch-observed.v1",
      payload: { deliveryId: request.deliveryId, outcome: "accepted" },
    });
    expect(runtimeOutcome.hostEffects.events[1]).toMatchObject({
      eventName: "lenso.email.receipt-observed.v1",
      payload: { deliveryId: request.deliveryId, kind: "delivered" },
    });

    const replay = await invokeRuntime();
    await expect(replay.json()).resolves.toEqual(runtimeOutcome);
    expect(transport.sends).toBe(1);

    const recovered = await fetch(`${base}/invocations/provider-runtime-1`);
    await expect(recovered.json()).resolves.toEqual(runtimeOutcome);
    const ack = await fetch(`${base}/invocations/provider-runtime-1:ack`, {
      body: JSON.stringify({ invocationId: "provider-runtime-1", outcomeDigest: runtimeOutcome.outcomeDigest }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(ack.status).toBe(200);
  });

  test("never upgrades a malformed Event actor into a Host Runtime identity", async () => {
    const ledger = new MemoryEmailLedger();
    const handlers = createHandlers(
      new DispatchEngine({ leaseMs: 30_000, ledger, providerName: "fixture", transport: new FakeEmailTransport() }),
      ledger,
    );
    const served = await serveService(service, {
      modules: { [MODULE_ID]: handlers },
      port: 0,
      providerV1: {
        ...providerV1Base,
        invocationStore: createMemoryProviderInvocationStore(),
        runtimeInstanceId: "email-provider-actor-test",
      },
    });
    servers.push(served);
    const request = dispatchFixture();
    const base = `${new URL(served.baseUrl).origin}/lenso/provider/v1`;
    const response = await fetch(`${base}/exports/email-delivery/events:handle`, {
      body: JSON.stringify(invocation({
        invocationId: "provider-event-invalid-actor",
        operationKind: "event_handler",
        operationName: "email.dispatch-requested.v1",
        payload: {
          actor: { kind: "service", scopes: ["email.dispatch"] },
          aggregate_id: request.deliveryId,
          aggregate_type: "notification_delivery",
          correlation_id: request.context.correlationId,
          event_name: DISPATCH_EVENT,
          event_version: 1,
          handler_name: "email.dispatch-requested.v1",
          headers: { tenant_id: "tenant-1" },
          occurred_at: "2026-08-13T00:00:00.000Z",
          outbox_event_id: "outbox-invalid-actor",
          payload: request,
          request_id: "event-request-invalid-actor",
          source_module: "lenso/notification",
          trace: {},
        },
      })),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const outcome = await response.json() as { hostEffects: { runtimeFunctionRequests: unknown[] }; status: string };
    expect(outcome.status).toBe("failed");
    expect(outcome.hostEffects.runtimeFunctionRequests).toEqual([]);
  });
});
