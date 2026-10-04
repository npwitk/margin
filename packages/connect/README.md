# margin-connect

Use **Claude Code, Codex** (and other [ACP](https://agentclientprotocol.com) agents) inside [Margin](https://github.com/YOUR-ORG/margin), the open-source collaborative LaTeX workspace, from the browser. You keep your own sign-in, settings, MCP servers and skills.

```sh
npx -y margin-connect --url https://paper.example.com --token mgn_…
```
Create the token in Margin → **Local**. The URL and token are remembered in `~/.margin-connect`. Then open a project → **✦ Assistant** → pick *Claude Code* or *Codex*.

How it works:
- Agents run on your computer through their ACP adapters (`@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`), from their normal config folders, signed in as you (`claude`, `codex login`).
- Each project gets a local copy in `~/.margin-connect/workspaces/…`, with a git baseline so agents can `git diff`, refreshed before every prompt. Files the agent changes are 3-way merged into the live paper, either as **suggestions** or as **direct edits**. Build outputs are never synced.
- Margin's MCP tools (board, comments, compile) are attached to every session.
- Permission requests, plans, tool calls and replies stream to the browser, and co-authors see "Claude Code for <you>" working live. Threads can be **handed off** to another agent mid-conversation.

More agents: `MARGIN_CONNECT_AGENTS='[{"id":"gemini","name":"Gemini CLI","command":"gemini","args":["--experimental-acp"]}]'`.

Using a subscription through third-party apps is subject to each provider's terms; an API key always works.

License: AGPL-3.0-or-later.
