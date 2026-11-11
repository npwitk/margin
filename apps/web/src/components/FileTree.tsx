import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { SHARED_DIR, documentLabels, isTextPath, type DocumentInfo, type FileEntry } from "@margin/shared";
import { Icon } from "./Icon.tsx";
import { load, save } from "../lib/storage.ts";
import { readDrop, type Dropped } from "../lib/dropped.ts";
import type { Peer } from "../lib/collab.ts";
import { Avatar } from "./Presence.tsx";
import { api } from "../lib/api.ts";
import { pageThumbnail } from "../lib/thumbnails.ts";

export type TreeAction = "newFile" | "newFolder" | "upload" | "rename" | "delete" | "setMain" | "compileDoc" | "download" | "renameDoc" | "resetDocName" | "newSection" | "newDocument" | "archiveDoc" | "restoreDoc"
  | "share" | "duplicateDoc" | "deleteDoc";

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
  onDropFiles(dir: string, dropped: Dropped): void;
  /** Scroll to and highlight this path, opening the groups and folders it's in. */
  reveal?: { path: string; key: number };
  /** Drag a file or folder in the tree onto a folder ("" = project root). */
  onMove(from: string, toDir: string): void;
  /** Switch the current document (its card was clicked). */
  onSelectDoc(path: string): void;
  /** Changes whenever a document's PDF may have changed, so its thumbnail is redrawn. */
  thumbKey(doc: string): string;
}

/** Drag data type for moving entries inside the tree (distinct from files dragged in from the desktop). */
const MOVE_TYPE = "application/x-margin-path";

/**
 * Files as a folder tree. With `root` (a document's own folder), paths inside
 * it are shown relative to it, so the group reads like its own workspace;
 * nodes keep their full project path for actions.
 */
function buildTree(files: FileEntry[], root?: string): Node[] {
  const top: Node = { name: "", path: root ?? "", type: "dir", children: [] };
  const dirs = new Map<string, Node>([["", top]]);
  const full = (rel: string, inside: boolean) => (inside && root ? `${root}/${rel}` : rel);
  const dirOf = (rel: string, inside: boolean): Node => {
    const key = `${inside ? "in" : "out"}:${rel}`;
    if (!rel) return top;
    if (dirs.has(key)) return dirs.get(key)!;
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const node: Node = { name: rel.split("/").pop()!, path: full(rel, inside), type: "dir", children: [] };
    dirs.set(key, node);
    dirOf(parent, inside).children.push(node);
    return node;
  };
  for (const f of files) {
    const inside = !!root && f.path.startsWith(`${root}/`);
    const rel = inside ? f.path.slice(root!.length + 1) : f.path;
    if (f.type === "dir") { dirOf(rel, inside); continue; }
    const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    dirOf(parentRel, inside).children.push({ name: rel.split("/").pop()!, path: f.path, type: "file", children: [] });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(top.children);
  return top.children;
}

const dirOfPath = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function fileIcon(path: string) {
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.bib$/i.test(path)) return "book";
  return "file";
}

const inside = (p: string, dir: string) => !dir || p === dir || p.startsWith(`${dir}/`);
const isShared = (p: string) => inside(p, SHARED_DIR);

/**
 * Split the project for the panel: the current document's folder, the shared
 * folder, and everything else (notes, archived documents, stray files).
 * Other documents' folders aren't listed: their cards open them.
 */
function partition(files: FileEntry[], docs: DocumentInfo[], current: string) {
  const curDir = dirOfPath(current);
  const activeDirs = docs.filter((d) => !d.archived && d.path !== current).map((d) => dirOfPath(d.path)).filter(Boolean);
  // Folders of documents deeper than the current one's (all of them when it sits at the top level) aren't its files.
  const nested = docs.filter((d) => d.path !== current).map((d) => dirOfPath(d.path)).filter((d) => d && d !== curDir && inside(d, curDir));
  const mine: FileEntry[] = [], shared: FileEntry[] = [], other: FileEntry[] = [];
  for (const f of files) {
    if (f.path === SHARED_DIR || (curDir && f.path === curDir)) continue;
    if (isShared(f.path)) shared.push(f);
    else if (inside(f.path, curDir) && !nested.some((d) => inside(f.path, d))) mine.push(f);
    else if (!activeDirs.some((d) => inside(f.path, d))) other.push(f);
  }
  return { curDir, mine, shared, other };
}

