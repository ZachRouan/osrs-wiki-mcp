import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseWikiSync, type RawWikiSync } from "../src/wikisync";
import { parseGains, type RawGains } from "../src/wom";

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url)), "utf8"));

describe("parseWikiSync — real synced account", () => {
  const raw = load<RawWikiSync>("wikisync");
  const result = parseWikiSync(raw);

  it("reads identity and sync time", () => {
    expect(result.username).toBe("IronExample");
    expect(result.synced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("splits quests by the 0/1/2 state encoding", () => {
    // Verified against the live payload: 181 finished, 5 started, 25 untouched.
    expect(result.quest_counts.completed).toBe(181);
    expect(result.quest_counts.in_progress).toBe(5);
    expect(result.quests.in_progress).toContain("Sins of the Father");
    expect(result.quests.completed).toContain("A Kingdom Divided");
  });

  it("filters the junk '.' quest key out of every bucket", () => {
    const all = [
      ...result.quests.completed,
      ...result.quests.in_progress,
      ...result.quests.not_started,
    ];
    expect(all).not.toContain(".");
    expect(all).not.toContain("");
    // The raw payload does contain it, so this is a real filter, not a no-op.
    expect(Object.keys(raw.quests ?? {})).toContain(".");
  });

  it("computes diary progress as completed/total from the tasks array", () => {
    const ardougne = result.diaries["Ardougne"];
    expect(ardougne.easy.complete).toBe(true);
    expect(ardougne.easy.progress).toBe("10/10");
    expect(ardougne.hard.complete).toBe(false);
    // Hard has 12 tasks with 5 done in the fixture.
    expect(ardougne.hard.completed_tasks).toBe(5);
    expect(ardougne.hard.total_tasks).toBe(12);
    expect(ardougne.hard.progress).toBe("5/12");
  });

  it("orders diary tiers by difficulty, not alphabetically", () => {
    // The API returns Easy, Elite, Hard, Medium — useless for a reader.
    expect(Object.keys(result.diaries["Ardougne"])).toEqual(["easy", "medium", "hard", "elite"]);
  });

  it("covers all twelve diary regions", () => {
    expect(Object.keys(result.diaries)).toHaveLength(12);
    expect(result.diary_counts.total_tiers).toBe(48);
    expect(result.diary_counts.completed_tiers).toBeLessThanOrEqual(48);
  });

  it("passes through levels and counts combat achievements", () => {
    expect(result.levels.Hunter).toBe(70);
    expect(result.combat_achievements).toBe(29);
  });

  it("survives an empty payload", () => {
    const empty = parseWikiSync({}, "Nobody");
    expect(empty.username).toBe("Nobody");
    expect(empty.quest_counts.total).toBe(0);
    expect(empty.diaries).toEqual({});
    expect(empty.synced_at).toBe("unknown");
  });
});

describe("parseGains — Wise Old Man", () => {
  // Deliberately the year fixture: the week response for this account is all
  // zeroes, which would let the assertions below pass against empty arrays.
  const result = parseGains(load<RawGains>("wom-gained-year"), "year");

  it("reports the period window", () => {
    expect(result.period).toBe("year");
    expect(result.starts_at).toMatch(/^\d{4}-/);
  });

  it("has real gains to assert against", () => {
    expect(result.skills.length).toBeGreaterThan(10);
    expect(result.xp_gained).toBeGreaterThan(1_000_000);
  });

  it("only lists skills that actually gained xp", () => {
    expect(result.skills.every((s) => s.xp_gained > 0)).toBe(true);
  });

  it("drops zero-gain skills entirely", () => {
    // The week payload reports every skill with gained: 0, so a parser that
    // failed to filter would emit two dozen useless rows.
    const raw = load<RawGains>("wom-gained-week-empty");
    const rawSkillCount = Object.keys(raw.data?.skills ?? {}).length;
    expect(rawSkillCount).toBeGreaterThan(20);
    expect(parseGains(raw, "week").skills).toEqual([]);
  });

  it("excludes overall from the per-skill list to avoid double counting", () => {
    expect(result.skills.map((s) => s.skill)).not.toContain("overall");
  });

  it("reports levels gained alongside xp", () => {
    const strength = result.skills.find((s) => s.skill === "strength");
    expect(strength?.xp_gained).toBe(2970433);
    expect(strength?.levels_gained).toBe(9);
  });

  it("sorts skills by xp gained and exposes the top 3", () => {
    const xp = result.skills.map((s) => s.xp_gained);
    expect([...xp].sort((a, b) => b - a)).toEqual(xp);
    expect(result.top_skills.length).toBeLessThanOrEqual(3);
    expect(result.top_skills).toEqual(result.skills.slice(0, 3));
  });

  it("reports efficiency metrics as rounded numbers", () => {
    expect(typeof result.ehp_gained).toBe("number");
    expect(typeof result.ehb_gained).toBe("number");
    expect(Number.isFinite(result.ehp_gained)).toBe(true);
  });

  it("only lists bosses with kills gained", () => {
    expect(result.bosses.every((b) => b.kills_gained > 0)).toBe(true);
  });

  it("survives an empty payload", () => {
    const empty = parseGains({}, "day");
    expect(empty.skills).toEqual([]);
    expect(empty.top_skills).toEqual([]);
    expect(empty.xp_gained).toBe(0);
  });

  it("explains an all-zero result rather than implying nothing was trained", () => {
    // WOM reports 0 when it has fewer than two snapshots in the window, which
    // is not the same as the player being idle.
    const idle = parseGains(load<RawGains>("wom-gained-week-empty"), "week");
    expect(idle.note).toMatch(/compares snapshots/i);
    expect(idle.note).toMatch(/not necessarily/i);
  });

  it("stays quiet when there are real gains to report", () => {
    expect(parseGains(load<RawGains>("wom-gained-year"), "year").note).toBeUndefined();
  });
});
