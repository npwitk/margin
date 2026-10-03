import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Engine, FileEntry, Project } from "@margin/shared";
import { BUILDS_DIR, PROJECTS_DIR, TEMPLATES_DIR } from "./config.ts";
import { initRepo } from "./git.ts";

export class HttpError extends Error {
  constructor(public status: 400 | 404 | 409 | 413, message: string) { super(message); }
}

const META = path.join(".margin", "project.json");
const HIDDEN = new Set([".git", ".margin"]);
/** Files never copied into the compile sandbox (latexmkrc is executable Perl). */
const NEVER_COMPILE = new Set([".git", ".margin", "latexmkrc", ".latexmkrc"]);

export function projectDir(id: string) {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new HttpError(404, "Project not found");
  return path.join(PROJECTS_DIR, id);
}

export function workDir(id: string) {
  return path.join(BUILDS_DIR, id, "work");
}

/** Resolve a project-relative path, refusing anything that escapes the project or touches .git/.margin. */
export function resolvePath(id: string, rel: string | undefined): string {
  if (!rel) throw new HttpError(400, "Missing path");
  const clean = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^\/+/, "");
  const parts = clean.split("/");
  if (!clean || clean === "." || parts.includes("..") || HIDDEN.has(parts[0])) {
    throw new HttpError(400, `Invalid path: ${rel}`);
  }
  return path.join(projectDir(id), clean);
}

export const etagOf = (buf: Buffer | string) => createHash("sha1").update(buf).digest("hex");

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "paper";
}

export async function getProject(id: string): Promise<Project> {
  const raw = await readFile(path.join(projectDir(id), META), "utf8").catch(() => null);
  if (!raw) throw new HttpError(404, "Project not found");
  return JSON.parse(raw) as Project;
}

async function saveProject(p: Project) {
  await writeFile(path.join(projectDir(p.id), META), JSON.stringify(p, null, 2) + "\n");
}

export async function listProjects(): Promise<Project[]> {
  await mkdir(PROJECTS_DIR, { recursive: true });
  const ids = await readdir(PROJECTS_DIR);
  const projects = await Promise.all(ids.map((id) => getProject(id).catch(() => null)));
  return projects.filter((p): p is Project => !!p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const TEMPLATES = ["article", "ieee", "blank"] as const;

export async function createProject(name: string, template: string, author: string): Promise<Project> {
  if (!TEMPLATES.includes(template as (typeof TEMPLATES)[number])) throw new HttpError(400, "Unknown template");
  const title = name.trim().slice(0, 120) || "Untitled paper";
  const id = `${slugify(title)}-${randomBytes(3).toString("hex")}`;
  const dir = projectDir(id);
  await mkdir(path.join(dir, ".margin"), { recursive: true });
  await cp(path.join(TEMPLATES_DIR, template), dir, { recursive: true });
  const main = path.join(dir, "main.tex");
  const escaped = title.replace(/[\\{}$&#^_%~]/g, (ch) => `\\${ch}`);
  await writeFile(main, (await readFile(main, "utf8")).replace("{{TITLE}}", escaped));

  const now = new Date().toISOString();
  const project: Project = { id, name: title, mainFile: "main.tex", engine: "pdflatex", createdAt: now, updatedAt: now };
  await saveProject(project);
  await initRepo(dir, author);
  return project;
}

export async function updateProject(id: string, patch: Partial<Pick<Project, "name" | "mainFile" | "engine">>): Promise<Project> {
  const p = await getProject(id);
  if (patch.name !== undefined) p.name = patch.name.trim().slice(0, 120) || p.name;
  if (patch.mainFile !== undefined) {
    if (!patch.mainFile.endsWith(".tex")) throw new HttpError(400, "Main file must be a .tex file");
    await stat(resolvePath(id, patch.mainFile)).catch(() => { throw new HttpError(400, "Main file does not exist"); });
    p.mainFile = patch.mainFile;
  }
  if (patch.engine !== undefined) {
    if (!["pdflatex", "xelatex", "lualatex"].includes(patch.engine)) throw new HttpError(400, "Unknown engine");
    p.engine = patch.engine as Engine;
  }
  p.updatedAt = new Date().toISOString();
  await saveProject(p);
  return p;
}

export async function touchProject(id: string) {
  const p = await getProject(id);
  p.updatedAt = new Date().toISOString();
  await saveProject(p);
}

export async function listFiles(id: string): Promise<FileEntry[]> {
  const root = projectDir(id);
  const out: FileEntry[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!prefix && HIDDEN.has(e.name)) continue;
      if (e.name === ".DS_Store" || e.name === ".gitkeep") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push({ path: rel, type: "dir", size: 0 });
        await walk(abs, rel);
      } else if (e.isFile()) {
        out.push({ path: rel, type: "file", size: (await stat(abs)).size });
      }
    }
  }
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readText(id: string, rel: string) {
  const buf = await readFile(resolvePath(id, rel)).catch(() => { throw new HttpError(404, "File not found"); });
  return { content: buf.toString("utf8"), etag: etagOf(buf) };
}

/** Write a file. If baseEtag is given and the file changed since, refuse with 409 so edits aren't lost. */
export async function writeText(id: string, rel: string, content: string, baseEtag?: string) {
  const abs = resolvePath(id, rel);
  if (baseEtag) {
    const current = await readFile(abs).catch(() => null);
    if (current && etagOf(current) !== baseEtag) throw new HttpError(409, "File changed since you opened it");
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return { etag: etagOf(content) };
}

export async function writeBinary(id: string, rel: string, data: Buffer) {
  const abs = resolvePath(id, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
}

export async function createEntry(id: string, rel: string, type: "file" | "dir") {
  const abs = resolvePath(id, rel);
  if (await stat(abs).catch(() => null)) throw new HttpError(409, "Already exists");
  if (type === "dir") await mkdir(abs, { recursive: true });
  else {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "");
  }
}

export async function moveEntry(id: string, from: string, to: string) {
  const src = resolvePath(id, from), dest = resolvePath(id, to);
  if (await stat(dest).catch(() => null)) throw new HttpError(409, "Destination already exists");
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(src, dest);
}

export async function deleteEntry(id: string, rel: string) {
  await rm(resolvePath(id, rel), { recursive: true, force: true });
}

/** Mirror the project into the compile sandbox's work dir, keeping previous build output for speed. */
export async function syncWorkDir(id: string) {
  const dest = workDir(id);
  await mkdir(dest, { recursive: true });
  for (const name of await readdir(dest)) {
    if (name !== "_out") await rm(path.join(dest, name), { recursive: true, force: true });
  }
  const src = projectDir(id);
  await cp(src, dest, {
    recursive: true,
    // Skip symlinks too: they could point TeX at files outside the project.
    filter: async (from) => from === src || (!NEVER_COMPILE.has(path.basename(from)) && !(await lstat(from)).isSymbolicLink()),
  });
}
