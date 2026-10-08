import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AiSettings } from "@margin/shared";
import type { AppEnv } from "../auth.ts";
import { HttpError } from "../storage.ts";
import { createChat, deleteChat, getChat, listChats, runTurn, stopChat } from "./agent.ts";
import { addByDoi, checkCitations } from "./citations.ts";
import { MODEL, SHARED_KEY, describeApiError } from "./client.ts";
import { deleteKey, keyInfo, saveKey } from "./keys.ts";
import { getReview, listReviews, listSkills, startReview } from "./reviewer.ts";
import { agentToolList, runTool } from "./tools.ts";
import { startFromIdea } from "./ideaToPaper.ts";
import { applyAgentChange, snapshot } from "../connect/apply.ts";
import { cancelThread } from "../connect/relay.ts";
import { limit } from "../ratelimit.ts";
import { rememberInLibrary } from "../library.ts";
import { setAgentActivity } from "../collab.ts";
import { getProject } from "../storage.ts";
import type { Session } from "@margin/shared";

/** One presence slot per member + agent, e.g. "ext-alice-claude-code". */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
const activityKey = (s: Session) => `ext-${slug(s.name)}-${slug(s.agent ?? "agent")}`;

const wrap = (err: unknown) => new HttpError(400, describeApiError(err));

/** /api/ai: per-member settings (bring your own key). */
export const aiSettingsRoutes = new Hono<AppEnv>()
  .get("/settings", async (c) => {
    const info = await keyInfo(c.get("session").name);
    return c.json({ hasKey: !!info, last4: info?.last4, shared: !!SHARED_KEY, model: MODEL } satisfies AiSettings);
  })
  .put("/key", async (c) => {
    const { apiKey } = await c.req.json<{ apiKey?: string }>();
    const key = apiKey?.trim() ?? "";
    if (!/^sk-ant-[\w-]{20,}$/.test(key)) return c.json({ error: "That doesn't look like an Anthropic API key (it starts with sk-ant-)." }, 400);
    // Verify with a free call before storing.
    try {
      await new Anthropic({ apiKey: key, authToken: null, maxRetries: 0, timeout: 15_000 }).models.retrieve(MODEL);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return c.json({ error: "Anthropic rejected that key." }, 400);
      if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError) return c.json({ error: `That key can't use ${MODEL}.` }, 400);
      if (!(err instanceof Anthropic.APIConnectionError)) return c.json({ error: describeApiError(err) }, 400);
      // Offline: store it anyway; the first real call will report problems.
    }
    await saveKey(c.get("session").name, key);
    return c.json({ ok: true, last4: key.slice(-4) });
  })
  .delete("/key", async (c) => {
    await deleteKey(c.get("session").name);
    return c.json({ ok: true });
  });

/** /api/ai/from-idea: create a project and let Claude plan it. */
aiSettingsRoutes.post("/from-idea", limit("idea", 10, 3600), async (c) => {
  const body = await c.req.json<{ idea?: string; goal?: string; template?: string; members?: string[] }>();
  try {
    return c.json(await startFromIdea(c.get("session"), { idea: body.idea ?? "", goal: body.goal, template: body.template, members: body.members }), 202);
  } catch (err) {
    return c.json({ error: describeApiError(err) }, 400);
  }
});

