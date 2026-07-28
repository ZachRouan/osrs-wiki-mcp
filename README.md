# OSRS Wiki MCP Server

A remote [MCP](https://modelcontextprotocol.io) server that exposes the
[Old School RuneScape Wiki](https://oldschool.runescape.wiki) as tools. Runs on Cloudflare Workers,
connects to claude.ai as a custom connector.

The point is to stop answering item questions from memory. "What do I need to make a burning
amulet?" gets answered from the live wiki — topaz amulet, cosmic rune, 5 fire runes, 49 Magic —
instead of a confident guess.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `search_pages` | `query` | Top 5 titles with plain-text snippets |
| `get_page` | `title`, `section?` | Cleaned page text, capped at 12,000 chars |
| `get_infobox` | `title` | Infobox + recipe templates as JSON |
| `ge_price` | `item` | Latest GE high/low price with timestamps |

`get_infobox` is the one that matters:

```jsonc
{
  "title": "Topaz amulet (u)",
  "template": "Infobox Item",
  "fields": { "id": "21105", "value": "1275", ... },
  "templates": [
    { "template": "Infobox Item", "fields": { ... } },
    { "template": "Recipe", "fields": {
        "skill1": "Crafting", "skill1lvl": "45",
        "mat1": "Red topaz", "mat2": "Silver bar"
    } }
  ]
}
```

## Deploy

Needs **Node 22+** (`.nvmrc` included) and a Cloudflare account. Free tier is fine.

```bash
nvm use && npm install
npx wrangler kv namespace create WIKI_CACHE   # paste the id into wrangler.toml
npx wrangler deploy
```

Wrangler prints your URL. The MCP endpoint is that URL **plus `/mcp`**.

## Connect to claude.ai

**Settings → Connectors → Add custom connector**, then paste the URL with the path appended:

```
https://osrs-wiki-mcp.<your-subdomain>.workers.dev/mcp
```

Save, then enable it in a chat or Project. Transport is Streamable HTTP, which is what custom
connectors require. There's no auth — it's a read-only proxy over public data — so treat the URL
as the only thing keeping it to yourself.

## Local development

```bash
npm run dev        # http://localhost:8787
npm test           # 23 parser tests
npm run typecheck
```

Point the inspector at it — choose Streamable HTTP, connect to `http://localhost:8787/mcp`:

```bash
npx @modelcontextprotocol/inspector
```

Or drive it from the CLI:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --method tools/call \
  --tool-name get_infobox --tool-arg title="Burning amulet"

npx wrangler kv key list --binding WIKI_CACHE --local   # see what's cached
```

`wrangler dev` is local-only. Deploying runs it on Cloudflare's edge instead — your machine can be
off.

---

## How it works

```
claude.ai ──Streamable HTTP──▶ Worker (McpAgent) ──▶ KV cache ──▶ oldschool.runescape.wiki
                                                                  prices.runescape.wiki
```

- `src/index.ts` — the `McpAgent` and four tool definitions
- `src/wiki.ts` — cached fetching, item-name resolution
- `src/infobox.ts` — the template parser
- `src/wikitext.ts` — nesting-aware scanners, markup cleanup, section extraction

Cache keys are the upstream URL with query params sorted, so ordering never splits the cache.
Wiki and price responses live 1 hour; the item id mapping, 24 hours.

### Gotchas

**Every upstream request sends `User-Agent: osrs-mcp/1.0 (personal project)`.** The wiki blocks
anonymous user agents. Don't remove it.

**Node 22+ is required.** Wrangler 4.100+ dropped Node 20, and older Wrangler ships a `workerd`
that the Agents SDK can't run on — it fails with `tracing.startActiveSpan is not a function`.
Wrangler is pinned to 4.104.0 because 4.108+ wants `@cloudflare/workers-types@^5` while
partyserver (via `agents`) requires `^4`.

**Free tier limits:** Durable Objects are free only in their SQLite-backed form, which is what
`wrangler.toml` configures. KV allows 1,000 writes/day — one per cache miss, so ~1,000 distinct
uncached queries daily.

### Parsing notes

Materials and skill levels live in `{{Recipe}}`, **not** the infobox, which is why `get_infobox`
matches recipe templates too. Without that, "what does this cost to make?" has no structured
answer.

Wikitext can't be parsed with regexes alone, so the scanners track nesting depth:

- `|` only splits at depth zero, so `{{Coins|1|2}}` and `[[a|b]]` inside a value survive
- same for `=`, so `{{RuneReq|Nature=4}}` isn't mistaken for a key/value pair
- `[[link|text]]` → `text`, `[[File:X.png]]` → `X.png`
- comments, `<ref>` tags and citation templates are stripped; templates *inside* values are kept,
  since they carry real information

Version-switched pages return a `versions` array with shared params kept top-level. Grouping only
triggers when `version1`, `version2`, … actually exist — a `{{Recipe}}` with `mat1`/`mat2` is a
list, not a version switch.

### Tests

The parser was written test-first against real wikitext committed under `test/fixtures/`. The
fixtures pin down what breaks naive parsers: recipe materials (`topaz-amulet-u`), a second infobox
on the page (`steel-ring`, `dragon-boots`), version switching (`ensouled-dragon-head`,
`burning-amulet`), and nested templates inside values (`master-reanimation`).

To refresh one:

```bash
curl -s -G 'https://oldschool.runescape.wiki/api.php' \
  -H 'User-Agent: osrs-mcp/1.0 (personal project)' \
  --data-urlencode 'action=query' --data-urlencode 'prop=revisions' \
  --data-urlencode 'rvprop=content' --data-urlencode 'rvslots=main' \
  --data-urlencode 'formatversion=2' --data-urlencode 'format=json' \
  --data-urlencode 'titles=Dragon boots'
```