/** A document as a card: page 1 of its PDF, its name and folder. */
function DocCard({ projectId, doc, active, label, thumbKey, compact, onClick, onMenu }: {
  projectId: string; doc: DocumentInfo; active: boolean; label?: string; thumbKey: string; compact: boolean;
  onClick(): void; onMenu(e: MouseEvent): void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (compact || !doc.hasPdf) { setThumb(null); return; }
    let cancelled = false;
    const prefix = `${projectId}:${doc.path}:`;
    void pageThumbnail(api.pdfUrl(projectId, Date.now(), doc.path), `${prefix}${thumbKey}`, prefix).then((url) => { if (!cancelled) setThumb(url); });
    return () => { cancelled = true; };
  }, [projectId, doc.path, doc.hasPdf, thumbKey, compact]);
  const slide = doc.docClass === "beamer";
  return (
    <button className={`doc-card ${active ? "active" : ""} ${compact ? "compact" : ""}`} onClick={onClick} onContextMenu={onMenu}
      title={`${doc.path}${active ? " · the document you're working on" : " · click to open"} · right-click for more`}>
      {!compact && (
        <span className={`doc-card-thumb ${slide ? "landscape" : ""}`}>
          {thumb ? <img src={thumb} alt="" /> : <span className="doc-card-class">{doc.docClass ?? "tex"}</span>}
        </span>
      )}
      <span className="doc-card-text">
        <span className="doc-card-title ellipsis">{doc.title}</span>
        <span className="doc-card-path ellipsis">{label ?? (dirOfPath(doc.path) ? `${dirOfPath(doc.path)}/` : doc.path)}{doc.hasPdf ? "" : " · not compiled"}</span>
      </span>
      {active && <span className="tree-group-live" />}
    </button>
  );
}

