import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { SystemCaptureMode, TrackName } from "../../../shared/types";

export type RecStatus = "idle" | "recording" | "paused" | "saving";

interface Track {
  stream: MediaStream;
  recorder: MediaRecorder;
  analyser: AnalyserNode;
}

const CHUNK_MS = 5000;

/** a clean digital tap: no browser voice processing on either capture route */
const RAW_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export const TAP_DENIED =
  "macOS isn't allowing system-audio recording. Approve Meeting Scribe under Privacy & Security → Screen & System Audio Recording, then start again.";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * System-audio capture without BlackHole. The main process grants
 * audio: 'loopback' on this request. `video: false` is deliberate and must stay:
 * asking for no screen source keeps this in the system-audio-recording
 * permission class instead of screen recording.
 *
 * Two first-run behaviors to survive. The macOS consent dialog aborts the
 * in-flight call (AbortError). And when the tap isn't permitted at all, macOS
 * hands back a track that is already 'ended' rather than failing the call -
 * feeding that to MediaRecorder yields only an opaque NotSupportedError, so the
 * liveness check has to happen here. Both get one retry, then a clear message.
 */
async function openLoopbackStream(): Promise<MediaStream> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: RAW_AUDIO,
      });
    } catch (e) {
      if (
        e instanceof DOMException &&
        e.name === "AbortError" &&
        attempt === 0
      ) {
        await wait(1200);
        continue;
      }
      throw e;
    }
    // nothing should hand us video, but a video track would fail MediaRecorder
    // with the same opaque error as a dead audio track
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    if (stream.getAudioTracks()[0]?.readyState === "live") return stream;
    stream.getTracks().forEach((t) => t.stop());
    if (attempt === 0) await wait(1200);
  }
  throw new Error(TAP_DENIED);
}

async function openTrack(
  ctx: AudioContext,
  source_: { deviceId: string } | { loopback: true },
  sessionId: string,
  name: TrackName,
): Promise<Track> {
  const stream =
    "loopback" in source_
      ? await openLoopbackStream()
      : await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: source_.deviceId },
            // Raw on purpose. Browser echo cancellation can't subtract audio
            // another app plays (measured: 0.4 dB on a call played by a
            // separate process), and the full voice-processing chain takes
            // over the output path the loopback tap reads. Speaker bleed is
            // stripped downstream in drop_bleed() and the echo drop instead.
            ...RAW_AUDIO,
          },
        });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);

  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
  });
  recorder.ondataavailable = async (e) => {
    if (e.data.size > 0)
      await api.recAppend(sessionId, name, await e.data.arrayBuffer());
  };

  return { stream, recorder, analyser };
}

// a recorder whose source track already ended is 'inactive'; stopping it throws
const stopRecorder = (r: MediaRecorder) =>
  new Promise<void>((res) => {
    if (r.state === "inactive") return res();
    r.onstop = () => res();
    r.stop();
  });

