import { useState } from "react";
import type { AiSettings } from "@margin/shared";
import { api } from "../lib/api.ts";
import { Modal } from "./Dialog.tsx";
import { Spinner } from "./Icon.tsx";

export function AiSettingsDialog({ settings, onChange, onClose }: { settings: AiSettings | null; onChange(s: AiSettings): void; onClose(): void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveAiKey(key);
      setKey("");
      onChange(await api.aiSettings());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="modal-title">AI settings</h3>
      <p className="muted small">
        Margin uses Claude ({settings?.model ?? "claude-opus-5-5"}) with your own Anthropic API key, so usage is billed to your account.
        Keys are stored encrypted on this server and never shown again. Create one at{" "}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>.
      </p>
      {settings?.hasKey ? (
        <div className="row gap key-row">
          <span className="grow">Your key: <code>sk-ant-…{settings.last4}</code></span>
          <button className="btn ghost danger-text" onClick={async () => { await api.deleteAiKey(); onChange(await api.aiSettings()); }}>Remove</button>
        </div>
      ) : settings?.shared ? (
        <p className="small">This workspace has a shared key, so you can use Claude now. Add your own to bill your account instead.</p>
      ) : null}
      <form className="row gap" onSubmit={save}>
        <input className="input" type="password" autoFocus placeholder={settings?.hasKey ? "Replace with a new key…" : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn primary" disabled={busy || !key.trim()}>{busy ? <Spinner /> : "Save"}</button>
      </form>
      {error && <p className="error small">{error}</p>}
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
