import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const isProd = process.env.NODE_ENV === "production";

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "/data");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");
export const BUILDS_DIR = path.join(DATA_DIR, "builds");
export const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../templates");
export const WEB_DIST = path.resolve(import.meta.dirname, "../../web/dist");

export const COMPILE_URL = process.env.COMPILE_URL ?? "http://compile:8788";
export const COMPILE_TOKEN = process.env.COMPILE_TOKEN;

/** Shared group password (optional when GitHub login is configured; disabled in invite-only workspaces). */
export const PASSWORD = (process.env.MARGIN_ADMINS ? undefined : process.env.MARGIN_PASSWORD) || undefined;
if (process.env.MARGIN_ADMINS && process.env.MARGIN_PASSWORD) console.warn("MARGIN_PASSWORD is ignored: the workspace is invite-only (MARGIN_ADMINS is set).");

/** GitHub OAuth app. Only logins in MARGIN_GITHUB_ALLOW may sign in ("*" = anyone). */
export const GITHUB = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  ? {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      allow: (process.env.MARGIN_GITHUB_ALLOW ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      oauthUrl: process.env.GITHUB_OAUTH_URL ?? "https://github.com",
      apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    }
  : null;

/**
 * Invite-only workspace: set MARGIN_ADMINS to the GitHub logins of the admins.
 * Only admins and invited members can sign in; the shared password is disabled.
 */
export const ADMINS = (process.env.MARGIN_ADMINS ?? "").split(",").map((s) => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
export const INVITE_ONLY = ADMINS.length > 0;
if (INVITE_ONLY && !GITHUB) {
  console.error("MARGIN_ADMINS (invite-only) needs GitHub sign-in: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.");
  if (isProd) process.exit(1);
}

/** Public origin for OAuth redirects, e.g. https://paper.example.com (defaults to the request's host). */
export const PUBLIC_URL = process.env.MARGIN_PUBLIC_URL?.replace(/\/$/, "");

/**
 * "workspace": a group's own server - everyone signed in can open every project.
 * "members": public sign-ups - projects are private to their members (invite links).
 * Defaults to members when GitHub sign-in is open to anyone.
 */
export const ACCESS_MODE: "workspace" | "members" =
  process.env.MARGIN_ACCESS === "members" || process.env.MARGIN_ACCESS === "workspace"
    ? process.env.MARGIN_ACCESS
    : GITHUB?.allow.includes("*") ? "members" : "workspace";

if (ACCESS_MODE === "members" && !GITHUB) {
  const msg = "MARGIN_ACCESS=members needs GitHub sign-in: with a shared password, names are self-declared and anyone could claim to be a member.";
  if (isProd) { console.error(msg); process.exit(1); } else console.warn(msg);
}

/** With no login method configured the app is open: fine on localhost, never in production. */
export const OPEN_ACCESS = !PASSWORD && !GITHUB;

if (isProd && (OPEN_ACCESS || !process.env.MARGIN_SECRET)) {
  console.error("Production needs MARGIN_SECRET plus MARGIN_PASSWORD and/or GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET.");
  process.exit(1);
}
if (GITHUB && GITHUB.allow.length === 0 && !process.env.MARGIN_ADMINS) {
  console.warn("GitHub login is configured but MARGIN_GITHUB_ALLOW is empty, so nobody can sign in with GitHub.");
}
/** Signs cookies and encrypts stored API keys. In development a random one is kept in DATA_DIR. */
export const SECRET = process.env.MARGIN_SECRET ?? (isProd ? "" : devSecret());

function devSecret() {
  const file = path.join(DATA_DIR, ".dev-secret");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const s = randomBytes(32).toString("hex");
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(file, s, { mode: 0o600 });
    } catch {
      // Read-only or missing data dir (e.g. unit tests): keep it in memory.
    }
    return s;
  }
}

export const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills");
export const SECURE_COOKIES = isProd;
