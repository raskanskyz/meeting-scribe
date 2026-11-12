import { useEffect, useRef, type CSSProperties } from "react";
import { fmtTs } from "../fmt";
import type { TranscriptSegment } from "../../../shared/types";

interface Props {
  segs: TranscriptSegment[];
  curTime: number;
  /** keep the segment being played in view */
  follow: boolean;
  colorOf: (name: string) => string;
  onSeek: (sec: number) => void;
}

/** segments playing at `t`; overlap is common (two people at once) */
export const playingAt = (segs: TranscriptSegment[], t: number): number[] =>
  t > 0
    ? segs.flatMap((s, i) => (s.start <= t && t < s.end ? [i] : []))
    : [];

export default function Transcript({
  segs,
  curTime,
  follow,
  colorOf,
  onSeek,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const playing = playingAt(segs, curTime);
  // follow the most recent voice
  const active = playing.length ? playing[playing.length - 1] : -1;

  // scroll only the transcript box (scrollIntoView would move the page too),
  // putting the live segment a third of the way down
  useEffect(() => {
    const el = box.current;
    const seg = el?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (!follow || !el || !seg) return;
    el.scrollTo({
      top: seg.offsetTop - el.clientHeight / 3,
      behavior: "smooth",
    });
  }, [active, follow]);

  return (
    <div className="transcript" ref={box}>
      {segs.map((s, i) => {
        const prev = segs[i - 1];
        const changed = !prev || prev.speaker !== s.speaker;
        let cls = changed ? "tx-seg tx-turn" : "tx-seg";
        if (playing.includes(i)) cls += " active";
        return (
          <div
            className={cls}
            style={{ "--sc": colorOf(s.speaker) } as CSSProperties}
            key={i}
            data-i={i}
          >
            {changed && (
              <div className="tx-head">
                <span className="tx-who">{s.speaker}</span>
                <button
                  className="tx-ts tx-jump"
                  title="Play from here"
                  onClick={() => onSeek(s.start)}
                >
                  {fmtTs(s.start)}
                </button>
              </div>
            )}
            <span className="tx-text" dir="auto">
              {s.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
