import type { EmailDispatchOutcome, EmailDispatchRequested, EmailReceiptKind, SanitizedEmailFailure, SanitizedRemoteReceipt } from "../contracts.js";

export interface AuthoritativeTransportReceipt {
  kind: EmailReceiptKind;
  source: string;
  remoteId: string;
  observedAt: string;
  evidence: Record<string, unknown>;
}

export interface TransportObservation {
  outcome: EmailDispatchOutcome;
  observedAt: string;
  remoteReceipt?: SanitizedRemoteReceipt;
  failure?: SanitizedEmailFailure;
  authoritativeReceipt?: AuthoritativeTransportReceipt;
}

export interface EmailTransport {
  readonly name: string;
  close(): Promise<void>;
  ready(): Promise<void>;
  send(request: EmailDispatchRequested): Promise<TransportObservation>;
}

export class TransportTechnicalFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super("Email transport failed before establishing a business outcome");
    this.name = "TransportTechnicalFailure";
  }
}

export const bounded = (value: string, maxBytes = 512): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
};
