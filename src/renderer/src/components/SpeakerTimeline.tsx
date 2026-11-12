import { useEffect, useRef, useState, type CSSProperties } from "react";
import { fmtDur, fmtTs } from "../fmt";
import {
  clampView,
  followView,
  pan,
  ticks,
  zoomAt,
  type View,
} from "../timelineView";
import TimelineOverview from "./TimelineOverview";
import type { SpeakerInfo, TranscriptSegment } from "../../../shared/types";

export interface Lane {
  name: string;
  /** seconds of speech */
  total: number;
  /** runs of consecutive segments by this speaker */
  turns: number;
  segs: TranscriptSegment[];
}

interface Props {
  lanes: Lane[];
  duration: number;
  curTime: number;
  speakers: SpeakerInfo[];
  colorOf: (name: string) => string;
  onSeek: (sec: number) => void;
  /** keep the playhead in view while zoomed (shared with the transcript) */
  follow: boolean;
  onFollow: (on: boolean) => void;
  /** renames every diarization cluster shown in this lane */
  onRename: (clusters: string[], name: string) => void;
}

const covers = (s: TranscriptSegment, t: number) => s.start <= t && t < s.end;

/** One lane per speaker; the lane and bar being played light up. Zooms like a
 *  DAW: ⌘/Ctrl + scroll or pinch around the cursor, scroll to pan. */
