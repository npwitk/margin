export type Engine = "pdflatex" | "xelatex" | "lualatex";

export interface Project {
  id: string;
  name: string;
  /** The default document (opened and compiled first). */
  mainFile: string;
  engine: Engine;
  /** Extra settings per document (engine, title). Documents themselves are found by scanning for \documentclass. */
  documents?: DocumentSettings[];
  /** What the paper is aiming for, e.g. "NeurIPS 2027 main track". Used by the AI reviewer. */
  goal?: string;
  /** Set while Claude is turning an idea into a first draft. */
  setup?: { status: "planning" | "done" | "error"; error?: string };
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSettings { path: string; engine?: Engine; title?: string }

/** A compilable root .tex file in a project: the paper, slides, a cover letter… */
export interface DocumentInfo {
  path: string;
  title: string;
  engine: Engine;
  /** The project's default document (Project.mainFile). */
  isDefault: boolean;
  hasPdf: boolean;
  /** e.g. "beamer", "article". */
  docClass?: string;
}

export const DOCUMENT_TEMPLATES = [
  { id: "article", label: "Article", hint: "A paper or report" },
  { id: "beamer", label: "Slides", hint: "Beamer presentation" },
  { id: "letter", label: "Letter", hint: "Cover letter or rebuttal" },
  { id: "poster", label: "Poster", hint: "A0 conference poster" },
  { id: "ieee", label: "IEEE conference", hint: "IEEEtran two-column" },
  { id: "blank", label: "Blank", hint: "Just \\documentclass" },
] as const;
export type DocumentTemplate = (typeof DOCUMENT_TEMPLATES)[number]["id"];

/** \documentclass that isn't commented out → this .tex is a document root. Returns the class name. */
export function documentClassOf(tex: string): string | null {
  const m = /^[^%\n]*?\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/m.exec(tex);
  return m ? m[1].trim() : null;
}

/** The \title{…} of a document, as plain text, if it has one. */
export function documentTitleOf(tex: string): string | null {
  const m = /^[^%\n]*?\\title\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/m.exec(tex);
  if (!m) return null;
  const t = m[1].replace(/\\\\/g, " ").replace(/\\[a-zA-Z]+\*?/g, "").replace(/[{}~]/g, " ").replace(/\s+/g, " ").trim();
  return t || null;
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
  /** GitHub login, when signed in with GitHub. */
  github?: string;
  avatar?: string;
  /** Set when the request comes from an external agent (e.g. "Claude Code") using an access token. */
  agent?: string;
}

export type MemberRole = "owner" | "editor";

export interface Member {
  /** "gh:<login>" for GitHub accounts, "name:<name>" for password sign-in. */
  id: string;
  name: string;
  role: MemberRole;
  avatar?: string;
  joinedAt: string;
}

export interface ProjectAccess {
  /** "workspace": everyone signed in can open every project. "members": only listed members. */
  mode: "workspace" | "members";
  members: Member[];
  invites: { id: string; createdBy: string; createdAt: string; expiresAt: string }[];
  you?: Member;
}

export interface WorkspaceMember {
  /** GitHub login, lowercase. */
  login: string;
  name: string;
  avatar?: string;
  role: "admin" | "member";
  joinedAt: string;
  invitedBy?: string;
}

export interface WorkspaceInfo {
  inviteOnly: boolean;
  admin: boolean;
  members: WorkspaceMember[];
  invites: { id: string; createdBy: string; createdAt: string; expiresAt: string; maxUses: number; uses: number }[];
  /** Admins fixed in the server config (MARGIN_ADMINS). */
  configAdmins: string[];
}

export interface AuthMethods {
  /** The workspace only admits invited GitHub accounts. */
  inviteOnly?: boolean;
  password: boolean;
  github: boolean;
  /** No login configured at all (local development only). */
  open: boolean;
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

/** Everyone assigned to a task (older tasks only have `assignee`). */
export const assigneesOf = (t: Pick<Task, "assignee" | "assignees">): string[] => t.assignees?.length ? t.assignees : t.assignee ? [t.assignee] : [];
/** Patch that sets the assignee list and keeps `assignee` in step. */
export const withAssignees = (names: string[]): Pick<Task, "assignee" | "assignees"> => ({ assignees: names, assignee: names[0] });

/** A comment on a board task. Top-level comments start threads; replies point at their thread. */
export interface TaskComment {
  id: string;
  taskId: string;
  /** Set on replies: the thread's first comment. */
  parentId?: string;
  author: string;
  /** Markdown. */
  body: string;
  createdAt: string;
  editedAt?: string;
  /** Emoji → names of who reacted. */
  reactions?: Record<string, string[]>;
  /** Threads only. */
  resolved?: { by: string; at: string };
  /** Deleted, but kept so replies still have their thread. */
  deleted?: boolean;
}

export const REACTIONS = ["👍", "🎉", "❤️", "👀", "🚀", "✅", "😄", "🙏"];

export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest";
export const TASK_PRIORITIES: { id: TaskPriority; label: string }[] = [
  { id: "highest", label: "Highest" }, { id: "high", label: "High" }, { id: "medium", label: "Medium" }, { id: "low", label: "Low" }, { id: "lowest", label: "Lowest" },
];

/** A card on the project board. Stored in the project's `.margin/board.json`. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** First assignee, kept for older clients and agents; same as assignees[0]. */
  assignee?: string;
  /** Everyone working on it. */
  assignees?: string[];
  /** Files this task touches, e.g. ["sections/method.tex"]. */
  files?: string[];
  notes?: string;
  due?: string;
  priority?: TaskPriority;
  /** Short labels, e.g. ["writing", "experiment"]. */
  labels?: string[];
  /** Per-project number shown as PREFIX-12; older tasks get one from creation order. */
  number?: number;
  /** Sort key within a column. */
  order: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What each connected member broadcasts on the project room's awareness. */
export interface PresenceState {
  user: { name: string; color: string; avatar?: string; agent?: boolean };
  file?: string | null;
  line?: number;
  view?: "write" | "board" | "review";
}

/** Live events the server pushes through the project room. */
export interface RoomEvents {
  filesVersion?: number;
  lastCompile?: { by: string; at: number; ok: boolean; doc?: string };
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
