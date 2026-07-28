/**
 * Mapper for Wise Old Man's `gained` endpoint.
 *
 * Every metric is reported whether or not it moved, so the mapper's main job is
 * dropping the zeros — a list of 24 skills that all gained nothing is noise.
 */

export interface SkillGain {
  skill: string;
  xp_gained: number;
  levels_gained: number;
  level_now: number;
}

export interface GainsResult {
  period: string;
  starts_at: string;
  ends_at: string;
  xp_gained: number;
  ehp_gained: number;
  ehb_gained: number;
  skills: SkillGain[];
  top_skills: SkillGain[];
  bosses: Array<{ boss: string; kills_gained: number }>;
  /** Present only when nothing moved, to explain a result of all zeroes. */
  note?: string;
}

interface RawMetricGain {
  gained?: number;
  start?: number;
  end?: number;
}

interface RawSkillGain {
  metric?: string;
  experience?: RawMetricGain;
  level?: RawMetricGain;
  ehp?: RawMetricGain;
}

interface RawBossGain {
  metric?: string;
  kills?: RawMetricGain;
}

export interface RawGains {
  startsAt?: string;
  endsAt?: string;
  data?: {
    skills?: Record<string, RawSkillGain>;
    bosses?: Record<string, RawBossGain>;
    computed?: Record<string, { value?: RawMetricGain }>;
  };
}

const TOP_SKILL_COUNT = 3;

export function parseGains(raw: RawGains, period: string): GainsResult {
  const skills: SkillGain[] = [];

  for (const [metric, entry] of Object.entries(raw.data?.skills ?? {})) {
    // `overall` is a roll-up of the others; reporting it as a skill double-counts.
    if (metric === "overall") continue;

    const gained = entry.experience?.gained ?? 0;
    if (gained <= 0) continue;

    skills.push({
      skill: metric,
      xp_gained: gained,
      levels_gained: entry.level?.gained ?? 0,
      level_now: entry.level?.end ?? 0,
    });
  }

  skills.sort((a, b) => b.xp_gained - a.xp_gained);

  const bosses: Array<{ boss: string; kills_gained: number }> = [];
  for (const [metric, entry] of Object.entries(raw.data?.bosses ?? {})) {
    const gained = entry.kills?.gained ?? 0;
    if (gained > 0) bosses.push({ boss: metric, kills_gained: gained });
  }
  bosses.sort((a, b) => b.kills_gained - a.kills_gained);

  const overallGained = raw.data?.skills?.overall?.experience?.gained ?? 0;

  const result: GainsResult = {
    period,
    starts_at: raw.startsAt ?? "unknown",
    ends_at: raw.endsAt ?? "unknown",
    xp_gained: overallGained,
    ehp_gained: round(raw.data?.computed?.ehp?.value?.gained ?? 0),
    ehb_gained: round(raw.data?.computed?.ehb?.value?.gained ?? 0),
    skills,
    top_skills: skills.slice(0, TOP_SKILL_COUNT),
    bosses,
  };

  // Wise Old Man measures gains between snapshots. With only one snapshot
  // inside the window there is nothing to diff, so it reports zero even for an
  // account that has been played — which reads as "did nothing" if unexplained.
  if (overallGained === 0 && skills.length === 0 && bosses.length === 0) {
    result.note =
      `No tracked gains in this ${period}. Wise Old Man compares snapshots, so this means it ` +
      `recorded fewer than two updates in the window — not necessarily that nothing was trained. ` +
      `Try a longer period, or update the account at wiseoldman.net to start a fresh window.`;
  }

  return result;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
