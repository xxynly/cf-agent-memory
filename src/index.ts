import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { isAuthorized, rateLimit, userIdFrom } from "./auth.js";
import { UserMemoryDO } from "./do/user-memory.js";
import { buildMcpServer } from "./mcp.js";
import { ingest, MAX_INGEST_ITEMS } from "./memory/ingest.js";
import { handleProxy } from "./proxy/anthropic.js";
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
  deleteSkillFile,
  getSkill,
  getSkillFile,
  getVersion,
  importSkill,
  listAllocations,
  listSkillFiles,
  listSkills,
  listVersions,
  putSkillFile,
  searchSkills,
  skillStats,
  unallocateSkill,
  updateSkill,
} from "./skills/store.js";
import type { Env, SkillRecord } from "./types.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-user-id"] }));

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "cf-agent-memory",
    version: "0.3.1",
    time: new Date().toISOString(),
  }),
);

const guard = async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (!isAuthorized(c.req.raw, c.env)) {
    return c.json({ error: "unauthorized", hint: "Send Authorization: Bearer <ADMIN_TOKEN>." }, 401);
  }
  await next();
};

// ── LLM proxy ─────────────────────────────────────────────────────────────
// Registered *before* the /v1/* guard: the proxy authenticates with its own
// PROXY_TOKEN and spends real LLM quota, so it must not share the admin token.
// Clients point ANTHROPIC_BASE_URL at this Worker.
app.all("/v1/messages", handleProxy);
app.all("/v1/messages/count_tokens", handleProxy);
app.all("/v1/models", handleProxy);

app.use("/v1/*", guard);
app.use("/mcp", guard);

const memoryInput = z.object({
  content: z.string().min(1).max(8_000),
  key: z.string().max(200).optional().nullable(),
  layer: z.enum(["l0", "l1", "l2", "l3"]).optional(),
  kind: z.enum(["fact", "event", "instruction", "task"]).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  scope: z.string().max(64).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  source: z.string().max(200).optional().nullable(),
});

app.post("/v1/memories", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const parsed = memoryInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.issues }, 400);
  }

  const record = await insertMemory(c.env, userIdFrom(c.req.raw), parsed.data);
  const vector = await embed(c.env, record.content).catch(() => null);
  const indexed = vector ? await upsertVector(c.env, userIdFrom(c.req.raw), record, vector) : false;

  return c.json({ ok: true, memory: record, vectorIndexed: indexed }, 201);
});

app.get("/v1/memories", async (c) => {
  const rows = await listMemories(c.env, userIdFrom(c.req.raw), {
    limit: Number(c.req.query("limit") ?? 20),
    offset: Number(c.req.query("offset") ?? 0),
    layer: c.req.query("layer") ?? undefined,
    kind: c.req.query("kind") ?? undefined,
    tag: c.req.query("tag") ?? undefined,
    includeSuperseded: c.req.query("includeSuperseded") === "1",
  });
  return c.json({ ok: true, count: rows.length, memories: rows });
});

app.get("/v1/memories/:id", async (c) => {
  const record = await getMemory(c.env, userIdFrom(c.req.raw), c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, memory: record });
});

app.patch("/v1/memories/:id", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const patch = z
    .object({
      content: z.string().min(1).max(8_000).optional(),
      tags: z.array(z.string().max(64)).max(20).optional(),
      importance: z.number().int().min(1).max(5).optional(),
      key: z.string().max(200).nullable().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!patch.success) return c.json({ error: "invalid_body", details: patch.error.issues }, 400);

  const updated = await updateMemory(c.env, userIdFrom(c.req.raw), c.req.param("id"), patch.data);
  if (!updated) return c.json({ error: "not_found" }, 404);

  const vector = await embed(c.env, updated.content).catch(() => null);
  if (vector) await upsertVector(c.env, userIdFrom(c.req.raw), updated, vector);

  return c.json({ ok: true, memory: updated });
});

app.delete("/v1/memories/:id", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const deleted = await deleteMemory(c.env, userIdFrom(c.req.raw), c.req.param("id"));
  if (!deleted) return c.json({ error: "not_found" }, 404);
  await deleteVector(c.env, c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/v1/recall", async (c) => {
  const parsed = z
    .object({
      query: z.string().min(1).max(2_000),
      limit: z.number().int().min(1).max(30).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.issues }, 400);

  const result = await recall(c.env, userIdFrom(c.req.raw), parsed.data.query, {
    limit: parsed.data.limit,
  });
  return c.json({ ok: true, ...result });
});

app.post("/v1/ingest", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const parsed = z
    .object({
      source: z.string().max(200).optional(),
      items: z.array(memoryInput.omit({ source: true })).min(1).max(MAX_INGEST_ITEMS),
    })
    .safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json(
      { error: "invalid_body", details: parsed.error.issues, maxItems: MAX_INGEST_ITEMS },
      400,
    );
  }

  const result = await ingest(c.env, userIdFrom(c.req.raw), parsed.data.items, parsed.data.source);
  return c.json({ ok: true, ...result }, 201);
});

app.get("/v1/stats", async (c) => {
  const userId = userIdFrom(c.req.raw);
  const [memories, skills] = await Promise.all([stats(c.env, userId), skillStats(c.env, userId)]);
  return c.json({ ok: true, stats: { ...memories, skills } });
});

// ── Skills ────────────────────────────────────────────────────────────────
// Specific paths must be registered before `/:name` or Hono matches the
// parameterised route first.

