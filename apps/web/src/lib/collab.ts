import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { useEffect, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { ROOM, colorFor, docName, type AgentActivity, type PresenceState, type RoomEvents, type Session, type Task } from "@margin/shared";

export interface Peer extends PresenceState {
  clientId: number;
}

/**
 * One WebSocket per open project, multiplexing a document per text file plus
 * the project "room" (board, members, presence, live events).
 */
export class ProjectCollab {
  readonly socket: HocuspocusProviderWebsocket;
  readonly room: HocuspocusProvider;
  readonly user: { name: string; color: string; colorLight: string; avatar?: string };
  private docs = new Map<string, HocuspocusProvider>();
  private ready = new Map<string, Promise<HocuspocusProvider>>();
  private syncListeners = new Set<() => void>();

  constructor(readonly projectId: string, session: Session) {
    const color = colorFor(session.name);
    this.user = { name: session.name, color, colorLight: `${color}33`, avatar: session.avatar };
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.socket = new HocuspocusProviderWebsocket({ url: `${proto}://${location.host}/api/collab` });
    this.room = this.provider(ROOM);
    this.room.awareness?.setLocalState({ user: this.user, file: null, view: "write" } satisfies PresenceState);
    this.room.on("synced", () => {
      this.room.document.getMap("members").set(session.name, { color, lastSeen: new Date().toISOString(), ...(session.avatar ? { avatar: session.avatar } : {}) });
    });
  }

  private provider(path: string) {
    const p = new HocuspocusProvider({ websocketProvider: this.socket, name: docName(this.projectId, path), token: "session-cookie" });
    p.attach();
    return p;
  }

  /** Open (or reuse) the live document for a text file; resolves once it has synced. */
  open(path: string): Promise<HocuspocusProvider> {
    let pending = this.ready.get(path);
    if (!pending) {
      const p = this.provider(path);
      p.awareness?.setLocalStateField("user", this.user);
      p.on("unsyncedChanges", () => this.syncListeners.forEach((cb) => cb()));
      this.docs.set(path, p);
      pending = new Promise((resolve, reject) => {
        if (p.isSynced) resolve(p);
        p.on("synced", () => resolve(p));
        p.on("authenticationFailed", ({ reason }: { reason: string }) => {
          this.close(path);
          reject(new Error(`Can't open ${path} (${reason})`));
        });
      });
      this.ready.set(path, pending);
    }
    return pending;
  }

  close(path: string) {
    this.docs.get(path)?.destroy();
    this.docs.delete(path);
    this.ready.delete(path);
  }

  /** Close every document at or under a path (after rename/delete). */
  closeUnder(path: string) {
    for (const p of [...this.docs.keys()]) if (p === path || p.startsWith(`${path}/`)) this.close(p);
  }

  isUnsynced(path: string) {
    return this.docs.get(path)?.hasUnsyncedChanges ?? false;
  }

  /** Wait until the server has every local edit (so compile sees it). */
  async flush(timeoutMs = 5000) {
    const start = Date.now();
    while ([...this.docs.values()].some((p) => p.hasUnsyncedChanges) && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Called whenever any open document gains or clears unsent edits. */
  onUnsyncedChange(cb: () => void) {
    this.syncListeners.add(cb);
    return () => { this.syncListeners.delete(cb); };
  }

  unsyncedPaths(): Set<string> {
    return new Set([...this.docs.entries()].filter(([, p]) => p.hasUnsyncedChanges).map(([path]) => path));
  }

  setPresence(patch: Partial<PresenceState>) {
    const a = this.room.awareness;
    if (!a) return;
    a.setLocalState({ ...(a.getLocalState() as PresenceState), ...patch });
  }

  get tasks() { return this.room.document.getMap<Task>("tasks"); }
  get members() { return this.room.document.getMap<{ color: string; lastSeen: string; avatar?: string }>("members"); }
  get agents() { return this.room.document.getMap<AgentActivity>("agents"); }
  get events() { return this.room.document.getMap<RoomEvents[keyof RoomEvents]>("events"); }

  destroy() {
    for (const p of this.docs.keys()) this.close(p);
    this.room.destroy();
    this.socket.destroy();
  }
}

export function useCollab(projectId: string, session: Session) {
  const [collab, setCollab] = useState<ProjectCollab | null>(null);
  useEffect(() => {
    const c = new ProjectCollab(projectId, session);
    setCollab(c);
    return () => c.destroy();
  }, [projectId, session.name]);
  return collab;
}

/** Everyone else currently in the project. */
export function usePeers(collab: ProjectCollab | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const a = collab?.room.awareness;
    if (!a) return;
    const update = () => {
      const list: Peer[] = [];
      a.getStates().forEach((state, clientId) => {
        if (clientId !== a.clientID && (state as PresenceState)?.user) list.push({ clientId, ...(state as PresenceState) });
      });
      setPeers(list.sort((x, y) => x.user.name.localeCompare(y.user.name)));
    };
    update();
    a.on("change", update);
    return () => a.off("change", update);
  }, [collab]);
  return peers;
}

/** Subscribe to a Y.Map and re-render with a snapshot of its values. */
export function useYMap<T>(map: Y.Map<T> | undefined): Map<string, T> {
  const subscribe = (cb: () => void) => {
    if (!map) return () => {};
    map.observe(cb);
    return () => map.unobserve(cb);
  };
  const cache = useSnapshotCache<Map<string, T>>();
  return useSyncExternalStore(subscribe, () => cache(map ? map.toJSON() : {}, () => new Map(map ? map.entries() : [])));
}

/** useSyncExternalStore needs a stable snapshot; rebuild only when the JSON changes. */
function useSnapshotCache<T>() {
  const [state] = useState(() => ({ key: "", value: undefined as T | undefined }));
  return (json: unknown, build: () => T): T => {
    const key = JSON.stringify(json);
    if (key !== state.key || state.value === undefined) {
      state.key = key;
      state.value = build();
    }
    return state.value;
  };
}
