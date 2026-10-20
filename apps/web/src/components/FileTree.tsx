import { useMemo, useState, type DragEvent, type MouseEvent } from "react";
import { isTextPath, type DocumentInfo, type FileEntry } from "@margin/shared";
import { Icon } from "./Icon.tsx";
import { load, save } from "../lib/storage.ts";
import type { Peer } from "../lib/collab.ts";
import { Avatar } from "./Presence.tsx";

export type TreeAction = "newFile" | "newFolder" | "upload" | "rename" | "delete" | "setMain" | "compileDoc" | "download";

interface Node { name: string; path: string; type: "file" | "dir"; children: Node[] }

interface Props {
  projectId: string;
  files: FileEntry[];
  openPath: string | null;
  mainFile: string;
  /** Every document (.tex with \documentclass) with the files it uses, and the one being compiled. */
  documents?: DocumentInfo[];
  activeDoc?: string;
  dirty: Set<string>;
  peersByFile: Map<string, Peer[]>;
  onOpen(path: string): void;
  onAction(action: TreeAction, path: string): void;
  onDropFiles(dir: string, files: File[]): void;
  /** Drag a file or folder in the tree onto a folder ("" = project root). */
  onMove(from: string, toDir: string): void;
}

/** Drag data type for moving entries inside the tree (distinct from files dragged in from the desktop). */
const MOVE_TYPE = "application/x-margin-path";

