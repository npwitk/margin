import { useEffect, useRef, useState } from "react";
import { createShader, playSweep, type ShaderController, type SweepOptions } from "glimm";
import { Icon } from "./Icon.tsx";

/**
 * A glimm band that crosses one pane to mark a moment: a compile you asked for landed,
 * you fixed the last error, or new errors showed up. It's punctuation, not motion, so the
 * Workspace decides when one is earned; this only plays it.
 */
export type SweepKind = "success" | "fixed" | "error";
export interface SweepSignal { kind: SweepKind; label?: string; key: number; at: number }

const LOOKS: Record<SweepKind, SweepOptions> = {
  // The new PDF comes off the press: a calm cool band, top to bottom.
  success: { palette: "lagoon", direction: "ttb", sweepMs: 1000, peakAlpha: 0.75, bandTight: 12, easing: "easeInOutCubic" },
  // Errors → clean is the one that earns the full spectrum.
  fixed: { palette: "prism", direction: "ttb", sweepMs: 1200, peakAlpha: 0.95, bandTight: 9, easing: "ease" },
  // Warm and quick across the Problems panel: look here.
  error: { palette: "ember", direction: "ltr", sweepMs: 850, peakAlpha: 0.7, bandTight: 14, easing: "easeOutQuart" },
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isDark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
};

export function Sweep({ signal }: { signal?: SweepSignal | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ctrl = useRef<ShaderController | null | undefined>(undefined);
  const [chip, setChip] = useState<SweepSignal | null>(null);

  useEffect(() => () => { ctrl.current?.destroy(); ctrl.current = undefined; }, []);

  useEffect(() => {
    // Only fresh signals: remounting a pane (reopening Problems) mustn't replay an old one.
    if (!signal || performance.now() - signal.at > 1500 || !canvas.current) return;
    let hide = 0;
    const showChip = () => { if (signal.label) setChip(signal); };
    const scheduleHide = () => { hide = window.setTimeout(() => setChip((c) => (c?.key === signal.key ? null : c)), 1600); };

    if (reducedMotion()) { showChip(); scheduleHide(); return () => window.clearTimeout(hide); }
    // The WebGL context is made on the first sweep, so a pane that never sweeps costs nothing.
    if (ctrl.current === undefined) ctrl.current = createShader({ canvas: canvas.current });
    if (!ctrl.current) { showChip(); scheduleHide(); return () => window.clearTimeout(hide); }

    const handle = playSweep(ctrl.current, { ...LOOKS[signal.kind], brightness: isDark() ? 0.85 : 1, onMidpoint: showChip });
    void handle.done.then(scheduleHide);
    return () => { handle.cancel(); window.clearTimeout(hide); };
  }, [signal?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sweep" aria-hidden={!chip}>
      <canvas ref={canvas} className="sweep-canvas" />
      {chip && (
        <div key={chip.key} className={`sweep-chip ${chip.kind}`} role="status">
          <Icon name={chip.kind === "error" ? "alert" : "check"} size={12} />{chip.label}
        </div>
      )}
    </div>
  );
}
