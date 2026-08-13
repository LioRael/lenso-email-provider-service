import type { EmailDispatchObserved, EmailDispatchRequested, EmailReceiptObserved } from "../contracts.js";

export interface DispatchRecord {
  businessAttemptId: string;
  deliveryId: string;
  attemptId: string;
  idempotencyKey: string;
  messageContentDigest: string;
  eventDigest: string;
  transport: string;
  phase: "executing" | "technical_failed" | "observed";
  technicalAttempts: number;
  observation: EmailDispatchObserved | null;
  leaseToken: string | null;
  leaseUntil: string | null;
}

export type DispatchClaim =
  | { kind: "claimed"; leaseToken: string; record: DispatchRecord }
  | { kind: "replay"; record: DispatchRecord }
  | { kind: "in_progress"; retryAfterMs: number; record: DispatchRecord }
  | { kind: "expired"; leaseToken: string; record: DispatchRecord }
  | { kind: "conflict" };

export interface ClaimDispatchInput {
  request: EmailDispatchRequested;
  eventDigest: string;
  transport: string;
  now: string;
  leaseMs: number;
}

export interface CompleteDispatchInput {
  businessAttemptId: string;
  eventDigest: string;
  leaseToken: string;
  observation: EmailDispatchObserved;
  authoritativeReceipt?: ReceiptIngestionInput;
  now: string;
}

export interface TechnicalFailureInput {
  businessAttemptId: string;
  eventDigest: string;
  leaseToken: string;
  now: string;
}

export interface ReceiptAuthentication {
  verified: true;
  mechanism: "webhook_signature" | "dsn_signature" | "fixture";
  keyReference: string;
  verifiedAt: string;
}

export interface ReceiptIngestionInput {
  source: string;
  remoteId: string;
  kind: EmailReceiptObserved["kind"];
  observedAt: string;
  businessAttemptId: string;
  authentication: ReceiptAuthentication;
  evidence: Record<string, unknown>;
}

export type ReceiptIngestionResult =
  | { kind: "inserted" | "replay"; receipt: EmailReceiptObserved }
  | { kind: "conflict" };

export interface EmailLedger {
  claimDispatch(input: ClaimDispatchInput): Promise<DispatchClaim>;
  completeDispatch(input: CompleteDispatchInput): Promise<DispatchRecord>;
  recordTechnicalFailure(input: TechnicalFailureInput): Promise<void>;
  getDispatch(businessAttemptId: string): Promise<DispatchRecord | undefined>;
  getLatestReceipt(businessAttemptId: string): Promise<EmailReceiptObserved | undefined>;
  ingestReceipt(input: ReceiptIngestionInput, receiptDigest: string): Promise<ReceiptIngestionResult>;
}

export class DispatchIdentityConflictError extends Error {
  constructor() {
    super("Business attempt identity is already bound to different email content");
    this.name = "DispatchIdentityConflictError";
  }
}
