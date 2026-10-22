import type { Env } from "../types.js";

interface Bucket {
  minute: number;
  count: number;
}

/**
 * One Durable Object per user. Its only job today is a fixed-window rate limit
 * that is strongly consistent across edge locations — something KV/D1 cannot do
 * cheaply. Keeping it separate from the memory tables means the DO never holds
 * source-of-truth data, so losing it is harmless.
 */
export class UserMemoryDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/rate") {
      const limit = Number(this.env.RATE_LIMIT_PER_MINUTE ?? 120);
      const minute = Math.floor(Date.now() / 60_000);
      const bucket = (await this.state.storage.get<Bucket>("bucket")) ?? { minute, count: 0 };

      if (bucket.minute !== minute) {
        bucket.minute = minute;
        bucket.count = 0;
      }

      if (bucket.count >= limit) {
        return Response.json(
          { ok: false, remaining: 0, limit },
          { status: 429, headers: { "retry-after": "60" } },
        );
      }

      bucket.count += 1;
      await this.state.storage.put("bucket", bucket);
      return Response.json({ ok: true, remaining: limit - bucket.count, limit });
    }

    return new Response("not found", { status: 404 });
  }
}
