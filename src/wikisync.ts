/**
 * Mapper for the WikiSync API (`sync.runescape.wiki`), which serves data
 * uploaded by the RuneLite WikiSync plugin.
 *
 * The service is undocumented, so the shapes here were derived from a real
 * response and are asserted against a committed fixture.
 */

/** Quest states as encoded by the plugin. */
const NOT_STARTED = 0;
const IN_PROGRESS = 1;
const FINISHED = 2;

export interface DiaryTier {
  complete: boolean;
  completed_tasks: number;
  total_tasks: number;
  /** Human-readable "7/12", which is what the spec asks the tool to surface. */
  progress: string;
}

export interface QuestProgress {
  username: string;
  synced_at: string;
  quests: {
    completed: string[];
    in_progress: string[];
    not_started: string[];
  };
  quest_counts: { completed: number; in_progress: number; not_started: number; total: number };
  diaries: Record<string, Record<string, DiaryTier>>;
  diary_counts: { completed_tiers: number; total_tiers: number };
  levels: Record<string, number>;
  combat_achievements: number;
}

interface RawDiaryTier {
  complete?: boolean;
  tasks?: boolean[];
}

export interface RawWikiSync {
  username?: string;
  timestamp?: string;
  quests?: Record<string, number>;
  achievement_diaries?: Record<string, Record<string, RawDiaryTier>>;
  levels?: Record<string, number>;
  combat_achievements?: number[];
}

/**
 * The payload contains a `"."` key with no quest behind it — an artefact of the
 * plugin's export rather than a real quest.
 */
function isRealQuest(name: string): boolean {
  return name.trim() !== "" && name !== ".";
}

export function parseWikiSync(raw: RawWikiSync, fallbackName = ""): QuestProgress {
  const completed: string[] = [];
  const inProgress: string[] = [];
  const notStarted: string[] = [];

  for (const [name, state] of Object.entries(raw.quests ?? {})) {
    if (!isRealQuest(name)) continue;
    if (state === FINISHED) completed.push(name);
    else if (state === IN_PROGRESS) inProgress.push(name);
    else if (state === NOT_STARTED) notStarted.push(name);
  }

  for (const list of [completed, inProgress, notStarted]) list.sort();

  const diaries: Record<string, Record<string, DiaryTier>> = {};
  let completedTiers = 0;
  let totalTiers = 0;

  for (const [region, tiers] of Object.entries(raw.achievement_diaries ?? {})) {
    const mapped: Record<string, DiaryTier> = {};

    for (const [tier, data] of Object.entries(tiers ?? {})) {
      const tasks = data?.tasks ?? [];
      const done = tasks.filter(Boolean).length;
      const complete = data?.complete === true;

      mapped[tier.toLowerCase()] = {
        complete,
        completed_tasks: done,
        total_tasks: tasks.length,
        progress: `${done}/${tasks.length}`,
      };

      totalTiers++;
      if (complete) completedTiers++;
    }

    // Present tiers in difficulty order rather than the API's alphabetical one.
    diaries[region] = orderTiers(mapped);
  }

  return {
    username: raw.username ?? fallbackName,
    synced_at: raw.timestamp ?? "unknown",
    quests: { completed, in_progress: inProgress, not_started: notStarted },
    quest_counts: {
      completed: completed.length,
      in_progress: inProgress.length,
      not_started: notStarted.length,
      total: completed.length + inProgress.length + notStarted.length,
    },
    diaries,
    diary_counts: { completed_tiers: completedTiers, total_tiers: totalTiers },
    levels: raw.levels ?? {},
    combat_achievements: (raw.combat_achievements ?? []).length,
  };
}

const TIER_ORDER = ["easy", "medium", "hard", "elite"];

function orderTiers(tiers: Record<string, DiaryTier>): Record<string, DiaryTier> {
  const ordered: Record<string, DiaryTier> = {};
  for (const tier of TIER_ORDER) {
    if (tiers[tier]) ordered[tier] = tiers[tier];
  }
  // Preserve anything unexpected rather than dropping it.
  for (const [tier, value] of Object.entries(tiers)) {
    if (!(tier in ordered)) ordered[tier] = value;
  }
  return ordered;
}
