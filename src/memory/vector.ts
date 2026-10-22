import type { Env, MemoryRecord } from "../types.js";

/** Embeddings come from Workers AI — no external API key, no extra service. */
export async function embed(env: Env, text: string): Promise<number[] | null> {
  const model = env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3";
  const response = (await env.AI.run(model as never, { text: [text] } as never)) as {
    data?: number[][];
  };
  const vector = response?.data?.[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(`embedding model returned no vector (model=${model})`);
  }
  return vector;
}

/** Batched embeddings — one Workers AI call for the whole ingest batch. */
export async function embedBatch(env: Env, texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const model = env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3";
    const response = (await env.AI.run(model as never, { text: texts } as never)) as {
      data?: number[][];
    };
    const vectors = response?.data;
    return Array.isArray(vectors) && vectors.length === texts.length ? vectors : null;
  } catch {
    return null;
  }
}

export async function upsertVectors(
  env: Env,
  userId: string,
  records: MemoryRecord[],
  vectors: number[][],
): Promise<boolean> {
  try {
    await env.VECTORIZE.upsert(
      records.map((record, i) => ({
        id: record.id,
        values: vectors[i]!,
        namespace: userId,
        metadata: {
          userId,
          layer: record.layer,
          kind: record.kind,
          createdAt: record.created_at,
        },
      })),
    );
    return true;
  } catch {
    return false;
  }
}

export async function upsertVector(
  env: Env,
  userId: string,
  record: MemoryRecord,
  values: number[],
): Promise<boolean> {
  try {
    await env.VECTORIZE.upsert([
      {
        id: record.id,
        values,
        namespace: userId,
        metadata: {
          userId,
          layer: record.layer,
          kind: record.kind,
          createdAt: record.created_at,
        },
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function deleteVector(env: Env, id: string): Promise<void> {
  try {
    await env.VECTORIZE.deleteByIds([id]);
  } catch {
    // Vectorize being unavailable must never block a delete in D1.
  }
}

export async function queryVectors(
  env: Env,
  userId: string,
  values: number[],
  topK: number,
): Promise<string[]> {
  const response = await env.VECTORIZE.query(values, {
    topK,
    namespace: userId,
    returnMetadata: "none",
  });
  return (response.matches ?? []).map((match) => match.id);
}
