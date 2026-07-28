import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkMaterials,
  containerKey,
  describeAge,
  hashItems,
  ingestPayloadSchema,
  type ItemStack,
  lastSyncKey,
  normalizeUsername,
  searchItems,
  topByQuantity,
  totalQuantity,
} from "../src/items";

const payload = JSON.parse(
  readFileSync(fileURLToPath(new URL("fixtures/item-sync-payload.json", import.meta.url)), "utf8"),
) as {
  username: string;
  timestamp: string;
  containers: { bank: ItemStack[]; inventory: ItemStack[]; equipment: ItemStack[] };
};

const bank = payload.containers.bank;
const inventory = payload.containers.inventory;
const equipment = payload.containers.equipment;
const all = { bank, inventory, equipment };

describe("the fixture is the realistic bank the tests claim it is", () => {
  it("holds 500 distinct items with real ids", () => {
    expect(bank).toHaveLength(500);
    expect(new Set(bank.map((i) => i.id)).size).toBe(500);
    expect(bank.every((i) => Number.isInteger(i.id) && i.id > 0)).toBe(true);
  });

  it("includes untradeables, which are absent from the GE mapping", () => {
    // Coins/Fire cape/Barrows gloves have no GE entry, but RuneLite reports
    // them — an implementation that assumes the mapping covers everything
    // would lose them.
    expect(inventory.find((i) => i.name === "Coins")?.id).toBe(995);
    expect(equipment.find((i) => i.name === "Fire cape")?.id).toBe(6570);
    expect(equipment.find((i) => i.name === "Barrows gloves")?.id).toBe(7462);
  });
});

describe("normalizeUsername", () => {
  it("treats underscores, spaces and case as the same name", () => {
    // OSRS itself does; two spellings must not become two sets of KV keys.
    const expected = "iron example";
    for (const spelling of ["Iron Example", "iron_example", " IRON_EXAMPLE ", "Iron  Example"]) {
      expect(normalizeUsername(spelling), spelling).toBe(expected);
    }
  });

  it("builds KV keys under a single namespace prefix", () => {
    expect(containerKey("IronExample", "bank")).toBe("items:ironexample:bank");
    expect(containerKey("Iron_Example", "equipment")).toBe("items:iron example:equipment");
    expect(lastSyncKey("IronExample")).toBe("items:ironexample:last_sync");
  });

  it("keeps every key inside KV's 512-byte limit", () => {
    const longest = containerKey("x".repeat(12), "inventory");
    expect(new TextEncoder().encode(longest).length).toBeLessThan(512);
  });
});

