import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createThread, isTextPath, textHunks, textOf, type ApplyMode, type Session } from "@margin/shared";
import { emit, liveText, releasePath, withDoc } from "../collab.ts";
import { merge3 } from "../pushMerge.ts";
import { deleteEntry, listFiles, resolvePath } from "../storage.ts";

/**
 * Bring a file change made by a local agent (in its copy of the project)
 * into the shared paper. `base` is the text the agent's copy started from;
 * the change is 3-way merged with what co-authors have typed since, then
 * either applied directly or offered as suggestions.
 */

export interface ApplyResult { mode: ApplyMode | "delete" | "created"; suggestions?: number; conflicts: number }

async function current(projectId: string, rel: string): Promise<string | null> {
  return liveText(projectId, rel) ?? (await readFile(resolvePath(projectId, rel), "utf8").catch(() => null));
}

export async function applyAgentChange(
  projectId: string, session: Session, rel: string, base: string | null, content: string | null, mode: ApplyMode,
): Promise<ApplyResult> {
  const abs = resolvePath(projectId, rel);
  if (!isTextPath(rel)) throw new Error(`${rel} isn't a text file`);
  const author = session.agent ?? "Agent";

  // Deleted by the agent.
  if (content === null) {
    if (mode !== "edit") return { mode: "suggest", suggestions: 0, conflicts: 0 };
    const live = await current(projectId, rel);
    if (live === null) return { mode: "delete", conflicts: 0 };
    if (base !== null && live !== base) return { mode: "delete", conflicts: 1 }; // someone edited it meanwhile; keep it
    await releasePath(projectId, rel);
    await deleteEntry(projectId, rel);
    emit(projectId, "filesVersion", Date.now());
    return { mode: "delete", conflicts: 0 };
  }

  // New file.
  if (!(await stat(abs).then(() => true, () => false))) {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    emit(projectId, "filesVersion", Date.now());
    return { mode: "created", conflicts: 0 };
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const live = (await current(projectId, rel)) ?? "";
    const merged = base === null || base === live ? { text: content, conflicts: 0 } : await merge3(content, base, live);
    if (merged.text === live) return { mode, suggestions: 0, conflicts: merged.conflicts };
    const result = await withDoc(projectId, rel, session, (doc) => {
      const text = textOf(doc);
      if (text.toString() !== live) return null; // changed while merging: try again
      const hunks = textHunks(live, merged.text);
      if (mode === "edit") {
        doc.transact(() => {
          // Apply back to front so earlier offsets stay valid.
          for (const h of [...hunks].sort((a, b) => b.from - a.from)) {
            if (h.to > h.from) text.delete(h.from, h.to - h.from);
            if (h.insert) text.insert(h.from, h.insert);
          }
        });
        return { mode, conflicts: merged.conflicts } as ApplyResult;
      }
      for (const h of hunks) createThread(doc, { from: h.from, to: h.to, author, kind: "suggestion", replacement: h.insert, message: `Suggested by ${author} for ${session.name}` });
      return { mode, suggestions: hunks.length, conflicts: merged.conflicts } as ApplyResult;
    });
    if (result) return result;
  }
  throw new Error(`${rel} is changing too fast to merge; try again`);
}

/** The project as collaborators see it right now, for an agent's local copy. */
export async function snapshot(projectId: string) {
  const files = (await listFiles(projectId)).filter((f) => f.type === "file");
  return Promise.all(files.map(async (f) => (isTextPath(f.path) && f.size < 5_000_000
    ? { path: f.path, size: f.size, text: (await current(projectId, f.path)) ?? "" }
    : { path: f.path, size: f.size, binary: true as const })));
}
