import { useSyncExternalStore } from "react";

/**
 * GitHub profile pictures by display name, learned from the session, the
 * workspace member list, the project's members and whoever is online. Any
 * <Avatar name=…> without an explicit src picks its picture up from here.
 */
const pictures = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function rememberAvatars(entries: Iterable<[string | undefined, string | undefined]>) {
  let changed = false;
  for (const [name, url] of entries) {
    if (!name || !url || !/^https:\/\//.test(url) || pictures.get(name) === url) continue;
    pictures.set(name, url);
    changed = true;
  }
  if (changed) { version++; listeners.forEach((l) => l()); }
}

export function useAvatar(name: string): string | undefined {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
  return pictures.get(name);
}
