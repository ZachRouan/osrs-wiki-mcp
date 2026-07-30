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
 * and rare, so they cannot storm the write budget.
 *
 * A journal capture is not deduped either: `captured_at` must mean "the last
 * time we saw this text and it was current", not "the last time it changed".
 * For the six quests with no progress var, age is the only staleness signal
 * the tool has, so a journal reconfirmed a moment ago must not report as days
 * old just because its text happened not to move. Vars-only pushes still
 * dedupe, because they ride every bank and equipment sync and would otherwise
 * write on every one of them.
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

  if (journal === undefined) {
    // Vars-only push: dedupe, since this rides every container sync.
    if (existing && JSON.stringify(existing.in_progress) === JSON.stringify(inProgress)) {
      return "unchanged";
    }

    const snapshot: QuestSnapshot = {
      username: payload.username,
      updated_at: capturedAt,
      in_progress: inProgress ?? [],
      journals: existing?.journals ?? {},
    };
    await kv.put(journalKey(payload.username), JSON.stringify(snapshot));
    return "stored";
  }

  // A journal capture: always write, refreshing captured_at.
  const snapshot: QuestSnapshot = {
    username: payload.username,
    updated_at: capturedAt,
    in_progress: inProgress ?? existing?.in_progress ?? [],
    journals: { ...(existing?.journals ?? {}) },
  };

  snapshot.journals[questSlug(journal.quest)] = {
    quest: journal.quest,
    captured_at: capturedAt,
    client_timestamp: payload.timestamp ?? null,
    progress_var: journal.progress_var ?? null,
    lines: parseJournalLines(journal.lines),
  };

  evictOldest(snapshot.journals);

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
