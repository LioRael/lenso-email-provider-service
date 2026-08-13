import { canonicalDigest } from "./canonical.js";
import type { EmailDispatchObserved, EmailDispatchRequested } from "./contracts.js";
import { DispatchIdentityConflictError, type EmailLedger } from "./store/email-ledger.js";
import type { EmailTransport } from "./transports/email-transport.js";
import { TransportTechnicalFailure } from "./transports/email-transport.js";

export class DispatchInProgressError extends TransportTechnicalFailure {
  constructor(retryAfterMs: number) {
    super("dispatch_in_progress", true, retryAfterMs);
    this.name = "DispatchInProgressError";
  }
}

export interface DispatchEngineOptions {
  ledger: EmailLedger;
  transport: EmailTransport;
  providerName: string;
  leaseMs: number;
  clock?: () => Date;
}

export class DispatchEngine {
  private readonly clock: () => Date;

  constructor(private readonly options: DispatchEngineOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async dispatch(request: EmailDispatchRequested): Promise<EmailDispatchObserved> {
    const eventDigest = canonicalDigest(request);
    const now = this.clock().toISOString();
    const claim = await this.options.ledger.claimDispatch({
      eventDigest,
      leaseMs: this.options.leaseMs,
      now,
      request,
      transport: this.options.transport.name,
    });
    if (claim.kind === "conflict") throw new DispatchIdentityConflictError();
    if (claim.kind === "replay") {
      if (!claim.record.observation) throw new Error("observed dispatch is missing its observation");
      return claim.record.observation;
    }
    if (claim.kind === "in_progress") throw new DispatchInProgressError(claim.retryAfterMs);

    if (claim.kind === "expired") {
      const observation: EmailDispatchObserved = {
        attemptId: request.attemptId,
        deliveryId: request.deliveryId,
        functionRunId: request.functionRunId,
        observedAt: now,
        outcome: "delivery_unknown",
        provider: this.options.providerName,
        remoteReceipt: null,
        failure: { classification: "ambiguous", code: "transport_lease_expired", retryAfterMs: null },
      };
      await this.options.ledger.completeDispatch({
        businessAttemptId: request.functionRunId,
        eventDigest,
        leaseToken: claim.leaseToken,
        now,
        observation,
      });
      return observation;
    }

    let transportObservation;
    try {
      transportObservation = await this.options.transport.send(request);
    } catch (error) {
      if (error instanceof TransportTechnicalFailure) {
        await this.options.ledger.recordTechnicalFailure({
          businessAttemptId: request.functionRunId,
          eventDigest,
          leaseToken: claim.leaseToken,
          now: this.clock().toISOString(),
        });
        throw error;
      }
      const unknownObservation: EmailDispatchObserved = {
        attemptId: request.attemptId,
        deliveryId: request.deliveryId,
        failure: {
          classification: "ambiguous",
          code: "transport_outcome_unknown",
          retryAfterMs: null,
        },
        functionRunId: request.functionRunId,
        observedAt: this.clock().toISOString(),
        outcome: "delivery_unknown",
        provider: this.options.providerName,
        remoteReceipt: null,
      };
      await this.options.ledger.completeDispatch({
        businessAttemptId: request.functionRunId,
        eventDigest,
        leaseToken: claim.leaseToken,
        now: this.clock().toISOString(),
        observation: unknownObservation,
      });
      return unknownObservation;
    }
    const observation: EmailDispatchObserved = {
      attemptId: request.attemptId,
      deliveryId: request.deliveryId,
      failure: transportObservation.failure ?? null,
      functionRunId: request.functionRunId,
      observedAt: transportObservation.observedAt,
      outcome: transportObservation.outcome,
      provider: this.options.providerName,
      remoteReceipt: transportObservation.remoteReceipt ?? null,
    };
    const authoritativeReceipt = transportObservation.authoritativeReceipt
      ? {
          authentication: {
            keyReference: "fixture/deterministic",
            mechanism: "fixture" as const,
            verified: true as const,
            verifiedAt: transportObservation.authoritativeReceipt.observedAt,
          },
          businessAttemptId: request.functionRunId,
          evidence: transportObservation.authoritativeReceipt.evidence,
          kind: transportObservation.authoritativeReceipt.kind,
          observedAt: transportObservation.authoritativeReceipt.observedAt,
          remoteId: transportObservation.authoritativeReceipt.remoteId,
          source: transportObservation.authoritativeReceipt.source,
        }
      : undefined;
    try {
      await this.options.ledger.completeDispatch({
        ...(authoritativeReceipt ? { authoritativeReceipt } : {}),
        businessAttemptId: request.functionRunId,
        eventDigest,
        leaseToken: claim.leaseToken,
        now: this.clock().toISOString(),
        observation,
      });
      return observation;
    } catch {
      throw new TransportTechnicalFailure("dispatch_ledger_unavailable", true, 1_000);
    }
  }
}
