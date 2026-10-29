import type {
  CheckpointFileDiff, PendingChanges,
  DocumentInfo, OutlineEntry, ConferenceEdition, ProjectVenue,
  CiteOptions, LibraryAddResult, LibraryRef, LibraryView,
  AgentMode, AiSettings, AuthMethods, ProjectAccess, WorkspaceInfo, Chat, ChatEvent, ChatSummary, CitationReport, PaperReview, ReviewSkill, Checkpoint, CompileResult, Engine, FileEntry, MemberRole, Project, ProjectSection, ProjectUpdate, Session, SyncTexForward, SyncTexInverse,
} from "@margin/shared";

export type StoredReview = Omit<PaperReview, "result"> & { status: "running" | "done" | "error"; error?: string; result?: PaperReview["result"] };

export interface AccessToken { id: string; label: string; createdAt: string; lastUsedAt?: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isJson = typeof init.body === "string";
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: isJson ? { "content-type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/login")) window.dispatchEvent(new Event("margin:unauthorized"));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: JSON.stringify(body ?? {}) });
const q = (p: string) => encodeURIComponent(p);
const P = (id: string) => `/projects/${id}`;

export const api = {
  session: () => req<{ session: Session | null; passwordRequired: boolean; methods: AuthMethods }>("/session"),
  login: (name: string, password: string) => req<{ session: Session }>("/login", json("POST", { name, password })),
  logout: () => req("/logout", json("POST")),

  projects: () => req<Project[]>("/projects"),
  createProject: (name: string, template: string, venue?: ProjectVenue) => req<Project>("/projects", json("POST", { name, template, venue })),
  conferences: (q = "") => req<ConferenceEdition[]>(`/conferences${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  project: (id: string) => req<Project>(P(id)),
  revertAgent: (id: string, key: string) => req<{ files: string[] }>(`${P(id)}/agent/revert`, json("POST", { key })),
  importZip: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return req<Project & { imported: number }>("/projects/import", { method: "POST", body: form });
  },
  importFrom: (body: { arxiv?: string; git?: string }) => req<Project & { imported: number }>("/projects/import", json("POST", body)),
  fromIdea: (body: { idea: string; goal?: string; template?: string; members?: string[] }) => req<Project>("/ai/from-idea", json("POST", body)),
  updateProject: (id: string, patch: Partial<{ name: string; mainFile: string; engine: Engine; goal: string; agentMode: AgentMode }>) =>
    req<Project>(P(id), json("PATCH", patch)),

  files: (id: string) => req<FileEntry[]>(`${P(id)}/files`),
  readFile: (id: string, path: string) => req<{ content: string; etag: string }>(`${P(id)}/file?path=${q(path)}`),
  writeFile: (id: string, path: string, content: string, baseEtag?: string) =>
    req<{ etag: string }>(`${P(id)}/file?path=${q(path)}`, json("PUT", { content, baseEtag })),
  createEntry: (id: string, path: string, type: "file" | "dir") => req<{ ok: true; existed?: boolean }>(`${P(id)}/entries`, json("POST", { path, type })),
  move: (id: string, from: string, to: string) => req(`${P(id)}/move`, json("POST", { from, to })),
  remove: (id: string, path: string) => req(`${P(id)}/entries?path=${q(path)}`, { method: "DELETE" }),
  /** Upload files (each with its path inside `dir`, so dropped folders keep their structure), in batches under the server's size limit. */
  upload: async (id: string, dir: string, items: { path: string; file: File }[], dirs: string[] = []) => {
    const LIMIT = 40 * 1024 * 1024;
    const batches: { path: string; file: File }[][] = [[]];
    let size = 0;
    for (const it of items) {
      if (size + it.file.size > LIMIT && batches.at(-1)!.length) { batches.push([]); size = 0; }
      batches.at(-1)!.push(it);
      size += it.file.size;
    }
    const saved: string[] = [];
    for (const [i, batch] of batches.entries()) {
      const form = new FormData();
      form.set("dir", dir);
      if (i === 0) dirs.forEach((d) => form.append("dirs", d));
      batch.forEach((it) => { form.append("files", it.file); form.append("paths", it.path); });
      saved.push(...(await req<{ saved: string[] }>(`${P(id)}/upload`, { method: "POST", body: form })).saved);
    }
    return { saved };
  },
  rawUrl: (id: string, path: string) => `/api${P(id)}/raw?path=${q(path)}`,
  /** A file as-is, or a folder (or the whole project, with no path) as a .zip. */
  downloadUrl: (id: string, path = "") => `/api${P(id)}/download${path ? `?path=${q(path)}` : ""}`,

  compile: (id: string, doc?: string) => req<CompileResult & { doc: string }>(`${P(id)}/compile`, json("POST", { doc })),
  pdfUrl: (id: string, version: number, doc?: string) => `/api${P(id)}/output.pdf?v=${version}${doc ? `&doc=${q(doc)}` : ""}`,
  forward: (id: string, file: string, line: number, doc?: string) =>
    req<SyncTexForward | null>(`${P(id)}/synctex/forward?file=${q(file)}&line=${line}${doc ? `&doc=${q(doc)}` : ""}`),
  inverse: (id: string, page: number, x: number, y: number, doc?: string) =>
    req<SyncTexInverse | null>(`${P(id)}/synctex/inverse?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}${doc ? `&doc=${q(doc)}` : ""}`),
  documents: (id: string) => req<DocumentInfo[]>(`${P(id)}/documents`),
  outline: (id: string, doc?: string) => req<{ doc: string; entries: OutlineEntry[] }>(`${P(id)}/outline${doc ? `?doc=${q(doc)}` : ""}`),
  createDocument: (id: string, body: { title?: string; template?: string; path?: string; layout?: "folder" | "beside"; copyFrom?: string }) =>
    req<{ path: string; documents: DocumentInfo[] }>(`${P(id)}/documents`, json("POST", body)),
  createArea: (id: string, title: string, path?: string) => req<{ section: ProjectSection; project: Project }>(`${P(id)}/sections`, json("POST", { title, path })),
  updateArea: (id: string, path: string, patch: { title?: string; index?: number }) => req<Project>(`${P(id)}/sections`, json("PATCH", { path, ...patch })),
  removeArea: (id: string, path: string) => req<Project>(`${P(id)}/sections?path=${q(path)}`, { method: "DELETE" }),
  addSection: (id: string, doc: string, title: string) => req<{ path: string; documents: DocumentInfo[] }>(`${P(id)}/documents/section`, json("POST", { doc, title })),
  updateDocument: (id: string, body: { path: string; engine?: Engine; title?: string; makeDefault?: boolean; archived?: boolean }) =>
    req<{ project: Project; documents: DocumentInfo[] }>(`${P(id)}/documents`, json("PATCH", body)),

  tokens: () => req<AccessToken[]>("/tokens"),
  createToken: (label: string) => req<AccessToken & { token: string }>("/tokens", json("POST", { label })),
  revokeToken: (tid: string) => req(`/tokens/${tid}`, { method: "DELETE" }),

  aiSettings: () => req<AiSettings>("/ai/settings"),
  saveAiKey: (apiKey: string) => req<{ ok: true; last4: string }>("/ai/key", json("PUT", { apiKey })),
  deleteAiKey: () => req("/ai/key", { method: "DELETE" }),
  chats: (id: string) => req<ChatSummary[]>(`${P(id)}/ai/chats`),
  createChat: (id: string, title?: string) => req<Chat>(`${P(id)}/ai/chats`, json("POST", { title })),
  chat: (id: string, chatId: string) => req<Chat>(`${P(id)}/ai/chats/${chatId}`),
  deleteChat: (id: string, chatId: string) => req(`${P(id)}/ai/chats/${chatId}`, { method: "DELETE" }),
  stopChat: (id: string, chatId: string) => req(`${P(id)}/ai/chats/${chatId}/stop`, json("POST")),
  /** Send a message; calls onEvent for each streamed event until the turn is done. */
  async sendChat(id: string, chatId: string, text: string, onEvent: (e: ChatEvent) => void, doc?: string) {
    const res = await fetch(`/api${P(id)}/ai/chats/${chatId}/messages`, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, doc }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (data) onEvent(JSON.parse(data) as ChatEvent);
      }
    }
  },
  skills: (id: string) => req<ReviewSkill[]>(`${P(id)}/ai/skills`),
  reviews: (id: string) => req<StoredReview[]>(`${P(id)}/ai/reviews`),
  review: (id: string, reviewId: string) => req<StoredReview>(`${P(id)}/ai/reviews/${reviewId}`),
  startReview: (id: string, skill: string, goal?: string, runner?: { deviceId: string; agentId: string }, doc?: string) =>
    req<StoredReview>(`${P(id)}/ai/reviews`, json("POST", { skill, goal, runner, doc })),
  cancelReview: (id: string, reviewId: string) => req(`${P(id)}/ai/reviews/${reviewId}/cancel`, json("POST")),
  addThread: (id: string, body: { path: string; quote?: string; from?: number; to?: number; kind: "comment" | "suggestion"; message?: string; replacement?: string }) =>
    req<{ id: string }>(`${P(id)}/review`, json("POST", body)),
  threadAction: (id: string, thread: string, body: { path: string; action: "reply" | "delete" | "open" | "resolved" | "rejected"; text?: string }) =>
    req(`${P(id)}/review/${encodeURIComponent(thread)}`, json("POST", body)),
  updates: (id: string) => req<ProjectUpdate[]>(`${P(id)}/updates`),
  postUpdate: (id: string, body: string) => req<ProjectUpdate>(`${P(id)}/updates`, json("POST", { body })),
  commentOnUpdate: (id: string, update: string, body: string) => req(`${P(id)}/updates/${update}/comments`, json("POST", { body })),
  summarizeUpdates: (id: string) => req<{ update: ProjectUpdate | null }>(`${P(id)}/updates/summarize`, json("POST")),
  tasksFromUpdate: (id: string, update: string) => req<{ tasks: { id: string; title: string }[] }>(`${P(id)}/updates/${update}/tasks`, json("POST")),
  citations: (id: string) => req<CitationReport>(`${P(id)}/citations`),
  addDoi: (id: string, doi: string) => req<{ key: string; file: string; bibtex: string }>(`${P(id)}/citations/doi`, json("POST", { doi })),

  library: () => req<LibraryView>("/library"),
  libraryAddDois: (dois: string[], projectId?: string) => req<LibraryAddResult & { failed: string[] }>("/library/doi", json("POST", { dois, projectId })),
  libraryAddBibtex: (text: string, projectId?: string) => req<LibraryAddResult>("/library/bibtex", json("POST", { text, projectId })),
  libraryImportProject: (projectId: string) => req<LibraryAddResult>("/library/import-project", json("POST", { projectId })),
  libraryUpdate: (id: string, patch: Partial<Pick<LibraryRef, "key" | "type" | "fields" | "projects" | "note">>) => req<LibraryRef>(`/library/${id}`, json("PATCH", patch)),
  libraryDelete: (id: string) => req(`/library/${id}`, { method: "DELETE" }),
  citeOptions: (id: string) => req<CiteOptions>(`${P(id)}/library`),
  insertFromLibrary: (id: string, refId: string) => req<{ key: string; file: string; added: boolean; note?: string }>(`${P(id)}/library/${refId}`, json("POST")),

  access: (id: string) => req<ProjectAccess>(`${P(id)}/access`),
  createInvite: (id: string, role: "editor" | "advisor" = "editor") => req<{ id: string; token: string; expiresAt: string; admits?: boolean }>(`${P(id)}/invites`, json("POST", { role })),
  revokeInvite: (id: string, inviteId: string) => req(`${P(id)}/invites/${inviteId}`, { method: "DELETE" }),
  join: (id: string, token: string) => req<Project>(`${P(id)}/join`, json("POST", { token })),
  removeMember: (id: string, memberId: string) => req(`${P(id)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" }),
  setRole: (id: string, memberId: string, role: MemberRole) => req(`${P(id)}/members/${encodeURIComponent(memberId)}`, json("PATCH", { role })),

  workspace: () => req<WorkspaceInfo>("/workspace"),
  createWorkspaceInvite: (days: number, maxUses: number) => req<{ id: string; token: string; expiresAt: string; maxUses: number }>("/workspace/invites", json("POST", { days, maxUses })),
  revokeWorkspaceInvite: (id: string) => req(`/workspace/invites/${id}`, { method: "DELETE" }),
  removeWorkspaceMember: (login: string) => req(`/workspace/members/${encodeURIComponent(login)}`, { method: "DELETE" }),
  setWorkspaceRole: (login: string, role: "admin" | "member") => req(`/workspace/members/${encodeURIComponent(login)}`, json("PATCH", { role })),

  history: (id: string, skip = 0) => req<{ versions: Checkpoint[]; pending: PendingChanges | null }>(`${P(id)}/history${skip ? `?skip=${skip}` : ""}`),
  versionChanges: (id: string, hash: string) => req<CheckpointFileDiff[]>(`${P(id)}/history/${hash}`),
  restoreVersion: (id: string, hash: string, path?: string) => req<{ restored: number; checkpoint: Checkpoint | null }>(`${P(id)}/history/${hash}/restore`, json("POST", { path })),
  checkpoint: (id: string, message: string) => req<{ checkpoint: Checkpoint | null }>(`${P(id)}/checkpoint`, json("POST", { message })),
};
