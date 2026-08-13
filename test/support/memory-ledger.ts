import { randomUUID } from "node:crypto";

import type { EmailReceiptObserved } from "../../src/contracts.js";
import { canonicalDigest } from "../../src/canonical.js";
import type {
  ClaimDispatchInput,
  CompleteDispatchInput,
  DispatchClaim,
  DispatchRecord,
  EmailLedger,
  ReceiptIngestionInput,
  ReceiptIngestionResult,
  TechnicalFailureInput,
} from "../../src/store/email-ledger.js";

export class MemoryEmailLedger implements EmailLedger {
  readonly dispatches = new Map<string, DispatchRecord>();
  readonly receipts = new Map<string, { digest: string; receipt: EmailReceiptObserved }>();

  async claimDispatch(input: ClaimDispatchInput): Promise<DispatchClaim> {
    const existing = this.dispatches.get(input.request.functionRunId);
    if (existing) {
      if (
        existing.eventDigest !== input.eventDigest ||
        existing.messageContentDigest !== input.request.message.contentDigest ||
        existing.deliveryId !== input.request.deliveryId ||
        existing.attemptId !== input.request.attemptId
      ) return { kind: "conflict" };
      if (existing.phase === "observed") return { kind: "replay", record: structuredClone(existing) };
      if (existing.phase === "executing" && existing.leaseUntil && Date.parse(existing.leaseUntil) > Date.parse(input.now)) {
        return { kind: "in_progress", record: structuredClone(existing), retryAfterMs: Date.parse(existing.leaseUntil) - Date.parse(input.now) };
      }
      const expired = existing.phase === "executing";
      const leaseToken = randomUUID();
      const record: DispatchRecord = {
        ...existing,
        leaseToken,
        leaseUntil: new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
        phase: "executing",
        technicalAttempts: existing.technicalAttempts + 1,
      };
      this.dispatches.set(record.businessAttemptId, record);
      return { kind: expired ? "expired" : "claimed", leaseToken, record: structuredClone(record) };
    }
    const leaseToken = randomUUID();
    const record: DispatchRecord = {
      attemptId: input.request.attemptId,
      businessAttemptId: input.request.functionRunId,
      deliveryId: input.request.deliveryId,
      eventDigest: input.eventDigest,
      idempotencyKey: input.request.idempotencyKey,
      leaseToken,
      leaseUntil: new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
      messageContentDigest: input.request.message.contentDigest,
      observation: null,
      phase: "executing",
      technicalAttempts: 1,
      transport: input.transport,
    };
    this.dispatches.set(record.businessAttemptId, record);
    return { kind: "claimed", leaseToken, record: structuredClone(record) };
  }

  async completeDispatch(input: CompleteDispatchInput): Promise<DispatchRecord> {
    const record = this.dispatches.get(input.businessAttemptId);
    if (!record || record.eventDigest !== input.eventDigest || record.leaseToken !== input.leaseToken || record.phase !== "executing") {
      throw new Error("dispatch completion conflict");
    }
    const completed: DispatchRecord = { ...record, leaseToken: null, leaseUntil: null, observation: structuredClone(input.observation), phase: "observed" };
    if (input.authoritativeReceipt) {
      const receiptInput = input.authoritativeReceipt;
      const digest = canonicalDigest(receiptInput);
      const key = `${receiptInput.source}:${receiptInput.remoteId}`;
      const receipt: EmailReceiptObserved = {
        attemptId: record.attemptId,
        deliveryId: record.deliveryId,
        digest,
        functionRunId: record.businessAttemptId,
        kind: receiptInput.kind,
        observedAt: receiptInput.observedAt,
        remoteId: receiptInput.remoteId,
        source: receiptInput.source,
      };
      const existing = this.receipts.get(key);
      if (existing && (existing.digest !== digest || existing.receipt.functionRunId !== record.businessAttemptId)) {
        throw new Error("authoritative receipt conflict");
      }
      this.receipts.set(key, { digest, receipt });
    }
    this.dispatches.set(input.businessAttemptId, completed);
    return structuredClone(completed);
  }

  async recordTechnicalFailure(input: TechnicalFailureInput): Promise<void> {
    const record = this.dispatches.get(input.businessAttemptId);
    if (!record || record.eventDigest !== input.eventDigest || record.leaseToken !== input.leaseToken || record.phase !== "executing") {
      throw new Error("dispatch technical failure conflict");
    }
    this.dispatches.set(input.businessAttemptId, { ...record, leaseToken: null, leaseUntil: null, phase: "technical_failed" });
  }

  async getDispatch(businessAttemptId: string): Promise<DispatchRecord | undefined> {
    const record = this.dispatches.get(businessAttemptId);
    return record ? structuredClone(record) : undefined;
  }

  async getLatestReceipt(businessAttemptId: string): Promise<EmailReceiptObserved | undefined> {
    return [...this.receipts.values()].map(({ receipt }) => receipt).filter((receipt) => receipt.functionRunId === businessAttemptId).sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0];
  }

  async ingestReceipt(input: ReceiptIngestionInput, receiptDigest: string): Promise<ReceiptIngestionResult> {
    const dispatch = this.dispatches.get(input.businessAttemptId);
    if (!dispatch) throw new Error("receipt target missing");
    const key = `${input.source}:${input.remoteId}`;
    const terminal = [...this.receipts.values()].find(({ receipt }) => receipt.functionRunId === input.businessAttemptId);
    if (terminal) {
      if (terminal.digest !== receiptDigest || terminal.receipt.kind !== input.kind || terminal.receipt.source !== input.source || terminal.receipt.remoteId !== input.remoteId) {
        return { kind: "conflict" };
      }
      return { kind: "replay", receipt: structuredClone(terminal.receipt) };
    }
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.digest !== receiptDigest || existing.receipt.functionRunId !== input.businessAttemptId || existing.receipt.kind !== input.kind) return { kind: "conflict" };
      return { kind: "replay", receipt: structuredClone(existing.receipt) };
    }
    const receipt: EmailReceiptObserved = {
      attemptId: dispatch.attemptId,
      deliveryId: dispatch.deliveryId,
      digest: receiptDigest,
      functionRunId: dispatch.businessAttemptId,
      kind: input.kind,
      observedAt: input.observedAt,
      remoteId: input.remoteId,
      source: input.source,
    };
    this.receipts.set(key, { digest: receiptDigest, receipt });
    return { kind: "inserted", receipt: structuredClone(receipt) };
  }
}
