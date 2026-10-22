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

-- ── Skills ────────────────────────────────────────────────────────────────
-- One row per skill holding the *head* version (the current SKILL.md).
-- Older versions live in skill_versions so an agent can pin a known-good one.
-- Resource files (scripts/, references/, …) live in R2 under
-- `<user_id>/skills/<skill_id>/<path>`; `manifest` caches their listing so the
-- list endpoint does not need an R2 round-trip per row.

CREATE TABLE IF NOT EXISTS skills (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  tags           TEXT NOT NULL DEFAULT '',
  tokens         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active',
  owner_agent_id TEXT,
  manifest       TEXT NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_name
  ON skills (user_id, name);

CREATE INDEX IF NOT EXISTS idx_skills_user_updated
  ON skills (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS skill_versions (
  id           TEXT PRIMARY KEY,
  skill_id     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_skill_version
  ON skill_versions (skill_id, version);

-- Which agent may use which skill. Personal edition: an agent id is just a
-- label, there is no agent registry to validate against.
CREATE TABLE IF NOT EXISTS skill_allocations (
  user_id    TEXT NOT NULL,
  skill_id   TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, skill_id, agent_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id UNINDEXED,
  tokens
);
