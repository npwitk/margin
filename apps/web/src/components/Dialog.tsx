import { useState, type ReactNode } from "react";

export interface PromptRequest {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirm?: string;
  danger?: boolean;
  /** No text field — just confirm/cancel. */
  confirmOnly?: boolean;
  resolve(value: string | null): void;
}

export function PromptDialog({ req, onDone }: { req: PromptRequest; onDone(): void }) {
  const [value, setValue] = useState(req.initial ?? "");
  const finish = (v: string | null) => { req.resolve(v); onDone(); };
  return (
    <Modal onClose={() => finish(null)}>
      <form onSubmit={(e) => { e.preventDefault(); if (req.confirmOnly || value.trim()) finish(value.trim()); }}>
        <h3 className="modal-title">{req.title}</h3>
        {req.label && <p className="muted small">{req.label}</p>}
        {!req.confirmOnly && (
          <input
            className="input"
            autoFocus
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => {
              // Select the name without its extension, like Finder.
              const dot = e.target.value.lastIndexOf(".");
              const slash = e.target.value.lastIndexOf("/") + 1;
              e.target.setSelectionRange(slash, dot > slash ? dot : e.target.value.length);
            }}
          />
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => finish(null)}>Cancel</button>
          <button type="submit" className={`btn ${req.danger ? "danger" : "primary"}`} autoFocus={req.confirmOnly}>
            {req.confirm ?? "OK"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Modal({ children, onClose, wide, className }: { children: ReactNode; onClose(): void; wide?: boolean; className?: string }) {
  return (
    <div className="overlay" onMouseDown={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className={`modal ${wide ? "wide" : ""} ${className ?? ""}`} onMouseDown={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
