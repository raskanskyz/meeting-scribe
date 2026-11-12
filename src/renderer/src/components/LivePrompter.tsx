import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { CHANNEL_COLORS } from "../speakerColors";
import type { LiveSegment } from "../../../shared/types";

const COLOR: Record<string, string> = {
  mic: CHANNEL_COLORS.me,
  system: CHANNEL_COLORS.them,
};

interface Props {
  /** true while a live recording is in progress; a rising edge starts a fresh transcript */
  active: boolean;
}

/** Live transcript that unfolds during a recording, one line per committed
 *  utterance, tagged with the track speaker (Me / Them). */
export default function LivePrompter({ active }: Props) {
  const [segments, setSegments] = useState<LiveSegment[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const wasActive = useRef(false);

  // clear on the rising edge of a new recording
  useEffect(() => {
    if (active && !wasActive.current) setSegments([]);
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    return api.onLiveSegment((e) => {
      setSegments((prev) => [
        ...prev,
        {
          track: e.track,
          speaker: e.speaker,
          start: e.start,
          end: e.end,
          text: e.text,
        },
      ]);
    });
  }, []);

  // keep the newest line in view
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments]);

  if (!active) return null;

  return (
    <div className="card live-prompter">
      <div className="track-head">
        <span>Live transcript</span>
        <span className="hint">
          {segments.length ? `${segments.length} lines` : "listening…"}
        </span>
      </div>
      <div className="live-lines" ref={listRef}>
        {segments.length === 0 && (
          <div className="hint">
            Speak - transcription appears here as you talk.
          </div>
        )}
        {segments.map((s, i) => (
          <div key={i} className="live-line" dir="auto">
            <span
              className="live-speaker"
              style={{ color: COLOR[s.track] ?? "#888" }}
            >
              {s.speaker}
            </span>
            <span>{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
