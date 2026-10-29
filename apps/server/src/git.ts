import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Checkpoint, CheckpointFileDiff } from "@margin/shared";

const exec = promisify(execFile);

const locks = new Map<string, Promise<unknown>>();
/** Serialize git operations on one project (checkpoints, fetch syncs, pushes). */
export function withGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(projectId) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(projectId, next);
  void next.finally(() => { if (locks.get(projectId) === next) locks.delete(projectId); }).catch(() => {});
  return next;
}

function git(cwd: string, args: string[]) {
  return exec("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function authorOf(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "member";
  return `${name.replace(/[<>]/g, "")} <${slug}@users.margin.local>`;
}

export async function initRepo(dir: string, authorName: string, message = "Create project") {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "Margin"]);
  await git(dir, ["config", "user.email", "bot@margin.local"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message, "--author", authorOf(authorName)]);
}

/**
 * Commit everything that changed. Returns null when there is nothing to commit.
 * Co-authors are credited with Co-authored-by trailers; `kind` records why the
 * version was saved (shown in the history).
 */
export async function checkpoint(dir: string, message: string, authorName: string, opts: { coAuthors?: string[]; kind?: Checkpoint["kind"] } = {}): Promise<Checkpoint | null> {
  await git(dir, ["add", "-A"]);
  const { stdout: status } = await git(dir, ["status", "--porcelain"]);
  // A named version can mark the current state even when nothing changed since the last one.
  if (!status.trim() && opts.kind !== "named") return null;
  const trailers = [
    ...[...new Set(opts.coAuthors ?? [])].filter((n) => n !== authorName).map((n) => `Co-authored-by: ${authorOf(n)}`),
    `Margin-Kind: ${opts.kind ?? "named"}`,
  ];
  await git(dir, ["commit", "-q", "--allow-empty", "-m", message || "Checkpoint", "-m", trailers.join("\n"), "--author", authorOf(authorName)]);
  return (await history(dir, 1))[0] ?? null;
}

// Margin's own commits carry a Margin-Kind trailer; ones without came from someone's clone.
const kindOf = (k: string): Checkpoint["kind"] => (k === "named" || k === "auto" || k === "restore" ? k : k ? "other" : "local");

/** Versions, newest first, with everyone who contributed and the files each one touched. */
export async function history(dir: string, limit = 50, skip = 0): Promise<Checkpoint[]> {
  const { stdout } = await git(dir, [
    "log", `-n${limit}`, `--skip=${skip}`, "--numstat", "--no-renames",
    "--pretty=format:%x1d%H%x1f%an%x1f%aI%x1f%s%x1f%P%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)%x1f%(trailers:key=Margin-Kind,valueonly)",
  ]);
  return stdout.split("\x1d").filter((b) => b.trim()).map((block) => {
    const [head, ...lines] = block.split("\n");
    const [hash, author, date, message, parents = "", co = "", kind = ""] = head.split("\x1f");
    const coNames = co.split("\x1e").map((t) => t.replace(/<[^>]*>/, "").trim()).filter(Boolean);
    const files = lines.filter((l) => l.trim()).map((l) => {
      const [a, d, ...p] = l.split("\t");
      return { path: p.join("\t"), additions: Number(a) || 0, deletions: Number(d) || 0 };
    }).filter((f) => !f.path.startsWith(".margin/") || f.path === ".margin/board.json");
    return { hash, author, date, message, people: [...new Set([author, ...coNames])], kind: parents.trim() ? kindOf(kind.trim()) : "other", files };
  });
}

/** What one version changed, file by file. */
export async function changesIn(dir: string, hash: string): Promise<CheckpointFileDiff[]> {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error("Bad version id");
  const { stdout } = await git(dir, ["show", "--format=", "--patch", "--find-renames", "-U3", "--no-color", "--no-ext-diff", hash]);
  const out: CheckpointFileDiff[] = [];
  for (const chunk of stdout.split(/^diff --git /m).slice(1)) {
    const header = chunk.slice(0, chunk.indexOf("\n"));
    const m = /^a\/(.*) b\/(.*)$/.exec(header);
    if (!m) continue;
    const binary = /^Binary files /m.test(chunk);
    const status: CheckpointFileDiff["status"] = /^new file mode/m.test(chunk) ? "added" : /^deleted file mode/m.test(chunk) ? "deleted" : /^rename from /m.test(chunk) ? "renamed" : "modified";
    const at = chunk.search(/^@@/m);
    let patch = at >= 0 ? chunk.slice(at) : "";
    const lines = patch.split("\n");
    const additions = lines.filter((l) => l.startsWith("+")).length;
    const deletions = lines.filter((l) => l.startsWith("-")).length;
    if (patch.length > 200_000) patch = `${patch.slice(0, 200_000)}\n… (diff truncated)`;
    if (m[2].startsWith(".margin/") && m[2] !== ".margin/board.json") continue;
    out.push({ path: m[2], from: status === "renamed" ? m[1] : undefined, status, binary, additions, deletions, patch });
  }
  return out;
}

/** Files in a version, and one file's content in it. */
export async function filesAt(dir: string, hash: string): Promise<string[]> {
  const { stdout } = await git(dir, ["ls-tree", "-r", "--name-only", "-z", hash]);
  return stdout.split("\0").filter(Boolean);
}

export async function fileAt(dir: string, hash: string, rel: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile("git", ["show", `${hash}:${rel}`], { cwd: dir, encoding: "buffer", maxBuffer: 200 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** The combined diff between two versions (`from` null: since the first commit), Margin's own files left out. */
export async function diffBetween(dir: string, from: string | null, to: string, maxChars = 120_000): Promise<{ stat: string; patch: string; truncated: boolean }> {
  const base = from ?? (await git(dir, ["rev-list", "--max-parents=0", to])).stdout.trim().split("\n")[0];
  const range = [base, to];
  const paths = ["--", ".", ":(exclude).margin"];
  const [{ stdout: stat }, { stdout: patch }] = await Promise.all([
    git(dir, ["diff", "--stat=120", ...range, ...paths]),
    git(dir, ["diff", "-U2", "--no-color", "--no-ext-diff", ...range, ...paths]),
  ]);
  return { stat: stat.trim(), patch: patch.length > maxChars ? patch.slice(0, maxChars) : patch, truncated: patch.length > maxChars };
}

/** Versions after `from` up to `to`, oldest first. */
export async function versionsBetween(dir: string, from: string | null, to: string): Promise<Checkpoint[]> {
  const all = await history(dir, 300);
  const end = all.findIndex((c) => c.hash === to);
  const start = from ? all.findIndex((c) => c.hash === from) : all.length;
  return all.slice(Math.max(0, end), start < 0 ? all.length : start).reverse();
}

/** The project's first commit (its template or import). */
export async function rootOf(dir: string) {
  return (await git(dir, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim().split("\n")[0];
}

export async function headOf(dir: string) {
  return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
}
