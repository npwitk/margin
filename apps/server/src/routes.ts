import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  acceptSuggestion, createThread, isTextPath, lineAt, listThreads, reply, setStatus, textOf,
  type CompileResult, type Engine, type ThreadKind, type ThreadStatus,
} from "@margin/shared";
import type { AppEnv } from "./auth.ts";
import { compileProject, compileWorker } from "./compile.ts";
import { createDocument, listDocuments, pdfPathOf, renameDocuments, resolveDocument, updateDocument } from "./documents.ts";
import { emit, flushProject, forgetBoardMember, liveText, releasePath, withDoc, writeThroughCollab } from "./collab.ts";
import { checkpoint, history, withGitLock } from "./git.ts";
import { importArxiv, importGit, importZip } from "./importers.ts";
import { createToken, listTokens, revokeToken } from "./tokens.ts";
import { addOwner, canAccess, createInvite, getAccess, joinWithInvite, removeMember, revokeInvite, setRole } from "./access.ts";
import { limit } from "./ratelimit.ts";
import { createInvite as createWorkspaceInvite, removeMember as removeWorkspaceMember, revokeInvite as revokeWorkspaceInvite, setRole as setWorkspaceRole, workspaceInfo } from "./workspace.ts";
import {
  HttpError, createEntry, createProjectFromFiles, etagOf, createProject, deleteEntry, getProject, listFiles, listProjects, moveEntry,
  projectDir, readText, resolvePath, syncWorkDir, touchProject, updateProject, workDir, writeBinary, writeText,
} from "./storage.ts";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", pdf: "application/pdf", txt: "text/plain; charset=utf-8",
};

/** A text file as collaborators currently see it (live document first, then disk). */
async function currentText(id: string, rel: string) {
  const live = liveText(id, rel);
  return live === null ? readText(id, rel) : { content: live, etag: etagOf(live) };
}


