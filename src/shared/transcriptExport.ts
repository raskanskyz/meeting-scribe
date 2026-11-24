import type { MeetingSummary, TranscriptSegment } from "./types";

export interface TranscriptExportInput {
  title: string;
  createdAt: string;
  durationSec: number;
  segments: TranscriptSegment[];
  /** calendar attendees, when the recording came from an event */
  invitees?: string[];
  summary?: MeetingSummary | null;
}

/** HH:MM:SS, the same shape the transcript view shows */
export function exportTs(sec: number): string {
  const s = Math.floor(sec);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Collapse consecutive segments from the same speaker into one turn. */
export function speakerTurns(segments: TranscriptSegment[]) {
  const turns: { speaker: string; start: number; text: string }[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) last.text += " " + text;
    else turns.push({ speaker: seg.speaker, start: seg.start, text });
  }
  return turns;
}

/** Strip characters that are invalid in file names on macOS/Windows. */
export function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Meeting").slice(0, 120);
}

/**
 * Markdown built to be pasted into an AI chat. Header facts first, then the
 * optional summary, then the transcript as one paragraph per speaker turn
 * with the turn's start time. Plain text, so it reads the same anywhere.
 */
export function buildTranscriptExport(input: TranscriptExportInput): string {
  const { segments, summary } = input;
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const single = speakers.length <= 1;
  const lines: string[] = [`# ${input.title || "Meeting"}`, ""];

  const created = new Date(input.createdAt);
  if (!isNaN(created.getTime()))
    lines.push(`- **Date:** ${created.toLocaleString()}`);
  if (input.durationSec > 0)
    lines.push(`- **Duration:** ${exportTs(input.durationSec)}`);
  if (speakers.length)
    lines.push(`- **Speakers:** ${speakers.join(", ")}`);
  if (input.invitees?.length)
    lines.push(`- **Invited:** ${input.invitees.join(", ")}`);
  lines.push("");
  lines.push(
    "_Speaker labels are automatic and may be wrong. Timestamps are from the start of the recording._",
    "",
  );

  if (summary) {
    lines.push("## Summary", "", summary.executiveSummary.trim(), "");
    if (summary.actionItems.length) {
      lines.push("### Action items", "");
      for (const a of summary.actionItems)
        lines.push(`- ${a.owner ? `${a.owner}: ` : ""}${a.text}`);
      lines.push("");
    }
    if (summary.keyDecisions.length) {
      lines.push("### Key decisions", "");
      for (const d of summary.keyDecisions) lines.push(`- ${d}`);
      lines.push("");
    }
    if (summary.openQuestions.length) {
      lines.push("### Open questions", "");
      for (const q of summary.openQuestions) lines.push(`- ${q}`);
      lines.push("");
    }
  }

  lines.push("## Transcript", "");
  for (const turn of speakerTurns(segments)) {
    const who = single ? "" : `**${turn.speaker}** `;
    lines.push(`${who}[${exportTs(turn.start)}] ${turn.text}`, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
