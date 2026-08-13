import { describe, expect, test } from "vitest";

import { SmtpEmailTransport, type SmtpClient } from "../src/transports/smtp.js";
import { dispatchFixture } from "./fixtures.js";

const config = {
  connectionTimeoutMs: 5_000,
  fromAddress: "notifications@example.test",
  fromName: "Lenso",
  greetingTimeoutMs: 5_000,
  host: "smtp.example.test",
  maxConnections: 5,
  maxMessages: 100,
  password: "never-observed",
  port: 587,
  rateLimitPerSecond: 10,
  secure: false,
  socketTimeoutMs: 15_000,
  username: "service-account",
};

const client = (send: SmtpClient["sendMail"]): SmtpClient => ({
  close() {},
  sendMail: send,
  async verify() {},
});

describe("SMTP outcome classification", () => {
  test("maps SMTP 250 to accepted, not delivered", async () => {
    const transport = new SmtpEmailTransport(config, client(async () => ({
      accepted: ["member@example.test"],
      messageId: "smtp-1",
      response: "250 2.0.0 queued",
    })));
    await expect(transport.send(dispatchFixture())).resolves.toMatchObject({
      outcome: "accepted",
      remoteReceipt: { remoteId: "smtp-1", source: "smtp" },
    });
  });

  test("returns a known RCPT rejection as a business observation", async () => {
    const transport = new SmtpEmailTransport(config, client(async () => {
      throw { code: "EENVELOPE", command: "RCPT TO", responseCode: 451 };
    }));
    await expect(transport.send(dispatchFixture())).resolves.toMatchObject({
      failure: { classification: "transient" },
      outcome: "temporary_failure",
    });
  });

  test("returns an unconfirmed DATA side effect as delivery_unknown", async () => {
    const transport = new SmtpEmailTransport(config, client(async () => {
      throw { code: "ECONNECTION", command: "DATA" };
    }));
    await expect(transport.send(dispatchFixture())).resolves.toMatchObject({
      failure: { classification: "ambiguous" },
      outcome: "delivery_unknown",
    });
  });

  test("keeps proven pre-DATA failures on the technical rail", async () => {
    const auth = new SmtpEmailTransport(config, client(async () => {
      throw { code: "EAUTH", command: "AUTH", responseCode: 535 };
    }));
    const envelope = new SmtpEmailTransport(config, client(async () => {
      throw { code: "ETIMEDOUT", command: "MAIL FROM" };
    }));
    await expect(auth.send(dispatchFixture())).rejects.toMatchObject({ code: "smtp_authentication_failed", retryable: false });
    await expect(envelope.send(dispatchFixture())).rejects.toMatchObject({ code: "smtp_etimedout", retryable: true });
  });

  test("treats an unphased connection close conservatively as delivery_unknown", async () => {
    const connection = new SmtpEmailTransport(config, client(async () => {
      throw { code: "ECONNECTION", command: "CONN" };
    }));
    await expect(connection.send(dispatchFixture())).resolves.toMatchObject({
      failure: { classification: "ambiguous", code: "smtp_connection_outcome_unknown" },
      outcome: "delivery_unknown",
    });
  });

  test("treats an unknown or post-send SMTP command conservatively", async () => {
    const transport = new SmtpEmailTransport(config, client(async () => {
      throw { code: "ECONNECTION", command: "QUIT" };
    }));
    await expect(transport.send(dispatchFixture())).resolves.toMatchObject({
      failure: { classification: "ambiguous", code: "smtp_connection_outcome_unknown" },
      outcome: "delivery_unknown",
    });
  });
});
