import { colorFor } from "@margin/shared";
import type { Peer } from "../lib/collab.ts";

export function Avatar({ name, size, online, title }: { name: string; size?: "sm" | "xs"; online?: boolean; title?: string }) {
  return (
    <span className={`avatar ${size ?? ""} ${online ? "online" : ""}`} style={{ background: colorFor(name) }} title={title ?? name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Stacked avatars of everyone in the project; click to jump to where they are. */
export function PresenceStrip({ peers, onFollow }: { peers: Peer[]; onFollow(peer: Peer): void }) {
  // One entry per person even if they have several tabs open.
  const unique = [...new Map(peers.map((p) => [p.user.name, p])).values()];
  if (!unique.length) return <span className="muted small">Only you here</span>;
  return (
    <div className="presence">
      {unique.slice(0, 6).map((p) => (
        <button key={p.clientId} className="presence-btn" onClick={() => onFollow(p)}
          title={`${p.user.name} · ${p.view === "board" ? "on the board" : p.file ? `${p.file}${p.line ? `:${p.line}` : ""}` : "browsing"} — click to follow`}>
          <Avatar name={p.user.name} online />
        </button>
      ))}
      {unique.length > 6 && <span className="muted small">+{unique.length - 6}</span>}
    </div>
  );
}
