/**
 * KV storage for player item snapshots.
 *
 * Snapshots are written with no TTL: an expiring bank would make the tools go
 * dark between play sessions, which is worse than serving data that honestly
 * reports its own age.
 */

import {
  CONTAINERS,
  type ContainerItems,
  type ContainerName,
  containerKey,
  extrasFingerprint,
  hashItems,
  type IngestPayload,
  type InventoryExtras,
  inventoryExtras,
  type ItemStack,
  lastSyncKey,
  type SourceItems,
} from "./items";

/**
 * The slice of Workers KV this module uses. `KVNamespace` satisfies it
 * structurally, but declaring it here keeps the store free of Worker-global
 * types — which is what lets it be typechecked and tested under plain Node.
 */
export interface ItemKV {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

/**
 * Minimum gap between accepted writes for one container. Opening a bank fires a
 * burst of container events, and KV itself only accepts one write per second to
 * the same key, so unthrottled bursts would be rejected upstream anyway.
 */
export const WRITE_THROTTLE_MS = 5_000;

/** Workers KV hard limit on a single value. */
export const MAX_KV_VALUE_BYTES = 25 * 1024 * 1024;

export interface StoredContainer {
  username: string;
  container: ContainerName;
  /** When the plugin last pushed this container, by server clock. */
  received_at: string;
  /** The plugin's own clock, recorded but not trusted. */
  client_timestamp: string | null;
  count: number;
  items: ItemStack[];
  /**
   * Inventory only, and absent on snapshots written before the plugin sent them.
   * Held here rather than in a container of its own so a rune pouch costs no
   * extra KV write and can never disagree with the inventory it came from.
   */
  extras?: InventoryExtras;
}

export interface SyncIndexEntry {
  /** Last accepted push, changed or not — this is what snapshot age means. */
  received_at: string;
  /** Last push whose contents actually differed from the stored copy. */
  content_changed_at: string;
  count: number;
  hash: string;
}

export interface SyncIndex {
  username: string;
  updated_at: string;
  containers: Partial<Record<ContainerName, SyncIndexEntry>>;
}

/** What happened to each container in one push. */
export type IngestOutcome = "stored" | "unchanged" | "throttled" | "too-large";

export interface IngestResult {
  username: string;
  received_at: string;
  outcomes: Partial<Record<ContainerName, IngestOutcome>>;
}

export async function readSyncIndex(kv: ItemKV, username: string): Promise<SyncIndex | null> {
  return (await kv.get(lastSyncKey(username), "json")) as SyncIndex | null;
}

export async function readContainer(
  kv: ItemKV,
  username: string,
  container: ContainerName,
): Promise<StoredContainer | null> {
  return (await kv.get(containerKey(username, container), "json")) as StoredContainer | null;
}

/**
 * Read every source of owned items at once, for tools that search all of them.
 *
 * A carried rune pouch is surfaced as its own source even though it is stored
 * inside the inventory snapshot: runes in the pouch are owned runes, and a
 * materials check that ignored them would under-report.
 */
export async function readAllContainers(kv: ItemKV, username: string): Promise<SourceItems> {
  const stored = await Promise.all(
    CONTAINERS.map((container) => readContainer(kv, username, container)),
  );

  const result: SourceItems = {};
  CONTAINERS.forEach((container, index) => {
    const snapshot = stored[index];
    if (snapshot) result[container] = snapshot.items;

    if (container === "inventory" && snapshot?.extras?.pouch_contents?.length) {
      result.rune_pouch = snapshot.extras.pouch_contents;
    }
  });
  return result;
}

/**
 * Persist the containers in one push.
 *
 * Two guards sit in front of every large write, because the free KV tier allows
 * 1,000 writes/day across this cache and the wiki cache combined:
 *
 *  - throttle: a container pushed less than WRITE_THROTTLE_MS ago is dropped
 *  - dedupe:   a container whose contents hash unchanged skips the item write,
 *              and only the small index entry is refreshed so the reported
 *              snapshot age stays honest
 */
export async function storeContainers(
  kv: ItemKV,
  payload: IngestPayload,
  nowMs: number,
): Promise<IngestResult> {
  const receivedAt = new Date(nowMs).toISOString();
  const existing = await readSyncIndex(kv, payload.username);

  const index: SyncIndex = {
    username: payload.username,
    updated_at: receivedAt,
    containers: { ...(existing?.containers ?? {}) },
  };

  const outcomes: IngestResult["outcomes"] = {};
  let indexChanged = false;

  for (const container of CONTAINERS) {
    const items = payload.containers[container];
    if (items === undefined) continue;

    const previous = index.containers[container];

    if (previous && nowMs - Date.parse(previous.received_at) < WRITE_THROTTLE_MS) {
      outcomes[container] = "throttled";
      continue;
    }

    const extras = container === "inventory" ? inventoryExtras(payload) : null;
    const hash = await hashItems(items, extras ? extrasFingerprint(extras) : "");

    if (previous && previous.hash === hash) {
      // Contents identical: refresh freshness only, skip the expensive write.
      index.containers[container] = { ...previous, received_at: receivedAt };
      outcomes[container] = "unchanged";
      indexChanged = true;
      continue;
    }

    const snapshot: StoredContainer = {
      username: payload.username,
      container,
      received_at: receivedAt,
      client_timestamp: payload.timestamp ?? null,
      count: items.length,
      items,
      ...(extras ? { extras } : {}),
    };

    const body = JSON.stringify(snapshot);
    if (new TextEncoder().encode(body).length > MAX_KV_VALUE_BYTES) {
      outcomes[container] = "too-large";
      continue;
    }

    await kv.put(containerKey(payload.username, container), body);
    index.containers[container] = {
      received_at: receivedAt,
      content_changed_at: receivedAt,
      count: items.length,
      hash,
    };
    outcomes[container] = "stored";
    indexChanged = true;
  }

  if (indexChanged) {
    await kv.put(lastSyncKey(payload.username), JSON.stringify(index));
  }

  return { username: payload.username, received_at: receivedAt, outcomes };
}
