/**
 * KV storage for a player's quest journals and in-progress vars.
 *
 * One key per player holding every journal, rather than one key per quest: a
 * capture then costs a single write and needs no index to answer "which quests
 * have journals". Written with no TTL, like item snapshots, so journals do not
 * go dark between play sessions.
 */

import type { ItemKV } from "./item-store";
import { type IngestPayload, journalKey, type QuestProgressEntry } from "./items";
import { type JournalLine, parseJournalLines, questSlug } from "./quests";

/**
 * How many quests keep a stored journal. Generous for the handful anyone has
 * open at once, and small enough that the value stays a few KB.
 */
export const MAX_STORED_JOURNALS = 25;

export interface StoredJournal {
  /** The journal's own title, kept for display; the map key is its slug. */
  quest: string;
  captured_at: string;
  client_timestamp: string | null;
  /** Null for quests with no var in the plugin's table. */
  progress_var: number | null;
  lines: JournalLine[];
}

export interface QuestSnapshot {
  username: string;
  updated_at: string;
  in_progress: QuestProgressEntry[];
  /** Keyed by `questSlug`, so punctuation cannot split one quest into two. */
  journals: Record<string, StoredJournal>;
}

export type QuestOutcome = "stored" | "unchanged" | "no-op";

export async function readQuests(kv: ItemKV, username: string): Promise<QuestSnapshot | null> {
  return (await kv.get(journalKey(username), "json")) as QuestSnapshot | null;
}

/**
 * Persist whatever quest data a push carried.
 *
 * Unlike the containers there is no write throttle here. A throttled container
 * push is harmless because the next sync resends it; a journal capture is not
 * resent, so dropping it would lose the data outright. Journal opens are manual
 * and rare, so they cannot storm the write budget. Dedupe still applies.
 */
export async function storeQuests(
  kv: ItemKV,
  payload: IngestPayload,
  nowMs: number,
): Promise<QuestOutcome> {
  const journal = payload.quest_journal;
  const inProgress = payload.quests_in_progress;
  if (journal === undefined && inProgress === undefined) return "no-op";

  const capturedAt = new Date(nowMs).toISOString();
  const existing = await readQuests(kv, payload.username);

  const snapshot: QuestSnapshot = {
    username: payload.username,
    updated_at: capturedAt,
    in_progress: inProgress ?? existing?.in_progress ?? [],
    journals: { ...(existing?.journals ?? {}) },
  };

  if (journal) {
    const slug = questSlug(journal.quest);
    const candidate: StoredJournal = {
      quest: journal.quest,
      captured_at: capturedAt,
      client_timestamp: payload.timestamp ?? null,
      progress_var: journal.progress_var ?? null,
      lines: parseJournalLines(journal.lines),
    };

    // Reuse the previous entry (and its captured_at) when nothing about the
    // journal actually changed. Rebuilding it with a fresh timestamp on every
    // push would make the dedupe check below always see a diff and defeat it.
    const previousJournal = existing?.journals[slug];
    const unchanged =
      previousJournal !== undefined &&
      previousJournal.quest === candidate.quest &&
      previousJournal.progress_var === candidate.progress_var &&
      JSON.stringify(previousJournal.lines) === JSON.stringify(candidate.lines);

    snapshot.journals[slug] = unchanged ? previousJournal : candidate;
  }

  evictOldest(snapshot.journals);

  // Compare everything but `updated_at`, which changes on every push by
  // definition and would defeat the check.
  const { updated_at: _ignored, ...compared } = snapshot;
  const previous = existing ? { ...existing, updated_at: capturedAt } : null;
  if (previous) {
    const { updated_at: _also, ...previousCompared } = previous;
    if (JSON.stringify(previousCompared) === JSON.stringify(compared)) return "unchanged";
  }

  await kv.put(journalKey(payload.username), JSON.stringify(snapshot));
  return "stored";
}

/** Keep the most recently captured journals, dropping the oldest first. */
function evictOldest(journals: Record<string, StoredJournal>): void {
  const slugs = Object.keys(journals);
  if (slugs.length <= MAX_STORED_JOURNALS) return;

  slugs
    .sort((a, b) => Date.parse(journals[a].captured_at) - Date.parse(journals[b].captured_at))
    .slice(0, slugs.length - MAX_STORED_JOURNALS)
    .forEach((slug) => delete journals[slug]);
}
