# Quest journal sync — design

**Date:** 2026-07-29
**Status:** approved, not yet implemented

## What this delivers

`get_quest_progress` can answer "where am I in this quest?" in the journal's own
words — "I should report back to Idria." — for any quest whose journal page the
player has opened in-game, and can tell when that text has been overtaken by
later progress instead of quoting it confidently.

Two pieces make that work: the journal text itself, and a per-quest progress
number that acts as a fingerprint for detecting a stale journal.

## Background

`get_quest_progress` today reads WikiSync and buckets every quest into
not-started / in-progress / complete. That is all WikiSync can support, and the
reason is worth recording because it rules out the cheapest-looking option.

### WikiSync cannot carry the granular number

The received payload maps quest name to a single integer. Across the committed
fixture of a real account, 211 quests carry only three distinct values: `0`
(25 quests), `1` (5), `2` (181). The WikiSync plugin buckets the value before
upload, so the granular number never reaches any server consuming its API.
There is nothing on the wire to expose.

### The granular number exists, and is reachable from a plugin

`net.runelite.api.Quest` holds 210 constants. Its `getState(Client)` runs client
script `4029` with the quest id and collapses the result: `1` →
`NOT_STARTED`, `2` → `FINISHED`, anything else → `IN_PROGRESS`. So the client's
own generic accessor is tri-state by construction.

The granular value lives in a varbit or varplayer per quest, and the mapping
from quest to var is not exposed by the API. `VarPlayerID` contains 108
quest-named constants out of 2,918, under cache names such as `COGQUEST`,
`RJQUEST` and `WATERFALL_QUEST` that cannot be joined to quest display names,
and many quests use varbits instead. Quest Helper solves this with two
hardcoded tables:

| Table | Entries | Form |
| --- | --- | --- |
| `QuestVarbits` | 186 | `QUEST_WHILE_GUTHIX_SLEEPS(VarbitID.WGS)` |
| `QuestVarPlayer` | 80 | `QUEST_COOKS_ASSISTANT(29)` |

All 186 `VarbitID` names those tables reference exist among the 13,152
constants in the `runelite-api` 1.12.33 jar this plugin already compiles
against, so reading the value needs no new dependency:
`client.getVarbitValue(VarbitID.WGS)` returns e.g. `24`.

Quest Helper is BSD 2-Clause (Copyright (c) 2020, Zoinkwiz), the same licence as
this plugin, so porting the tables with attribution is clean.

### What the number does not give us

Translating `24` into "you have just planted the trollweiss" needs Quest
Helper's per-quest step map — one Java class per quest, roughly 200 of them,
each returning `Map<Integer, QuestStep>`. That is not portable and would rot on
every game update. **Porting step maps is out of scope.** The number earns its
place as a fingerprint, not as a description: a model that wants the meaning for
one quest being actively played can read that quest's step definitions from
Quest Helper's public source.

## Scope

In scope:

- Plugin reads the quest journal widget when the player opens a quest's page.
- Plugin reports the progress var for quests currently in progress.
- Worker stores journals per player and parses the game's markup.
- `get_quest_progress` gains an optional `quest` parameter.

Out of scope:

- Porting Quest Helper's per-quest step maps (see above).
- Achievement diary journal pages (`Journalscroll`, group 741). WikiSync already
  reports diary tier progress, which is what the existing tool surfaces.
- The quest list widget (`Questlist`, group 399). Its colours encode the same
  three buckets WikiSync already provides.

## Architecture

```
player opens a quest journal page
  → WidgetLoaded(119) → read TITLE + QJ lines (raw markup kept)
  → mark journal dirty → existing 3s debounce
  → POST to the already-configured endpoint
      quest_journal:       { quest, progress_var, lines[] }
      quests_in_progress:  [ { quest, progress_var } ]   ← on every sync
  → Worker parses markup, stores under journal:<user>
  → get_quest_progress(quest) joins journal + WikiSync bucket + live var
```

The journal rides the existing debounce and the endpoint the plugin is already
configured with, so this needs no configuration change from the user.

Progress vars are sent on *every* sync, not only on journal opens. That is what
makes staleness detectable: the journal records the var as it was at capture
time, and a later sync carries the current one.

## Plugin changes

Repository: `runelite-item-sync`.

### `QuestVars` (new)

An `EnumMap<Quest, Integer>` from quest to the var holding its progress, plus a
parallel record of whether each entry is a varbit or a varplayer, since they are
read by different accessors (`getVarbitValue` vs `getVarpValue`). Header credits
Quest Helper under BSD-2.

Building the table is a name join against Quest Helper's two enums. Figures
below are derived by name matching and are to be confirmed by the tests
described later:

| | Count |
| --- | --- |
| Quest Helper entries joining a `Quest` constant by exact name | 186 |
| Joining after hand mapping | 18 |
| **Quests covered, of 210** | **204** |
| Quest Helper entries that are not quests, or are secondary state vars | 5 |
| `Quest` constants expected to end with no var | 6 |

