import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  CalendarClock,
  Check,
  Circle,
  Monitor,
  Pause,
  Play,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { api } from "../api";
import Waveform from "../components/Waveform";
import LivePrompter from "../components/LivePrompter";
import { CHANNEL_COLORS } from "../speakerColors";
import { fmtClock, langName } from "../fmt";
import type { useRecorder } from "../hooks/useRecorder";
import type {
  AudioSetupStatus,
  CalendarEvent,
  ScreenSource,
  Settings,
} from "../../../shared/types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  recorder: ReturnType<typeof useRecorder>;
  /** how meeting audio will be captured (system tap vs BlackHole) */
  audio: AudioSetupStatus | null;
  onRefreshAudio: () => void;
  devices: MediaDeviceInfo[];
  micId: string;
  systemId: string;
  captureSystem: boolean;
  recordScreen: boolean;
  setRecordScreen: (v: boolean) => void;
  screenSources: ScreenSource[];
  setScreenSourceId: (id: string) => void;
  screenPermission: string;
  setMicId: (id: string) => void;
  setSystemId: (id: string) => void;
  setCaptureSystem: (v: boolean) => void;
  title: string;
  setTitle: (t: string) => void;
  error: string;
  /** null = record without screen; undefined = use the remembered source */
  onStart: (screenSourceId?: string | null) => Promise<void>;
  onStop: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onRefreshDevices: () => void;
  /** fill session name + attendee roster from a calendar meeting */
  onPrefill: (title: string, invitees: string[]) => void;
  /** a start requested from toast/tray/⌘R - run the normal flow incl. picker */
  autoStart: boolean;
  onAutoStarted: () => void;
}

const TALLY: Record<string, string> = {
  idle: "standby",
  recording: "rec",
  paused: "paused",
  saving: "saving",
};

