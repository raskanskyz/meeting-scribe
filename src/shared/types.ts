export interface Settings {
  recordingsDir: string;
  language: string;
  activeModel: string;
  /** language code -> model repo; unmapped languages and 'auto' use activeModel */
  modelMap: Record<string, string>;
  /** output device auto-selected while recording ('' disables auto-switch) */
  outputDevice: string;
  /** split the meeting track into individual speakers (pyannote diarization) */
  diarize: boolean;
  /** Hugging Face token for the gated pyannote diarization model */
  hfToken: string;
  /** minimum cosine similarity for a voice to match a saved voiceprint (0–1) */
  matchThreshold: number;
  /** path to the Claude Code CLI ('' auto-detects from PATH and common installs) */
  claudeBinary: string;
  /** model alias passed to `claude --model` for meeting summaries */
  summaryModel: string;
  /** automatically polish new transcripts with Claude after transcription */
  lintTranscripts: boolean;
  /** automatically generate a summary with Claude after transcription */
  autoSummarize: boolean;
  /** never touch the network: no Claude polish/summaries, no model downloads,
   *  sidecars forced to HF_HUB_OFFLINE */
  offlineMode: boolean;
  /** opt-in: polish and summaries also get screenshots from screen.webm (and the
   *  text read from them on-device). Sent to Claude when on; never in offline mode */
  screenContext: boolean;
  /** delete the raw track audio once transcript (+ polish/summary, when those
   *  are enabled) is on disk - reclaims space, makes re-transcribing impossible */
  deleteAudioWhenDone: boolean;
  /** ISO timestamp the setup wizard was completed or skipped; '' shows it on launch */
  onboardedAt: string;
  /** exclude the app's windows from screen sharing, recordings and screenshots */
  hideFromCapture: boolean;
  /** how meeting audio is captured; 'auto' prefers loopback when macOS supports it */
  systemCapture: "auto" | "loopback" | "blackhole";
}

/** How the meeting ("them") track is captured. `loopback` taps the system audio
 *  directly via ScreenCaptureKit/CATap - no driver, no output switching.
 *  `blackhole` is the legacy virtual-device route, kept for macOS < 14.2. */
export type SystemCaptureMode = "loopback" | "blackhole";

export interface AudioSetupStatus {
  /** a BlackHole output device is installed */
  blackhole: boolean;
  /** the managed Multi-Output Device exists */
  device: boolean;
  deviceName: string;
  /** the existing device actually routes into BlackHole (absent when no device) */
  deviceHasBlackhole?: boolean;
  defaultOutput?: string;
  /** set when this call created (or recreated) the device */
  created?: boolean;
  /** the physical output the device mirrors to */
  pairedWith?: string;
  /** this macOS can tap system audio directly (14.2+) */
  loopbackSupported: boolean;
  /** the capture route in effect, given the setting and what this Mac supports */
  mode: SystemCaptureMode;
  /** system output is muted - loopback taps post-volume, so it would record silence */
  outputMuted?: boolean;
  /** system output volume, 0–1 */
  outputVolume?: number;
  error?: string;
}

export interface HfValidation {
  ok: boolean;
  /** Hugging Face account name once the token itself checks out */
  user?: string;
  stage?: "network" | "token" | "gated";
  message?: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  cluster?: string;
}

export interface ActionItem {
  owner: string | null;
  text: string;
}

export interface MeetingSummary {
  executiveSummary: string;
  actionItems: ActionItem[];
  keyDecisions: string[];
  openQuestions: string[];
  model: string;
  generatedAt: string;
}

export interface ClaudeStatus {
  available: boolean;
  path?: string;
  reason?: string;
}

export interface SummaryResult {
  summary?: MeetingSummary;
  error?: string;
}

export interface LintResult {
  segments?: TranscriptSegment[];
  changed?: number;
  polishedAt?: string;
  error?: string;
  /** batches Claude failed on; corrections from the surviving batches still apply */
  failedBatches?: number;
  totalBatches?: number;
}

export type TrackName = "mic" | "system";

/** on-disk recording files: the two audio tracks plus the optional screen video */
export type FileTrack = TrackName | "screen";

export interface ScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** data-URL preview, present when the sources were fetched with thumbnails */
  thumbnail?: string;
}

