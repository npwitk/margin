# margin-paper-mcp

Connect **Claude Code, Codex, Cursor** or any MCP client to a [Margin](https://github.com/npwitk/margin) project, the open-source collaborative LaTeX workspace.

Your agent works on the live paper like a co-author, with nothing to download or push. It can:
- read and search
- edit text, create and rewrite files, add sections, create documents and folders, move and delete files
- suggest edits and comment
- compile
- see, claim and update board tasks
- answer review comments
- save named versions

Co-authors see it working live ("Claude Code for Alice") with its own cursor. A project setting (Share → AI agents) decides whether edits go straight in or arrive as suggestions to accept. Everything an agent changed can be undone in one step from its avatar.

## Setup
Create an access token in Margin → **Local**, then:

```sh
# Claude Code, inside a git clone of the project (server and project come from the git remote)
claude mcp add margin -e MARGIN_TOKEN=mgn_… -- npx -y margin-paper-mcp

# Anywhere
claude mcp add margin -e MARGIN_TOKEN=mgn_… -- npx -y margin-paper-mcp --url https://paper.example.com --project my-paper-1a2b3c
```

Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.margin]
command = "npx"
args = ["-y", "margin-paper-mcp", "--url", "https://paper.example.com", "--project", "my-paper-1a2b3c"]
env = { MARGIN_TOKEN = "mgn_…" }
```

Options: `--url` / `MARGIN_URL`, `--project` / `MARGIN_PROJECT`, `--token` / `MARGIN_TOKEN`, `--name` / `MARGIN_AGENT_NAME` (the name co-authors see; detected from the client otherwise).

## `margin`: a local folder without git

The package also installs a `margin` command for people who want the files on their computer but don't use git:

```sh
npx -y -p margin-paper-mcp margin clone https://paper.example.com/#/p/my-paper-1a2b3c   # asks for the token once
cd My-Paper
# …edit…
npx -y -p margin-paper-mcp margin sync      # send your changes, get everyone else's
npx -y -p margin-paper-mcp margin status    # what changed here; is Margin newer?
```

If you and someone else changed the same lines, `sync` stops and explains how to pick a version. `margin sync --keep-both` sends both versions instead, so anyone can pick one with a click in Margin's editor. Git runs underneath, so the folder is an ordinary clone.

License: AGPL-3.0-or-later.
