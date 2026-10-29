import { useState } from "react";
import { colorFor } from "@margin/shared";
import { Icon } from "./Icon.tsx";
import { AgentLogo, brandOf } from "./AgentLogo.tsx";
import type { Peer } from "../lib/collab.ts";
import { useAvatar } from "../lib/avatars.ts";

export function Avatar({ name, size, online, title, src, agent }: { name: string; size?: "sm" | "xs"; online?: boolean; title?: string; src?: string; agent?: boolean }) {
  const known = useAvatar(name);
  const brand = agent ? brandOf(name) : null;
  src = src ?? known;
  return (
    <span className={`avatar ${size ?? ""} ${online ? "online" : ""} ${agent ? `agent ${brand ?? ""}` : ""}`} style={agent ? undefined : { background: colorFor(name) }} title={title ?? name}>
      {agent ? (brand ? <AgentLogo brand={brand} size={size === "xs" ? 9 : 12} /> : <Icon name="sparkle" size={11} />) : src ? <img src={src} alt="" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Stacked avatars of everyone in the project; click to jump to where they are. Agents open a card with what they're doing. */
export function PresenceStrip({ peers, onFollow, onRevertAgent }: { peers: Peer[]; onFollow(peer: Peer): void; onRevertAgent?(peer: Peer): void }) {
  const [card, setCard] = useState<{ peer: Peer; x: number; y: number } | null>(null);
  // One entry per person even if they have several tabs open.
  const unique = [...new Map(peers.map((p) => [p.user.name, p])).values()];
  if (!unique.length) return <span className="muted small">Only you here</span>;
  return (
    <div className="presence">
      {unique.slice(0, 6).map((p) => (
        <button key={p.clientId} className="presence-btn"
          onClick={(e) => {
            if (!p.user.agent) return onFollow(p);
            const r = e.currentTarget.getBoundingClientRect();
            setCard({ peer: p, x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 6 });
          }}
          title={p.user.agent ? `${p.user.name} · ${p.status ?? p.file ?? "working"}` : `${p.user.name} · ${p.view === "board" ? "on the board" : p.file ? `${p.file}${p.line ? `:${p.line}` : ""}` : "browsing"} — click to follow`}>
          <Avatar name={p.user.name} src={p.user.avatar} agent={p.user.agent} online={!p.user.agent} />
        </button>
      ))}
      {unique.length > 6 && <span className="muted small">+{unique.length - 6}</span>}
      {card && (
        <>
          <div className="menu-backdrop" onClick={() => setCard(null)} />
          <div className="menu agent-card" style={{ left: card.x, top: card.y }}>
            <div className="agent-card-head"><Avatar name={card.peer.user.name} agent size="sm" /><strong>{card.peer.user.name}</strong></div>
            <div className="muted small agent-card-status">{card.peer.status ?? "Working"}</div>
            {card.peer.file && <button onClick={() => { setCard(null); onFollow(card.peer); }}><Icon name="file" size={14} />Go to {card.peer.file}</button>}
            {!!card.peer.edits?.length && onRevertAgent && (
              <>
                <div className="menu-sep" />
                <div className="muted small agent-card-status">Changed {card.peer.edits.join(", ")}</div>
                <button className="danger" onClick={() => { setCard(null); onRevertAgent(card.peer); }}><Icon name="history" size={14} />Undo its edits</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
