import { useEffect, useState } from "react";

export type Route = { name: "projects" } | { name: "project"; id: string } | { name: "join"; id: string; token: string };

function parse(hash: string): Route {
  const join = /^#\/join\/([a-z0-9-]+)\/([\w-]+)/.exec(hash);
  if (join) return { name: "join", id: join[1], token: join[2] };
  const m = /^#\/p\/([a-z0-9-]+)/.exec(hash);
  return m ? { name: "project", id: m[1] } : { name: "projects" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const navigate = (r: Route) => {
  location.hash = r.name === "project" ? `#/p/${r.id}` : r.name === "join" ? `#/join/${r.id}/${r.token}` : "#/";
};
