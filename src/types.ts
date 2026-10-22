/** Cloudflare bindings and shared domain types. */

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  USER_MEMORY: DurableObjectNamespace;
  ASSETS: Fetcher;

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
