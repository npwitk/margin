const PATHS: Record<string, string> = {
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  chevron: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  folderPlus: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6",
  upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
  play: "M7 5l12 7-12 7z",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 8v5M12 16.5v.5M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  back: "M15 6l-6 6 6 6",
  minus: "M5 12h14",
  download: "M12 4v12M7 11l5 5 5-5M5 20h14",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5v.5",
  pdf: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 5v16M8 7h7",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  board: "M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v7h-4z",
  comment: "M4 5h16v11H9l-5 4z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  key: "M15 7a4 4 0 1 1-3.9 5H8v3H5v-3H3v-3h8.1A4 4 0 0 1 15 7zM16 11h.01",
  terminal: "M4 6l6 6-6 6M12 18h8",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  lines: "M5 6h14M5 10h14M5 14h10M5 18h7",
  calendar: "M5 5h14v15H5zM5 10h14M9 3v4M15 3v4",
  task: "M5 4h14v16H5zM9 12l2 2 4-4",
  paperclip: "M20 11.5l-8.2 8.2a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7.6",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8h.01",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  sidebar: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM9.5 4v16M6.5 8h1M6.5 11h1",
  outline: "M4 6h.01M8 6h12M8 12h.01M12 12h8M8 18h.01M12 18h8",
  share: "M12 3v12M8 7l4-4 4 4M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  sparkle: "M12 3c.5 4.5 2.5 6.5 7 7-4.5.5-6.5 2.5-7 7-.5-4.5-2.5-6.5-7-7 4.5-.5 6.5-2.5 7-7zM19 16.5c.2 1.4.8 2 2.2 2.2-1.4.2-2 .8-2.2 2.3-.2-1.5-.8-2.1-2.2-2.3 1.4-.2 2-.8 2.2-2.2z",
  ellipsis: "M6 12h.01M12 12h.01M18 12h.01",
  sync: "M4 12h10M10 8l4 4-4 4M18 5v14",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8",
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.file} />
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

/** Margin's mark: a page with a margin rule and lines of text, in a rounded square. */
export function AppMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="app-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="mk-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b8cff" />
          <stop offset="1" stopColor="#0a5fe0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#mk-bg)" />
      <rect x="15" y="11" width="34" height="42" rx="4" fill="#fff" />
      <path d="M23 11v42" stroke="#ff6b5b" strokeWidth="2" />
      <path d="M28 20h15M28 26h15M28 32h11M28 38h15M28 44h8" stroke="#c7d3e6" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
