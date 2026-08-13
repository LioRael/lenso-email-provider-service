# Lenso Email Provider Service

Host-managed `lenso.provider.v1` Service for transactional email. It provides
the `lenso/email-delivery` Module and keeps the transport boundary honest:
SMTP acceptance is `accepted`, never `delivered`. A delivery claim requires an
authoritative normalized receipt or the deterministic fixture transport.

This first slice deliberately excludes SMS, Push, marketing campaigns, a
visual template editor, credential UI, and public webhook/DSN ingress.

## Responsibilities

The owning Notification Module creates immutable send intents and rendering
snapshots, decides business retry eligibility, and owns final notification
state. This Service owns credential resolution, SMTP/vendor calls, remote
receipt durability, and transport connection limits. The Host owns Provider
authentication, technical invocation recovery/retry, queues, Provider Calls,
and Runtime Story.

The dispatch path is:

1. Notification commits `lenso.email.dispatch-requested.v1` to its outbox.
2. The Service Event handler validates it and returns a deterministic Host
   runtime-function request for `lenso.email.dispatch.v1`.
3. The runtime handler claims the stable Notification `functionRunId` and
   canonical event digest in Postgres before touching the transport.
4. A known transport observation is committed and emitted as
   `lenso.email.dispatch-observed.v1` through a bounded Host Event effect.
5. Authenticated receipt adapters can call the non-HTTP domain seam and later
   emit `lenso.email.receipt-observed.v1`.

One Notification `functionRunId` is one business attempt. Outer Provider
invocation IDs are Host technical-attempt identities. A known temporary SMTP
rejection is a successful Provider operation carrying
`temporary_failure`; Notification may create a new business attempt. Only a
failure proven to happen before a remote side effect enters the Host technical
retry rail.

## Outcomes

| Outcome | Meaning | Automatic resend of the same business attempt |
| --- | --- | --- |
| `accepted` | SMTP/vendor accepted responsibility | No |
| `temporary_failure` | Known 4xx-style rejection | No; Notification decides a new attempt |
| `permanent_failure` | Known permanent rejection | No |
| `delivery_unknown` | A side effect may have happened, including an expired DATA lease | Never |

The dispatch ledger uses a lease only to distinguish a live worker from an
abandoned execution. An expired execution is finalized as
`delivery_unknown`; it is not stolen and resent. A technical failure explicitly
classified as pre-side-effect may be retried by the Host with the same business
identity and digest.

## Local development

Prerequisites: Node 22+, pnpm, PostgreSQL 17+, current `lenso`, and
`@lenso/service-kit` with durable Provider invocation Store support.

```sh
cp .env.example .env
docker compose up -d postgres
set -a; source .env; set +a
pnpm install
pnpm db:migrate
pnpm dev
```

Useful URLs:

- Service manifest: `http://127.0.0.1:4112/lenso/service/v1/manifest`
- Service status: `http://127.0.0.1:4112/lenso/service/v1/status`
- Provider descriptor: `http://127.0.0.1:4112/lenso/provider/v1`
- Exact Module Release:
  `http://127.0.0.1:4112/lenso/provider/v1/exports/email-delivery/module-release`

The fake transport is deterministic and supports `accepted`, `delivered`,
`temporary_failure`, `permanent_failure`, and `delivery_unknown` through
`EMAIL_FAKE_MODE`. The `delivered` fixture emits `accepted` plus an independent
authoritative `receipt-observed(kind=delivered)` event. It is an acceptance
transport, not a production transport.

For a multi-attempt acceptance scenario, `EMAIL_FAKE_SEQUENCE` accepts one to
20 comma-separated modes and advances once per actual transport send. For
example, `temporary_failure,delivered` proves an operator retry without adding
a retry policy to the Service. Once exhausted, the last mode is reused.

The HTTP listener defaults to loopback (`HOST=127.0.0.1`). Binding outside
loopback, such as `HOST=0.0.0.0` in a container, requires
`LENSO_PROVIDER_BEARER_TOKEN`; the Service Kit authenticates every Provider V1
descriptor, health, invocation, recovery, and acknowledgement request using a
constant-time bearer comparison. `LENSO_LOCAL_ENROLLMENT_TOKEN` remains a
loopback-only System Plane credential and cannot be combined with a
non-loopback bind.

