import { recencyBoost, rrfFuse } from "../lib/rrf.js";
import type { Env, RecallHit, RecallResult } from "../types.js";
import { getMemoriesByIds, keywordSearch } from "./store.js";
import { embed, queryVectors } from "./vector.js";

export interface RecallOptions {
  limit?: number;
  /** Include memories that were superseded by a newer fact with the same key. */
  includeSuperseded?: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hybrid recall: dense (Vectorize) + sparse (FTS5/bm25) fused with RRF.
 *
 * Every stage degrades independently — if Vectorize or the embedding call fails,
 * keyword recall still returns results instead of the whole request erroring.
 */
export async function recall(
  env: Env,
  userId: string,
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 30);
  const degraded: string[] = [];
  const candidatePool = Math.max(limit * 3, 20);

  const [vectorIds, keywordIds] = await Promise.all([
    (async () => {
      try {
        const embedding = await embed(env, query);
        if (!embedding) {
          degraded.push("embedding_unavailable");
          return [] as string[];
        }
        return await queryVectors(env, userId, embedding, candidatePool);
      } catch (error) {
        degraded.push(`vector:${errorText(error)}`);
        return [] as string[];
      }
    })(),
    keywordSearch(env, userId, query, candidatePool).catch((error) => {
      degraded.push(`keyword:${errorText(error)}`);
      return [] as string[];
    }),
  ]);

  const fused = rrfFuse([
    { ids: vectorIds, weight: 1 },
    { ids: keywordIds, weight: 1 },
  ]);

  const shortlist = fused.slice(0, limit * 3);
  const records = await getMemoriesByIds(env, userId, shortlist.map((f) => f.id));
  const byId = new Map(records.map((r) => [r.id, r]));

  const hits: RecallHit[] = [];
  for (const entry of shortlist) {
    const memory = byId.get(entry.id);
    if (!memory) continue;
    if (!options.includeSuperseded && memory.superseded_by) continue;

    const via: string[] = [];
    if (vectorIds.includes(entry.id)) via.push("vector");
    if (keywordIds.includes(entry.id)) via.push("keyword");

    hits.push({
      memory,
      score: entry.score * (1 + 0.15 * recencyBoost(memory.created_at)),
      via,
    });
  }

  hits.sort((a, b) => b.score - a.score);

  return {
    hits: hits.slice(0, limit),
    diagnostics: {
      vector: vectorIds.length,
      keyword: keywordIds.length,
      fused: fused.length,
      degraded,
    },
  };
}
