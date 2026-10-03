import { useEffect, useState } from "react";
import type { Session } from "@margin/shared";
import { api } from "./lib/api.ts";
import { useRoute } from "./lib/router.ts";
import { Login } from "./components/Login.tsx";
import { Projects } from "./components/Projects.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { Spinner } from "./components/Icon.tsx";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const route = useRoute();

  useEffect(() => {
    api.session()
      .then((r) => { setSession(r.session); setPasswordRequired(r.passwordRequired); })
      .catch(() => setSession(null));
    const onUnauthorized = () => setSession(null);
    window.addEventListener("margin:unauthorized", onUnauthorized);
    return () => window.removeEventListener("margin:unauthorized", onUnauthorized);
  }, []);

  if (session === undefined) return <div className="center-screen"><Spinner size={20} /></div>;
  if (!session) return <Login passwordRequired={passwordRequired} onLogin={setSession} />;
  if (route.name === "project") return <Workspace key={route.id} projectId={route.id} session={session} />;
  return <Projects session={session} onLogout={() => setSession(null)} />;
}
