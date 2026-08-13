# Architecture decisions

## Boundary

`lenso/email-delivery` is a Host-managed Provider Module. It is not an
Autonomous Service: it has no public client ingress, independent workload
control plane, or generic Store API. Postgres exists to make its own Provider
effects and receipts durable across retries and restarts.

## Two idempotency layers

The Provider invocation Store binds one outer `invocationId` to the canonical
Provider request digest and immutable outcome. The email dispatch ledger binds
the stable Notification `functionRunId` to the immutable rendering digest and
transport observation. The first protects Host technical delivery; the second
protects the business side effect when different outer invocations refer to
the same Notification attempt.

Both layers fail closed on digest conflict. Acknowledgement records the exact
Provider outcome digest; it does not delete evidence.

Provider V1 currently selects exactly one unkeyed contract digest for every
operation in an export. This Service therefore exposes one canonical email
contract-bundle digest whose content addresses each exact schema digest; each
handler additionally validates its exact payload and Runtime envelope. Move to
per-operation keyed input/output digests when the framework contract supports
that finer mapping.

## Honesty at the SMTP boundary

An SMTP `250` means the next hop accepted responsibility. It cannot prove
mailbox delivery. The service therefore emits `accepted`. `delivered` is
reserved for authenticated receipt evidence or the explicit deterministic
fixture transport.

When an error includes a known SMTP response code, it is a business
observation. A connection/authentication failure before message submission is
a technical failure. A lost/invalid response after `DATA`, or an abandoned
dispatch lease, is `delivery_unknown`; blindly retrying would risk duplicate
mail.

## Receipt seam

The receipt seam accepts normalized evidence only after an ingress adapter has
verified its signature/DSN authenticity. It stores the verification mechanism
and key reference, never the key. `(source, remoteId)` is the replay identity;
the canonical digest detects mutation. Public ingress remains deferred.
The first authoritative terminal receipt for a business attempt is immutable.
A later receipt with a different source, remote identity, digest, or terminal
kind is quarantined as a conflict and is never emitted as a newer state.
