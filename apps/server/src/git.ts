import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Checkpoint } from "@margin/shared";

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

export async function initRepo(dir: string, authorName: string) {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "Margin"]);
  await git(dir, ["config", "user.email", "bot@margin.local"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "Create project", "--author", authorOf(authorName)]);
}

/** Commit everything that changed. Returns null when there is nothing to commit. */
export async function checkpoint(dir: string, message: string, authorName: string): Promise<Checkpoint | null> {
  await git(dir, ["add", "-A"]);
  const { stdout: status } = await git(dir, ["status", "--porcelain"]);
  if (!status.trim()) return null;
  await git(dir, ["commit", "-q", "-m", message || "Checkpoint", "--author", authorOf(authorName)]);
  return (await history(dir, 1))[0] ?? null;
}

export async function history(dir: string, limit = 50): Promise<Checkpoint[]> {
  const { stdout } = await git(dir, ["log", `-n${limit}`, "--pretty=format:%H%x1f%an%x1f%aI%x1f%s"]);
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, author, date, message] = line.split("\x1f");
    return { hash, author, date, message };
  });
}
