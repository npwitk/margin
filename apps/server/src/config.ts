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

/** Shared group password. Unset = open access (local development only). */
export const PASSWORD = process.env.MARGIN_PASSWORD || undefined;

if (isProd && (!PASSWORD || !process.env.MARGIN_SECRET)) {
  console.error("MARGIN_PASSWORD and MARGIN_SECRET must be set in production.");
  process.exit(1);
}
export const SECRET = process.env.MARGIN_SECRET ?? (isProd ? "" : "dev-secret-" + randomBytes(4).toString("hex"));
export const SECURE_COOKIES = isProd;