function buildTree(files: FileEntry[]): Node[] {
  const root: Node = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  const dirOf = (p: string): Node => {
    if (dirs.has(p)) return dirs.get(p)!;
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    const node: Node = { name: p.split("/").pop()!, path: p, type: "dir", children: [] };
    dirs.set(p, node);
    dirOf(parent).children.push(node);
    return node;
  };
  for (const f of files) {
    if (f.type === "dir") { dirOf(f.path); continue; }
    const parentPath = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    dirOf(parentPath).children.push({ name: f.path.split("/").pop()!, path: f.path, type: "file", children: [] });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

function fileIcon(path: string) {
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.bib$/i.test(path)) return "book";
  return "file";
}

interface Group { id: string; title: string; subtitle?: string; doc?: DocumentInfo; files: FileEntry[] }

/**
 * With several documents, the tree shows one section per document (the files
 * it uses), then files shared by several documents, then everything else.
 */
function groupByDocument(files: FileEntry[], docs: DocumentInfo[]): Group[] {
  const users = new Map<string, string[]>();
  for (const d of docs) for (const f of d.files ?? [d.path]) users.set(f, [...(users.get(f) ?? []), d.path]);
  const groups: Group[] = docs.map((d) => ({ id: `doc:${d.path}`, title: d.title, subtitle: d.path, doc: d, files: [] }));
  const shared: Group = { id: "shared", title: "Shared", subtitle: "Used by more than one document", files: [] };
  const other: Group = { id: "other", title: "Other files", subtitle: "Not used by any document", files: [] };
  const filePaths = files.filter((f) => f.type === "file").map((f) => f.path);
  for (const f of files) {
    if (f.type === "dir") {
      // Empty folders have nothing to belong to; show them with the other files.
      if (!filePaths.some((p) => p.startsWith(`${f.path}/`))) other.files.push(f);
      continue;
    }
    const u = users.get(f.path) ?? [];
    if (u.length === 1) groups.find((g) => g.doc?.path === u[0])!.files.push(f);
    else if (u.length > 1) shared.files.push(f);
    else other.files.push(f);
  }
  return [...groups, shared, other].filter((g) => g.files.length);
}

export function FileTree({ projectId, files, openPath, mainFile, documents = [], activeDoc, dirty, peersByFile, onOpen, onAction, onDropFiles, onMove }: Props) {
  const docPaths = useMemo(() => documents.map((d) => d.path), [documents]);
  const [mode, setMode] = useState<"documents" | "folders">(() => load(`treeMode:${projectId}`, "documents"));
  const grouped = mode === "documents" && documents.length > 1;
  const tree = useMemo(() => buildTree(files), [files]);
  const groups = useMemo(() => (grouped ? groupByDocument(files, documents).map((g) => ({ ...g, tree: buildTree(g.files) })) : []), [grouped, files, documents]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(load<string[]>(`collapsed:${projectId}`, [])));
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    next.has(key) ? next.delete(key) : next.add(key);
    setCollapsed(next);
    save(`collapsed:${projectId}`, [...next]);
  };
  const setTreeMode = (m: "documents" | "folders") => { setMode(m); save(`treeMode:${projectId}`, m); };

  const openMenu = (e: MouseEvent, node: Node | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  // ── Drag and drop: files from the desktop upload; entries from the tree move ──
  const canMoveInto = (from: string, dir: string) => {
    const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    return dir !== parent && dir !== from && !dir.startsWith(`${from}/`);
  };
  const onDrop = (e: DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const from = e.dataTransfer.getData(MOVE_TYPE);
    if (from) { setDragging(null); if (canMoveInto(from, dir)) onMove(from, dir); return; }
    const list = [...e.dataTransfer.files];
    if (list.length) onDropFiles(dir, list);
  };
  const dropProps = (dir: string) => ({
    onDragOver: (e: DragEvent) => {
      const moving = e.dataTransfer.types.includes(MOVE_TYPE);
      if (!moving && !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      // Not a valid place for this entry (its own folder, or inside itself): no highlight, no drop.
      if (moving && dragging && !canMoveInto(dragging, dir)) { e.dataTransfer.dropEffect = "none"; setDropTarget(null); return; }
      e.dataTransfer.dropEffect = moving ? "move" : "copy";
      setDropTarget(dir);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropTarget((d) => (d === dir ? null : d));
    },
    onDrop: (e: DragEvent) => onDrop(e, dir),
  });
  const dragProps = (path: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData(MOVE_TYPE, path);
      e.dataTransfer.setData("text/plain", path);
      e.dataTransfer.effectAllowed = "move";
      setDragging(path);
    },
    onDragEnd: () => { setDragging(null); setDropTarget(null); },
  });

  const renderNodes = (nodes: Node[], depth: number, scope: string) =>
    nodes.map((n) => {
      const pad = { paddingLeft: 10 + depth * 14 };
      if (n.type === "dir") {
        const key = scope ? `${scope}|${n.path}` : n.path;
        const open = !collapsed.has(key);
        return (
          <div key={n.path} {...dropProps(n.path)} className={dropTarget === n.path ? "drop-target" : undefined}>
            <button className={`tree-row ${dragging === n.path ? "is-dragging" : ""}`} style={pad} onClick={() => toggle(key)} onContextMenu={(e) => openMenu(e, n)} {...dragProps(n.path)}>
              <Icon name="chevron" size={12} className={`chev ${open ? "open" : ""}`} />
              <Icon name="folder" size={14} className="tree-icon" />
              <span className="tree-name">{n.name}</span>
            </button>
            {open && renderNodes(n.children, depth + 1, scope)}
          </div>
        );
      }
      return (
        <button
          key={n.path}
          className={`tree-row ${openPath === n.path ? "selected" : ""} ${dragging === n.path ? "is-dragging" : ""}`}
          style={pad}
          onClick={() => onOpen(n.path)}
          onContextMenu={(e) => openMenu(e, n)}
          title={n.path}
          {...dragProps(n.path)}
        >
          <span className="chev-space" />
          <Icon name={fileIcon(n.path)} size={14} className="tree-icon" />
          <span className={`tree-name ${isTextPath(n.path) ? "" : "muted"}`}>{n.name}</span>
          {n.path === mainFile ? <span className={`badge ${activeDoc === n.path ? "" : "dim"}`} title="Default document">main</span>
            : docPaths.includes(n.path) && <span className={`badge ${activeDoc === n.path ? "" : "dim"}`} title={activeDoc === n.path ? "The document you're compiling" : "A document: right-click to compile it"}>doc</span>}
          {peersByFile.get(n.path)?.slice(0, 3).map((p) => <Avatar key={p.clientId} name={p.user.name} agent={p.user.agent} size="xs" title={p.user.agent ? p.user.name : `${p.user.name} is editing`} />)}
          {dirty.has(n.path) && <span className="dot" title="Sending edits…" />}
        </button>
      );
    });

  const menuDir = menu?.node ? (menu.node.type === "dir" ? menu.node.path : "") : "";
  const act = (a: TreeAction, path: string) => { setMenu(null); onAction(a, path); };

  return (
    <div className={`tree ${dropTarget === "" ? "drop-target" : ""}`} onContextMenu={(e) => openMenu(e, null)} {...dropProps("")}>
      {documents.length > 1 && (
        <div className="tree-mode segmented">
          <button className={grouped ? "active" : ""} onClick={() => setTreeMode("documents")} title="Group files by the document that uses them">By document</button>
          <button className={!grouped ? "active" : ""} onClick={() => setTreeMode("folders")} title="Plain folder view">Folders</button>
        </div>
      )}
      {grouped
        ? groups.map((g) => {
            const key = `group:${g.id}`;
            const open = !collapsed.has(key);
            return (
              <section key={g.id} className={`tree-group ${g.doc && g.doc.path === activeDoc ? "active" : ""}`}>
                <button className="tree-group-head" onClick={() => toggle(key)} title={g.doc ? `${g.subtitle} · double-click to compile` : g.subtitle}
                  onDoubleClick={() => g.doc && onAction("compileDoc", g.doc.path)}>
                  <Icon name="chevron" size={11} className={`chev ${open ? "open" : ""}`} />
                  <span className="tree-group-title ellipsis">{g.title}</span>
                  {g.doc && g.doc.path === activeDoc && <span className="tree-group-live" title="The document you're compiling" />}
                  <span className="tree-group-count">{g.files.filter((f) => f.type === "file").length}</span>
                </button>
                {open && renderNodes(g.tree, 0, g.id)}
              </section>
            );
          })
        : renderNodes(tree, 0, "")}
      <div className="tree-hint">Drag onto a folder to move · drop files from your computer to upload</div>
      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="menu" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 290) }}>
            {(!menu.node || menu.node.type === "dir") && (
              <>
                <button onClick={() => act("newFile", menuDir)}><Icon name="plus" size={14} />New file</button>
                <button onClick={() => act("newFolder", menuDir)}><Icon name="folderPlus" size={14} />New folder</button>
                <button onClick={() => act("upload", menuDir)}><Icon name="upload" size={14} />Upload…</button>
              </>
            )}
            {menu.node?.type === "file" && docPaths.includes(menu.node.path) && menu.node.path !== activeDoc && (
              <button onClick={() => act("compileDoc", menu.node!.path)}><Icon name="play" size={14} />Compile this document</button>
            )}
            {menu.node?.type === "file" && menu.node.path.endsWith(".tex") && menu.node.path !== mainFile && (
              <button onClick={() => act("setMain", menu.node!.path)}><Icon name="star" size={14} />Make default document</button>
            )}
            <div className="menu-sep" />
            <button onClick={() => act("download", menu.node?.path ?? "")}>
              <Icon name="download" size={14} />
              {!menu.node ? "Download project (.zip)" : menu.node.type === "dir" ? "Download folder (.zip)" : "Download"}
            </button>
            {menu.node && (
              <>
                <button onClick={() => act("rename", menu.node!.path)}><Icon name="file" size={14} />Rename or move…</button>
                <button className="danger" onClick={() => act("delete", menu.node!.path)}><Icon name="x" size={14} />Delete</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
