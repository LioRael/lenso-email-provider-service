import { createHash } from "node:crypto";

const canonicalString = (value: string): string => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Canonical JSON cannot contain an unpaired surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Canonical JSON cannot contain an unpaired surrogate");
    }
  }
  return JSON.stringify(value);
};

export const canonicalJson = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): string => {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON cannot contain a cycle");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError("Canonical JSON only accepts plain objects and arrays");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON cannot contain a sparse array");
        }
        entries.push(canonicalJson(value[index], seen));
      }
      return `[${entries.join(",")}]`;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON cannot contain symbol keys");
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalString(key)}:${canonicalJson((value as Record<string, unknown>)[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

export const canonicalDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

export const stableId = (prefix: string, value: unknown): string =>
  `${prefix}_${canonicalDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
