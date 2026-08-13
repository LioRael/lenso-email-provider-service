import { randomUUID } from "node:crypto";

import type {
  ProviderInvocationStore,
  ProviderInvocationStoreAcknowledgeInput,
  ProviderInvocationStoreAcknowledgeResult,
  ProviderInvocationStoreClaimInput,
  ProviderInvocationStoreClaimResult,
  ProviderInvocationStoreCompleteInput,
  ProviderStoredInvocation,
  ProviderV1Outcome,
} from "@lenso/service-kit";
import type { Pool, PoolClient } from "pg";

import { canonicalDigest } from "../canonical.js";
import type { EmailDispatchObserved, EmailReceiptObserved } from "../contracts.js";
import type {
  ClaimDispatchInput,
  CompleteDispatchInput,
  DispatchClaim,
  DispatchRecord,
  EmailLedger,
  ReceiptIngestionInput,
  ReceiptIngestionResult,
  TechnicalFailureInput,
} from "./email-ledger.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

interface InvocationRow {
  invocation_id: string;
  request_digest: string;
  phase: ProviderStoredInvocation["phase"];
  outcome: ProviderV1Outcome;
  outcome_digest: string;
  created_at: Date | string;
  updated_at: Date | string;
  acknowledged_at: Date | string | null;
  acknowledged_outcome_digest: string | null;
}

interface DispatchRow {
  business_attempt_id: string;
  delivery_id: string;
  attempt_id: string;
  idempotency_key: string;
  message_content_digest: string;
  event_digest: string;
  transport: string;
  phase: DispatchRecord["phase"];
  lease_token: string | null;
  lease_until: Date | string | null;
  technical_attempts: number;
  observation: EmailDispatchObserved | null;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const invocationRecord = (row: InvocationRow): ProviderStoredInvocation => ({
  acknowledgedAt: row.acknowledged_at === null ? null : iso(row.acknowledged_at),
  acknowledgedOutcomeDigest: row.acknowledged_outcome_digest,
  createdAt: iso(row.created_at),
  invocationId: row.invocation_id,
  outcome: row.outcome,
  phase: row.phase,
  requestDigest: row.request_digest,
  updatedAt: iso(row.updated_at),
});

const validatedInvocationRecord = (row: InvocationRow): ProviderStoredInvocation => {
  if (row.outcome_digest !== row.outcome.outcomeDigest) {
    throw new Error("Provider invocation outcome digest columns disagree");
  }
  return invocationRecord(row);
};

const dispatchRecord = (row: DispatchRow): DispatchRecord => ({
  attemptId: row.attempt_id,
  businessAttemptId: row.business_attempt_id,
  deliveryId: row.delivery_id,
  eventDigest: row.event_digest,
  idempotencyKey: row.idempotency_key,
  leaseToken: row.lease_token,
  leaseUntil: row.lease_until === null ? null : iso(row.lease_until),
  messageContentDigest: row.message_content_digest,
  observation: row.observation,
  phase: row.phase,
  technicalAttempts: row.technical_attempts,
  transport: row.transport,
});

const withTransaction = async <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const selectInvocation = async (db: Queryable, invocationId: string, lock = false) => {
  const result = await db.query<InvocationRow>(
    `SELECT invocation_id, request_digest, phase, outcome, outcome_digest, created_at, updated_at,
            acknowledged_at, acknowledged_outcome_digest
       FROM lenso_email_provider_invocations
      WHERE invocation_id = $1${lock ? " FOR UPDATE" : ""}`,
    [invocationId],
  );
  return result.rows[0];
};

export class PostgresProviderInvocationStore implements ProviderInvocationStore {
  readonly durability = "durable" as const;

  constructor(private readonly pool: Pool) {}

