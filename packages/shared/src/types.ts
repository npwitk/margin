export type Engine = "pdflatex" | "xelatex" | "lualatex";

export interface Project {
  id: string;
  name: string;
  mainFile: string;
  engine: Engine;
  createdAt: string;
  updatedAt: string;
}

export interface FileEntry {
  /** Project-relative path using forward slashes. */
  path: string;
  type: "file" | "dir";
  size: number;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Project-relative path when the log tells us which file. */
  file?: string;
  line?: number;
}

export interface CompileResult {
  ok: boolean;
  hasPdf: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
  log: string;
}

export interface SyncTexForward {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncTexInverse {
  file: string;
  line: number;
}

export interface Checkpoint {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface Session {
  name: string;
}

const TEXT_EXTENSIONS = new Set([
  "tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "def", "cfg", "clo", "ltx",
  "txt", "md", "csv", "tsv", "dat", "json", "yaml", "yml", "toml",
  "py", "r", "m", "jl", "sh", "js", "ts", "gitignore", "latexmkrc",
]);

export function isTextPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : base.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

// ── Collaboration (P1) ──────────────────────────────────────────────────────

export type TaskStatus = "todo" | "doing" | "review" | "done";

export const TASK_COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "In progress" },
  { id: "review", label: "In review" },
  { id: "done", label: "Done" },
];

/** A card on the project board. Stored in the project's `.margin/board.json`. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** Member name (later: agent ids like "claude:alice"). */
  assignee?: string;
  /** Files this task touches, e.g. ["sections/method.tex"]. */
  files?: string[];
  notes?: string;
  due?: string;
  /** Sort key within a column. */
  order: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What each connected member broadcasts on the project room's awareness. */
export interface PresenceState {
  user: { name: string; color: string };
  file?: string | null;
  line?: number;
  view?: "write" | "board";
}

/** Live events the server pushes through the project room. */
export interface RoomEvents {
  filesVersion?: number;
  lastCompile?: { by: string; at: number; ok: boolean };
}

/** Collaboration document names: one per text file, plus one room per project. */
export const ROOM = ".margin";
export const docName = (projectId: string, path: string) => `${projectId}/${path}`;
export function parseDocName(name: string): { projectId: string; path: string } | null {
  const i = name.indexOf("/");
  if (i <= 0 || i === name.length - 1) return null;
  return { projectId: name.slice(0, i), path: name.slice(i + 1) };
}

const COLORS = ["#5e6ad2", "#d4483b", "#2e9d62", "#b7791f", "#a1468c", "#2b7bb9", "#c05621", "#0f8b8d"];
/** Stable color per member name. */
export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
