import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { documentLabels, isTextPath, type DocumentInfo, type FileEntry } from "@margin/shared";
import { Icon } from "./Icon.tsx";
import { load, save } from "../lib/storage.ts";
import type { Peer } from "../lib/collab.ts";
import { Avatar } from "./Presence.tsx";

export type TreeAction = "newFile" | "newFolder" | "upload" | "rename" | "delete" | "setMain" | "compileDoc" | "download" | "renameDoc" | "resetDocName" | "newSection" | "newDocument" | "archiveDoc" | "restoreDoc";

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
  /** Scroll to and highlight this path, opening the groups and folders it's in. */
  reveal?: { path: string; key: number };
  /** Drag a file or folder in the tree onto a folder ("" = project root). */
  onMove(from: string, toDir: string): void;
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

/**
 * A document's own folder: the folder its main file is in, when no other
 * document lives in that folder or below it. Everything inside belongs to it.
 */
function ownedRoot(doc: DocumentInfo, all: DocumentInfo[]): string | undefined {
  const dir = dirOfPath(doc.path);
  if (!dir) return undefined;
  const others = all.filter((d) => d.path !== doc.path).map((d) => dirOfPath(d.path));
  return others.some((o) => o === dir || o.startsWith(`${dir}/`)) ? undefined : dir;
}

function fileIcon(path: string) {
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.bib$/i.test(path)) return "book";
  return "file";
}

interface Group { id: string; title: string; tag?: string; subtitle?: string; doc?: DocumentInfo; files: FileEntry[]; archived?: boolean; root?: string }

/**
 * With several documents, the tree shows one section per document (the files
 * it uses), then files shared by several documents, then everything else.
 */
function groupByDocument(files: FileEntry[], allDocs: DocumentInfo[]): Group[] {
  const docs = allDocs.filter((d) => !d.archived);
  const archivedDocs = allDocs.filter((d) => d.archived);
  const users = new Map<string, string[]>();
  for (const d of docs) for (const f of d.files ?? [d.path]) users.set(f, [...(users.get(f) ?? []), d.path]);
  // Files only archived documents use go with those documents, out of the way.
  const archivedUsers = new Map<string, string>();
  for (const d of archivedDocs) for (const f of d.files ?? [d.path]) if (!users.has(f) && !archivedUsers.has(f)) archivedUsers.set(f, d.path);
  const labels = documentLabels(allDocs);
  // Same title twice: keep the folder/file tag separate so long titles don't truncate it away.
  const groups: Group[] = docs.map((d) => {
    const label = labels.get(d.path) ?? d.title;
    return { id: `doc:${d.path}`, title: d.title, tag: label !== d.title ? label.slice(d.title.length + 3) : undefined, subtitle: d.path, doc: d, files: [], root: ownedRoot(d, allDocs) };
  });
  const archived: Group[] = archivedDocs.map((d) => ({ id: `archived:${d.path}`, title: labels.get(d.path) ?? d.title, subtitle: d.path, doc: d, files: [], archived: true, root: ownedRoot(d, allDocs) }));
  // The group whose own folder contains a path (the deepest one), for files no document uses yet.
  const owner = (p: string) => [...groups, ...archived].filter((g) => g.root && p.startsWith(`${g.root}/`)).sort((a, b) => b.root!.length - a.root!.length)[0];
  const shared: Group = { id: "shared", title: "Shared", subtitle: "Used by more than one document", files: [] };
  const other: Group = { id: "other", title: "Other files", subtitle: "Not used by any document yet: notes, data, unused figures", files: [] };
  const filePaths = files.filter((f) => f.type === "file").map((f) => f.path);
  for (const f of files) {
    if (f.type === "dir") {
      // Empty folders: inside a document's own folder they belong to it; otherwise they go with the other files.
      if (filePaths.some((p) => p.startsWith(`${f.path}/`))) continue;
      (owner(f.path) ?? other).files.push(f);
      continue;
    }
    const u = users.get(f.path) ?? [];
    if (u.length === 1) groups.find((g) => g.doc?.path === u[0])!.files.push(f);
    else if (u.length > 1) shared.files.push(f);
    else if (archivedUsers.has(f.path)) archived.find((g) => g.doc?.path === archivedUsers.get(f.path))!.files.push(f);
    else (owner(f.path) ?? other).files.push(f);
  }
  return [...groups, shared, other, ...archived].filter((g) => g.files.length || g.archived);
}

