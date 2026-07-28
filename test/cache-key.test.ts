import { describe, expect, it } from "vitest";

import { buildCacheKey, MAX_KV_KEY_BYTES, normalizeUrl } from "../src/cache-key";

const API = "https://oldschool.runescape.wiki/api.php";

const byteLength = (value: string) => new TextEncoder().encode(value).length;

describe("normalizeUrl", () => {
  it("sorts query parameters so ordering never splits the cache", () => {
    const a = normalizeUrl(`${API}?titles=Dragon+boots&action=query&format=json`);
    const b = normalizeUrl(`${API}?format=json&action=query&titles=Dragon+boots`);
    expect(a).toBe(b);
  });

  it("keeps distinct requests distinct", () => {
    expect(normalizeUrl(`${API}?titles=Steel+ring`)).not.toBe(normalizeUrl(`${API}?titles=Dragon+boots`));
  });
});

describe("buildCacheKey", () => {
  it("leaves short keys readable for cache inspection", async () => {
    const key = await buildCacheKey(`${API}?action=query&titles=Dragon+boots`);
    expect(key).toContain("oldschool.runescape.wiki");
    expect(key).not.toMatch(/^sha256:/);
  });

  it("stays within the KV key limit for very long titles", async () => {
    // Regression: a 600-character title produced a 744-byte key and the request
    // failed with "exceeds key length limit of 512".
    const key = await buildCacheKey(`${API}?action=query&titles=${"A".repeat(600)}`);
    expect(byteLength(key)).toBeLessThanOrEqual(MAX_KV_KEY_BYTES);
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("survives characters that expand under percent-encoding", async () => {
    const key = await buildCacheKey(`${API}?action=query&titles=${encodeURIComponent("é".repeat(400))}`);
    expect(byteLength(key)).toBeLessThanOrEqual(MAX_KV_KEY_BYTES);
  });

  it("is deterministic", async () => {
    const url = `${API}?action=query&titles=${"B".repeat(600)}`;
    expect(await buildCacheKey(url)).toBe(await buildCacheKey(url));
  });

  it("gives different long requests different keys", async () => {
    const first = await buildCacheKey(`${API}?action=query&titles=${"C".repeat(600)}`);
    const second = await buildCacheKey(`${API}?action=query&titles=${"D".repeat(600)}`);
    expect(first).not.toBe(second);
  });

  it("hashes the normalized form, so param order still does not matter", async () => {
    const long = "E".repeat(600);
    const a = await buildCacheKey(`${API}?titles=${long}&action=query`);
    const b = await buildCacheKey(`${API}?action=query&titles=${long}`);
    expect(a).toBe(b);
  });
});
