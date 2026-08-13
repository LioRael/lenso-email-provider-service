import {
  providerFailed,
  providerRejected,
  providerSucceeded,
  type ModuleEventHandlerContext,
  type ModuleRuntimeHandlerContext,
  type ProviderActorContext,
  type ProviderV1HostEventEffect,
  type ProviderV1TraceContext,
} from "@lenso/service-kit";

import { stableId } from "./canonical.js";
import {
  assertDispatchEvent,
  DISPATCH_FUNCTION,
  DISPATCH_OBSERVED_EVENT,
  parseDispatchRequested,
  RECEIPT_CHECK_EVENT,
  RECEIPT_CHECK_FUNCTION,
  RECEIPT_OBSERVED_EVENT,
  type EmailDispatchObserved,
  type EmailDispatchRequested,
  type EmailReceiptObserved,
} from "./contracts.js";
import { DispatchEngine } from "./dispatch.js";
import { DispatchIdentityConflictError, type EmailLedger } from "./store/email-ledger.js";
import { TransportTechnicalFailure } from "./transports/email-transport.js";
import { MODULE_ID } from "./service.js";

const actor = (value: unknown): ProviderActorContext => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Partial<ProviderActorContext>;
    if (candidate.kind === "anonymous" || candidate.kind === "system") return { kind: candidate.kind };
    if (candidate.kind === "user" && typeof candidate.user_id === "string" && Array.isArray(candidate.scopes) && candidate.scopes.every((scope) => typeof scope === "string")) {
      return { kind: "user", scopes: candidate.scopes, user_id: candidate.user_id };
    }
    if (candidate.kind === "service" && typeof candidate.service_id === "string" && Array.isArray(candidate.scopes) && candidate.scopes.every((scope) => typeof scope === "string")) {
      return { kind: "service", scopes: candidate.scopes, service_id: candidate.service_id };
    }
  }
  throw new TypeError("Host Event actor context is invalid");
};

const trace = (value: unknown): ProviderV1TraceContext => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as ProviderV1TraceContext;
  return {
    ...(typeof input.trace_id === "string" ? { trace_id: input.trace_id } : {}),
    ...(typeof input.span_id === "string" ? { span_id: input.span_id } : {}),
    ...(Array.isArray(input.baggage) && input.baggage.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"))
      ? { baggage: input.baggage }
      : {}),
  };
};

const tenant = (headers: unknown): string | null =>
  typeof (headers as { tenant_id?: unknown } | null)?.tenant_id === "string"
    ? (headers as { tenant_id: string }).tenant_id
    : null;

const dispatchHostEvent = (observation: EmailDispatchObserved, request: EmailDispatchRequested): ProviderV1HostEventEffect => ({
  aggregateId: observation.deliveryId,
  aggregateType: "notification_delivery",
  causationId: observation.functionRunId,
  correlationId: request.context.correlationId,
  eventId: stableId("evt", { event: DISPATCH_OBSERVED_EVENT, observation }),
  eventName: DISPATCH_OBSERVED_EVENT,
  eventVersion: 1,
  headers: { contentType: "application/json", schema: DISPATCH_OBSERVED_EVENT },
  occurredAt: observation.observedAt,
  payload: observation,
  sourceModule: MODULE_ID,
});

const receiptHostEvent = (receipt: EmailReceiptObserved, correlationId: string): ProviderV1HostEventEffect => ({
  aggregateId: receipt.deliveryId,
  aggregateType: "notification_delivery",
  causationId: receipt.functionRunId,
  correlationId,
  eventId: stableId("evt", { event: RECEIPT_OBSERVED_EVENT, receipt }),
  eventName: RECEIPT_OBSERVED_EVENT,
  eventVersion: 1,
  headers: { contentType: "application/json", schema: RECEIPT_OBSERVED_EVENT },
  occurredAt: receipt.observedAt,
  payload: receipt,
  sourceModule: MODULE_ID,
});

const receiptCheckInput = (value: unknown): { functionRunId: string; correlationId: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("receipt check input must be an object");
  const input = value as { functionRunId?: unknown; correlationId?: unknown };
  if (typeof input.functionRunId !== "string" || !input.functionRunId.trim()) throw new TypeError("functionRunId is required");
  if (typeof input.correlationId !== "string" || !input.correlationId.trim()) throw new TypeError("correlationId is required");
  return { correlationId: input.correlationId, functionRunId: input.functionRunId };
};

