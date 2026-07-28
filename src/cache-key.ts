/**
 * Cache key construction.
 *
 * Workers KV rejects keys longer than 512 bytes, and a long page title expands
 * further once percent-encoded — so any key over the limit is replaced by a
 * digest of itself rather than being allowed to fail the request.
 */

/** Workers KV hard limit on key length, in bytes. */
export const MAX_KV_KEY_BYTES = 512;

/** Leaves room for the `sha256:` prefix and avoids sitting exactly on the limit. */
const SAFE_KEY_BYTES = 480;

/** Sort query parameters so key ordering never splits the cache. */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  return parsed.toString();
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The KV key for an upstream request URL. Short keys stay human-readable so the
 * cache can be inspected with `wrangler kv key list`; over-long keys collapse to
 * a stable SHA-256 digest.
 */
export async function buildCacheKey(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  const encoded = new TextEncoder().encode(normalized);

  if (encoded.length <= SAFE_KEY_BYTES) return normalized;

  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${toHex(digest)}`;
}
