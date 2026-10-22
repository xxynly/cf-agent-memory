import { newId } from "../lib/id.js";
import { buildFtsQuery, tokenize, tokensToText } from "../lib/tokens.js";
import type {
  Env,
  NewSkill,
  SkillFileEntry,
  SkillRecord,
  SkillStatus,
} from "../types.js";

const COLUMNS = [
  "id",
  "user_id",
  "name",
  "description",
  "content",
  "content_hash",
  "version",
  "tags",
  "tokens",
  "status",
  "owner_agent_id",
  "manifest",
  "created_at",
  "updated_at",
].join(", ");

/** Cap on how much of SKILL.md we feed to the tokenizer — indexing is CPU-bound. */
const INDEX_CHARS = 20_000;

export interface ListSkillsOptions {
  limit?: number;
  offset?: number;
  tag?: string;
  status?: SkillStatus;
  agentId?: string;
}

function clampLimit(value: number | undefined, fallback = 20, max = 100): number {
  if (!value || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function indexTokens(name: string, description: string, content: string, tags: string): string {
  const body = content.length > INDEX_CHARS ? content.slice(0, INDEX_CHARS) : content;
  return tokensToText(tokenize([name, description, tags, body].join(" ")));
}

function normalizeName(name: string): string {
  return name.trim().slice(0, 120);
}

/** Files are addressed by relative path; reject anything that could escape the prefix. */
export function safePath(path: string): string | null {
  const trimmed = path.replace(/^\/+/, "").trim();
  if (!trimmed || trimmed.includes("..") || trimmed.length > 512) return null;
  return trimmed;
}

function fileKey(userId: string, skillId: string, path: string): string {
  return `${userId}/skills/${skillId}/${path}`;
}

/**
 * Import a skill by name. Importing an existing name is an *update*: the old
 * head is snapshotted into `skill_versions` and the version counter increments,
 * mirroring the upstream append-version semantics.
 */
export async function importSkill(
  env: Env,
  userId: string,
  input: NewSkill,
): Promise<{ skill: SkillRecord; created: boolean; previousVersion: number | null }> {
  const name = normalizeName(input.name);
  if (!name) throw new Error("name is required");
  if (!input.content.trim()) throw new Error("content is required");

  const now = Date.now();
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean).join(",");
  const contentHash = await sha256Hex(input.content);
  const description = input.description?.trim() ?? "";
  const tokens = indexTokens(name, description, input.content, tags);

  const existing = await getSkill(env, userId, name);

  if (!existing) {
    const record: SkillRecord = {
      id: newId("skl"),
      user_id: userId,
      name,
      description,
      content: input.content,
      content_hash: contentHash,
      version: 1,
      tags,
      tokens,
      status: input.status ?? "active",
      owner_agent_id: input.owner_agent_id ?? null,
      manifest: "[]",
      created_at: now,
      updated_at: now,
    };

    const insert = env.DB.prepare(
      `INSERT INTO skills (${COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
    ).bind(
      record.id,
      record.user_id,
      record.name,
      record.description,
      record.content,
      record.content_hash,
      record.version,
      record.tags,
      record.tokens,
      record.status,
      record.owner_agent_id,
      record.manifest,
      record.created_at,
      record.updated_at,
    );
    const fts = env.DB.prepare(
      `INSERT INTO skills_fts (skill_id, tokens) VALUES (?1, ?2)`,
    ).bind(record.id, tokens);

    await runWithFtsFallback(env, [insert, fts], [insert]);
    return { skill: record, created: true, previousVersion: null };
  }

  const contentChanged = existing.content_hash !== contentHash;
  const nextVersion = contentChanged ? existing.version + 1 : existing.version;
  const statements: D1PreparedStatement[] = [];

  if (contentChanged) {
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO skill_versions (id, skill_id, version, content, content_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(newId("skv"), existing.id, existing.version, existing.content, existing.content_hash, now),
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE skills SET description = ?1, content = ?2, content_hash = ?3, version = ?4,
         tags = ?5, tokens = ?6, status = ?7, owner_agent_id = ?8, updated_at = ?9
       WHERE id = ?10 AND user_id = ?11`,
    ).bind(
      description || existing.description,
      input.content,
      contentHash,
      nextVersion,
      tags || existing.tags,
      tokens,
      input.status ?? existing.status,
      input.owner_agent_id ?? existing.owner_agent_id,
      now,
      existing.id,
      userId,
    ),
    env.DB.prepare(`DELETE FROM skills_fts WHERE skill_id = ?1`).bind(existing.id),
    env.DB.prepare(`INSERT INTO skills_fts (skill_id, tokens) VALUES (?1, ?2)`).bind(existing.id, tokens),
  );

  await runWithFtsFallback(env, statements, statements.slice(0, 2));

  const updated = await getSkill(env, userId, existing.id);
  return { skill: updated ?? existing, created: false, previousVersion: existing.version };
}

/** Accepts either the id (`skl_…`) or the unique name. */
export async function getSkill(
  env: Env,
  userId: string,
  idOrName: string,
): Promise<SkillRecord | null> {
  const byId = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM skills WHERE user_id = ?1 AND id = ?2`,
  )
    .bind(userId, idOrName)
    .first<SkillRecord>();
  if (byId) return byId;

  const byName = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM skills WHERE user_id = ?1 AND name = ?2`,
  )
    .bind(userId, idOrName)
    .first<SkillRecord>();
  return byName ?? null;
}

