/**
 * Pure quest logic for journals pushed by the RuneLite sync plugin.
 *
 * No KV and no fetch in here, so all of it runs under plain Node. Storage lives
 * in `quest-store.ts`. Parsing sits on this side rather than in the plugin on
 * purpose: the markup the game uses for a completed step is the least certain
 * part of this feature, and getting it wrong should cost a deploy rather than a
 * plugin rebuild and a client restart.
 *
 * This module imports from `items.ts` and is never imported back by it. A value
 * cycle between the two throws at module-init whenever this file is the entry
 * module, which is what its own test file does.
 */

import { describeAge, MAX_JOURNAL_LINE_CHARS, MAX_JOURNAL_LINES } from "./items";
// `QuestSnapshot` is a type-only import: `quest-store.ts` imports values from
// this module, so a value import back here would create a runtime cycle.
// `import type` is erased at compile time and carries no runtime dependency.
import type { QuestSnapshot } from "./quest-store";

export interface JournalLine {
  text: string;
  /** The step is struck through, which is how the journal marks it complete. */
  done: boolean;
}

/**
 * A completed step is struck through. The tag can open mid-line on a wrapped
 * step, so its presence anywhere marks the line rather than requiring it to
 * wrap the whole thing.
 */
const STRUCK = /<str>/i;

/**
 * Every markup tag. Captured journals use only `<str>`, `<col=rrggbb>` and
 * `</col>`, but anything angle-bracketed goes.
 *
 * Removed outright rather than replaced with a space: the journal recolours
 * proper nouns mid-sentence, so a space would turn "Dark Squall." into
 * "Dark Squall .". Across every captured line, no tag sits between two word
 * characters, so removal cannot glue two words together.
 */
const MARKUP = /<[^>]*>/g;

export function parseJournalLines(raw: string[]): JournalLine[] {
  const lines: JournalLine[] = [];

  for (const line of raw) {
    if (lines.length >= MAX_JOURNAL_LINES) break;
    if (typeof line !== "string") continue;

    const done = STRUCK.test(line);
    const text = line.replace(MARKUP, "").replace(/\s+/g, " ").trim();
    if (text === "") continue;

    lines.push({ text: text.slice(0, MAX_JOURNAL_LINE_CHARS), done });
  }

  return lines;
}

/**
 * Key and comparison form for a quest name. Punctuation differs between the
 * journal title, WikiSync and whatever a model types, so none of it is kept.
 */
export function questSlug(quest: string): string {
  return quest
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface QuestMatch {
  /** The single quest this resolves to, or null when it does not resolve. */
  matched: string | null;
  /** Populated only when several quests matched, so the caller can say which. */
  candidates: string[];
}

/**
 * Resolve a quest name leniently, because a model should not have to reproduce
 * the wiki's exact punctuation. Exact wins over substring: "Desert Treasure I"
 * is itself a substring of the sequel, so a substring-first rule would resolve
 * the exact name to the wrong quest. Several matches report the ambiguity
 * rather than picking one.
 */
export function matchQuest(query: string, names: string[]): QuestMatch {
  const wanted = questSlug(query);
  if (wanted === "") return { matched: null, candidates: [] };

  const exact = names.find((name) => questSlug(name) === wanted);
  if (exact) return { matched: exact, candidates: [] };

  const partial = names.filter((name) => questSlug(name).includes(wanted));
  if (partial.length === 1) return { matched: partial[0], candidates: [] };
  return { matched: null, candidates: partial };
}

export interface JournalReport {
  captured_at: string;
  age: string;
  captured_at_progress_var: number | null;
  /** True when known-stale, false when known-current, null when undecidable. */
  stale: boolean | null;
  stale_note?: string;
  lines: JournalLine[];
}

export interface QuestReport {
  quest: string | null;
  state: string | null;
  progress_var: number | null;
  journal: JournalReport | null;
  candidates: string[];
  note?: string;
}

const REOPEN =
  "Ask the player to open this quest in their in-game quest journal, which " +
  "re-syncs the current text within a few seconds.";

/**
 * Join a stored journal to the live quest state.
 *
 * Staleness is reported, never guessed. The progress var is the only signal
 * that catches movement within a quest; without one the report says the age and
 * stops, rather than implying the text is current.
 */
export function questReport(
  query: string,
  snapshot: QuestSnapshot | null,
  state: string | null,
  nowMs: number,
): QuestReport {
  const known = new Set<string>();
  for (const entry of snapshot?.in_progress ?? []) known.add(entry.quest);
  for (const journal of Object.values(snapshot?.journals ?? {})) known.add(journal.quest);

  const match = matchQuest(query, [...known]);
  if (!match.matched) {
    return {
      quest: null,
      state: null,
      progress_var: null,
      journal: null,
      candidates: match.candidates,
      note:
        match.candidates.length > 0
          ? "Several quests match that name. Ask for one of the candidates by its full name."
          : `No journal or progress is stored for "${query}". ${REOPEN}`,
    };
  }

  const live = (snapshot?.in_progress ?? []).find((entry) => entry.quest === match.matched);
  const stored = snapshot?.journals?.[questSlug(match.matched)] ?? null;
  const progressVar = live?.progress_var ?? null;

  if (!stored) {
    return {
      quest: match.matched,
      state,
      progress_var: progressVar,
      journal: null,
      candidates: [],
      note: `No journal has been captured for this quest. ${REOPEN}`,
    };
  }

  const capturedVar = stored.progress_var;
  let stale: boolean | null;
  let note: string | undefined;

  if (state === "completed") {
    stale = true;
    note = `This quest is complete, so the journal below is from before it was finished. ${REOPEN}`;
  } else if (capturedVar === null || progressVar === null) {
    // No var for this quest, so movement within it is invisible here.
    stale = null;
    note =
      "This quest has no progress number, so whether the journal is current " +
      `cannot be checked — only its age is known. ${REOPEN}`;
  } else if (capturedVar !== progressVar) {
    stale = true;
    note = `The player has progressed since this journal was captured. ${REOPEN}`;
  } else {
    stale = false;
  }

  return {
    quest: match.matched,
    state,
    progress_var: progressVar,
    candidates: [],
    journal: {
      captured_at: stored.captured_at,
      age: describeAge(stored.captured_at, nowMs),
      captured_at_progress_var: capturedVar,
      stale,
      ...(note ? { stale_note: note } : {}),
      lines: stored.lines,
    },
  };
}
