import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ApplyMode, ThreadEvent } from "./protocol.js";
import type { Config } from "./config.js";

const exec = promisify(execFile);

/** Build output and tooling folders never go back to the paper. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".margin", "__pycache__", ".claude", ".codex", "_out"]);
const IGNORED_EXT = /\.(aux|log|out|fls|fdb_latexmk|synctex\.gz|synctex|toc|lof|lot|bbl|blg|bcf|run\.xml|nav|snm|vrb|pdf|dvi|xdv|idx|ilg|ind)$/i;
const hash = (s: string) => createHash("sha1").update(s).digest("hex");
// Same list as Margin's server (packages/shared isTextPath).
const TEXT_EXT = new Set(["tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "def", "cfg", "clo", "ltx", "txt", "md", "csv", "tsv", "dat", "json", "yaml", "yml", "toml", "py", "r", "m", "jl", "sh", "js", "ts", "gitignore", "latexmkrc"]);
const isTextPath = (p: string) => { const b = p.split("/").pop() ?? p; return TEXT_EXT.has((b.includes(".") ? b.split(".").pop()! : b).toLowerCase()); };

export function syncable(rel: string) {
  return !rel.split("/").some((p) => IGNORED_DIRS.has(p)) && !IGNORED_EXT.test(rel) && isTextPath(rel);
}

/**
 * A local copy of one Margin project that agents work in. Text files the
 * agent changes are 3-way merged into the live paper (directly or as
 * suggestions); before each prompt the copy is refreshed with co-authors'
 * latest text.
 */
export class Workspace {
  readonly root: string;
  /** The text each file had when last synced (what an agent's change is relative to). */
  private base = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private inflight = new Map<string, Promise<void>>();
  title = "";
  mode: ApplyMode = "suggest";
  agentName = "Agent";
  onEvent: (e: ThreadEvent) => void = () => {};
  refs = 0;

  /** Read-only copies (for reviews) always mirror the paper and never send changes back. */
  constructor(private config: Config, readonly projectId: string, readonly readonly = false) {
    const host = new URL(config.url).host.replace(/[^\w.-]/g, "_");
    this.root = path.join(config.home, "workspaces", host, readonly ? `${projectId}.readonly` : projectId);
  }

  private async api(p: string, init: RequestInit = {}) {
    const res = await fetch(`${this.config.url}/api/projects/${this.projectId}${p}`, {
      ...init,
      headers: { authorization: `Bearer ${this.config.token}`, "x-margin-agent": this.agentName, "content-type": "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Margin returned HTTP ${res.status}`);
    return res;
  }

  /** Bring the local copy up to date with the shared paper (keeps any unsynced local edits). */
  async pull() {
    await this.flush();
    const { project, files } = (await (await this.api("/agent/snapshot")).json()) as {
      project: { name: string };
      files: { path: string; size: number; text?: string; binary?: true }[];
    };
    this.title = project.name;
    await mkdir(this.root, { recursive: true });
    const remote = new Set(files.map((f) => f.path));
    let changed = false;
    for (const f of files) {
      const abs = path.join(this.root, f.path);
      if (!abs.startsWith(this.root + path.sep)) continue;
      if (f.binary) {
        const st = await stat(abs).catch(() => null);
        if (st?.size === f.size) continue;
        const res = await this.api(`/raw?path=${encodeURIComponent(f.path)}`);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.from(await res.arrayBuffer()));
        continue;
      }
      const local = await readFile(abs, "utf8").catch(() => null);
      const base = this.base.get(f.path);
      if (!this.readonly && local !== null && base !== undefined && local !== base) continue; // agent's unsynced change wins locally
      if (local !== f.text) {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, f.text!);
        changed = true;
      }
      this.base.set(f.path, f.text!);
    }
    // Files deleted in the paper (and untouched locally).
    for (const [rel, text] of this.base) {
      if (remote.has(rel)) continue;
      const abs = path.join(this.root, rel);
      if ((await readFile(abs, "utf8").catch(() => null)) === text) { await rm(abs, { force: true }); changed = true; }
      this.base.delete(rel);
    }
    if (changed || !(await stat(path.join(this.root, ".git")).catch(() => null))) await this.commit("Margin: sync with the shared paper");
  }

  /** A local git history so agents can `git diff` their own changes. Best effort. */
  private async commit(message: string) {
    const git = (args: string[]) => exec("git", ["-c", "user.name=Margin", "-c", "user.email=bot@margin.local", ...args], { cwd: this.root }).catch(() => null);
    if (!(await stat(path.join(this.root, ".git")).catch(() => null))) {
      await git(["init", "-q"]);
      await writeFile(path.join(this.root, ".git", "info", "exclude"), "*.aux\n*.log\n*.out\n*.fls\n*.fdb_latexmk\n*.synctex.gz\n*.bbl\n*.blg\n*.pdf\n").catch(() => {});
    }
    await git(["add", "-A"]);
    await git(["commit", "-qm", message, "--allow-empty"]);
  }

  start() {
    if (this.watcher || this.readonly) return;
    this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const rel = String(name).split(path.sep).join("/");
      if (!syncable(rel)) return;
      clearTimeout(this.timers.get(rel));
      this.timers.set(rel, setTimeout(() => void this.push(rel), 350));
    });
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
  }

  /** Send one file's local change to Margin, if it changed since the last sync. */
  push(rel: string): Promise<void> {
    if (this.readonly) return Promise.resolve();
    const prev = this.inflight.get(rel) ?? Promise.resolve();
    const next = prev.then(async () => {
      const abs = path.join(this.root, rel);
      const content = await readFile(abs, "utf8").catch(() => null);
      const base = this.base.get(rel) ?? null;
      if (content === base || (content === null && base === null)) return;
      if (content !== null && content.length > 5_000_000) return;
      try {
        const res = await this.api("/agent/apply", { method: "POST", body: JSON.stringify({ path: rel, base, content, mode: this.mode }) });
        const r = (await res.json()) as { mode: string; suggestions?: number; conflicts: number };
        if (content === null) this.base.delete(rel); else this.base.set(rel, content);
        this.onEvent({ kind: "synced", path: rel, mode: r.mode === "edit" || r.mode === "created" ? "edit" : r.mode === "delete" ? "delete" : "suggest", suggestions: r.suggestions, conflicts: r.conflicts || undefined });
      } catch (err) {
        this.onEvent({ kind: "error", message: `Couldn't sync ${rel}: ${(err as Error).message}` });
      }
    });
    this.inflight.set(rel, next.catch(() => {}));
    return next;
  }

  /** Push every pending local change (catches anything the watcher missed). */
  async flush() {
    if (this.readonly) return;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const seen = new Set<string>();
    const walk = async (dir: string, prefix: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) await walk(path.join(dir, e.name), rel); }
        else if (e.isFile() && syncable(rel)) { seen.add(rel); await this.push(rel); }
      }
    };
    if (await stat(this.root).catch(() => null)) await walk(this.root, "");
    for (const rel of [...this.base.keys()]) if (!seen.has(rel)) await this.push(rel); // deleted locally
    void hash;
  }
}