export default function RecordView({
  settings,
  onChange,
  recorder,
  audio,
  onRefreshAudio,
  devices,
  micId,
  systemId,
  captureSystem,
  recordScreen,
  setRecordScreen,
  screenSources,
  setScreenSourceId,
  screenPermission,
  setMicId,
  setSystemId,
  setCaptureSystem,
  title,
  setTitle,
  error,
  onStart,
  onStop,
  onDiscard,
  onRefreshDevices,
  onPrefill,
  autoStart,
  onAutoStarted,
}: Props) {
  const {
    status,
    elapsed,
    live,
    captureMode,
    systemError,
    screenWarning,
    analysers,
    pause,
    resume,
  } = recorder;
  const [systemSilent, setSystemSilent] = useState(false);
  const lastLoudRef = useRef(Date.now());

  const hasBlackhole = devices.some((d) => /blackhole/i.test(d.label));
  const recording = status === "recording" || status === "paused";
  const loopback = audio?.mode === "loopback";
  // the tap records what's actually played, so a muted output captures silence
  const outputSilent =
    loopback && (audio?.outputMuted === true || audio?.outputVolume === 0);
  const screenBlocked =
    recordScreen &&
    (screenSources.length === 0 || screenPermission === "denied");

  const onSystemLevel = useCallback((rms: number) => {
    if (rms > 0.004) lastLoudRef.current = Date.now();
    setSystemSilent(Date.now() - lastLoudRef.current > 8000);
  }, []);

  // the next video meeting within the hour, one glance from the record button
  const [nextMeeting, setNextMeeting] = useState<CalendarEvent | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await api.upcomingMeetings(1);
        if (alive)
          setNextMeeting(res.status === "ok" ? (res.events[0] ?? null) : null);
      } catch {
        /* the chip is optional */
      }
    };
    load();
    const iv = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const meetingInvitees = (e: CalendarEvent) =>
    e.attendees
      .filter((a) => a.status.toLowerCase() !== "declined")
      .map((a) => a.name.trim())
      .filter(Boolean);

  const startsLabel = (e: CalendarEvent) => {
    const mins = Math.round(
      (new Date(e.start).getTime() - Date.now()) / 60_000,
    );
    return mins <= 0 ? "in progress" : `starts in ${mins} min`;
  };

  // BlackHole route only: the multi-output aggregate mutes the hardware
  // volume keys while recording (macOS refuses master volume on aggregates),
  // so the deck exposes the real speakers' volume. The system tap never
  // touches the output device - keys keep working, no slider needed.
  const [volume, setVolume] = useState<number | null>(null);
  const volTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!recording || captureMode !== "blackhole") {
      setVolume(null);
      return;
    }
    api.getVolume().then(setVolume);
    return () => clearTimeout(volTimer.current);
  }, [recording, captureMode]);
  const changeVolume = (v: number) => {
    setVolume(v);
    clearTimeout(volTimer.current); // throttle sidecar spawns while dragging
    volTimer.current = window.setTimeout(() => api.setVolume(v), 120);
  };

  // screen-source picker shown when Start is clicked with screen recording on
  const [picker, setPicker] = useState<ScreenSource[] | null>(null);

  // Esc closes the source picker
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);

  // one-click BlackHole install; success flips the checklist via devicechange
  const [bhBusy, setBhBusy] = useState(false);
  const [bhError, setBhError] = useState("");
  const installBlackhole = async () => {
    setBhBusy(true);
    setBhError("");
    const res = await api.installBlackhole();
    setBhBusy(false);
    if (!res.ok) {
      setBhError(res.message ?? "Installation failed.");
      return;
    }
    // devicechange usually fires on its own once coreaudiod is back;
    // this covers the runs where it doesn't
    setTimeout(onRefreshDevices, 2500);
  };

  // starts requested from outside this view run the exact same flow -
  // including the "what should be recorded?" picker
  useEffect(() => {
    if (!autoStart) return;
    onAutoStarted();
    if (status === "idle" && micId) void handleStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const handleStart = async () => {
    lastLoudRef.current = Date.now();
    onRefreshAudio(); // catches a mute/volume change made since the page loaded
    if (!recordScreen) return void onStart(null);
    // show the picker instantly with the names we already have, then fill in
    // thumbnails - capturing one per window is the slow part, and blocking the
    // modal on it made the click feel laggy
    setPicker(screenSources);
    const res = await api.screenSources(true);
    if (!res.sources.length) {
      // no permission - close and record without screen; the banner explains
      setPicker((cur) => (cur ? null : cur));
      return void onStart(null);
    }
    // don't clobber a pick the user already made from the instant list
    setPicker((cur) => (cur ? res.sources : cur));
  };

  const pickSource = (id: string | null) => {
    setPicker(null);
    if (id) setScreenSourceId(id); // remembered as the default for tray starts
    onStart(id);
  };

  const deviceSelect = (value: string, onSelect: (v: string) => void) => (
    <select
      value={value}
      onChange={(e) => onSelect(e.target.value)}
      disabled={recording}
    >
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || d.deviceId.slice(0, 12)}
        </option>
      ))}
    </select>
  );

  return (
    <div>
      <header className="view-head">
        <span className="eyebrow">Console</span>
        <h2>Record</h2>
      </header>

      {error && <div className="warn-banner">{error}</div>}

      {/* one-time setup checklist, shown only while something is missing;
          the system tap needs no BlackHole at all */}
      {!recording && ((!loopback && !hasBlackhole) || screenBlocked) && (
        <div className="card setup-card">
          <div className="panel-title">Setup</div>
          {!loopback && (
            <div className="setup-row">
              {hasBlackhole ? (
                <Check size={15} className="setup-ok" aria-hidden="true" />
              ) : (
                <X size={15} className="setup-missing" aria-hidden="true" />
              )}
              <div>
                <div className="setup-name">BlackHole audio driver</div>
                {!hasBlackhole && (
                  <div className="hint">
                    Needed to capture meeting audio (mic-only until then). macOS
                    asks for your password once - audio drivers can't install
                    silently.
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="primary"
                        disabled={bhBusy}
                        onClick={installBlackhole}
                      >
                        {bhBusy
                          ? "Installing… (enter your password when asked)"
                          : "Install BlackHole"}
                      </button>
                    </div>
                    {bhError && (
                      <div
                        className="warn-banner"
                        style={{ marginTop: 8, marginBottom: 0 }}
                      >
                        {bhError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="setup-row">
            {screenBlocked ? (
              <X size={15} className="setup-missing" aria-hidden="true" />
            ) : (
              <Check size={15} className="setup-ok" aria-hidden="true" />
            )}
            <div>
              <div className="setup-name">Screen Recording permission</div>
              {screenBlocked && (
                <div className="hint">
                  Enable Meeting Scribe (in dev: Electron) under Screen
                  Recording, then relaunch.{" "}
                  <button
                    className="ghost"
                    onClick={() => api.openScreenPrivacy()}
                  >
                    Open System Settings
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {systemError && (
        <div className="warn-banner">
          Meeting audio isn't being captured - {systemError} Your microphone{" "}
          {recording ? "is still recording" : "was still recorded"}.
          {loopback && (
            <div style={{ marginTop: 8 }}>
              <button className="ghost" onClick={() => api.openScreenPrivacy()}>
                Open privacy settings
              </button>
            </div>
          )}
        </div>
      )}

      {outputSilent && !recording && (
        <div className="warn-banner">
          Your Mac's output is muted - meeting audio is captured from what's
          actually played, so the meeting track would be silent. Unmute (or
          raise the volume) before recording.
        </div>
      )}

      {recording && captureSystem && systemSilent && (
        <div className="warn-banner">
          {loopback
            ? "Meeting audio is silent - check your Mac isn't muted and that the meeting is playing through this Mac's output."
            : "Meeting audio is silent - check that your Mac's sound output is the Multi-Output Device that includes BlackHole."}
        </div>
      )}

      {recording && screenWarning && (
        <div className="warn-banner">{screenWarning}</div>
      )}

      {!recording && nextMeeting && (
        <div className="next-meeting">
          <CalendarClock size={15} aria-hidden="true" />
          <span>
            <strong>{nextMeeting.title}</strong> · {startsLabel(nextMeeting)}
          </span>
          <span className="spacer" />
          <button
            className="ghost"
            title="Fill the session name and attendees from this meeting"
            onClick={() =>
              onPrefill(nextMeeting.title, meetingInvitees(nextMeeting))
            }
          >
            Prepare
          </button>
          {nextMeeting.videoLink && (
            <button
              className="ghost"
              onClick={() => api.openExternal(nextMeeting.videoLink!)}
            >
              Join
            </button>
          )}
        </div>
      )}

      <div className="deck" data-live={status === "recording"}>
        <div className="deck-top">
          <input
            className="deck-name"
            placeholder="Untitled session"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <select
            className="lang-select"
            title="Language of this meeting - sets the live transcription model"
            value={settings.language}
            disabled={recording}
            onChange={async (e) =>
              onChange(await api.setSettings({ language: e.target.value }))
            }
          >
            {[...new Set([settings.language, "he", "en"])].map((l) => (
              <option key={l} value={l}>
                {langName(l)}
              </option>
            ))}
          </select>
        </div>

        <div className="transport">
          <div
            className={
              status === "recording"
                ? "tally live"
                : status === "paused"
                  ? "tally paused"
                  : "tally"
            }
          >
            <span className="lamp" />
            {TALLY[status]}
          </div>
          <div className={status === "recording" ? "timer live" : "timer"}>
            {fmtClock(elapsed)}
          </div>
          <div className="transport-row">
            {recording && volume !== null && (
              <div
                className="transport-vol"
                title="Speaker volume - the keyboard volume keys can't control the recording audio device (macOS limitation)"
              >
                <Volume2 size={14} aria-hidden="true" />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                />
              </div>
            )}
            {status === "recording" && (
              <button className="rec-side" onClick={pause} title="Pause">
                <Pause size={16} fill="currentColor" />
              </button>
            )}
            {status === "paused" && (
              <button className="rec-side" onClick={resume} title="Resume">
                <Play size={16} fill="currentColor" />
              </button>
            )}
            {status === "idle" && (
              <button
                className="rec-main"
                onClick={handleStart}
                disabled={!micId}
                title="Start recording (⌘R)"
              >
                <Circle size={18} fill="currentColor" />
              </button>
            )}
            {recording && (
              <button
                className="rec-main"
                onClick={onStop}
                title="Stop & save (⌘R)"
              >
                <Square size={17} fill="currentColor" />
              </button>
            )}
            {status === "saving" && <span className="hint">Saving…</span>}
            {recording && (
              <button
                className="danger transport-discard"
                onClick={onDiscard}
                title="Stop without saving - deletes this recording"
              >
                <Trash2 size={13} /> Discard
              </button>
            )}
          </div>
          <div className="transport-label">
            {status === "recording"
              ? "recording - ⌘R stops & saves"
              : status === "paused"
                ? "paused - resume or stop & save"
                : "⌘R starts and stops"}
          </div>
        </div>

        <div className="strips">
          <section className="strip" data-ch="me">
            <div className="strip-head">
              <span className="strip-title">
                <span className="ch-dot" />
                Me - Mic
              </span>
            </div>
            <Waveform
              analyser={analysers.mic ?? null}
              color={CHANNEL_COLORS.me}
            />
            <div className="strip-foot">{deviceSelect(micId, setMicId)}</div>
          </section>

          <section
            className={captureSystem ? "strip" : "strip off"}
            data-ch="them"
          >
            <div className="strip-head">
              <span className="strip-title">
                <span className="ch-dot" />
                Them - Meeting
              </span>
              <label
                title={
                  loopback
                    ? "Tapped straight from the system audio - no driver, volume keys keep working"
                    : "System audio, tapped digitally via BlackHole"
                }
              >
                <input
                  type="checkbox"
                  checked={captureSystem}
                  disabled={recording || (!loopback && !devices.length)}
                  onChange={(e) => setCaptureSystem(e.target.checked)}
                />{" "}
                Capture
              </label>
            </div>
            <Waveform
              analyser={captureSystem ? (analysers.system ?? null) : null}
              color={CHANNEL_COLORS.them}
              onLevel={recording ? onSystemLevel : undefined}
            />
            <div className="strip-foot">
              {/* the system tap has no device to pick */}
              {loopback ? (
                <span className="strip-sub">System audio (direct tap)</span>
              ) : (
                deviceSelect(systemId, setSystemId)
              )}
            </div>
          </section>
        </div>

        <div className="deck-foot">
          <label title="You'll pick the screen or window when recording starts">
            <input
              type="checkbox"
              checked={recordScreen}
              disabled={recording}
              onChange={(e) => setRecordScreen(e.target.checked)}
            />
            <Monitor size={13} aria-hidden="true" /> Record the screen
          </label>
          <p className="hint">
            Tracks are stored separately - you're always the mic; meeting
            speakers are split when identification is on.
          </p>
        </div>
      </div>

      <LivePrompter active={recording && live} />

      {picker && (
        <div className="modal-overlay" onClick={() => setPicker(null)}>
          <div
            className="modal"
            role="dialog"
            aria-label="What should be recorded?"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-title">What should be recorded?</div>
            {picker.length === 0 ? (
              <p className="hint" style={{ padding: "20px 0" }}>
                Finding open windows…
              </p>
            ) : (
              <div className="src-grid">
                {picker.map((s, i) => (
                  <button
                    key={s.id}
                    className="src-item"
                    autoFocus={i === 0}
                    onClick={() => pickSource(s.id)}
                  >
                    {s.thumbnail ? (
                      <img src={s.thumbnail} alt="" />
                    ) : (
                      <div className="src-thumb-loading" aria-hidden="true" />
                    )}
                    <div className="src-name">
                      {s.kind === "screen" ? (
                        <Monitor size={12} aria-hidden="true" />
                      ) : (
                        <AppWindow size={12} aria-hidden="true" />
                      )}
                      <span className="src-label">{s.name}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <div
              className="row"
              style={{ justifyContent: "flex-end", marginTop: 14 }}
            >
              <button className="ghost" onClick={() => pickSource(null)}>
                Record without screen
              </button>
              <button className="ghost" onClick={() => setPicker(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
