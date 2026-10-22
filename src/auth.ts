import type { Env } from "./types.js";

/** Bearer token from the Authorization header, or `?token=` for quick curl tests. */
export function readToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return new URL(request.url).searchParams.get("token");
}

/** Length-independent comparison; avoids leaking the token length via timing. */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const token = readToken(request);
  return token !== null && safeEqual(token, env.ADMIN_TOKEN);
}

export function userIdFrom(request: Request): string {
  const header = request.headers.get("x-user-id")?.trim();
  if (header) return header.slice(0, 64);
  return new URL(request.url).searchParams.get("user")?.slice(0, 64) || "personal";
}

/**
 * Proxy auth. Deliberately separate from ADMIN_TOKEN: the proxy spends real LLM
 * quota, and the client's own `x-api-key` must never be accepted as proof of
 * authorization for our route.
 */
export function isProxyAuthorized(request: Request, env: Env): boolean {
  if (!env.PROXY_TOKEN) return false;
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return false;
  const token = header.slice(7).trim();
  return token.length > 0 && safeEqual(token, env.PROXY_TOKEN);
}

/** Fixed-window rate limit through the per-user Durable Object. Fails open. */
export async function rateLimit(env: Env, userId: string): Promise<Response | null> {
  try {
    const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
    const response = await stub.fetch("https://user-memory.internal/rate", { method: "POST" });
    if (response.status === 429) {
      const body = await response.json<{ limit: number }>();
      return Response.json(
        { error: "rate_limited", limit: body.limit, hint: "Retry in a minute or raise RATE_LIMIT_PER_MINUTE." },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    return null;
  } catch {
    return null;
  }
}
