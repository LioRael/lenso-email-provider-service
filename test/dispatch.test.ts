import { describe, expect, test } from "vitest";

import { computeMessageContentDigest, parseDispatchRequested } from "../src/contracts.js";
import { DispatchEngine, DispatchInProgressError } from "../src/dispatch.js";
import { DispatchIdentityConflictError } from "../src/store/email-ledger.js";
import type { EmailTransport } from "../src/transports/email-transport.js";
import { TransportTechnicalFailure } from "../src/transports/email-transport.js";
import { FakeEmailTransport } from "../src/transports/fake.js";
import { dispatchFixture } from "./fixtures.js";
import { MemoryEmailLedger } from "./support/memory-ledger.js";

describe("transactional email dispatch", () => {
  test("validates the rendering snapshot digest", () => {
    const request = dispatchFixture();
    expect(parseDispatchRequested(request)).toEqual(request);
    expect(() => parseDispatchRequested({ ...request, message: { ...request.message, subject: "changed" } })).toThrow("does not match");
    expect(computeMessageContentDigest({ ...request.message, subject: "changed" })).not.toBe(request.message.contentDigest);
  });

  test("replays a committed attempt without sending twice", async () => {
    const ledger = new MemoryEmailLedger();
    const transport = new FakeEmailTransport(["accepted"]);
    const engine = new DispatchEngine({ leaseMs: 30_000, ledger, providerName: "fixture", transport });
    const request = dispatchFixture();
    const first = await engine.dispatch(request);
    const replay = await engine.dispatch(request);
    expect(first.outcome).toBe("accepted");
    expect(replay).toEqual(first);
    expect(transport.sends).toBe(1);
  });

  test("fails closed when one business attempt is rebound to different content", async () => {
    const ledger = new MemoryEmailLedger();
    const engine = new DispatchEngine({ leaseMs: 30_000, ledger, providerName: "fixture", transport: new FakeEmailTransport() });
    const request = dispatchFixture();
    await engine.dispatch(request);
    const text = "Different immutable snapshot";
    const message = { ...request.message, text };
    message.contentDigest = computeMessageContentDigest(message);
    await expect(engine.dispatch({ ...request, message })).rejects.toBeInstanceOf(DispatchIdentityConflictError);
  });

  test("reserves Host retry for a technical failure before a known outcome", async () => {
    const ledger = new MemoryEmailLedger();
    let sends = 0;
    const transport: EmailTransport = {
      async close() {},
      name: "technical-fixture",
      async ready() {},
      async send(request) {
        sends += 1;
        if (sends === 1) throw new TransportTechnicalFailure("connection_refused", true, 100);
        return new FakeEmailTransport(["delivered"]).send(request);
      },
    };
    const engine = new DispatchEngine({ leaseMs: 30_000, ledger, providerName: "fixture", transport });
    await expect(engine.dispatch(dispatchFixture())).rejects.toMatchObject({ code: "connection_refused", retryable: true });
    await expect(engine.dispatch(dispatchFixture())).resolves.toMatchObject({ outcome: "accepted" });
    expect(sends).toBe(2);
  });

  test("conservatively commits an unknown transport throw as delivery_unknown", async () => {
    const ledger = new MemoryEmailLedger();
    let sends = 0;
    const transport: EmailTransport = {
      async close() {},
      name: "unknown-fixture",
      async ready() {},
      async send() {
        sends += 1;
        throw new Error("unclassified transport failure");
      },
    };
    const engine = new DispatchEngine({ leaseMs: 30_000, ledger, providerName: "fixture", transport });
    const request = dispatchFixture();
    await expect(engine.dispatch(request)).resolves.toMatchObject({ outcome: "delivery_unknown" });
    await expect(engine.dispatch(request)).resolves.toMatchObject({ outcome: "delivery_unknown" });
    expect(sends).toBe(1);
  });

  test("does not steal an active lease and never resends an expired ambiguous attempt", async () => {
    const ledger = new MemoryEmailLedger();
    const transport = new FakeEmailTransport(["delivered"]);
    let now = new Date("2026-08-13T00:00:00.000Z");
    const engine = new DispatchEngine({ clock: () => now, leaseMs: 1_000, ledger, providerName: "fixture", transport });
    const request = dispatchFixture();
    await ledger.claimDispatch({ eventDigest: (await import("../src/canonical.js")).canonicalDigest(request), leaseMs: 1_000, now: now.toISOString(), request, transport: transport.name });
    await expect(engine.dispatch(request)).rejects.toBeInstanceOf(DispatchInProgressError);
    now = new Date("2026-08-13T00:00:02.000Z");
    await expect(engine.dispatch(request)).resolves.toMatchObject({ outcome: "delivery_unknown" });
    expect(transport.sends).toBe(0);
  });
});