export interface ScreenSourcesResult {
  /** macOS Screen Recording permission: 'granted', 'denied', … */
  status: string;
  sources: ScreenSource[];
}

export interface CalendarAttendee {
  name: string;
  status: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location?: string;
  notes?: string;
  url?: string;
  videoLink?: string;
  myStatus: string;
  organizer?: string;
  attendees: CalendarAttendee[];
}

export interface CalendarResult {
  /** 'ok' means access is granted; anything else means no events were read */
  status: "ok" | "denied" | "restricted" | "notDetermined" | "error";
  message?: string;
  events: CalendarEvent[];
}

export interface RecordingMeta {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  tracks: TrackName[];
  hasTranscript: boolean;
  attendees?: number;
  speakers?: string[];
  /** attendee names from the calendar event this was recorded from - the
   *  authoritative roster/count when present (diarization only labels turns) */
  invitees?: string[];
  /** 'ok' or the reason speaker identification was skipped */
  diarization?: string;
  /** ISO timestamp of the last Claude polish pass; absent = never polished */
  polishedAt?: string;
  /** ISO timestamp the raw track audio was reclaimed; the tracks are gone and
   *  this recording can never be re-transcribed */
  audioDeletedAt?: string;
  /** a screen.webm video exists for this recording (computed, like hasTranscript) */
  hasScreen?: boolean;
}

export interface SpeakerInfo {
  cluster: string;
  name: string;
  /** true when the name came from the voiceprint registry or a manual rename */
  matched: boolean;
}

export type Engine = "faster-whisper" | "mlx";

export interface ModelInfo {
  repo: string;
  label: string;
  detail: string;
  sizeGb: number;
  recommended?: boolean;
  /** which runtime the model runs on; absent = faster-whisper (CPU, batch) */
  engine?: Engine;
}

export interface LiveSegment {
  track: TrackName;
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscribeProgress {
  recordingId: string;
  phase:
    | "downloading"
    | "loading"
    | "transcribing"
    | "diarizing"
    | "merging"
    | "linting"
    | "summarizing"
    | "done"
    | "error";
  track?: TrackName | "diarize";
  pct?: number;
  message?: string;
}

export interface DownloadProgress {
  errorDetails?: string;
  repo: string;
  pct: number;
  done: boolean;
  error?: string;
}

/** Nemotron speaker model: fetched by diarize-sidecar, keyed like a repo for models:progress */
export const DIARIZE_MODEL = "FluidInference/nemotron-3-diarization-coreml";

export const CURATED_MODELS: ModelInfo[] = [
  {
    repo: "mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx",
    label: "ivrit.ai large-v3-turbo (live)",
    detail: "Hebrew fine-tune, Apple GPU - live transcription while recording",
    sizeGb: 1.5,
    engine: "mlx",
    recommended: true,
  },
  {
    repo: "mlx-community/whisper-large-v3-turbo",
    label: "Whisper large-v3-turbo (live, English)",
    detail:
      "Vanilla multilingual, Apple GPU - live transcription for English meetings",
    sizeGb: 1.6,
    engine: "mlx",
  },
  {
    repo: "ivrit-ai/whisper-large-v3-turbo-ct2",
    label: "ivrit.ai large-v3-turbo (CPU)",
    detail: "Hebrew fine-tune, CPU, transcribe after the meeting",
    sizeGb: 1.6,
  },
  {
    repo: "ivrit-ai/whisper-large-v3-ct2",
    label: "ivrit.ai large-v3",
    detail: "Hebrew fine-tune, most accurate, ~2x slower",
    sizeGb: 3.1,
  },
  {
    repo: "Systran/faster-whisper-large-v3",
    label: "Whisper large-v3",
    detail: "Vanilla multilingual (non-Hebrew meetings)",
    sizeGb: 3.1,
  },
  {
    repo: "Systran/faster-whisper-small",
    label: "Whisper small",
    detail: "Fast drafts, low accuracy on Hebrew",
    sizeGb: 0.5,
  },
];

/** Engine a model runs on. MLX models (Apple GPU, live) end in `-mlx`; all
 *  others are faster-whisper (CPU, batch). Falls back to the curated entry. */
export function modelEngine(repo: string): Engine {
  const known = CURATED_MODELS.find((m) => m.repo === repo);
  if (known?.engine) return known.engine;
  return /-mlx$/.test(repo) ? "mlx" : "faster-whisper";
}
