import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth.ts";
import { memberId } from "./access.ts";

/**
 * Per-member limits on expensive actions (compiles, imports, AI). In memory,
 * per server process. Limits are generous for real use; set
 * MARGIN_RATE_LIMITS=off to disable.
 */

const hits = new Map<string, number[]>();
const OFF = process.env.MARGIN_RATE_LIMITS === "off";

export function allow(key: string, max: number, windowSec: number): number {
  if (OFF) return 0;
  const now = Date.now();
  const since = now - windowSec * 1000;
  const list = (hits.get(key) ?? []).filter((t) => t > since);
  if (list.length >= max) {
    hits.set(key, list);
    return Math.ceil((list[0] + windowSec * 1000 - now) / 1000);
  }
  list.push(now);
  hits.set(key, list);
  return 0;
}

export const limit = (name: string, max: number, windowSec: number): MiddlewareHandler<AppEnv> => async (c, next) => {
  const wait = allow(`${name}:${memberId(c.get("session"))}`, max, windowSec);
  if (wait) {
    c.header("retry-after", String(wait));
    return c.json({ error: `Too many requests. Try again in ${wait < 90 ? `${wait}s` : `${Math.ceil(wait / 60)} min`}.` }, 429);
  }
  await next();
};

// Forget idle members now and then.
setInterval(() => {
  const cutoff = Date.now() - 3600_000 * 2;
  for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
}, 600_000).unref();
