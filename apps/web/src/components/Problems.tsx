import { useState } from "react";
import type { CompileResult, Diagnostic } from "@margin/shared";
import { Icon } from "./Icon.tsx";

interface Props {
  result: CompileResult;
  onOpen(d: Diagnostic): void;
  onFix?(d: Diagnostic): void;
  onClose(): void;
}

export function Problems({ result, onOpen, onFix, onClose }: Props) {
  const [tab, setTab] = useState<"problems" | "log">("problems");
  const counts = { error: 0, warning: 0, info: 0 };
  result.diagnostics.forEach((d) => counts[d.severity]++);

  return (
    <div className="problems">
      <div className="problems-head">
        <button className={`tab ${tab === "problems" ? "active" : ""}`} onClick={() => setTab("problems")}>
          Problems <span className="count">{result.diagnostics.length}</span>
        </button>
        <button className={`tab ${tab === "log" ? "active" : ""}`} onClick={() => setTab("log")}>Raw log</button>
        <div className="spacer" />
        <span className="muted small">
          {counts.error} errors · {counts.warning} warnings · {counts.info} layout · {(result.durationMs / 1000).toFixed(1)}s
        </span>
        <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" size={14} /></button>
      </div>
      {tab === "problems" ? (
        <div className="problems-list">
          {result.diagnostics.length === 0 && <div className="empty small">No problems. Nice.</div>}
          {result.diagnostics.map((d, i) => (
            <div key={i} className={`problem ${d.severity}`} role="button" tabIndex={0} onClick={() => d.file && onOpen(d)}>
              <span className={`sev ${d.severity}`} />
              <span className="problem-msg">{d.message}</span>
              {d.file && <span className="problem-loc">{d.file}{d.line ? `:${d.line}` : ""}</span>}
              {onFix && d.severity === "error" && (
                <button className="btn ghost tight fix-btn" onClick={(e) => { e.stopPropagation(); onFix(d); }} title="Ask Claude to fix this">✦ Fix</button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <pre className="log">{result.log}</pre>
      )}
    </div>
  );
}
