import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AuthMethods, Session } from "@margin/shared";
import { GITHUB, OPEN_ACCESS, PASSWORD, PUBLIC_URL, SECRET, SECURE_COOKIES } from "./config.ts";
import { verifyToken } from "./tokens.ts";

export type AppEnv = { Variables: { session: Session } };

const COOKIE = "margin_session";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

function passwordMatches(given: string) {
  if (OPEN_ACCESS) return true;
  if (!PASSWORD) return false;
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

/** An agent's display name from the x-margin-agent header ("Claude Code", "Codex"...). */
function agentName(raw: string | undefined) {
  const name = (raw ?? "").replace(/[^\w .()-]/g, "").trim().slice(0, 40);
  return name || "Agent";
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Agents and scripts authenticate with a personal access token instead of the cookie.
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(mgn_\S+)$/)?.[1];
  if (bearer) {
    const member = await verifyToken(bearer);
    if (!member) return c.json({ error: "Invalid access token" }, 401);
    c.set("session", { name: member, agent: agentName(c.req.header("x-margin-agent")) });
    return next();
  }
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("session", session);
  await next();
};

const methods: AuthMethods = { password: !!PASSWORD, github: !!GITHUB, open: OPEN_ACCESS };

async function startSession(c: Context, session: Session) {
  await setSignedCookie(c, COOKIE, JSON.stringify(session), SECRET, {
    httpOnly: true, sameSite: "Lax", secure: SECURE_COOKIES, path: "/", maxAge: THIRTY_DAYS,
  });
}

const origin = (c: Context) => PUBLIC_URL ?? `${c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")}://${c.req.header("x-forwarded-host") ?? c.req.header("host")}`;
const fail = (c: Context, message: string) => c.redirect(`/?auth_error=${encodeURIComponent(message)}`);

export const authRoutes = new Hono<AppEnv>()
  .get("/session", async (c) => {
    return c.json({ session: await readSession(c), passwordRequired: !!PASSWORD, methods });
  })

  // ── GitHub OAuth ───────────────────────────────────────────────────────
  .get("/auth/github", async (c) => {
    if (!GITHUB) return c.json({ error: "GitHub login is not configured" }, 404);
    const state = randomBytes(16).toString("hex");
    await setSignedCookie(c, "margin_oauth", state, SECRET, { httpOnly: true, sameSite: "Lax", secure: SECURE_COOKIES, path: "/api/auth", maxAge: 600 });
    const q = new URLSearchParams({ client_id: GITHUB.clientId, redirect_uri: `${origin(c)}/api/auth/github/callback`, state, scope: "read:user", allow_signup: "false" });
    return c.redirect(`${GITHUB.oauthUrl}/login/oauth/authorize?${q}`);
  })
  .get("/auth/github/callback", async (c) => {
    if (!GITHUB) return fail(c, "GitHub login is not configured");
    const { code, state, error } = c.req.query();
    const expected = await getSignedCookie(c, SECRET, "margin_oauth");
    deleteCookie(c, "margin_oauth", { path: "/api/auth" });
    if (error) return fail(c, "GitHub sign-in was cancelled");
    if (!code || !state || !expected || state !== expected) return fail(c, "Sign-in expired, please try again");

    const tokenRes = await fetch(`${GITHUB.oauthUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: GITHUB.clientId, client_secret: GITHUB.clientSecret, code, redirect_uri: `${origin(c)}/api/auth/github/callback` }),
    }).then((r) => r.json() as Promise<{ access_token?: string }>).catch(() => null);
    if (!tokenRes?.access_token) return fail(c, "GitHub didn't accept the sign-in");

    const user = await fetch(`${GITHUB.apiUrl}/user`, {
      headers: { authorization: `Bearer ${tokenRes.access_token}`, accept: "application/vnd.github+json", "user-agent": "margin" },
    }).then((r) => (r.ok ? r.json() as Promise<{ login: string; name?: string | null; avatar_url?: string }> : null)).catch(() => null);
    if (!user?.login) return fail(c, "Couldn't read your GitHub profile");

    const login = user.login.toLowerCase();
    if (!GITHUB.allow.includes("*") && !GITHUB.allow.includes(login)) {
      return fail(c, `@${user.login} isn't on this workspace's access list. Ask the owner to add you.`);
    }
    await startSession(c, { name: (user.name?.trim() || user.login).slice(0, 40), github: user.login, avatar: user.avatar_url });
    return c.redirect("/");
  })
  .post("/login", async (c) => {
    const { name, password } = await c.req.json<{ name?: string; password?: string }>();
    const display = (name ?? "").trim().slice(0, 40);
    if (!PASSWORD && !OPEN_ACCESS) return c.json({ error: "Sign in with GitHub" }, 400);
    if (!display) return c.json({ error: "Tell us your name" }, 400);
    if (!passwordMatches(password ?? "")) {
      await new Promise((r) => setTimeout(r, 500)); // slow down guessing
      return c.json({ error: "Wrong password" }, 401);
    }
    const session: Session = { name: display };
    await startSession(c, session);
    return c.json({ session });
  })
  .post("/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
