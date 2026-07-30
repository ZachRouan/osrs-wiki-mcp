import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { matchQuest, parseJournalLines, questSlug } from "../src/quests";

const { captures } = JSON.parse(
  readFileSync(fileURLToPath(new URL("fixtures/quest-journal-raw.json", import.meta.url)), "utf8"),
) as { captures: Array<{ quest: string; finished: boolean; lines: string[] }> };

/** Real capture of an in-progress quest: 53 lines, 47 of them struck through. */
const guthix = captures.find((c) => c.quest === "While Guthix Sleeps")!;

describe("parseJournalLines", () => {
  it("strips colour tags and keeps the words", () => {
    expect(parseJournalLines(["<col=800000>I should report back to Idria.</col>"])).toEqual([
      { text: "I should report back to Idria.", done: false },
    ]);
  });

  it("does not insert a space where a tag sits against punctuation", () => {
    // Real capture: the journal recolours proper nouns mid-sentence, so
    // replacing a tag with a space yields "Dark Squall ." instead of
    // "Dark Squall.". Tags are removed outright; the game's own spacing is
    // already correct on both sides of every tag.
    expect(
      parseJournalLines(["<col=000080>a search for the <col=800000>Dark Squall<col=000080>."])[0]
        .text,
    ).toBe("a search for the Dark Squall.");
  });

  it("marks a struck-through line as done and removes the tag", () => {
    expect(parseJournalLines(["<str>I spoke to Ali the Wise.</str>"])).toEqual([
      { text: "I spoke to Ali the Wise.", done: true },
    ]);
  });

  it("treats a line as done when only part of it is struck through", () => {
    // The game opens <str> mid-line on wrapped steps, so requiring the whole
    // line to be wrapped would silently mark completed steps as outstanding.
    expect(parseJournalLines(["Step one <str>done</str>"])[0].done).toBe(true);
  });

  it("collapses whitespace and drops lines that are empty after stripping", () => {
    expect(parseJournalLines(["<br>", "  ", "<col=ff>   </col>", "a   b"])).toEqual([
      { text: "a b", done: false },
    ]);
  });

  it("caps the number of lines", () => {
    const many = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    expect(parseJournalLines(many)).toHaveLength(210);
  });

  it("truncates an over-long line", () => {
    const [line] = parseJournalLines(["x".repeat(500)]);
    expect(line.text).toHaveLength(200);
  });

  it("drops a tag left dangling by the plugin's 200-char raw cutoff", () => {
    // The plugin truncates the raw line at 200 characters including markup,
    // which can land mid-tag. `<col=7f00` never closes, so the complete-tag
    // regex alone leaves it sitting in the visible text.
    expect(
      parseJournalLines(["Retrieve the pieces of the Dragonkin Cog. <col=7f00"])[0].text,
    ).toBe("Retrieve the pieces of the Dragonkin Cog.");
  });

  it("does not touch a complete tag that legitimately ends the line", () => {
    expect(parseJournalLines(["<str>I spoke to Ali the Wise.</str>"])[0].text).toBe(
      "I spoke to Ali the Wise.",
    );
  });

  it("parses every real capture without producing empty or marked-up text", () => {
    for (const capture of captures) {
      const parsed = parseJournalLines(capture.lines);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.every((line) => line.text.length > 0)).toBe(true);
      expect(parsed.some((line) => line.text.includes("<"))).toBe(false);
    }
  });

  it("separates the completed steps from the outstanding objective", () => {
    // The whole point of the feature: the tail of an in-progress journal is
    // the current objective, and it is the part NOT struck through.
    const parsed = parseJournalLines(guthix.lines);
    expect(parsed).toHaveLength(53);
    expect(parsed.filter((line) => line.done)).toHaveLength(47);
    expect(parsed[0]).toEqual({
      text: "I spoke to Ivy Sophista in Taverley. She directed me to",
      done: true,
    });
    expect(parsed[parsed.length - 1]).toEqual({
      text: "to the others about what to do next.",
      done: false,
    });
  });
});

describe("questSlug", () => {
  it("is case, punctuation and spacing insensitive", () => {
    expect(questSlug("Romeo & Juliet")).toBe("romeo juliet");
    expect(questSlug("  While   Guthix Sleeps ")).toBe("while guthix sleeps");
    expect(questSlug("Recipe for Disaster: Evil Dave")).toBe("recipe for disaster evil dave");
    expect(questSlug("Desert Treasure II - The Fallen Empire")).toBe(
      "desert treasure ii the fallen empire",
    );
  });
});

describe("matchQuest", () => {
  const names = [
    "While Guthix Sleeps",
    "Desert Treasure I",
    "Desert Treasure II - The Fallen Empire",
    "Sins of the Father",
  ];

  it("matches exactly regardless of case and punctuation", () => {
    expect(matchQuest("while guthix sleeps", names).matched).toBe("While Guthix Sleeps");
    expect(matchQuest("Desert Treasure 1", names).matched).toBe(null);
    expect(matchQuest("Sins of the Father!", names).matched).toBe("Sins of the Father");
  });

  it("matches a unique substring", () => {
    expect(matchQuest("guthix sleeps", names).matched).toBe("While Guthix Sleeps");
  });

  it("prefers an exact match over a substring one", () => {
    // "Desert Treasure I" is also a substring of the sequel's name, so a
    // substring-first rule would resolve the exact name to the wrong quest.
    expect(matchQuest("Desert Treasure I", names).matched).toBe("Desert Treasure I");
  });

  it("reports ambiguity with candidates instead of guessing", () => {
    const result = matchQuest("desert treasure", names);
    expect(result.matched).toBe(null);
    expect(result.candidates).toEqual([
      "Desert Treasure I",
      "Desert Treasure II - The Fallen Empire",
    ]);
  });

  it("returns nothing for an unknown quest", () => {
    expect(matchQuest("nonexistent quest", names)).toEqual({ matched: null, candidates: [] });
  });
});
