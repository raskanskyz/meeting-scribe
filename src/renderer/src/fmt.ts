/** hh:mm:ss clock for the recording timer */
export function fmtClock(sec: number): string {
  const s = Math.floor(sec);
  return [s / 3600, (s % 3600) / 60, s % 60]
    .map((n) => String(Math.floor(n)).padStart(2, "0"))
    .join(":");
}

/** compact duration: "1h 23m" / "5m 12s" */
export function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}h ${m % 60}m`
    : `${m}m ${Math.floor(sec % 60)}s`;
}

/** transcript timestamp: "03:12" or "1:03:12" */
export function fmtTs(sec: number): string {
  const s = Math.floor(sec);
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return `${h ? `${p(h)}:` : ""}${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** human description of a transcription phase (shared by Library + Details) */
export function phaseLabel(p: {
  phase?: string;
  pct?: number;
  track?: string;
}): string {
  switch (p.phase) {
    case "downloading":
      return `Downloading model - ${p.pct ?? 0}%`;
    case "loading":
      return "Loading model…";
    case "transcribing":
      return `Transcribing ${p.track ?? ""} - ${p.pct ?? 0}%`;
    case "diarizing":
      return `Identifying speakers - ${p.pct ?? 0}%`;
    case "merging":
      return "Merging speakers…";
    case "linting":
      return "Polishing transcript with Claude…";
    case "summarizing":
      return "Generating summary with Claude…";
    default:
      return "";
  }
}

/** display name for an ISO language code ("he" → "Hebrew") */
const displayNames = new Intl.DisplayNames([navigator.language], {
  type: "language",
});
export function langName(code: string): string {
  if (code === "auto") return "Auto-detect";
  try {
    return displayNames.of(code) ?? code;
  } catch {
    return code;
  }
}
