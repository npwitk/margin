import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SHARED_DIR, isTextPath, type Session } from "@margin/shared";
import { textOf } from "./ai/paper.ts";
import { listDocuments } from "./documents.ts";
import { movePath, removePath } from "./entries.ts";
import { HttpError, resolvePath } from "./storage.ts";

/**
 * Move a file into the project's shared/ folder so every document can use it
 * by name. It keeps its path relative to its document's folder
 * (ieee-tcc/figures/x.pdf → shared/figures/x.pdf), so \includegraphics{figures/x.pdf}
 * keeps working: the compiler searches shared/ after the document's own folder.
 * Other documents' byte-identical copies at the same relative path are removed;
 * copies that differ stay, since a document's own file wins.
 */
export interface SharePlan { from: string; to: string; duplicates: string[] }

async function bytesOf(projectId: string, rel: string): Promise<Buffer | null> {
  if (isTextPath(rel)) {
    const live = await textOf(projectId, rel); // includes edits not saved to disk yet
    if (live !== null) return Buffer.from(live);
  }
  return readFile(resolvePath(projectId, rel)).catch(() => null);
}

export async function planShare(projectId: string, file: string): Promise<SharePlan> {
  const from = path.posix.normalize(file.replace(/^\/+/, ""));
  resolvePath(projectId, from);
  if (from === SHARED_DIR || from.startsWith(`${SHARED_DIR}/`)) throw new HttpError(400, `${from} is already shared`);
  const st = await stat(resolvePath(projectId, from)).catch(() => null);
  if (!st?.isFile()) throw new HttpError(400, "Only files can be shared");

  const docs = await listDocuments(projectId);
  if (docs.some((d) => d.path === from)) throw new HttpError(400, "A document's main file can't be shared; share the figures, .bib or macros it uses");
  // The document folder the file belongs to: the deepest one it sits in.
  const dirs = [...new Set(docs.map((d) => path.posix.dirname(d.path)))];
  const home = dirs.filter((d) => d === "." || from.startsWith(`${d}/`)).sort((a, b) => (b === "." ? 0 : b.length + 1) - (a === "." ? 0 : a.length + 1))[0];
  const rel = home && home !== "." ? from.slice(home.length + 1) : home === "." ? from : path.posix.basename(from);
  const to = `${SHARED_DIR}/${rel}`;
  if (await stat(resolvePath(projectId, to)).catch(() => null)) throw new HttpError(409, `${to} already exists. Rename one of them first`);

  const mine = await bytesOf(projectId, from);
  const duplicates: string[] = [];
  for (const d of dirs) {
    if (d === home) continue;
    const twin = d === "." ? rel : `${d}/${rel}`;
    if (twin === from) continue;
    const theirs = await bytesOf(projectId, twin);
    if (mine && theirs && mine.equals(theirs)) duplicates.push(twin);
  }
  return { from, to, duplicates: duplicates.sort() };
}

export async function shareFile(projectId: string, file: string, session: Session): Promise<SharePlan> {
  const plan = await planShare(projectId, file);
  await movePath(projectId, plan.from, plan.to, session);
  for (const d of plan.duplicates) await removePath(projectId, d, session);
  return plan;
}
