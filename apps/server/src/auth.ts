import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Session } from "@margin/shared";
import { PASSWORD, SECRET, SECURE_COOKIES } from "./config.ts";

export type AppEnv = { Variables: { session: Session } };

const COOKIE = "margin_session";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

function passwordMatches(given: string) {
  if (!PASSWORD) return true;
  const a = Buffer.from(given), b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readSession(c: Parameters<MiddlewareHandler>[0]): Promise<Session | null> {
  const raw = await getSignedCookie(c, SECRET, COOKIE);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return typeof s.name === "string" && s.name ? s : null;
  } catch {
    return null;
  }
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("session", session);
  await next();
};

export const authRoutes = new Hono<AppEnv>()
  .get("/session", async (c) => {
    return c.json({ session: await readSession(c), passwordRequired: !!PASSWORD });
  })
  .post("/login", async (c) => {
    const { name, password } = await c.req.json<{ name?: string; password?: string }>();
    const display = (name ?? "").trim().slice(0, 40);
    if (!display) return c.json({ error: "Tell us your name" }, 400);
    if (!passwordMatches(password ?? "")) {
      await new Promise((r) => setTimeout(r, 500)); // slow down guessing
      return c.json({ error: "Wrong password" }, 401);
    }
    const session: Session = { name: display };
    await setSignedCookie(c, COOKIE, JSON.stringify(session), SECRET, {
      httpOnly: true, sameSite: "Lax", secure: SECURE_COOKIES, path: "/", maxAge: THIRTY_DAYS,
    });
    return c.json({ session });
  })
  .post("/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
