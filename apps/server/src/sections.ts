import { mkdir, stat } from "node:fs/promises";
import type { ProjectSection, Session } from "@margin/shared";
import { emit } from "./collab.ts";
import { slug, unusedFolder } from "./documents.ts";
import { HttpError, getProject, resolvePath, saveProject } from "./storage.ts";
import { editorName, recordEdit } from "./versions.ts";

/**
 * Sections of a project: named areas such as "Paper", "Slides" or "Notes",
 * each backed by a folder, that the file list shows as groups people add
 * documents and files to. Only the names live in project.json; the folders
 * are ordinary folders, so git, agents and LaTeX see nothing special.
 */

const clean = (p: string) => p.trim().replace(/^\/+|\/+$/g, "");

/** Start a new section: a fresh folder named after it, or an existing folder given a name. */
export async function addProjectSection(projectId: string, input: { title: string; path?: string }, session: Session): Promise<ProjectSection> {
  const title = input.title.trim().slice(0, 60);
  if (!title) throw new HttpError(400, "Give the section a name");
  const p = await getProject(projectId);
  const sections = p.sections ?? [];
  let folder: string;
  if (input.path) {
    folder = clean(input.path);
    const st = await stat(resolvePath(projectId, folder)).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, `${folder} isn't a folder`);
    if (sections.some((s) => s.path === folder)) throw new HttpError(409, `${folder} is already a section`);
  } else {
    folder = await unusedFolder(projectId, slug(title));
    await mkdir(resolvePath(projectId, folder), { recursive: true });
    recordEdit(projectId, folder, editorName(session));
  }
  const section = { path: folder, title };
  p.sections = [...sections, section];
  p.updatedAt = new Date().toISOString();
  await saveProject(p);
  emit(projectId, "filesVersion", Date.now());
  return section;
}

/** Rename a section (its folder keeps its name) or reorder it. */
export async function updateProjectSection(projectId: string, path: string, patch: { title?: string; index?: number }) {
  const p = await getProject(projectId);
  const sections = [...(p.sections ?? [])];
  const i = sections.findIndex((s) => s.path === path);
  if (i < 0) throw new HttpError(404, "No such section");
  if (patch.title !== undefined) sections[i] = { ...sections[i], title: patch.title.trim().slice(0, 60) || sections[i].title };
  if (patch.index !== undefined) {
    const [s] = sections.splice(i, 1);
    sections.splice(Math.max(0, Math.min(patch.index, sections.length)), 0, s);
  }
  p.sections = sections;
  await saveProject(p);
  emit(projectId, "filesVersion", Date.now());
  return sections;
}

/** Stop showing a folder as a section. Its files stay where they are. */
export async function removeProjectSection(projectId: string, path: string) {
  const p = await getProject(projectId);
  const next = (p.sections ?? []).filter((s) => s.path !== path);
  p.sections = next.length ? next : undefined;
  await saveProject(p);
  emit(projectId, "filesVersion", Date.now());
}

/** Keep sections pointing at their folders when folders are renamed or deleted. */
export async function renameSections(projectId: string, moved: (p: string) => string | null) {
  const p = await getProject(projectId);
  if (!p.sections?.length) return;
  const next = p.sections.flatMap((s) => { const to = moved(s.path); return to ? [{ ...s, path: to }] : []; });
  if (JSON.stringify(next) === JSON.stringify(p.sections)) return;
  p.sections = next.length ? next : undefined;
  await saveProject(p);
}
