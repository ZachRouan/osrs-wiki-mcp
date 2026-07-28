# OSRS Wiki MCP Server — Project Plan

A remote MCP server exposing the Old School RuneScape Wiki as structured tools for Claude (claude.ai custom connector). Goal: kill the "plausible-but-wrong item recipe" failure mode by making live wiki data one tool call away.

---

## Architecture

```
claude.ai (custom connector, Streamable HTTP)
        │
        ▼
Cloudflare Worker  (TypeScript + @modelcontextprotocol/sdk / Agents SDK McpAgent)
        │  ├── Workers KV cache (1hr TTL)
        ▼
┌─────────────────────────────────────────────┐
│ oldschool.runescape.wiki/api.php (MediaWiki) │
│ prices.runescape.wiki/api/v1/osrs (prices)   │
└─────────────────────────────────────────────┘
```

- **Remote server required** — claude.ai connectors need a URL-reachable endpoint speaking Streamable HTTP (stdio is Desktop-only).
- **MediaWiki API** gives full-text search (`action=query&list=search`), page content (`action=parse`, `prop=revisions&rvprop=content`), and raw wikitext containing structured infobox templates (`{{Infobox Item}}`, `{{Infobox Monster}}`, `{{Quest details}}`) — these hold the exact fields that matter: levels, materials, requirements, drop sources.
- **Prices API** — `prices.runescape.wiki/api/v1/osrs/latest` for GE prices (optional).
- **Etiquette:** the wiki requires a descriptive `User-Agent` (e.g. `osrs-mcp/1.0 (contact@example.com)`); anonymous agents get blocked. Cache aggressively — game data barely changes.

## Tools (keep it to four)

| Tool | Input | Output | Notes |
|---|---|---|---|
| `search_pages` | `query: string` | top 5 titles + snippets | `list=search` wrapper |
| `get_page` | `title: string`, `section?: string` | cleaned wikitext/extract | **cap at ~3k tokens**; big pages (e.g. "Prayer") need section param or truncation |
| `get_infobox` | `title: string` | parsed JSON of infobox fields | the killer feature — see parser notes |
| `ge_price` | `item: string` | latest high/low price | optional dessert |

### Infobox parser notes (the only real engineering)
- Parse `{{Infobox X | key = value | ... }}` wikitext into JSON (~100 lines).
- Handle: nested templates in values, `<!-- comments -->`, version-switched infoboxes (multi-variant pages like dragon boots use `|version1=`, `|smw...` params — return all versions or the first + a variant list).
- Strip wiki markup from values (`[[links|display]]` → `display`).
- Write it **test-first** against known pages: `Topaz amulet (u)` (materials: red topaz + silver bar, 45 Crafting), `Steel ring`, `Ensouled dragon head` (Master Reanimation, 90 Magic), `Burning amulet`.

## Stack

- **TypeScript + Cloudflare Workers** — first-class MCP support (Agents SDK `McpAgent` handles transport), free tier is plenty, Workers KV for caching.
  - Alternative: Python + FastMCP on Fly.io/Railway if preferred.
- **Auth:** personal read-only proxy of public data → unauthenticated endpoint at an unguessable path is pragmatic. (MCP OAuth exists if you ever want it proper.)
- **Caching:** KV, key = normalized request, TTL 3600s.

## Build order

1. Scaffold from Cloudflare's remote MCP template; verify hello-world tool in `npx @modelcontextprotocol/inspector`
2. `search_pages` + `get_page` (thin fetch wrappers + markup cleanup + token cap)
3. `get_infobox` — test-first with the fixture pages above
4. KV caching, User-Agent header, error handling (page-not-found → suggest search)
5. Deploy → claude.ai → Settings → Connectors → Add custom connector → paste URL
6. Write sharp tool descriptions: "ALWAYS use for item recipes, requirements, levels, drop sources — do not answer from memory"

## Usage pattern once live

- claude.ai Project: "My Ironman" — upload `ironman-progress.md` tracker + enable the connector
- Every item/recipe/requirement question resolves via `get_infobox` instead of model recall
- Tracker file updated in-conversation as progress happens

## Success criteria

Ask: "what do I need to make a burning amulet?" → answer comes from the live infobox (red topaz, **silver** bar, 45 Crafting, ball of wool, Lvl-3 Enchant @ 49 Magic) with zero hallucinated gold bars.
