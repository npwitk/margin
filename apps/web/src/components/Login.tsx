import { useState } from "react";
import type { AuthMethods, Session } from "@margin/shared";
import { api } from "../lib/api.ts";
import { Spinner } from "./Icon.tsx";

const GITHUB_MARK = "M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z";

export function Login({ methods, onLogin }: { methods: AuthMethods; onLogin(s: Session): void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get("auth_error"));
  const [busy, setBusy] = useState(false);
  const showForm = methods.password || methods.open;
  const invited = new URLSearchParams(location.search).has("invited");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin((await api.login(name, password)).session);
      history.replaceState(null, "", location.pathname + location.hash);
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
        {invited && !error && <p className="invite-note">You've been invited. Continue with GitHub to join.</p>}
        {methods.inviteOnly && !invited && <p className="muted small">This workspace is invite-only. Sign in with the GitHub account you were invited with.</p>}
        {methods.github && (
          <a className="btn block github" href="/api/auth/github">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={GITHUB_MARK} /></svg>
            Continue with GitHub
          </a>
        )}
        {methods.github && showForm && <div className="or"><span>or</span></div>}
        {showForm && (
          <>
            <input className="input" autoFocus={!methods.github} placeholder="Your name (shown to teammates)" value={name} onChange={(e) => setName(e.target.value)} />
            {methods.password && (
              <input className="input" type="password" placeholder="Group password" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </>
        )}
        {error && <p className="error small">{error}</p>}
        {showForm && <button className={`btn block ${methods.github ? "" : "primary"}`} disabled={busy || !name.trim()}>{busy ? <Spinner /> : "Continue"}</button>}
        {methods.open && <p className="muted small">Development mode: no login configured.</p>}
      </form>
    </div>
  );
}