export async function listSkills(
  env: Env,
  userId: string,
  options: ListSkillsOptions = {},
): Promise<SkillRecord[]> {
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const filters = ["s.user_id = ?1"];
  const bindings: unknown[] = [userId];

  if (options.status) {
    bindings.push(options.status);
    filters.push(`s.status = ?${bindings.length}`);
  }
  if (options.tag) {
    bindings.push(`%${options.tag}%`);
    filters.push(`s.tags LIKE ?${bindings.length}`);
  }
  if (options.agentId) {
    bindings.push(options.agentId);
    filters.push(
      `EXISTS (SELECT 1 FROM skill_allocations a WHERE a.skill_id = s.id AND a.agent_id = ?${bindings.length})`,
    );
  }

  bindings.push(limit, offset);
  const sql = `SELECT ${COLUMNS.replace(/\b(\w+)\b/g, "s.$1")} FROM skills s
    WHERE ${filters.join(" AND ")}
    ORDER BY s.updated_at DESC
    LIMIT ?${bindings.length - 1} OFFSET ?${bindings.length}`;

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<SkillRecord>();
  return results ?? [];
}

export async function updateSkill(
  env: Env,
  userId: string,
  idOrName: string,
  patch: {
    description?: string;
    tags?: string[];
    status?: SkillStatus;
    owner_agent_id?: string | null;
  },
): Promise<SkillRecord | null> {
  const existing = await getSkill(env, userId, idOrName);
  if (!existing) return null;

  const description = patch.description ?? existing.description;
  const tags = patch.tags ? patch.tags.join(",") : existing.tags;
  const tokens = indexTokens(existing.name, description, existing.content, tags);

  await runWithFtsFallback(
    env,
    [
      env.DB.prepare(
        `UPDATE skills SET description = ?1, tags = ?2, tokens = ?3, status = ?4,
           owner_agent_id = ?5, updated_at = ?6 WHERE id = ?7 AND user_id = ?8`,
      ).bind(
        description,
        tags,
        tokens,
        patch.status ?? existing.status,
        patch.owner_agent_id === undefined ? existing.owner_agent_id : patch.owner_agent_id,
        Date.now(),
        existing.id,
        userId,
      ),
      env.DB.prepare(`DELETE FROM skills_fts WHERE skill_id = ?1`).bind(existing.id),
      env.DB.prepare(`INSERT INTO skills_fts (skill_id, tokens) VALUES (?1, ?2)`).bind(existing.id, tokens),
    ],
    [
      env.DB.prepare(
        `UPDATE skills SET description = ?1, tags = ?2, tokens = ?3, status = ?4,
           owner_agent_id = ?5, updated_at = ?6 WHERE id = ?7 AND user_id = ?8`,
      ).bind(
        description,
        tags,
        tokens,
        patch.status ?? existing.status,
        patch.owner_agent_id === undefined ? existing.owner_agent_id : patch.owner_agent_id,
        Date.now(),
        existing.id,
        userId,
      ),
    ],
  );

  return getSkill(env, userId, existing.id);
}

