import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ChevronRight, Mic, MoreHorizontal, Search } from "lucide-react";
import { api } from "../api";
import { fmtDur, langName, phaseLabel } from "../fmt";
import type { AiJobType } from "../aiJobs";
import type {
  RecordingMeta,
  Settings,
  TranscribeProgress,
} from "../../../shared/types";

function groupLabel(iso: string): string {
  const mid = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((mid(new Date()) - mid(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 31) return "This month";
  return "Earlier";
}

interface Props {
  settings: Settings;
  /** true while this list is visible - views stay mounted, so refetch on show */
  active: boolean;
  /** bumped by App when a recording finishes or is renamed elsewhere */
  epoch: number;
  // owned by App so an in-flight job survives leaving and returning to this tab
  progress: Record<string, TranscribeProgress>;
  setProgress: Dispatch<SetStateAction<Record<string, TranscribeProgress>>>;
  onOpen: (rec: RecordingMeta) => void;
  onRecord: () => void;
  aiJobs: Record<string, AiJobType | undefined>;
}

export default function LibraryView({
  settings,
  active,
  epoch,
  progress,
  setProgress,
  onOpen,
  onRecord,
  aiJobs,
}: Props) {
  const [recs, setRecs] = useState<RecordingMeta[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "done" | "todo">("all");
  // date window; recent meetings are what you almost always want
  const [range, setRange] = useState<"7d" | "30d" | "90d" | "all" | "custom">(
    "7d",
  );
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [editTitle, setEditTitle] = useState<{
    id: string;
    value: string;
  } | null>(null);

  const refresh = () => api.listRecordings().then(setRecs);
  useEffect(() => {
    if (active) refresh();
  }, [active, epoch]);

  // the progress listener lives in App, so refresh the list here when a job
  // reaches 'done' (fires once per completion, even if we were on another tab)
  const refreshedFor = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const [id, p] of Object.entries(progress)) {
      if (p.phase === "done") {
        if (!refreshedFor.current.has(id)) {
          refreshedFor.current.add(id);
          refresh();
        }
      } else {
        refreshedFor.current.delete(id);
      }
    }
  }, [progress]);

  const langOptions = [
    ...new Set([
      settings.language,
      "he",
      "en",
      ...Object.keys(settings.modelMap),
      "auto",
    ]),
  ];

  const transcribe = (id: string, lang: string) => {
    setProgress((prev) => ({
      ...prev,
      [id]: { recordingId: id, phase: "loading" },
    }));
    api.startTranscribe(id, lang);
  };

  const remove = async (r: RecordingMeta) => {
    const ok = await api.confirmDialog({
      message: `Delete "${r.title}"?`,
      detail: "The recording and its transcript are moved to the Trash.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await api.deleteRecording(r.id);
    refresh();
  };

  const showMenu = async (r: RecordingMeta) => {
    const p = progress[r.id];
    const busy = p && p.phase !== "done" && p.phase !== "error";
    const action = await api.recordingMenu({
      canTranscribe: !busy && !r.audioDeletedAt,
      hasTranscript: !!r.hasTranscript,
      currentLang: settings.language,
      languages: langOptions.map((code) => ({ code, label: langName(code) })),
    });
    if (!action) return;
    if (action.startsWith("transcribe:")) transcribe(r.id, action.slice(11));
    else if (action === "rename") setEditTitle({ id: r.id, value: r.title });
    else if (action === "reveal") api.revealRecording(r.id);
    else if (action === "delete") remove(r);
  };

  const saveTitle = async () => {
    if (!editTitle) return;
    const { id, value } = editTitle;
    setEditTitle(null);
    const title = value.trim();
    if (!title) return;
    await api.renameRecording(id, title);
    refresh();
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const days =
      range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : null;
    const cutoff = days ? Date.now() - days * 86_400_000 : null;
    return recs.filter((r) => {
      const t = new Date(r.createdAt).getTime();
      if (cutoff !== null && t < cutoff) return false;
      if (range === "custom") {
        if (fromDate && t < new Date(fromDate).getTime()) return false;
        // inclusive end day
        if (toDate && t >= new Date(toDate).getTime() + 86_400_000)
          return false;
      }
      if (filter === "done" && !r.hasTranscript) return false;
      if (filter === "todo" && r.hasTranscript) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        (r.speakers ?? []).some((s) => s.toLowerCase().includes(q)) ||
        (r.invitees ?? []).some((s) => s.toLowerCase().includes(q))
      );
    });
  }, [recs, query, filter, range, fromDate, toDate]);

  if (recs.length === 0) {
    return (
      <div>
        <header className="view-head">
          <span className="eyebrow">Archive</span>
          <h2>Library</h2>
        </header>
        <div className="empty-state">
          <Mic size={26} aria-hidden="true" />
          <h3>No recordings yet</h3>
          <p>Recorded meetings land here, ready to transcribe and summarize.</p>
          <button className="primary" onClick={onRecord}>
            Start recording
          </button>
        </div>
      </div>
    );
  }

  let lastGroup = "";
  return (
    <div>
      <header className="view-head">
        <span className="eyebrow">Archive</span>
        <h2>Library</h2>
      </header>

      <div className="lib-toolbar">
        <div className="lib-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search meetings and people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as typeof range)}
          title="Date range"
        >
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="all">All time</option>
          <option value="custom">Custom…</option>
        </select>
        {range === "custom" && (
          <>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              title="From"
            />
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              title="To"
            />
          </>
        )}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
        >
          <option value="all">All</option>
          <option value="done">Transcribed</option>
          <option value="todo">Not transcribed</option>
        </select>
      </div>

      {shown.length === 0 && (
        <p className="hint">
          {query.trim()
            ? `Nothing matches “${query}” in this date range.`
            : range === "all"
              ? "No recordings match the current filter."
              : "No recordings in this date range - widen it above."}
        </p>
      )}

      {shown.map((r) => {
        const p = progress[r.id];
        const busy = p && p.phase !== "done" && p.phase !== "error";
        const group = groupLabel(r.createdAt);
        const header =
          group !== lastGroup ? (
            <div className="group-head" key={`g-${group}`}>
              {group}
            </div>
          ) : null;
        lastGroup = group;
        const count = r.invitees?.length ?? r.attendees;
        return (
          <div key={r.id}>
            {header}
            <div
              className="card rec-row"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(r)}
              onKeyDown={(e) => e.key === "Enter" && onOpen(r)}
              onContextMenu={(e) => {
                e.preventDefault();
                showMenu(r);
              }}
            >
              <div className="rec-row-main">
                {editTitle?.id === r.id ? (
                  <input
                    className="inline-edit"
                    style={{ width: 320 }}
                    autoFocus
                    value={editTitle.value}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      setEditTitle({ id: r.id, value: e.target.value })
                    }
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") saveTitle();
                      if (e.key === "Escape") setEditTitle(null);
                    }}
                    onBlur={saveTitle}
                  />
                ) : (
                  <div className="rec-title">{r.title}</div>
                )}
                <div className="rec-meta">
                  {new Date(r.createdAt).toLocaleString()} ·{" "}
                  {fmtDur(r.durationSec)}
                  {count != null && (
                    <span title={r.invitees?.join(", ")}>
                      {" "}
                      · {count} attendee{count === 1 ? "" : "s"}
                    </span>
                  )}
                  {r.audioDeletedAt && <> · transcript only</>}
                </div>
                {busy && (
                  <div className="rec-progress">
                    <div className="rec-meta">{phaseLabel(p)}</div>
                    <div
                      className={
                        typeof p.pct === "number"
                          ? "progress"
                          : "progress indeterminate"
                      }
                    >
                      <div
                        style={
                          typeof p.pct === "number"
                            ? { width: `${p.pct}%` }
                            : undefined
                        }
                      />
                    </div>
                  </div>
                )}
                {p?.phase === "error" && (
                  <div className="warn-banner" style={{ marginBottom: 0 }}>
                    Transcription failed: {p.message}
                  </div>
                )}
              </div>
              <div
                className="rec-row-side"
                onClick={(e) => e.stopPropagation()}
              >
                {aiJobs[r.id] && (
                  <span className="badge">
                    {aiJobs[r.id] === "summary" ? "summarizing…" : "polishing…"}
                  </span>
                )}
                {r.hasTranscript && !busy && (
                  <span className="badge ok">transcribed</span>
                )}
                <button
                  className="icon"
                  title="Actions"
                  onClick={() => showMenu(r)}
                >
                  <MoreHorizontal size={16} />
                </button>
                <ChevronRight
                  size={15}
                  className="row-chev"
                  aria-hidden="true"
                  onClick={() => onOpen(r)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
