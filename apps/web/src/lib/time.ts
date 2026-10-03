export function relativeTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"]];
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, name] = units[i];
    if (s >= size) {
      const n = Math.round(s / size);
      return i === units.length - 1 && n > 4 ? new Date(iso).toLocaleDateString() : `${n} ${name}${n > 1 ? "s" : ""} ago`;
    }
  }
  return "just now";
}
