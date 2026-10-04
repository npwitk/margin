# Margin

An open-source, AI-native LaTeX workspace for research groups. Write, compile and review papers together. Agents like Claude Code and Codex work alongside you as visible teammates.

> Working name. Status: **P3 complete** (external agents). Next up: P4 (idea → paper workflow, public launch).

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
- **Comments and suggested edits:** select text and press `⌘⌥M`. Comments stay attached to their words as the text changes. Suggestions show inline (old text struck through, new text next to it) and are accepted with one click.
- **Work locally with git:** `git clone https://<host>/git/<project>.git`, using a personal access token (**Local** button) as the password. Pulls include teammates' live edits. A push is 3-way merged into the live document, so it isn't rejected because someone was typing. Force pushes are refused.
- **Sign-in:** GitHub (restricted to `MARGIN_GITHUB_ALLOW`), a shared group password, or both.
- **Safe external writes:** REST writes (scripts, agents) merge into the live document; stale writes are refused with a 409.

### Review API (for scripts and agents)
```
GET  /api/projects/:id/review?path=sections/method.tex        list threads (with line numbers)
POST /api/projects/:id/review   {path, quote, kind: "comment"|"suggestion", message?, replacement?}
POST /api/projects/:id/review/:thread   {path, action: "reply"|"accept"|"resolved"|"rejected"|"open", text?}
```

Collab runs inside the API server (Hocuspocus over `/api/collab`). Files on disk stay the source of truth for compile and git. CRDT state is cached in `DATA_DIR/ystate`, so reconnecting clients merge instead of duplicating text.

## AI (P2)
Claude (`claude-opus-5-5`) is built in. Bring your own key: each member adds their Anthropic API key in **AI settings**, stored encrypted on the server. A workspace can also set a shared `ANTHROPIC_API_KEY`.
- **Assistant** (preview pane → ✦ Assistant): chats shared with the project. Claude reads and searches files, compiles, checks the board and searches the web for literature. It **never edits directly**: changes arrive as suggestions and comments in the Review panel, and teammates see "Claude for <name>" working live.
- **Fix with Claude:** a button on every compile error.
- **AI review** (Review view): set your publishing goal, pick a rubric from `skills/*.md`, and get a 1–10 readiness score per criterion with concrete issues pinned to the exact text. One click turns an issue into a comment. Rubrics are plain Markdown, so add your venue's.
- **Citation checker** (preview pane → Citations): every `.bib` entry is checked against Crossref and OpenAlex. Made-up, mismatched or wrong-DOI references and `\cite` keys missing from the `.bib` are flagged. **Add by DOI** appends clean BibTeX.

Refusals fall back automatically (`fallbacks: "default"`); the agent's history is append-only and prompt-cached.

## Your own agents (P3)
`packages/mcp` is **margin-mcp**, an MCP server that connects Claude Code, Codex, Cursor or any MCP client to a Margin project with the same tools as the built-in assistant: read, search, suggest edits, comment, compile, list/claim/update board tasks, and read/answer review comments. The agent shows up live for the whole group ("Claude Code for Alice"), and its edits arrive as suggestions.

```sh
# Inside a git clone of the project (URL and project are read from the remote):
claude mcp add margin -e MARGIN_TOKEN=<token> -- npx -y margin-mcp
# Anywhere:
claude mcp add margin -e MARGIN_TOKEN=<token> -- npx -y margin-mcp --url https://paper.example.com --project <id>
```
Create the token in **Local** (the same dialog shows Codex and generic MCP config). Until it's published to npm, build it with `npm run build -w margin-mcp` and use `node packages/mcp/dist/index.js`.

Under the hood, agents call `/api/projects/:id/agent/tools/:name` with `Authorization: Bearer <token>`. Scripts can use the same API.

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
cp .env.example .env        # MARGIN_DOMAIN, MARGIN_SECRET (openssl rand -hex 32), and a password and/or GitHub app
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
- **P1, collaboration:** ✓ live editing, presence, board, comments and suggestions, git remote, GitHub sign-in
- **P2, AI:** ✓ assistant with tools, compile-error fixer, reviewer skills, citation checker, add by DOI · later: PDF reference library (GROBID), chat with your papers
- **P3, external agents:** ✓ margin-mcp (Claude Code, Codex, any MCP client), token auth for the API, agent presence, task claiming, comment replies · later: publish to npm, remote MCP over HTTP
- **P4:** idea → paper workflow, Overleaf/arXiv import, public launch, Tauri desktop app

## License
AGPL-3.0-or-later
