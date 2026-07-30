import { beforeEach, describe, expect, it } from "vitest";

import { readQuests, storeQuests, MAX_STORED_JOURNALS } from "../src/quest-store";
import type { IngestPayload } from "../src/items";
import { questReport } from "../src/quests";
import type { QuestSnapshot } from "../src/quest-store";

class FakeKV {
  readonly store = new Map<string, string>();
  writes: string[] = [];
  async get(key: string, type?: "json" | "text"): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> {
    this.writes.push(key);
    this.store.set(key, value);
  }
}

let kv: FakeKV;
beforeEach(() => {
  kv = new FakeKV();
});

const T0 = Date.parse("2026-07-30T12:00:00.000Z");

function journalPush(quest: string, lines: string[], progressVar?: number): IngestPayload {
  return {
    username: "questtest",
    quest_journal: { quest, lines, ...(progressVar === undefined ? {} : { progress_var: progressVar }) },
  } as IngestPayload;
}

describe("storeQuests", () => {
  it("stores a journal with its parsed lines", async () => {
    expect(await storeQuests(kv, journalPush("While Guthix Sleeps", ["<str>Done.</str>", "Do this."], 24), T0)).toBe("stored");

    const snapshot = await readQuests(kv, "questtest");
    const journal = snapshot!.journals["while guthix sleeps"];
    expect(journal.quest).toBe("While Guthix Sleeps");
    expect(journal.progress_var).toBe(24);
    expect(journal.lines).toEqual([
      { text: "Done.", done: true },
      { text: "Do this.", done: false },
    ]);
  });

  it("keys journals by slug so punctuation cannot split one quest into two", async () => {
    await storeQuests(kv, journalPush("Romeo & Juliet", ["a"]), T0);
    await storeQuests(kv, journalPush("ROMEO & JULIET!", ["b"]), T0 + 1000);
    expect(Object.keys((await readQuests(kv, "questtest"))!.journals)).toEqual(["romeo juliet"]);
  });

  it("skips the write when the in-progress vars are unchanged", async () => {
    // A vars-only push rides every bank and equipment sync, so unlike a
    // journal capture it must dedupe or it would burn the write budget on
    // every container sync.
    const payload = {
      username: "questtest",
      quests_in_progress: [{ quest: "A Quest", progress_var: 3 }],
    } as IngestPayload;
    expect(await storeQuests(kv, payload, T0)).toBe("stored");
    const before = kv.writes.length;
    expect(await storeQuests(kv, payload, T0 + 60_000)).toBe("unchanged");
    expect(kv.writes.length).toBe(before);
  });

  it("always writes a re-captured journal, even when the text is identical, refreshing captured_at", async () => {
    // A journal capture is never deduped: captured_at must mean "the last
    // time we saw this text and it was current", not "the last time it
    // changed" — otherwise a journal reconfirmed a moment ago would still
    // report as stale.
    await storeQuests(kv, journalPush("A Quest", ["line"], 3), T0);
    const before = kv.writes.length;
    expect(await storeQuests(kv, journalPush("A Quest", ["line"], 3), T0 + 60_000)).toBe("stored");
    expect(kv.writes.length).toBe(before + 1);
    const journal = (await readQuests(kv, "questtest"))!.journals["a quest"];
    expect(journal.captured_at).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("stores identical text when only the progress var moved", async () => {
    // The trap: journal text can be byte-identical while the quest has moved on.
    // A journal capture always writes now, so this no longer discriminates a
    // dedupe path — but it still pins that the newer progress_var is the one
    // persisted, not the stale one from the first capture.
    await storeQuests(kv, journalPush("A Quest", ["line"], 3), T0);
    expect(await storeQuests(kv, journalPush("A Quest", ["line"], 9), T0 + 60_000)).toBe("stored");
    expect((await readQuests(kv, "questtest"))!.journals["a quest"].progress_var).toBe(9);
  });

  it("evicts the oldest journal past the cap", async () => {
    for (let i = 0; i < MAX_STORED_JOURNALS + 3; i++) {
      await storeQuests(kv, journalPush(`Quest ${i}`, [`line ${i}`]), T0 + i * 1000);
    }
    const journals = (await readQuests(kv, "questtest"))!.journals;
    expect(Object.keys(journals)).toHaveLength(MAX_STORED_JOURNALS);
    expect(journals["quest 0"]).toBeUndefined();
    expect(journals["quest 27"]).toBeDefined();
  });

  it("evicts by captured_at, not by insertion order", async () => {
    // Fill to the cap with distinct quests at increasing timestamps. "Quest 0"
    // is inserted first and would sit first in Object.keys(...) order forever
    // unless eviction genuinely looks at captured_at instead.
    for (let i = 0; i < MAX_STORED_JOURNALS; i++) {
      await storeQuests(kv, journalPush(`Quest ${i}`, [`line ${i}`]), T0 + i * 1000);
    }

    // Re-capture "Quest 0" with different content much later: its captured_at
    // becomes the newest in the set, but its key position in the journals
    // object is unchanged (still first), since re-assigning an existing key
    // does not move it in insertion order. Content must actually change or
    // the dedupe path would keep the old captured_at and defeat this test.
    await storeQuests(kv, journalPush("Quest 0", ["line 0 v2"]), T0 + 1_000_000);

    // One more brand-new quest forces an eviction of exactly one journal.
    await storeQuests(kv, journalPush("Quest 25", ["line 25"]), T0 + 1_000_000 + 1000);

    const journals = (await readQuests(kv, "questtest"))!.journals;
    expect(Object.keys(journals)).toHaveLength(MAX_STORED_JOURNALS);
    // "Quest 0" was refreshed most recently, so it survives despite being
    // first in insertion order.
    expect(journals["quest 0"]).toBeDefined();
    expect(journals["quest 0"].lines).toEqual([{ text: "line 0 v2", done: false }]);
    // "Quest 1" is now the genuinely oldest by captured_at and is the one
    // dropped, not "Quest 0".
    expect(journals["quest 1"]).toBeUndefined();
  });

  it("records in-progress vars without a journal", async () => {
    const payload = {
      username: "questtest",
      quests_in_progress: [{ quest: "The Frozen Door" }, { quest: "A Quest", progress_var: 5 }],
    } as IngestPayload;
    expect(await storeQuests(kv, payload, T0)).toBe("stored");
    expect((await readQuests(kv, "questtest"))!.in_progress).toEqual([
      { quest: "The Frozen Door" },
      { quest: "A Quest", progress_var: 5 },
    ]);
  });

  it("does nothing and writes nothing for a push with no quest data", async () => {
    expect(await storeQuests(kv, { username: "questtest" } as IngestPayload, T0)).toBe("no-op");
    expect(kv.writes).toEqual([]);
  });

  it("keeps journals when a later push carries only vars", async () => {
    await storeQuests(kv, journalPush("A Quest", ["line"]), T0);
    await storeQuests(
      kv,
      { username: "questtest", quests_in_progress: [{ quest: "A Quest", progress_var: 1 }] } as IngestPayload,
      T0 + 1000,
    );
    expect((await readQuests(kv, "questtest"))!.journals["a quest"]).toBeDefined();
  });
});

const NOW = Date.parse("2026-07-30T14:00:00.000Z");

const snapshot: QuestSnapshot = {
  username: "questtest",
  updated_at: "2026-07-30T13:00:00.000Z",
  in_progress: [
    { quest: "While Guthix Sleeps", progress_var: 24 },
    { quest: "The Frozen Door" },
    { quest: "Desert Treasure I", progress_var: 2 },
    { quest: "Desert Treasure II - The Fallen Empire", progress_var: 5 },
  ],
  journals: {
    "while guthix sleeps": {
      quest: "While Guthix Sleeps",
      captured_at: "2026-07-30T12:00:00.000Z",
      client_timestamp: null,
      progress_var: 18,
      lines: [{ text: "Report to Idria.", done: false }],
    },
    "the frozen door": {
      quest: "The Frozen Door",
      captured_at: "2026-07-30T12:00:00.000Z",
      client_timestamp: null,
      progress_var: null,
      lines: [{ text: "Find the strange door.", done: false }],
    },
  },
};

describe("questReport", () => {
  it("flags a journal the player has progressed past", () => {
    const report = questReport("guthix sleeps", snapshot, "in_progress", NOW);
    expect(report.quest).toBe("While Guthix Sleeps");
    expect(report.progress_var).toBe(24);
    expect(report.journal!.captured_at_progress_var).toBe(18);
    expect(report.journal!.stale).toBe(true);
    expect(report.journal!.stale_note).toMatch(/reopen|open this quest/i);
  });

  it("does not flag a journal captured at the current progress", () => {
    const current: QuestSnapshot = {
      ...snapshot,
      in_progress: [{ quest: "While Guthix Sleeps", progress_var: 18 }],
    };
    expect(questReport("While Guthix Sleeps", current, "in_progress", NOW).journal!.stale).toBe(false);
  });

  it("cannot judge staleness without a var, and says so rather than guessing", () => {
    const report = questReport("The Frozen Door", snapshot, "in_progress", NOW);
    expect(report.journal!.stale).toBe(null);
    expect(report.journal!.age).toBe("2 hours ago");
  });

  it("flags a journal captured before the quest was completed", () => {
    const report = questReport("The Frozen Door", snapshot, "completed", NOW);
    expect(report.journal!.stale).toBe(true);
  });

  it("explains how to get a journal that was never captured", () => {
    const report = questReport("Sins of the Father", snapshot, "in_progress", NOW);
    expect(report.journal).toBe(null);
    expect(report.note).toMatch(/open .*quest journal/i);
  });

  it("reports ambiguity instead of picking a quest", () => {
    const report = questReport("desert treasure", snapshot, "in_progress", NOW);
    expect(report.quest).toBe(null);
    expect(report.candidates).toEqual([
      "Desert Treasure I",
      "Desert Treasure II - The Fallen Empire",
    ]);
    expect(report.note).toMatch(/several quests match/i);
  });
});
