import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { CalendarEvent, CalendarResult } from "../../../shared/types";

interface Props {
  /** true while this tab is visible - views stay mounted, so refetch on show */
  active: boolean;
  onPick: (title: string, invitees: string[]) => void;
}

function provider(url: string): string {
  if (/meet\.google\.com/.test(url)) return "Google Meet";
  if (/zoom\.us/.test(url)) return "Zoom";
  if (/teams\.(microsoft|live)\.com/.test(url)) return "Teams";
  if (/webex\.com/.test(url)) return "Webex";
  if (/whereby\.com/.test(url)) return "Whereby";
  return "Video call";
}

function when(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const now = new Date();
  const midnight = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(start) - midnight(now)) / 86_400_000);
  const day =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : start.toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
          });
  const t = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${t(start)}–${t(end)}`;
}

function startsInLabel(startIso: string): string | null {
  const mins = Math.round((new Date(startIso).getTime() - Date.now()) / 60_000);
  if (mins < 0 && mins > -120) return "in progress";
  if (mins >= 0 && mins <= 15) return `starts in ${mins} min`;
  return null;
}

export default function MeetingsView({ active, onPick }: Props) {
  const [result, setResult] = useState<CalendarResult | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .upcomingMeetings(24)
      .then(setResult)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  const record = (e: CalendarEvent) => {
    const invitees = e.attendees
      .filter((a) => a.status.toLowerCase() !== "declined")
      .map((a) => a.name.trim())
      .filter(Boolean);
    onPick(e.title, invitees);
    if (e.videoLink) api.openExternal(e.videoLink);
  };

  return (
    <div>
      <header className="view-head">
        <span className="eyebrow">Calendar</span>
        <h2>Meetings</h2>
      </header>
      <p className="hint" style={{ marginBottom: 16 }}>
        Your meetings in the next 24 hours - everything you haven't declined,
        read locally from macOS Calendar.{" "}
        <button
          className="ghost"
          onClick={refresh}
          disabled={loading}
          style={{ marginLeft: 6 }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </p>

      {result && result.status !== "ok" && (
        <div className="warn-banner">
          {result.status === "denied" || result.status === "restricted" ? (
            <>
              Meeting Scribe doesn't have Calendar access. Enable it under
              System Settings → Privacy &amp; Security → Calendars, then
              Refresh.
              <br />
              <button
                className="ghost"
                style={{ marginTop: 8 }}
                onClick={() => api.openCalendarPrivacy()}
              >
                Open Privacy Settings
              </button>
            </>
          ) : result.status === "notDetermined" ? (
            <>
              Calendar access hasn't been granted yet - Refresh to trigger the
              permission prompt.
            </>
          ) : (
            <>Couldn't read the calendar: {result.message}</>
          )}
        </div>
      )}

      {result?.status === "ok" && result.events.length === 0 && !loading && (
        <p className="hint">
          No meetings in the next 24 hours.
          {result.message && (
            <>
              <br />
              <span style={{ opacity: 0.7 }}>{result.message}</span>
            </>
          )}
        </p>
      )}

      {result?.events.map((e) => {
        const soon = startsInLabel(e.start);
        return (
          <div className="card" key={e.id}>
            <div
              className="row"
              style={{
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div>
                <div className="rec-title">
                  {e.title} {soon && <span className="badge ok">{soon}</span>}
                </div>
                <div className="rec-meta">
                  {when(e.start, e.end)}
                  {e.videoLink && <> · {provider(e.videoLink)}</>}
                  {e.myStatus === "pending" && <> · awaiting reply</>}
                  {e.attendees.length > 0 && (
                    <> · {e.attendees.length} attendees</>
                  )}
                  {e.organizer && <> · by {e.organizer}</>}
                </div>
              </div>
              <div className="row">
                {e.videoLink && (
                  <button
                    className="ghost"
                    onClick={() => api.openExternal(e.videoLink!)}
                  >
                    Join
                  </button>
                )}
                <button className="primary" onClick={() => record(e)}>
                  Record
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
