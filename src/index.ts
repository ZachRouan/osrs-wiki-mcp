import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Env } from "./env";
import { combatLevel, parseHiscores } from "./hiscores";
import { handleIngest, INGEST_PATH } from "./ingest";
import { parseInfoboxes } from "./infobox";
import {
  checkMaterials,
  CONTAINERS,
  describeAge,
  searchItems,
  topByQuantity,
  totalQuantity,
} from "./items";
import { readAllContainers, readContainer, readSyncIndex } from "./item-store";
import { secureEquals } from "./secure-compare";
import {
  fetchHiscores,
  fetchWikiSync,
  fetchWomGains,
  fetchWomPlayer,
  trackWomPlayer,
} from "./player-api";
import { wrapUntrusted } from "./untrusted";
import { getItemMapping, getLatestPrice, getWikitext, resolveItem, searchPages } from "./wiki";
import { parseWikiSync } from "./wikisync";
import { cleanPageWikitext, extractSection, truncateWithNotice } from "./wikitext";
import { parseGains } from "./wom";

export type { Env };

/** OSRS display names are at most 12 characters. */
const MAX_USERNAME_LENGTH = 12;

const WIKISYNC_HELP =
  "This account has never synced with WikiSync. To enable it: install the WikiSync plugin in " +
  "RuneLite (Plugin Hub), make sure it is enabled, then log into the game once. Quest and diary " +
  "data appears after that first login.";

const ITEM_SYNC_HELP =
  "No item snapshot has ever been received for this account. Bank, inventory and equipment " +
  "contents are not available from any public API — they come from the runelite-item-sync " +
  "plugin in this project, which pushes them from the game client. See the 'RuneLite item sync' " +
  "section of the project README for build and sideload instructions. Once the plugin is " +
  "installed and configured, open your bank in game to send the first snapshot.";

/** An unfiltered bank is thousands of lines, so summarise instead. */
const BANK_SUMMARY_LIMIT = 50;

/** Enough for a full recipe's material list, with room to spare. */
const MAX_MATERIALS_PER_CALL = 30;

/**
 * MediaWiki titles cap at 255 bytes; anything longer cannot name a real page.
 * Bounding these at the tool boundary keeps absurd input from reaching KV.
 */
const MAX_TITLE_LENGTH = 255;
const MAX_QUERY_LENGTH = 300;
const MAX_ITEM_LENGTH = 100;

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function formatHits(hits: Array<{ title: string; snippet: string }>): string {
  return hits.map((hit) => `${hit.title}\n  ${hit.snippet || "(no snippet)"}`).join("\n\n");
}

function formatCoins(amount: number | null): string {
  return amount === null ? "unknown" : `${amount.toLocaleString("en-US")} gp`;
}

