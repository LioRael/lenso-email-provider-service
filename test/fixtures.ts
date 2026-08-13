import { computeMessageContentDigest, type EmailDispatchRequested } from "../src/contracts.js";

export const dispatchFixture = (overrides: Partial<EmailDispatchRequested> = {}): EmailDispatchRequested => {
  const messageWithoutDigest = {
    html: "<p>You are invited.</p>",
    locale: "en-US",
    subject: "Join Acme",
    templateId: "organization-invitation",
    templateVersion: "v1",
    text: "You are invited.",
  };
  return {
    attemptId: "attempt-1",
    channel: "email",
    context: { correlationId: "correlation-1" },
    deliveryId: "delivery-1",
    functionRunId: "function-run-1",
    idempotencyKey: "organization-invitation:invite-1",
    message: { ...messageWithoutDigest, contentDigest: computeMessageContentDigest(messageWithoutDigest) },
    recipient: { address: "member@example.test" },
    ...overrides,
  };
};
