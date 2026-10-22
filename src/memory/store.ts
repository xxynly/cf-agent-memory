import { newId } from "../lib/id.js";
import { buildFtsQuery, tokenize, tokensToText } from "../lib/tokens.js";
import type { Env, MemoryRecord, NewMemory } from "../types.js";

const COLUMNS = [
  "id",
  "user_id",
  "layer",
  "kind",
  "key",
  "content",
  "tags",
  "tokens",
  "scope",
  "importance",
  "source",
  "superseded_by",
  "created_at",
  "updated_at",
  "accessed_at",
  "access_count",
].join(", ");

export interface ListOptions {
  limit?: number;
  offset?: number;
  layer?: string;
  kind?: string;
  tag?: string;
  includeSuperseded?: boolean;
}

function clampLimit(value: number | undefined, fallback = 20, max = 100): number {
  if (!value || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

export async function insertMemory(
  env: Env,
  userId: string,
  input: NewMemory,
): Promise<MemoryRecord> {
  const now = Date.now();
  const id = newId();
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const tokens = tokensToText(
    tokenize([input.content, input.key ?? "", tags.join(" ")].join(" ")),
  );

  const record: MemoryRecord = {
    id,
    user_id: userId,
    layer: input.layer ?? "l1",
    kind: input.kind ?? "fact",
    key: input.key ?? null,
    content: input.content,
    tags: tags.join(","),
    tokens,
    scope: input.scope ?? "personal",
    importance: Math.min(Math.max(input.importance ?? 3, 1), 5),
    source: input.source ?? null,
    superseded_by: null,
    created_at: now,
    updated_at: now,
    accessed_at: null,
    access_count: 0,
  };

  const statements: D1PreparedStatement[] = [];

  if (record.key) {
    statements.push(
      env.DB.prepare(
        `UPDATE memories SET superseded_by = ?1, updated_at = ?2
         WHERE user_id = ?3 AND key = ?4 AND superseded_by IS NULL`,
      ).bind(id, now, userId, record.key),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO memories (${COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`,
    ).bind(
      record.id,
      record.user_id,
      record.layer,
      record.kind,
      record.key,
      record.content,
      record.tags,
      record.tokens,
      record.scope,
      record.importance,
      record.source,
      record.superseded_by,
      record.created_at,
      record.updated_at,
      record.accessed_at,
      record.access_count,
    ),
  );

  const ftsStatement = env.DB.prepare(
    `INSERT INTO memories_fts (memory_id, tokens) VALUES (?1, ?2)`,
  ).bind(id, tokens);

  try {
    await env.DB.batch([...statements, ftsStatement]);
  } catch (error) {
    // FTS5 may be unavailable in some D1 regions/plans: keep the write path alive.
    if (!isFtsError(error)) throw error;
    await env.DB.batch(statements);
  }

  return record;
}

export async function getMemory(env: Env, userId: string, id: string): Promise<MemoryRecord | null> {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM memories WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, userId)
    .first<MemoryRecord>();
  return row ?? null;
}

export async function getMemoriesByIds(
  env: Env,
  userId: string,
  ids: string[],
): Promise<MemoryRecord[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM memories WHERE user_id = ?1 AND id IN (${placeholders})`,
  )
    .bind(userId, ...ids)
    .all<MemoryRecord>();
  return results ?? [];
}

export async function listMemories(
  env: Env,
  userId: string,
  options: ListOptions = {},
): Promise<MemoryRecord[]> {
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const filters = ["user_id = ?1"];
  const bindings: unknown[] = [userId];

  if (!options.includeSuperseded) filters.push("superseded_by IS NULL");
  if (options.layer) {
    bindings.push(options.layer);
    filters.push(`layer = ?${bindings.length}`);
  }
  if (options.kind) {
    bindings.push(options.kind);
    filters.push(`kind = ?${bindings.length}`);
  }
  if (options.tag) {
    bindings.push(`%${options.tag}%`);
    filters.push(`tags LIKE ?${bindings.length}`);
  }

  bindings.push(limit, offset);
  const sql = `SELECT ${COLUMNS} FROM memories
    WHERE ${filters.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?${bindings.length - 1} OFFSET ?${bindings.length}`;

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<MemoryRecord>();
  return results ?? [];
}

export async function updateMemory(
  env: Env,
  userId: string,
  id: string,
  patch: { content?: string; tags?: string[]; importance?: number; key?: string | null },
): Promise<MemoryRecord | null> {
  const existing = await getMemory(env, userId, id);
  if (!existing) return null;

  const content = patch.content ?? existing.content;
  const tags = patch.tags ? patch.tags.join(",") : existing.tags;
  const tokens = tokensToText(tokenize([content, patch.key ?? existing.key ?? "", tags].join(" ")));
  const now = Date.now();

  const statements = [
    env.DB.prepare(
      `UPDATE memories SET content = ?1, tags = ?2, tokens = ?3, importance = ?4, key = ?5, updated_at = ?6
       WHERE id = ?7 AND user_id = ?8`,
    ).bind(
      content,
      tags,
      tokens,
      patch.importance ?? existing.importance,
      patch.key === undefined ? existing.key : patch.key,
      now,
      id,
      userId,
    ),
    env.DB.prepare(`DELETE FROM memories_fts WHERE memory_id = ?1`).bind(id),
    env.DB.prepare(`INSERT INTO memories_fts (memory_id, tokens) VALUES (?1, ?2)`).bind(id, tokens),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (!isFtsError(error)) throw error;
    await env.DB.batch(statements.slice(0, 1));
  }

  return getMemory(env, userId, id);
}

export async function deleteMemory(env: Env, userId: string, id: string): Promise<boolean> {
  const existing = await getMemory(env, userId, id);
  if (!existing) return false;

  const statements = [
    env.DB.prepare(`DELETE FROM memories WHERE id = ?1 AND user_id = ?2`).bind(id, userId),
    env.DB.prepare(`DELETE FROM memories_fts WHERE memory_id = ?1`).bind(id),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (!isFtsError(error)) throw error;
    await env.DB.batch(statements.slice(0, 1));
  }
  return true;
}

/** Keyword channel. Returns ids ordered best-first. */
export async function keywordSearch(
  env: Env,
  userId: string,
  query: string,
  limit = 20,
): Promise<string[]> {
  const tokens = tokenize(query);
  const match = buildFtsQuery(tokens);
  if (!match) return [];

  try {
    const { results } = await env.DB.prepare(
      `SELECT f.memory_id AS id
       FROM memories_fts f
       JOIN memories m ON m.id = f.memory_id
       WHERE memories_fts MATCH ?1 AND m.user_id = ?2 AND m.superseded_by IS NULL
       ORDER BY bm25(memories_fts)
       LIMIT ?3`,
    )
      .bind(match, userId, limit)
      .all<{ id: string }>();
    return (results ?? []).map((r) => r.id);
  } catch (error) {
    if (!isFtsError(error)) throw error;
    // Fallback: AND over the first few tokens using LIKE. Slower, still correct.
    const probe = tokens.slice(0, 3);
    if (probe.length === 0) return [];
    const where = probe.map((_, i) => `tokens LIKE ?${i + 3}`).join(" AND ");
    const { results } = await env.DB.prepare(
      `SELECT id FROM memories
       WHERE user_id = ?1 AND superseded_by IS NULL AND ${where}
       ORDER BY created_at DESC LIMIT ?2`,
    )
      .bind(userId, limit, ...probe.map((t) => `%${t}%`))
      .all<{ id: string }>();
    return (results ?? []).map((r) => r.id);
  }
}

export async function touchMemories(env: Env, userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
  await env.DB.prepare(
    `UPDATE memories SET accessed_at = ?1, access_count = access_count + 1
     WHERE user_id = ?${ids.length + 2} AND id IN (${placeholders})`,
  )
    .bind(now, ...ids, userId)
    .run()
    .catch(() => undefined);
}

export async function stats(env: Env, userId: string) {
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE user_id = ?1 AND superseded_by IS NULL`,
  )
    .bind(userId)
    .first<{ n: number }>();

  const byLayer = await env.DB.prepare(
    `SELECT layer, COUNT(*) AS n FROM memories
     WHERE user_id = ?1 AND superseded_by IS NULL GROUP BY layer`,
  )
    .bind(userId)
    .all<{ layer: string; n: number }>();

  const byKind = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM memories
     WHERE user_id = ?1 AND superseded_by IS NULL GROUP BY kind`,
  )
    .bind(userId)
    .all<{ kind: string; n: number }>();

  return {
    total: total?.n ?? 0,
    byLayer: Object.fromEntries((byLayer.results ?? []).map((r) => [r.layer, r.n])),
    byKind: Object.fromEntries((byKind.results ?? []).map((r) => [r.kind, r.n])),
  };
}

export async function logIngest(
  env: Env,
  userId: string,
  source: string | null,
  count: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ingest_log (id, user_id, source, count, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(newId("ing"), userId, source, count, Date.now())
    .run()
    .catch(() => undefined);
}

function isFtsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|fts5|malformed|unable to use function MATCH/i.test(message);
}
