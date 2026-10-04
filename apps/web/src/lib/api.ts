import type {
  AiSettings, AuthMethods, ProjectAccess, Chat, ChatEvent, ChatSummary, CitationReport, PaperReview, ReviewSkill, Checkpoint, CompileResult, Engine, FileEntry, Project, Session, SyncTexForward, SyncTexInverse,
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
  createProject: (name: string, template: string) => req<Project>("/projects", json("POST", { name, template })),
  project: (id: string) => req<Project>(P(id)),
  importZip: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return req<Project & { imported: number }>("/projects/import", { method: "POST", body: form });
  },
  importFrom: (body: { arxiv?: string; git?: string }) => req<Project & { imported: number }>("/projects/import", json("POST", body)),
  fromIdea: (body: { idea: string; goal?: string; template?: string; members?: string[] }) => req<Project>("/ai/from-idea", json("POST", body)),
  updateProject: (id: string, patch: Partial<{ name: string; mainFile: string; engine: Engine; goal: string }>) =>
    req<Project>(P(id), json("PATCH", patch)),

  files: (id: string) => req<FileEntry[]>(`${P(id)}/files`),
  readFile: (id: string, path: string) => req<{ content: string; etag: string }>(`${P(id)}/file?path=${q(path)}`),
  writeFile: (id: string, path: string, content: string, baseEtag?: string) =>
    req<{ etag: string }>(`${P(id)}/file?path=${q(path)}`, json("PUT", { content, baseEtag })),
  createEntry: (id: string, path: string, type: "file" | "dir") => req(`${P(id)}/entries`, json("POST", { path, type })),
  move: (id: string, from: string, to: string) => req(`${P(id)}/move`, json("POST", { from, to })),
  remove: (id: string, path: string) => req(`${P(id)}/entries?path=${q(path)}`, { method: "DELETE" }),
  upload: (id: string, dir: string, files: File[]) => {
    const form = new FormData();
    form.set("dir", dir);
    files.forEach((f) => form.append("files", f));
    return req<{ saved: string[] }>(`${P(id)}/upload`, { method: "POST", body: form });
  },
  rawUrl: (id: string, path: string) => `/api${P(id)}/raw?path=${q(path)}`,

  compile: (id: string) => req<CompileResult>(`${P(id)}/compile`, json("POST")),
  pdfUrl: (id: string, version: number) => `/api${P(id)}/output.pdf?v=${version}`,
  forward: (id: string, file: string, line: number) =>
    req<SyncTexForward | null>(`${P(id)}/synctex/forward?file=${q(file)}&line=${line}`),
  inverse: (id: string, page: number, x: number, y: number) =>
    req<SyncTexInverse | null>(`${P(id)}/synctex/inverse?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`),

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
  async sendChat(id: string, chatId: string, text: string, onEvent: (e: ChatEvent) => void) {
    const res = await fetch(`/api${P(id)}/ai/chats/${chatId}/messages`, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
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
  startReview: (id: string, skill: string, goal?: string) => req<StoredReview>(`${P(id)}/ai/reviews`, json("POST", { skill, goal })),
  addThread: (id: string, body: { path: string; quote: string; kind: "comment" | "suggestion"; message?: string; replacement?: string }) =>
    req<{ id: string }>(`${P(id)}/review`, json("POST", body)),
  citations: (id: string) => req<CitationReport>(`${P(id)}/citations`),
  addDoi: (id: string, doi: string) => req<{ key: string; file: string; bibtex: string }>(`${P(id)}/citations/doi`, json("POST", { doi })),

  access: (id: string) => req<ProjectAccess>(`${P(id)}/access`),
  createInvite: (id: string) => req<{ id: string; token: string; expiresAt: string }>(`${P(id)}/invites`, json("POST")),
  revokeInvite: (id: string, inviteId: string) => req(`${P(id)}/invites/${inviteId}`, { method: "DELETE" }),
  join: (id: string, token: string) => req<Project>(`${P(id)}/join`, json("POST", { token })),
  removeMember: (id: string, memberId: string) => req(`${P(id)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" }),
  setRole: (id: string, memberId: string, role: "owner" | "editor") => req(`${P(id)}/members/${encodeURIComponent(memberId)}`, json("PATCH", { role })),

  history: (id: string) => req<Checkpoint[]>(`${P(id)}/history`),
  checkpoint: (id: string, message: string) => req<{ checkpoint: Checkpoint | null }>(`${P(id)}/checkpoint`, json("POST", { message })),
};
