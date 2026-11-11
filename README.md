# Margin

**A LaTeX workspace for research groups, where co-authors, advisors and AI agents write the paper together.**

Margin is an open-source alternative to Overleaf that you host yourself. Students, co-authors and advisors edit the same paper live, compile it in the browser, leave comments and suggested edits, and track who is doing what. AI agents work in the paper the same way people do. Claude is built in, and you can connect Claude Code, Codex or any MCP client. Everyone sees what the agent is doing, and its changes arrive as suggestions that a person accepts or rejects.

Every project is a git repository on your own server. You can clone it, edit it in your own editor and sync it back, so the paper is never locked into Margin.

## Why Margin

Research groups write papers with tools that weren't built for how they work now:

- **AI is already part of the writing,** but usually outside the paper. Someone copies a section into a chat window, gets text back and pastes it in, and co-authors can't tell what changed or why. In Margin, agents work inside the project: their changes are reviewable suggestions, and their activity is visible to the whole group.
- **References are where AI does the most damage.** Made-up or mangled citations get past authors and get caught by reviewers. Margin checks every reference against Crossref and OpenAlex, and only adds references that come from real metadata.
- **A paper is more than one `.tex` file.** A group has the paper, the supplement, the rebuttal, the slides, the poster and the reading list. In Margin, one project holds all of them, with one shared reference library.
- **Your group's unpublished work should stay with your group.** Margin runs on your own server, with your own sign-in, and each member's AI keys stay encrypted on that server.

Margin is open source (AGPL-3.0) so a lab, department or university can run it, audit it and change it, and so the way it handles papers and AI is visible rather than taken on trust.

## What you can do

### Write together
- **Live co-editing** with named cursors, presence ("Alice is in `method.tex`, line 40"), and undo that only undoes your own edits.
- **Comments and suggested edits** that stay attached to their words as the text changes. Suggestions are accepted with one click.
- **A task board** (To do → In progress → In review → Done) with assignees, due dates and linked files. A card is marked LIVE while its assignee is working in one of its files.
- **Roles** for owners, editors and advisors. Invite links sign people in with GitHub, and an invited advisor sees only the papers they were invited to.
- **Updates:** a running summary of what changed in the paper, written by Claude when versions are saved, plus notes from the team.

### Compile and read
- pdfLaTeX, XeLaTeX and LuaLaTeX with BibTeX/biber, in a locked-down sandbox.
- PDF preview with **SyncTeX**: `⌘J` jumps from source to PDF, and double-clicking the PDF jumps back.
- Errors and warnings parsed into a clickable list, with **Fix with Claude** on each one.
- **Several documents per project,** one folder each (paper, supplement, slides, poster, cover letter), plus a `shared/` folder for figures and macros they all use.
- **28 templates,** including IEEE, ACM, NeurIPS, ICML, ICLR, CVPR, ACL, LNCS, Elsevier, USENIX, REVTeX, theses, Beamer, posters, CVs, rebuttals and cover letters.
- **Import** an Overleaf `.zip`, an arXiv paper's source, or a public git repository.

### References you can trust
- **Citation checker:** checks every reference used by the open document against Crossref and OpenAlex. It flags references that don't exist, wrong DOIs, papers the publisher has withdrawn, and `\cite` keys that have no entry.
- **Add by DOI:** appends clean BibTeX from the DOI's metadata.
- **One reference library for the group,** shared across papers, with PDFs, a history of which papers cite each reference, and hover cards in the editor.
- **University library access:** paywalled papers open through your institution's library proxy.

### AI that works in the open
- **Assistant:** chats shared with the whole project. Claude reads and searches the paper, compiles it, checks the board and searches the literature. It never edits directly: its changes arrive as suggestions and comments, labelled "Claude for <name>".
- **AI review:** a panel of specialist reviewers reads the paper in parallel: copy editing, consistency, claims, maths, tables and figures, a referee, and an advocate and a skeptic of the contribution. Findings are pinned to file and line, scored and turned into a report. Reviewers are plain Markdown files in [`skills/`](skills), so you can write your own for a venue or a thesis rubric.
- **From an idea to a first draft:** describe the idea, the venue and the co-authors. Claude sharpens the research question, outlines the sections, drafts the abstract, assigns first tasks, and adds real related work from OpenAlex. Nothing is generated from memory.
- **Bring your own key:** each member adds their own Anthropic API key, stored encrypted. A workspace can also set a shared key.

