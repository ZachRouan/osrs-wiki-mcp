/**
 * Pure logic for player item snapshots pushed by the RuneLite sync plugin.
 *
 * No KV and no fetch in here, so all of it is testable under plain Node. The
 * storage layer lives in `item-store.ts` and the HTTP endpoint in `ingest.ts`.
 */

import { z } from "zod";

/** The three containers the plugin can push. */
export const CONTAINERS = ["bank", "inventory", "equipment"] as const;
export type ContainerName = (typeof CONTAINERS)[number];

/**
 * A bank tops out around 1,400 distinct items today. The cap is generous
 * rather than tight — it exists to stop a malformed push from filling KV, not
 * to encode a game limit that Jagex keeps raising.
 */
export const MAX_ITEMS_PER_CONTAINER = 10_000;

/** One line per journal text widget, so the interface bounds the count. */
export const MAX_JOURNAL_LINES = 210;

/** Long enough for any real journal line; short enough to bound the payload. */
export const MAX_JOURNAL_LINE_CHARS = 200;

/** Comfortably longer than "Recipe for Disaster: Freeing King Awowogei". */
export const MAX_QUEST_NAME_LENGTH = 60;

/** Long enough for every real item name; short enough to bound the payload. */
const MAX_ITEM_NAME_LENGTH = 120;

/**
 * Rune pouch slots. RuneLite exposes six rune/quantity varbit pairs, which
 * covers the regular and divine pouches.
 */
export const MAX_POUCH_SLOTS = 6;

/** OSRS display names are at most 12 characters. */
const MAX_USERNAME_LENGTH = 12;

export const itemStackSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string().min(1).max(MAX_ITEM_NAME_LENGTH),
  quantity: z.number().int().nonnegative(),
  /** Equipment only; absent for bank and inventory. */
  slot: z.string().max(32).optional(),
});

export type ItemStack = z.infer<typeof itemStackSchema>;

