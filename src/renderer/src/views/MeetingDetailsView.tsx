import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, Pencil } from "lucide-react";
import { api } from "../api";
import { summaryClipboardSections } from "../summaryClipboard";
import { SPEAKER_COLORS } from "../speakerColors";
import { fmtDur, fmtTs, phaseLabel } from "../fmt";
import MeetingPlayer, { type PlayerHandle } from "../components/MeetingPlayer";
import SpeakerTimeline, { type Lane } from "../components/SpeakerTimeline";
import Transcript from "../components/Transcript";
import type { AiJobType, AiNotice } from "../aiJobs";
import type {
  ClaudeStatus,
  MeetingSummary,
  RecordingMeta,
  SpeakerInfo,
  TranscribeProgress,
  TranscriptSegment,
} from "../../../shared/types";

interface Props {
  rec: RecordingMeta;
  onBack: () => void;
  /** in-flight AI job for this recording (owned by App so it survives navigation) */
  job?: AiJobType;
  /** outcome of the last finished AI job for this recording */
  notice?: AiNotice;
  /** transcription progress for this recording (owned by App) */
  progress?: TranscribeProgress;
  onGenerate: () => void;
  onLint: () => void;
  onRename: (title: string) => void;
  onTranscribe: () => void;
}

export default function MeetingDetailsView({
  rec,
  onBack,
  job,
  notice,
  progress,
  onGenerate,
  onLint,
  onRename,
  onTranscribe,
}: Props) {
  const [segs, setSegs] = useState<TranscriptSegment[] | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerInfo[]>([]);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [showTx, setShowTx] = useState(true);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [curTime, setCurTime] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const playerRef = useRef<PlayerHandle | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);

  const busy =
    progress && progress.phase !== "done" && progress.phase !== "error";

  useEffect(() => {
    let live = true;
    setFolder(null);
    api.recordingFolder(rec.id).then((f) => live && setFolder(f));
    return () => {
      live = false;
    };
  }, [rec.id]);

  // refetch when an AI job or a transcription finishes, so results appear even
  // if this view was closed and reopened while the job ran
  useEffect(() => {
    api.getTranscriptSegments(rec.id).then(setSegs);
    api.getSpeakers(rec.id).then(setSpeakers);
    api.getSummary(rec.id).then(setSummary);
    api.claudeStatus().then(setClaude);
  }, [rec.id, job, progress?.phase]);

  // Esc / ⌘[ go back to the library (unless typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "[")) {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const generating = job === "summary";
  const linting = job === "lint";
  const genError = (notice?.type === "summary" && notice.error) || "";
  const lintMsg =
    notice?.type === "lint"
      ? (notice.error ??
        (notice.changed
          ? `Fixed ${notice.changed} segment${notice.changed === 1 ? "" : "s"}.`
          : "No corrections needed."))
      : "";

  const { lanes, duration } = useMemo(() => {
    const list = segs ?? [];
    const duration = Math.max(rec.durationSec, ...list.map((s) => s.end), 1);
    const byName = new Map<string, Lane>();
    list.forEach((s, i) => {
      const lane = byName.get(s.speaker) ?? {
        name: s.speaker,
        total: 0,
        turns: 0,
        segs: [],
      };
      lane.total += Math.max(0, s.end - s.start);
      // a turn starts whenever this speaker takes over from someone else
      if (list[i - 1]?.speaker !== s.speaker) lane.turns++;
      lane.segs.push(s);
      byName.set(s.speaker, lane);
    });
    return {
      lanes: [...byName.values()].sort((a, b) => b.total - a.total),
      duration,
    };
  }, [segs, rec.durationSec]);

  const colorOf = (name: string) =>
    SPEAKER_COLORS[
      Math.max(
        0,
        lanes.findIndex((l) => l.name === name),
      ) % SPEAKER_COLORS.length
    ];

  const saveTitle = () => {
    const value = editTitle?.trim();
    setEditTitle(null);
    if (value && value !== rec.title) onRename(value);
  };

  const renameSpeaker = async (clusters: string[], name: string) => {
    for (const cluster of clusters) {
      const updated = await api.renameSpeaker(rec.id, cluster, name);
      if (updated) setSpeakers(updated);
    }
    api.getTranscriptSegments(rec.id).then(setSegs);
  };
  const seek = (sec: number) => playerRef.current?.seek(sec);

  const copySection = (key: string, text: string) => {
    api.copyText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };

  // One source of truth for copied summary sections. Each section
  // title travels with the text, and Copy all is the same list joined up
  const summarySections = useMemo(() => {
    if (!summary) return [];
    return summaryClipboardSections(summary, rec.title);
  }, [summary, rec.title]);

  const sectionText = (id: string) => {
    const s = summarySections.find((x) => x.id === id);
    return s ? `${s.title}\n${s.body}` : "";
  };
  const allSectionsText = summarySections
    .map((s) => `${s.title}\n${s.body}`)
    .join("\n\n");

  const CopyBtn = ({
    id,
    text,
    label,
  }: {
    id: string;
    text: string;
    label?: string;
  }) => (
    <button
      className="copy-btn"
      onClick={() => copySection(id, text)}
      title="Copy to clipboard"
    >
      {copied === id ? "Copied ✓" : (label ?? "Copy")}
    </button>
  );

  return (
    <div>
      <header className="view-head">
        <button className="back-link" onClick={onBack} title="Back (Esc)">
          <ChevronLeft size={13} aria-hidden="true" /> Library
        </button>
        <span className="eyebrow">Meeting</span>
        {editTitle !== null ? (
          <input
            className="inline-edit"
            style={{ width: 380, fontSize: 17 }}
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTitle();
              if (e.key === "Escape") setEditTitle(null);
            }}
            onBlur={saveTitle}
          />
        ) : (
          <h2>
            {rec.title}{" "}
            <button
              className="icon"
              title="Rename meeting"
              onClick={() => setEditTitle(rec.title)}
            >
              <Pencil size={14} />
            </button>
          </h2>
        )}
        <div className="rec-meta">
          {new Date(rec.createdAt).toLocaleString()} · {fmtDur(rec.durationSec)}
          {rec.speakers?.length ? <> · {rec.speakers.join(", ")}</> : null}
        </div>
      </header>

      <div className="card">
        {rec.audioDeletedAt ? (
          <p className="hint">
            Raw audio was deleted{" "}
            {new Date(rec.audioDeletedAt).toLocaleString()} to reclaim disk
            space (Settings → Disk space). Playback and re-transcription are no
            longer possible.
          </p>
        ) : (
          <MeetingPlayer
            recId={rec.id}
            tracks={rec.tracks}
            durationSec={rec.durationSec}
            onTime={setCurTime}
            handleRef={playerRef}
            follower={rec.hasScreen ? screenVideoRef : undefined}
          />
        )}
      </div>

      {rec.hasScreen && (
        <div className="card">
          <div className="panel-title">Screen</div>
          <video
            controls
            preload="metadata"
            src={`media://rec/${rec.id}/screen.webm`}
            ref={screenVideoRef}
            style={{ width: "100%", borderRadius: 8 }}
          />
          <p className="hint" style={{ marginTop: 8 }}>
            The video follows the player above - press play there (or click the
            timeline) and it stays in sync, sound included.
          </p>
        </div>
      )}

      <div className="card">
        <div className="panel-title">Speaker Timeline</div>
        {segs === null ? (
          <p className="hint">Loading…</p>
        ) : lanes.length === 0 ? (
          busy ? (
            <div>
              <div className="rec-meta" style={{ marginBottom: 6 }}>
                {phaseLabel(progress)}
              </div>
              <div
                className={
                  typeof progress.pct === "number"
                    ? "progress"
                    : "progress indeterminate"
                }
              >
                <div
                  style={
                    typeof progress.pct === "number"
                      ? { width: `${progress.pct}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <p className="hint">
                No transcript yet - transcribe this recording to see who spoke
                when, plus the full text.
              </p>
              {!rec.audioDeletedAt && (
                <button className="primary" onClick={onTranscribe}>
                  Transcribe
                </button>
              )}
            </div>
          )
        ) : (
          <>
            <SpeakerTimeline
              lanes={lanes}
              duration={duration}
              curTime={curTime}
              speakers={speakers}
              colorOf={colorOf}
              onSeek={seek}
              follow={follow}
              onFollow={setFollow}
              onRename={renameSpeaker}
            />
            {rec.diarization && rec.diarization !== "ok" && (
              <p className="hint" style={{ marginTop: 8 }}>
                Speaker identification skipped: {rec.diarization}
              </p>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="panel-title-row">
          <div className="panel-title">AI Summary</div>
          <div className="row">
            {folder && (
              <CopyBtn id="folder" label="Copy folder path" text={folder} />
            )}
            {summary && !generating && (
              <CopyBtn id="all" label="Copy all" text={allSectionsText} />
            )}
            {segs !== null &&
              lanes.length > 0 &&
              claude?.available &&
              !generating && (
                <button className="ghost" onClick={onGenerate} disabled={!!job}>
                  {summary ? "Regenerate" : "Generate summary"}
                </button>
              )}
          </div>
        </div>

        {generating && (
          <div>
            <div className="rec-meta" style={{ marginBottom: 6 }}>
              Reading the transcript with Claude - usually 15–60 seconds…
            </div>
            <div className="progress indeterminate">
              <div />
            </div>
          </div>
        )}
        {genError && <div className="warn-banner">{genError}</div>}

        {!generating && !summary && !genError && (
          <p className="hint">
            {claude === null
              ? "Checking for Claude Code…"
              : claude.available
                ? "Generate an executive summary, action items, and key decisions from the transcript. Runs through your locally installed Claude Code using your own subscription - no API key involved."
                : `${claude.reason}. Install Claude Code and sign in with your subscription to enable AI summaries, or set the binary path in Settings.`}
          </p>
        )}

        {summary && !generating && (
          <div className="sum-body">
            <div className="sum-panel">
              <div className="sum-panel-head">
                <h3>Executive Summary</h3>
                <CopyBtn id="exec" text={sectionText("exec")} />
              </div>
              <p dir="auto">{summary.executiveSummary}</p>
            </div>
            {summary.actionItems.length > 0 && (
              <div className="sum-panel">
                <div className="sum-panel-head">
                  <h3>Action Items</h3>
                  <CopyBtn id="action" text={sectionText("action")} />
                </div>
                <ul>
                  {summary.actionItems.map((a, i) => (
                    <li key={i} dir="auto">
                      {a.owner && <strong>{a.owner}: </strong>}
                      {a.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.keyDecisions.length > 0 && (
              <div className="sum-panel">
                <div className="sum-panel-head">
                  <h3>Key Decisions</h3>
                  <CopyBtn id="decisions" text={sectionText("decisions")} />
                </div>
                <ul>
                  {summary.keyDecisions.map((d, i) => (
                    <li key={i} dir="auto">
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.openQuestions.length > 0 && (
              <div className="sum-panel">
                <div className="sum-panel-head">
                  <h3>Open Questions</h3>
                  <CopyBtn id="questions" text={sectionText("questions")} />
                </div>
                <ul>
                  {summary.openQuestions.map((q, i) => (
                    <li key={i} dir="auto">
                      {q}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="sum-meta">
              Generated {new Date(summary.generatedAt).toLocaleString()} ·{" "}
              {summary.model} · local Claude Code
            </div>
          </div>
        )}
      </div>

      {segs !== null && segs.length > 0 && (
        <div className="card">
          <div className="panel-title-row">
            <div className="row">
              <div className="panel-title">Transcript</div>
              {rec.polishedAt && (
                <span
                  className="badge ai"
                  title={`Polished ${new Date(rec.polishedAt).toLocaleString()}`}
                >
                  ✓ polished
                </span>
              )}
            </div>
            <div className="row">
              {claude?.available && (
                <button className="ghost" onClick={onLint} disabled={!!job}>
                  {linting ? "Polishing…" : "Polish with Claude"}
                </button>
              )}
              {showTx && (
                <label className="follow-toggle" title="Keep the part being played in view">
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(e) => setFollow(e.target.checked)}
                  />
                  Follow playback
                </label>
              )}
              <button className="ghost" onClick={() => setShowTx((v) => !v)}>
                {showTx ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          {linting && (
            <div style={{ marginTop: 12 }}>
              <div className="rec-meta" style={{ marginBottom: 6 }}>
                Fixing recognition errors and normalizing terms - the original
                is kept as transcript.raw.json…
              </div>
              <div className="progress indeterminate">
                <div />
              </div>
            </div>
          )}
          {lintMsg && !linting && (
            <p className="hint" style={{ marginTop: 10 }}>
              {lintMsg}
            </p>
          )}
          {showTx && (
            <Transcript
              segs={segs}
              curTime={curTime}
              follow={follow}
              colorOf={colorOf}
              onSeek={seek}
            />
          )}
        </div>
      )}
    </div>
  );
}
