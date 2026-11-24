import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTranscriptExport,
  safeFileName,
  speakerTurns,
} from "./transcriptExport.ts";

const seg = (speaker, start, text) => ({ speaker, start, end: start + 1, text });

test("consecutive segments from one speaker merge into a single turn", () => {
  const turns = speakerTurns([
    seg("Alice", 0, "Hello"),
    seg("Alice", 2, "there."),
    seg("Bob", 5, " Hi "),
    seg("Alice", 9, ""),
    seg("Alice", 10, "Back."),
  ]);
  assert.deepEqual(turns, [
    { speaker: "Alice", start: 0, text: "Hello there." },
    { speaker: "Bob", start: 5, text: "Hi" },
    { speaker: "Alice", start: 10, text: "Back." },
  ]);
});

test("multi-speaker transcript labels turns and uses HH:MM:SS", () => {
  const md = buildTranscriptExport({
    title: "Roadmap",
    createdAt: "2026-11-20T10:00:00Z",
    durationSec: 3725,
    segments: [seg("Alice", 0, "Hi."), seg("Bob", 3723, "Bye.")],
  });
  assert.match(md, /^# Roadmap/);
  assert.match(md, /\*\*Duration:\*\* 01:02:05/);
  assert.match(md, /\*\*Speakers:\*\* Alice, Bob/);
  assert.match(md, /\*\*Alice\*\* \[00:00:00\] Hi\./);
  assert.match(md, /\*\*Bob\*\* \[01:02:03\] Bye\./);
  assert.doesNotMatch(md, /## Summary/);
});

test("single speaker omits the speaker prefix", () => {
  const md = buildTranscriptExport({
    title: "Solo",
    createdAt: "2026-11-20T10:00:00Z",
    durationSec: 30,
    segments: [seg("Speaker 1", 4, "Note to self.")],
  });
  assert.match(md, /\[00:00:04\] Note to self\./);
  assert.doesNotMatch(md, /\*\*Speaker 1\*\*/);
});

test("summary is included before the transcript when present", () => {
  const md = buildTranscriptExport({
    title: "Sync",
    createdAt: "2026-11-20T10:00:00Z",
    durationSec: 60,
    invitees: ["Carol"],
    segments: [seg("Alice", 0, "Ship it.")],
    summary: {
      executiveSummary: "Agreed to ship Friday.",
      actionItems: [{ owner: "Alice", text: "Cut the release" }],
      keyDecisions: ["Ship Friday"],
      openQuestions: [],
      model: "m",
      generatedAt: "2026-11-20T11:00:00Z",
    },
  });
  assert.match(md, /\*\*Invited:\*\* Carol/);
  const summaryAt = md.indexOf("## Summary");
  const transcriptAt = md.indexOf("## Transcript");
  assert.ok(summaryAt > 0 && summaryAt < transcriptAt);
  assert.match(md, /- Alice: Cut the release/);
  assert.match(md, /### Key decisions\n\n- Ship Friday/);
  assert.doesNotMatch(md, /### Open questions/);
});

test("file names drop characters that are invalid on disk", () => {
  assert.equal(safeFileName("Q3: plan/review?"), "Q3 plan review");
  assert.equal(safeFileName("   "), "Meeting");
});
