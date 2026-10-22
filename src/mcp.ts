import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types.js";
import { recall } from "./memory/recall.js";
import {
  deleteMemory,
  getMemory,
  insertMemory,
  listMemories,
  stats,
  updateMemory,
} from "./memory/store.js";
import { deleteVector, embed, upsertVector } from "./memory/vector.js";
import {
  allocateSkill,
  deleteSkill,
  getSkill,
  getVersion,
  importSkill,
  listSkills,
  searchSkills,
} from "./skills/store.js";

const layer = z.enum(["l0", "l1", "l2", "l3"]);
const kind = z.enum(["fact", "event", "instruction", "task"]);

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * The MCP surface. Tools are deliberately few and opinionated: a model should
 * never have to think about storage strategy, only about what is worth keeping.
 */
export function buildMcpServer(env: Env, userId: string): McpServer {
  const server = new McpServer({ name: "cf-agent-memory", version: "0.3.1" });

  server.registerTool(
    "memory_remember",
    {
      title: "Remember",
      description:
        "Store a durable fact, preference, decision or how-to so it survives future sessions. " +
        "Call this when the user states a preference, corrects you, makes a decision, or shares context " +
        "that will still matter next week. Use `key` for facts that get updated over time " +
        "(e.g. key='db.version') — a newer memory with the same key supersedes the old one. " +
        "记住值得长期保留的事实、偏好、决策或做法。",
      inputSchema: {
        content: z.string().min(1).describe("Self-contained sentence, no pronouns that need context."),
        key: z.string().optional().describe("Stable topic key, e.g. 'project.database'."),
        kind: kind.optional(),
        layer: layer.optional().describe("l1 atom (default) / l2 scenario / l3 persona."),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(1).max(5).optional().describe("1=trivia, 5=critical."),
      },
    },
    async (args) => {
      const record = await insertMemory(env, userId, args);
      const vector = await embed(env, record.content).catch(() => null);
      const indexed = vector ? await upsertVector(env, userId, record, vector) : false;
      return text({
        ok: true,
        id: record.id,
        key: record.key,
        vectorIndexed: indexed,
        note: indexed ? undefined : "Stored, but semantic index is unavailable — keyword recall still works.",
      });
    },
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Recall",
      description:
        "Search long-term memory with hybrid retrieval (semantic + keyword + recency). " +
        "Call this before answering questions about the user, their projects, past decisions, " +
        "or whenever the user references something from an earlier session. " +
        "检索长期记忆（语义 + 关键词 + 时间加权）。",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().min(1).max(30).optional(),
      },
    },
    async ({ query, limit }) => {
      const result = await recall(env, userId, query, { limit });
      if (result.hits.length === 0) {
        return text({ hits: [], note: "No matching memories.", diagnostics: result.diagnostics });
      }
      return text({
        hits: result.hits.map((hit) => ({
          id: hit.memory.id,
          content: hit.memory.content,
          kind: hit.memory.kind,
          layer: hit.memory.layer,
          key: hit.memory.key,
          tags: hit.memory.tags ? hit.memory.tags.split(",") : [],
          score: Number(hit.score.toFixed(5)),
          via: hit.via,
          createdAt: new Date(hit.memory.created_at).toISOString(),
        })),
        diagnostics: result.diagnostics,
      });
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memories",
      description: "Browse stored memories newest-first. Useful for auditing or cleaning up.",
      inputSchema: {
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
        layer: layer.optional(),
        kind: kind.optional(),
        tag: z.string().optional(),
      },
    },
    async (args) => {
      const rows = await listMemories(env, userId, args);
      return text(
        rows.map((row) => ({
          id: row.id,
          content: row.content,
          kind: row.kind,
          layer: row.layer,
          key: row.key,
          tags: row.tags ? row.tags.split(",") : [],
          importance: row.importance,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      );
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update memory",
      description: "Correct an existing memory in place. Prefer this over storing a duplicate.",
      inputSchema: {
        id: z.string(),
        content: z.string().optional(),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(1).max(5).optional(),
      },
    },
    async ({ id, ...patch }) => {
      const updated = await updateMemory(env, userId, id, patch);
      if (!updated) return fail(`Memory ${id} not found.`);

      const vector = await embed(env, updated.content).catch(() => null);
      if (vector) await upsertVector(env, userId, updated, vector);
      return text({ ok: true, id: updated.id, content: updated.content });
    },
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Forget",
      description:
        "Delete a memory that is wrong or no longer relevant. Use when the user asks to forget something.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const existing = await getMemory(env, userId, id);
      if (!existing) return fail(`Memory ${id} not found.`);
      await deleteMemory(env, userId, id);
      await deleteVector(env, id);
      return text({ ok: true, id });
    },
  );

  server.registerTool(
    "memory_stats",
    {
      title: "Memory stats",
      description: "Counts by layer and kind — useful to check whether memory is filling up.",
      inputSchema: {},
    },
    async () => text(await stats(env, userId)),
  );

  // ── Skills ──────────────────────────────────────────────────────────────
  // A skill is a reusable SKILL.md (plus optional files in R2). These tools
  // let an agent publish what it just worked out, and pull it back later by
  // name instead of re-deriving it.

  server.registerTool(
    "skill_import",
    {
      title: "Import skill",
      description:
        "Publish a reusable skill as SKILL.md content so future sessions can load it instead of re-deriving it. " +
        "Use this after working out a repeatable procedure (a deploy runbook, a debugging recipe, a project convention). " +
        "Importing an existing name bumps its version and keeps the old one for rollback. " +
        "导入技能（同名再次导入会生成新版本，旧版本保留）。",
      inputSchema: {
        name: z.string().min(1).max(120).describe("Kebab-case skill name, e.g. 'cf-deploy-runbook'."),
        content: z
          .string()
          .min(1)
          .describe("Full SKILL.md body: what it does, when to use it, and the concrete steps."),
        description: z.string().optional().describe("One-line summary shown in lists."),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const result = await importSkill(env, userId, args);
      return text({
        ok: true,
        name: result.skill.name,
        version: result.skill.version,
        created: result.created,
        previousVersion: result.previousVersion ?? undefined,
        note: result.created ? undefined : "Existing skill updated — previous head kept as a version.",
      });
    },
  );

  server.registerTool(
    "skill_list",
    {
      title: "List skills",
      description:
        "Browse the skill library newest-first. Call this at the start of a task to see whether a relevant " +
        "procedure already exists before writing one from scratch.",
      inputSchema: {
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
        tag: z.string().optional(),
        agent_id: z.string().optional().describe("Only skills allocated to this agent."),
      },
    },
    async (args) => {
      const rows = await listSkills(env, userId, {
        limit: args.limit,
        offset: args.offset,
        tag: args.tag,
        agentId: args.agent_id,
      });
      return text(
        rows.map((row) => ({
          name: row.name,
          description: row.description,
          version: row.version,
          tags: row.tags ? row.tags.split(",") : [],
          files: JSON.parse(row.manifest || "[]").length,
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
      );
    },
  );

  server.registerTool(
    "skill_get",
    {
      title: "Get skill",
      description:
        "Load a skill's full SKILL.md by name (or id), optionally a specific version. " +
        "Call this before following a procedure so you follow the current version.",
      inputSchema: {
        name: z.string(),
        version: z.number().optional().describe("Omit for the current head version."),
      },
    },
    async ({ name, version }) => {
      if (version !== undefined) {
        const pinned = await getVersion(env, userId, name, version);
        if (!pinned) return fail(`Skill ${name} v${version} not found.`);
        return text({ name, version: pinned.version, content: pinned.content });
      }

      const skill = await getSkill(env, userId, name);
      if (!skill) return fail(`Skill ${name} not found. Try skill_list.`);
      return text({
        name: skill.name,
        description: skill.description,
        version: skill.version,
        tags: skill.tags ? skill.tags.split(",") : [],
        files: JSON.parse(skill.manifest || "[]"),
        content: skill.content,
      });
    },
  );

  server.registerTool(
    "skill_search",
    {
      title: "Search skills",
      description: "Keyword search over skill names, descriptions and bodies. Cheaper than listing everything.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      const rows = await searchSkills(env, userId, query, limit);
      return text(
        rows.map((row) => ({
          name: row.name,
          description: row.description,
          version: row.version,
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
      );
    },
  );

  server.registerTool(
    "skill_allocate",
    {
      title: "Allocate skill",
      description:
        "Grant an agent access to a skill. Personal edition: `agent_id` is a free-form label " +
        "(e.g. 'claude-code', 'codebuddy'), used to filter skill_list.",
      inputSchema: {
        name: z.string(),
        agent_id: z.string().min(1),
      },
    },
    async ({ name, agent_id }) => {
      const skill = await allocateSkill(env, userId, name, agent_id);
      if (!skill) return fail(`Skill ${name} not found.`);
      return text({ ok: true, name: skill.name, agent_id });
    },
  );

  server.registerTool(
    "skill_delete",
    {
      title: "Delete skill",
      description: "Remove a skill and its resource files. Use when it is obsolete or wrong.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const deleted = await deleteSkill(env, userId, name);
      if (!deleted) return fail(`Skill ${name} not found.`);
      return text({ ok: true, name });
    },
  );

  return server;
}
