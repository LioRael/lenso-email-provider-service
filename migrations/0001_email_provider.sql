CREATE TABLE IF NOT EXISTS lenso_email_provider_invocations (
  invocation_id text PRIMARY KEY,
  request_digest text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('executing', 'pending', 'completed')),
  outcome jsonb NOT NULL,
  outcome_digest text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_outcome_digest text,
  CHECK ((acknowledged_at IS NULL) = (acknowledged_outcome_digest IS NULL))
);

CREATE INDEX IF NOT EXISTS lenso_email_provider_invocations_updated_idx
  ON lenso_email_provider_invocations (updated_at);

CREATE TABLE IF NOT EXISTS lenso_email_dispatches (
  business_attempt_id text PRIMARY KEY,
  delivery_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  message_content_digest text NOT NULL,
  event_digest text NOT NULL,
  transport text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('executing', 'technical_failed', 'observed')),
  lease_token text,
  lease_until timestamptz,
  technical_attempts integer NOT NULL DEFAULT 0 CHECK (technical_attempts >= 0),
  observation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (phase = 'executing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (phase <> 'executing' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CHECK ((phase = 'observed') = (observation IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS lenso_email_dispatches_delivery_idx
  ON lenso_email_dispatches (delivery_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lenso_email_dispatches_idempotency_idx
  ON lenso_email_dispatches (idempotency_key);

CREATE TABLE IF NOT EXISTS lenso_email_remote_receipts (
  source text NOT NULL,
  remote_id text NOT NULL,
  receipt_digest text NOT NULL,
  business_attempt_id text NOT NULL REFERENCES lenso_email_dispatches (business_attempt_id),
  kind text NOT NULL CHECK (kind IN ('delivered', 'bounced', 'rejected')),
  observed_at timestamptz NOT NULL,
  authentication jsonb NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, remote_id)
);

CREATE INDEX IF NOT EXISTS lenso_email_remote_receipts_attempt_idx
  ON lenso_email_remote_receipts (business_attempt_id, observed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS lenso_email_remote_receipts_terminal_attempt_idx
  ON lenso_email_remote_receipts (business_attempt_id);
