import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { isAuthorized, rateLimit, userIdFrom } from "./auth.js";
import { UserMemoryDO } from "./do/user-memory.js";
import { buildMcpServer } from "./mcp.js";
import { ingest, MAX_INGEST_ITEMS } from "./memory/ingest.js";
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
import type { Env } from "./types.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-user-id"] }));

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "cf-agent-memory",
    version: "0.1.0",
    time: new Date().toISOString(),
  }),
);

const guard = async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (!isAuthorized(c.req.raw, c.env)) {
    return c.json({ error: "unauthorized", hint: "Send Authorization: Bearer <ADMIN_TOKEN>." }, 401);
  }
  await next();
};

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
  return c.json({ ok: true, stats: await stats(c.env, userIdFrom(c.req.raw)) });
});

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
