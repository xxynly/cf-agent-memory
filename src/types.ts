/** Cloudflare bindings and shared domain types. */

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  USER_MEMORY: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Resource files for skills (scripts, references, templates). */
  SKILLS: R2Bucket;

  /** Bearer token required by every /v1 and /mcp request. Set with `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN: string;
  EMBEDDING_MODEL?: string;
  VECTOR_DIMENSIONS?: string;
  RATE_LIMIT_PER_MINUTE?: string;
}

export type MemoryLayer = "l0" | "l1" | "l2" | "l3";
export type MemoryKind = "fact" | "event" | "instruction" | "task";

export interface MemoryRecord {
  id: string;
  user_id: string;
  layer: MemoryLayer;
  kind: MemoryKind;
  /** Stable topic key. A new memory with the same key supersedes the old one. */
  key: string | null;
  content: string;
  tags: string;
  tokens: string;
  scope: string;
  importance: number;
  source: string | null;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
  accessed_at: number | null;
  access_count: number;
}

export interface NewMemory {
  content: string;
  key?: string | null;
  layer?: MemoryLayer;
  kind?: MemoryKind;
  tags?: string[];
  scope?: string;
  importance?: number;
  source?: string | null;
}

export interface RecallHit {
  memory: MemoryRecord;
  score: number;
  via: string[];
}

export interface RecallResult {
  hits: RecallHit[];
  diagnostics: {
    vector: number;
    keyword: number;
    fused: number;
    degraded: string[];
  };
}

/** A resource file that ships with a skill. Bytes live in R2, this is the index. */
export interface SkillFileEntry {
  path: string;
  size: number;
  contentType: string;
  updatedAt: number;
}

export interface SkillRecord {
  id: string;
  user_id: string;
  name: string;
  description: string;
  /** Full SKILL.md body. */
  content: string;
  content_hash: string;
  /** Current head version, starting at 1. */
  version: number;
  tags: string;
  tokens: string;
  status: SkillStatus;
  /** Agent that owns the skill. Personal edition: a free-form label. */
  owner_agent_id: string | null;
  /** JSON-encoded SkillFileEntry[]. */
  manifest: string;
  created_at: number;
  updated_at: number;
}

export type SkillStatus = "active" | "archived";

export interface NewSkill {
  name: string;
  content: string;
  description?: string;
  tags?: string[];
  owner_agent_id?: string | null;
  status?: SkillStatus;
}