const skillInput = z.object({
  name: z.string().min(1).max(120),
  content: z.string().min(1).max(200_000),
  description: z.string().max(2_000).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  owner_agent_id: z.string().max(64).optional().nullable(),
  status: z.enum(["active", "archived"]).optional(),
});

app.get("/v1/skills", async (c) => {
  const userId = userIdFrom(c.req.raw);
  const query = c.req.query("q")?.trim();

  if (query) {
    const rows = await searchSkills(c.env, userId, query, Number(c.req.query("limit") ?? 20));
    return c.json({ ok: true, count: rows.length, skills: rows.map(summarizeSkill) });
  }

  const rows = await listSkills(c.env, userId, {
    limit: Number(c.req.query("limit") ?? 20),
    offset: Number(c.req.query("offset") ?? 0),
    tag: c.req.query("tag") ?? undefined,
    status: (c.req.query("status") as "active" | "archived" | undefined) ?? undefined,
    agentId: c.req.query("agent") ?? undefined,
  });
  return c.json({ ok: true, count: rows.length, skills: rows.map(summarizeSkill) });
});

app.post("/v1/skills", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const parsed = skillInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.issues }, 400);

  const userId = userIdFrom(c.req.raw);
  const result = await importSkill(c.env, userId, parsed.data);
  return c.json({ ok: true, ...result, skill: summarizeSkill(result.skill) }, result.created ? 201 : 200);
});

app.get("/v1/skills/:name/files", async (c) => {
  const files = await listSkillFiles(c.env, userIdFrom(c.req.raw), c.req.param("name"));
  if (!files) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, count: files.length, files });
});

app.put("/v1/skills/:name/files/:path{.+}", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const body = await c.req.arrayBuffer();
  if (body.byteLength > 2_000_000) return c.json({ error: "file_too_large", maxBytes: 2_000_000 }, 413);

  const written = await putSkillFile(
    c.env,
    userIdFrom(c.req.raw),
    c.req.param("name"),
    c.req.param("path"),
    body,
    c.req.header("content-type") ?? "text/plain; charset=utf-8",
  );
  if (!written) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, ...written }, 201);
});

app.get("/v1/skills/:name/files/:path{.+}", async (c) => {
  const object = await getSkillFile(
    c.env,
    userIdFrom(c.req.raw),
    c.req.param("name"),
    c.req.param("path"),
  );
  if (!object) return c.json({ error: "not_found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: object.httpEtag,
    },
  });
});

app.delete("/v1/skills/:name/files/:path{.+}", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const deleted = await deleteSkillFile(
    c.env,
    userIdFrom(c.req.raw),
    c.req.param("name"),
    c.req.param("path"),
  );
  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

app.get("/v1/skills/:name/versions", async (c) => {
  const result = await listVersions(c.env, userIdFrom(c.req.raw), c.req.param("name"));
  if (!result) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, ...result });
});

app.get("/v1/skills/:name/versions/:version", async (c) => {
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version)) return c.json({ error: "invalid_version" }, 400);

  const result = await getVersion(c.env, userIdFrom(c.req.raw), c.req.param("name"), version);
  if (!result) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, ...result });
});

app.post("/v1/skills/:name/allocate", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const parsed = z
    .object({ agent_id: z.string().min(1).max(64) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.issues }, 400);

  const skill = await allocateSkill(
    c.env,
    userIdFrom(c.req.raw),
    c.req.param("name"),
    parsed.data.agent_id,
  );
  if (!skill) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, skill: summarizeSkill(skill), agent_id: parsed.data.agent_id });
});

app.delete("/v1/skills/:name/allocate/:agentId", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const removed = await unallocateSkill(
    c.env,
    userIdFrom(c.req.raw),
    c.req.param("name"),
    c.req.param("agentId"),
  );
  if (!removed) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

app.get("/v1/skills/:name", async (c) => {
  const skill = await getSkill(c.env, userIdFrom(c.req.raw), c.req.param("name"));
  if (!skill) return c.json({ error: "not_found" }, 404);
  const allocations = await listAllocations(c.env, userIdFrom(c.req.raw), skill.id);
  return c.json({ ok: true, skill: { ...skill, manifest: JSON.parse(skill.manifest || "[]") }, allocations });
});

app.patch("/v1/skills/:name", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const patch = z
    .object({
      description: z.string().max(2_000).optional(),
      tags: z.array(z.string().max(64)).max(20).optional(),
      status: z.enum(["active", "archived"]).optional(),
      owner_agent_id: z.string().max(64).nullable().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!patch.success) return c.json({ error: "invalid_body", details: patch.error.issues }, 400);

  const updated = await updateSkill(c.env, userIdFrom(c.req.raw), c.req.param("name"), patch.data);
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, skill: summarizeSkill(updated) });
});

app.delete("/v1/skills/:name", async (c) => {
  const limited = await rateLimit(c.env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const deleted = await deleteSkill(c.env, userIdFrom(c.req.raw), c.req.param("name"));
  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/** List responses drop the full SKILL.md body — callers fetch it by name. */
function summarizeSkill(skill: SkillRecord) {
  const { content, tokens, ...rest } = skill;
  return {
    ...rest,
    manifest: JSON.parse(skill.manifest || "[]"),
    contentChars: content.length,
    excerpt: content.slice(0, 200),
  };
}

/** Stateless MCP over Streamable HTTP — no session state, every call is independent. */
app.all("/mcp", async (c) => {
  const server = buildMcpServer(c.env, userIdFrom(c.req.raw));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  console.error("unhandled", error);
  return c.json({ error: "internal_error", message: error.message }, 500);
});

export { UserMemoryDO };
export default app;