export async function deleteSkill(env: Env, userId: string, idOrName: string): Promise<boolean> {
  const existing = await getSkill(env, userId, idOrName);
  if (!existing) return false;

  const statements = [
    env.DB.prepare(`DELETE FROM skills WHERE id = ?1 AND user_id = ?2`).bind(existing.id, userId),
    env.DB.prepare(`DELETE FROM skill_versions WHERE skill_id = ?1`).bind(existing.id),
    env.DB.prepare(`DELETE FROM skill_allocations WHERE skill_id = ?1 AND user_id = ?2`).bind(
      existing.id,
      userId,
    ),
    env.DB.prepare(`DELETE FROM skills_fts WHERE skill_id = ?1`).bind(existing.id),
  ];

  await runWithFtsFallback(env, statements, statements.slice(0, 3));
  await deleteAllFiles(env, userId, existing.id);
  return true;
}

/** Keyword channel over name + description + body. Mirrors memory recall's FTS path. */
export async function searchSkills(
  env: Env,
  userId: string,
  query: string,
  limit = 20,
): Promise<SkillRecord[]> {
  const tokens = tokenize(query);
  const match = buildFtsQuery(tokens);
  if (!match) return [];

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS.replace(/\b(\w+)\b/g, "s.$1")}
       FROM skills_fts f
       JOIN skills s ON s.id = f.skill_id
       WHERE skills_fts MATCH ?1 AND s.user_id = ?2 AND s.status = 'active'
       ORDER BY bm25(skills_fts)
       LIMIT ?3`,
    )
      .bind(match, userId, clampLimit(limit, 20, 50))
      .all<SkillRecord>();
    return results ?? [];
  } catch (error) {
    if (!isFtsError(error)) throw error;
    const probe = tokens.slice(0, 3);
    if (probe.length === 0) return [];
    const where = probe.map((_, i) => `tokens LIKE ?${i + 3}`).join(" AND ");
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM skills
       WHERE user_id = ?1 AND status = 'active' AND ${where}
       ORDER BY updated_at DESC LIMIT ?2`,
    )
      .bind(userId, clampLimit(limit, 20, 50), ...probe.map((t) => `%${t}%`))
      .all<SkillRecord>();
    return results ?? [];
  }
}

// ── Versions ──────────────────────────────────────────────────────────────

export async function listVersions(env: Env, userId: string, idOrName: string) {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return null;

  const { results } = await env.DB.prepare(
    `SELECT version, content_hash, created_at FROM skill_versions
     WHERE skill_id = ?1 ORDER BY version DESC LIMIT 50`,
  )
    .bind(skill.id)
    .all<{ version: number; content_hash: string; created_at: number }>();

  return {
    skillId: skill.id,
    head: skill.version,
    versions: results ?? [],
  };
}

export async function getVersion(
  env: Env,
  userId: string,
  idOrName: string,
  version: number,
): Promise<{ version: number; content: string; content_hash: string } | null> {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return null;
  if (version === skill.version) {
    return { version: skill.version, content: skill.content, content_hash: skill.content_hash };
  }
  const row = await env.DB.prepare(
    `SELECT version, content, content_hash FROM skill_versions WHERE skill_id = ?1 AND version = ?2`,
  )
    .bind(skill.id, version)
    .first<{ version: number; content: string; content_hash: string }>();
  return row ?? null;
}

// ── Allocations ───────────────────────────────────────────────────────────

