import { canonicalDigest, canonicalJson } from "./canonical.js";
import { parseIsoDate, type EmailReceiptObserved } from "./contracts.js";
import type { EmailLedger, ReceiptIngestionInput, ReceiptIngestionResult } from "./store/email-ledger.js";

const boundedString = (value: unknown, field: string, max = 512): string => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
};

const receiptKinds = new Set<EmailReceiptObserved["kind"]>(["delivered", "bounced", "rejected"]);

export const ingestAuthenticatedReceipt = async (
  ledger: EmailLedger,
  value: ReceiptIngestionInput,
): Promise<ReceiptIngestionResult> => {
  if (value.authentication.verified !== true) throw new TypeError("receipt authentication must be verified");
  if (!receiptKinds.has(value.kind)) throw new TypeError("receipt kind is invalid");
  const normalized: ReceiptIngestionInput = {
    authentication: {
      keyReference: boundedString(value.authentication.keyReference, "authentication.keyReference"),
      mechanism: value.authentication.mechanism,
      verified: true,
      verifiedAt: parseIsoDate(value.authentication.verifiedAt, "authentication.verifiedAt"),
    },
    businessAttemptId: boundedString(value.businessAttemptId, "businessAttemptId"),
    evidence: value.evidence,
    kind: value.kind,
    observedAt: parseIsoDate(value.observedAt, "observedAt"),
    remoteId: boundedString(value.remoteId, "remoteId"),
    source: boundedString(value.source, "source", 128),
  };
  if (!normalized.evidence || typeof normalized.evidence !== "object" || Array.isArray(normalized.evidence)) {
    throw new TypeError("receipt evidence must be an object");
  }
  if (Buffer.byteLength(canonicalJson(normalized.evidence), "utf8") > 16_384) {
    throw new TypeError("receipt evidence exceeds 16 KiB");
  }
  const digest = canonicalDigest(normalized);
  return ledger.ingestReceipt(normalized, digest);
};
