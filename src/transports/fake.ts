import { canonicalDigest, stableId } from "../canonical.js";
import type { EmailDispatchOutcome, EmailDispatchRequested, SanitizedRemoteReceipt } from "../contracts.js";
import type { EmailTransport, TransportObservation } from "./email-transport.js";

export type FakeEmailMode = EmailDispatchOutcome | "delivered";

export class FakeEmailTransport implements EmailTransport {
  readonly name = "fake";
  private index = 0;

  constructor(private readonly sequence: readonly FakeEmailMode[] = ["delivered"]) {
    if (sequence.length === 0) throw new Error("Fake transport sequence cannot be empty");
  }

  async ready(): Promise<void> {}
  async close(): Promise<void> {}

  async send(request: EmailDispatchRequested): Promise<TransportObservation> {
    const mode = this.sequence[Math.min(this.index, this.sequence.length - 1)]!;
    this.index += 1;
    const observedAt = new Date(Date.UTC(2026, 7, 13, 0, 0, this.index)).toISOString();
    if (mode === "accepted" || mode === "delivered") {
      const receiptWithoutDigest = {
        remoteId: stableId("fake", { index: this.index, functionRunId: request.functionRunId }),
        source: "fake",
      };
      const remoteReceipt: SanitizedRemoteReceipt = {
        ...receiptWithoutDigest,
        digest: canonicalDigest(receiptWithoutDigest),
      };
      return {
        ...(mode === "delivered"
          ? {
              authoritativeReceipt: {
                evidence: { mode: "delivered" },
                kind: "delivered" as const,
                observedAt,
                remoteId: remoteReceipt.remoteId,
                source: remoteReceipt.source,
              },
            }
          : {}),
        observedAt,
        outcome: "accepted",
        remoteReceipt,
      };
    }
    const classification = mode === "delivery_unknown" ? "ambiguous" : mode === "temporary_failure" ? "transient" : "permanent";
    return {
      failure: {
        classification,
        code: `fake_${mode}`,
        retryAfterMs: mode === "temporary_failure" ? 1_000 : null,
      },
      observedAt,
      outcome: mode,
    };
  }

  get sends(): number {
    return this.index;
  }
}