export async function allocateSkill(
  env: Env,
  userId: string,
  idOrName: string,
  agentId: string,
): Promise<SkillRecord | null> {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return null;

  await env.DB.prepare(
    `INSERT OR IGNORE INTO skill_allocations (user_id, skill_id, agent_id, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(userId, skill.id, agentId.slice(0, 64), Date.now())
    .run();

  return skill;
}

export async function unallocateSkill(
  env: Env,
  userId: string,
  idOrName: string,
  agentId: string,
): Promise<boolean> {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return false;

  const result = await env.DB.prepare(
    `DELETE FROM skill_allocations WHERE user_id = ?1 AND skill_id = ?2 AND agent_id = ?3`,
  )
    .bind(userId, skill.id, agentId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listAllocations(env: Env, userId: string, idOrName: string) {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return null;

  const { results } = await env.DB.prepare(
    `SELECT agent_id, created_at FROM skill_allocations
     WHERE user_id = ?1 AND skill_id = ?2 ORDER BY created_at ASC`,
  )
    .bind(userId, skill.id)
    .all<{ agent_id: string; created_at: number }>();

  return results ?? [];
}

// ── Resource files (R2) ───────────────────────────────────────────────────

export async function putSkillFile(
  env: Env,
  userId: string,
  idOrName: string,
  path: string,
  body: ArrayBuffer | string,
  contentType = "text/plain; charset=utf-8",
): Promise<{ skillId: string; path: string; size: number } | null> {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return null;
  const clean = safePath(path);
  if (!clean) throw new Error("invalid path");

  const payload = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  await env.SKILLS.put(fileKey(userId, skill.id, clean), payload, {
    httpMetadata: { contentType },
  });
  await refreshManifest(env, userId, skill);

  return { skillId: skill.id, path: clean, size: payload.byteLength };
}

export async function getSkillFile(
  env: Env,
  userId: string,
  idOrName: string,
  path: string,
): Promise<R2ObjectBody | null> {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return null;
  const clean = safePath(path);
  if (!clean) return null;
  return env.SKILLS.get(fileKey(userId, skill.id, clean));
}

export async function deleteSkillFile(
  env: Env,
  userId: string,
  idOrName: string,
  path: string,
): Promise<boolean> {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return false;
  const clean = safePath(path);
  if (!clean) return false;

  await env.SKILLS.delete(fileKey(userId, skill.id, clean));
  await refreshManifest(env, userId, skill);
  return true;
}

export async function listSkillFiles(
  env: Env,
  userId: string,
  idOrName: string,
): Promise<SkillFileEntry[] | null> {
  const skill = await getSkill(env, userId, idOrName);
  if (!skill) return null;

  const listed = await env.SKILLS.list({
    prefix: fileKey(userId, skill.id, ""),
    limit: 1000,
    // R2 omits httpMetadata from listings unless explicitly requested.
    include: ["httpMetadata"],
  });
  return listed.objects.map((object) => ({
    path: object.key.slice(fileKey(userId, skill.id, "").length),
    size: object.size,
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    updatedAt: object.uploaded.getTime(),
  }));
}

/** Rebuild `manifest` from R2 truth so the list endpoint stays cheap. */
async function refreshManifest(env: Env, userId: string, skill: SkillRecord): Promise<void> {
  const files = (await listSkillFiles(env, userId, skill.id)) ?? [];
  await env.DB.prepare(`UPDATE skills SET manifest = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(JSON.stringify(files), Date.now(), skill.id)
    .run();
}

async function deleteAllFiles(env: Env, userId: string, skillId: string): Promise<void> {
  const prefix = fileKey(userId, skillId, "");
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.SKILLS.list({ prefix, limit: 500, cursor });
    if (listed.objects.length > 0) {
      await env.SKILLS.delete(listed.objects.map((object) => object.key));
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────

export async function skillStats(env: Env, userId: string) {
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM skills WHERE user_id = ?1 AND status = 'active'`,
  )
    .bind(userId)
    .first<{ n: number }>();

  const allocated = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM skill_allocations WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();

  return { total: total?.n ?? 0, allocations: allocated?.n ?? 0 };
}

// ── Internals ─────────────────────────────────────────────────────────────

async function runWithFtsFallback(
  env: Env,
  statements: D1PreparedStatement[],
  withoutFts: D1PreparedStatement[],
): Promise<void> {
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (!isFtsError(error)) throw error;
    await env.DB.batch(withoutFts);
  }
}

function isFtsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|fts5|malformed|unable to use function MATCH/i.test(message);
}
