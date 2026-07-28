import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Env } from "./env";
import { parseInfoboxes } from "./infobox";
import { wrapUntrusted } from "./untrusted";
import { getItemMapping, getLatestPrice, getWikitext, resolveItem, searchPages } from "./wiki";
import { cleanPageWikitext, extractSection, truncateWithNotice } from "./wikitext";

export type { Env };

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
  server = new McpServer({ name: "osrs-wiki", version: "1.0.0" });

  async init() {
    this.server.tool(
      "search_pages",
      "Search the Old School RuneScape Wiki and return the top 5 matching page titles with a " +
        "plain-text snippet each. Use this to find the exact page title before calling get_page " +
        "or get_infobox.",
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
  }
}

const mcpHandler = OsrsWikiMCP.serve("/mcp");

/** Length-independent comparison, so the secret can't be probed byte by byte. */
function secretPathMatches(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

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

    const secret = env.MCP_SECRET_PATH?.trim();
    if (secret) {
      // Serve only at /mcp/<secret>. Anything else looks like an empty host.
      if (!secretPathMatches(url.pathname, `/mcp/${secret}`)) {
        return new Response("Not found", { status: 404 });
      }
      const rewritten = new URL(url);
      rewritten.pathname = "/mcp";
      return mcpHandler.fetch(new Request(rewritten, request), env, ctx);
    }

    return mcpHandler.fetch(request, env, ctx);
  },
};
