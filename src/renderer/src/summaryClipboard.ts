import type { MeetingSummary } from "../../shared/types";

export function summaryClipboardSections(
  summary: MeetingSummary,
  meetingTitle: string,
) {
  const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");
  const out = [
    {
      id: "exec",
      title: meetingTitle
        ? `${meetingTitle} - Executive Summary`
        : "Executive Summary",
      body: summary.executiveSummary,
    },
  ];
  if (summary.actionItems.length)
    out.push({
      id: "action",
      title: "Action Items",
      body: bullets(
        summary.actionItems.map(
          (a) => `${a.owner ? `${a.owner}: ` : ""}${a.text}`,
        ),
      ),
    });
  if (summary.keyDecisions.length)
    out.push({
      id: "decisions",
      title: "Key Decisions",
      body: bullets(summary.keyDecisions),
    });
  if (summary.openQuestions.length)
    out.push({
      id: "questions",
      title: "Open Questions",
      body: bullets(summary.openQuestions),
    });
  return out;
}
