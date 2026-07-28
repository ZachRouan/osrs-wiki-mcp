# OSRS Wiki MCP Server

A remote [MCP](https://modelcontextprotocol.io) server that exposes the
[Old School RuneScape Wiki](https://oldschool.runescape.wiki) as tools, deployable to Cloudflare
Workers and usable as a **claude.ai custom connector**.

The point is to stop answering item/recipe questions from memory. Ask "what do I need to make a
burning amulet?" and the answer comes from the live wiki infobox — a topaz amulet, a cosmic rune,
5 fire runes and 49 Magic — instead of a plausible-sounding hallucination.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `search_pages` | `query` | Top 5 page titles with plain-text snippets |
| `get_page` | `title`, `section?` | Cleaned page wikitext, capped at 12,000 characters |
| `get_infobox` | `title` | Parsed infobox/recipe templates as JSON |
| `ge_price` | `item` | Latest Grand Exchange high/low price with timestamps |

`get_infobox` is the important one. It parses `{{Infobox *}}`, `{{Quest details}}` and
`{{Recipe}}` templates into JSON:

```jsonc
{
  "title": "Topaz amulet (u)",
  "template": "Infobox Item",
  "fields": { "name": "Topaz amulet (u)", "id": "21105", "value": "1275", ... },
  "templates": [
    { "template": "Infobox Item", "fields": { ... } },
    { "template": "Recipe", "fields": {
        "skill1": "Crafting", "skill1lvl": "45",
        "mat1": "Red topaz", "mat2": "Silver bar"
    } }
  ]
}
```

Materials and skill requirements live in `{{Recipe}}`, **not** in the infobox — which is why
`get_infobox` matches recipe templates too. Without that, "what does this cost to make?" has no
structured answer.

Version-switched pages (items with charges, tradeable/untradeable variants) return a `versions`
array, with parameters shared across variants kept top-level:

```jsonc
{
  "template": "Infobox Item",
  "fields": { "examine": "Useful teleports around the wilderness.", "value": "1250" },
  "versions": [
    { "version": "(1)", "name": "Burning amulet(1)", "id": "21175", "exchange": "No" },
    { "version": "(5)", "name": "Burning amulet(5)", "id": "21166", "exchange": "Yes" }
  ]
}
```

Grouping only triggers when the template actually has `version1`, `version2`, … parameters.
A `{{Recipe}}` with `mat1`/`mat2`/`mat3` is a list, not a version switch, and is left flat.

## Requirements

- **Node.js 22 or newer.** Wrangler 4.100+ requires it, and older Wrangler ships a `workerd` that
  the Agents SDK cannot run on. `.nvmrc` is included — run `nvm use`.
- A Cloudflare account (the free tier is sufficient).

## Setup

```bash
nvm use          # Node 22
npm install
```

### Create the KV namespace

Responses are cached in Workers KV, keyed by the normalized upstream request URL.

```bash
npx wrangler kv namespace create WIKI_CACHE
```

That prints an id. Paste it into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

```toml
[[kv_namespaces]]
binding = "WIKI_CACHE"
id = "<the id you just got>"
```

### Deploy

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g. `https://osrs-wiki-mcp.<your-subdomain>.workers.dev`.
The MCP endpoint is that URL plus **`/mcp`**.

## Connect it to claude.ai

1. Deploy, and copy the `workers.dev` URL.
2. In claude.ai go to **Settings → Connectors → Add custom connector**.
3. Paste the URL **with the `/mcp` path appended**:
   `https://osrs-wiki-mcp.<your-subdomain>.workers.dev/mcp`
4. Save, then enable the connector in a chat or Project.

The transport is Streamable HTTP, which is what claude.ai custom connectors require. There is no
authentication — the server is a read-only proxy over public wiki data.

## Local development

```bash
npm run dev      # wrangler dev on http://localhost:8787
```

Then point the MCP Inspector at it:

```bash
npx @modelcontextprotocol/inspector
```

Choose **Streamable HTTP** transport and connect to `http://localhost:8787/mcp`.

The inspector also has a CLI mode, which is handy for scripted checks:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --method tools/list

npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp \
  --transport http --method tools/call \
  --tool-name get_infobox --tool-arg title="Burning amulet"
```

Inspect what the cache has stored:

```bash
npx wrangler kv key list --binding WIKI_CACHE --local
```

## Tests

```bash
npm test           # vitest run
npm run typecheck  # worker and test sources, separately
```

The infobox parser was written test-first against real wikitext committed under
`test/fixtures/`, fetched once from the live wiki. The fixtures cover the cases that actually
break naive parsers:

| Fixture | What it pins down |
| --- | --- |
| `topaz-amulet-u` | Materials (red topaz + silver bar) and 45 Crafting, from `{{Recipe}}` |
| `steel-ring` | A second infobox (`Infobox Bonuses`) on the same page |
| `ensouled-dragon-head` | Version switching (`id1`/`id2`), `<ref>`/citation stripping |
| `master-reanimation` | 90 Magic requirement; nested `{{RuneReq\|Nature=4}}` inside a value |
| `burning-amulet` | Five charge versions; recipe list params must not be read as versions |
| `dragon-boots` | Two infoboxes; combat stats preserved rather than dropped |

To refresh a fixture, re-fetch its wikitext (note the User-Agent — the wiki blocks anonymous
requests):

```bash
curl -s -G 'https://oldschool.runescape.wiki/api.php' \
  -H 'User-Agent: osrs-mcp/1.0 (personal project)' \
  --data-urlencode 'action=query' --data-urlencode 'prop=revisions' \
  --data-urlencode 'rvprop=content' --data-urlencode 'rvslots=main' \
  --data-urlencode 'formatversion=2' --data-urlencode 'format=json' \
  --data-urlencode 'titles=Dragon boots'
```

## How it works

```
claude.ai  ──Streamable HTTP──▶  Cloudflare Worker (McpAgent)
                                      │
                                      ├── Workers KV cache
                                      │     wiki + prices: 1h,  item mapping: 24h
                                      ▼
                     oldschool.runescape.wiki/api.php   (MediaWiki)
                     prices.runescape.wiki/api/v1/osrs  (Grand Exchange)
```

- `src/index.ts` — the `McpAgent` and the four tool definitions.
- `src/wiki.ts` — cached upstream fetching, item-name resolution.
- `src/infobox.ts` — the template parser.
- `src/wikitext.ts` — brace/bracket-aware scanners, markup cleanup, section extraction.

Every upstream request sends `User-Agent: osrs-mcp/1.0 (personal project)`. The wiki blocks
anonymous user agents, so do not remove it.

Caching is keyed on the upstream URL with its query parameters sorted, so parameter ordering
never splits the cache. Wiki and price responses are held for 1 hour; the item id mapping, which
is effectively static, for 24 hours.

### Parsing notes

Wikitext cannot be parsed with regular expressions alone, so the scanners in `src/wikitext.ts`
track nesting depth:

- A `|` only splits parameters at depth zero, so `{{Coins|1|2}}` and `[[a|b]]` inside a value stay
  intact.
- The same applies to `=`, so `{{RuneReq|Nature=4|Blood=2}}` is not mistaken for a key/value pair.
- `[[link|text]]` becomes `text`, `[[link]]` becomes `link`, and `[[File:X.png]]` becomes `X.png`
  in infobox values.
- HTML comments, `<ref>` tags and citation templates are removed.
- Templates *inside* values are deliberately preserved — `{{RuneReq|Nature=4}}` carries real
  information that stripping to plain text would destroy.

For `get_page`, references and navboxes are dropped. A parameterless template alone on its line
(`{{Amulets}}`, `{{Dragon equipment}}`) is a navbox by convention on this wiki, so those go too,
while templates carrying parameters are kept.
