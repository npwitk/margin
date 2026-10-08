import { useMemo, useState, type DragEvent, type MouseEvent } from "react";
import { isTextPath, type FileEntry } from "@margin/shared";
import { Icon } from "./Icon.tsx";
import { load, save } from "../lib/storage.ts";
import type { Peer } from "../lib/collab.ts";
import { Avatar } from "./Presence.tsx";

export type TreeAction = "newFile" | "newFolder" | "upload" | "rename" | "delete" | "setMain" | "compileDoc";

interface Node { name: string; path: string; type: "file" | "dir"; children: Node[] }

interface Props {
  projectId: string;
  files: FileEntry[];
  openPath: string | null;
  mainFile: string;
  /** Every document root (.tex with \documentclass), and the one being compiled. */
  documents?: string[];
  activeDoc?: string;
  dirty: Set<string>;
  peersByFile: Map<string, Peer[]>;
  onOpen(path: string): void;
  onAction(action: TreeAction, path: string): void;
  onDropFiles(dir: string, files: File[]): void;
}

function buildTree(files: FileEntry[]): Node[] {
  const root: Node = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  for (const f of files) {
    const parentPath = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const node: Node = { name: f.path.split("/").pop()!, path: f.path, type: f.type, children: [] };
    if (f.type === "dir") dirs.set(f.path, node);
    (dirs.get(parentPath) ?? root).children.push(node);
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

export function FileTree({ projectId, files, openPath, mainFile, documents = [], activeDoc, dirty, peersByFile, onOpen, onAction, onDropFiles }: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(load<string[]>(`collapsed:${projectId}`, [])));
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    next.has(path) ? next.delete(path) : next.add(path);
    setCollapsed(next);
    save(`collapsed:${projectId}`, [...next]);
  };

  const openMenu = (e: MouseEvent, node: Node | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const onDrop = (e: DragEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const list = [...e.dataTransfer.files];
    if (list.length) onDropFiles(dir, list);
  };

  const dropProps = (dir: string) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setDropTarget(dir); } },
    onDragLeave: () => setDropTarget((d) => (d === dir ? null : d)),
    onDrop: (e: DragEvent) => onDrop(e, dir),
  });

  const renderNodes = (nodes: Node[], depth: number) =>
    nodes.map((n) => {
      const pad = { paddingLeft: 10 + depth * 14 };
      if (n.type === "dir") {
        const open = !collapsed.has(n.path);
        return (
          <div key={n.path} {...dropProps(n.path)} className={dropTarget === n.path ? "drop-target" : undefined}>
            <button className="tree-row" style={pad} onClick={() => toggle(n.path)} onContextMenu={(e) => openMenu(e, n)}>
              <Icon name="chevron" size={12} className={`chev ${open ? "open" : ""}`} />
              <Icon name="folder" size={14} className="tree-icon" />
              <span className="tree-name">{n.name}</span>
            </button>
            {open && renderNodes(n.children, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={n.path}
          className={`tree-row ${openPath === n.path ? "selected" : ""}`}
          style={pad}
          onClick={() => onOpen(n.path)}
          onContextMenu={(e) => openMenu(e, n)}
          title={n.path}
        >
          <span className="chev-space" />
          <Icon name={fileIcon(n.path)} size={14} className="tree-icon" />
          <span className={`tree-name ${isTextPath(n.path) ? "" : "muted"}`}>{n.name}</span>
          {n.path === mainFile ? <span className={`badge ${activeDoc === n.path ? "" : "dim"}`} title="Default document">main</span>
            : documents.includes(n.path) && <span className={`badge ${activeDoc === n.path ? "" : "dim"}`} title={activeDoc === n.path ? "The document you're compiling" : "A document: right-click to compile it"}>doc</span>}
          {peersByFile.get(n.path)?.slice(0, 3).map((p) => <Avatar key={p.clientId} name={p.user.name} agent={p.user.agent} size="xs" title={p.user.agent ? p.user.name : `${p.user.name} is editing`} />)}
          {dirty.has(n.path) && <span className="dot" title="Sending edits…" />}
        </button>
      );
    });

  const menuDir = menu?.node ? (menu.node.type === "dir" ? menu.node.path : "") : "";
  const act = (a: TreeAction, path: string) => { setMenu(null); onAction(a, path); };

  return (
    <div
      className={`tree ${dropTarget === "" ? "drop-target" : ""}`}
      onContextMenu={(e) => openMenu(e, null)}
      {...dropProps("")}
    >
      {renderNodes(tree, 0)}
      <div className="tree-hint">Drop PDFs, figures or data anywhere here</div>
      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="menu" style={{ left: menu.x, top: menu.y }}>
            {(!menu.node || menu.node.type === "dir") && (
              <>
                <button onClick={() => act("newFile", menuDir)}><Icon name="plus" size={14} />New file</button>
                <button onClick={() => act("newFolder", menuDir)}><Icon name="folderPlus" size={14} />New folder</button>
                <button onClick={() => act("upload", menuDir)}><Icon name="upload" size={14} />Upload…</button>
              </>
            )}
            {menu.node?.type === "file" && documents.includes(menu.node.path) && menu.node.path !== activeDoc && (
              <button onClick={() => act("compileDoc", menu.node!.path)}><Icon name="play" size={14} />Compile this document</button>
            )}
            {menu.node?.type === "file" && menu.node.path.endsWith(".tex") && menu.node.path !== mainFile && (
              <button onClick={() => act("setMain", menu.node!.path)}><Icon name="star" size={14} />Make default document</button>
            )}
            {menu.node && (
              <>
                {menu.node.type === "dir" && <div className="menu-sep" />}
                <button onClick={() => act("rename", menu.node!.path)}><Icon name="file" size={14} />Rename…</button>
                <button className="danger" onClick={() => act("delete", menu.node!.path)}><Icon name="x" size={14} />Delete</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
