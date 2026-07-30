/**
 * `POST /ingest/items` — the write side of the RuneLite item sync.
 *
 * The only authenticated, state-changing surface on this Worker. Everything
 * else is a read-only proxy, so the checks here are the ones that matter.
 */

import { ingestPayloadSchema } from "./items";
import { type ItemKV, storeContainers } from "./item-store";
import { storeQuests } from "./quest-store";
import { secureEquals } from "./secure-compare";

export const INGEST_PATH = "/ingest/items";

export interface IngestConfig {
  kv: ItemKV;
  /** The `SYNC_TOKEN` secret. Absent means item sync is disabled. */
  token?: string;
}

/** 1 MiB. A 1,400-item bank serialises to well under 200 KB. */
const MAX_BODY_BYTES = 1024 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleIngest(request: Request, config: IngestConfig): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed. POST a JSON item payload." }, 405);
  }

  // Without a configured token the endpoint would be an open write to KV, so
  // it stays closed rather than defaulting to allow.
  const expected = config.token?.trim();
  if (!expected) {
    return json(
      { error: "Item sync is not configured on this server (no SYNC_TOKEN secret set)." },
      503,
    );
  }

  const presented = request.headers.get("X-Sync-Token") ?? "";
  if (!secureEquals(presented, expected)) {
    return json({ error: "Invalid or missing X-Sync-Token." }, 401);
  }

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: `Payload too large (limit ${MAX_BODY_BYTES} bytes).` }, 413);
  }

  let raw: unknown;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      return json({ error: `Payload too large (limit ${MAX_BODY_BYTES} bytes).` }, 413);
    }
    raw = JSON.parse(body);
  } catch {
    return json({ error: "Body is not valid JSON." }, 400);
  }

  const parsed = ingestPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: "Payload does not match the expected shape.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  try {
    const result = await storeContainers(config.kv, parsed.data, Date.now());
    const quests = await storeQuests(config.kv, parsed.data, Date.now());
    return json({ ...result, quests }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: `Could not store the snapshot: ${message}` }, 500);
  }
}
