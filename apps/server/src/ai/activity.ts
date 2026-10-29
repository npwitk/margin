import { stat } from "node:fs/promises";
import { isTextPath, type Session } from "@margin/shared";
import { emit, setAgentActivity, writeThroughCollab } from "../collab.ts";
import { removePath } from "../entries.ts";
import { fileAt, history } from "../git.ts";
import { HttpError, projectDir, resolvePath, writeBinary } from "../storage.ts";
import { editorName, saveVersion } from "../versions.ts";

/**
 * What an agent is doing, shown next to people's presence, and the files it
 * changed directly. Before an agent's first direct edit Margin saves a
 * version, so everything it did can be taken back in one step.
 */

export interface AgentRun {
  /** Version to go back to; null until the agent first edits something. */
  before: string | null;
  files: Set<string>;
  last: number;
}

const RUN_TTL = 6 * 60 * 60_000;
const runs = new Map<string, AgentRun>();
const runKey = (projectId: string, key: string) => `${projectId}\0${key}`;

function runOf(projectId: string, key: string): AgentRun {
  const now = Date.now();
  for (const [k, r] of runs) if (now - r.last > RUN_TTL) runs.delete(k);
  const k = runKey(projectId, key);
  let run = runs.get(k);
  if (!run) runs.set(k, (run = { before: null, files: new Set(), last: now }));
  run.last = now;
  return run;
}

export interface CursorRange { from: number; to: number; edited?: boolean }

/** A status reporter for one agent: `status("Editing", "intro.tex", { from, to, edited: true })`. */
export function reporter(projectId: string, key: string, agent: string, session: Session) {
  return (text: string, file?: string, range?: CursorRange) => {
    const run = runs.get(runKey(projectId, key));
    setAgentActivity(projectId, key, {
      chatId: key, agent, for: session.name, status: text.slice(0, 120), file: file?.slice(0, 300),
      ...(range ?? {}), ...(run?.files.size ? { edits: [...run.files] } : {}), at: Date.now(),
    });
  };
}

/** The agent stopped: clear its presence, or leave a "Finished" note while its edits can still be undone. */
export function finish(projectId: string, key: string, agent: string, session: Session) {
  if (runs.get(runKey(projectId, key))?.files.size) reporter(projectId, key, agent, session)("Finished");
  else setAgentActivity(projectId, key, null);
}

/** Call before an agent changes `file` directly: saves the "before" version once per run. */
export async function beforeEdit(projectId: string, key: string, file: string, session: Session) {
  const run = runOf(projectId, key);
  if (run.before === null) {
    const saved = await saveVersion(projectId, { message: `Before ${session.agent ?? "the agent"}'s edits`, by: editorName(session), kind: "other" });
    run.before = saved?.hash ?? (await history(projectDir(projectId), 1))[0]?.hash ?? null;
  }
  run.files.add(file);
}

export function agentRun(projectId: string, key: string): AgentRun | undefined {
  return runs.get(runKey(projectId, key));
}

export function endRun(projectId: string, key: string) {
  runs.delete(runKey(projectId, key));
}

/**
 * Undo everything an agent changed directly in this run: each file goes back
 * to how it was before the agent's first edit (files it created are removed).
 * Edits people made to those files since are lost too, but stay in history.
 */
export async function revertRun(projectId: string, key: string, session: Session) {
  const run = runs.get(runKey(projectId, key));
  if (!run?.before || !run.files.size) throw new HttpError(404, "Nothing to undo for that agent");
  const dir = projectDir(projectId);
  await saveVersion(projectId, { message: "Before undoing an agent's edits", by: session.name, kind: "auto" });
  const files = [...run.files];
  for (const rel of files) {
    const data = await fileAt(dir, run.before, rel);
    const exists = await stat(resolvePath(projectId, rel)).then((st) => st.isFile(), () => false);
    if (!data) { if (exists) await removePath(projectId, rel, session); continue; }
    if (exists && isTextPath(rel)) await writeThroughCollab(projectId, rel, data.toString("utf8"), session);
    else await writeBinary(projectId, rel, data);
  }
  runs.delete(runKey(projectId, key));
  emit(projectId, "filesVersion", Date.now());
  await saveVersion(projectId, { message: `Undid ${files.length} file${files.length === 1 ? "" : "s"} changed by an agent`, by: session.name, kind: "restore" });
  return { files };
}
