import type { Session } from "@margin/shared";
import { emit, releasePath } from "./collab.ts";
import { renameDocuments } from "./documents.ts";
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
  await renameDocuments(projectId, (p) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p));
  recordEdit(projectId, to, editorName(session));
  emit(projectId, "filesVersion", Date.now());
}

export async function removePath(projectId: string, rel: string, session: Session) {
  resolvePath(projectId, rel);
  await releasePath(projectId, rel);
  await deleteEntry(projectId, rel);
  await renameDocuments(projectId, (p) => (p === rel || p.startsWith(`${rel}/`) ? null : p));
  recordEdit(projectId, rel, editorName(session));
  emit(projectId, "filesVersion", Date.now());
}