All 18 hand-mapped cases are naming differences rather than judgement calls:
eight spelling, eight `RECIPE_FOR_DISASTER_*` subquests, and two entries that
carry no `QUEST_` prefix (`BARBARIAN_TRAINING` and `HIS_FAITHFUL_SERVANTS`,
which otherwise map normally). The eight spelling cases in full:

| Quest Helper | `Quest` constant |
| --- | --- |
| `DESERT_TREASURE` | `DESERT_TREASURE_I` |
| `DESERT_TREASURE_II` | `DESERT_TREASURE_II__THE_FALLEN_EMPIRE` |
| `ENCHANTED_KEY` | `THE_ENCHANTED_KEY` |
| `FAIRYTALE_I_GROWING_PAINS` | `FAIRYTALE_I__GROWING_PAINS` |
| `FAIRYTALE_II_CURE_A_QUEEN` | `FAIRYTALE_II__CURE_A_QUEEN` |
| `ROMEO_AND_JULIET` | `ROMEO__JULIET` |
| `THE_MAGE_ARENA` | `MAGE_ARENA_I` |
| `THE_MAGE_ARENA_II` | `MAGE_ARENA_II` |

Dropped: `QUEST_TAB` and `ARCHITECTURAL_ALLIANCE` are not quests, and
`ALFRED_GRIMHANDS_BARCRAWL_STATE_76`, `SHIELD_OF_ARRAV_STATE_146` and
`UNDERGROUND_PASS_STATE_162` are secondary vars for quests already mapped.

The quests expected to end with no var are `INTO_THE_TOMBS`,
`LEARNING_THE_ROPES`, `RECIPE_FOR_DISASTER__ANOTHER_COOKS_QUEST`,
`RECIPE_FOR_DISASTER__CULINAROMANCER`, `THE_BLOOD_MOON_RISES` and
`THE_FROZEN_DOOR`. This is not a defect to work around: those quests report no
`progress_var`, and the tool says so rather than implying a missing value means
no progress. The Frozen Door is currently one of the account's five in-progress
entries, so this path will be exercised in practice, and for it the journal text
is the only signal.

**The var is never used to derive quest state.** State always comes from
`Quest.getState()`, because Quest Helper's own comments flag that several vars
"don't hold the completion value" — they track progress without reaching a
terminal value on completion. Deriving completion from the var would silently
misreport those quests.

### Journal capture

`InterfaceID.Questjournal` is group 119 (`7798784 >> 16`). Its children include
`TITLE` (the quest name) and `QJ1`…`QJ210`, one per journal line. Those 210
packed ids are consecutive (`7798795`…`7799004`), so the read is a loop over two
constants rather than a table:

```java
for (int id = Questjournal.QJ1; id <= Questjournal.QJ210; id++)
```

Each line is taken from `Widget.getText()`, skipping null, hidden and empty
widgets, **with the game's markup left intact**. The loop bounds the line count
structurally at 210; each line is additionally truncated to 200 characters, so
the worst case is 41 KB against the ingest endpoint's 1 MiB body limit
and a malformed interface cannot inflate the payload.

Capture marks a journal-dirty flag and calls the existing `scheduleFlush`, so
one open produces one upload.

### Changes to existing methods

- `build()` gains a `quest_journal` block and a `quests_in_progress` block, and
  must no longer return `null` when the journal is the only thing that changed.
  Today it returns early on an empty `changed` set; that check has to account
  for a dirty journal.
- `payload.isEmpty()` must treat a payload carrying only a journal as non-empty.
- `shutDown()` clears the captured journal alongside the other state.

### Configuration

One new toggle in the existing "What to sync" section, `syncQuestJournal`
("Sync quest journal"), defaulting to on to match the container toggles.

## Wire format

Two optional additions to the existing payload:

```json
{
  "quest_journal": {
    "quest": "While Guthix Sleeps",
    "progress_var": 24,
    "lines": [
      "<str>I spoke to Ali the Wise.</str>",
      "I should report back to Idria."
    ]
  },
  "quests_in_progress": [
    { "quest": "While Guthix Sleeps", "progress_var": 24 },
    { "quest": "The Frozen Door" }
  ]
}
```

`progress_var` is omitted where the quest has no mapped var. Field names stay
snake_case because Gson serialises them verbatim and the Worker's zod schema
matches the wire shape directly.

## Worker changes

### `quest-journal.ts` (new)

Pure parsing, no KV or Worker globals, so it is testable under plain Node like
`items.ts`:

- Strip RuneScape markup — `<str>`, `<col=…>`, `<br>` and friends.
- Derive a per-line `done` flag from whether the line is struck through.
- Collapse whitespace and drop lines that are empty after stripping.

Parsing lives on the Worker rather than in the plugin deliberately. The exact
markup the journal uses for a completed step is the main unknown in this design,
and a wrong guess should cost a `wrangler deploy`, not a plugin rebuild and a
client restart.

### `journal-store.ts` (new)

One KV key per player, `journal:<normalised-username>`, holding a map of quest
to `{ quest, captured_at, client_timestamp, progress_var, lines }`.

