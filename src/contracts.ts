import { createHash } from "node:crypto";

export const DISPATCH_EVENT = "lenso.email.dispatch-requested.v1";
export const DISPATCH_OBSERVED_EVENT = "lenso.email.dispatch-observed.v1";
export const RECEIPT_CHECK_EVENT = "lenso.email.receipt-check-requested.v1";
export const RECEIPT_OBSERVED_EVENT = "lenso.email.receipt-observed.v1";
export const DISPATCH_FUNCTION = "lenso.email.dispatch.v1";
export const RECEIPT_CHECK_FUNCTION = "lenso.email.receipt-check.v1";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;

export interface EmailMessageSnapshot {
  templateId: string;
  templateVersion: string;
  locale: string;
  subject: string;
  text: string;
  html: string;
  contentDigest: string;
}

export interface EmailDispatchRequested {
  deliveryId: string;
  attemptId: string;
  functionRunId: string;
  idempotencyKey: string;
  channel: "email";
  recipient: { address: string };
  message: EmailMessageSnapshot;
  context: { correlationId: string };
}

export type EmailDispatchOutcome =
  | "accepted"
  | "temporary_failure"
  | "permanent_failure"
  | "delivery_unknown";

export interface SanitizedRemoteReceipt {
  source: string;
  remoteId: string;
  digest: string;
}

export interface SanitizedEmailFailure {
  code: string;
  classification: "transient" | "permanent" | "ambiguous";
  retryAfterMs: number | null;
}

export interface EmailDispatchObserved {
  deliveryId: string;
  attemptId: string;
  functionRunId: string;
  outcome: EmailDispatchOutcome;
  provider: string;
  observedAt: string;
  remoteReceipt: SanitizedRemoteReceipt | null;
  failure: SanitizedEmailFailure | null;
}

export type EmailReceiptKind = "delivered" | "bounced" | "rejected";

export interface EmailReceiptObserved {
  deliveryId: string;
  attemptId: string;
  functionRunId: string;
  kind: EmailReceiptKind;
  source: string;
  observedAt: string;
  remoteId: string;
  digest: string;
}

export const computeMessageContentDigest = (
  message: Omit<EmailMessageSnapshot, "contentDigest">,
): string => {
  const hasher = createHash("sha256");
  for (const part of [message.subject, message.text, message.html]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hasher.update(length);
    hasher.update(bytes);
  }
  return `sha256:${hasher.digest("hex")}`;
};

const requiredString = (value: unknown, field: string, max = 160): string => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} bytes`);
  }
  return value;
};

export const parseDispatchRequested = (value: unknown): EmailDispatchRequested => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("dispatch payload must be an object");
  }
  const input = value as Partial<EmailDispatchRequested>;
  if (input.channel !== "email") throw new TypeError("channel must be email");
  if (!input.recipient || !input.message || !input.context) {
    throw new TypeError("recipient, message, and context are required");
  }
  const address = requiredString(input.recipient.address, "recipient.address", 320);
  if (!EMAIL.test(address)) throw new TypeError("recipient.address is invalid");
  const message = input.message;
  const normalizedMessage: Omit<EmailMessageSnapshot, "contentDigest"> = {
    html: requiredString(message.html, "message.html", 262_144),
    locale: requiredString(message.locale, "message.locale", 64),
    subject: requiredString(message.subject, "message.subject", 998),
    templateId: requiredString(message.templateId, "message.templateId"),
    templateVersion: requiredString(message.templateVersion, "message.templateVersion", 128),
    text: requiredString(message.text, "message.text", 131_072),
  };
  if (normalizedMessage.templateId !== "organization-invitation") {
    throw new TypeError("message.templateId must be organization-invitation");
  }
  if (normalizedMessage.templateVersion !== "v1") {
    throw new TypeError("message.templateVersion must be v1");
  }
  if (normalizedMessage.locale !== "en" && normalizedMessage.locale !== "en-US") {
    throw new TypeError("message.locale must be en or en-US");
  }
  const contentDigest = requiredString(message.contentDigest, "message.contentDigest", 71);
  if (!SHA256.test(contentDigest)) throw new TypeError("message.contentDigest must be sha256");
  if (computeMessageContentDigest(normalizedMessage) !== contentDigest) {
    throw new TypeError("message.contentDigest does not match the immutable rendering snapshot");
  }
  return {
    attemptId: requiredString(input.attemptId, "attemptId"),
    channel: "email",
    context: { correlationId: requiredString(input.context.correlationId, "context.correlationId") },
    deliveryId: requiredString(input.deliveryId, "deliveryId"),
    functionRunId: requiredString(input.functionRunId, "functionRunId"),
    idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey", 240),
    message: { ...normalizedMessage, contentDigest },
    recipient: { address },
  };
};

export const parseIsoDate = (value: unknown, field: string): string => {
  const string = requiredString(value, field, 64);
  if (Number.isNaN(Date.parse(string))) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(string).toISOString();
};

export const assertDispatchEvent = (
  name: string,
  version: number,
  payload: unknown,
): EmailDispatchRequested => {
  if (name !== DISPATCH_EVENT || version !== 1) {
    throw new TypeError(`expected ${DISPATCH_EVENT} version 1`);
  }
  return parseDispatchRequested(payload);
};