/** /api/projects/:id/ai/... and /citations */
export const aiProjectRoutes = new Hono<AppEnv>()
  .onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: (err as Error).message || "Server error" }, 500);
  })

  // Assistant chats
  .get("/:id/ai/chats", async (c) => c.json(await listChats(c.req.param("id"))))
  .post("/:id/ai/chats", async (c) => {
    const { title } = await c.req.json<{ title?: string }>().catch(() => ({ title: undefined }));
    return c.json(await createChat(c.req.param("id"), c.get("session").name, title), 201);
  })
  .get("/:id/ai/chats/:chat", async (c) => {
    try { return c.json(await getChat(c.req.param("id"), c.req.param("chat"))); } catch { throw new HttpError(404, "Chat not found"); }
  })
  .delete("/:id/ai/chats/:chat", async (c) => { await deleteChat(c.req.param("id"), c.req.param("chat")); return c.json({ ok: true }); })
  .post("/:id/ai/chats/:chat/stop", (c) => { stopChat(c.req.param("chat")); return c.json({ ok: true }); })

  // Send a message; the reply streams back as server-sent events.
  .post("/:id/ai/chats/:chat/messages", limit("chat", 120, 3600), async (c) => {
    const { text, doc } = await c.req.json<{ text?: string; doc?: string }>();
    if (!text?.trim()) throw new HttpError(400, "Message is empty");
    const id = c.req.param("id"), chatId = c.req.param("chat"), session = c.get("session");
    await getChat(id, chatId).catch(() => { throw new HttpError(404, "Chat not found"); });
    return streamSSE(c, async (sse) => {
      let open = true;
      sse.onAbort(() => { open = false; });
      const queue: Promise<unknown>[] = [];
      try {
        await runTurn(id, chatId, session, text.trim().slice(0, 20_000), doc, (e) => {
          if (open) queue.push(sse.writeSSE({ data: JSON.stringify(e) }).catch(() => {}));
        });
      } catch (err) {
        if (open) await sse.writeSSE({ data: JSON.stringify({ type: "error", message: describeApiError(err) }) });
        if (open) await sse.writeSSE({ data: JSON.stringify({ type: "done" }) });
      }
      await Promise.all(queue);
    });
  })

  // Reviewer
  .get("/:id/ai/skills", async (c) => c.json((await listSkills()).map(({ body: _b, meta: _m, ...s }) => s)))
  .get("/:id/ai/reviews", async (c) => c.json(await listReviews(c.req.param("id"))))
  .post("/:id/ai/reviews/:review/cancel", async (c) => {
    const r = await getReview(c.req.param("id"), c.req.param("review"));
    if (r?.runner) await cancelThread(c.get("session"), r.runner.threadId);
    return c.json({ ok: true });
  })
  .get("/:id/ai/reviews/:review", async (c) => {
    const r = await getReview(c.req.param("id"), c.req.param("review"));
    if (!r) throw new HttpError(404, "Review not found");
    return c.json(r);
  })
  .post("/:id/ai/reviews", limit("review", 20, 3600), async (c) => {
    const { skill, goal, runner, doc } = await c.req.json<{ skill?: string; goal?: string; runner?: { deviceId: string; agentId: string }; doc?: string }>();
    try {
      return c.json(await startReview(c.req.param("id"), c.get("session"), skill ?? "general", goal, runner, doc), 202);
    } catch (err) {
      throw wrap(err);
    }
  })

  // External agents (margin-mcp): the assistant's tools over HTTP, authenticated with an access token.
  .get("/:id/agent/tools", async (c) => {
    await getProject(c.req.param("id"));
    return c.json(agentToolList());
  })
  .post("/:id/agent/tools/:name", limit("agent", 600, 3600), async (c) => {
    const id = c.req.param("id"), name = c.req.param("name");
    await getProject(id);
    const { input } = await c.req.json<{ input?: unknown }>().catch(() => ({ input: undefined }));
    const session = c.get("session");
    const agentName = session.agent ?? "Agent";
    const key = activityKey(session);
    const status = (text: string, file?: string) =>
      setAgentActivity(id, key, { chatId: key, agent: agentName, for: session.name, status: text, file, at: Date.now() });
    status(`Using ${name.replace(/_/g, " ")}`);
    return c.json(await runTool(name, input ?? {}, { projectId: id, session, agentName, status }));
  })
  // Margin Connect: a local agent's file change, and the project snapshot for its copy.
  .post("/:id/agent/apply", limit("apply", 3000, 3600), async (c) => {
    const id = c.req.param("id");
    await getProject(id);
    const body = await c.req.json<{ path: string; base: string | null; content: string | null; mode?: "edit" | "suggest" }>();
    try {
      return c.json(await applyAgentChange(id, c.get("session"), body.path, body.base, body.content, body.mode === "edit" ? "edit" : "suggest"));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
  .get("/:id/agent/snapshot", async (c) => {
    const id = c.req.param("id");
    const p = await getProject(id);
    return c.json({ project: p, files: await snapshot(id) });
  })

  // Presence for agents working in a local clone: { status, file } to show, { done: true } to clear.
  .post("/:id/agent/activity", async (c) => {
    const id = c.req.param("id");
    await getProject(id);
    const { status, file, done } = await c.req.json<{ status?: string; file?: string; done?: boolean }>().catch(() => ({} as { status?: string; file?: string; done?: boolean }));
    const session = c.get("session");
    const key = activityKey(session);
    if (done) setAgentActivity(id, key, null);
    else setAgentActivity(id, key, { chatId: key, agent: session.agent ?? "Agent", for: session.name, status: (status ?? "Working").slice(0, 120), file: file?.slice(0, 300), at: Date.now() });
    return c.json({ ok: true });
  })

  // Citations
  .get("/:id/citations", limit("citations", 20, 600), async (c) => c.json(await checkCitations(c.req.param("id"))))
  .post("/:id/citations/doi", async (c) => {
    const { doi, file } = await c.req.json<{ doi?: string; file?: string }>();
    try {
      const added = await addByDoi(c.req.param("id"), c.get("session"), doi ?? "", file);
      void rememberInLibrary({ key: added.key, type: added.type, fields: added.fields }, c.get("session"), c.req.param("id"));
      return c.json(added, 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
