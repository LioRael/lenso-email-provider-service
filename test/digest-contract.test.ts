import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { canonicalJson } from "../src/canonical.js";
import { computeMessageContentDigest } from "../src/contracts.js";
import { canonicalDigest } from "../src/canonical.js";
import {
  contractDigests,
  emailContractBundleDigest,
  MODULE_ID,
  providerManifest,
  providerV1Base,
  service,
} from "../src/service.js";
import { dispatchFixture } from "./fixtures.js";

const sha = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

describe("cross-repository email contracts", () => {
  test("pins Provider descriptor digests to the exact packaged schemas", async () => {
    const schema = async (name: string) => JSON.parse(await readFile(new URL(`../contracts/${name}`, import.meta.url), "utf8")) as unknown;
    expect(contractDigests.dispatch).toBe(sha(await schema("lenso.email.dispatch-requested.v1.schema.json")));
    expect(contractDigests.dispatchObserved).toBe(sha(await schema("lenso.email.dispatch-observed.v1.schema.json")));
    expect(contractDigests.receiptObserved).toBe(sha(await schema("lenso.email.receipt-observed.v1.schema.json")));
    expect(emailContractBundleDigest).toBe(canonicalDigest({ protocol: "lenso.email-contract-bundle.v1", schemas: contractDigests }));
    expect(Object.values(providerV1Base.exports[0]!.contractDigests)).toEqual([emailContractBundleDigest]);
  });

  test("serializes the Provider Manifest in the Rust canonical shape", () => {
    expect(providerManifest.admin).toBeNull();
    expect(providerManifest).not.toHaveProperty("config");
    expect(providerManifest.module_id).toBe(MODULE_ID);
    expect(providerManifest.requires).toEqual([]);
  });

  test("exports the canonical qualified Module identity from the Service manifest", () => {
    const serialized = JSON.parse(JSON.stringify(service)) as {
      modules: Array<{ module_id: string; protocol: string }>;
    };
    expect(serialized.modules).toHaveLength(1);
    expect(serialized.modules[0]).toMatchObject({ module_id: MODULE_ID });
    expect(serialized.modules[0]?.protocol).toBe("lenso.module-manifest.v1");
  });

  test("uses the same length-prefixed rendering digest as Notification", () => {
    const message = dispatchFixture().message;
    expect(computeMessageContentDigest(message)).toBe("sha256:455cbfb8e821db0b3bbf76a391224409f6aaa1ab390ef8fe21d9b7cef814078a");
  });
});