describe("ingestPayloadSchema", () => {
  it("accepts the real plugin payload", () => {
    expect(ingestPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts a push carrying only one container", () => {
    const result = ingestPayloadSchema.safeParse({
      username: "IronExample",
      containers: { equipment },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a push with no containers at all", () => {
    // A no-op push still costs a KV read and an index write.
    const result = ingestPayloadSchema.safeParse({ username: "IronExample", containers: {} });
    expect(result.success).toBe(false);
  });

  it("rejects usernames longer than OSRS allows", () => {
    const result = ingestPayloadSchema.safeParse({
      username: "a".repeat(13),
      containers: { bank },
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed item stacks", () => {
    for (const bad of [
      { id: "21105", name: "Topaz amulet (u)", quantity: 1 },
      { id: 21105, name: "", quantity: 1 },
      { id: 21105, name: "Topaz amulet (u)", quantity: -3 },
      { id: -1, name: "Topaz amulet (u)", quantity: 1 },
    ]) {
      const result = ingestPayloadSchema.safeParse({
        username: "IronExample",
        containers: { bank: [bad] },
      });
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects a container above the item cap", () => {
    const huge = Array.from({ length: 10_001 }, (_, i) => ({ id: i + 1, name: "x", quantity: 1 }));
    expect(ingestPayloadSchema.safeParse({ username: "a", containers: { bank: huge } }).success).toBe(
      false,
    );
  });
});

describe("hashItems", () => {
  it("is stable across reordering", async () => {
    // RuneLite does not promise a container order; a reshuffled bank is not a
    // changed bank and must not trigger a write.
    const shuffled = [...bank].reverse();
    expect(await hashItems(shuffled)).toBe(await hashItems(bank));
  });

  it("ignores name changes for the same id and quantity", async () => {
    const renamed = bank.map((item, i) => (i === 0 ? { ...item, name: "Renamed" } : item));
    expect(await hashItems(renamed)).toBe(await hashItems(bank));
  });

  it("changes when a quantity changes", async () => {
    const changed = bank.map((item, i) => (i === 0 ? { ...item, quantity: item.quantity + 1 } : item));
    expect(await hashItems(changed)).not.toBe(await hashItems(bank));
  });

  it("changes when an item is removed", async () => {
    expect(await hashItems(bank.slice(1))).not.toBe(await hashItems(bank));
  });

  it("distinguishes equipment slots", async () => {
    const moved = equipment.map((item, i) => (i === 0 ? { ...item, slot: "cape" } : item));
    expect(await hashItems(moved)).not.toBe(await hashItems(equipment));
  });
});

describe("describeAge", () => {
  const base = Date.parse("2026-07-27T12:00:00Z");
  const ago = (ms: number) => describeAge(new Date(base - ms).toISOString(), base);

  it("scales the unit to the gap", () => {
    expect(ago(1_000)).toBe("1 second ago");
    expect(ago(45_000)).toBe("45 seconds ago");
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(20 * 60_000)).toBe("20 minutes ago");
    expect(ago(60 * 60_000)).toBe("1 hour ago");
    expect(ago(5 * 60 * 60_000)).toBe("5 hours ago");
    expect(ago(24 * 60 * 60_000)).toBe("1 day ago");
    expect(ago(9 * 24 * 60 * 60_000)).toBe("9 days ago");
  });

  it("does not report a negative age when a clock runs fast", () => {
    expect(describeAge(new Date(base + 30_000).toISOString(), base)).toBe("just now");
  });

  it("says so rather than throwing on an unparseable timestamp", () => {
    expect(describeAge("not a date", base)).toBe("unknown age");
  });
});

describe("searchItems", () => {
  it("matches case-insensitively on any part of the name", () => {
    const matches = searchItems(bank, "TOPAZ");
    const names = matches.map((m) => m.name);
    expect(names).toContain("Red topaz");
    expect(names).toContain("Topaz amulet");
    expect(matches.every((m) => m.name.toLowerCase().includes("topaz"))).toBe(true);
  });

  it("returns the largest stacks first", () => {
    const quantities = searchItems(bank, "rune").map((m) => m.quantity);
    expect(quantities.length).toBeGreaterThan(1);
    expect([...quantities].sort((a, b) => b - a)).toEqual(quantities);
  });

  it("keeps the planted quantities intact", () => {
    expect(searchItems(bank, "Red topaz")[0].quantity).toBe(14);
    expect(searchItems(bank, "Silver bar")[0].quantity).toBe(62);
  });

  it("distinguishes items sharing a prefix", () => {
    const silver = searchItems(bank, "silver ").map((m) => m.name);
    expect(silver).toContain("Silver bar");
    expect(silver).toContain("Silver ore");
  });

  it("returns nothing for a miss or an empty query", () => {
    expect(searchItems(bank, "twisted bow")).toEqual([]);
    expect(searchItems(bank, "   ")).toEqual([]);
  });
});

describe("bank summarising", () => {
  it("returns the n largest stacks without mutating the source", () => {
    const before = bank.map((i) => i.id);
    const top = topByQuantity(bank, 50);

    expect(top).toHaveLength(50);
    expect(top[0].quantity).toBe(Math.max(...bank.map((i) => i.quantity)));
    expect([...top.map((i) => i.quantity)].sort((a, b) => b - a)).toEqual(top.map((i) => i.quantity));
    expect(bank.map((i) => i.id)).toEqual(before);
  });

  it("counts total quantity across every stack", () => {
    expect(totalQuantity(bank)).toBe(bank.reduce((s, i) => s + i.quantity, 0));
    expect(totalQuantity([])).toBe(0);
  });
});

describe("checkMaterials", () => {
  it("answers the Topaz amulet (u) recipe from the real bank", () => {
    // mat1/mat2 as get_infobox returns them for Topaz amulet (u).
    const results = checkMaterials(all, ["Red topaz", "Silver bar"]);

    expect(results.map((r) => r.have)).toEqual([true, true]);
    expect(results[0].owned).toBe(14);
    expect(results[0].sources).toEqual({ bank: 14 });
  });

  it("adds quantities across bank, inventory and equipment", () => {
    // Silver bar: 62 banked plus 12 carried.
    const [silver] = checkMaterials(all, ["Silver bar"]);
    expect(silver.sources).toEqual({ bank: 62, inventory: 12 });
    expect(silver.owned).toBe(74);
  });

  it("finds worn items that are nowhere else", () => {
    // Barrows gloves are equipped and not banked, so a bank-only search misses
    // them entirely.
    const [gloves] = checkMaterials(all, ["Barrows gloves"]);
    expect(gloves.have).toBe(true);
    expect(gloves.sources).toEqual({ equipment: 1 });
  });

  it("sums an item held in two places at once", () => {
    // One whip equipped, a spare in the bank.
    const [whip] = checkMaterials(all, ["Abyssal whip"]);
    expect(whip.sources).toEqual({ bank: 1, equipment: 1 });
    expect(whip.owned).toBe(2);
  });

  it("reports a clean zero for an item that is nowhere at all", () => {
    const [bow] = checkMaterials(all, ["Twisted bow"]);
    expect(bow.owned).toBe(0);
    expect(bow.have).toBe(false);
    expect(bow.sources).toEqual({});
    expect(bow.similar).toBeUndefined();
  });

  it("is case-insensitive on exact matches", () => {
    expect(checkMaterials(all, ["rED tOpAz"])[0].owned).toBe(14);
  });

  it("never counts a near-miss as the real item", () => {
    // The bank holds an Onyx amulet but no Onyx. Counting the amulet would
    // answer "yes, make the jewellery" when the gem is what is missing.
    const [onyx] = checkMaterials(all, ["Onyx"]);
    expect(onyx.owned).toBe(0);
    expect(onyx.have).toBe(false);
    expect(onyx.sources).toEqual({});
    expect(onyx.similar!.map((s) => s.name)).toEqual(["Onyx amulet"]);
  });

  it("caps the near-miss list at the five largest", () => {
    // "Fire" matches seven items across the containers; only five come back,
    // largest first.
    const [fire] = checkMaterials(all, ["Fire"]);
    expect(fire.have).toBe(false);
    expect(fire.similar).toHaveLength(5);
    expect(fire.similar![0].name).toBe("Fire rune");
    expect(fire.similar!.every((s) => s.name.toLowerCase().includes("fire"))).toBe(true);

    const quantities = fire.similar!.map((s) => s.quantity);
    expect([...quantities].sort((a, b) => b - a)).toEqual(quantities);
  });

  it("handles a whole recipe at once, in order", () => {
    const materials = ["Topaz amulet", "Cosmic rune", "Fire rune", "Onyx"];
    const results = checkMaterials(all, materials);

    expect(results.map((r) => r.item)).toEqual(materials);
    expect(results.map((r) => r.have)).toEqual([true, true, true, false]);
  });

  it("tolerates containers that were never synced", () => {
    const [topaz] = checkMaterials({ bank }, ["Red topaz"]);
    expect(topaz.owned).toBe(14);
    expect(checkMaterials({}, ["Red topaz"])[0].have).toBe(false);
  });
});
