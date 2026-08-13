import nodemailer from "nodemailer";

import { canonicalDigest } from "../canonical.js";
import type { EmailDispatchRequested, SanitizedRemoteReceipt } from "../contracts.js";
import { bounded, type EmailTransport, type TransportObservation, TransportTechnicalFailure } from "./email-transport.js";

export interface SmtpTransportConfig {
  connectionTimeoutMs: number;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  greetingTimeoutMs: number;
  maxConnections: number;
  maxMessages: number;
  rateLimitPerSecond: number;
  socketTimeoutMs: number;
}

export interface SmtpClient {
  close(): void;
  verify(): Promise<unknown>;
  sendMail(message: Record<string, unknown>): Promise<{
    accepted?: unknown[];
    rejected?: unknown[];
    response?: string;
    messageId?: string;
  }>;
}

interface SmtpFailureLike {
  code?: unknown;
  command?: unknown;
  responseCode?: unknown;
}

const responseCode = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

const failureCode = (value: unknown): string =>
  typeof value === "string" && /^[A-Z0-9_-]{1,64}$/u.test(value) ? value.toLowerCase() : "smtp_failure";

const command = (value: unknown): string =>
  typeof value === "string" ? value.toUpperCase().trim() : "";

const provenPreDataCommands = new Set([
  "EHLO",
  "HELO",
  "STARTTLS",
  "AUTH",
  "MAIL FROM",
  "RCPT TO",
]);

const receipt = (source: string, remoteId: string): SanitizedRemoteReceipt => {
  const value = { remoteId: bounded(remoteId, 320), source };
  return { ...value, digest: canonicalDigest(value) };
};

export class SmtpEmailTransport implements EmailTransport {
  readonly name = "smtp";
  private readonly client;

  constructor(private readonly config: SmtpTransportConfig, client?: SmtpClient) {
    this.client = client ?? nodemailer.createTransport({
        auth: { pass: config.password, user: config.username },
        connectionTimeout: config.connectionTimeoutMs,
        greetingTimeout: config.greetingTimeoutMs,
        host: config.host,
        maxConnections: config.maxConnections,
        maxMessages: config.maxMessages,
        pool: true,
        port: config.port,
        rateDelta: 1_000,
        rateLimit: config.rateLimitPerSecond,
        requireTLS: !config.secure,
        secure: config.secure,
        socketTimeout: config.socketTimeoutMs,
      });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async ready(): Promise<void> {
    try {
      await this.client.verify();
    } catch {
      throw new TransportTechnicalFailure("smtp_startup_unavailable", true, 5_000);
    }
  }

  async send(request: EmailDispatchRequested): Promise<TransportObservation> {
    const observedAt = new Date().toISOString();
    try {
      const result = await this.client.sendMail({
        from: { address: this.config.fromAddress, name: this.config.fromName },
        html: request.message.html ?? undefined,
        subject: request.message.subject,
        text: request.message.text,
        to: request.recipient.address,
      });
      const code = typeof result.response === "string" ? responseCode(Number(result.response.match(/^(\d{3})/u)?.[1])) : null;
      const remoteId = typeof result.messageId === "string" && result.messageId ? result.messageId : `smtp-${request.attemptId}`;
      if (Array.isArray(result.accepted) && result.accepted.length > 0) {
        // SMTP acceptance is transfer-of-responsibility evidence, not delivery.
        return { observedAt, outcome: "accepted", remoteReceipt: receipt("smtp", remoteId) };
      }
      if (Array.isArray(result.rejected) && result.rejected.length > 0) {
        const outcome = code !== null && code >= 400 && code < 500 ? "temporary_failure" : "permanent_failure";
        return {
          failure: {
            classification: outcome === "temporary_failure" ? "transient" : "permanent",
            code: outcome === "temporary_failure" ? "smtp_temporary_rejection" : "smtp_permanent_rejection",
            retryAfterMs: outcome === "temporary_failure" ? 60_000 : null,
          },
          observedAt,
          outcome,
          remoteReceipt: receipt("smtp", remoteId),
        };
      }
      return {
        failure: { classification: "ambiguous", code: "smtp_result_ambiguous", retryAfterMs: null },
        observedAt,
        outcome: "delivery_unknown",
      };
    } catch (caught) {
      const error = (caught ?? {}) as SmtpFailureLike;
      const code = responseCode(error.responseCode);
      const step = command(error.command);
      if (code !== null && (step === "RCPT TO" || step === "DATA")) {
        const outcome = code >= 400 && code < 500 ? "temporary_failure" : "permanent_failure";
        return {
          failure: {
            classification: outcome === "temporary_failure" ? "transient" : "permanent",
            code: outcome === "temporary_failure" ? "smtp_temporary_rejection" : "smtp_permanent_rejection",
            retryAfterMs: outcome === "temporary_failure" ? 60_000 : null,
          },
          observedAt,
          outcome,
        };
      }
      if (step === "DATA") {
        return {
          failure: { classification: "ambiguous", code: "smtp_data_outcome_unknown", retryAfterMs: null },
          observedAt,
          outcome: "delivery_unknown",
        };
      }
      if (!provenPreDataCommands.has(step)) {
        return {
          failure: { classification: "ambiguous", code: "smtp_connection_outcome_unknown", retryAfterMs: null },
          observedAt,
          outcome: "delivery_unknown",
        };
      }
      const retryable = step !== "AUTH" && (code === null || (code >= 400 && code < 500));
      throw new TransportTechnicalFailure(
        step === "AUTH" ? "smtp_authentication_failed" : `smtp_${failureCode(error.code)}`,
        retryable,
        retryable ? 5_000 : null,
      );
    }
  }
}
