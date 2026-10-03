import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Engine } from "@margin/shared";
import { compile, forwardSearch, inverseSearch } from "./latex.ts";

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "/data");
const TOKEN = process.env.COMPILE_TOKEN;
const ENGINES: Engine[] = ["pdflatex", "xelatex", "lualatex"];

const app = new Hono();

app.use("*", async (c, next) => {
  if (TOKEN && c.req.header("x-compile-token") !== TOKEN && c.req.path !== "/health") {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

function workDirFor(projectId: string | undefined) {
  if (!projectId || !/^[a-z0-9-]{1,64}$/.test(projectId)) throw new Error("bad project id");
  return path.join(DATA_DIR, "builds", projectId, "work");
}

function checkRelative(p: string | undefined, ext?: string) {
  if (!p || p.startsWith("/") || p.split("/").includes("..") || (ext && !p.endsWith(ext))) throw new Error(`bad path: ${p}`);
  return p;
}

// One compile per project at a time; later requests wait for the earlier one.
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  return next;
}

app.get("/health", (c) => c.json({ ok: true }));

app.post("/compile", async (c) => {
  const body = await c.req.json<{ projectId: string; mainFile: string; engine?: Engine }>();
  try {
    const workDir = workDirFor(body.projectId);
    const mainFile = checkRelative(body.mainFile, ".tex");
    const engine = ENGINES.includes(body.engine!) ? body.engine! : "pdflatex";
    return c.json(await serialized(body.projectId, () => compile(workDir, mainFile, engine)));
  } catch (err) {
    return c.json({ error: String((err as Error).message) }, 400);
  }
});

app.get("/synctex/forward", async (c) => {
  const q = c.req.query();
  try {
    const res = await forwardSearch(workDirFor(q.projectId), checkRelative(q.mainFile, ".tex"), checkRelative(q.file), Number(q.line));
    return c.json(res);
  } catch (err) {
    return c.json({ error: String((err as Error).message) }, 400);
  }
});

app.get("/synctex/inverse", async (c) => {
  const q = c.req.query();
  try {
    const res = await inverseSearch(workDirFor(q.projectId), checkRelative(q.mainFile, ".tex"), Number(q.page), Number(q.x), Number(q.y));
    return c.json(res);
  } catch (err) {
    return c.json({ error: String((err as Error).message) }, 400);
  }
});

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () => {
  console.log(`compile worker listening on :${port} (data: ${DATA_DIR})`);
});