## SMTP credentials

Set `EMAIL_TRANSPORT=smtp`. `EMAIL_SMTP_USERNAME_ENV` and
`EMAIL_SMTP_PASSWORD_ENV` are names of environment variables containing the
credentials. The Service resolves those references at startup and never puts
their values in its manifest, status, errors, Host Events, effect records, or
logs.

For example:

```sh
export EMAIL_SMTP_USERNAME_ENV=SECRET_SMTP_USER
export EMAIL_SMTP_PASSWORD_ENV=SECRET_SMTP_PASSWORD
export SECRET_SMTP_USER='service-account'
export SECRET_SMTP_PASSWORD='...'
```

`SmtpEmailTransport.ready()` verifies connectivity at startup. STARTTLS is
required whenever implicit TLS is not configured, so credentials are never
sent over a plaintext SMTP session. Runtime errors are classified from bounded
SMTP code/command metadata; an unphased connection close is conservatively
`delivery_unknown`. Raw server transcripts and credentials are not persisted
or returned.

SMTP concurrency and rate policy are explicit: configure
`EMAIL_SMTP_MAX_CONNECTIONS`, `EMAIL_SMTP_MAX_MESSAGES`, and
`EMAIL_SMTP_RATE_LIMIT_PER_SECOND`. Values are startup-validated and feed the
transport connection pool; they do not create a second retry policy.
Connection, greeting, and socket budgets are configured by the
`EMAIL_SMTP_*_TIMEOUT_MS` variables. Startup rejects a socket timeout that
reaches the dispatch lease, leaving time to persist a conservative outcome.

## Receipt ingress boundary

`ingestAuthenticatedReceipt()` in `src/receipts.ts` is the domain seam for a
future vendor webhook or DSN adapter. It requires already-verified
authentication metadata, caps normalized evidence at 16 KiB, computes a
canonical digest, and enforces `(source, remoteId)` replay safety in Postgres.
It is intentionally not mounted as a public HTTP route. Adding public ingress
requires a separate threat model for signature verification, timestamp
windows, key rotation, replay storage, network policy, and tenant routing.

## Verification

```sh
pnpm check
NOTIFICATION_MODULE_ROOT=/path/to/lenso-notification-module pnpm check:ecosystem
docker compose up -d postgres
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5442/lenso_email pnpm test:integration
lenso service package --check .
pnpm build
pnpm pack --dry-run
```

The Postgres suite runs the public
`verifyProviderInvocationStoreConformance()` vector, then proves email outcome
and receipt recovery through fresh Store adapters without resending.

The Service Kit durable APIs require `@lenso/service-kit@^0.6.0`. The committed
lockfile resolves that public package; release and container builds never use a
sibling-workspace or Git dependency.

## Install and lifecycle

With the Service running:

```sh
lenso service verify ./lenso.service.json \
  --manifest-url http://127.0.0.1:4112/lenso/service/v1/manifest \
  --ready-url http://127.0.0.1:4112/lenso/service/v1/status
lenso service install http://127.0.0.1:4112/lenso/service/v1/manifest --repo-root /path/to/host
lenso service list email-delivery --repo-root /path/to/host --json
lenso service status email-delivery lenso-email-provider-service --repo-root /path/to/host --json
lenso service doctor email-delivery --repo-root /path/to/host --json
```

Installation and Module readiness are visible in Console. Provider Calls and
Runtime Story remain Host-owned; credentials and raw receipt evidence are not
Console data.

## Operational notes

- Run migrations before enabling traffic, or set
  `DATABASE_AUTO_MIGRATE=true` for a single-process local environment.
- Do not delete unacknowledged Provider invocation outcomes. Production
  retention must exceed the Host recovery window and business audit policy.
- Keep `EMAIL_DISPATCH_LEASE_MS` longer than the transport timeout. A lease
  expiry is deliberately conservative and becomes `delivery_unknown`.
- Scale SMTP through Nodemailer's connection pool and provider-side quotas;
  do not add a second business retry policy inside this Service.
- Back up the Provider invocation, dispatch, and remote receipt tables as one
  recovery unit.
