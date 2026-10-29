#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseLink, parseRemote } from "./config.js";

/**
 * margin: work on a Margin paper in a folder on your computer without
 * learning git. `margin clone` downloads it, `margin sync` sends your
 * changes and brings in everyone else's, `margin status` says where you
 * are. Git does the work underneath, so people who know it can mix freely.
 */

const HELP = `margin: keep a folder on your computer in step with a Margin paper.

  margin clone <link> [folder]   Download a paper. <link> is the project's address
                                 (copy it from your browser) or its git URL.
  margin sync [-m "message"]     Send your changes and get everyone else's.
              [--keep-both]      If you and someone else changed the same lines, send both
                                 versions and choose in Margin instead of in the file.
  margin status                  What changed here, and whether you're up to date.

Your access token (Margin (the terminal button, “Work outside the browser”)) is asked for once and remembered for this folder.
`;

const out = (s = "") => process.stdout.write(`${s}\n`);
const fail = (s: string): never => { process.stderr.write(`\n${s}\n`); process.exit(1); };

function git(args: string[], opts: { cwd?: string; quiet?: boolean } = {}) {
  const r = spawnSync("git", args, { cwd: opts.cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.error) fail("margin needs git installed. Get it from https://git-scm.com/downloads, then try again.");
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

async function ask(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function api(base: { url: string; project: string; token: string }, p: string) {
  const res = await fetch(`${base.url}/api/projects/${base.project}${p}`, { headers: { authorization: `Bearer ${base.token}` } }).catch(() => null);
  if (!res) fail(`Couldn't reach ${base.url}. Check your internet connection and the link.`);
  if (res!.status === 401) fail("Margin didn't accept that token. Create a new one in Margin (the terminal button, “Work outside the browser”), and paste it here.");
  if (res!.status === 404) fail("That project wasn't found, or you aren't a member of it. Ask an owner to invite you (Share).");
  if (!res!.ok) fail(`Margin returned an error (HTTP ${res!.status}).`);
  return res!.json() as Promise<unknown>;
}

/** The folder's project, from its git remote. */
function here() {
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!root.ok) fail("This folder isn't a Margin paper. Go into the folder `margin clone` made (cd <folder>), or download one first: margin clone <link>");
  const remote = git(["remote", "get-url", "origin"], { cwd: root.out });
  const info = remote.ok ? parseRemote(remote.out) : null;
  if (!info?.token) fail("This folder isn't connected to Margin (no origin remote with a token). Download it again with: margin clone <link>");
  return { root: root.out, url: info!.url, project: info!.project, token: info!.token! };
}

/** Files changed between two commits, for the summary. */
function changedFiles(cwd: string, from: string, to: string) {
  if (!from || from === to) return [];
  const r = git(["diff", "--name-only", from, to], { cwd });
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}

const list = (files: string[]) => (files.length <= 4 ? files.join(", ") : `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function clone(args: string[]) {
  const [link, folderArg] = args.filter((a) => !a.startsWith("--"));
  if (!link) fail("Which paper? margin clone <link>  (copy the link from your browser's address bar while the paper is open)");
  const info = parseLink(link);
  if (!info) fail(`That doesn't look like a Margin link: ${link}\nCopy it from the address bar while the paper is open, e.g. https://paper.example.com/#/p/my-paper-1a2b3c`);
  const tokenFlag = args.find((a) => a.startsWith("--token="))?.slice(8);
  const token = tokenFlag ?? info!.token ?? process.env.MARGIN_TOKEN ?? await ask("Access token (the terminal button in Margin → Create token): ");
  if (!/^mgn_/.test(token)) fail("Access tokens start with mgn_. Create one in Margin (the terminal button, “Work outside the browser”).");
  const base = { url: info!.url, project: info!.project, token };
  const project = await api(base, "") as { name: string };
  const access = await api(base, "/access") as { you?: { name: string } };
  const folder = folderArg ?? (project.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || info!.project);
  if (existsSync(folder)) fail(`There's already a folder called ${folder} here. Pick another name: margin clone <link> <folder>`);

  out(`Downloading “${project.name}” into ${folder}/ …`);
  const u = new URL(`${base.url}/git/${base.project}.git`);
  u.username = "margin";
  u.password = token;
  const r = git(["clone", "-q", u.toString(), folder]);
  if (!r.ok) fail(`Download failed: ${r.err.replaceAll(token, "mgn_…")}`);
  // Commits from here are credited to you in Margin's history.
  if (access.you?.name) git(["config", "user.name", access.you.name], { cwd: folder });
  if (!git(["config", "user.email"], { cwd: folder }).out) git(["config", "user.email", `${access.you?.name.toLowerCase().replace(/[^a-z0-9]+/g, ".") || "me"}@users.margin.local`], { cwd: folder });
  out(`Done. Edit the files in ${folder}/ with any editor (or run an agent there, e.g. claude).`);
  out(`When you want to share your changes or get others', run:  cd ${folder} && margin sync`);
}

/** Files changed, added or deleted here since the last sync. */
function localChanges(root: string) {
  const changed = git(["diff", "--name-only", "HEAD"], { cwd: root }).out.split("\n");
  const added = git(["ls-files", "--others", "--exclude-standard"], { cwd: root }).out.split("\n");
  return [...new Set([...changed, ...added].filter(Boolean))];
}

function inMerge(root: string) {
  return existsSync(path.join(root, ".git", "MERGE_HEAD"));
}

function filesWithMarkers(root: string) {
  const r = git(["diff", "--name-only", "--diff-filter=U"], { cwd: root });
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}

async function sync(args: string[]) {
  const ctx = here();
  const { root } = ctx;
  const mi = args.indexOf("-m");
  const message = mi >= 0 ? args[mi + 1] : undefined;
  const name = git(["config", "user.name"], { cwd: root }).out || "someone";

  const keepBoth = args.includes("--keep-both");
  let pushedMerge: string[] = [];

  // Finishing an earlier sync that stopped on overlapping changes.
  if (inMerge(root)) {
    const left = git(["grep", "-l", "-E", "^(<{7}|>{7})( |$)"], { cwd: root });
    const files = left.ok && left.out ? left.out.split("\n") : [];
    if (files.length && !keepBoth) fail(`These files still have both versions between <<<<<<< and >>>>>>> lines:\n  ${files.join("\n  ")}\nKeep the text you want, delete the marker lines, save, and run margin sync again.\nOr run margin sync --keep-both to send both versions and pick in Margin with one click.`);
    // Name the two sides the way Margin shows them: yours is what you're sending, theirs is what was live.
    for (const f of files) {
      const abs = path.join(root, f);
      const text = readFileSync(abs, "utf8").replace(/^<{7} HEAD$/gm, `<<<<<<< pushed by ${name}`).replace(/^>{7} [0-9a-f]{7,40}$/gm, ">>>>>>> live edits");
      writeFileSync(abs, text);
    }
    pushedMerge = files.length ? files : git(["diff", "--name-only", "--diff-filter=U"], { cwd: root }).out.split("\n").filter(Boolean);
    git(["add", "-A"], { cwd: root });
    git(["commit", "-q", "-m", files.length ? `Kept both versions of ${list(files)} to choose in Margin` : `Combined ${name}'s edits with Margin's`], { cwd: root });
  }

  // 1. Save local changes.
  const dirty = localChanges(root);
  let sent: string[] = [];
  if (dirty.length) {
    git(["add", "-A"], { cwd: root });
    sent = git(["diff", "--cached", "--name-only"], { cwd: root }).out.split("\n").filter(Boolean);
    const c = git(["commit", "-q", "-m", message ?? `Edits from ${name}'s computer: ${list(sent)}`], { cwd: root });
    if (!c.ok) fail(`Couldn't save your changes: ${c.err}`);
  }

  // 2. Bring in everyone's changes (Margin saves live edits first), then 3. send ours.
  let received: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = git(["rev-parse", "HEAD"], { cwd: root }).out;
    const pull = git(["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"], { cwd: root });
    received = [...new Set([...received, ...changedFiles(root, before, git(["rev-parse", "HEAD"], { cwd: root }).out)])];
    if (!pull.ok) {
      const clashes = filesWithMarkers(root);
      if (clashes.length) {
        out(`\nYou and someone else changed the same lines in ${list(clashes)}.`);
        out("Both versions are in the file now, like this:");
        out("  <<<<<<< HEAD           ← your version starts");
        out("  =======                ← theirs starts");
        out("  >>>>>>> …              ← end");
        out("Keep the text you want, delete those marker lines, save, and run margin sync again.");
        out("Or run margin sync --keep-both to send both versions and pick in Margin with one click.");
        process.exit(2);
      }
      fail(`Couldn't get the latest version: ${pull.err.replaceAll(ctx.token, "mgn_…")}`);
    }
    const ahead = git(["rev-list", "--count", "origin/main..HEAD"], { cwd: root }).out;
    if (ahead === "0") break;
    const push = git(["push", "-q", "origin", "HEAD:main"], { cwd: root });
    if (push.ok) break;
    // Someone saved in between: get their changes and try again.
    if (attempt === 2) fail(`Couldn't send your changes: ${push.err.replaceAll(ctx.token, "mgn_…")}`);
  }

  if (!sent.length && pushedMerge.length) sent = pushedMerge;
  out(sent.length ? `Sent ${plural(sent.length, "file")}: ${list(sent)}` : "Nothing new to send.");
  out(received.length ? `Got ${plural(received.length, "updated file")}: ${list(received)}` : "Nothing new from others.");

  // Overlaps Margin found while merging what we sent with live edits. A fetch waits until that merge is done.
  if (sent.length) git(["fetch", "-q", "origin"], { cwd: root });
  const conflicts = await api(ctx, "/conflicts") as { file: string; count: number }[];
  if (conflicts.length) {
    out(`\nHeads up: ${list(conflicts.map((c) => c.file))} ${conflicts.length === 1 ? "has" : "have"} overlapping changes waiting for someone to pick a version.`);
    out(`Open the paper in Margin to choose with one click: ${ctx.url}/#/p/${ctx.project}`);
  }
}

async function status() {
  const ctx = here();
  const { root } = ctx;
  const dirty = localChanges(root);
  if (inMerge(root)) out("You're in the middle of a sync with overlapping changes; fix the files, then run margin sync.");
  out(dirty.length ? `Changed here, not sent yet: ${list(dirty)}` : "No unsent changes here.");
  const fetched = git(["fetch", "-q", "origin"], { cwd: root });
  if (!fetched.ok) return out("Couldn't check Margin for new changes (offline?).");
  const behind = changedFiles(root, "HEAD", "origin/main");
  out(behind.length ? `Newer in Margin: ${list(behind)}. Run margin sync to get them.` : "Up to date with Margin.");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "clone") return clone(rest);
  if (cmd === "sync") return sync(rest);
  if (cmd === "status") return status();
  out(HELP);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}

main().catch((err) => fail((err as Error).message));