export const ingestPayloadSchema = z.object({
  username: z.string().min(1).max(MAX_USERNAME_LENGTH),
  /** The plugin's clock. Recorded, but never trusted for freshness. */
  timestamp: z.string().min(1).max(64).optional(),
  containers: z
    .object({
      bank: z.array(itemStackSchema).max(MAX_ITEMS_PER_CONTAINER).optional(),
      inventory: z.array(itemStackSchema).max(MAX_ITEMS_PER_CONTAINER).optional(),
      equipment: z.array(itemStackSchema).max(MAX_ITEMS_PER_CONTAINER).optional(),
    })
    // At least one container, otherwise the push is a no-op that still costs a
    // KV read and an index write.
    .refine((c) => CONTAINERS.some((name) => c[name] !== undefined), {
      message: "containers must include at least one of bank, inventory, equipment",
    }),
  /**
   * Occupied and total inventory slots, counted before the plugin merged stacks
   * by item id. Without these the item list's length is the only slot estimate
   * available, and it undercounts every non-stackable duplicate.
   */
  inventory_slots_used: z.number().int().nonnegative().max(MAX_ITEMS_PER_CONTAINER).optional(),
  inventory_slots_total: z.number().int().nonnegative().max(MAX_ITEMS_PER_CONTAINER).optional(),
  /**
   * Runes in a carried rune pouch. The inventory reports the pouch as one opaque
   * item, so these would otherwise be invisible. A pouch holds at most six kinds.
   */
  pouch_contents: z.array(itemStackSchema).max(MAX_POUCH_SLOTS).optional(),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

/**
 * OSRS treats spaces and underscores in display names as the same character,
 * and is case-insensitive. Normalising here means "Iron Example",
 * "iron_example" and "IRONEXAMPLE " all address one set of KV keys.
 */
export function normalizeUsername(username: string): string {
  return username.replace(/_/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
}

/** KV key holding one container's items. */
export function containerKey(username: string, container: ContainerName): string {
  return `items:${normalizeUsername(username)}:${container}`;
}

/**
 * KV key holding the small per-player sync index: when each container last
 * arrived and a hash of its contents. Kept separate from the containers so the
 * throttle and change checks never have to read a multi-hundred-KB bank blob.
 */
export function lastSyncKey(username: string): string {
  return `items:${normalizeUsername(username)}:last_sync`;
}

/**
 * Stable content hash for a container, used to skip rewriting a bank that has
 * not changed. Only id/quantity/slot matter — a name is a function of the id,
 * so a RuneLite name-cache refresh should not count as a change.
 *
 * `extra` folds in anything stored alongside the items that can change on its
 * own. Draining pouch runes leaves the inventory item list identical, so a hash
 * over items alone would dedupe that write away and serve stale pouch contents
 * under a fresh-looking snapshot age.
 */
export async function hashItems(items: ItemStack[], extra = ""): Promise<string> {
  const canonical =
    items
      .map((item) => `${item.id}:${item.quantity}:${item.slot ?? ""}`)
      .sort()
      .join("|") + (extra === "" ? "" : `#${extra}`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Human-readable age of a snapshot. The tools must report this: item data is a
 * point-in-time copy, and advice based on a two-day-old bank is worse than
 * advice that admits it is two days old.
 */
export function describeAge(isoTimestamp: string, nowMs: number): string {
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) return "unknown age";

  const seconds = Math.round((nowMs - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return seconds === 1 ? "1 second ago" : `${seconds} seconds ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Case-insensitive substring match on item names, highest quantity first. */
export function searchItems(items: ItemStack[], query: string): ItemStack[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return items
    .filter((item) => item.name.toLowerCase().includes(needle))
    .sort((a, b) => b.quantity - a.quantity);
}

/** The n largest stacks, which is the only useful summary of an unfiltered bank. */
export function topByQuantity(items: ItemStack[], limit: number): ItemStack[] {
  return [...items].sort((a, b) => b.quantity - a.quantity).slice(0, limit);
}

export function totalQuantity(items: ItemStack[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * Ceiling on a rendered item list. The 12,000-character limit used for wiki
 * prose would cut a real bank off around halfway, but `MAX_ITEMS_PER_CONTAINER`
 * allows far more than any bank holds, so some bound is still needed.
 */
export const MAX_ITEM_LIST_CHARS = 60_000;

export interface RenderedItems {
  text: string;
  shown: number;
  dropped: number;
}

/**
 * Render stacks as `Name xQuantity` lines, largest first.
 *
 * One line per stack costs about a quarter of what the equivalent array of JSON
 * objects does, which is what makes returning a whole bank affordable. Item ids
 * are omitted deliberately: every tool that consumes these names — ge_price,
 * check_materials, get_infobox — resolves by name, so the ids are dead weight.
 *
 * Sorting by quantity means a list long enough to truncate loses only its
 * least significant tail.
 */
export function renderItemLines(
  items: ItemStack[],
  maxChars: number = MAX_ITEM_LIST_CHARS,
): RenderedItems {
  const sorted = [...items].sort((a, b) => b.quantity - a.quantity);

  const lines: string[] = [];
  let used = 0;

  for (const item of sorted) {
    const line = `${item.name} x${item.quantity}`;
    // +1 for the newline joining this line to the previous one.
    const cost = line.length + (lines.length === 0 ? 0 : 1);
    if (used + cost > maxChars) break;
    lines.push(line);
    used += cost;
  }

  return {
    text: lines.join("\n"),
    shown: lines.length,
    dropped: sorted.length - lines.length,
  };
}

/**
 * Inventory-only facts stored beside the item list.
 *
 * Null rather than absent, so an older plugin that sends none of them is
 * distinguishable from one that reported a genuinely empty pouch.
 */
export interface InventoryExtras {
  slots_used: number | null;
  slots_total: number | null;
  pouch_contents: ItemStack[] | null;
}

export function inventoryExtras(payload: IngestPayload): InventoryExtras {
  return {
    slots_used: payload.inventory_slots_used ?? null,
    slots_total: payload.inventory_slots_total ?? null,
    pouch_contents: payload.pouch_contents ?? null,
  };
}

/** Canonical form of the extras, folded into the inventory's content hash. */
export function extrasFingerprint(extras: InventoryExtras): string {
  const pouch = (extras.pouch_contents ?? [])
    .map((rune) => `${rune.id}:${rune.quantity}`)
    .sort()
    .join(",");
  return `${extras.slots_used ?? ""}/${extras.slots_total ?? ""}/${pouch}`;
}

export type ContainerItems = Partial<Record<ContainerName, ItemStack[]>>;

/**
 * Where owned items can be found.
 *
 * A carried rune pouch holds real runes, so "how many law runes do I have" must
 * count them — but it is not a stored container: it has no KV key of its own and
 * travels inside the inventory snapshot. Keeping it out of `CONTAINERS` is what
 * stops it leaking into storage and the ingest schema.
 */
export const MATERIAL_SOURCES = [...CONTAINERS, "rune_pouch"] as const;
export type MaterialSource = (typeof MATERIAL_SOURCES)[number];

export type SourceItems = Partial<Record<MaterialSource, ItemStack[]>>;

export interface MaterialCheck {
  item: string;
  /** Total across every source, counting exact name matches only. */
  owned: number;
  have: boolean;
  sources: Partial<Record<MaterialSource, number>>;
  /**
   * Present only when nothing matched exactly. Charged and enchanted items
   * ("Amulet of glory(4)") are distinct items, so they are reported separately
   * rather than being silently counted as the base item.
   */
  similar?: Array<{ name: string; quantity: number; sources: Partial<Record<MaterialSource, number>> }>;
}

/**
 * How many of each named item the player owns, across bank, inventory and worn
 * equipment. Built for checking a Recipe template's materials, whose names are
 * exact wiki item names — hence exact matching, with near-misses surfaced
 * separately instead of folded into the total.
 */
export function checkMaterials(containers: SourceItems, names: string[]): MaterialCheck[] {
  return names.map((rawName) => {
    const name = rawName.trim();
    const needle = name.toLowerCase();

    const sources: Partial<Record<MaterialSource, number>> = {};
    let owned = 0;

    for (const container of MATERIAL_SOURCES) {
      const items = containers[container];
      if (!items) continue;

      const quantity = items
        .filter((item) => item.name.toLowerCase() === needle)
        .reduce((sum, item) => sum + item.quantity, 0);

      if (quantity > 0) {
        sources[container] = quantity;
        owned += quantity;
      }
    }

    if (owned > 0) return { item: name, owned, have: true, sources };

    // Nothing exact. Offer substring matches so "Amulet of glory" still
    // surfaces "Amulet of glory(4)" without claiming the player owns one.
    const similar = new Map<string, { name: string; quantity: number; sources: Partial<Record<MaterialSource, number>> }>();

    for (const container of MATERIAL_SOURCES) {
      for (const item of containers[container] ?? []) {
        if (!item.name.toLowerCase().includes(needle)) continue;

        const entry = similar.get(item.name) ?? { name: item.name, quantity: 0, sources: {} };
        entry.quantity += item.quantity;
        entry.sources[container] = (entry.sources[container] ?? 0) + item.quantity;
        similar.set(item.name, entry);
      }
    }

    const ranked = [...similar.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);

    return {
      item: name,
      owned: 0,
      have: false,
      sources: {},
      ...(ranked.length > 0 ? { similar: ranked } : {}),
    };
  });
}
