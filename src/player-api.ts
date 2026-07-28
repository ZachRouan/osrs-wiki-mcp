import type { Env } from "./env";
import { cachedFetchJson, USER_AGENT } from "./http-cache";
import type { RawHiscores } from "./hiscores";
import type { RawWikiSync } from "./wikisync";
import type { RawGains } from "./wom";

/** Player data changes as the account is played, so it is cached only briefly. */
export const PLAYER_TTL_SECONDS = 300;

const HISCORES_IRONMAN = "https://secure.runescape.com/m=hiscore_oldschool_ironman/index_lite.json";
const HISCORES_STANDARD = "https://secure.runescape.com/m=hiscore_oldschool/index_lite.json";
const WIKISYNC = "https://sync.runescape.wiki/runelite/player";
const WOM = "https://api.wiseoldman.net/v2/players";

export type HiscoresBoard = "ironman" | "standard";

export interface HiscoresLookup {
  board: HiscoresBoard;
  raw: RawHiscores;
}

/**
 * Look the player up on the ironman board first, then the standard board.
 *
 * A missing account returns 404 with an HTML error page, so the status has to
 * decide the outcome — the body is not parseable.
 */
export async function fetchHiscores(env: Env, username: string): Promise<HiscoresLookup | null> {
  const query = `?player=${encodeURIComponent(username)}`;

  const ironman = await cachedFetchJson<RawHiscores>(env, `${HISCORES_IRONMAN}${query}`, {
    ttl: PLAYER_TTL_SECONDS,
    missingStatuses: [404],
  });
  if (ironman) return { board: "ironman", raw: ironman };

  const standard = await cachedFetchJson<RawHiscores>(env, `${HISCORES_STANDARD}${query}`, {
    ttl: PLAYER_TTL_SECONDS,
    missingStatuses: [404],
  });
  if (standard) return { board: "standard", raw: standard };

  return null;
}

/**
 * WikiSync data, or null when the player has never synced.
 *
 * The service answers 400 with `{"code":"NO_USER_DATA"}` for an unsynced
 * player rather than the 404 you would expect.
 */
export async function fetchWikiSync(env: Env, username: string): Promise<RawWikiSync | null> {
  return cachedFetchJson<RawWikiSync>(
    env,
    `${WIKISYNC}/${encodeURIComponent(username)}/STANDARD`,
    { ttl: PLAYER_TTL_SECONDS, missingStatuses: [400, 404] },
  );
}

export interface WomPlayer {
  displayName?: string;
  type?: string;
  build?: string;
  combatLevel?: number;
  exp?: number;
  ehp?: number;
  ehb?: number;
}

export async function fetchWomPlayer(env: Env, username: string): Promise<WomPlayer | null> {
  return cachedFetchJson<WomPlayer>(env, `${WOM}/${encodeURIComponent(username)}`, {
    ttl: PLAYER_TTL_SECONDS,
    missingStatuses: [404],
  });
}

export async function fetchWomGains(
  env: Env,
  username: string,
  period: string,
): Promise<RawGains | null> {
  return cachedFetchJson<RawGains>(
    env,
    `${WOM}/${encodeURIComponent(username)}/gained?period=${encodeURIComponent(period)}`,
    { ttl: PLAYER_TTL_SECONDS, missingStatuses: [404] },
  );
}

/**
 * Ask Wise Old Man to start tracking a player. Not cached — it is a mutation,
 * and the point is to change server state before retrying the read.
 */
export async function trackWomPlayer(username: string): Promise<boolean> {
  try {
    const response = await fetch(`${WOM}/${encodeURIComponent(username)}`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