export const createHandlers = (engine: DispatchEngine, ledger: EmailLedger) => ({
  events: {
    "email.dispatch-requested.v1": async ({ event }: ModuleEventHandlerContext) => {
      const request = assertDispatchEvent(event.event_name, event.event_version, event.payload);
      if (request.context.correlationId !== event.correlation_id) {
        throw new TypeError("dispatch correlationId must match the Host Event envelope");
      }
      return providerSucceeded(
        { actions: [] },
        {
          effectEvidence: [{ attemptId: request.attemptId, deliveryId: request.deliveryId, kind: "email_dispatch_enqueued" }],
          hostEffects: {
            runtimeFunctionRequests: [
              {
                actor: actor(event.actor),
                causationId: event.outbox_event_id,
                correlationId: event.correlation_id,
                functionName: DISPATCH_FUNCTION,
                input: request,
                maxAttempts: 5,
                requestId: request.functionRunId,
                tenantId: tenant(event.headers),
                trace: trace(event.trace),
              },
            ],
          },
        },
      );
    },
    "email.receipt-check-requested.v1": async ({ event }: ModuleEventHandlerContext) => {
      if (event.event_name !== RECEIPT_CHECK_EVENT || event.event_version !== 1) throw new TypeError(`expected ${RECEIPT_CHECK_EVENT} version 1`);
      const input = receiptCheckInput(event.payload);
      return providerSucceeded(
        { actions: [] },
        {
          effectEvidence: [{ functionRunId: input.functionRunId, kind: "email_receipt_check_enqueued" }],
          hostEffects: {
            runtimeFunctionRequests: [
              {
                actor: actor(event.actor),
                causationId: event.outbox_event_id,
                correlationId: event.correlation_id,
                functionName: RECEIPT_CHECK_FUNCTION,
                input,
                maxAttempts: 3,
                requestId: stableId("email_receipt_check", { eventId: event.outbox_event_id, functionRunId: input.functionRunId }),
                tenantId: tenant(event.headers),
                trace: trace(event.trace),
              },
            ],
          },
        },
      );
    },
  },
  runtime: {
    [DISPATCH_FUNCTION]: async ({ input, invocation }: ModuleRuntimeHandlerContext) => {
      let request: EmailDispatchRequested;
      try {
        request = parseDispatchRequested(input);
        if (
          request.functionRunId !== invocation.function_run_id ||
          request.context.correlationId !== invocation.correlation_id
        ) {
          return providerRejected({
            code: "email_dispatch_context_conflict",
            message: "Email dispatch identity does not match the Host Runtime envelope",
          });
        }
        const observation = await engine.dispatch(request);
        const receipt = await ledger.getLatestReceipt(request.functionRunId);
        return providerSucceeded(observation, {
          effectEvidence: [
            {
              attemptId: observation.attemptId,
              deliveryId: observation.deliveryId,
              kind: "email_dispatch_observation",
              outcome: observation.outcome,
              ...(observation.remoteReceipt ? { remoteReceipt: observation.remoteReceipt } : {}),
            },
          ],
          hostEffects: {
            events: [
              dispatchHostEvent(observation, request),
              ...(receipt ? [receiptHostEvent(receipt, request.context.correlationId)] : []),
            ],
          },
        });
      } catch (error) {
        if (error instanceof DispatchIdentityConflictError) {
          return providerRejected({
            code: "email_dispatch_identity_conflict",
            message: "Email business attempt identity is bound to different content",
          });
        }
        if (error instanceof TransportTechnicalFailure) {
          return providerFailed({
            code: error.code,
            message: "Email transport could not establish a business outcome",
            retryAfterMs: error.retryAfterMs,
            retryable: error.retryable,
          });
        }
        return providerRejected({ code: "invalid_email_dispatch", message: "Email dispatch payload is invalid" });
      }
    },
    [RECEIPT_CHECK_FUNCTION]: async ({ input }: ModuleRuntimeHandlerContext) => {
      try {
        const query = receiptCheckInput(input);
        const receipt = await ledger.getLatestReceipt(query.functionRunId);
        if (!receipt) return providerSucceeded({ found: false, functionRunId: query.functionRunId });
        return providerSucceeded(
          { found: true, receipt },
          {
            effectEvidence: [{ digest: receipt.digest, kind: "email_remote_receipt", remoteId: receipt.remoteId, source: receipt.source }],
            hostEffects: { events: [receiptHostEvent(receipt, query.correlationId)] },
          },
        );
      } catch {
        return providerRejected({ code: "invalid_receipt_check", message: "Email receipt check input is invalid" });
      }
    },
  },
});
