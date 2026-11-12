import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Cpu,
  Library,
  Mic,
  Settings as SettingsIcon,
  Square,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api";
import type {
  AudioSetupStatus,
  RecordingMeta,
  ScreenSource,
  Settings,
  TranscribeProgress,
} from "../../shared/types";
import { useRecorder } from "./hooks/useRecorder";
import { fmtClock } from "./fmt";
import RecordView from "./views/RecordView";
import MeetingsView from "./views/MeetingsView";
import LibraryView from "./views/LibraryView";
import MeetingDetailsView from "./views/MeetingDetailsView";
import type { AiJobType, AiNotice } from "./aiJobs";
import ModelsView from "./views/ModelsView";
import SettingsView from "./views/SettingsView";
import SetupWizard from "./views/SetupWizard";

type Tab = "record" | "meetings" | "library" | "models" | "settings";

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "record", label: "Record", icon: Mic },
  { id: "library", label: "Library", icon: Library },
  { id: "meetings", label: "Meetings", icon: CalendarDays },
  { id: "models", label: "Models", icon: Cpu },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function modelName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("record");
  // views stay mounted once visited so tab switches never lose state (open
  // transcripts, search text, scroll) or replay the entrance animation
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(["record"]));
  const [settings, setSettings] = useState<Settings | null>(null);

  // recorder + device selection live here (not in RecordView) so recording
  // keeps working across tab switches and can be driven from the tray menu
  const recorder = useRecorder();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState("");
  const [systemId, setSystemId] = useState("");
  const [captureSystem, setCaptureSystem] = useState(true);
  // how meeting audio will be captured (system tap vs BlackHole), decided by main
  const [audio, setAudio] = useState<AudioSetupStatus | null>(null);
  // screen recording defaults on; the source list refreshes when the picker opens
  const [recordScreen, setRecordScreen] = useState(true);
  const [screenSources, setScreenSources] = useState<ScreenSource[]>([]);
  const [screenSourceId, setScreenSourceId] = useState("");
  const [screenPermission, setScreenPermission] = useState("granted");
  const [title, setTitle] = useState("");
  // attendee names from a calendar meeting this recording was started from
  const [invitees, setInvitees] = useState<string[]>([]);
  const [recError, setRecError] = useState("");

  // transcription progress lives here, not in LibraryView, so switching tabs
  // during a job doesn't unmount the listener (dropping events) or lose the
  // accumulated phase - navigating back then showed a bar with no description
  const [txProgress, setTxProgress] = useState<
    Record<string, TranscribeProgress>
  >({});

  // meeting opened in the details page; survives tab switches
  const [openRec, setOpenRec] = useState<RecordingMeta | null>(null);
  // a start requested from outside the Record view (toast, tray, ⌘R) - the
  // view picks it up and runs its normal flow, screen picker included
  const [autoStart, setAutoStart] = useState(false);
  // bumped when a recording finishes or is renamed so the library refreshes
  const [libEpoch, setLibEpoch] = useState(0);

  // AI jobs (summary/polish) live here, not in the details view, so navigating
  // away and back doesn't lose the in-progress state or the completion result
  const [aiJobs, setAiJobs] = useState<Record<string, AiJobType | undefined>>(
    {},
  );
  const [aiNotices, setAiNotices] = useState<
    Record<string, AiNotice | undefined>
  >({});
  const activeAi = useRef<Set<string>>(new Set());

  // per-tab scroll offsets, restored when returning to a tab
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollPos = useRef<Record<string, number>>({});

  const switchTab = useCallback(
    (t: Tab) => {
      if (contentRef.current)
        scrollPos.current[tab] = contentRef.current.scrollTop;
      setOpenRec(null);
      setTab(t);
      setVisited((v) => (v.has(t) ? v : new Set(v).add(t)));
      requestAnimationFrame(() => {
        if (contentRef.current)
          contentRef.current.scrollTop = scrollPos.current[t] ?? 0;
      });
    },
    [tab],
  );
  const switchTabRef = useRef(switchTab);
  switchTabRef.current = switchTab;

  const openDetails = useCallback((rec: RecordingMeta) => {
    if (contentRef.current)
      scrollPos.current.library = contentRef.current.scrollTop;
    setOpenRec(rec);
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = 0;
    });
  }, []);

  const closeDetails = useCallback(() => {
    setOpenRec(null);
    requestAnimationFrame(() => {
      if (contentRef.current)
        contentRef.current.scrollTop = scrollPos.current.library ?? 0;
    });
  }, []);

  const runAiJob = useCallback(async (id: string, type: AiJobType) => {
    if (activeAi.current.has(id)) return;
    activeAi.current.add(id);
    setAiJobs((p) => ({ ...p, [id]: type }));
    setAiNotices((p) => ({ ...p, [id]: undefined }));
    let notice: AiNotice;
    if (type === "summary") {
      const res = await api.generateSummary(id);
      notice = { type, error: res.error };
    } else {
      const res = await api.lintTranscript(id);
      notice = { type, error: res.error, changed: res.changed };
      if (res.polishedAt) {
        const at = res.polishedAt;
        setOpenRec((cur) =>
          cur && cur.id === id ? { ...cur, polishedAt: at } : cur,
        );
      }
    }
    activeAi.current.delete(id);
    setAiJobs((p) => ({ ...p, [id]: undefined }));
    setAiNotices((p) => ({ ...p, [id]: notice }));
  }, []);

  useEffect(() => {
    api.getSettings().then(setSettings);
  }, []);

  // re-read on settings changes: switching capture mode changes what's required
  useEffect(() => {
    api.audioStatus().then(setAudio);
  }, [settings?.systemCapture, settings?.outputDevice]);

  // only the BlackHole route depends on a device being present; the system
  // tap has nothing to be missing
  useEffect(() => {
    if (audio?.mode !== "blackhole" || !devices.length) return;
    setCaptureSystem(devices.some((d) => /blackhole/i.test(d.label)));
  }, [audio?.mode, devices]);

  useEffect(
    () =>
      api.onTranscribeProgress((p) => {
        // progress events don't carry the phase, so merge them into the last one
        setTxProgress((prev) => ({
          ...prev,
          [p.recordingId]: p.phase ? p : { ...prev[p.recordingId], ...p },
        }));
      }),
    [],
  );

  const refreshScreenSources = useCallback(async () => {
    try {
      const res = await api.screenSources();
      setScreenSources(res.sources);
      setScreenPermission(res.status);
      // keep the current pick while it still exists; otherwise default to full screen
      setScreenSourceId((cur) =>
        cur && res.sources.some((s) => s.id === cur)
          ? cur
          : (res.sources.find((s) => s.kind === "screen")?.id ?? ""),
      );
    } catch {
      /* no sources just means the picker is empty until retried */
    }
  }, []);

  useEffect(() => {
    refreshScreenSources();
  }, [refreshScreenSources]);

  // screenOverride: explicit pick from the Record view's source dialog;
  // undefined (tray starts) falls back to the remembered/default source
  const startRecording = useCallback(
    async (screenOverride?: string | null) => {
      if (!settings || !micId || recorder.status !== "idle") return;
      setRecError("");
      const screenSrc =
        screenOverride !== undefined
          ? screenOverride
          : recordScreen && screenSourceId
            ? screenSourceId
            : null;
      try {
        await recorder.start(
          micId,
          captureSystem && systemId ? systemId : null,
          screenSrc,
        );
      } catch (e) {
        setRecError(`Could not start recording: ${e}`);
      }
    },
    [
      settings,
      micId,
      systemId,
      captureSystem,
      recordScreen,
      screenSourceId,
      recorder,
    ],
  );

  const stopRecording = useCallback(async () => {
    if (recorder.status !== "recording" && recorder.status !== "paused") return;
    await recorder.stop(title, invitees);
    setTitle("");
    setInvitees([]);
    setOpenRec(null);
    setLibEpoch((n) => n + 1);
    switchTabRef.current("library");
  }, [recorder, title, invitees]);

  const discardRecording = useCallback(async () => {
    if (recorder.status !== "recording" && recorder.status !== "paused") return;
    const ok = await api.confirmDialog({
      message: "Discard this recording?",
      detail: "The audio captured so far will be permanently deleted.",
      confirmLabel: "Discard",
    });
    if (!ok) return;
    await recorder.discard();
    setTitle("");
    setInvitees([]);
  }, [recorder]);

  const startRef = useRef(startRecording);
  startRef.current = startRecording;
  const stopRef = useRef(stopRecording);
  stopRef.current = stopRecording;
  const statusRef = useRef(recorder.status);
  statusRef.current = recorder.status;

  // device list refreshes live (BlackHole install, headphones) - devicechange
  // only adjusts selections while idle so a running recording's UI stays honest
  const enumRetries = useRef(0);
  const enumerate = useCallback(async () => {
    const inputs = (list: MediaDeviceInfo[]) =>
      list.filter(
        (d) =>
          d.kind === "audioinput" &&
          d.deviceId !== "default" &&
          d.deviceId !== "communications",
      );
    try {
      let all = inputs(await navigator.mediaDevices.enumerateDevices());
      // labels stay empty until mic permission has been exercised once -
      // probe only then, so devicechange refreshes don't blink the mic light
      if (!all.some((d) => d.label)) {
        const probe = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        probe.getTracks().forEach((t) => t.stop());
        all = inputs(await navigator.mediaDevices.enumerateDevices());
      }
      enumRetries.current = 0;
      setDevices(all);
      // a stale probe failure shouldn't outlive a successful refresh
      setRecError((cur) => (cur.startsWith("Microphone access") ? "" : cur));
      if (statusRef.current !== "idle") return;
      const bh = all.find((d) => /blackhole/i.test(d.label));
      setMicId((cur) =>
        cur && all.some((d) => d.deviceId === cur)
          ? cur
          : ((
              all.find((d) => /macbook.*microphone|built-in/i.test(d.label)) ??
              all[0]
            )?.deviceId ?? ""),
      );
      setSystemId((cur) =>
        cur && all.some((d) => d.deviceId === cur) ? cur : (bh?.deviceId ?? ""),
      );
      // captureSystem is driven by the audio-status effect (mode-aware)
    } catch (e) {
      // coreaudiod restarts (driver installs) fail transiently - retry first
      if (enumRetries.current < 3) {
        enumRetries.current += 1;
        setTimeout(enumerate, 2000);
        return;
      }
      setRecError(`Microphone access failed: ${e}`);
    }
  }, []);

  useEffect(() => {
    enumerate();
    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", enumerate);
  }, [enumerate]);

  // a "meeting starting soon" toast lands on Record, prefilled; its
  // "Start recording" button additionally opens the screen picker
  useEffect(
    () =>
      api.onMeetingReminder((p) => {
        if (statusRef.current !== "idle") return;
        setTitle(p.title);
        setInvitees(p.invitees);
        switchTabRef.current("record");
        if (p.start) setAutoStart(true);
      }),
    [],
  );

  // tray menu + app menu (⌘R sends 'toggle'); starts go through the Record
  // view so the screen picker is never skipped
  useEffect(
    () =>
      api.onTrayCommand((cmd) => {
        const busy =
          statusRef.current === "recording" || statusRef.current === "paused";
        if (cmd === "stop" || (cmd === "toggle" && busy)) {
          stopRef.current();
        } else {
          switchTabRef.current("record");
          setAutoStart(true);
        }
      }),
    [],
  );

  // ⌘1–5 switch tabs, ⌘, opens Settings (⌘R lives in the application menu)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === ",") {
        e.preventDefault();
        switchTabRef.current("settings");
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) {
        e.preventDefault();
        switchTabRef.current(TABS[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // rename from the details page keeps the open record and the library in sync
  const renameOpen = useCallback(async (id: string, title: string) => {
    const meta = await api.renameRecording(id, title);
    if (meta) {
      setOpenRec((cur) => (cur && cur.id === id ? { ...cur, ...meta } : cur));
      setLibEpoch((n) => n + 1);
    }
  }, []);

  const transcribeOpen = useCallback((id: string, lang?: string) => {
    setTxProgress((prev) => ({
      ...prev,
      [id]: { recordingId: id, phase: "loading" },
    }));
    api.startTranscribe(id, lang);
  }, []);

  if (!settings) return null;

  if (!settings.onboardedAt) {
    return <SetupWizard settings={settings} onChange={setSettings} />;
  }

  const recActive =
    recorder.status === "recording" || recorder.status === "paused";

  const viewFor = (t: Tab) => {
    switch (t) {
      case "record":
        return (
          <RecordView
            settings={settings}
            onChange={setSettings}
            recorder={recorder}
            devices={devices}
            micId={micId}
            systemId={systemId}
            captureSystem={captureSystem}
            recordScreen={recordScreen}
            setRecordScreen={setRecordScreen}
            screenSources={screenSources}
            setScreenSourceId={setScreenSourceId}
            screenPermission={screenPermission}
            setMicId={setMicId}
            setSystemId={setSystemId}
            setCaptureSystem={setCaptureSystem}
            title={title}
            setTitle={setTitle}
            error={recError}
            onStart={startRecording}
            onStop={stopRecording}
            onDiscard={discardRecording}
            audio={audio}
            onRefreshAudio={() => api.audioStatus().then(setAudio)}
            onRefreshDevices={enumerate}
            onPrefill={(t2, people) => {
              setTitle(t2);
              setInvitees(people);
            }}
            autoStart={autoStart}
            onAutoStarted={() => setAutoStart(false)}
          />
        );
      case "meetings":
        return (
          <MeetingsView
            active={tab === "meetings"}
            onPick={(t2, people) => {
              setTitle(t2);
              setInvitees(people);
              switchTabRef.current("record");
            }}
          />
        );
      case "library":
        return (
          <>
            {openRec && (
              <MeetingDetailsView
                rec={openRec}
                onBack={closeDetails}
                job={aiJobs[openRec.id]}
                notice={aiNotices[openRec.id]}
                progress={txProgress[openRec.id]}
                onGenerate={() => runAiJob(openRec.id, "summary")}
                onLint={() => runAiJob(openRec.id, "lint")}
                onRename={(t2) => renameOpen(openRec.id, t2)}
                onTranscribe={() => transcribeOpen(openRec.id)}
              />
            )}
            <div hidden={!!openRec}>
              <LibraryView
                settings={settings}
                active={tab === "library" && !openRec}
                epoch={libEpoch}
                progress={txProgress}
                setProgress={setTxProgress}
                onOpen={openDetails}
                onRecord={() => switchTabRef.current("record")}
                aiJobs={aiJobs}
              />
            </div>
          </>
        );
      case "models":
        return <ModelsView settings={settings} onChange={setSettings} />;
      case "settings":
        return <SettingsView settings={settings} onChange={setSettings} />;
    }
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="brand-text">
            <span className="brand-name">Meeting Scribe</span>
            <span className="brand-sub">Two-track · local</span>
          </div>
        </div>

        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "nav-btn active" : "nav-btn"}
            onClick={() => switchTab(t.id)}
          >
            <t.icon size={15} aria-hidden="true" />
            {t.label}
          </button>
        ))}

        {recActive && (
          <div
            className={`rec-pill ${recorder.status}`}
            title={
              recorder.status === "paused" ? "Recording paused" : "Recording"
            }
          >
            <button
              className="rec-pill-time"
              onClick={() => switchTab("record")}
            >
              <span className="lamp" />
              {fmtClock(recorder.elapsed)}
            </button>
            <button
              className="rec-pill-stop"
              title="Stop & save"
              onClick={stopRecording}
            >
              <Square size={9} fill="currentColor" />
            </button>
          </div>
        )}

        <div className="rail-foot">
          <div>
            <div className="k">Engine</div>
            <div className="v" title={settings.activeModel}>
              {modelName(settings.activeModel)}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.offlineMode}
            className={`offline-toggle${settings.offlineMode ? " on" : ""}`}
            title="Offline mode: nothing leaves this Mac (no downloads, polish or summaries)"
            onClick={async () =>
              setSettings(await api.setSettings({ offlineMode: !settings.offlineMode }))
            }
          >
            Offline mode: {settings.offlineMode ? "On" : "Off"}
          </button>
        </div>
      </nav>

      <main className="content" ref={contentRef}>
        {TABS.map(
          ({ id }) =>
            visited.has(id) && (
              <div className="view" key={id} hidden={tab !== id}>
                {viewFor(id)}
              </div>
            ),
        )}
      </main>
    </div>
  );
}
