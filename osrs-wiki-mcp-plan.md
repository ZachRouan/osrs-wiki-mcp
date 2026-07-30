# OSRS Wiki MCP Server — Design Notes

A remote MCP server exposing the Old School RuneScape Wiki and live player data as structured
tools for Claude (claude.ai custom connector). Goal: kill the "plausible-but-wrong item recipe"
failure mode, and stop an assistant guessing at account state it could just look up.

**Status: built and deployed.** v1 (wiki tools), v2 (player tools) and v3 (live item data) are
live on Cloudflare Workers. This doc records what was built and, more usefully, which parts of the
plan turned out to be wrong.

---

## Architecture

```
claude.ai (custom connector, Streamable HTTP)        RuneLite + Item Sync plugin
        │                                                        │
        │                                            POST /ingest/items (X-Sync-Token)
        ▼                                                        ▼
Cloudflare Worker  (TypeScript, Agents SDK McpAgent)  ◄──────────┘
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

**Items (v3)** — pushed by the [Item Sync](https://github.com/ZachRouan/runelite-item-sync) plugin,
since no public API exposes container contents

| Tool | Input | Output |
|---|---|---|
| `get_bank` | `search?`, `full?` | matching items with quantities, a summary when unfiltered, or every stack as lines when `full` |
| `get_equipment` | — | worn gear by slot, plus inventory slots and rune pouch |
| `check_materials` | `items[]` | owned quantity of each, across bank, inventory, worn gear and rune pouch |

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

**The bank vanishes if you re-read it later.** `ItemContainerChanged` hands the plugin the
container, but the first implementation kept only a dirty flag and re-read via
`client.getItemContainer()` after a 3s debounce. Closing the bank inside that window makes the
re-read return null, so the upload went out carrying only the inventory rider. Caught in live play,
not by any test: a quick open/close sent 2 stacks, holding it open sent 669. Contents are now
copied out of the event immediately.

**Exact name matching is load-bearing.** The account holds a *Topaz amulet (u)* and no strung
*Topaz amulet*. A substring match would have reported the burning amulet recipe as satisfied and
sent the player to enchant an amulet they do not own. Near-misses are surfaced separately under
`similar`, never counted.

**A whole bank was never too big — the format was.** The plan capped the unfiltered `get_bank` at
the 50 largest stacks on the assumption that a full dump was unaffordable. Measured against 500
real item names, the cost is almost entirely JSON scaffolding and item ids: objects with ids run
85.5 bytes per stack, plain `Name xQuantity` lines run 20.2. That is a 677-item bank at ~3,400
tokens instead of ~14,500, so `full` returns lines and drops the ids — every tool that consumes
these names (`ge_price`, `check_materials`, `get_infobox`) resolves by name anyway. The 12,000-char
prose limit would have cut a real bank in half, so this path carries its own 60,000-char cap and
reports what it dropped.

**Merged stacks are not slots.** `get_equipment` reported `slots_used: inventory.items.length`,
but the plugin merges stacks by canonical id, so that counts item types. A live inventory showing
24 was actually 28 of 28 full: Prayer potion(3) x2 and Cooked karambwan x4 are non-stackable and
each occupy one slot per item. The tool was inventing four free slots. Slot counts cannot be
recovered from a merged list, so the plugin now counts them on the raw slot array and sends the
container size too. Equipment was never affected — it is slot-keyed and explicitly never merged.

**A rune pouch is invisible to container reads.** The inventory reports it as one opaque item.
RuneLite's own overlay reads six `RUNE_POUCH_TYPE_n`/`RUNE_POUCH_QUANTITY_n` varbit pairs, where
the type varbit is an *index into enum `RUNEPOUCH_RUNE` (982)*, not an item id — resolving it as an
id would name the wrong rune. `net.runelite.api.Varbits` is deprecated in favour of gameval
`VarbitID`, which carries all six pairs at identical values. The varbits also persist after the
pouch is banked, so contents are sent only while a pouch is carried.

**A content hash must cover everything stored under the key.** Pouch runes drain while the
inventory item list stays byte-identical, so hashing items alone deduped that write away and served
stale runes under a fresh snapshot age — the same failure shape as the bank that vanished. The
inventory hash now folds in the slot counts and pouch contents.

**The GE mapping is tradeables-only.** Coins, Fire cape, Dragon defender and Barrows gloves have no
entry, but RuneLite reports them — anything assuming the mapping covers every item silently loses
them.

**Inventory cannot be a sync trigger.** KV's free tier allows 1,000 writes/day across the item
snapshots and the wiki cache combined. Inventory changes every few seconds, so triggering on it
exhausts the budget in about 90 minutes and takes the wiki cache down with it. It rides along with
bank and equipment syncs instead, and a content hash skips rewriting an unchanged bank while still
refreshing its age.

**The Plugin Hub will not distribute this.** Their rejected features list disallows "plugins which
expose player information over HTTP", which is the whole point of it. Reasoning from Dink — which
posts to user-configured webhooks and is merged — was wrong: it sends event notifications, not
queryable account state. The plugin-hub README names that list as a review criterion and links it;
checking it first would have saved the submission.

**The Jagex Launcher makes sideloading impossible.** `loadSideLoadPlugins()` returns immediately
unless developer mode, and `developerMode = options.has("developer-mode") && getLauncherVersion()
== null` — any official launcher sets `runelite.launcher.version`, so the flag cannot help. The
directory is also `~/.runelite/sideloaded-plugins`, not the `~/.runelite/plugins` that the Plugin
Hub uses. The documented `--insecure-write-credentials` workaround is unreachable too under a
Flatpak launcher: the launcher reads `settings.json` from its working directory, which inside the
sandbox is ephemeral tmpfs with the real home unmounted. The development client takes arguments we
control, so it passes that flag itself instead.

**A development client starts empty.** Launched bare it uses `~/.runelite` and loads none of the 40
installed Plugin Hub plugins, profiles or settings. Pointing `user.home` at the launcher's
directory fixes it, at the cost of never running two clients at once.

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
- **The one write surface.** `/ingest/items` sits outside the secret path with its own bearer
  token, fails closed when `SYNC_TOKEN` is unset, caps bodies at 1 MiB and validates against a
  schema before touching KV. A stolen token can overwrite item snapshots but cannot read them.

Note for future rotations: **claude.ai caches a connector's tool list per URL.** After v2 shipped,
Claude insisted the server had only four tools and that no account lookup existed — while the
server was demonstrably serving eight. Toggling the connector did not clear it; rotating the
secret to produce a new URL did. `search_pages` now carries an `[osrs-wiki v2]` marker so stale
metadata is obvious at a glance.

## Stack

- **TypeScript + Cloudflare Workers**, Agents SDK `McpAgent` for transport, Workers KV for
  caching, SQLite-backed Durable Objects for sessions. All within the free tier.
- **Item sync:** a RuneLite plugin in Java, in its own public repo so it could be submitted to the
  Plugin Hub. It stays there as the canonical copy even though the submission was declined.
- **Testing:** Vitest, 169 tests against committed real fixtures, plus 10 JUnit tests pinning the
  plugin's JSON against the Worker's schema. The infobox parser was written
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
- Bank value from `ge_price`, now that contents are known
- "What can I make right now?" — cross-referencing recipes against the bank rather than checking
  one item at a time
