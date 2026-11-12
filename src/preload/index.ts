import { contextBridge, ipcRenderer } from "electron";
import type {
  AudioSetupStatus,
  CalendarResult,
  ProviderInfo,
  ProviderStatus,
  ProviderTestResult,
  DownloadProgress,
  FileTrack,
  HfValidation,
  LintResult,
  LiveSegment,
  MeetingSummary,
  RecordingMeta,
  ScreenSourcesResult,
  Settings,
  SpeakerInfo,
  SummaryResult,
  SystemCaptureMode,
  TrackName,
  TranscribeProgress,
  TranscriptSegment,
} from "../shared/types";

export interface LiveEvent extends LiveSegment {
  recordingId: string;
}

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke("settings:set", patch),
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("dialog:pickFolder"),
  confirmDialog: (opts: {
    message: string;
    detail?: string;
    confirmLabel?: string;
  }): Promise<boolean> => ipcRenderer.invoke("dialog:confirm", opts),
  installBlackhole: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("blackhole:install"),
  /** used by the reminder toast window only */
  toastAction: (action: string): void =>
    ipcRenderer.send("toast:action", action),
  getVolume: (): Promise<number | null> => ipcRenderer.invoke("volume:get"),
  setVolume: (v: number): Promise<void> => ipcRenderer.invoke("volume:set", v),
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke("clipboard:write", text),
  audioStatus: (): Promise<AudioSetupStatus> =>
    ipcRenderer.invoke("audio:status"),
  audioEnsure: (rebuild?: boolean): Promise<AudioSetupStatus> =>
    ipcRenderer.invoke("audio:ensure", rebuild),
  validateHfToken: (token: string): Promise<HfValidation> =>
    ipcRenderer.invoke("hf:validate", token),
  recordingMenu: (opts: {
    canTranscribe: boolean;
    hasTranscript: boolean;
    currentLang: string;
    languages: { code: string; label: string }[];
  }): Promise<string | null> => ipcRenderer.invoke("menu:recording", opts),

  upcomingMeetings: (hours?: number): Promise<CalendarResult> =>
    ipcRenderer.invoke("calendar:upcoming", hours),
  openCalendarPrivacy: (): Promise<void> =>
    ipcRenderer.invoke("calendar:openPrivacySettings"),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("shell:openExternal", url),
  screenSources: (withThumbs?: boolean): Promise<ScreenSourcesResult> =>
    ipcRenderer.invoke("screen:sources", withThumbs),
  openScreenPrivacy: (): Promise<void> =>
    ipcRenderer.invoke("screen:openPrivacySettings"),
  /** same pane - macOS 15 renamed it "Screen & System Audio Recording" */
  openScreenRecordingPrivacy: (): Promise<void> =>
    ipcRenderer.invoke("screen:openPrivacySettings"),

  recBegin: (): Promise<{
    id: string;
    live: boolean;
    mode: SystemCaptureMode;
  }> => ipcRenderer.invoke("rec:begin"),
  recAppend: (id: string, track: FileTrack, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke("rec:append", id, track, data),
  recFeedPcm: (id: string, track: TrackName, data: ArrayBuffer): void =>
    ipcRenderer.send("rec:feedPcm", id, track, data),
  recFinish: (
    id: string,
    meta: Omit<RecordingMeta, "id" | "hasTranscript">,
  ): Promise<RecordingMeta> => ipcRenderer.invoke("rec:finish", id, meta),
  recAbort: (id: string): Promise<void> => ipcRenderer.invoke("rec:abort", id),
  onLiveSegment: (cb: (e: LiveEvent) => void): (() => void) => {
    const fn = (_e: unknown, p: LiveEvent) => cb(p);
    ipcRenderer.on("live:segment", fn);
    return () => ipcRenderer.removeListener("live:segment", fn);
  },

  onMeetingReminder: (
    cb: (p: { title: string; invitees: string[]; start?: boolean }) => void,
  ): (() => void) => {
    const fn = (
      _e: unknown,
      p: { title: string; invitees: string[]; start?: boolean },
    ) => cb(p);
    ipcRenderer.on("notify:meeting", fn);
    return () => ipcRenderer.removeListener("notify:meeting", fn);
  },

  onTrayCommand: (
    cb: (cmd: "start" | "stop" | "toggle") => void,
  ): (() => void) => {
    const fn = (_e: unknown, cmd: "start" | "stop" | "toggle") => cb(cmd);
    ipcRenderer.on("tray:command", fn);
    return () => ipcRenderer.removeListener("tray:command", fn);
  },

  listRecordings: (): Promise<RecordingMeta[]> =>
    ipcRenderer.invoke("recordings:list"),
  deleteRecording: (id: string): Promise<void> =>
    ipcRenderer.invoke("recordings:delete", id),
  revealRecording: (id: string): Promise<void> =>
    ipcRenderer.invoke("recordings:reveal", id),
  /** absolute folder holding the transcript/summary, or null if missing */
  recordingFolder: (id: string): Promise<string | null> =>
    ipcRenderer.invoke("recordings:folder", id),
  renameRecording: (id: string, title: string): Promise<RecordingMeta | null> =>
    ipcRenderer.invoke("recordings:rename", id, title),
  readTranscript: (id: string): Promise<string | null> =>
    ipcRenderer.invoke("transcript:read", id),
  getTranscriptSegments: (id: string): Promise<TranscriptSegment[]> =>
    ipcRenderer.invoke("transcript:segments", id),

  providerStatus: (): Promise<ProviderStatus & { name: string }> =>
    ipcRenderer.invoke("provider:status"),
  listProviders: (refresh = false): Promise<ProviderInfo[]> =>
    ipcRenderer.invoke("provider:list", refresh),
  testProvider: (): Promise<ProviderTestResult> =>
    ipcRenderer.invoke("provider:test"),
  lintTranscript: (id: string): Promise<LintResult> =>
    ipcRenderer.invoke("transcript:lint", id),
  getSummary: (id: string): Promise<MeetingSummary | null> =>
    ipcRenderer.invoke("summary:get", id),
  generateSummary: (id: string): Promise<SummaryResult> =>
    ipcRenderer.invoke("summary:generate", id),

  getSpeakers: (id: string): Promise<SpeakerInfo[]> =>
    ipcRenderer.invoke("speakers:get", id),
  renameSpeaker: (
    id: string,
    cluster: string,
    name: string,
  ): Promise<SpeakerInfo[] | null> =>
    ipcRenderer.invoke("speakers:rename", id, cluster, name),

  startTranscribe: (id: string, language?: string): Promise<number> =>
    ipcRenderer.invoke("transcribe:start", id, language),
  onTranscribeProgress: (cb: (p: TranscribeProgress) => void): (() => void) => {
    const fn = (_e: unknown, p: TranscribeProgress) => cb(p);
    ipcRenderer.on("transcribe:progress", fn);
    return () => ipcRenderer.removeListener("transcribe:progress", fn);
  },

  downloadedModels: (): Promise<string[]> =>
    ipcRenderer.invoke("models:downloaded"),
  downloadModel: (repo: string): Promise<number> =>
    ipcRenderer.invoke("models:download", repo),
  onModelProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
    const fn = (_e: unknown, p: DownloadProgress) => cb(p);
    ipcRenderer.on("models:progress", fn);
    return () => ipcRenderer.removeListener("models:progress", fn);
  },
};

export type Api = typeof api;
contextBridge.exposeInMainWorld("api", api);
