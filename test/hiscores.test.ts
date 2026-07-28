import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { combatLevel, parseHiscores, type RawHiscores } from "../src/hiscores";

const fixture = (name: string): RawHiscores =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url)), "utf8"));

describe("parseHiscores — real ironman account", () => {
  const result = parseHiscores(fixture("hiscores-ironman"));

  it("reads the account name", () => {
    expect(result.name).toBe("IronExample");
  });

  it("keys skills by lowercased name, not row position", () => {
    // Row position breaks when Jagex inserts a skill; names do not.
    expect(result.skills.attack.level).toBe(78);
    expect(result.skills.overall.level).toBe(1683);
    expect(result.skills.overall.xp).toBe(28570687);
  });

  it("keeps rank and xp for ranked skills", () => {
    expect(result.skills.overall.rank).toBeGreaterThan(0);
    expect(result.skills.attack.xp).toBeGreaterThan(0);
  });

  it("includes every skill the account is ranked in", () => {
    expect(Object.keys(result.skills).length).toBeGreaterThan(20);
    for (const name of ["hitpoints", "magic", "ranged", "prayer", "defence", "strength"]) {
      expect(result.skills[name], `missing ${name}`).toBeDefined();
    }
  });

  it("returns boss killcounts as plain numbers", () => {
    for (const [name, kc] of Object.entries(result.bosses)) {
      expect(typeof kc, `${name} should be numeric`).toBe("number");
      expect(kc).toBeGreaterThan(0);
    }
    expect(result.bosses["Wintertodt"]).toBe(34);
    expect(result.bosses["Crazy Archaeologist"]).toBe(26);
  });

  it("keeps ranks and minigames out of the boss list", () => {
    // "PvP Arena - Rank 2289" is rank 2289, not 2289 kills. Reporting it as a
    // boss would have an assistant confidently invent a killcount.
    expect(result.bosses["PvP Arena - Rank"]).toBeUndefined();
    expect(result.bosses["Collections Logged"]).toBeUndefined();
    expect(result.bosses["Rifts closed"]).toBeUndefined();
    expect(result.bosses["Clue Scrolls (all)"]).toBeUndefined();

    expect(result.activities["PvP Arena - Rank"]).toBe(2289);
    expect(result.activities["Clue Scrolls (all)"]).toBe(21);
    expect(result.activities["Collections Logged"]).toBe(81);
  });

  it("classifies every real boss it finds as a boss", () => {
    for (const name of ["Barrows Chests", "Hespori", "Lunar Chests", "Tempoross"]) {
      expect(result.bosses[name], `${name} should be a boss`).toBeGreaterThan(0);
    }
  });
});

describe("unranked entries are omitted", () => {
  const raw = fixture("hiscores-unranked");
  const result = parseHiscores(raw);

  it("drops activities the account is not ranked in", () => {
    const unrankedNames = (raw.activities ?? [])
      .filter((a) => (a.score ?? -1) < 0)
      .map((a) => a.name);
    expect(unrankedNames.length).toBeGreaterThan(0);
    for (const name of unrankedNames) {
      expect(result.bosses[name!]).toBeUndefined();
    }
  });

  it("never surfaces a -1 anywhere in the output", () => {
    expect(Object.values(result.bosses)).not.toContain(-1);
    for (const skill of Object.values(result.skills)) {
      expect(skill.level).toBeGreaterThanOrEqual(0);
      expect(skill.xp).toBeGreaterThanOrEqual(0);
    }
  });

  it("drops zero-score activities as well as -1", () => {
    expect(Object.values(result.bosses).every((kc) => kc > 0)).toBe(true);
  });
});

describe("malformed input", () => {
  it("survives an empty response", () => {
    const result = parseHiscores({}, "Someone");
    expect(result.name).toBe("Someone");
    expect(result.skills).toEqual({});
    expect(result.bosses).toEqual({});
    expect(result.activities).toEqual({});
  });

  it("skips entries with no name", () => {
    const result = parseHiscores({ skills: [{ level: 50, xp: 100, rank: 1 }] });
    expect(result.skills).toEqual({});
  });
});

describe("combatLevel", () => {
  it("matches the known combat level for the fixture account", () => {
    // Cross-checked against Wise Old Man, which independently reports 103.
    expect(combatLevel(parseHiscores(fixture("hiscores-ironman")).skills)).toBe(103);
  });

  it("returns 3 for a fresh account", () => {
    const fresh = { hitpoints: { level: 10, xp: 0, rank: 1 } };
    expect(combatLevel(fresh)).toBe(3);
  });
});
