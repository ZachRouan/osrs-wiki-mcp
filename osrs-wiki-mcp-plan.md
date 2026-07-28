# OSRS Wiki MCP Server — Design Notes

A remote MCP server exposing the Old School RuneScape Wiki and live player data as structured
tools for Claude (claude.ai custom connector). Goal: kill the "plausible-but-wrong item recipe"
failure mode, and stop an assistant guessing at account state it could just look up.

**Status: built and deployed.** v1 (wiki tools) and v2 (player tools) are live on Cloudflare
Workers. This doc records what was built and, more usefully, which parts of the original plan
turned out to be wrong.

---

## Architecture

```
claude.ai (custom connector, Streamable HTTP)
        │
        ▼
Cloudflare Worker  (TypeScript, Agents SDK McpAgent)
        │  ├── secret path gate + rate limiter (60/min per IP)
        │  ├── Workers KV cache — wiki 1h, item mapping 24h, player data 5min
        ▼
┌──────────────────────────────────────────────────────┐
│ oldschool.runescape.wiki/api.php     (MediaWiki)     │
│ prices.runescape.wiki/api/v1/osrs    (GE prices)     │
│ secure.runescape.com/m=hiscore_*     (hiscores)      │
│ sync.runescape.wiki/runelite         (WikiSync)      │
│ api.wiseoldman.net/v2                (Wise Old Man)  │
└──────────────────────────────────────────────────────┘
```

- **Remote server required** — claude.ai connectors need a URL-reachable endpoint speaking
  Streamable HTTP (stdio is Desktop-only).
- **Etiquette:** every upstream request sends `User-Agent: osrs-mcp/1.0 (personal project)`. The
  wiki blocks anonymous agents.

## Tools

**Wiki (v1)**

| Tool | Input | Output |
|---|---|---|
| `search_pages` | `query` | top 5 titles + plain-text snippets |
| `get_page` | `title`, `section?` | cleaned wikitext, capped at 12,000 chars |
| `get_infobox` | `title` | parsed infobox + recipe templates as JSON |
| `ge_price` | `item` | latest high/low price with timestamps |

**Player (v2)** — `username` optional, falls back to `DEFAULT_PLAYER`

| Tool | Source | Output |
|---|---|---|
| `get_player_stats` | Jagex hiscores | levels, XP, combat level, boss KC |
| `get_quest_progress` | WikiSync | quest states, diary progress |
| `get_gains` | Wise Old Man | XP/KC gained over day/week/month/year |
| `get_account_summary` | all three | combined snapshot, tolerates partial failure |

## What the plan got wrong

The useful part of this document. Each of these was caught by checking real data rather than
trusting the assumption.

**Materials are not in the infobox.** The original plan assumed `get_infobox` alone could answer
"what do I need to make X". It cannot — `{{Infobox Item}}` holds value, weight and id, while
materials and skill levels live in a separate `{{Recipe}}` template. `get_infobox` matches both.
Without this the headline success criterion was unreachable.

**"90 Magic" for Master Reanimation is not on the Ensouled dragon head page.** It appears only in
prose there; the structured value lives in `{{Infobox Spell|level=90}}` on the *Master
Reanimation* page. The fixture set was adjusted to assert what is actually structured, rather than
scraping prose with a regex.

**Dragon boots is not version-switched.** It was listed as the version-switching test case. It
has two infoboxes (`Item` + `Bonuses`) but no `versionN` params. Burning amulet (5 charges) and
Ensouled dragon head (2 variants) are the real version-switching fixtures.

**The hiscores JSON endpoint works**, so there is no CSV parsing and no dependence on column
order — which matters now that Sailing has shifted it. A missing account returns **HTML**, not
CSV or JSON, so status has to decide the outcome before anything is parsed.

**WikiSync answers `HTTP 400`** with `{"code":"NO_USER_DATA"}` for an unsynced player, not the
404 the plan assumed.

**Boss killcounts and activities are mixed in one hiscores list.** `PvP Arena - Rank 2289` means
rank 2289, not 2289 kills. Reporting it as a boss made an assistant invent a killcount, so the two
are now classified apart by name.

**Wise Old Man reports zero gains** when a window contains fewer than two snapshots. That reads as
"you did nothing" — an all-zero result now carries a note explaining what it actually means.

**Node 22 is required.** Wrangler 4.100+ dropped Node 20, and older Wrangler ships a `workerd`
the Agents SDK cannot run on (`tracing.startActiveSpan is not a function`). Wrangler is pinned to
4.104.0: 4.108+ wants `@cloudflare/workers-types@^5` while partyserver requires `^4`.

## Security posture

The plan called auth "optional — an unguessable path is pragmatic". That held up, with additions
after a review:

- **Secret path.** Serves only at `/mcp/<secret>` from a Worker secret; every other path 404s,
  compared length-independently.
- **Rate limiting.** 60 req/min per IP via Cloudflare's native limiter — edge-local counters, so
  it costs none of the 1,000/day KV write budget it protects.
- **Input bounds.** Titles capped at 255 bytes, usernames at 12. Over-long cache keys collapse to
  a SHA-256 digest rather than failing on KV's 512-byte limit.
- **Untrusted content.** The wiki is publicly editable, so all wiki-derived output is fenced in
  `<untrusted-wiki-content>` with a trust banner and scanned for model-directed phrasings.
  Content is never silently rewritten.

Note for future rotations: **claude.ai caches a connector's tool list per URL.** After v2 shipped,
Claude insisted the server had only four tools and that no account lookup existed — while the
server was demonstrably serving eight. Toggling the connector did not clear it; rotating the
secret to produce a new URL did. `search_pages` now carries an `[osrs-wiki v2]` marker so stale
metadata is obvious at a glance.

## Stack

- **TypeScript + Cloudflare Workers**, Agents SDK `McpAgent` for transport, Workers KV for
  caching, SQLite-backed Durable Objects for sessions. All within the free tier.
- **Testing:** Vitest, 85 tests against committed real fixtures. The infobox parser was written
  test-first. `npm run smoke` hits the live player APIs and is deliberately outside `npm test`,
  since it depends on third-party services and current account state.

## Usage pattern

- claude.ai Project: "My Ironman" — enable the connector; `DEFAULT_PLAYER` means no username is
  needed in conversation.
- Item and recipe questions resolve via `get_infobox` instead of model recall.
- Account advice starts with `get_account_summary` rather than asking the user their levels.
- The tracker file the original plan proposed is now largely redundant: quest and diary state come
  live from WikiSync.

## Success criteria — met

"What do I need to make a burning amulet?" returns, from live wiki data: topaz amulet, cosmic
rune, 5 fire runes, 49 Magic. Zero hallucinated gold bars.

The v2 equivalent: "what should I train next?" is answered from the account's real levels, quest
states and diary progress rather than from whatever the user mentioned earlier in the chat.

## Possible next steps

Not planned, just noted:

- Collection log and combat achievement detail (WikiSync returns both; only counts are surfaced)
- A `get_diary_tasks` tool naming the specific incomplete tasks per tier
- Skill calculators — "how many X to level Y" — from wiki calculator data
