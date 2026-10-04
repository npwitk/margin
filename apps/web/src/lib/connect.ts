import { useEffect, useRef, useState } from "react";
import { applyThreadEvent, type AgentId, type AgentThread, type ApplyMode, type ConnectCommand, type ConnectDevice, type ServerToUi, type UiMessage } from "@margin/shared";

type Summary = Omit<AgentThread, "entries">;

/** Live connection to Margin Connect: your computers' agents and your agent threads in this project. */
export function useConnect(projectId: string) {
  const [devices, setDevices] = useState<ConnectDevice[]>([]);
  const [threads, setThreads] = useState<Summary[]>([]);
  const [open, setOpen] = useState<Record<string, AgentThread>>({});
  const [online, setOnline] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const waiting = useRef(new Map<string, (r: { ok: boolean; error?: string; threadId?: string }) => void>());
  const n = useRef(0);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer = 0;
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/connect/ui`);
      ws.current = socket;
      socket.onopen = () => { retry = 0; setOnline(true); socket.send(JSON.stringify({ type: "subscribe", projectId } satisfies UiMessage)); };
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerToUi;
        if (msg.type === "devices") setDevices(msg.devices);
        else if (msg.type === "threads") setThreads(msg.threads);
        else if (msg.type === "thread") setOpen((o) => ({ ...o, [msg.thread.id]: msg.thread }));
        else if (msg.type === "event") {
          setOpen((o) => (o[msg.threadId] ? { ...o, [msg.threadId]: applyThreadEvent(o[msg.threadId], msg.event) } : o));
          if (msg.event.kind === "user" || msg.event.kind === "turn_end" || msg.event.kind === "error") {
            const running = msg.event.kind === "user";
            setThreads((list) => list.map((t) => (t.id === msg.threadId ? { ...t, running, updatedAt: new Date().toISOString() } : t)));
          }
        } else if (msg.type === "response") {
          waiting.current.get(msg.reqId)?.(msg);
          waiting.current.delete(msg.reqId);
        }
      };
      socket.onclose = () => {
        setOnline(false);
        for (const w of waiting.current.values()) w({ ok: false, error: "Disconnected from Margin" });
        waiting.current.clear();
        if (!closed) timer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
    };
    connect();
    return () => { closed = true; window.clearTimeout(timer); ws.current?.close(); };
  }, [projectId]);

  const send = (deviceId: string, command: UiMessage & { type: "command" } extends { command: infer C } ? C : never) =>
    new Promise<{ ok: boolean; error?: string; threadId?: string }>((resolve) => {
      const reqId = `r${++n.current}`;
      waiting.current.set(reqId, resolve);
      ws.current?.send(JSON.stringify({ type: "command", reqId, deviceId, command } satisfies UiMessage));
    });

  return {
    online, devices, threads, open,
    openThread: (threadId: string) => ws.current?.send(JSON.stringify({ type: "open", threadId } satisfies UiMessage)),
    newThread: (deviceId: string, agentId: AgentId, mode: ApplyMode, handoffFrom?: string) => send(deviceId, { kind: "new_thread", agentId, mode, handoffFrom }),
    command: (deviceId: string, cmd: ConnectCommand) => send(deviceId, cmd),
  };
}