export const tokenRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await listTokens(c.get("session").name)))
  .post("/", async (c) => {
    const { label } = await c.req.json<{ label?: string }>().catch(() => ({ label: undefined }));
    return c.json(await createToken(c.get("session").name, label ?? "", c.get("session").github), 201);
  })
  .delete("/:tid", async (c) => {
    const ok = await revokeToken(c.get("session").name, c.req.param("tid"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Token not found" }, 404);
  });

export const workspaceRoutes = new Hono<AppEnv>()
  .onError((err, c) => c.json({ error: err.message }, ((err as { status?: number }).status ?? 500) as 400))
  .get("/", async (c) => c.json(await workspaceInfo(c.get("session"))))
  .post("/invites", async (c) => {
    const body = await c.req.json<{ days?: number; maxUses?: number }>().catch(() => ({}));
    return c.json(await createWorkspaceInvite(c.get("session"), body), 201);
  })
  .delete("/invites/:id", async (c) => { await revokeWorkspaceInvite(c.get("session"), c.req.param("id")); return c.json({ ok: true }); })
  .delete("/members/:login", async (c) => { await removeWorkspaceMember(c.get("session"), c.req.param("login")); return c.json({ ok: true }); })
  .patch("/members/:login", async (c) => {
    const { role } = await c.req.json<{ role?: "admin" | "member" }>();
    if (role !== "admin" && role !== "member") return c.json({ error: "Role must be admin or member" }, 400);
    await setWorkspaceRole(c.get("session"), c.req.param("login"), role);
    return c.json({ ok: true });
  });

export const projectRoutes = new Hono<AppEnv>()
  .onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err.message || "Server error" }, 500);
  })

  .get("/", async (c) => {
    const session = c.get("session");
    const all = await listProjects();
    const visible = await Promise.all(all.map((p) => canAccess(p.id, session)));
    return c.json(all.filter((_, i) => visible[i]));
  })

  .post("/", limit("create", 20, 3600), async (c) => {
    const { name, template } = await c.req.json<{ name: string; template?: string }>();
    const project = await createProject(name, template ?? "article", c.get("session").name);
    await addOwner(project.id, c.get("session"));
    return c.json(project, 201);
  })

  // Import: multipart with a .zip, or JSON { arxiv } / { git }.
  .post("/import", limit("import", 10, 3600), bodyLimit({ maxSize: 100 * 1024 * 1024, onError: (c) => c.json({ error: "Upload too large (100 MB max)" }, 413) }), async (c) => {
    const author = c.get("session").name;
    let result, source, name: string | undefined;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") throw new HttpError(400, "Choose a .zip file");
      name = String(form.get("name") ?? "") || file.name.replace(/\.zip$/i, "").replace(/[_-]+/g, " ");
      result = importZip(new Uint8Array(await file.arrayBuffer()));
      source = file.name;
    } else {
      const body = await c.req.json<{ arxiv?: string; git?: string; name?: string }>();
      if (body.arxiv) { result = await importArxiv(body.arxiv); source = `arXiv ${body.arxiv.trim()}`; }
      else if (body.git) { result = await importGit(body.git); source = body.git.trim(); }
      else throw new HttpError(400, "Nothing to import");
      name = body.name;
    }
    const project = await createProjectFromFiles(name || result.title || "Imported paper", result.files, result.mainFile, result.engine, author, source);
    await addOwner(project.id, c.get("session"));
    return c.json({ ...project, imported: result.files.length }, 201);
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
    await renameDocuments(id, (p) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p));
    emit(id, "filesVersion", Date.now());
    return c.json({ ok: true });
  })

  .delete("/:id/entries", async (c) => {
    const id = c.req.param("id"), rel = c.req.query("path")!;
    resolvePath(id, rel);
    await releasePath(id, rel);
    await deleteEntry(id, rel);
    await renameDocuments(id, (p) => (p === rel || p.startsWith(`${rel}/`) ? null : p));
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
  .post("/:id/compile", limit("compile", 30, 60), async (c) => {
    const { doc } = await c.req.json<{ doc?: string }>().catch(() => ({ doc: undefined }));
    return c.json(await compileProject(c.req.param("id"), c.get("session").name, doc));
  })

  // ── Documents: every .tex with a \documentclass ─────────────────────────
  .get("/:id/documents", async (c) => c.json(await listDocuments(c.req.param("id"))))
  .post("/:id/documents", limit("create", 30, 3600), async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ title?: string; template?: string; path?: string; engine?: Engine }>();
    const created = await createDocument(id, body);
    emit(id, "filesVersion", Date.now());
    return c.json({ path: created, documents: await listDocuments(id) }, 201);
  })
  .patch("/:id/documents", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ path: string; engine?: Engine; title?: string; makeDefault?: boolean }>();
    const project = await updateDocument(id, body.path, body);
    return c.json({ project, documents: await listDocuments(id) });
  })

  .get("/:id/output.pdf", async (c) => {
    const id = c.req.param("id");
    const { path: doc } = await resolveDocument(id, c.req.query("doc"));
    const data = await readFile(pdfPathOf(id, doc)).catch(() => null);
    if (!data) throw new HttpError(404, "No PDF yet — compile first");
    return new Response(data, { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
  })

  .get("/:id/synctex/forward", async (c) => {
    const id = c.req.param("id");
    const { path: mainFile } = await resolveDocument(id, c.req.query("doc"));
    const q = new URLSearchParams({ projectId: id, mainFile, file: c.req.query("file") ?? "", line: c.req.query("line") ?? "1" });
    return c.json(await compileWorker(`/synctex/forward?${q}`));
  })

  .get("/:id/synctex/inverse", async (c) => {
    const id = c.req.param("id");
    const { path: mainFile } = await resolveDocument(id, c.req.query("doc"));
    const { page = "1", x = "0", y = "0" } = c.req.query();
    const q = new URLSearchParams({ projectId: id, mainFile, page, x, y });
    return c.json(await compileWorker(`/synctex/inverse?${q}`));
  })

  // ── Review threads (comments & suggestions) ─────────────────────────────
  .get("/:id/review", async (c) => {
    const id = c.req.param("id"), rel = c.req.query("path")!;
    resolvePath(id, rel);
    return c.json(await withDoc(id, rel, c.get("session"), (doc) => {
      const text = textOf(doc).toString();
      return listThreads(doc).map((t) => ({ ...t, line: t.from === null ? null : lineAt(text, t.from) }));
    }));
  })

  // Anchor by exact `quote` (first match, optionally after `near` line) or by offsets.
  .post("/:id/review", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{
      path: string; quote?: string; from?: number; to?: number; near?: number;
      kind?: ThreadKind; message?: string; replacement?: string;
    }>();
    resolvePath(id, body.path);
    const author = c.get("session").name;
    const thread = await withDoc(id, body.path, c.get("session"), (doc) => {
      const text = textOf(doc).toString();
      let from = body.from, to = body.to;
      if (body.quote !== undefined) {
        const startAt = body.near ? text.split("\n").slice(0, body.near - 1).join("\n").length : 0;
        let i = text.indexOf(body.quote, startAt);
        if (i < 0) i = text.indexOf(body.quote);
        if (i < 0) return null;
        from = i;
        to = i + body.quote.length;
      }
      if (from === undefined || to === undefined) return null;
      return createThread(doc, { from, to, author, kind: body.kind, message: body.message, replacement: body.replacement });
    });
    if (!thread) throw new HttpError(400, "Couldn't find that text in the file");
    return c.json(thread, 201);
  })

  .post("/:id/review/:thread", async (c) => {
    const id = c.req.param("id"), threadId = c.req.param("thread");
    const body = await c.req.json<{ path: string; action: "reply" | "accept" | ThreadStatus; text?: string }>();
    resolvePath(id, body.path);
    const by = c.get("session").name;
    const ok = await withDoc(id, body.path, c.get("session"), (doc) => {
      if (body.action === "reply") return !!reply(doc, threadId, by, body.text ?? "");
      if (body.action === "accept") return acceptSuggestion(doc, threadId, by);
      return !!setStatus(doc, threadId, body.action, by);
    });
    if (!ok) throw new HttpError(409, "Can't do that to this thread");
    return c.json({ ok: true });
  })

  // ── Members & invites ────────────────────────────────────────────────────
  .get("/:id/access", async (c) => c.json(await getAccess(c.req.param("id"), c.get("session"))))
  .post("/:id/invites", async (c) => c.json(await createInvite(c.req.param("id"), c.get("session")), 201))
  .delete("/:id/invites/:invite", async (c) => { await revokeInvite(c.req.param("id"), c.get("session"), c.req.param("invite")); return c.json({ ok: true }); })
  .post("/:id/join", limit("join", 20, 3600), async (c) => {
    const { token } = await c.req.json<{ token?: string }>();
    await getProject(c.req.param("id"));
    await joinWithInvite(c.req.param("id"), c.get("session"), token ?? "");
    return c.json(await getProject(c.req.param("id")));
  })
  .delete("/:id/members/:member", async (c) => {
    const gone = await removeMember(c.req.param("id"), c.get("session"), decodeURIComponent(c.req.param("member")));
    if (gone) await forgetBoardMember(c.req.param("id"), gone.name, c.get("session"));
    return c.json({ ok: true });
  })
  .patch("/:id/members/:member", async (c) => {
    const { role } = await c.req.json<{ role?: "owner" | "editor" }>();
    if (role !== "owner" && role !== "editor") throw new HttpError(400, "Role must be owner or editor");
    await setRole(c.req.param("id"), c.get("session"), decodeURIComponent(c.req.param("member")), role);
    return c.json({ ok: true });
  })

  // ── Checkpoints (git) ────────────────────────────────────────────────────
  .get("/:id/history", async (c) => c.json(await history(projectDir(c.req.param("id")))))

  .post("/:id/checkpoint", async (c) => {
    const id = c.req.param("id");
    const { message } = await c.req.json<{ message?: string }>().catch(() => ({ message: undefined }));
    await flushProject(id);
    const cp = await withGitLock(id, () => checkpoint(projectDir(id), (message ?? "").trim().slice(0, 200), c.get("session").name));
    if (cp) await touchProject(id);
    return c.json({ checkpoint: cp });
  });
