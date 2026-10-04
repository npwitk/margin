# margin-paper-mcp

Connect **Claude Code, Codex, Cursor** or any MCP client to a [Margin](https://github.com/YOUR-ORG/margin) project, the open-source collaborative LaTeX workspace.

Your agent gets the same tools as Margin's built-in assistant:
- read, search
- suggest edits, comment
- compile
- see, claim and update board tasks
- answer review comments

Co-authors see it working live ("Claude Code for Alice"), and its edits arrive as suggestions they accept.

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

License: AGPL-3.0-or-later.