One key rather than one per quest, because a capture then costs a single write
and needs no index to answer "which quests have journals". Capped at 25 quests,
evicting the oldest by `captured_at`. Reuses the container conventions:
content-hash dedupe so re-opening an unchanged journal does not rewrite, and the
same `WRITE_THROTTLE_MS` 5s throttle. Written with no TTL, like the containers,
so journals do not go dark between play sessions.

The write budget is the reason for the care: the free KV tier allows 1,000
writes per day shared with the wiki cache. Journal opens are manual and rare, so
one write per open is affordable; an index doubling that is not worth it.

### Progress vars

`quests_in_progress` is small — five entries for the current account — and
changes as the player progresses. It is stored in the existing per-player sync
index rather than a key of its own, and a change to the vars marks that index
dirty. In practice this costs no additional write: the index is already
rewritten on any sync carrying a container, because refreshing `received_at`
marks it dirty regardless. The one new case is a journal-only or vars-only sync,
which writes the index alone.

### Ingest

`ingestPayloadSchema` gains optional `quest_journal` and `quests_in_progress`.
The existing refine that requires at least one container must accept a payload
carrying only a journal or only progress vars.

## Tool surface

`get_quest_progress` gains an optional `quest` parameter, matched leniently so a
model need not reproduce a name's exact spelling: compare case-insensitively
after stripping punctuation and collapsing whitespace, take an exact match if
there is one, otherwise a unique substring match, and if several quests match
report the ambiguity with the candidates rather than picking one.

With `quest`, the response carries the WikiSync bucket, the live progress var,
and the stored journal with the var recorded at capture time:

```json
{
  "quest": "While Guthix Sleeps",
  "state": "in_progress",
  "progress_var": 24,
  "journal": {
    "captured_at": "2026-07-29T21:14:02Z",
    "age": "2 hours ago",
    "captured_at_progress_var": 18,
    "stale": true,
    "stale_note": "You have progressed since this journal was captured. Ask the player to open this quest in their quest journal for current text.",
    "lines": [
      { "text": "I spoke to Ali the Wise.", "done": true },
      { "text": "I should report back to Idria.", "done": false }
    ]
  }
}
```

Staleness is reported, never guessed at:

- Vars differ → `stale: true` with the note above.
- WikiSync says finished but the journal was captured mid-quest → same, worded
  for that case.
- No var for this quest → `stale: null`, saying only the timestamp is available.
- No journal stored → say so, and tell the model to ask the player to open the
  quest in their journal.

Without `quest`, the response is unchanged apart from a list of which quests
have journals stored, so a model can see what is available before asking.

## Unknowns to settle before writing the parser

Both are empirical and both will be resolved in the development client using the
Widget Inspector, not guessed:

1. **Timing.** Whether `WidgetLoaded(119)` fires before the text is populated.
   If it does, the read moves to `ScriptPostFired` for the journal's build
   script, or to `clientThread.invokeLater`.
2. **Completed-step markup.** Whether completed steps are marked with `<str>`,
   a colour tag, or something else. This determines the `done` flag.

A third, smaller question: whether opening a *completed* quest's journal is
worth storing. The intent is to skip it — `Quest.getState()` already reports
completion and WikiSync carries it, so storing the text spends a KV write for
nothing, and clicking through old quests is common. Recorded here as a decision
rather than an open question.

## Testing

Worker, under Vitest, following the existing suites:

- `quest-journal.ts` parsing: markup stripping, the `done` flag, whitespace
  collapse, empty-line dropping, bounds.
- `journal-store.ts` against the existing `FakeKV` harness: first store, dedupe
  on unchanged content, throttle, eviction at the 25-quest cap, and the trap
  case — a journal whose text is byte-identical but whose `progress_var` moved
  must still be stored, exactly as the rune pouch case required folding extras
  into the container hash.
- Ingest: a payload with only a journal is accepted; a payload with neither
  containers nor journal is rejected.
- Tool: fuzzy quest matching, each staleness branch, and the no-journal message.

Plugin, under JUnit:

- Every `QuestVars` entry resolves to a real `Quest` constant.
- Every `Quest` constant either has a var or appears on an explicit, documented
  exclusion list — so coverage is asserted at build time and a quest cannot be
  silently forgotten.
- Line extraction: bounds, and skipping null/hidden/empty widgets.

End-to-end, against a local `wrangler dev` with a real journal captured from the
development client, in the style of the existing pouch e2e script. The plugin's
capture path is only genuinely verified by opening a real quest journal in the
client and reading what arrives.

## Documentation and deployment

- `runelite-item-sync/README.md`: the two new payload fields, the new toggle,
  and why the var is a fingerprint rather than a state source.
- `README.md` and `osrs-wiki-mcp-plan.md`: the tool's new parameter, and updated
  test counts.
- Attribution for the ported tables in the plugin source and its README.

This changes the tool schema, and claude.ai caches tool metadata per URL. So the
last step is rotating `MCP_SECRET_PATH` and re-adding the connector, as when
`get_bank`'s `full` parameter was added. Worth batching any other schema change
into the same deploy.
