import type { Env, NewMemory } from "../types.js";
import { insertMemory, logIngest } from "./store.js";
import { embedBatch, upsertVectors } from "./vector.js";

/** Kept small so a single request stays well under Workers' 50-subrequest budget. */
export const MAX_INGEST_ITEMS = 20;

export interface IngestResult {
  ids: string[];
  count: number;
  vectorsOk: boolean;
}

export async function ingest(
  env: Env,
  userId: string,
  items: NewMemory[],
  source?: string | null,
): Promise<IngestResult> {
  const accepted = items.slice(0, MAX_INGEST_ITEMS);
  const records = [];

  for (const item of accepted) {
    records.push(
      await insertMemory(env, userId, { ...item, source: item.source ?? source ?? null }),
    );
  }

  let vectorsOk = false;
  if (records.length > 0) {
    const vectors = await embedBatch(env, records.map((r) => r.content));
    if (vectors) vectorsOk = await upsertVectors(env, userId, records, vectors);
  }

  await logIngest(env, userId, source ?? null, records.length);

  return { ids: records.map((r) => r.id), count: records.length, vectorsOk };
}
