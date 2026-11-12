import { useRef, useState, type MutableRefObject } from "react";
import { Pause, Play } from "lucide-react";
import { fmtTs } from "../fmt";
import type { TrackName } from "../../../shared/types";

export interface PlayerHandle {
  /** jump to a position (seconds) and start playing */
  seek: (sec: number) => void;
}

interface Props {
  recId: string;
  tracks: TrackName[];
  /** MediaRecorder webm reports Infinity duration - trust the metadata instead */
  durationSec: number;
  onTime?: (sec: number) => void;
  handleRef?: MutableRefObject<PlayerHandle | null>;
  /** a video element that mirrors playback, muted - the audio stems lead */
  follower?: MutableRefObject<HTMLVideoElement | null>;
}

/** One player for the whole meeting: both stems (mic + system) play in sync
 *  as a mix, with per-track mute instead of two separate browser players. */
export default function MeetingPlayer({
  recId,
  tracks,
  durationSec,
  onTime,
  handleRef,
  follower,
}: Props) {
  const els = useRef<Partial<Record<TrackName, HTMLAudioElement | null>>>({});
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState<Partial<Record<TrackName, boolean>>>({});

  const all = () =>
    tracks
      .map((t) => els.current[t])
      .filter((el): el is HTMLAudioElement => !!el);

  const sync = (fn: (v: HTMLVideoElement) => void) => {
    const v = follower?.current;
    if (v) fn(v);
  };

  const playAll = (at?: number) => {
    for (const el of all()) {
      if (at !== undefined) el.currentTime = at;
      void el.play().catch(() => {});
    }
    sync((v) => {
      v.muted = true; // its own audio is the same mix - the stems lead
      if (at !== undefined) v.currentTime = at;
      void v.play().catch(() => {});
    });
    setPlaying(true);
  };
  const pauseAll = () => {
    all().forEach((el) => el.pause());
    sync((v) => v.pause());
    setPlaying(false);
  };

  const seekTo = (sec: number) => {
    setTime(sec);
    onTime?.(sec);
    playAll(sec);
  };

  if (handleRef) handleRef.current = { seek: seekTo };

  return (
    <div className="player">
      <button
        className="player-btn"
        title={playing ? "Pause" : "Play"}
        onClick={() => (playing ? pauseAll() : playAll())}
      >
        {playing ? (
          <Pause size={15} fill="currentColor" />
        ) : (
          <Play size={15} fill="currentColor" />
        )}
      </button>
      <span className="player-time">{fmtTs(time)}</span>
      <input
        className="player-seek"
        type="range"
        min={0}
        max={durationSec || 1}
        step={0.1}
        value={Math.min(time, durationSec)}
        onChange={(e) => {
          const sec = Number(e.target.value);
          setTime(sec);
          onTime?.(sec);
          all().forEach((el) => {
            el.currentTime = sec;
          });
          sync((v) => {
            v.currentTime = sec;
          });
        }}
      />
      <span className="player-time">{fmtTs(durationSec)}</span>
      {tracks.map((t) => (
        <button
          key={t}
          className={`badge track-toggle${muted[t] ? " muted" : ""}`}
          data-ch={t === "mic" ? "me" : "them"}
          title={muted[t] ? "Unmute this track" : "Mute this track"}
          onClick={() => {
            const el = els.current[t];
            if (el) el.muted = !muted[t];
            setMuted((m) => ({ ...m, [t]: !m[t] }));
          }}
        >
          {t === "mic" ? "Me" : "Them"}
        </button>
      ))}
      {tracks.map((t, i) => (
        <audio
          key={t}
          hidden
          preload="metadata"
          src={`media://rec/${recId}/${t}.webm`}
          ref={(el) => {
            els.current[t] = el;
          }}
          // the first track is the clock; the rest just follow
          onTimeUpdate={
            i === 0
              ? (e) => {
                  const sec = e.currentTarget.currentTime;
                  setTime(sec);
                  onTime?.(sec);
                  // gentle drift correction only - constant seeking stutters
                  sync((v) => {
                    if (!v.paused && Math.abs(v.currentTime - sec) > 0.5)
                      v.currentTime = sec;
                  });
                }
              : undefined
          }
          onEnded={
            i === 0
              ? () => {
                  setPlaying(false);
                  sync((v) => v.pause());
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}
