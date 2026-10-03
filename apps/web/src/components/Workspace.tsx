import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTextPath, type CompileResult, type Diagnostic, type Engine, type FileEntry, type Project, type Session, type SyncTexForward } from "@margin/shared";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { load, save } from "../lib/storage.ts";
import { CommandPalette, type Command } from "./CommandPalette.tsx";
import { PromptDialog, type PromptRequest } from "./Dialog.tsx";
import { Editor, type EditorHandle } from "./Editor.tsx";
import { FileTree, type TreeAction } from "./FileTree.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { Problems } from "./Problems.tsx";

const ENGINES: { id: Engine; label: string }[] = [
  { id: "pdflatex", label: "pdfLaTeX" },
  { id: "xelatex", label: "XeLaTeX" },
  { id: "lualatex", label: "LuaLaTeX" },
];
const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";

export function Workspace({ projectId, session }: { projectId: string; session: Session }) {
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [textPath, setTextPath] = useState<string | null>(null);
  const [revealAt, setRevealAt] = useState<{ line: number; key: number }>();
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);
  const [showProblems, setShowProblems] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [highlight, setHighlight] = useState<SyncTexForward & { key: number }>();
  const [toast, setToast] = useState<string | null>(null);
  const [split, setSplit] = useState(() => load("split", 0.5));
  const [sidebar, setSidebar] = useState(() => load("sidebar", true));

  const editor = useRef<EditorHandle>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef("");
  const compiling$ = useRef(false);
  const queued = useRef(false);
  const center = useRef<HTMLDivElement>(null);

  const notify = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const ask = (req: Omit<PromptRequest, "resolve">) => new Promise<string | null>((resolve) => setPrompt({ ...req, resolve }));

  const refreshFiles = useCallback(() => api.files(projectId).then(setFiles).catch(() => {}), [projectId]);

  const openFile = useCallback((path: string, line?: number) => {
    setOpenPath(path);
    if (isTextPath(path)) setTextPath(path);
    if (line) setRevealAt({ line, key: Date.now() });
    save(`open:${projectId}`, path);
  }, [projectId]);

  // ── Compile ──────────────────────────────────────────────────────────────
  const compileImpl = useRef<() => Promise<void>>(async () => {});
  compileImpl.current = async () => {
    if (compiling$.current) { queued.current = true; return; }
    compiling$.current = true;
    setCompiling(true);
    try {
      await editor.current?.saveAll();
      const r = await api.compile(projectId);
      setResult(r);
      if (r.hasPdf) setPdfVersion((v) => v + 1);
      if (r.diagnostics.some((d) => d.severity === "error")) setShowProblems(true);
    } catch (err) {
      notify((err as Error).message);
    } finally {
      compiling$.current = false;
      setCompiling(false);
      if (queued.current) { queued.current = false; void compileImpl.current(); }
    }
  };
  const compile = useCallback(() => void compileImpl.current(), []);

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([api.project(projectId), api.files(projectId)])
      .then(([p, f]) => {
        setProject(p);
        setFiles(f);
        const last = load<string | null>(`open:${projectId}`, null);
        openFile(last && f.some((x) => x.path === last) ? last : p.mainFile);
        compile();
      })
      .catch((err) => setLoadError(err.message));
  }, [projectId, openFile, compile]);

  // Pick up files teammates added while you were away.
  useEffect(() => {
    const onFocus = () => void refreshFiles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshFiles]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (editor.current?.hasUnsaved()) e.preventDefault(); };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Global shortcuts (the editor handles its own when focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
      else if (k === "s" || k === "enter") { e.preventDefault(); compile(); }
      else if (k === "b") { e.preventDefault(); setSidebar((s: boolean) => { save("sidebar", !s); return !s; }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compile]);

  // ── File actions ─────────────────────────────────────────────────────────
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  const uploadTo = async (dir: string, list: File[]) => {
    try {
      const { saved } = await api.upload(projectId, dir, list);
      await refreshFiles();
      notify(`Added ${saved.length} file${saved.length === 1 ? "" : "s"}${dir ? ` to ${dir}/` : ""}`);
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const onTreeAction = async (action: TreeAction, path: string) => {
    try {
      switch (action) {
        case "newFile": {
          const name = await ask({ title: "New file", placeholder: "sections/results.tex", initial: path ? `${path}/` : "", confirm: "Create" });
          if (!name) return;
          const rel = path && !name.startsWith(`${path}/`) ? join(path, name) : name;
          await api.createEntry(projectId, rel, "file");
          await refreshFiles();
          openFile(rel);
          break;
        }
        case "newFolder": {
          const name = await ask({ title: "New folder", placeholder: "figures", confirm: "Create" });
          if (!name) return;
          await api.createEntry(projectId, join(path, name), "dir");
          await refreshFiles();
          break;
        }
        case "upload":
          uploadDir.current = path;
          uploadInput.current?.click();
          break;
        case "rename": {
          const to = await ask({ title: "Rename", label: "You can move it by changing the folder.", initial: path, confirm: "Rename" });
          if (!to || to === path) return;
          await editor.current?.saveAll();
          await api.move(projectId, path, to);
          files.filter((f) => f.path === path || f.path.startsWith(`${path}/`)).forEach((f) => editor.current?.forget(f.path));
          const moved = (p: string | null) => (p && (p === path || p.startsWith(`${path}/`)) ? to + p.slice(path.length) : p);
          if (project && moved(project.mainFile) !== project.mainFile) setProject(await api.updateProject(projectId, { mainFile: moved(project.mainFile)! }));
          setOpenPath(moved);
          setTextPath(moved);
          await refreshFiles();
          break;
        }
        case "delete": {
          const ok = await ask({ title: `Delete ${path}?`, label: "It stays recoverable from earlier checkpoints.", confirm: "Delete", danger: true, confirmOnly: true });
          if (ok === null) return;
          await api.remove(projectId, path);
          files.filter((f) => f.path === path || f.path.startsWith(`${path}/`)).forEach((f) => editor.current?.forget(f.path));
          if (openPath === path || openPath?.startsWith(`${path}/`) || textPath === path) openFile(project!.mainFile);
          await refreshFiles();
          break;
        }
        case "setMain":
          setProject(await api.updateProject(projectId, { mainFile: path }));
          compile();
          break;
      }
    } catch (err) {
      notify((err as Error).message);
    }
  };

  // ── SyncTeX ──────────────────────────────────────────────────────────────
  const forwardSync = async (path: string, line: number) => {
    try {
      const res = await api.forward(projectId, path, line);
      if (res) setHighlight({ ...res, key: Date.now() });
      else notify("That line isn't in the PDF yet — compile first");
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const inverseSync = async (page: number, x: number, y: number) => {
    try {
      const res = await api.inverse(projectId, page, x, y);
      if (res) openFile(res.file, res.line);
      else notify("No source location there");
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const openDiagnostic = (d: Diagnostic) => d.file && openFile(d.file, d.line);

  const setEngine = async (engine: Engine) => {
    setProject(await api.updateProject(projectId, { engine }));
    compile();
  };

  const renameProject = async () => {
    const name = await ask({ title: "Rename project", initial: project?.name, confirm: "Rename" });
    if (name) setProject(await api.updateProject(projectId, { name }));
  };

  // ── Splitter ─────────────────────────────────────────────────────────────
  const startDrag = (e: React.PointerEvent) => {
    const area = center.current?.parentElement;
    if (!area) return;
    e.preventDefault();
    const rect = area.getBoundingClientRect();
    const left = center.current!.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => {
      const frac = Math.min(0.8, Math.max(0.2, (ev.clientX - left) / (rect.right - left)));
      setSplit(frac);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
      setSplit((s: number) => { save("split", s); return s; });
    };
    document.body.classList.add("dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── Command palette ──────────────────────────────────────────────────────
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "compile", label: "Compile", section: "Action", icon: "play", hint: `${MOD}S`, run: compile },
      { id: "checkpoint", label: "Create checkpoint…", section: "Action", icon: "history", run: () => setHistoryOpen(true) },
      { id: "problems", label: showProblems ? "Hide problems" : "Show problems", section: "View", icon: "alert", run: () => setShowProblems((s) => !s) },
      { id: "sidebar", label: "Toggle sidebar", section: "View", icon: "folder", hint: `${MOD}B`, run: () => setSidebar((s: boolean) => !s) },
      { id: "newfile", label: "New file…", section: "Action", icon: "plus", run: () => void onTreeAction("newFile", "") },
      { id: "upload", label: "Upload files…", section: "Action", icon: "upload", run: () => void onTreeAction("upload", "") },
      { id: "rename-project", label: "Rename project…", section: "Project", icon: "file", run: () => void renameProject() },
      { id: "projects", label: "Back to all projects", section: "Navigate", icon: "back", run: () => navigate({ name: "projects" }) },
    ];
    if (textPath?.endsWith(".tex") && textPath !== project?.mainFile) {
      cmds.push({ id: "main", label: `Set ${textPath} as main file`, section: "Project", icon: "star", run: () => void onTreeAction("setMain", textPath) });
    }
    for (const e of ENGINES) {
      if (e.id !== project?.engine) cmds.push({ id: `engine-${e.id}`, label: `Compile with ${e.label}`, section: "Project", icon: "terminal", run: () => void setEngine(e.id) });
    }
    for (const f of files) {
      if (f.type === "file") cmds.push({ id: `file:${f.path}`, label: f.path, section: "File", icon: "file", run: () => openFile(f.path) });
    }
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, textPath, project, showProblems]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="center-screen">
        <p>{loadError}</p>
        <button className="btn" onClick={() => navigate({ name: "projects" })}>Back to projects</button>
      </div>
    );
  }
  if (!project) return <div className="center-screen"><Spinner size={20} /></div>;

  const errors = result?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const warnings = result?.diagnostics.filter((d) => d.severity === "warning").length ?? 0;
  const binaryOpen = openPath && !isTextPath(openPath) ? openPath : null;

  return (
    <div className="workspace">
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate({ name: "projects" })} title="All projects"><Icon name="back" /></button>
        <button className="project-name" onClick={renameProject} title="Rename project">{project.name}</button>
        <span className="chip subtle" title="Main file · engine">{project.mainFile} · {ENGINES.find((e) => e.id === project.engine)?.label}</span>
        <div className="spacer" />
        {result && (
          <button className={`chip ${errors ? "danger" : warnings ? "warn" : ""}`} onClick={() => setShowProblems((s) => !s)} title="Problems">
            {errors ? <><Icon name="alert" size={13} />{errors} error{errors > 1 ? "s" : ""}</> :
              warnings ? <><Icon name="alert" size={13} />{warnings} warning{warnings > 1 ? "s" : ""}</> :
                <><Icon name="check" size={13} />Clean</>}
          </button>
        )}
        <button className="btn ghost" onClick={() => setHistoryOpen(true)} title="Checkpoints"><Icon name="history" size={14} />Checkpoint</button>
        <button className="btn ghost" onClick={() => setPaletteOpen(true)} title="Command palette"><kbd>{MOD}K</kbd></button>
        <button className="btn primary" onClick={compile} disabled={compiling} title={`Compile (${MOD}S)`}>
          {compiling ? <Spinner /> : <Icon name="play" size={13} />}
          {compiling ? "Compiling" : "Compile"}
        </button>
        <span className="avatar" title={`Signed in as ${session.name}`}>{session.name.slice(0, 1).toUpperCase()}</span>
      </header>

      <div className="body">
        {sidebar && (
          <aside className="sidebar">
            <div className="sidebar-head">
              <span className="section-label">Files</span>
              <div className="spacer" />
              <button className="icon-btn" title="New file" onClick={() => void onTreeAction("newFile", "")}><Icon name="plus" size={14} /></button>
              <button className="icon-btn" title="New folder" onClick={() => void onTreeAction("newFolder", "")}><Icon name="folderPlus" size={14} /></button>
              <button className="icon-btn" title="Upload" onClick={() => void onTreeAction("upload", "")}><Icon name="upload" size={14} /></button>
            </div>
            <FileTree
              projectId={projectId}
              files={files}
              openPath={openPath}
              mainFile={project.mainFile}
              dirty={dirty}
              onOpen={(p) => openFile(p)}
              onAction={(a, p) => void onTreeAction(a, p)}
              onDropFiles={(dir, list) => void uploadTo(dir, list)}
            />
          </aside>
        )}

        <div className="panes">
          <section className="pane" ref={center} style={{ flexBasis: `${split * 100}%` }}>
            <div className="pane-tab">
              <Icon name={binaryOpen ? (binaryOpen.endsWith(".pdf") ? "pdf" : "image") : "file"} size={13} className="muted" />
              <span>{openPath}</span>
              {openPath && dirty.has(openPath) && <span className="dot" />}
              <div className="spacer" />
              {!binaryOpen && <span className="muted small">{MOD}J jump to PDF · double-click PDF to jump back</span>}
            </div>
            <div className="pane-body">
              {textPath && (
                <div className="fill" hidden={!!binaryOpen}>
                  <Editor
                    ref={editor}
                    projectId={projectId}
                    path={textPath}
                    revealAt={revealAt}
                    onDirtyChange={(p, d) => setDirty((prev) => {
                      const next = new Set(prev);
                      d ? next.add(p) : next.delete(p);
                      return next;
                    })}
                    onCompile={compile}
                    onForwardSync={(p, l) => void forwardSync(p, l)}
                    onError={notify}
                  />
                </div>
              )}
              {binaryOpen?.toLowerCase().endsWith(".pdf") && <PdfViewer url={api.rawUrl(projectId, binaryOpen)} />}
              {binaryOpen && /\.(png|jpe?g|gif|svg|webp)$/i.test(binaryOpen) && (
                <div className="image-preview"><img src={api.rawUrl(projectId, binaryOpen)} alt={binaryOpen} /></div>
              )}
              {binaryOpen && !/\.(pdf|png|jpe?g|gif|svg|webp)$/i.test(binaryOpen) && (
                <div className="empty">No preview for this file type. <a href={api.rawUrl(projectId, binaryOpen)} download>Download</a></div>
              )}
            </div>
            {showProblems && result && <Problems result={result} onOpen={openDiagnostic} onClose={() => setShowProblems(false)} />}
          </section>

          <div className="splitter" onPointerDown={startDrag} />

          <section className="pane preview" style={{ flexBasis: `${(1 - split) * 100}%` }}>
            <PdfViewer
              url={pdfVersion ? api.pdfUrl(projectId, pdfVersion) : null}
              highlight={highlight}
              onInverse={(pg, x, y) => void inverseSync(pg, x, y)}
              emptyMessage={compiling ? "Compiling…" : errors ? "Fix the errors to see a PDF" : "Compile to see your paper"}
            />
          </section>
        </div>
      </div>

      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (list.length) void uploadTo(uploadDir.current, list);
        }}
      />
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {historyOpen && <HistoryPanel projectId={projectId} onClose={() => setHistoryOpen(false)} beforeCheckpoint={() => editor.current?.saveAll() ?? Promise.resolve()} />}
      {prompt && <PromptDialog req={prompt} onDone={() => setPrompt(null)} />}
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