export function FileTree({ projectId, files, openPath, mainFile, documents = [], activeDoc, dirty, peersByFile, onOpen, onAction, onDropFiles, onMove, reveal, onSelectDoc, thumbKey }: Props) {
  const docPaths = useMemo(() => documents.map((d) => d.path), [documents]);
  const current = activeDoc ?? mainFile;
  const active = documents.filter((d) => !d.archived);
  const archived = documents.filter((d) => d.archived);
  const labels = useMemo(() => documentLabels(documents), [documents]);
  const [allFiles, setAllFilesState] = useState(() => load(`allFiles:${projectId}`, false));
  const setAllFiles = (v: boolean) => { setAllFilesState(v); save(`allFiles:${projectId}`, v); };
  const parts = useMemo(() => partition(files, documents, current), [files, documents, current]);
  const trees = useMemo(() => ({
    all: buildTree(files),
    mine: buildTree(parts.mine, parts.curDir || undefined),
    shared: buildTree(parts.shared, SHARED_DIR),
    other: buildTree(parts.other),
  }), [files, parts]);
  // Which documents use each file (the Shared folder's "used by" labels and hover text).
  const usedBy = useMemo(() => {
    const m = new Map<string, DocumentInfo[]>();
    for (const d of documents) for (const f of d.files ?? [d.path]) m.set(f, [...(m.get(f) ?? []), d]);
    return m;
  }, [documents]);
  const shortName = (d: DocumentInfo) => (dirOfPath(d.path).split("/").pop() || d.path.replace(/\.tex$/, ""));
  // Folders start open; "Other files" starts closed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(load<string[]>(`tree:${projectId}`, ["group:other"])));
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node | null } | null>(null);
  const [docMenu, setDocMenu] = useState<{ x: number; y: number; doc: DocumentInfo } | null>(null);
  const [showArchived, setShowArchivedState] = useState(() => load(`showArchived:${projectId}`, false));
  const setShowArchived = (v: boolean) => { setShowArchivedState(v); save(`showArchived:${projectId}`, v); };
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    next.has(key) ? next.delete(key) : next.add(key);
    setCollapsed(next);
    save(`tree:${projectId}`, [...next]);
  };
  // Reveal a path: open what it's in (switching to its document when it's in another one's folder), then scroll to it and flash it.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    const target = reveal.path;
    const owner = active.filter((d) => d.path !== current && dirOfPath(d.path) && inside(target, dirOfPath(d.path))).sort((a, b) => b.path.length - a.path.length)[0];
    if (owner && !allFiles) onSelectDoc(owner.path);
    const ancestors = target.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    const next = new Set(collapsed);
    for (const scope of ["", "mine", "shared", "other"]) for (const a of ancestors) next.delete(scope ? `${scope}|${a}` : a);
    if (isShared(target)) next.delete("group:shared");
    else if (!owner && !inside(target, parts.curDir)) next.delete("group:other");
    setCollapsed(next);
    const t = window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.classList.add("flash");
      window.setTimeout(() => el?.classList.remove("flash"), 1600);
    }, 60);
    return () => window.clearTimeout(t);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Folders come with everything in them, structure kept.
    void readDrop(e.dataTransfer).then((d) => { if (d.files.length || d.dirs.length) onDropFiles(dir, d); });
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
  // Dropping on a document's group puts things in that document's folder (highlighting the whole group).
  const groupDropProps = (key: string, dir: string) => ({
    onDragOver: (e: DragEvent) => {
      const moving = e.dataTransfer.types.includes(MOVE_TYPE);
      if (!moving && !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      if (moving && dragging && !canMoveInto(dragging, dir)) { e.dataTransfer.dropEffect = "none"; setDropTarget(null); return; }
      e.dataTransfer.dropEffect = moving ? "move" : "copy";
      setDropTarget(key);
    },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDropTarget((d) => (d === key ? null : d)); },
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
            <button data-path={n.path} className={`tree-row ${dragging === n.path ? "is-dragging" : ""}`} style={pad} onClick={() => toggle(key)} onContextMenu={(e) => openMenu(e, n)} {...dragProps(n.path)}>
              <Icon name="chevron" size={12} className={`chev ${open ? "open" : ""}`} />
              <Icon name="folder" size={15} className="tree-icon folder" />
              <span className="tree-name">{n.name}</span>
              {!n.children.length && <span className="tree-meta">Empty</span>}
            </button>
            {open && renderNodes(n.children, depth + 1, scope)}
          </div>
        );
      }
      return (
        <button
          key={n.path}
          data-path={n.path}
          className={`tree-row ${openPath === n.path ? "selected" : ""} ${dragging === n.path ? "is-dragging" : ""}`}
          style={pad}
          onClick={() => onOpen(n.path)}
          onContextMenu={(e) => openMenu(e, n)}
          title={documents.length > 1 && !docPaths.includes(n.path)
            ? `${n.path}\n${usedBy.get(n.path)?.length ? `Used by ${usedBy.get(n.path)!.map((d) => d.path).join(", ")}` : "Not used by any document"}`
            : n.path}
          {...dragProps(n.path)}
        >
          <span className="chev-space" />
          <Icon name={fileIcon(n.path)} size={14} className="tree-icon" />
          <span className={`tree-name ${isTextPath(n.path) ? "" : "muted"}`}>{n.name}</span>
          {n.path === mainFile ? <span className={`badge ${activeDoc === n.path ? "" : "dim"}`} title="Default document">main</span>
            : docPaths.includes(n.path) && <span className={`badge ${activeDoc === n.path ? "" : "dim"}`} title={activeDoc === n.path ? "The document you're compiling" : "A document: right-click to compile it"}>doc</span>}
          {scope === "shared" && (usedBy.get(n.path)?.length ?? 0) > 0 && <span className="used-by" title={`Used by ${usedBy.get(n.path)!.map((d) => d.path).join(", ")}`}>{usedBy.get(n.path)!.length > 1 ? `${usedBy.get(n.path)!.length} docs` : shortName(usedBy.get(n.path)![0])}</span>}
          {peersByFile.get(n.path)?.slice(0, 3).map((p) => <Avatar key={p.clientId} name={p.user.name} agent={p.user.agent} size="xs" title={p.user.agent ? p.user.name : `${p.user.name} is editing`} />)}
          {dirty.has(n.path) && <span className="dot" title="Sending edits…" />}
        </button>
      );
    });

  const menuDir = menu?.node ? (menu.node.type === "dir" ? menu.node.path : "") : parts.curDir;
  const act = (a: TreeAction, path: string) => { setMenu(null); onAction(a, path); };
  const doc = (a: TreeAction, path: string) => { setDocMenu(null); onAction(a, path); };

  /** A titled block of the panel (the current document's folder, Shared, Other files). */
  const group = (id: string, title: string, dir: string, nodes: Node[], opts: { hint?: string; empty?: string; actions?: boolean } = {}) => {
    const open = !collapsed.has(`group:${id}`);
    const count = (id === "mine" ? parts.mine : id === "shared" ? parts.shared : parts.other).filter((f) => f.type === "file").length;
    return (
      <section className={`tree-group ${dropTarget === `group:${id}` ? "drop-target" : ""}`} {...groupDropProps(`group:${id}`, dir)}>
        <div className="tree-group-row">
          <button className="tree-group-head" onClick={() => toggle(`group:${id}`)} title={opts.hint}>
            <Icon name="chevron" size={11} className={`chev ${open ? "open" : ""}`} />
            <span className="tree-group-title ellipsis">{title}</span>
            <span className="tree-group-count">{count}</span>
          </button>
          {opts.actions && (
            <>
              <button className="icon-btn tree-group-add" title={`New file in ${dir || "the project"}/`} onClick={() => onAction("newFile", dir)}><Icon name="plus" size={13} /></button>
              <button className="icon-btn tree-group-add" title={`Upload to ${dir || "the project"}/ (or drop files here)`} onClick={() => onAction("upload", dir)}><Icon name="upload" size={13} /></button>
            </>
          )}
        </div>
        {open && (nodes.length ? renderNodes(nodes, 0, id) : opts.empty && <div className="tree-empty-area">{opts.empty}</div>)}
      </section>
    );
  };

  const curInfo = documents.find((d) => d.path === current);
  return (
    <div ref={rootRef} className={`tree ${dropTarget === "" ? "drop-target" : ""}`} onContextMenu={(e) => openMenu(e, null)} {...dropProps(allFiles ? "" : parts.curDir)}>
      <div className="doc-cards">
        {active.map((d) => (
          <DocCard key={d.path} projectId={projectId} doc={d} active={d.path === current} label={labels.get(d.path) !== d.title ? labels.get(d.path)?.slice(d.title.length + 3) : undefined}
            thumbKey={thumbKey(d.path)} compact={active.length < 2}
            onClick={() => { onSelectDoc(d.path); onOpen(d.path); }}
            onMenu={(e) => { e.preventDefault(); e.stopPropagation(); setDocMenu({ x: e.clientX, y: e.clientY, doc: d }); }} />
        ))}
        <div className="doc-cards-foot">
          <button className="tree-archived-toggle" onClick={() => onAction("newDocument", "")} title="New document, in a folder of its own"><Icon name="plus" size={11} />New</button>
          {archived.length > 0 && (
            <button className="tree-archived-toggle" onClick={() => setShowArchived(!showArchived)}>
              <Icon name="chevron" size={11} className={`chev ${showArchived ? "open" : ""}`} />Archived · {archived.length}
            </button>
          )}
          <span className="spacer" />
          <button className={`tree-archived-toggle ${allFiles ? "on" : ""}`} onClick={() => setAllFiles(!allFiles)} title="Show every file in one folder tree, to move things around">
            <Icon name="folder" size={11} />All files
          </button>
        </div>
        {showArchived && archived.map((d) => (
          <button key={d.path} className="doc-archived-row" onClick={() => onAction("restoreDoc", d.path)} title={`${d.path} · click to restore`}>
            <Icon name="archive" size={11} /><span className="ellipsis">{d.title}</span><span className="muted small">Restore</span>
          </button>
        ))}
      </div>
      {allFiles
        ? renderNodes(trees.all, 0, "")
        : (
          <>
            {group("mine", parts.curDir ? `${parts.curDir}/` : (curInfo?.title ?? "Project"), parts.curDir, trees.mine,
              { hint: "The files of the document you're working on", actions: true })}
            {group("shared", "Shared", SHARED_DIR, trees.shared, {
              hint: `${SHARED_DIR}/: every document uses these by name (\\includegraphics{x}, \\bibliography{refs}). A document's own file of the same name wins.`,
              empty: "Figures, .bib and macros every document can use. Drop files here, or right-click a file → Move to Shared.", actions: true,
            })}
            {parts.other.length > 0 && group("other", "Other files", "", trees.other, { hint: "Notes, archived documents and files outside every document's folder" })}
          </>
        )}
      {docMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setDocMenu(null)} onContextMenu={(e) => { e.preventDefault(); setDocMenu(null); }} />
          <div className="menu" style={{ left: docMenu.x, top: Math.min(docMenu.y, window.innerHeight - 240) }}>
            <button onClick={() => doc("newSection", docMenu.doc.path)}><Icon name="plus" size={14} />Add a chapter file (\input)…</button>
            <button onClick={() => doc("renameDoc", docMenu.doc.path)}><Icon name="file" size={14} />Rename…</button>
            {docMenu.doc.customTitle && <button onClick={() => doc("resetDocName", docMenu.doc.path)}><Icon name="history" size={14} />Use the LaTeX \title again</button>}
            <button onClick={() => doc("duplicateDoc", docMenu.doc.path)}><Icon name="folderPlus" size={14} />Duplicate…</button>
            {!docMenu.doc.isDefault && <button onClick={() => doc("setMain", docMenu.doc.path)}><Icon name="star" size={14} />Make default document</button>}
            {!docMenu.doc.isDefault && (
              <>
                <div className="menu-sep" />
                <button onClick={() => doc("archiveDoc", docMenu.doc.path)}><Icon name="archive" size={14} />Archive</button>
                <button className="danger" onClick={() => doc("deleteDoc", docMenu.doc.path)}><Icon name="x" size={14} />Delete document and its folder</button>
              </>
            )}
          </div>
        </>
      )}
      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="menu" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 320) }}>
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
            {menu.node?.type === "file" && !isShared(menu.node.path) && !docPaths.includes(menu.node.path) && (
              <button onClick={() => act("share", menu.node!.path)} title="Every document can use it by name; identical copies in other documents are removed"><Icon name="people" size={14} />Move to Shared</button>
            )}
            <div className="menu-sep" />
            <button onClick={() => act("download", menu.node?.path ?? "")}>
              <Icon name="download" size={14} />
              {!menu.node ? "Download project (.zip)" : menu.node.type === "dir" ? "Download folder (.zip)" : "Download"}
            </button>
            {menu.node && (
              <>
                <button onClick={() => act("rename", menu.node!.path)}><Icon name={menu.node.type === "dir" ? "folder" : "file"} size={14} />{menu.node.type === "dir" ? "Rename folder…" : "Rename or move…"}</button>
                <button className="danger" onClick={() => act("delete", menu.node!.path)}><Icon name="x" size={14} />Delete</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
