/**
 * Mapper for the official hiscores `index_lite.json` response.
 *
 * Keyed by the names the API returns rather than by row position: the CSV
 * variant's column order shifts whenever Jagex adds a skill (Sailing being the
 * most recent), and silently mis-attributing XP is worse than failing.
 */

export interface SkillEntry {
  level: number;
  xp: number;
  rank: number;
}

export interface HiscoresResult {
  name: string;
  /** Skill name, lowercased, e.g. `attack`. Always includes `overall`. */
  skills: Record<string, SkillEntry>;
  /** Boss killcounts only. */
  bosses: Record<string, number>;
  /**
   * Clue scrolls, minigames and ranked scoreboards. Kept apart from bosses
   * because several are ratings rather than counts — "PvP Arena - Rank 2289"
   * means rank 2289, not 2289 kills.
   */
  activities: Record<string, number>;
}

interface RawSkill {
  id?: number;
  name?: string;
  rank?: number;
  level?: number;
  xp?: number;
}

interface RawActivity {
  id?: number;
  name?: string;
  rank?: number;
  score?: number;
}

export interface RawHiscores {
  name?: string;
  skills?: RawSkill[];
  activities?: RawActivity[];
}

/** The API uses -1 for "not ranked", which is noise rather than data. */
function isRanked(value: number | undefined): value is number {
  return typeof value === "number" && value >= 0;
}

/**
 * Entries on the activities list that are not bosses. Matched by name rather
 * than by index: the hiscores order shifts whenever an activity is added, and
 * mislabelling a rank as a killcount produces confidently wrong advice.
 */
const NON_BOSS_ACTIVITIES = new Set([
  "Soul Wars Zeal",
  "Rifts closed",
  "Colosseum Glory",
  "Collections Logged",
]);

function isBoss(name: string): boolean {
  if (NON_BOSS_ACTIVITIES.has(name)) return false;
  if (name.startsWith("Clue Scrolls")) return false;
  if (name.startsWith("Bounty Hunter")) return false;
  if (name.endsWith("- Rank")) return false;
  if (name.endsWith("Points")) return false;
  return true;
}

export function parseHiscores(raw: RawHiscores, fallbackName = ""): HiscoresResult {
  const skills: Record<string, SkillEntry> = {};

  for (const skill of raw.skills ?? []) {
    if (!skill.name) continue;
    // Overall is always meaningful; individual skills below rank are omitted.
    if (!isRanked(skill.level)) continue;

    skills[skill.name.toLowerCase()] = {
      level: skill.level,
      xp: isRanked(skill.xp) ? skill.xp : 0,
      rank: isRanked(skill.rank) ? skill.rank : -1,
    };
  }

  const bosses: Record<string, number> = {};
  const activities: Record<string, number> = {};

  for (const activity of raw.activities ?? []) {
    if (!activity.name) continue;
    if (!isRanked(activity.score) || activity.score === 0) continue;

    if (isBoss(activity.name)) bosses[activity.name] = activity.score;
    else activities[activity.name] = activity.score;
  }

  return { name: raw.name ?? fallbackName, skills, bosses, activities };
}

/** Combat level, for the account summary. Uses the standard OSRS formula. */
export function combatLevel(skills: Record<string, SkillEntry>): number {
  const at = (name: string) => skills[name]?.level ?? 1;

  const base = (at("defence") + at("hitpoints") + Math.floor(at("prayer") / 2)) / 4;
  const melee = (13 / 40) * (at("attack") + at("strength"));
  const ranged = (13 / 40) * Math.floor(at("ranged") * 1.5);
  const magic = (13 / 40) * Math.floor(at("magic") * 1.5);

  return Math.floor(base + Math.max(melee, ranged, magic));
}
