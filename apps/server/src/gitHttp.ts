import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { Context } from "hono";
import { PROJECTS_DIR } from "./config.ts";
import { flushProject, pauseProject, resumeProject } from "./collab.ts";
import { checkpoint, withGitLock } from "./git.ts";
import { head, mergePushed } from "./pushMerge.ts";
import { projectDir } from "./storage.ts";
import { verifyToken } from "./tokens.ts";
import { canAccess } from "./access.ts";
import { isActiveMember } from "./workspace.ts";

/**
 * Git smart HTTP (`git clone https://host/git/<id>.git`), served by
 * `git http-backend`. Authenticate with any username and a Margin access
 * token as the password.
 *
 * Fetches first checkpoint live edits, so clones and pulls are current.
 * Pushes only move the branch (receive.denyCurrentBranch = ignore); each
 * changed file is then 3-way merged with live edits (see pushMerge.ts), so
 * people typing in the browser never cause a push to be rejected.
 */

const exec = promisify(execFile);
const configured = new Set<string>();

async function ensureConfig(dir: string) {
  if (configured.has(dir)) return;
  for (const [k, v] of [
    ["http.receivepack", "true"],
    ["receive.denyCurrentBranch", "ignore"],
    ["receive.fsckObjects", "true"],
    ["receive.denyNonFastForwards", "true"],
    ["receive.denyDeletes", "true"],
  ]) await exec("git", ["config", k, v], { cwd: dir });
  configured.add(dir);
}

function unauthorized(c: Context, message = "Authentication required") {
  return c.text(`${message}\n`, 401, { "WWW-Authenticate": 'Basic realm="Margin", charset="UTF-8"' });
}

async function memberFrom(c: Context): Promise<{ name: string; github?: string } | null> {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return verifyToken(password);
}

/** Commit whatever collaborators have typed since the last checkpoint. */
async function syncLiveEdits(id: string) {
  await flushProject(id);
  await checkpoint(projectDir(id), "Sync live edits", "Margin");
}

export async function handleGit(c: Context) {
  const m = /^\/git\/([a-z0-9-]{1,64})\.git(\/.*)$/.exec(c.req.path);
  if (!m) return c.text("Not found\n", 404);
  const [, id, rest] = m;
  const dir = projectDir(id);
  if (!(await stat(path.join(dir, ".git")).catch(() => null))) return c.text("Repository not found\n", 404);

  const owner = await memberFrom(c);
  if (!owner) return unauthorized(c, c.req.header("authorization") ? "Invalid token" : undefined);
  if (!(await isActiveMember(owner))) return unauthorized(c, "This token's owner is no longer a member");
  if (!(await canAccess(id, owner))) return c.text("Repository not found\n", 404);
  const member = owner.name;

  const service = rest === "/info/refs" ? c.req.query("service") : rest.slice(1);
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return c.text("Dumb HTTP is not supported\n", 403);
  const isPush = service === "git-receive-pack" && c.req.method === "POST";

  await ensureConfig(dir);
  // Fetches see live edits. (Not before pushes: that would move the branch
  // under the pusher and make their push look out of date.)
  if (service === "git-upload-pack" && rest === "/info/refs") await withGitLock(id, () => syncLiveEdits(id));

  const run = async (): Promise<{ response: Response; finished: Promise<unknown> }> => {
    const oldHead = isPush ? await head(dir) : null;
    if (isPush) await pauseProject(id);

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_PROJECT_ROOT: PROJECTS_DIR,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${id}${rest}`,
      REQUEST_METHOD: c.req.method,
      QUERY_STRING: new URL(c.req.url).search.slice(1),
      CONTENT_TYPE: c.req.header("content-type") ?? "",
      REMOTE_USER: member,
      REMOTE_ADDR: c.req.header("x-forwarded-for") ?? "127.0.0.1",
      GIT_HTTP_MAX_REQUEST_BUFFER: String(100 * 1024 * 1024),
    };
    const enc = c.req.header("content-encoding");
    if (enc) env.HTTP_CONTENT_ENCODING = enc;
    const proto = c.req.header("git-protocol");
    if (proto) env.GIT_PROTOCOL = proto;

    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    if (c.req.raw.body) Readable.fromWeb(c.req.raw.body as never).pipe(child.stdin);
    else child.stdin.end();
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

    // Parse the CGI header block, then stream the rest.
    const reader = child.stdout[Symbol.asyncIterator]();
    let buf = Buffer.alloc(0);
    let headerEnd = -1;
    while (headerEnd < 0) {
      const { value, done } = await reader.next();
      if (done) break;
      buf = Buffer.concat([buf, value as Buffer]);
      headerEnd = buf.indexOf("\r\n\r\n");
    }
    if (headerEnd < 0) {
      await exited;
      if (isPush) await resumeProject(id);
      console.error("git http-backend:", stderr);
      return { response: new Response("git http-backend failed\n", { status: 500 }), finished: Promise.resolve() };
    }
    const headers = new Headers();
    let status = 200;
    for (const line of buf.subarray(0, headerEnd).toString("latin1").split("\r\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number.parseInt(v, 10) || 200;
      else headers.append(k, v);
    }
    const first = buf.subarray(headerEnd + 4);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (first.length) controller.enqueue(new Uint8Array(first));
        for (;;) {
          const { value, done } = await reader.next();
          if (done) break;
          controller.enqueue(new Uint8Array(value as Buffer));
        }
        controller.close();
      },
    });

    // Merge pushed files into live documents once git has finished.
    const finished = !isPush ? exited : exited
      .then(async () => {
        const newHead = await head(dir);
        if (oldHead && newHead !== oldHead) await mergePushed(id, oldHead, newHead);
      })
      .catch((err) => console.error("merge after push:", err))
      .finally(() => resumeProject(id));
    return { response: new Response(body, { status, headers }), finished };
  };

  if (!isPush) return (await run()).response;
  // Hold the project's git lock until the push has been merged into live documents.
  return new Promise<Response>((resolve, reject) => {
    void withGitLock(id, async () => {
      try {
        const { response, finished } = await run();
        resolve(response);
        await finished;
      } catch (err) {
        reject(err);
      }
    });
  });
}
