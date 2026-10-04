# Margin

An open-source, AI-native LaTeX workspace for research groups. Write, compile and review papers together. Agents like Claude Code and Codex work alongside you as visible teammates.

> Working name. Status: **P4**: idea → paper, importers, membership and invites done. See the roadmap for what's left before public sign-ups.

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
`packages/mcp` is **margin-paper-mcp**, an MCP server that connects Claude Code, Codex, Cursor or any MCP client to a Margin project with the same tools as the built-in assistant: read, search, suggest edits, comment, compile, list/claim/update board tasks, and read/answer review comments. The agent shows up live for the whole group ("Claude Code for Alice"), and its edits arrive as suggestions.

```sh
# Inside a git clone of the project (URL and project are read from the remote):
claude mcp add margin -e MARGIN_TOKEN=<token> -- npx -y margin-paper-mcp
# Anywhere:
claude mcp add margin -e MARGIN_TOKEN=<token> -- npx -y margin-paper-mcp --url https://paper.example.com --project <id>
```
Create the token in **Local** (the same dialog shows Codex and generic MCP config). Until it's published to npm, build it with `npm run build -w margin-paper-mcp` and use `node packages/mcp/dist/index.js`.

Under the hood, agents call `/api/projects/:id/agent/tools/:name` with `Authorization: Bearer <token>`. Scripts can use the same API.

## Bring your own agent: Margin Connect
Drive **Claude Code** or **Codex** from Margin's ✦ Assistant panel, running on your own computer with your own sign-in, MCP servers and skills:
```sh
npx -y margin-connect --url https://paper.example.com --token mgn_…   # or: node packages/connect/dist/index.js …
```
The bridge (`packages/connect`) speaks the [Agent Client Protocol](https://agentclientprotocol.com) to each agent. It keeps a local copy of the project in sync and 3-way merges the agent's file changes into the live paper, as suggestions or direct edits. It streams plans, tool calls and permission prompts to the browser, attaches Margin's MCP tools, shows the agent to co-authors, and lets you hand a thread to another agent mid-conversation. Other ACP agents can be added with `MARGIN_CONNECT_AGENTS`.

## Start a paper (P4)
**New paper** offers three starts:
- **From a template:** article, IEEE conference or blank.
- **Import existing work:** an Overleaf `.zip` (Menu → Download → Source), an arXiv paper's LaTeX source (`1706.03762` or its URL), or a public `https://` git repository. The main file and engine (pdfLaTeX/XeLaTeX/LuaLaTeX) are detected. Archives are size-capped and path-checked, and git imports can't reach private networks.
- **✦ From an idea:** describe the idea, a target venue and co-authors. Claude sharpens the research question, outlines sections into files, drafts the abstract and puts first tasks on the board for each co-author. It adds **real** related work (OpenAlex search plus DOI metadata, never generated) to `refs/references.bib` and `notes/idea.md`.

## Sharing and access
- `MARGIN_ACCESS=workspace` (default): a group's own server; everyone signed in can open every project.
- `MARGIN_ACCESS=members`: for public sign-ups, and the default when `MARGIN_GITHUB_ALLOW=*`. Projects are private to their members across the API, live editing, git and agent tokens. Owners invite people with 14-day links (**Share**) and manage roles. Requires GitHub sign-in, since password names are self-declared.
- Membership is stored outside the project's git repo, so a push can't change it.
- Per-member rate limits cover compiles, imports, AI and new projects (`MARGIN_RATE_LIMITS=off` to disable).

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
- **P3, external agents:** ✓ margin-paper-mcp (Claude Code, Codex, any MCP client), token auth for the API, agent presence, task claiming, comment replies · later: publish to npm, remote MCP over HTTP
- **P4:** ✓ idea → paper, Overleaf/arXiv/git import, members and invites, rate limits, npm-ready margin-paper-mcp · before public sign-ups: per-job compile isolation (gVisor/Firecracker or a container per compile), quotas and storage limits per user, email/abuse handling, backups · later: Tauri desktop app, PDF reference library

## License
AGPL-3.0-or-later
