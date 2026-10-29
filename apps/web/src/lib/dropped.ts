/**
 * What was dropped from the desktop: files, and folders with everything in
 * them (keeping their structure, including empty subfolders), like copying
 * into a folder in Finder. A plain `dataTransfer.files` lists a dropped
 * folder as a single empty "file", so folders are read through the entry API.
 */

export interface Dropped {
  files: { path: string; file: File }[];
  /** Folders that are empty (others are created by the files in them). */
  dirs: string[];
}

/** System clutter that never belongs in a project. */
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\.git)$/;

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** readEntries returns at most ~100 entries per call; keep reading until it's empty. */
async function children(dir: FileSystemDirectoryEntry) {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function walk(entry: FileSystemEntry, prefix: string, out: Dropped) {
  if (JUNK.test(entry.name)) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.files.push({ path, file: await fileOf(entry as FileSystemFileEntry) });
    return;
  }
  const kids = await children(entry as FileSystemDirectoryEntry);
  if (!kids.some((k) => !JUNK.test(k.name))) out.dirs.push(path);
  for (const k of kids) await walk(k, path, out);
}

export async function readDrop(dt: DataTransfer): Promise<Dropped> {
  // Entries must be taken synchronously, before the drop event ends.
  const entries = [...dt.items].filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some((e) => !e)) return { files: [...dt.files].map((file) => ({ path: file.name, file })), dirs: [] };
  const out: Dropped = { files: [], dirs: [] };
  for (const e of entries) await walk(e!, "", out);
  return out;
}
