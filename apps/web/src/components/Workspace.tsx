import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTextPath, type AiSettings, type CompileResult, type Diagnostic, type Engine, type FileEntry, type Project, type Session, type SyncTexForward, type CiteOptions } from "@margin/shared";
import { api } from "../lib/api.ts";
import { useCollab, usePeers, type Peer } from "../lib/collab.ts";
import { useThreads } from "../lib/review.ts";
import { ReviewPanel, type Draft } from "./ReviewPanel.tsx";
import { LocalDialog } from "./LocalDialog.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { AiSettingsDialog } from "./AiSettingsDialog.tsx";
import { AssistantPanel } from "./AssistantPanel.tsx";
import { CitationsPanel } from "./CitationsPanel.tsx";
import { ReviewView } from "./ReviewView.tsx";
import { useYMap } from "../lib/collab.ts";
import { navigate } from "../lib/router.ts";
import { rememberAvatars } from "../lib/avatars.ts";
import { load, save } from "../lib/storage.ts";
import { CommandPalette, type Command } from "./CommandPalette.tsx";
import { PromptDialog, type PromptRequest } from "./Dialog.tsx";
import { Editor, type EditorHandle } from "./Editor.tsx";
import { FileTree, type TreeAction } from "./FileTree.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { Icon, Spinner } from "./Icon.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { Problems } from "./Problems.tsx";
import { Board } from "./Board.tsx";
import { Avatar, PresenceStrip } from "./Presence.tsx";

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
  const [localOpen, setLocalOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Markdown files open rendered; this remembers which ones you switched to the source.
  const [mdSource, setMdSource] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [highlight, setHighlight] = useState<SyncTexForward & { key: number }>();
  const [toast, setToast] = useState<string | null>(null);
  const [split, setSplit] = useState(() => load("split", 0.5));
  const [sidebar, setSidebar] = useState(() => load("sidebar", true));
  const [view, setView] = useState<"write" | "board" | "review">(() => load(`view:${projectId}`, "write"));
  const [previewTab, setPreviewTab] = useState<"pdf" | "assistant" | "citations">(() => load("previewTab", "pdf"));
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [assistantRequest, setAssistantRequest] = useState<{ text: string; key: number }>();

  const collab = useCollab(projectId, session);
  const peers = usePeers(collab);
  useEffect(() => { rememberAvatars(peers.filter((p) => !p.user.agent).map((p) => [p.user.name, p.user.avatar])); }, [peers]);
  const [reviewOpen, setReviewOpen] = useState(() => load("review", false));
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const { doc: reviewDoc, threads } = useThreads(collab, textPath);
  const openThreads = threads.filter((t) => t.status === "open").length;
  useEffect(() => save("review", reviewOpen), [reviewOpen]);
  useEffect(() => save("previewTab", previewTab), [previewTab]);
  useEffect(() => { api.aiSettings().then(setAiSettings).catch(() => {}); }, []);
  const agentsMap = useYMap(collab?.agents);
  // Agents (built-in Claude, or Claude Code / Codex via margin-mcp). Hide ones that went quiet.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  const agentPeers = useMemo<Peer[]>(() => [...agentsMap.values()]
    .filter((a) => now - a.at < 10 * 60_000)
    .map((a, i) => ({
      clientId: -1 - i, user: { name: `${a.agent ?? "Claude"} for ${a.for}`, color: "#d97757", agent: true }, file: a.file ?? null, line: undefined, view: "write" as const,
    })), [agentsMap, now]);
  // Switching files clears the draft and selection, unless we're jumping to a specific thread.
  const pendingThread = useRef<string | null>(null);
  useEffect(() => { setDraft(null); setActiveThread(pendingThread.current); pendingThread.current = null; }, [textPath]);

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

  // \cite completion: the paper's references and the library's, refreshed every few seconds.
  const citeCache = useRef<{ at: number; data: Promise<CiteOptions> } | null>(null);
  const citeOptions = useCallback(() => {
    if (!citeCache.current || Date.now() - citeCache.current.at > 15_000) {
      const data = api.citeOptions(projectId);
      citeCache.current = { at: Date.now(), data };
      data.catch(() => { citeCache.current = null; });
    }
    return citeCache.current.data;
  }, [projectId]);
  const libraryCite = useCallback(async (refId: string) => {
    const r = await api.insertFromLibrary(projectId, refId);
    citeCache.current = null;
    notify(r.note ?? (r.added ? `Added ${r.key} to ${r.file}` : `${r.file} already has it as ${r.key}`));
    return r.key;
  }, [projectId, notify]);

  const ask = (req: Omit<PromptRequest, "resolve">) => new Promise<string | null>((resolve) => setPrompt({ ...req, resolve }));

  const refreshFiles = useCallback(() => api.files(projectId).then(setFiles).catch(() => {}), [projectId]);

  const openFile = useCallback((path: string, line?: number) => {
    setOpenPath(path);
    if (isTextPath(path)) setTextPath(path);
    if (line) setRevealAt({ line, key: Date.now() });
    save(`open:${projectId}`, path);
    setView("write");
  }, [projectId]);

  useEffect(() => { collab?.setPresence({ file: openPath, view }); save(`view:${projectId}`, view); }, [collab, openPath, view, projectId]);

  // Unsent-edit dots in the tree.
  useEffect(() => {
    if (!collab) return;
    return collab.onUnsyncedChange(() => setDirty(collab.unsyncedPaths()));
  }, [collab]);

  // Live events from teammates: files added/removed, someone compiled.
  useEffect(() => {
    if (!collab) return;
    const events = collab.events;
    const onEvent = (e: { keysChanged: Set<string>; transaction: { local: boolean } }) => {
      if (e.transaction.local) return;
      if (e.keysChanged.has("filesVersion")) void refreshFiles();
      const last = events.get("lastCompile") as { by: string; ok: boolean } | undefined;
      if (e.keysChanged.has("lastCompile") && last && last.by !== session.name) {
        setPdfVersion((v) => v + 1);
        notify(`${last.by} compiled${last.ok ? "" : " (with errors)"} — preview updated`);
      }
    };
    events.observe(onEvent);
    return () => events.unobserve(onEvent);
  }, [collab, refreshFiles, session.name, notify]);

  // ── Compile ──────────────────────────────────────────────────────────────
  const compileImpl = useRef<() => Promise<void>>(async () => {});
  compileImpl.current = async () => {
    if (compiling$.current) { queued.current = true; return; }
    compiling$.current = true;
    setCompiling(true);
    try {
      await collab?.flush();
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
        const startView = load<"write" | "board" | "review">(`view:${projectId}`, "write");
        openFile(last && f.some((x) => x.path === last) ? last : p.mainFile);
        setView(startView);
        compile();
      })
      .catch((err) => setLoadError(err.message));
  }, [projectId, openFile, compile]);

  // While Claude plans a paper from an idea, poll until it's ready.
  const planning = project?.setup?.status === "planning";
  useEffect(() => {
    if (!planning) return;
    const t = window.setInterval(async () => {
      const p = await api.project(projectId).catch(() => null);
      if (!p || p.setup?.status === "planning") return;
      setProject(p);
      await refreshFiles();
      if (p.setup?.status === "done") { notify("Your paper is planned: outline, related work and tasks are ready."); compile(); setView("board"); }
      else notify(p.setup?.error ?? "Planning failed");
    }, 3000);
    return () => window.clearInterval(t);
  }, [planning, projectId, refreshFiles, compile, notify]);

  // A teammate deleted or renamed the file you had open.
  useEffect(() => {
    if (!project || !files.length || !textPath || files.some((f) => f.path === textPath)) return;
    collab?.close(textPath);
    editor.current?.forget(textPath);
    notify(`${textPath} was moved or deleted`);
    openFile(files.some((f) => f.path === project.mainFile) ? project.mainFile : files.find((f) => f.path.endsWith(".tex"))?.path ?? project.mainFile);
  }, [files]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick up files teammates added while you were away.
  useEffect(() => {
    const onFocus = () => void refreshFiles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshFiles]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (collab?.unsyncedPaths().size) e.preventDefault(); };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [collab]);

  // Global shortcuts (the editor handles its own when focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
      else if (k === "s" || k === "enter") { e.preventDefault(); compile(); }
      else if (k === "b" && e.shiftKey) { e.preventDefault(); setView((v) => (v === "board" ? "write" : "board")); }
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
          await collab?.flush();
          await api.move(projectId, path, to);
          collab?.closeUnder(path);
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
          collab?.closeUnder(path);
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

  const follow = (peer: Peer) => {
    if (peer.view === "board") setView("board");
    else if (peer.file) openFile(peer.file, peer.line);
  };

  const peersByFile = useMemo(() => {
    const m = new Map<string, Peer[]>();
    [...peers, ...agentPeers].forEach((p) => { if (p.file && p.view !== "board") m.set(p.file, [...(m.get(p.file) ?? []), p]); });
    return m;
  }, [peers, agentPeers]);

  const askClaude = (text: string) => {
    setView("write");
    setPreviewTab("assistant");
    setAssistantRequest({ text, key: Date.now() });
  };

  const openSuggestion = (path: string, threadId?: string) => {
    if (threadId) {
      setReviewOpen(true);
      if (path === textPath) setActiveThread(threadId);
      else pendingThread.current = threadId;
    }
    openFile(path);
  };

  const startComment = (kind: Draft["kind"] = "comment") => {
    const sel = editor.current?.selection();
    if (!sel) { notify("Select some text first, then comment or suggest an edit"); return; }
    setDraft({ from: sel.from, to: sel.to, quote: sel.text, kind });
    setReviewOpen(true);
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
      { id: "library", label: "Open reference library", section: "Action", icon: "book", run: () => navigate({ name: "library", project: projectId }) },
      { id: "ai-review", label: "AI review of the paper", section: "AI", icon: "star", run: () => setView("review") },
      { id: "assistant", label: "Ask Claude…", section: "AI", icon: "comment", run: () => { setView("write"); setPreviewTab("assistant"); } },
      { id: "citations", label: "Check citations", section: "AI", icon: "book", run: () => { setView("write"); setPreviewTab("citations"); } },
      { id: "ai-settings", label: "AI settings (API key)…", section: "AI", icon: "key", run: () => setAiSettingsOpen(true) },
      { id: "board", label: view === "board" ? "Back to writing" : "Open board", section: "View", icon: "board", hint: `${MOD}⇧B`, run: () => setView((v) => (v === "board" ? "write" : "board")) },
      { id: "comment", label: "Comment on selection", section: "Review", icon: "comment", hint: `${MOD}⌥M`, run: () => startComment("comment") },
      { id: "suggest", label: "Suggest an edit to selection", section: "Review", icon: "comment", run: () => startComment("suggestion") },
      { id: "review", label: reviewOpen ? "Hide review panel" : "Show review panel", section: "View", icon: "comment", run: () => setReviewOpen((o: boolean) => !o) },
      { id: "problems", label: showProblems ? "Hide problems" : "Show problems", section: "View", icon: "alert", run: () => setShowProblems((s) => !s) },
      { id: "sidebar", label: "Toggle sidebar", section: "View", icon: "folder", hint: `${MOD}B`, run: () => setSidebar((s: boolean) => !s) },
      { id: "newfile", label: "New file…", section: "Action", icon: "plus", run: () => void onTreeAction("newFile", "") },
      { id: "upload", label: "Upload files…", section: "Action", icon: "upload", run: () => void onTreeAction("upload", "") },
      { id: "share", label: "Share: members and invite links…", section: "Project", icon: "plus", run: () => setShareOpen(true) },
      { id: "local", label: "Work locally (git clone, agents)…", section: "Project", icon: "terminal", run: () => setLocalOpen(true) },
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
  }, [files, textPath, project, showProblems, view, reviewOpen]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="center-screen">
        <p>{loadError}</p>
        <button className="btn" onClick={() => navigate({ name: "projects" })}>Back to projects</button>
      </div>
    );
  }
  if (!project || !collab) return <div className="center-screen"><Spinner size={20} /></div>;

  const errors = result?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const warnings = result?.diagnostics.filter((d) => d.severity === "warning").length ?? 0;
  const binaryOpen = openPath && !isTextPath(openPath) ? openPath : null;
  const mdPreview = !binaryOpen && !!textPath && /\.(md|markdown)$/i.test(textPath) && !mdSource.has(textPath);
  const toggleMd = () => textPath && setMdSource((s) => { const n = new Set(s); n.has(textPath) ? n.delete(textPath) : n.add(textPath); return n; });

  return (
    <div className="workspace">
      <header className="topbar">
        <button className="icon-btn" onClick={() => navigate({ name: "projects" })} title="All projects"><Icon name="back" /></button>
        <button className="project-name" onClick={renameProject} title="Rename project">{project.name}</button>
        <span className="chip subtle" title="Main file · engine">{project.mainFile} · {ENGINES.find((e) => e.id === project.engine)?.label}</span>
        <div className="segmented">
          <button className={view === "write" ? "active" : ""} onClick={() => setView("write")}>Write</button>
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")} title={`Board (${MOD}⇧B)`}>Board</button>
          <button className={view === "review" ? "active" : ""} onClick={() => setView("review")} title="AI review">Review</button>
        </div>
        <div className="spacer" />
        <PresenceStrip peers={[...peers, ...agentPeers]} onFollow={follow} />
        {result && (
          <button className={`chip ${errors ? "danger" : warnings ? "warn" : ""}`} onClick={() => setShowProblems((s) => !s)} title="Problems">
            {errors ? <><Icon name="alert" size={13} />{errors} error{errors > 1 ? "s" : ""}</> :
              warnings ? <><Icon name="alert" size={13} />{warnings} warning{warnings > 1 ? "s" : ""}</> :
                <><Icon name="check" size={13} />Clean</>}
          </button>
        )}
        <button className="btn ghost" onClick={() => setShareOpen(true)} title="Members and invite links"><Icon name="plus" size={14} />Share</button>
        <button className="btn ghost" onClick={() => setLocalOpen(true)} title="Clone with git / work with agents"><Icon name="terminal" size={14} />Local</button>
        <button className="btn ghost" onClick={() => setHistoryOpen(true)} title="Checkpoints"><Icon name="history" size={14} />Checkpoint</button>
        <button className="btn ghost" onClick={() => setPaletteOpen(true)} title="Command palette"><kbd>{MOD}K</kbd></button>
        <button className="btn primary" onClick={compile} disabled={compiling} title={`Compile (${MOD}S)`}>
          {compiling ? <Spinner /> : <Icon name="play" size={13} />}
          {compiling ? "Compiling" : "Compile"}
        </button>
        <Avatar name={session.name} src={session.avatar} title={`Signed in as ${session.name}${session.github ? ` (@${session.github})` : ""}`} />
      </header>

      {view === "board" && (
        <Board collab={collab} session={session} files={files} peers={peers} projectName={project.name} onOpenFile={(p) => openFile(p)} />
      )}
      {view === "review" && (
        <ReviewView project={project} settings={aiSettings} onProjectChange={setProject} onOpenSettings={() => setAiSettingsOpen(true)}
          onOpen={(p, line) => openFile(p, line)} notify={notify} />
      )}
      {planning && (
        <div className="planning-banner"><Spinner /> ✦ Claude is planning your paper: research question, outline, related work and tasks. This takes about a minute.</div>
      )}
      {project.setup?.status === "error" && (
        <div className="planning-banner error-banner">Planning didn't finish: {project.setup.error} The template is ready to use; you can also ask the Assistant to plan the outline.</div>
      )}
      <div className="body" hidden={view !== "write"}>
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
              peersByFile={peersByFile}
              onOpen={(p) => openFile(p)}
              onAction={(a, p) => void onTreeAction(a, p)}
              onDropFiles={(dir, list) => void uploadTo(dir, list)}
            />
          </aside>
        )}

        <div className="panes">
          <section className="pane" ref={center} style={{ flexBasis: `${split * 100}%` }}>
            <div className={`pane-tab ${reviewOpen && !binaryOpen ? "with-review" : ""}`}>
              <Icon name={binaryOpen ? (binaryOpen.endsWith(".pdf") ? "pdf" : "image") : "file"} size={13} className="muted" />
              <span>{openPath}</span>
              {openPath && dirty.has(openPath) && <span className="dot" title="Sending edits…" />}
              {openPath && peersByFile.get(openPath)?.map((p) => <Avatar key={p.clientId} name={p.user.name} size="xs" title={`${p.user.name} is here${p.line ? ` (line ${p.line})` : ""}`} />)}
              <div className="spacer" />
              {textPath && /\.(md|markdown)$/i.test(textPath) && !binaryOpen && (
                <div className="segmented small-seg">
                  <button className={mdPreview ? "active" : ""} onClick={() => mdPreview || toggleMd()}>Read</button>
                  <button className={!mdPreview ? "active" : ""} onClick={() => mdPreview && toggleMd()}>Edit</button>
                </div>
              )}
              {!binaryOpen && !mdPreview && /\.tex$/i.test(textPath ?? "") && <span className="muted small hint">{MOD}J jump to PDF · {MOD}-click PDF to jump back</span>}
              {!binaryOpen && (
                <>
                  <button className="btn ghost tight" onClick={() => startComment()} title={`Comment on selection (${MOD}⌥M)`}><Icon name="comment" size={13} />Comment</button>
                  <button className={`chip ${reviewOpen ? "active" : ""}`} onClick={() => setReviewOpen((o: boolean) => !o)} title="Review panel">
                    Review{openThreads ? ` ${openThreads}` : ""}
                  </button>
                </>
              )}
            </div>
            <div className="pane-body row-layout">
             <div className="editor-area">
              {mdPreview && textPath && <MarkdownView collab={collab} projectId={projectId} path={textPath} onOpen={(p) => openFile(p)} />}
              {textPath && (
                <div className="fill" hidden={!!binaryOpen || mdPreview}>
                  <Editor
                    ref={editor}
                    collab={collab}
                    path={textPath}
                    revealAt={revealAt}
                    onCursor={(line) => collab.setPresence({ line })}
                    onComment={() => startComment()}
                    onThreadClick={(id) => { setReviewOpen(true); setActiveThread(id); }}
                    onCompile={compile}
                    onForwardSync={(p, l) => void forwardSync(p, l)}
                    onError={notify}
                    citeOptions={citeOptions}
                    onLibraryCite={libraryCite}
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
              {reviewOpen && !binaryOpen && (
                <ReviewPanel
                  doc={reviewDoc}
                  threads={threads}
                  session={session}
                  activeId={activeThread}
                  draft={draft}
                  onDraftDone={() => setDraft(null)}
                  onActivate={(t) => { setActiveThread(t.id); if (t.from !== null && t.to !== null) editor.current?.select(t.from, t.to); }}
                  onClose={() => setReviewOpen(false)}
                />
              )}
            </div>
            {showProblems && result && (
              <Problems result={result} onOpen={openDiagnostic} onClose={() => setShowProblems(false)}
                onFix={(d) => askClaude(`Fix this LaTeX compile error: "${d.message}"${d.file ? ` at ${d.file}${d.line ? `:${d.line}` : ""}` : ""}. Read the surrounding lines, suggest a fix, and compile to check it.`)} />
            )}
          </section>

          <div className="splitter" onPointerDown={startDrag} />

          <section className="pane preview" style={{ flexBasis: `${(1 - split) * 100}%` }}>
            <div className="preview-tabs">
              <button className={previewTab === "pdf" ? "active" : ""} onClick={() => setPreviewTab("pdf")}>PDF</button>
              <button className={previewTab === "assistant" ? "active" : ""} onClick={() => setPreviewTab("assistant")}>✦ Assistant{[...agentsMap.values()].some((x) => (x.agent ?? "Claude") === "Claude") ? <span className="live-dot" /> : null}</button>
              <button className={previewTab === "citations" ? "active" : ""} onClick={() => setPreviewTab("citations")}>Citations</button>
            </div>
            <div className="preview-body" hidden={previewTab !== "pdf"}>
              <PdfViewer
                url={pdfVersion ? api.pdfUrl(projectId, pdfVersion) : null}
                highlight={highlight}
                onInverse={(pg, x, y) => void inverseSync(pg, x, y)}
                emptyMessage={compiling ? "Compiling…" : errors ? "Fix the errors to see a PDF" : "Compile to see your paper"}
              />
            </div>
            <div className="preview-body" hidden={previewTab !== "assistant"}>
              <AssistantPanel projectId={projectId} session={session} settings={aiSettings} request={assistantRequest}
                onOpenSettings={() => setAiSettingsOpen(true)} onOpenSuggestion={openSuggestion}
                onOpenFile={(p, review) => { openFile(p); if (review) setReviewOpen(true); }} onCreateToken={() => setLocalOpen(true)} />
            </div>
            {previewTab === "citations" && (
              <div className="preview-body">
                <CitationsPanel projectId={projectId} onOpen={(p, line) => openFile(p, line)} notify={notify} />
              </div>
            )}
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
      {historyOpen && <HistoryPanel projectId={projectId} onClose={() => setHistoryOpen(false)} beforeCheckpoint={() => collab.flush()} />}
      {aiSettingsOpen && <AiSettingsDialog settings={aiSettings} onChange={setAiSettings} onClose={() => setAiSettingsOpen(false)} />}
      {shareOpen && <ShareDialog projectId={projectId} session={session} onClose={() => setShareOpen(false)} />}
      {localOpen && <LocalDialog projectId={projectId} session={session} onClose={() => setLocalOpen(false)} />}
      {prompt && <PromptDialog req={prompt} onDone={() => setPrompt(null)} />}
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
