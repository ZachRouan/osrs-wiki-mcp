import type { Env } from "./env";
import { cachedFetchJson, USER_AGENT } from "./http-cache";
import { stripHtml } from "./wikitext";

export { USER_AGENT };

const WIKI_API = "https://oldschool.runescape.wiki/api.php";
const PRICES_API = "https://prices.runescape.wiki/api/v1/osrs";

export const CACHE_TTL_SECONDS = 3600;
/** The item id mapping is effectively static; keep it for a day. */
export const MAPPING_TTL_SECONDS = 86_400;

/** Wiki responses always exist; a null here means an upstream failure. */
async function fetchWikiJson<T>(env: Env, url: string, ttl: number = CACHE_TTL_SECONDS): Promise<T> {
  const result = await cachedFetchJson<T>(env, url, { ttl });
  if (result === null) throw new Error("Upstream returned no data");
  return result;
}

function wikiApiUrl(params: Record<string, string>): string {
  const url = new URL(WIKI_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export interface SearchHit {
  title: string;
  snippet: string;
}

interface SearchResponse {
  query?: { search?: Array<{ title: string; snippet: string }> };
}

export async function searchPages(env: Env, query: string, limit = 5): Promise<SearchHit[]> {
  const url = wikiApiUrl({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(limit),
    format: "json",
    formatversion: "2",
  });
  const data = await fetchWikiJson<SearchResponse>(env, url);
  return (data.query?.search ?? []).map((hit) => ({
    title: hit.title,
    snippet: stripHtml(hit.snippet ?? ""),
  }));
}

interface RevisionsResponse {
  query?: {
    pages?: Array<{
      title: string;
      missing?: boolean;
      revisions?: Array<{ slots?: { main?: { content?: string } } }>;
    }>;
  };
}

export interface PageWikitext {
  title: string;
  wikitext: string;
}

/** Raw wikitext for `title`, or null when the page does not exist. */
export async function getWikitext(env: Env, title: string): Promise<PageWikitext | null> {
  const url = wikiApiUrl({
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    titles: title,
    redirects: "1",
    format: "json",
    formatversion: "2",
  });
  const data = await fetchWikiJson<RevisionsResponse>(env, url);
  const page = data.query?.pages?.[0];
  if (!page || page.missing) return null;

  const content = page.revisions?.[0]?.slots?.main?.content;
  if (typeof content !== "string") return null;
  return { title: page.title, wikitext: content };
}

export interface MappingEntry {
  id: number;
  name: string;
  examine?: string;
  members?: boolean;
}

export async function getItemMapping(env: Env): Promise<MappingEntry[]> {
  return fetchWikiJson<MappingEntry[]>(env, `${PRICES_API}/mapping`, MAPPING_TTL_SECONDS);
}

export interface LatestPrice {
  high: number | null;
  highTime: number | null;
  low: number | null;
  lowTime: number | null;
}

interface LatestResponse {
  data?: Record<string, LatestPrice>;
}

export async function getLatestPrice(env: Env, itemId: number): Promise<LatestPrice | null> {
  const data = await fetchWikiJson<LatestResponse>(env, `${PRICES_API}/latest?id=${itemId}`);
  return data.data?.[String(itemId)] ?? null;
}

/**
 * Resolve a user-supplied item name to a mapping entry: exact case-insensitive
 * match first, then the shortest name containing the query.
 */
export function resolveItem(mapping: MappingEntry[], query: string): MappingEntry | null {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;

  const exact = mapping.find((entry) => entry.name.toLowerCase() === wanted);
  if (exact) return exact;

  const candidates = mapping.filter((entry) => entry.name.toLowerCase().includes(wanted));
  if (candidates.length === 0) return null;

  return candidates.reduce((best, entry) => {
    const startsBest = best.name.toLowerCase().startsWith(wanted);
    const startsEntry = entry.name.toLowerCase().startsWith(wanted);
    if (startsEntry !== startsBest) return startsEntry ? entry : best;
    return entry.name.length < best.name.length ? entry : best;
  });
}