### Use your own tools and agents
- **Work offline in your own editor.** Run one command to download the paper and one to sync it. No git knowledge is needed:
  ```sh
  npx -y -p margin-paper-mcp margin clone https://paper.example.com/#/p/<project>
  npx -y -p margin-paper-mcp margin sync
  ```
  Or use plain git: `git clone https://<host>/git/<project>.git`. Pushes are 3-way merged into the live document, so they aren't rejected because someone was typing.
- **Connect Claude Code, Codex, Cursor or any MCP client** with [`margin-paper-mcp`](packages/mcp). The agent gets the same tools as the built-in assistant (read, search, suggest, comment, compile, claim board tasks), and it shows up live to your co-authors:
  ```sh
  claude mcp add margin -e MARGIN_TOKEN=<token> -- npx -y margin-paper-mcp --url https://paper.example.com --project <id>
  ```
- **Run Claude Code or Codex from Margin's Assistant panel** on your own computer, with your own subscription, MCP servers and skills, using [`margin-connect`](packages/connect). It speaks the [Agent Client Protocol](https://agentclientprotocol.com) and merges the agent's file changes into the live paper.
- **A REST API** for scripts and agents. Writes merge into the live document, and stale writes are refused instead of overwriting someone's work.

Access tokens are created in Margin (**Local** button). Using a subscription through third-party apps is subject to each provider's terms.

## Run it

### On your computer
Requires Node 22+, git, and a TeX distribution with `latexmk` and `synctex` (for example MacTeX or TeX Live).

```sh
npm install
npm run dev          # web :5173, api :8787, compile worker :8788
```

Open http://localhost:5173. Data lives in `.data/`. Sign-in is open in development unless `MARGIN_PASSWORD` is set.

### On your own domain
On any VPS with Docker:

```sh
cp .env.example .env        # domain, secret, GitHub sign-in, admins
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

Point your domain's DNS at the server, and Caddy gets an HTTPS certificate automatically. [DEPLOY.md](DEPLOY.md) walks through the whole setup for an invite-only server, step by step.

**Access modes:** `MARGIN_ACCESS=workspace` (the default) lets everyone signed in open every project, which suits a single lab. `MARGIN_ACCESS=members` makes each project private to its members across the web app, live editing, git and agent tokens.

## How it's built

```
apps/web          React, Vite, CodeMirror 6, PDF.js
apps/server       Hono API: auth, projects as git repos, live collaboration (Yjs + Hocuspocus),
                  AI, citations, reference library, git remote
apps/compile      TeX Live sandbox behind a small HTTP API
packages/shared   Types, BibTeX and LaTeX log parsing
packages/mcp      margin-paper-mcp: the MCP server and the `margin` clone/sync command
packages/connect  margin-connect: runs local ACP agents (Claude Code, Codex) for Margin
skills/           AI reviewer panels and rubrics, as Markdown
deploy/           docker-compose and Caddy
```

Files on disk are the source of truth for compiling and git. Live edits are Yjs documents, and checkpoints are git commits credited to each member.

### Compile sandbox
LaTeX can read files and run commands, so every compile:
- runs on a copy of the project (no `.git`, no symlinks, no `latexmkrc`)
- uses `-no-shell-escape -norc` and `openin_any=p` / `openout_any=p`, so it can't use absolute or parent paths
- runs in a non-root, read-only, resource-capped container on a network with no internet access
- is stopped after 90 seconds

## Status

Margin is ready to run today as a self-hosted, invite-only server for a group. Before it's ready for open public sign-ups, it still needs per-compile isolation (a container, gVisor or Firecracker per job), per-user quotas, abuse handling and backups. A desktop app is planned.

Contributions, bug reports and new reviewer skills are welcome.

## Credits

The reviewer panels are adapted from Claes Bäckman's [AI-research-feedback](https://github.com/claesbackman/AI-research-feedback) skills (MIT), generalised from economics to any field.

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html). If you run a modified Margin as a service, you must share your changes with its users.
