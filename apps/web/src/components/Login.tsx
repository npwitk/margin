import { useState } from "react";
import type { Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { Spinner } from "./Icon.tsx";

export function Login({ passwordRequired, onLogin }: { passwordRequired: boolean; onLogin(s: Session): void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin((await api.login(name, password)).session);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="login" onSubmit={submit}>
        <div className="logo lg">M</div>
        <h1>Margin</h1>
        <p className="muted">Write, compile and review papers together.</p>
        <input className="input" autoFocus placeholder="Your name (shown to teammates)" value={name} onChange={(e) => setName(e.target.value)} />
        {passwordRequired && (
          <input className="input" type="password" placeholder="Group password" value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        {error && <p className="error small">{error}</p>}
        <button className="btn primary block" disabled={busy || !name.trim()}>{busy ? <Spinner /> : "Continue"}</button>
      </form>
    </div>
  );
}