export function useRecorder() {
  const [status, setStatus] = useState<RecStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  // the route the in-flight recording is actually using, as decided by main
  const [captureMode, setCaptureMode] = useState<SystemCaptureMode | null>(
    null,
  );
  // why the meeting track is missing, when the mic still recorded fine
  const [systemError, setSystemError] = useState("");
  const [screenWarning, setScreenWarning] = useState("");
  const [analysers, setAnalysers] = useState<
    Partial<Record<TrackName, AnalyserNode>>
  >({});

  const tracksRef = useRef<Partial<Record<TrackName, Track>>>({});
  const screenRef = useRef<{
    stream: MediaStream;
    recorder: MediaRecorder;
    mixCtx?: AudioContext;
  } | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const accumRef = useRef(0);

  useEffect(() => {
    if (status !== "recording") return;
    const iv = setInterval(() => {
      setElapsed(accumRef.current + (Date.now() - startedAtRef.current) / 1000);
    }, 250);
    return () => clearInterval(iv);
  }, [status]);

  const start = useCallback(
    async (
      micId: string,
      systemId: string | null,
      screenSourceId: string | null = null,
    ) => {
      const { id: sessionId, mode } = await api.recBegin();
      sessionRef.current = sessionId;
      setCaptureMode(mode);
      setSystemError("");
      const tracks: Partial<Record<TrackName, Track>> = {};
      try {
        const ctx = new AudioContext();
        ctxRef.current = ctx;

        tracks.mic = await openTrack(
          ctx,
          { deviceId: micId },
          sessionId,
          "mic",
        );
        // loopback needs no device pick; BlackHole does
        const systemSource =
          mode === "loopback"
            ? ({ loopback: true } as const)
            : systemId
              ? { deviceId: systemId }
              : null;
        if (systemSource) {
          // losing the meeting side must not cost the whole recording -
          // capture the mic and say what went wrong instead of failing
          try {
            tracks.system = await openTrack(
              ctx,
              systemSource,
              sessionId,
              "system",
            );
          } catch (e) {
            setSystemError(e instanceof Error ? e.message : String(e));
          }
        }
      } catch (e) {
        Object.values(tracks).forEach((t) => {
          t!.stream.getTracks().forEach((s) => s.stop());
        });
        await ctxRef.current?.close().catch(() => {});
        ctxRef.current = null;
        sessionRef.current = null;
        setCaptureMode(null);
        await api.recAbort(sessionId);
        throw e;
      }

      // screen capture rides along; its failure must never block the meeting audio
      setScreenWarning("");
      if (screenSourceId) {
        try {
          const video = {
            // Electron's desktop-capture constraints predate the standard types
            // ponytail: modest caps - meeting capture needs legibility, not 30fps/5K
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: screenSourceId,
              maxWidth: 2560,
              maxHeight: 1600,
              maxFrameRate: 10,
            },
          } as unknown as MediaTrackConstraints;
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video,
          });
          stream.getVideoTracks()[0].onended = () =>
            setScreenWarning(
              "Screen source ended (window closed?) - the rest of this meeting has no video.",
            );
          // the video gets the meeting sound too: mix both stems into one
          // audio track on a separate context for the video recording
          let mixCtx: AudioContext | undefined;
          try {
            mixCtx = new AudioContext();
            const dest = mixCtx.createMediaStreamDestination();
            Object.values(tracks).forEach((t) =>
              mixCtx!.createMediaStreamSource(t!.stream).connect(dest),
            );
            dest.stream.getAudioTracks().forEach((a) => stream.addTrack(a));
          } catch {
            /* a silent video beats no video */
          }
          const recorder = new MediaRecorder(stream, {
            mimeType: "video/webm",
            videoBitsPerSecond: 2_500_000,
          });
          recorder.ondataavailable = async (e) => {
            if (e.data.size > 0)
              await api.recAppend(
                sessionId,
                "screen",
                await e.data.arrayBuffer(),
              );
          };
          screenRef.current = { stream, recorder, mixCtx };
        } catch (e) {
          setScreenWarning(
            `Screen recording failed: ${e instanceof Error ? e.message : e}. Grant Screen Recording to Meeting Scribe in System Settings → Privacy & Security.`,
          );
        }
      }

      tracksRef.current = tracks;
      setAnalysers({
        mic: tracks.mic!.analyser,
        system: tracks.system?.analyser,
      });

      Object.values(tracks).forEach((t) => t!.recorder.start(CHUNK_MS));
      screenRef.current?.recorder.start(CHUNK_MS);
      accumRef.current = 0;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setStatus("recording");
    },
    [],
  );

  const pause = useCallback(() => {
    Object.values(tracksRef.current).forEach((t) => t!.recorder.pause());
    const sr = screenRef.current?.recorder;
    if (sr?.state === "recording") sr.pause();
    accumRef.current += (Date.now() - startedAtRef.current) / 1000;
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    Object.values(tracksRef.current).forEach((t) => t!.recorder.resume());
    const sr = screenRef.current?.recorder;
    if (sr?.state === "paused") sr.resume();
    startedAtRef.current = Date.now();
    setStatus("recording");
  }, []);

  const stop = useCallback(
    async (title?: string, invitees?: string[]): Promise<string> => {
      setStatus("saving");
      const tracks = tracksRef.current;
      const durationSec =
        accumRef.current +
        (status === "recording"
          ? (Date.now() - startedAtRef.current) / 1000
          : 0);

      await Promise.all(
        [
          ...Object.values(tracks).map((t) => t!.recorder),
          ...(screenRef.current ? [screenRef.current.recorder] : []),
        ].map(stopRecorder),
      );
      // ondataavailable handlers fire before onstop, but the async IPC appends may
      // still be in flight; give them a beat before closing the file
      await new Promise((r) => setTimeout(r, 300));

      Object.values(tracks).forEach((t) => {
        t!.stream.getTracks().forEach((s) => s.stop());
      });
      screenRef.current?.stream.getTracks().forEach((s) => s.stop());
      screenRef.current = null;
      await ctxRef.current?.close();

      const id = sessionRef.current!;
      await api.recFinish(id, {
        title: title?.trim() || `Meeting ${new Date().toLocaleString()}`,
        createdAt: new Date().toISOString(),
        durationSec: Math.round(durationSec),
        tracks: Object.keys(tracks) as TrackName[],
        ...(invitees?.length ? { invitees } : {}),
      });

      tracksRef.current = {};
      setAnalysers({});
      setElapsed(0);
      setCaptureMode(null);
      setStatus("idle");
      return id;
    },
    [status],
  );

  // stop without saving: tear down capture and delete the session folder
  const discard = useCallback(async (): Promise<void> => {
    setStatus("saving");
    const tracks = tracksRef.current;
    await Promise.all(
      [
        ...Object.values(tracks).map((t) => t!.recorder),
        ...(screenRef.current ? [screenRef.current.recorder] : []),
      ].map(stopRecorder),
    );
    Object.values(tracks).forEach((t) => {
      t!.stream.getTracks().forEach((s) => s.stop());
    });
    screenRef.current?.stream.getTracks().forEach((s) => s.stop());
    void screenRef.current?.mixCtx?.close().catch(() => {});
    screenRef.current = null;
    await ctxRef.current?.close();
    await api.recAbort(sessionRef.current!); // restores output and deletes folder
    tracksRef.current = {};
    sessionRef.current = null;
    setAnalysers({});
    setElapsed(0);
    setCaptureMode(null);
    setStatus("idle");
  }, []);

  return {
    status,
    elapsed,
    captureMode,
    systemError,
    screenWarning,
    analysers,
    start,
    pause,
    resume,
    stop,
    discard,
  };
}
