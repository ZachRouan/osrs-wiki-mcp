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

import { MAX_JOURNAL_LINE_CHARS, MAX_JOURNAL_LINES } from "./items";

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
