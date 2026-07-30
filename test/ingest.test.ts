import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { handleIngest, type IngestConfig } from "../src/ingest";
import { readAllContainers, readContainer, readSyncIndex, storeContainers, WRITE_THROTTLE_MS } from "../src/item-store";
import { MAX_JOURNAL_LINE_CHARS, type IngestPayload, type ItemStack } from "../src/items";

const payload = JSON.parse(
  readFileSync(fileURLToPath(new URL("fixtures/item-sync-payload.json", import.meta.url)), "utf8"),
) as IngestPayload & { containers: { bank: ItemStack[]; inventory: ItemStack[]; equipment: ItemStack[] } };

const TOKEN = "test-sync-token-3f9a";

/** Enough of Workers KV to exercise the store, plus a write counter. */
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
let config: IngestConfig;

beforeEach(() => {
  kv = new FakeKV();
  config = { kv, token: TOKEN };
});

function post(body: unknown, headers: Record<string, string> = { "X-Sync-Token": TOKEN }): Request {
  return new Request("https://example.workers.dev/ingest/items", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("ingest authentication", () => {
  it("rejects a request with no token", async () => {
    const response = await handleIngest(post(payload, {}), config);
    expect(response.status).toBe(401);
    expect(kv.writes).toEqual([]);
  });

  it("rejects a wrong token of the same length", async () => {
    const wrong = TOKEN.slice(0, -1) + "0";
    expect(wrong).toHaveLength(TOKEN.length);
    expect((await handleIngest(post(payload, { "X-Sync-Token": wrong }), config)).status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    const response = await handleIngest(post(payload, { "X-Sync-Token": TOKEN.slice(0, 5) }), config);
    expect(response.status).toBe(401);
  });

  it("refuses everything when no SYNC_TOKEN is configured", async () => {
    // Must fail closed: the alternative is an anonymous write endpoint to KV.
    const unconfigured: IngestConfig = { kv };
    const response = await handleIngest(post(payload, {}), unconfigured);
    expect(response.status).toBe(503);
    expect(kv.writes).toEqual([]);

    const blank: IngestConfig = { kv, token: "   " };
    expect((await handleIngest(post(payload), blank)).status).toBe(503);
  });

  it("accepts the correct token", async () => {
    expect((await handleIngest(post(payload), config)).status).toBe(200);
  });

  it("rejects non-POST methods", async () => {
    const get = new Request("https://example.workers.dev/ingest/items", {
      method: "GET",
      headers: { "X-Sync-Token": TOKEN },
    });
    expect((await handleIngest(get, config)).status).toBe(405);
  });

  it("never echoes the expected token in an error body", async () => {
    const body = await (await handleIngest(post(payload, {}), config)).text();
    expect(body).not.toContain(TOKEN);
  });
});

describe("ingest validation", () => {
  it("rejects a body that is not JSON", async () => {
    const response = await handleIngest(post("this is not json"), config);
    expect(response.status).toBe(400);
    expect(kv.writes).toEqual([]);
  });

  it("rejects a payload that does not match the schema, and says why", async () => {
    const response = await handleIngest(post({ username: "IronExample" }), config);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { issues: Array<{ path: string; message: string }> };
    expect(body.issues.length).toBeGreaterThan(0);
    expect(
      body.issues.some(
        (i) => i.message.includes("container") && i.message.includes("journal") && i.message.includes("progress"),
      ),
    ).toBe(true);
  });

  it("rejects an oversized body", async () => {
    const big = "x".repeat(1024 * 1024 + 10);
    const response = await handleIngest(post(JSON.stringify({ big })), config);
    expect(response.status).toBe(413);
    expect(kv.writes).toEqual([]);
  });

  it("returns a plain error rather than a stack trace when KV fails", async () => {
    const broken: IngestConfig = {
      kv: {
        get: async () => null,
        put: async () => {
          throw new Error("KV PUT failed: 500");
        },
      },
      token: TOKEN,
    };

    const response = await handleIngest(post(payload), broken);
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("KV PUT failed: 500");
    expect(body.error).not.toContain("at ");
  });
});

describe("storage", () => {
  it("writes each container under its own key plus a sync index", async () => {
    await handleIngest(post(payload), config);

    expect([...kv.store.keys()].sort()).toEqual([
      "items:ironexample:bank",
      "items:ironexample:equipment",
      "items:ironexample:inventory",
      "items:ironexample:last_sync",
    ]);
  });

  it("stores all 500 bank items unmodified", async () => {
    await handleIngest(post(payload), config);

    const stored = await readContainer(kv, "IronExample", "bank");
    expect(stored!.count).toBe(500);
    expect(stored!.items).toEqual(payload.containers.bank);
    expect(stored!.username).toBe("IronExample");
  });

  it("records the server clock, not the client's", async () => {
    // A plugin with a wrong clock must not make a fresh snapshot look stale.
    const stale = { ...payload, timestamp: "2001-01-01T00:00:00Z" };
    await handleIngest(post(stale), config);

    const stored = await readContainer(kv, "IronExample", "bank");
    expect(stored!.client_timestamp).toBe("2001-01-01T00:00:00Z");
    expect(Date.parse(stored!.received_at)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("addresses the same keys however the username is spelled", async () => {
    await handleIngest(post({ ...payload, username: "iron_example" }), config);
    const viaSpaces = await readContainer(kv, "Iron Example", "bank");
    expect(viaSpaces!.count).toBe(500);
  });

  it("reads every container back at once", async () => {
    await handleIngest(post(payload), config);

    const containers = await readAllContainers(kv, "IronExample");
    expect(containers.bank).toHaveLength(500);
    expect(containers.inventory).toHaveLength(4);
    expect(containers.equipment).toHaveLength(10);
  });

  it("returns nothing for a player who has never synced", async () => {
    expect(await readContainer(kv, "Nobody", "bank")).toBeNull();
    expect(await readAllContainers(kv, "Nobody")).toEqual({});
    expect(await readSyncIndex(kv, "Nobody")).toBeNull();
  });
});

describe("write guards", () => {
  const t0 = Date.parse("2026-07-27T12:00:00Z");

  it("throttles a repeat push inside the window", async () => {
    await storeContainers(kv, payload, t0);
    kv.writes = [];

    const result = await storeContainers(kv, payload, t0 + WRITE_THROTTLE_MS - 1);

    expect(result.outcomes).toEqual({
      bank: "throttled",
      inventory: "throttled",
      equipment: "throttled",
    });
    expect(kv.writes).toEqual([]);
  });

  it("skips the item write when contents are unchanged, but keeps the age honest", async () => {
    await storeContainers(kv, payload, t0);
    kv.writes = [];

    const later = t0 + 60 * 60 * 1000;
    const result = await storeContainers(kv, payload, later);

    expect(result.outcomes.bank).toBe("unchanged");
    // The 500-item blob is not rewritten; only the small index is.
    expect(kv.writes).toEqual(["items:ironexample:last_sync"]);

    const index = await readSyncIndex(kv, "IronExample");
    expect(index!.containers.bank!.received_at).toBe(new Date(later).toISOString());
    // ...while the content date still points at the last real change.
    expect(index!.containers.bank!.content_changed_at).toBe(new Date(t0).toISOString());
  });

  it("writes when the contents actually change", async () => {
    await storeContainers(kv, payload, t0);
    kv.writes = [];

    const spent = {
      ...payload,
      containers: {
        ...payload.containers,
        bank: payload.containers.bank.map((item, i) =>
          i === 0 ? { ...item, quantity: item.quantity - 1 } : item,
        ),
      },
    };
    const result = await storeContainers(kv, spent, t0 + WRITE_THROTTLE_MS);

    expect(result.outcomes.bank).toBe("stored");
    expect(kv.writes).toContain("items:ironexample:bank");

    const stored = await readContainer(kv, "IronExample", "bank");
    expect(stored!.items[0].quantity).toBe(payload.containers.bank[0].quantity - 1);
  });

  it("throttles each container independently", async () => {
    await storeContainers(kv, { ...payload, containers: { bank: payload.containers.bank } }, t0);
    kv.writes = [];

    // A bank burst must not suppress an unrelated equipment change.
    const result = await storeContainers(
      kv,
      { ...payload, containers: { bank: payload.containers.bank, equipment: payload.containers.equipment } },
      t0 + 1000,
    );

    expect(result.outcomes.bank).toBe("throttled");
    expect(result.outcomes.equipment).toBe("stored");
  });

  it("does not write an index when nothing was accepted", async () => {
    await storeContainers(kv, payload, t0);
    kv.writes = [];

    await storeContainers(kv, payload, t0 + 1);
    expect(kv.writes).toEqual([]);
  });

  it("leaves untouched containers alone", async () => {
    await storeContainers(kv, payload, t0);

    await storeContainers(
      kv,
      { ...payload, containers: { equipment: payload.containers.equipment.slice(0, 3) } },
      t0 + WRITE_THROTTLE_MS,
    );

    const bank = await readContainer(kv, "IronExample", "bank");
    expect(bank!.count).toBe(500);
    expect((await readContainer(kv, "IronExample", "equipment"))!.count).toBe(3);
  });
});

describe("inventory slots and rune pouch", () => {
  const pouchPayload = (
    runes: ItemStack[],
    slotsUsed = 28,
  ): IngestPayload => ({
    username: "pouchtest",
    containers: {
      inventory: [
        { id: 12791, name: "Rune pouch", quantity: 1 },
        { id: 3144, name: "Cooked karambwan", quantity: 4 },
      ],
    },
    inventory_slots_used: slotsUsed,
    inventory_slots_total: 28,
    pouch_contents: runes,
  });

  it("stores slot counts and pouch contents beside the inventory", async () => {
    await storeContainers(kv, pouchPayload([{ id: 563, name: "Law rune", quantity: 12 }]), 1_000);

    const stored = await readContainer(kv, "pouchtest", "inventory");
    expect(stored?.extras).toEqual({
      slots_used: 28,
      slots_total: 28,
      pouch_contents: [{ id: 563, name: "Law rune", quantity: 12 }],
    });
    // No container of its own: the pouch costs no extra KV key. Checked as an
    // exact key set, since the test username itself contains "pouch".
    expect([...kv.writes].sort()).toEqual([
      "items:pouchtest:inventory",
      "items:pouchtest:last_sync",
    ]);
  });

  it("rewrites the snapshot when only the pouch changed", async () => {
    const t0 = 1_000_000;
    await storeContainers(kv, pouchPayload([{ id: 563, name: "Law rune", quantity: 12 }]), t0);

    // Same inventory items, fewer runes — casting spells drains the pouch while
    // the inventory list is byte-identical.
    const later = t0 + WRITE_THROTTLE_MS + 1;
    const result = await storeContainers(
      kv,
      pouchPayload([{ id: 563, name: "Law rune", quantity: 3 }]),
      later,
    );

    expect(result.outcomes.inventory).toBe("stored");
    const stored = await readContainer(kv, "pouchtest", "inventory");
    expect(stored?.extras?.pouch_contents).toEqual([{ id: 563, name: "Law rune", quantity: 3 }]);
  });

  it("still dedupes when nothing changed at all", async () => {
    const t0 = 2_000_000;
    const runes = [{ id: 563, name: "Law rune", quantity: 12 }];
    await storeContainers(kv, pouchPayload(runes), t0);
    const result = await storeContainers(kv, pouchPayload(runes), t0 + WRITE_THROTTLE_MS + 1);

    expect(result.outcomes.inventory).toBe("unchanged");
  });

  it("rewrites when only the slot count changed", async () => {
    const t0 = 3_000_000;
    const runes = [{ id: 563, name: "Law rune", quantity: 12 }];
    await storeContainers(kv, pouchPayload(runes, 28), t0);
    const result = await storeContainers(
      kv,
      pouchPayload(runes, 20),
      t0 + WRITE_THROTTLE_MS + 1,
    );

    expect(result.outcomes.inventory).toBe("stored");
    expect((await readContainer(kv, "pouchtest", "inventory"))?.extras?.slots_used).toBe(20);
  });

  it("exposes the pouch as its own material source", async () => {
    await storeContainers(kv, pouchPayload([{ id: 563, name: "Law rune", quantity: 12 }]), 1_000);

    const sources = await readAllContainers(kv, "pouchtest");
    expect(sources.rune_pouch).toEqual([{ id: 563, name: "Law rune", quantity: 12 }]);
    expect(sources.inventory).toHaveLength(2);
  });

  it("omits the pouch source when no pouch is carried", async () => {
    await storeContainers(
      kv,
      { username: "nopouch", containers: { inventory: [{ id: 995, name: "Coins", quantity: 5 }] } },
      1_000,
    );

    const sources = await readAllContainers(kv, "nopouch");
    expect(sources.rune_pouch).toBeUndefined();
  });

  it("accepts a push with no slot or pouch fields, as an older plugin sends", async () => {
    const response = await handleIngest(post(payload), config);
    expect(response.status).toBe(200);

    const stored = await readContainer(kv, payload.username, "inventory");
    expect(stored?.extras).toEqual({
      slots_used: null,
      slots_total: null,
      pouch_contents: null,
    });
  });
})

describe("quest payload acceptance", () => {
  const journal = {
    username: "questtest",
    quest_journal: {
      quest: "While Guthix Sleeps",
      progress_var: 24,
      lines: ["<str>Spoke to Ali.</str>", "I should report back to Idria."],
    },
  };

  it("accepts a payload carrying only a journal", async () => {
    expect((await handleIngest(post(journal), config)).status).toBe(200);
  });

  it("accepts a payload carrying only progress vars", async () => {
    const vars = {
      username: "questtest",
      quests_in_progress: [{ quest: "The Frozen Door" }, { quest: "Sins of the Father", progress_var: 7 }],
    };
    expect((await handleIngest(post(vars), config)).status).toBe(200);
  });

  it("still rejects a payload with nothing in it at all", async () => {
    const response = await handleIngest(post({ username: "questtest" }), config);
    expect(response.status).toBe(400);
    expect(kv.writes).toEqual([]);
  });

  it("rejects a journal with more lines than the interface can hold", async () => {
    const tooMany = {
      username: "questtest",
      quest_journal: { quest: "X", lines: Array.from({ length: 400 }, () => "line") },
    };
    expect((await handleIngest(post(tooMany), config)).status).toBe(400);
  });

  it("rejects a journal line longer than the interface can hold", async () => {
    const tooLong = {
      username: "questtest",
      quest_journal: { quest: "X", lines: ["a".repeat(MAX_JOURNAL_LINE_CHARS + 1)] },
    };
    expect((await handleIngest(post(tooLong), config)).status).toBe(400);
  });

  it("rejects an empty containers object with no quest data", async () => {
    const response = await handleIngest(post({ username: "questtest", containers: {} }), config);
    expect(response.status).toBe(400);
    expect(kv.writes).toEqual([]);
  });
});