export default function SpeakerTimeline({
  lanes,
  duration,
  curTime,
  speakers,
  colorOf,
  onSeek,
  follow,
  onFollow,
  onRename,
}: Props) {
  const [edit, setEdit] = useState<{ lane: string; value: string } | null>(
    null,
  );
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );
  // null = fit the whole meeting, so a transcript that lengthens stays fitted
  const [zoomed, setZoomed] = useState<View | null>(null);
  const view = zoomed ?? { start: 0, span: duration };
  const area = useRef<HTMLDivElement>(null);
  const tracks = useRef<HTMLDivElement>(null);

  const playing = curTime > 0;
  const x = (t: number) => `${((t - view.start) / view.span) * 100}%`;
  const inView = (t: number) => t >= view.start && t <= view.start + view.span;
  // seconds at a screen x, over the track column
  const timeAt = (clientX: number, v: View = view) => {
    const r = tracks.current!.getBoundingClientRect();
    const f = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return v.start + f * v.span;
  };
  const zoomBy = (factor: number) =>
    setView(
      zoomAt(
        view,
        factor,
        playing && inView(curTime) ? curTime : view.start + view.span / 2,
        duration,
      ),
    );

  useEffect(() => {
    if (follow && zoomed && playing) {
      const next = followView(zoomed, curTime, duration);
      if (next !== zoomed) setZoomed(next);
    }
  }, [curTime, follow, zoomed, playing, duration]);

  // Latest view for the wheel listener. setView writes it immediately, so a
  // burst of wheel events between renders builds on itself instead of lagging.
  const viewRef = useRef({ view, zoomed, timeAt });
  viewRef.current = { view, zoomed, timeAt };
  const setView = (v: View | null) => {
    const z = v && v.span < duration ? clampView(v, duration) : null;
    viewRef.current = {
      ...viewRef.current,
      view: z ?? { start: 0, span: duration },
      zoomed: z,
    };
    setZoomed(z);
  };

  // React's onWheel is passive, so preventDefault needs a native listener.
  // Fitted, plain vertical scroll still scrolls the page.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { view: v, zoomed: z, timeAt: at } = viewRef.current;
      const w = tracks.current?.clientWidth || 1;
      if (e.ctrlKey || e.metaKey) {
        // pinch arrives as ctrl+wheel with small deltas
        e.preventDefault();
        setView(
          zoomAt(v, Math.exp(-e.deltaY * 0.006), at(e.clientX, v), duration),
        );
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || (z && e.deltaY)) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView(pan(v, (d / w) * v.span, duration));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [duration]);

  // the clusters behind a lane: from its segments, else by name ("Me" has none)
  const clustersOf = (l: Lane) => {
    const fromSegs = [
      ...new Set(l.segs.map((s) => s.cluster).filter((c): c is string => !!c)),
    ];
    return fromSegs.length
      ? fromSegs
      : speakers.filter((sp) => sp.name === l.name).map((sp) => sp.cluster);
  };

  // naming enrolls a voiceprint, so only Enter commits - blur/Escape discard
  const commit = (l: Lane) => {
    const name = edit?.value.trim();
    setEdit(null);
    if (name && name !== l.name) onRename(clustersOf(l), name);
  };

  const factor = duration / view.span;

  return (
    <>
      <div className="tl-toolbar">
        <span className="tl-clock">
          {fmtTs(curTime)} / {fmtTs(duration)}
        </span>
        <label className="follow-toggle" title="Keep the playhead in view">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => onFollow(e.target.checked)}
          />
          Follow
        </label>
        <div className="tl-zoom">
          <button
            className="ghost"
            title="Zoom out"
            onClick={() => zoomBy(0.5)}
          >
            −
          </button>
          <span className="tl-factor">
            {factor < 10 ? factor.toFixed(1) : Math.round(factor)}×
          </span>
          <button className="ghost" title="Zoom in" onClick={() => zoomBy(2)}>
            +
          </button>
          <button
            className="ghost"
            title="Show the whole meeting"
            disabled={!zoomed}
            onClick={() => setView(null)}
          >
            Fit
          </button>
        </div>
      </div>
      <div className="tl-body" ref={area}>
        <div className="tl-ruler">
          {ticks(view).map((t) => (
            <span key={t} style={{ left: x(t) }}>
              {fmtTs(t)}
            </span>
          ))}
        </div>
        {lanes.map((l) => {
          const clusters = clustersOf(l);
          const matched = speakers.some(
            (sp) => clusters.includes(sp.cluster) && sp.matched,
          );
          const active = playing && l.segs.some((s) => covers(s, curTime));
          return (
            <div
              className={active ? "tl-lane active" : "tl-lane"}
              key={l.name}
              style={{ "--sc": colorOf(l.name) } as CSSProperties}
            >
              <div className="tl-label">
                {edit?.lane === l.name ? (
                  <input
                    className="inline-edit tl-edit"
                    autoFocus
                    value={edit.value}
                    onChange={(e) =>
                      setEdit({ lane: l.name, value: e.target.value })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit(l);
                      if (e.key === "Escape") setEdit(null);
                    }}
                    onBlur={() => setEdit(null)}
                  />
                ) : clusters.length ? (
                  <button
                    className={matched ? "tl-name" : "tl-name unnamed"}
                    title={
                      matched
                        ? "Recognized by voice. Click to rename"
                        : "Click to name this speaker (remembered by voice)"
                    }
                    onClick={() => setEdit({ lane: l.name, value: l.name })}
                  >
                    <span className="tl-dot" />
                    <span className="tl-name-text">{l.name}</span>
                  </button>
                ) : (
                  <span className="tl-name" title={l.name}>
                    <span className="tl-dot" />
                    <span className="tl-name-text">{l.name}</span>
                  </span>
                )}
                <span className="tl-stats">
                  {fmtDur(l.total)} · {l.turns} turn{l.turns === 1 ? "" : "s"}
                </span>
              </div>
              <div
                className="tl-track"
                onClick={(e) => {
                  // bars seek to their own start; empty track seeks right here
                  if (e.target === e.currentTarget) onSeek(timeAt(e.clientX));
                }}
              >
                {l.segs.map((s, j) =>
                  s.end < view.start ||
                  s.start > view.start + view.span ? null : (
                    <button
                      key={j}
                      className={
                        playing && covers(s, curTime)
                          ? "tl-bar active"
                          : "tl-bar"
                      }
                      style={{
                        left: x(s.start),
                        width: `${Math.max(((s.end - s.start) / view.span) * 100, 0.35)}%`,
                      }}
                      onClick={() => onSeek(s.start)}
                      onMouseEnter={(e) =>
                        setTip({
                          x: e.clientX,
                          y: e.currentTarget.getBoundingClientRect().top,
                          text: `[${fmtTs(s.start)}] ${s.text}`,
                        })
                      }
                      onMouseLeave={() => setTip(null)}
                    />
                  ),
                )}
              </div>
              <span className="tl-pct">
                {Math.round((l.total / duration) * 100)}%
              </span>
            </div>
          );
        })}
        {/* one grid + playhead across every lane, over the track column */}
        <div className="tl-overlay" ref={tracks}>
          {ticks(view).map((t) => (
            <div key={t} className="tl-grid" style={{ left: x(t) }} />
          ))}
          {playing && inView(curTime) && (
            <div className="tl-playhead" style={{ left: x(curTime) }} />
          )}
        </div>
      </div>
      {zoomed && (
        <TimelineOverview
          lanes={lanes}
          duration={duration}
          view={view}
          curTime={curTime}
          colorOf={colorOf}
          onView={setView}
        />
      )}
      <div className="tl-hint">
        Click to jump · ⌘ + scroll or pinch to zoom · scroll to pan when zoomed
      </div>
      {tip && (
        <div className="tl-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </>
  );
}
