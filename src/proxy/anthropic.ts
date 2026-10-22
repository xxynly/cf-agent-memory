/**
 * Anthropic-compatible LLM proxy.
 *
 * Point a client at this Worker with `ANTHROPIC_BASE_URL=https://<worker>`:
 *
 *   client ──POST /v1/messages──▶ Worker ──▶ upstream (api.anthropic.com)
 *            Authorization: Bearer PROXY_TOKEN      x-api-key: <key>
 *
 * The Worker reads the last prose user turn, recalls matching long-term
 * memories and lists available skills, prepends them to that turn, then
 * forwards. Nothing else about the request is touched.
 *
 * Free-plan CPU is 10ms per request and a Claude Code body is easily 200KB+,
 * so the body-size gate is not an optimisation — without it, JSON.parse +
 * JSON.stringify on a long conversation can blow the budget and fail the
 * request. Above the gate we forward untouched: worst case is one turn without
 * memory, which is exactly the MCP-only behaviour.
 */

import type { Context } from "hono";
import type { Env } from "../types.js";
import { isProxyAuthorized, rateLimit, userIdFrom } from "../auth.js";
import { buildInjection, extractLastUserText, injectIntoBody, readInjectionConfig } from "./inject.js";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

/** Paths whose bodies we are willing to rewrite. */
const INJECTABLE_PATHS = new Set(["/v1/messages"]);

export interface ProxyOutcome {
  status: number;
  injected: boolean;
  reason: ProxyReason;
  upstreamMs: number;
}

export type ProxyReason =
  | "injected"
  | "no_content"
  | "body_too_large"
  | "not_injectable"
  | "injection_failed"
  | "passthrough";

function upstreamBase(env: Env): string {
  const configured = env.UPSTREAM_URL?.trim();
  if (!configured) return DEFAULT_UPSTREAM;
  return configured.replace(/\/+$/, "");
}

function maxBodyBytes(env: Env): number {
  const value = Number(env.MAX_PROXY_BODY_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BODY_BYTES;
}

/**
 * Forward the request upstream, injecting memory/skill context first when it is
 * safe to do so. Always streams the response back untouched.
 */
export async function handleProxy(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  if (!env.PROXY_TOKEN) {
    return c.json(
      {
        error: "proxy_not_configured",
        hint: "Set PROXY_TOKEN as a Worker secret to enable the LLM proxy.",
      },
      503,
    );
  }

  if (!isProxyAuthorized(c.req.raw, env)) {
    return c.json({ error: "unauthorized", hint: "Send Authorization: Bearer <PROXY_TOKEN>." }, 401);
  }

  const limited = await rateLimit(env, userIdFrom(c.req.raw));
  if (limited) return limited;

  const path = new URL(c.req.raw.url).pathname;
  const method = c.req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const raw = hasBody ? await c.req.arrayBuffer() : new ArrayBuffer(0);
  const size = raw.byteLength;

  let body: ArrayBuffer | string = raw;
  let injected = false;
  let reason: ProxyReason = "passthrough";

  if (INJECTABLE_PATHS.has(path)) {
    if (size > maxBodyBytes(env)) {
      reason = "body_too_large";
    } else {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        const query = extractLastUserText(parsed);

        if (!query.trim()) {
          reason = "no_content";
        } else {
          const block = await buildInjection(
            env,
            userIdFrom(c.req.raw),
            query,
            readInjectionConfig(env),
          );

          if (!block) {
            reason = "no_content";
          } else {
            body = JSON.stringify(injectIntoBody(parsed, block));
            injected = true;
            reason = "injected";
          }
        }
      } catch (error) {
        // Malformed body, or injection blew up. Forward the original bytes so a
        // broken injector can never take the request down with it.
        reason = "injection_failed";
        body = raw;
        console.error("proxy.injection_failed", error instanceof Error ? error.message : error);
      }
    }
  } else {
    reason = "not_injectable";
  }

  const started = Date.now();
  const upstream = await forwardUpstream(c.req.raw, env, path, body, hasBody);
  const upstreamMs = Date.now() - started;

  const headers = new Headers(upstream.headers);
  headers.set("x-cfam-injected", injected ? "1" : "0");
  headers.set("x-cfam-reason", reason);
  headers.set("x-cfam-upstream-ms", String(upstreamMs));

  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Copy the client request upstream, swapping the credentials for our own. */
async function forwardUpstream(
  request: Request,
  env: Env,
  path: string,
  body: ArrayBuffer | string,
  hasBody: boolean,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.delete("cf-worker");

  // The client authenticates to *us* with PROXY_TOKEN. The upstream key is
  // either the one the client presented, or the one stored on the Worker.
  const clientKey = headers.get("x-api-key");
  const upstreamKey = clientKey?.trim() || env.ANTHROPIC_API_KEY?.trim() || "";
  headers.delete("authorization");
  headers.delete("x-api-key");
  if (upstreamKey) headers.set("x-api-key", upstreamKey);

  const target = `${upstreamBase(env)}${path}`;
  return fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? body : undefined,
    // Manual: a redirect would silently consume subrequests and drop the stream.
    redirect: "manual",
  });
}
