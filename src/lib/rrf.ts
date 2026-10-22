/**
 * Reciprocal Rank Fusion.
 *
 * Fuses ranked id lists coming from different retrievers (vector, keyword, …)
 * without needing comparable scores. `k` damps the influence of deep ranks;
 * 60 is the value from the original RRF paper and works fine in practice.
 */
export interface FusionInput {
  ids: string[];
  weight?: number;
}

export function rrfFuse(
  inputs: FusionInput[],
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  for (const input of inputs) {
    const weight = input.weight ?? 1;
    input.ids.forEach((id, rank) => {
      const gain = weight / (k + rank + 1);
      scores.set(id, (scores.get(id) ?? 0) + gain);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** Mild recency boost: halves at ~30 days, never overrides relevance. */
export function recencyBoost(createdAtMs: number, nowMs = Date.now(), halfLifeDays = 30): number {
  const ageDays = Math.max(0, (nowMs - createdAtMs) / 86_400_000);
  return 0.5 ** (ageDays / halfLifeDays);
}
