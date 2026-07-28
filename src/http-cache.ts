import { buildCacheKey, normalizeUrl } from "./cache-key";
import type { Env } from "./env";

/** The wiki blocks anonymous user agents — every upstream request must carry this. */
export const USER_AGENT = "osrs-mcp/1.0 (personal project)";

export interface CachedFetchOptions {
  ttl: number;
  /**
   * Response statuses meaning "this player/page has no data" rather than a
   * failure. Returns null instead of throwing. Upstreams disagree on which
   * status to use: the hiscores 404, WikiSync answers 400 with a JSON error
   * body, so both are passed explicitly by the caller.
   */
  missingStatuses?: number[];
}

/**
 * Fetch JSON through the KV cache.
 *
 * Only successful responses are cached — an outage must not be remembered for
 * the full TTL.
 */
export async function cachedFetchJson<T>(
  env: Env,
  url: string,
  options: CachedFetchOptions,
): Promise<T | null> {
  const requestUrl = normalizeUrl(url);
  const key = await buildCacheKey(requestUrl);

  const cached = await env.WIKI_CACHE.get(key, "text");
  if (cached !== null) return JSON.parse(cached) as T;

  const response = await fetch(requestUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });

  if (options.missingStatuses?.includes(response.status)) return null;

  if (!response.ok) {
    throw new Error(`Upstream request failed (${response.status} ${response.statusText})`);
  }

  const body = await response.text();

  // The hiscores serve an HTML error page on some failures; parsing it as JSON
  // would throw something unhelpful, so fail with a clear message instead.
  let parsed: T;
  try {
    parsed = JSON.parse(body) as T;
  } catch {
    throw new Error("Upstream returned a non-JSON response");
  }

  await env.WIKI_CACHE.put(key, body, { expirationTtl: options.ttl });
  return parsed;
}