function formatTimestamp(seconds: number | null): string {
  if (seconds === null) return "unknown time";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

export class OsrsWikiMCP extends McpAgent<Env> {
  server = new McpServer({ name: "osrs-wiki", version: "3.0.0" });

  /**
   * Resolve the account to look at: the supplied name, else DEFAULT_PLAYER.
   * Returns null when neither is available, so the caller can explain rather
   * than query the hiscores for an empty string.
   */
  private resolvePlayer(username?: string): string | null {
    const explicit = username?.trim();
    if (explicit) return explicit;

    const fallback = this.env.DEFAULT_PLAYER?.trim();
    return fallback ? fallback : null;
  }

  async init() {
    this.server.tool(
      "search_pages",
      "[osrs-wiki v3] Search the Old School RuneScape Wiki and return the top 5 matching page " +
        "titles with a plain-text snippet each. Use this to find the exact page title before " +
        "calling get_page or get_infobox. Note: this server ALSO provides live player-account " +
        "tools — get_player_stats, get_quest_progress, get_gains and get_account_summary for the " +
        "user's real levels, quests and progress, and get_bank, get_equipment and " +
        "check_materials for what they actually own.",
      {
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_LENGTH)
          .describe("Search terms, e.g. 'burning amulet' or 'dragon slayer'"),
      },
      async ({ query }) => {
        const hits = await searchPages(this.env, query, 5);
        if (hits.length === 0) return text(`No wiki pages matched "${query}".`);
        return text(wrapUntrusted(`search results for "${query}"`, formatHits(hits)));
      },
    );

    this.server.tool(
      "get_page",
      "Read the prose of an Old School RuneScape Wiki page as cleaned plain text. Use this for " +
        "narrative topics such as quest walkthroughs, strategy, mechanics and lore. For item " +
        "recipes, stats and requirements prefer get_infobox, which returns exact structured " +
        "fields instead of prose.",
      {
        title: z
          .string()
          .min(1)
          .max(MAX_TITLE_LENGTH)
          .describe("Exact page title, e.g. 'Dragon Slayer II'"),
        section: z
          .string()
          .max(MAX_TITLE_LENGTH)
          .optional()
          .describe("Optional section heading to return on its own, e.g. 'Creation' or 'Rewards'"),
      },
      async ({ title, section }) => {
        const page = await getWikitext(this.env, title);

        if (!page) {
          const suggestions = await searchPages(this.env, title, 3);
          if (suggestions.length === 0) {
            return text(`No page titled "${title}" exists, and no similar pages were found.`);
          }
          return text(
            `No page titled "${title}" exists. Closest matches:\n\n${formatHits(suggestions)}`,
          );
        }

        let body = page.wikitext;
        if (section) {
          const extracted = extractSection(body, section);
          if (extracted === null) {
            return text(
              `Page "${page.title}" has no section named "${section}". ` +
                `Call get_page without the section argument to see the whole page.`,
            );
          }
          body = extracted;
        }

        // Truncate before wrapping so the closing marker is never cut off.
        const cleaned = truncateWithNotice(cleanPageWikitext(body));
        const label = section ? `${page.title} — ${section}` : page.title;
        return text(wrapUntrusted(label, cleaned));
      },
    );

    this.server.tool(
      "get_infobox",
      "Get the structured infobox data for an Old School RuneScape Wiki page as JSON. " +
        "ALWAYS use this for item recipes, crafting materials, level requirements, quest " +
        "requirements, monster stats, and drop sources. Do not answer OSRS item/recipe questions " +
        "from memory. Returns the parsed template fields, including Recipe templates (materials " +
        "as mat1/mat2/..., skill requirements as skill1/skill1lvl) and a versions array for " +
        "items with multiple variants such as charge levels.",
      {
        title: z
          .string()
          .min(1)
          .max(MAX_TITLE_LENGTH)
          .describe("Exact page title, e.g. 'Burning amulet'"),
      },
      async ({ title }) => {
        const page = await getWikitext(this.env, title);

        if (!page) {
          const suggestions = await searchPages(this.env, title, 3);
          if (suggestions.length === 0) {
            return text(`No page titled "${title}" exists, and no similar pages were found.`);
          }
          return text(
            `No page titled "${title}" exists. Closest matches:\n\n${formatHits(suggestions)}`,
          );
        }

        const parsed = parseInfoboxes(page.wikitext);
        if (!parsed) {
          const preview = cleanPageWikitext(page.wikitext).slice(0, 500);
          return text(
            `No infobox or recipe template was found on "${page.title}". ` +
              `First 500 characters of the page:\n\n${preview}`,
          );
        }

        return text(
          wrapUntrusted(page.title, JSON.stringify({ title: page.title, ...parsed }, null, 2)),
        );
      },
    );

    this.server.tool(
      "ge_price",
      "Get the latest Grand Exchange price for a tradeable Old School RuneScape item, resolved " +
        "by item name. Returns the most recent high (buy) and low (sell) prices with their " +
        "timestamps. Use this for current prices; do not answer price questions from memory.",
      {
        item: z
          .string()
          .min(1)
          .max(MAX_ITEM_LENGTH)
          .describe("Item name, e.g. 'Dragon boots' or 'Abyssal whip'"),
      },
      async ({ item }) => {
        const mapping = await getItemMapping(this.env);
        const match = resolveItem(mapping, item);

        if (!match) {
          return text(
            `No tradeable Grand Exchange item matches "${item}". ` +
              `Untradeable items have no GE price.`,
          );
        }

        const price = await getLatestPrice(this.env, match.id);
        if (!price) {
          return text(`No recent Grand Exchange trades are recorded for ${match.name} (id ${match.id}).`);
        }

        const resolvedNote =
          match.name.toLowerCase() === item.trim().toLowerCase()
            ? ""
            : `\n(resolved "${item}" to the closest tradeable item)`;

        return text(
          `${match.name} (item id ${match.id})\n` +
            `High (buy): ${formatCoins(price.high)} at ${formatTimestamp(price.highTime)}\n` +
            `Low (sell): ${formatCoins(price.low)} at ${formatTimestamp(price.lowTime)}${resolvedNote}`,
        );
      },
    );
    const username = z
      .string()
      .min(1)
      .max(MAX_USERNAME_LENGTH)
      .optional()
      .describe("OSRS username. Omit to use the server's configured default player.");

    const noPlayer = text(
      "No username was given and no DEFAULT_PLAYER is configured on the server. " +
        "Ask the user for their OSRS username, or set DEFAULT_PLAYER.",
    );

    this.server.tool(
      "get_player_stats",
      "Get a player's CURRENT skill levels, XP, and boss killcounts from official hiscores. " +
        "Use this instead of asking the user their levels or trusting levels stated earlier in " +
        "a conversation — they change as the user plays.",
      { username },
      async ({ username: name }) => {
        const player = this.resolvePlayer(name);
        if (!player) return noPlayer;

        try {
          const lookup = await fetchHiscores(this.env, player);
          if (!lookup) {
            return text(
              `No hiscores entry for "${player}" on either the ironman or standard board. ` +
                `Check the spelling — names are as displayed in game.`,
            );
          }

          const parsed = parseHiscores(lookup.raw, player);
          return text(
            JSON.stringify(
              {
                username: parsed.name,
                board: lookup.board,
                combat_level: combatLevel(parsed.skills),
                skills: parsed.skills,
                bosses: parsed.bosses,
                activities: parsed.activities,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return text(`Could not reach the hiscores for "${player}": ${describe(error)}`);
        }
      },
    );

    this.server.tool(
      "get_quest_progress",
      "Get a player's actual quest completion states and achievement diary progress via " +
        "WikiSync. Use before giving quest advice.",
      { username },
      async ({ username: name }) => {
        const player = this.resolvePlayer(name);
        if (!player) return noPlayer;

        try {
          const raw = await fetchWikiSync(this.env, player);
          if (!raw) return text(`No WikiSync data for "${player}". ${WIKISYNC_HELP}`);

          return text(JSON.stringify(parseWikiSync(raw, player), null, 2));
        } catch (error) {
          return text(`Could not reach WikiSync for "${player}": ${describe(error)}`);
        }
      },
    );

    this.server.tool(
      "get_gains",
      "Get a player's recent XP and boss KC gains from Wise Old Man over a chosen period. " +
        "Use for questions about progress, what the user has been training, or how fast they " +
        "are going.",
      {
        username,
        period: z
          .enum(["day", "week", "month", "year"])
          .default("week")
          .describe("Time window for the gains"),
      },
      async ({ username: name, period }) => {
        const player = this.resolvePlayer(name);
        if (!player) return noPlayer;

        try {
          let raw = await fetchWomGains(this.env, player, period);

          // Wise Old Man only reports gains for accounts it already tracks, so
          // register the player and try once more before giving up.
          if (!raw) {
            const tracked = await trackWomPlayer(player);
            if (tracked) raw = await fetchWomGains(this.env, player, period);
          }

          if (!raw) {
            return text(
              `"${player}" is not tracked on Wise Old Man, and automatically adding them failed. ` +
                `Add the account at https://wiseoldman.net/players/${encodeURIComponent(player)} ` +
                `(or type "!update ${player}" in a WOM-enabled Discord), then try again.`,
            );
          }

          return text(JSON.stringify(parseGains(raw, period), null, 2));
        } catch (error) {
          return text(`Could not reach Wise Old Man for "${player}": ${describe(error)}`);
        }
      },
    );

    this.server.tool(
      "get_account_summary",
      "Fetch a combined live snapshot of a player's account (stats + quests + diaries). " +
        "Call this FIRST when giving any account-specific advice.",
      { username },
      async ({ username: name }) => {
        const player = this.resolvePlayer(name);
        if (!player) return noPlayer;

        // Tolerate partial failure: a summary with stats but no quests is far
        // more useful than an error because one upstream was down.
        const [hiscores, wikisync, wom] = await Promise.allSettled([
          fetchHiscores(this.env, player),
          fetchWikiSync(this.env, player),
          fetchWomPlayer(this.env, player),
        ]);

        const summary: Record<string, unknown> = { username: player };
        const problems: string[] = [];

        if (hiscores.status === "fulfilled" && hiscores.value) {
          const parsed = parseHiscores(hiscores.value.raw, player);
          const skill = (key: string) => parsed.skills[key]?.level ?? 1;

          summary.board = hiscores.value.board;
          summary.total_level = parsed.skills.overall?.level ?? null;
          summary.total_xp = parsed.skills.overall?.xp ?? null;
          summary.combat_level = combatLevel(parsed.skills);
          summary.combat_skills = {
            attack: skill("attack"),
            strength: skill("strength"),
            defence: skill("defence"),
            hitpoints: skill("hitpoints"),
            ranged: skill("ranged"),
            magic: skill("magic"),
            prayer: skill("prayer"),
            slayer: skill("slayer"),
          };
          summary.top_bosses = Object.entries(parsed.bosses)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([boss, kc]) => ({ boss, kc }));
          summary.clues_completed = parsed.activities["Clue Scrolls (all)"] ?? 0;
          summary.collections_logged = parsed.activities["Collections Logged"] ?? 0;
        } else {
          problems.push(
            hiscores.status === "rejected"
              ? `hiscores unavailable (${describe(hiscores.reason)})`
              : "no hiscores entry found for this name",
          );
        }

        if (wikisync.status === "fulfilled" && wikisync.value) {
          const quests = parseWikiSync(wikisync.value, player);
          summary.synced_at = quests.synced_at;
          summary.quests = {
            completed: quests.quest_counts.completed,
            in_progress: quests.quest_counts.in_progress,
            not_started: quests.quest_counts.not_started,
            notable_in_progress: quests.quests.in_progress.slice(0, 10),
          };
          summary.diaries = {
            completed_tiers: quests.diary_counts.completed_tiers,
            total_tiers: quests.diary_counts.total_tiers,
            by_region: Object.fromEntries(
              Object.entries(quests.diaries).map(([region, tiers]) => [
                region,
                Object.fromEntries(Object.entries(tiers).map(([t, v]) => [t, v.progress])),
              ]),
            ),
          };
          summary.combat_achievements = quests.combat_achievements;
        } else {
          problems.push(
            wikisync.status === "rejected"
              ? `WikiSync unavailable (${describe(wikisync.reason)})`
              : `no WikiSync data — ${WIKISYNC_HELP}`,
          );
        }

        if (wom.status === "fulfilled" && wom.value) {
          summary.account_type = wom.value.type ?? null;
          summary.ehp = wom.value.ehp ?? null;
          summary.ehb = wom.value.ehb ?? null;
        }

        if (problems.length > 0) summary.partial_results = problems;

        return text(JSON.stringify(summary, null, 2));
      },
    );

    this.server.tool(
      "get_bank",
      "Search the player's actual bank contents from the last RuneLite sync. ALWAYS use this to " +
        "check whether the user owns an item, has materials for a recipe, or how many of " +
        "something they have. Data may be minutes/hours old — report the snapshot age.",
      {
        search: z
          .string()
          .min(1)
          .max(MAX_ITEM_LENGTH)
          .optional()
          .describe(
            "Case-insensitive substring of an item name, e.g. 'topaz' or 'rune bar'. " +
              "Strongly preferred — without it only a summary of the bank is returned.",
          ),
        username,
      },
      async ({ search, username: name }) => {
        const player = this.resolvePlayer(name);
        if (!player) return noPlayer;

        try {
          const snapshot = await readContainer(this.env.WIKI_CACHE, player, "bank");
          if (!snapshot) return text(`No bank snapshot for "${player}". ${ITEM_SYNC_HELP}`);

          const age = describeAge(snapshot.received_at, Date.now());

          if (search) {
            const matches = searchItems(snapshot.items, search);
            return text(
              JSON.stringify(
                {
                  username: player,
                  container: "bank",
                  snapshot_age: age,
                  synced_at: snapshot.received_at,
                  search,
                  match_count: matches.length,
                  matches,
                  ...(matches.length === 0
                    ? { note: `No bank item name contains "${search}".` }
                    : {}),
                },
                null,
                2,
              ),
            );
          }

          // No search term: a full dump would be thousands of lines, so return
          // a summary and push the caller towards a filtered call.
          return text(
            JSON.stringify(
              {
                username: player,
                container: "bank",
                snapshot_age: age,
                synced_at: snapshot.received_at,
                distinct_items: snapshot.items.length,
                total_quantity: totalQuantity(snapshot.items),
                note:
                  `Showing only the ${BANK_SUMMARY_LIMIT} largest stacks of ` +
                  `${snapshot.items.length} distinct items. Call get_bank again with a search ` +
                  `term to look up a specific item, or check_materials for several at once.`,
                largest_stacks: topByQuantity(snapshot.items, BANK_SUMMARY_LIMIT),
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return text(`Could not read the bank snapshot for "${player}": ${describe(error)}`);
        }
      },
    );

    this.server.tool(
      "get_equipment",
      "Get the player's currently equipped gear and inventory from the last RuneLite sync. Use " +
        "for loadout checks and 'what am I wearing' questions.",
      { username },
      async ({ username: name }) => {
        const player = this.resolvePlayer(name);
        if (!player) return noPlayer;

        try {
          const [equipment, inventory] = await Promise.all([
            readContainer(this.env.WIKI_CACHE, player, "equipment"),
            readContainer(this.env.WIKI_CACHE, player, "inventory"),
          ]);

          if (!equipment && !inventory) {
            return text(`No equipment or inventory snapshot for "${player}". ${ITEM_SYNC_HELP}`);
          }

          const now = Date.now();
          const worn: Record<string, { name: string; id: number; quantity: number }> = {};
          for (const item of equipment?.items ?? []) {
            worn[item.slot ?? "unknown"] = {
              name: item.name,
              id: item.id,
              quantity: item.quantity,
            };
          }

          return text(
            JSON.stringify(
              {
                username: player,
                equipment: equipment
                  ? {
                      snapshot_age: describeAge(equipment.received_at, now),
                      synced_at: equipment.received_at,
                      slots_filled: Object.keys(worn).length,
                      worn,
                    }
                  : { note: "No equipment snapshot has been received." },
                inventory: inventory
                  ? {
                      snapshot_age: describeAge(inventory.received_at, now),
                      synced_at: inventory.received_at,
                      slots_used: inventory.items.length,
                      items: inventory.items,
                    }
                  : { note: "No inventory snapshot has been received." },
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return text(`Could not read the item snapshot for "${player}": ${describe(error)}`);
        }
      },
    );

    this.server.tool(
      "check_materials",
      "Check how many of each named item the player owns across bank, inventory and equipment. " +
        "Use together with get_infobox Recipe data to verify the user can make an item BEFORE " +
        "advising a furnace/crafting trip.",
      {
        items: z
          .array(z.string().min(1).max(MAX_ITEM_LENGTH))
          .min(1)
          .max(MAX_MATERIALS_PER_CALL)
          .describe(
            "Exact item names to look for, e.g. ['Red topaz', 'Silver bar']. Use the mat1/mat2 " +
              "values from a get_infobox Recipe template.",
          ),
        username,
      },
      async ({ items, username: name }) => {
        const player = this.resolvePlayer(name);
        if (!player) return noPlayer;

        try {
          const [containers, index] = await Promise.all([
            readAllContainers(this.env.WIKI_CACHE, player),
            readSyncIndex(this.env.WIKI_CACHE, player),
          ]);

          const present = CONTAINERS.filter((c) => containers[c] !== undefined);
          if (present.length === 0) {
            return text(`No item snapshot for "${player}". ${ITEM_SYNC_HELP}`);
          }

          const now = Date.now();
          const results = checkMaterials(containers, items);

          return text(
            JSON.stringify(
              {
                username: player,
                searched_containers: present,
                snapshot_ages: Object.fromEntries(
                  present.map((c) => [
                    c,
                    index?.containers[c]
                      ? describeAge(index.containers[c]!.received_at, now)
                      : "unknown age",
                  ]),
                ),
                have_all: results.every((result) => result.have),
                missing: results.filter((result) => !result.have).map((result) => result.item),
                results,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          return text(`Could not read the item snapshot for "${player}": ${describe(error)}`);
        }
      },
    );
  }
}

/** Error text safe to hand back to the model — never a stack trace. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const mcpHandler = OsrsWikiMCP.serve("/mcp");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cheap counters held at the edge — no KV writes, so the daily write budget
    // stays available for the cache itself.
    if (env.MCP_RATE_LIMITER) {
      const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.MCP_RATE_LIMITER.limit({ key: client });
      if (!success) {
        return new Response("Rate limit exceeded. Try again shortly.", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
    }

    // The item-sync endpoint carries its own bearer secret, so it sits outside
    // the MCP secret path rather than behind it.
    if (url.pathname === INGEST_PATH) {
      return handleIngest(request, { kv: env.WIKI_CACHE, token: env.SYNC_TOKEN });
    }

    const secret = env.MCP_SECRET_PATH?.trim();
    if (secret) {
      // Serve only at /mcp/<secret>. Anything else looks like an empty host.
      if (!secureEquals(url.pathname, `/mcp/${secret}`)) {
        return new Response("Not found", { status: 404 });
      }
      const rewritten = new URL(url);
      rewritten.pathname = "/mcp";
      return mcpHandler.fetch(new Request(rewritten, request), env, ctx);
    }

    return mcpHandler.fetch(request, env, ctx);
  },
};
