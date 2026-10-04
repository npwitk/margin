import { useEffect, useState } from "react";
import type { AuthMethods, Session } from "@margin/shared";
import { api } from "./lib/api.ts";
import { useRoute } from "./lib/router.ts";
import { Login } from "./components/Login.tsx";
import { Projects } from "./components/Projects.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { Spinner } from "./components/Icon.tsx";
import { JoinProject } from "./components/ShareDialog.tsx";
import { Library } from "./components/Library.tsx";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [methods, setMethods] = useState<AuthMethods>({ password: false, github: false, open: true });
  const route = useRoute();

  useEffect(() => {
    api.session()
      .then((r) => { setSession(r.session); setMethods(r.methods); })
      .catch(() => setSession(null));
    const onUnauthorized = () => setSession(null);
    window.addEventListener("margin:unauthorized", onUnauthorized);
    return () => window.removeEventListener("margin:unauthorized", onUnauthorized);
  }, []);

  if (session === undefined) return <div className="center-screen"><Spinner size={20} /></div>;
  if (!session) return <Login methods={methods} onLogin={setSession} />;
  if (route.name === "join") return <JoinProject id={route.id} token={route.token} />;
  if (route.name === "library") return <Library section={route.project} session={session} />;
  if (route.name === "project") return <Workspace key={route.id} projectId={route.id} session={session} />;
  return <Projects session={session} onLogout={() => setSession(null)} />;
}
