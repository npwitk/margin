import path from "node:path";
import { randomBytes } from "node:crypto";

const isProd = process.env.NODE_ENV === "production";

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "/data");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");
export const BUILDS_DIR = path.join(DATA_DIR, "builds");
export const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../templates");
export const WEB_DIST = path.resolve(import.meta.dirname, "../../web/dist");

export const COMPILE_URL = process.env.COMPILE_URL ?? "http://compile:8788";
export const COMPILE_TOKEN = process.env.COMPILE_TOKEN;

/** Shared group password (optional when GitHub login is configured). */
export const PASSWORD = process.env.MARGIN_PASSWORD || undefined;

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

/** Public origin for OAuth redirects, e.g. https://paper.example.com (defaults to the request's host). */
export const PUBLIC_URL = process.env.MARGIN_PUBLIC_URL?.replace(/\/$/, "");

/** With no login method configured the app is open: fine on localhost, never in production. */
export const OPEN_ACCESS = !PASSWORD && !GITHUB;

if (isProd && (OPEN_ACCESS || !process.env.MARGIN_SECRET)) {
  console.error("Production needs MARGIN_SECRET plus MARGIN_PASSWORD and/or GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET.");
  process.exit(1);
}
if (GITHUB && GITHUB.allow.length === 0) {
  console.warn("GitHub login is configured but MARGIN_GITHUB_ALLOW is empty, so nobody can sign in with GitHub.");
}
export const SECRET = process.env.MARGIN_SECRET ?? (isProd ? "" : "dev-secret-" + randomBytes(4).toString("hex"));
export const SECURE_COOKIES = isProd;
