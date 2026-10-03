/** localStorage helpers for per-viewer conveniences; failures are harmless. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`margin:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`margin:${key}`, JSON.stringify(value));
  } catch {
    /* private mode, quota, etc. */
  }
}