  async claim(input: ProviderInvocationStoreClaimInput): Promise<ProviderInvocationStoreClaimResult> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<InvocationRow>(
        `INSERT INTO lenso_email_provider_invocations
          (invocation_id, request_digest, phase, outcome, outcome_digest, created_at, updated_at)
         VALUES ($1, $2, 'executing', $3::jsonb, $4, $5::timestamptz, $5::timestamptz)
         ON CONFLICT (invocation_id) DO NOTHING
         RETURNING invocation_id, request_digest, phase, outcome, created_at, updated_at,
                   acknowledged_at, acknowledged_outcome_digest, outcome_digest`,
        [input.invocationId, input.requestDigest, JSON.stringify(input.pendingOutcome), input.pendingOutcome.outcomeDigest, input.now],
      );
      if (inserted.rows[0]) return { kind: "claimed", record: validatedInvocationRecord(inserted.rows[0]) };
      const existing = await selectInvocation(client, input.invocationId, true);
      if (!existing) throw new Error("invocation disappeared while claiming it");
      if (existing.request_digest !== input.requestDigest) return { kind: "conflict" };
      return { kind: "replay", record: validatedInvocationRecord(existing) };
    });
  }

  async get(invocationId: string): Promise<ProviderStoredInvocation | undefined> {
    const row = await selectInvocation(this.pool, invocationId);
    return row ? validatedInvocationRecord(row) : undefined;
  }

  async complete(input: ProviderInvocationStoreCompleteInput): Promise<ProviderStoredInvocation> {
    return withTransaction(this.pool, async (client) => {
      const existing = await selectInvocation(client, input.invocationId, true);
      if (!existing) throw new Error("cannot complete an unclaimed invocation");
      if (existing.request_digest !== input.requestDigest) throw new Error("invocation request digest conflict");
      if (existing.phase === "completed") {
        if (existing.outcome.outcomeDigest !== input.outcome.outcomeDigest) {
          throw new Error("completed Provider outcomes are immutable");
        }
        return validatedInvocationRecord(existing);
      }
      if (
        existing.phase === "pending" &&
        input.outcome.status === "pending" &&
        existing.outcome.outcomeDigest !== input.outcome.outcomeDigest
      ) {
        throw new Error("Provider invocation pending outcome cannot be rebound");
      }
      const phase = input.outcome.status === "pending" ? "pending" : "completed";
      const updated = await client.query<InvocationRow>(
        `UPDATE lenso_email_provider_invocations
            SET phase = $2, outcome = $3::jsonb, outcome_digest = $4,
                updated_at = $5::timestamptz,
                acknowledged_at = CASE WHEN outcome_digest = $4 THEN acknowledged_at ELSE NULL END,
                acknowledged_outcome_digest = CASE WHEN outcome_digest = $4 THEN acknowledged_outcome_digest ELSE NULL END
          WHERE invocation_id = $1
          RETURNING invocation_id, request_digest, phase, outcome, created_at, updated_at,
                    acknowledged_at, acknowledged_outcome_digest, outcome_digest`,
        [input.invocationId, phase, JSON.stringify(input.outcome), input.outcome.outcomeDigest, input.now],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("invocation disappeared while completing it");
      return validatedInvocationRecord(row);
    });
  }

  async acknowledge(input: ProviderInvocationStoreAcknowledgeInput): Promise<ProviderInvocationStoreAcknowledgeResult> {
    return withTransaction(this.pool, async (client) => {
      const existing = await selectInvocation(client, input.invocationId, true);
      if (!existing) return { kind: "not_found" };
      if (existing.outcome.outcomeDigest !== input.outcomeDigest) return { kind: "conflict" };
      const updated = await client.query<InvocationRow>(
        `UPDATE lenso_email_provider_invocations
            SET acknowledged_at = COALESCE(acknowledged_at, $2::timestamptz),
                acknowledged_outcome_digest = $3,
                updated_at = GREATEST(updated_at, $2::timestamptz)
          WHERE invocation_id = $1
          RETURNING invocation_id, request_digest, phase, outcome, created_at, updated_at,
                    acknowledged_at, acknowledged_outcome_digest, outcome_digest`,
        [input.invocationId, input.now, input.outcomeDigest],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("invocation disappeared while acknowledging it");
      return { kind: "acknowledged", record: validatedInvocationRecord(row) };
    });
  }
}

const selectDispatch = async (db: Queryable, businessAttemptId: string, lock = false) => {
  const result = await db.query<DispatchRow>(
    `SELECT business_attempt_id, delivery_id, attempt_id, idempotency_key,
            message_content_digest, event_digest, transport, phase, lease_token,
            lease_until, technical_attempts, observation
       FROM lenso_email_dispatches
      WHERE business_attempt_id = $1${lock ? " FOR UPDATE" : ""}`,
    [businessAttemptId],
  );
  return result.rows[0];
};

const matchesDispatch = (row: DispatchRow, input: ClaimDispatchInput) =>
  row.event_digest === input.eventDigest &&
  row.message_content_digest === input.request.message.contentDigest &&
  row.delivery_id === input.request.deliveryId &&
  row.attempt_id === input.request.attemptId &&
  row.idempotency_key === input.request.idempotencyKey &&
  row.transport === input.transport;

export class PostgresEmailLedger implements EmailLedger {
  constructor(private readonly pool: Pool) {}

  async claimDispatch(input: ClaimDispatchInput): Promise<DispatchClaim> {
    return withTransaction(this.pool, async (client) => {
      const leaseToken = randomUUID();
      const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
      const inserted = await client.query<DispatchRow>(
        `INSERT INTO lenso_email_dispatches
          (business_attempt_id, delivery_id, attempt_id, idempotency_key,
           message_content_digest, event_digest, transport, phase, lease_token,
           lease_until, technical_attempts, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'executing', $8, $9::timestamptz, 1, $10::timestamptz, $10::timestamptz)
         ON CONFLICT (business_attempt_id) DO NOTHING
         RETURNING business_attempt_id, delivery_id, attempt_id, idempotency_key,
                   message_content_digest, event_digest, transport, phase, lease_token,
                   lease_until, technical_attempts, observation`,
        [input.request.functionRunId, input.request.deliveryId, input.request.attemptId,
          input.request.idempotencyKey, input.request.message.contentDigest, input.eventDigest,
          input.transport, leaseToken, leaseUntil, input.now],
      );
      if (inserted.rows[0]) return { kind: "claimed", leaseToken, record: dispatchRecord(inserted.rows[0]) };

      const row = await selectDispatch(client, input.request.functionRunId, true);
      if (!row) throw new Error("dispatch disappeared while claiming it");
      if (!matchesDispatch(row, input)) return { kind: "conflict" };
      if (row.phase === "observed") return { kind: "replay", record: dispatchRecord(row) };
      if (row.phase === "executing" && row.lease_until && Date.parse(iso(row.lease_until)) > Date.parse(input.now)) {
        return {
          kind: "in_progress",
          record: dispatchRecord(row),
          retryAfterMs: Math.max(1, Date.parse(iso(row.lease_until)) - Date.parse(input.now)),
        };
      }
      const expired = row.phase === "executing";
      const updated = await client.query<DispatchRow>(
        `UPDATE lenso_email_dispatches
            SET phase = 'executing', lease_token = $2, lease_until = $3::timestamptz,
                technical_attempts = technical_attempts + 1, updated_at = $4::timestamptz
          WHERE business_attempt_id = $1
          RETURNING business_attempt_id, delivery_id, attempt_id, idempotency_key,
                    message_content_digest, event_digest, transport, phase, lease_token,
                    lease_until, technical_attempts, observation`,
        [input.request.functionRunId, leaseToken, leaseUntil, input.now],
      );
      const refreshed = updated.rows[0];
      if (!refreshed) throw new Error("dispatch disappeared while reclaiming it");
      return { kind: expired ? "expired" : "claimed", leaseToken, record: dispatchRecord(refreshed) };
    });
  }

  async completeDispatch(input: CompleteDispatchInput): Promise<DispatchRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<DispatchRow>(
        `UPDATE lenso_email_dispatches
          SET phase = 'observed', observation = $4::jsonb,
              lease_token = NULL, lease_until = NULL, updated_at = $5::timestamptz
        WHERE business_attempt_id = $1 AND event_digest = $2
          AND phase = 'executing' AND lease_token = $3
        RETURNING business_attempt_id, delivery_id, attempt_id, idempotency_key,
                  message_content_digest, event_digest, transport, phase, lease_token,
                  lease_until, technical_attempts, observation`,
      [input.businessAttemptId, input.eventDigest, input.leaseToken, JSON.stringify(input.observation), input.now],
      );
      const row = result.rows[0];
      if (!row) throw new Error("dispatch completion lost its lease or conflicted");
      if (input.authoritativeReceipt) {
        const receiptDigest = canonicalDigest(input.authoritativeReceipt);
        const receipt = input.authoritativeReceipt;
        const inserted = await client.query(
          `INSERT INTO lenso_email_remote_receipts
            (source, remote_id, receipt_digest, business_attempt_id, kind, observed_at, authentication, evidence)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::jsonb)
           ON CONFLICT (source, remote_id) DO NOTHING
           RETURNING source`,
          [receipt.source, receipt.remoteId, receiptDigest, receipt.businessAttemptId,
            receipt.kind, receipt.observedAt, JSON.stringify(receipt.authentication), JSON.stringify(receipt.evidence)],
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query<{ receipt_digest: string; business_attempt_id: string; kind: EmailReceiptObserved["kind"] }>(
            `SELECT receipt_digest, business_attempt_id, kind
               FROM lenso_email_remote_receipts WHERE source = $1 AND remote_id = $2 FOR UPDATE`,
            [receipt.source, receipt.remoteId],
          );
          const found = existing.rows[0];
          if (!found || found.receipt_digest !== receiptDigest || found.business_attempt_id !== receipt.businessAttemptId || found.kind !== receipt.kind) {
            const terminal = await client.query<{ source: string; remote_id: string; receipt_digest: string; kind: EmailReceiptObserved["kind"] }>(
              `SELECT source, remote_id, receipt_digest, kind
                 FROM lenso_email_remote_receipts WHERE business_attempt_id = $1 FOR UPDATE`,
              [receipt.businessAttemptId],
            );
            const first = terminal.rows[0];
            if (!first || first.source !== receipt.source || first.remote_id !== receipt.remoteId || first.receipt_digest !== receiptDigest || first.kind !== receipt.kind) {
              throw new Error("authoritative transport receipt conflicts with durable evidence");
            }
          }
        }
      }
      return dispatchRecord(row);
    });
  }

  async recordTechnicalFailure(input: TechnicalFailureInput): Promise<void> {
    const result = await this.pool.query(
      `UPDATE lenso_email_dispatches
          SET phase = 'technical_failed', lease_token = NULL, lease_until = NULL,
              updated_at = $4::timestamptz
        WHERE business_attempt_id = $1 AND event_digest = $2
          AND phase = 'executing' AND lease_token = $3`,
      [input.businessAttemptId, input.eventDigest, input.leaseToken, input.now],
    );
    if (result.rowCount !== 1) throw new Error("dispatch technical failure lost its lease");
  }

  async getDispatch(businessAttemptId: string): Promise<DispatchRecord | undefined> {
    const row = await selectDispatch(this.pool, businessAttemptId);
    return row ? dispatchRecord(row) : undefined;
  }

  async getLatestReceipt(businessAttemptId: string): Promise<EmailReceiptObserved | undefined> {
    const result = await this.pool.query<{
      source: string;
      remote_id: string;
      receipt_digest: string;
      kind: EmailReceiptObserved["kind"];
      observed_at: Date | string;
    }>(
      `SELECT source, remote_id, receipt_digest, kind, observed_at
         FROM lenso_email_remote_receipts
        WHERE business_attempt_id = $1
        ORDER BY observed_at DESC, created_at DESC
        LIMIT 1`,
      [businessAttemptId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const dispatch = await this.getDispatch(businessAttemptId);
    if (!dispatch) throw new Error("receipt refers to a missing dispatch");
    return {
      attemptId: dispatch.attemptId,
      deliveryId: dispatch.deliveryId,
      digest: row.receipt_digest,
      functionRunId: businessAttemptId,
      kind: row.kind,
      observedAt: iso(row.observed_at),
      remoteId: row.remote_id,
      source: row.source,
    };
  }

  async ingestReceipt(input: ReceiptIngestionInput, receiptDigest: string): Promise<ReceiptIngestionResult> {
    return withTransaction(this.pool, async (client) => {
      const dispatch = await selectDispatch(client, input.businessAttemptId, true);
      if (!dispatch) throw new Error("receipt target business attempt does not exist");
      const existingTerminal = await client.query<{
        source: string;
        remote_id: string;
        receipt_digest: string;
        kind: EmailReceiptObserved["kind"];
        observed_at: Date | string;
      }>(
        `SELECT source, remote_id, receipt_digest, kind, observed_at
           FROM lenso_email_remote_receipts
          WHERE business_attempt_id = $1
          FOR UPDATE`,
        [input.businessAttemptId],
      );
      const terminal = existingTerminal.rows[0];
      if (terminal) {
        if (
          terminal.source !== input.source ||
          terminal.remote_id !== input.remoteId ||
          terminal.receipt_digest !== receiptDigest ||
          terminal.kind !== input.kind
        ) {
          return { kind: "conflict" };
        }
        return {
          kind: "replay",
          receipt: {
            attemptId: dispatch.attempt_id,
            deliveryId: dispatch.delivery_id,
            digest: terminal.receipt_digest,
            functionRunId: dispatch.business_attempt_id,
            kind: terminal.kind,
            observedAt: iso(terminal.observed_at),
            remoteId: terminal.remote_id,
            source: terminal.source,
          },
        };
      }
      const inserted = await client.query(
        `INSERT INTO lenso_email_remote_receipts
          (source, remote_id, receipt_digest, business_attempt_id, kind, observed_at, authentication, evidence)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::jsonb)
         ON CONFLICT (source, remote_id) DO NOTHING
         RETURNING source`,
        [input.source, input.remoteId, receiptDigest, input.businessAttemptId, input.kind,
          input.observedAt, JSON.stringify(input.authentication), JSON.stringify(input.evidence)],
      );
      let kind: "inserted" | "replay" = "inserted";
      if (inserted.rowCount === 0) {
        const existing = await client.query<{ receipt_digest: string; business_attempt_id: string; kind: EmailReceiptObserved["kind"]; observed_at: Date | string }>(
          `SELECT receipt_digest, business_attempt_id, kind, observed_at
             FROM lenso_email_remote_receipts WHERE source = $1 AND remote_id = $2 FOR UPDATE`,
          [input.source, input.remoteId],
        );
        const row = existing.rows[0];
        if (!row || row.receipt_digest !== receiptDigest || row.business_attempt_id !== input.businessAttemptId || row.kind !== input.kind) {
          return { kind: "conflict" };
        }
        kind = "replay";
      }
      const receipt: EmailReceiptObserved = {
        attemptId: dispatch.attempt_id,
        deliveryId: dispatch.delivery_id,
        digest: receiptDigest,
        functionRunId: dispatch.business_attempt_id,
        kind: input.kind,
        observedAt: input.observedAt,
        remoteId: input.remoteId,
        source: input.source,
      };
      return { kind, receipt };
    });
  }
}
