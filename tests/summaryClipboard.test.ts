// node tests/summaryClipboard.test.ts
import assert from "node:assert/strict";
import { summaryClipboardSections } from "../src/renderer/src/summaryClipboard.ts";

const summary = {
  executiveSummary: "We agreed on the release plan.",
  actionItems: [{ owner: "Dana", text: "Publish the plan" }],
  keyDecisions: ["Ship Friday"],
  openQuestions: ["Who reviews?"],
  model: "test",
  generatedAt: "2026-10-19T00:00:00Z",
};

for (const title of ["Release planning", "תכנון גרסה", ""]) {
  const sections = summaryClipboardSections(summary, title);
  const heading = title ? `${title} - Executive Summary` : "Executive Summary";
  const text = (section: typeof sections[number]) => `${section.title}\n${section.body}`;
  assert.equal(text(sections[0]), `${heading}\n${summary.executiveSummary}`);
  assert.equal(
    sections.map(text).join("\n\n"),
    `${heading}\n${summary.executiveSummary}\n\nAction Items\n- Dana: Publish the plan\n\nKey Decisions\n- Ship Friday\n\nOpen Questions\n- Who reviews?`,
  );
}

assert.deepEqual(
  summaryClipboardSections({ ...summary, actionItems: [], keyDecisions: [], openQuestions: [] }, "Renamed meeting"),
  [{ id: "exec", title: "Renamed meeting - Executive Summary", body: summary.executiveSummary }],
);
console.log("summaryClipboard ok");
