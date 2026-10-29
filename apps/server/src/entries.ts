import type { Session } from "@margin/shared";
import { emit, releasePath } from "./collab.ts";
import { renameDocuments } from "./documents.ts";
import { renameSections } from "./sections.ts";
import { createEntry, deleteEntry, moveEntry, resolvePath } from "./storage.ts";
import { editorName, recordEdit } from "./versions.ts";

/**
 * File and folder changes shared by the REST API and agent tools: they close
 * live documents first, keep document settings pointing at the right paths,
 * credit the edit and tell every client to refresh its file list.
 */

export async function addEntry(projectId: string, rel: string, type: "file" | "dir", session: Session) {
  const result = await createEntry(projectId, rel, type);
  if (result.existed) return result;
  recordEdit(projectId, rel, editorName(session));
  emit(projectId, "filesVersion", Date.now());
  return result;
}

export async function movePath(projectId: string, from: string, to: string, session: Session) {
  resolvePath(projectId, to);
  await releasePath(projectId, from);
  await moveEntry(projectId, from, to);
  const moved = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p);
  await renameDocuments(projectId, moved);
  await renameSections(projectId, moved);
  recordEdit(projectId, to, editorName(session));
  emit(projectId, "filesVersion", Date.now());
}

export async function removePath(projectId: string, rel: string, session: Session) {
  resolvePath(projectId, rel);
  await releasePath(projectId, rel);
  await deleteEntry(projectId, rel);
  const gone = (p: string) => (p === rel || p.startsWith(`${rel}/`) ? null : p);
  await renameDocuments(projectId, gone);
  await renameSections(projectId, gone);
  recordEdit(projectId, rel, editorName(session));
  emit(projectId, "filesVersion", Date.now());
}
