-- cf-agent-memory · D1 schema
-- Apply with: wrangler d1 execute cf-agent-memory --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  layer         TEXT NOT NULL DEFAULT 'l1',
  kind          TEXT NOT NULL DEFAULT 'fact',
  key           TEXT,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '',
  tokens        TEXT NOT NULL DEFAULT '',
  scope         TEXT NOT NULL DEFAULT 'personal',
  importance    INTEGER NOT NULL DEFAULT 3,
  source        TEXT,
  superseded_by TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  accessed_at   INTEGER,
  access_count  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_user_created
  ON memories (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_user_layer
  ON memories (user_id, layer, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_user_key
  ON memories (user_id, key);

-- Standalone FTS5 table (no external-content triggers: we sync it explicitly,
-- which keeps UPDATE/DELETE semantics obvious and avoids rowid drift).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  tokens
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  source     TEXT,
  count      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_user_created
  ON ingest_log (user_id, created_at DESC);
