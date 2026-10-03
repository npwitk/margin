import type {
  AuthMethods, Checkpoint, CompileResult, Engine, FileEntry, Project, Session, SyncTexForward, SyncTexInverse,
} from "@margin/shared";

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
  updateProject: (id: string, patch: Partial<{ name: string; mainFile: string; engine: Engine }>) =>
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

  history: (id: string) => req<Checkpoint[]>(`${P(id)}/history`),
  checkpoint: (id: string, message: string) => req<{ checkpoint: Checkpoint | null }>(`${P(id)}/checkpoint`, json("POST", { message })),
};
