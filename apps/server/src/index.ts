import { readFile, stat } from "node:fs/promises";
import type { MiddlewareHandler } from "hono";
import { canAccess } from "./access.ts";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { Server } from "node:http";
import { authRoutes, requireSession, type AppEnv } from "./auth.ts";
import { attachCollab, shutdownCollab } from "./collab.ts";
import { ACCESS_MODE, DATA_DIR, GITHUB, OPEN_ACCESS, PASSWORD, PROJECTS_DIR, WEB_DIST } from "./config.ts";
import { aiProjectRoutes, aiSettingsRoutes } from "./ai/routes.ts";
import { handleGit } from "./gitHttp.ts";
import { projectRoutes, tokenRoutes } from "./routes.ts";

const app = new Hono<AppEnv>();
app.use("*", logger());

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", authRoutes);
app.use("/api/projects/*", requireSession);
app.use("/api/projects", requireSession);
// Every /api/projects/:id/... request is checked against the project's members.
const projectGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.param("id");
  if (!id || id === "import" || c.req.path.endsWith("/join")) return next();
  const exists = await stat(path.join(PROJECTS_DIR, id)).then(() => true, () => false);
  if (exists && /^[a-z0-9-]{1,64}$/.test(id) && !(await canAccess(id, c.get("session")))) return c.json({ error: "Project not found" }, 404);
  return next();
};
app.use("/api/projects/:id", projectGate);
app.use("/api/projects/:id/*", projectGate);
app.route("/api/projects", aiProjectRoutes);
app.route("/api/projects", projectRoutes);
app.use("/api/ai/*", requireSession);
app.route("/api/ai", aiSettingsRoutes);
app.use("/api/tokens/*", requireSession);
app.use("/api/tokens", requireSession);
app.route("/api/tokens", tokenRoutes);

// Git smart HTTP: authenticated with access tokens, not the session cookie.
app.all("/git/*", (c) => handleGit(c));
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Production: serve the built web app, falling back to index.html for client routes.
const webRoot = path.relative(process.cwd(), WEB_DIST);
app.use("/*", serveStatic({ root: webRoot }));
app.get("*", async (c) => {
  const html = await readFile(path.join(WEB_DIST, "index.html"), "utf8").catch(() => null);
  return html ? c.html(html) : c.text("Web app not built. In development open http://localhost:5173", 404);
});

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () => {
  console.log(`margin server on :${port} (data: ${DATA_DIR}, auth: ${OPEN_ACCESS ? "OPEN — dev only" : [PASSWORD && "password", GITHUB && "github"].filter(Boolean).join(" + ")}, access: ${ACCESS_MODE})`);
});
attachCollab(server as Server);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await shutdownCollab().catch((err) => console.error("shutdown:", err));
    process.exit(0);
  });
}
