import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isTextPath, type CompileResult } from "@margin/shared";
import type { AppEnv } from "./auth.ts";
import { COMPILE_TOKEN, COMPILE_URL } from "./config.ts";
import { emit, flushProject, liveText, releasePath, writeThroughCollab } from "./collab.ts";
import { checkpoint, history } from "./git.ts";
import {
  HttpError, createEntry, etagOf, createProject, deleteEntry, getProject, listFiles, listProjects, moveEntry,
  projectDir, readText, resolvePath, syncWorkDir, touchProject, updateProject, workDir, writeBinary, writeText,
} from "./storage.ts";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", pdf: "application/pdf", txt: "text/plain; charset=utf-8",
};

async function compileWorker(pathAndQuery: string, init?: RequestInit) {
  const res = await fetch(`${COMPILE_URL}${pathAndQuery}`, {
    ...init,
    headers: { "content-type": "application/json", ...(COMPILE_TOKEN ? { "x-compile-token": COMPILE_TOKEN } : {}) },
  }).catch(() => null);
  if (!res) throw new Error("Compile service is not reachable");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Compile service error ${res.status}`);
  return body;
}

/** A text file as collaborators currently see it (live document first, then disk). */
async function currentText(id: string, rel: string) {
  const live = liveText(id, rel);
  return live === null ? readText(id, rel) : { content: live, etag: etagOf(live) };
}

function pdfFile(id: string, mainFile: string) {
  return path.join(workDir(id), "_out", `${path.basename(mainFile, ".tex")}.pdf`);
}

export const projectRoutes = new Hono<AppEnv>()
  .onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err.message || "Server error" }, 500);
  })

  .get("/", async (c) => c.json(await listProjects()))

  .post("/", async (c) => {
    const { name, template } = await c.req.json<{ name: string; template?: string }>();
    return c.json(await createProject(name, template ?? "article", c.get("session").name), 201);
  })

  .get("/:id", async (c) => c.json(await getProject(c.req.param("id"))))

  .patch("/:id", async (c) => c.json(await updateProject(c.req.param("id"), await c.req.json())))

  // ── Files ────────────────────────────────────────────────────────────────
  .get("/:id/files", async (c) => c.json(await listFiles(c.req.param("id"))))

  .get("/:id/file", async (c) => c.json(await currentText(c.req.param("id"), c.req.query("path")!)))

  // Writes to existing text files go through the live document so open editors merge them.
  .put("/:id/file", async (c) => {
    const id = c.req.param("id"), rel = c.req.query("path")!;
    const { content, baseEtag } = await c.req.json<{ content: string; baseEtag?: string }>();
    const exists = await stat(resolvePath(id, rel)).then(() => true, () => false);
    if (!exists || !isTextPath(rel)) {
      const res = await writeText(id, rel, content, baseEtag);
      if (!exists) emit(id, "filesVersion", Date.now());
      return c.json(res);
    }
    // Read-modify-write clients (scripts, agents) must not undo edits made since their read.
    if (baseEtag && (await currentText(id, rel)).etag !== baseEtag) throw new HttpError(409, "File changed since you read it");
    await writeThroughCollab(id, rel, content, c.get("session"));
    return c.json({ etag: etagOf(content) });
  })

  .get("/:id/raw", async (c) => {
    const abs = resolvePath(c.req.param("id"), c.req.query("path"));
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, "File not found");
    const ext = path.extname(abs).slice(1).toLowerCase();
    return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "content-length": String(st.size),
        // User-supplied files (e.g. SVG) must never run script on our origin.
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  })

  .post("/:id/entries", async (c) => {
    const { path: rel, type } = await c.req.json<{ path: string; type: "file" | "dir" }>();
    await createEntry(c.req.param("id"), rel, type === "dir" ? "dir" : "file");
    emit(c.req.param("id"), "filesVersion", Date.now());
    return c.json({ ok: true }, 201);
  })

  .post("/:id/move", async (c) => {
    const id = c.req.param("id");
    const { from, to } = await c.req.json<{ from: string; to: string }>();
    resolvePath(id, to);
    await releasePath(id, from);
    await moveEntry(id, from, to);
    emit(id, "filesVersion", Date.now());
    return c.json({ ok: true });
  })

  .delete("/:id/entries", async (c) => {
    const id = c.req.param("id"), rel = c.req.query("path")!;
    resolvePath(id, rel);
    await releasePath(id, rel);
    await deleteEntry(id, rel);
    emit(id, "filesVersion", Date.now());
    return c.json({ ok: true });
  })

  .post("/:id/upload", bodyLimit({ maxSize: 50 * 1024 * 1024, onError: (c) => c.json({ error: "Upload too large (50 MB max)" }, 413) }), async (c) => {
    const id = c.req.param("id");
    projectDir(id);
    const form = await c.req.formData();
    const dir = String(form.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
    const saved: string[] = [];
    for (const item of form.getAll("files")) {
      if (typeof item === "string") continue;
      const name = path.basename(item.name);
      const rel = dir ? `${dir}/${name}` : name;
      const data = Buffer.from(await item.arrayBuffer());
      const existing = await stat(resolvePath(id, rel)).then(() => true, () => false);
      // Re-uploading a .tex/.bib someone has open: merge it into the live document.
      if (existing && isTextPath(rel)) await writeThroughCollab(id, rel, data.toString("utf8"), c.get("session"));
      else await writeBinary(id, rel, data);
      saved.push(rel);
    }
    emit(id, "filesVersion", Date.now());
    return c.json({ saved });
  })

  // ── Compile & preview ────────────────────────────────────────────────────
  .post("/:id/compile", async (c) => {
    const id = c.req.param("id");
    const project = await getProject(id);
    await flushProject(id);
    await syncWorkDir(id);
    const result = (await compileWorker("/compile", {
      method: "POST",
      body: JSON.stringify({ projectId: id, mainFile: project.mainFile, engine: project.engine }),
    })) as CompileResult;
    await touchProject(id);
    emit(id, "lastCompile", { by: c.get("session").name, at: Date.now(), ok: result.ok });
    return c.json(result);
  })

  .get("/:id/output.pdf", async (c) => {
    const id = c.req.param("id");
    const project = await getProject(id);
    const data = await readFile(pdfFile(id, project.mainFile)).catch(() => null);
    if (!data) throw new HttpError(404, "No PDF yet — compile first");
    return new Response(data, { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
  })

  .get("/:id/synctex/forward", async (c) => {
    const id = c.req.param("id");
    const { mainFile } = await getProject(id);
    const q = new URLSearchParams({ projectId: id, mainFile, file: c.req.query("file") ?? "", line: c.req.query("line") ?? "1" });
    return c.json(await compileWorker(`/synctex/forward?${q}`));
  })

  .get("/:id/synctex/inverse", async (c) => {
    const id = c.req.param("id");
    const { mainFile } = await getProject(id);
    const { page = "1", x = "0", y = "0" } = c.req.query();
    const q = new URLSearchParams({ projectId: id, mainFile, page, x, y });
    return c.json(await compileWorker(`/synctex/inverse?${q}`));
  })

  // ── Checkpoints (git) ────────────────────────────────────────────────────
  .get("/:id/history", async (c) => c.json(await history(projectDir(c.req.param("id")))))

  .post("/:id/checkpoint", async (c) => {
    const id = c.req.param("id");
    const { message } = await c.req.json<{ message?: string }>().catch(() => ({ message: undefined }));
    await flushProject(id);
    const cp = await checkpoint(projectDir(id), (message ?? "").trim().slice(0, 200), c.get("session").name);
    if (cp) await touchProject(id);
    return c.json({ checkpoint: cp });
  });
