# Margin

An open-source, AI-native LaTeX workspace for research groups. Write, compile and review papers together. Agents like Claude Code and Codex work alongside you as visible teammates.

> Working name. Status: **P1 in progress**: live collaboration and the project board work.

## What works today (P0)
- Projects stored as **git repos** you own; checkpoints are commits credited to each member
- CodeMirror 6 editor with LaTeX highlighting, autosave, and conflict detection (no silent overwrites)
- Sandboxed **latexmk** compile (pdfLaTeX / XeLaTeX / LuaLaTeX) with BibTeX/biber
- PDF.js preview with **SyncTeX**: `⌘J` jumps from source to PDF; double-clicking the PDF jumps back
- Parsed errors and warnings, clickable to file:line, plus the raw log
- File tree with drag-and-drop upload (reference PDFs, figures, data) and in-app PDF/image preview
- `⌘K` command palette, Linear-style UI, light and dark themes
- Templates: article, IEEE conference, blank
- Shared-password login (each member enters their name)

## Collaboration (P1)
- **Live co-editing:** every text file is a Yjs document. Teammates' cursors show with their names, and undo only undoes *your* edits.
- **Presence:** see who's in the project and which file and line they're on. Click an avatar to follow them.
- **Board:** To do → In progress → In review → Done. Tasks have assignees, linked files and due dates. A card is marked **LIVE** while its assignee is in one of its files. Saved to `.margin/board.json` in the repo.
- **Shared preview:** when anyone compiles, everyone's PDF refreshes.
- **Safe external writes:** REST writes (scripts, and agents later) merge into the live document; stale writes are refused with a 409.

Collab runs inside the API server (Hocuspocus over `/api/collab`). Files on disk stay the source of truth for compile and git. CRDT state is cached in `DATA_DIR/ystate`, so reconnecting clients merge instead of duplicating text.

## Run locally
Requires Node 22+, git, and a TeX distribution with `latexmk` and `synctex` (e.g. MacTeX).
```sh
npm install
npm run dev          # web :5173, api :8787, compile worker :8788
```
Open http://localhost:5173. Data lives in `.data/`. In dev, auth is open unless `MARGIN_PASSWORD` is set.

## Deploy on your domain
On any VPS with Docker:
```sh
cp .env.example .env        # set MARGIN_DOMAIN, MARGIN_PASSWORD, MARGIN_SECRET (openssl rand -hex 32)
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```
Point your domain's DNS A record at the server; Caddy fetches TLS automatically. The first build pulls TeX Live (~5 GB for `latest-full`).

## Architecture
```
apps/web       React + Vite + CodeMirror 6 + PDF.js
apps/server    Hono API: auth, projects (git), files, checkpoints, live collab (Hocuspocus); proxies compile/SyncTeX
apps/compile   TeX Live sandbox: latexmk + synctex behind a tiny HTTP API
packages/shared  types + LaTeX log parser
deploy/        docker-compose + Caddy
```

### Compile sandbox
LaTeX can read files and run commands, so each compile:
- runs on a *copy* of the project (no `.git`, no symlinks, no `latexmkrc`)
- uses `-no-shell-escape -norc` and `openin_any=p` / `openout_any=p` (no absolute or parent paths)
- runs in a non-root, read-only, capped container on an internal network with no internet access
- is killed after 90 s

Before public sign-ups: per-job containers (or gVisor/Firecracker) so projects can't see each other's build dirs.

## Roadmap
- **P1, collaboration:** ~~live editing, presence, project board~~ ✓ · next: comments and suggestions, git remote for `git clone`, GitHub OAuth
- **P2, AI:** a built-in agent with tools (bring your own key), compile-error fixer, goal-based reviewer skills (`skills/*.md`), citation checker (Crossref/OpenAlex), reference library
- **P3, external agents:** a `margin-mcp` server so Claude Code and Codex claim board tasks and edit live as "Claude for <member>"
- **P4:** idea → paper workflow, Overleaf/arXiv import, public launch, Tauri desktop app

## License
AGPL-3.0-or-later
