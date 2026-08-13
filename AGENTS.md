# Agent instructions

Before planning, changing, or executing a release, read
`.github/workflows/release-changesets.yml`. Do not infer production authority
from repository write access. npm publication requires the repository's
Trusted Publisher workflow and explicit approval.

This repository is the out-of-process Email Provider Service. Notification
owns send intent, render snapshot, business attempts, retry decisions, and
final delivery state. The Host owns Provider authentication, technical retry,
queues, Provider Calls, and Runtime Story.

- Use only public `@lenso/service-kit` Provider contracts.
- Keep Provider invocation outcomes and email dispatch observations durable.
- Bind stable business identity to `functionRunId` plus the canonical payload
  digest; reject identity drift.
- SMTP or vendor acceptance is `accepted`, never `delivered`.
- Treat an ambiguous post-side-effect failure as `delivery_unknown`; never
  resend it automatically.
- Resolve credentials from secret references and never serialize values,
  transport transcripts, or full remote evidence.
- Non-loopback Provider V1 listeners require inbound bearer authentication.
- Keep SMS, Push, marketing campaigns, and template editing outside this
  Service.

Issues and PRDs live in the central `LioRael/lenso` tracker. See
`docs/agents/issue-tracker.md`.
