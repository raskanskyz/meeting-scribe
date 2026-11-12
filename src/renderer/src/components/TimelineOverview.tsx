import { useRef, type CSSProperties } from "react";
import { clampView, type View } from "../timelineView";
import type { Lane } from "./SpeakerTimeline";

interface Props {
  lanes: Lane[];
  duration: number;
  view: View;
  curTime: number;
  colorOf: (name: string) => string;
  onView: (v: View) => void;
}

/** The whole meeting in miniature; drag the window (or click) to move it. */
export default function TimelineOverview({
  lanes,
  duration,
  view,
  curTime,
  colorOf,
  onView,
}: Props) {
  const strip = useRef<HTMLDivElement>(null);
  // where in the window the pointer grabbed it, in seconds
  const grab = useRef<number | null>(null);
  const pct = (t: number) => `${(t / duration) * 100}%`;

  const timeAt = (clientX: number) => {
    const r = strip.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * duration;
  };
  const moveTo = (clientX: number) => {
    if (grab.current === null) return;
    onView(
      clampView(
        { start: timeAt(clientX) - grab.current, span: view.span },
        duration,
      ),
    );
  };

  return (
    <div
      className="tl-overview"
      ref={strip}
      onPointerDown={(e) => {
        const t = timeAt(e.clientX);
        const inside = t >= view.start && t <= view.start + view.span;
        // clicking outside the window centers it there, then drags from the middle
        grab.current = inside ? t - view.start : view.span / 2;
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => moveTo(e.clientX)}
      onPointerUp={() => (grab.current = null)}
    >
      {lanes.map((l, i) => (
        <div
          key={l.name}
          className="tl-ov-row"
          style={
            {
              "--sc": colorOf(l.name),
              top: `${((i + 0.5) / lanes.length) * 100}%`,
            } as CSSProperties
          }
        >
          {l.segs.map((s, j) => (
            <span
              key={j}
              style={{ left: pct(s.start), width: pct(s.end - s.start) }}
            />
          ))}
        </div>
      ))}
      <div
        className="tl-ov-window"
        style={{ left: pct(view.start), width: pct(view.span) }}
      />
      {curTime > 0 && (
        <div className="tl-ov-playhead" style={{ left: pct(curTime) }} />
      )}
    </div>
  );
}