export function FileTree({ projectId, files, openPath, mainFile, documents = [], activeDoc, dirty, peersByFile, onOpen, onAction, onDropFiles, onMove, reveal }: Props) {
  const docPaths = useMemo(() => documents.map((d) => d.path), [documents]);
  const [mode, setMode] = useState<"documents" | "folders">(() => load(`treeMode:${projectId}`, "documents"));
  const grouped = mode === "documents" && documents.length > 1;
  const tree = useMemo(() => buildTree(files), [files]);
  const groups = useMemo(() => (grouped ? groupByDocument(files, documents).map((g) => ({ ...g, tree: buildTree(g.files, g.root) })) : []), [grouped, files, documents]);
  // Which documents use each file (for the Shared group's labels and hover text).
  const usedBy = useMemo(() => {
    const m = new Map<string, DocumentInfo[]>();
    for (const d of documents) for (const f of d.files ?? [d.path]) m.set(f, [...(m.get(f) ?? []), d]);
    return m;
  }, [documents]);
  const shortName = (d: DocumentInfo) => d.path.split("/").pop()!.replace(/\.tex$/, "");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(load<string[]>(`collapsed:${projectId}`, [])));
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node | null } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; doc: DocumentInfo; dir: string } | null>(null);
  const [showArchived, setShowArchivedState] = useState(() => load(`showArchived:${projectId}`, false));
  const setShowArchived = (v: boolean) => { setShowArchivedState(v); save(`showArchived:${projectId}`, v); };
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    next.has(key) ? next.delete(key) : next.add(key);
    setCollapsed(next);
    save(`collapsed:${projectId}`, [...next]);
  };
  // Reveal a path: open every group and folder on the way, then scroll to it and flash it.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    const target = reveal.path;
    const ancestors = target.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    const next = new Set(collapsed);
    const scopes = grouped ? groups.filter((g) => g.files.some((f) => f.path === target || f.path.startsWith(`${target}/`))).map((g) => g.id) : [""];
    for (const scope of scopes) {
      const g = groups.find((x) => x.id === scope);
      if (g) { next.delete(`group:${g.id}`); if (g.archived) { next.add(`open:group:${g.id}`); setShowArchived(true); } }
      for (const a of ancestors) next.delete(scope ? `${scope}|${a}` : a);
    }
    setCollapsed(next);
    const t = window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.classList.add("flash");
      window.setTimeout(() => el?.classList.remove("flash"), 1600);
    }, 60);
    return () => window.clearTimeout(t);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {scope === "shared" && usedBy.get(n.path)?.map((d) => <span key={d.path} className="used-by" title={`Used by ${d.path}`}>{shortName(d)}</span>)}
          {peersByFile.get(n.path)?.slice(0, 3).map((p) => <Avatar key={p.clientId} name={p.user.name} agent={p.user.agent} size="xs" title={p.user.agent ? p.user.name : `${p.user.name} is editing`} />)}
          {dirty.has(n.path) && <span className="dot" title="Sending edits…" />}
        </button>
      );
    });

  const menuDir = menu?.node ? (menu.node.type === "dir" ? menu.node.path : "") : "";
  const act = (a: TreeAction, path: string) => { setMenu(null); onAction(a, path); };

  return (
    <div ref={rootRef} className={`tree ${dropTarget === "" ? "drop-target" : ""}`} onContextMenu={(e) => openMenu(e, null)} {...dropProps("")}>
      {documents.length > 1 && (
        <div className="tree-mode segmented">
          <button className={grouped ? "active" : ""} onClick={() => setTreeMode("documents")} title="Group files by the document that uses them">By document</button>
          <button className={!grouped ? "active" : ""} onClick={() => setTreeMode("folders")} title="Plain folder view">Folders</button>
        </div>
      )}
      {grouped
        ? groups.map((g, i) => {
            const key = `group:${g.id}`;
            // Archived groups start closed; the rest start open.
            const open = g.archived ? collapsed.has(`open:${key}`) : !collapsed.has(key);
            const firstArchived = g.archived && !groups[i - 1]?.archived;
            if (g.archived && !showArchived) {
              return firstArchived
                ? <button key="archived-toggle" className="tree-archived-toggle" onClick={() => setShowArchived(true)}><Icon name="chevron" size={11} className="chev" />Archived · {groups.filter((x) => x.archived).length}</button>
                : null;
            }
            return (
              <div key={g.id}>
                {firstArchived && <button className="tree-archived-toggle" onClick={() => setShowArchived(false)}><Icon name="chevron" size={11} className="chev open" />Archived · {groups.filter((x) => x.archived).length}</button>}
                <section className={`tree-group ${g.doc && g.doc.path === activeDoc ? "active" : ""} ${g.archived ? "archived" : ""} ${g.doc && dropTarget === `group:${g.id}` ? "drop-target" : ""}`}
                  {...(g.doc ? groupDropProps(`group:${g.id}`, g.root ?? dirOfPath(g.doc.path)) : {})}>
                  <button className="tree-group-head" onClick={() => toggle(g.archived ? `open:${key}` : key)}
                    title={g.doc ? `${g.subtitle}${g.archived ? " · archived: right-click to restore" : " · double-click to compile · right-click for more"}` : g.subtitle}
                    onDoubleClick={() => g.doc && !g.archived && onAction("compileDoc", g.doc.path)}
                    onContextMenu={(e) => { if (!g.doc) return; e.preventDefault(); e.stopPropagation(); setGroupMenu({ x: e.clientX, y: e.clientY, doc: g.doc, dir: g.root ?? dirOfPath(g.doc.path) }); }}>
                    <Icon name="chevron" size={11} className={`chev ${open ? "open" : ""}`} />
                    {g.archived && <Icon name="archive" size={11} className="muted" />}
                    <span className="tree-group-title ellipsis">{g.title}</span>
                    {g.tag && <span className="tree-group-tag" title={g.subtitle}>{g.tag}</span>}
                    {g.doc && g.doc.path === activeDoc && <span className="tree-group-live" title="The document you're compiling" />}
                    <span className="tree-group-count">{g.files.filter((f) => f.type === "file").length}</span>
                  </button>
                  {open && renderNodes(g.tree, 0, g.id)}
                </section>
              </div>
            );
          })
        : renderNodes(tree, 0, "")}
      {groupMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setGroupMenu(null)} onContextMenu={(e) => { e.preventDefault(); setGroupMenu(null); }} />
          <div className="menu" style={{ left: groupMenu.x, top: Math.min(groupMenu.y, window.innerHeight - 200) }}>
            {groupMenu.doc.archived ? (
              <>
                <button onClick={() => { setGroupMenu(null); onAction("restoreDoc", groupMenu.doc.path); }}><Icon name="history" size={14} />Restore document</button>
                <button onClick={() => { setGroupMenu(null); onAction("renameDoc", groupMenu.doc.path); }}><Icon name="file" size={14} />Rename group…</button>
              </>
            ) : (
              <>
                <button onClick={() => { setGroupMenu(null); onAction("newSection", groupMenu.doc.path); }}><Icon name="plus" size={14} />New section…</button>
                <button onClick={() => { setGroupMenu(null); onAction("newFile", groupMenu.dir); }}><Icon name="file" size={14} />New file here…</button>
                <button onClick={() => { setGroupMenu(null); onAction("newFolder", groupMenu.dir); }}><Icon name="folderPlus" size={14} />New folder here…</button>
                <button onClick={() => { setGroupMenu(null); onAction("upload", groupMenu.dir); }}><Icon name="upload" size={14} />Upload here…</button>
                {groupMenu.doc.path !== activeDoc && <button onClick={() => { setGroupMenu(null); onAction("compileDoc", groupMenu.doc.path); }}><Icon name="play" size={14} />Compile this document</button>}
                <div className="menu-sep" />
                <button onClick={() => { setGroupMenu(null); onAction("renameDoc", groupMenu.doc.path); }}><Icon name="file" size={14} />Rename group…</button>
                {groupMenu.doc.customTitle && <button onClick={() => { setGroupMenu(null); onAction("resetDocName", groupMenu.doc.path); }}><Icon name="history" size={14} />Use the LaTeX \title again</button>}
                {!groupMenu.doc.isDefault && <button onClick={() => { setGroupMenu(null); onAction("setMain", groupMenu.doc.path); }}><Icon name="star" size={14} />Make default document</button>}
                <button onClick={() => { setGroupMenu(null); onAction("newDocument", groupMenu.doc.path); }}><Icon name="folderPlus" size={14} />New document…</button>
                {!groupMenu.doc.isDefault && <><div className="menu-sep" /><button onClick={() => { setGroupMenu(null); onAction("archiveDoc", groupMenu.doc.path); }}><Icon name="archive" size={14} />Archive document</button></>}
              </>
            )}
          </div>
        </>
      )}
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
