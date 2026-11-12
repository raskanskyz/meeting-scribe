import { downloadError } from "../shared/downloadError";
import {
  app,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  shell,
  systemPreferences,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { diarizeSidecar, runSidecar } from "./sidecar";
import { StreamSession } from "./stream";
import { fetchUpcoming } from "./calendar";
import {
  ensureMultiOutput,
  getOutputVolume,
  setOutputVolume,
  switchOutputForRecording,
} from "./audio";
import { audioEnsure, audioStatus, captureMode } from "./audiosetup";
import { validateHfToken } from "./hf";
import { setTrayRecording } from "./tray";
import { recordingFolder } from "./recordingFolder";
import {
  buildTranscriptMd,
  type SpeakerRecord,
  type TranscriptSegment,
} from "./transcript";
import {
  claudeStatus,
  findClaude,
  generateSummary,
  lintTranscript,
} from "./summarize";
import { DIARIZE_MODEL, modelEngine } from "../shared/types";
import type {
  FileTrack,
  LintResult,
  LiveSegment,
  MeetingSummary,
  RecordingMeta,
  ScreenSourcesResult,
  Settings,
  SpeakerInfo,
  SummaryResult,
  TrackName,
} from "../shared/types";

const DEFAULT_SETTINGS: Settings = {
  recordingsDir: path.join(
    app.getPath("home"),
    "Desktop/dev/meeting-scribe/recordings",
  ),
  language: "he",
  activeModel: "mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx",
  modelMap: { en: "mlx-community/whisper-large-v3-turbo" },
  outputDevice: "Meeting Scribe",
  diarize: true,
  hfToken: "",
  matchThreshold: 0.55,
  claudeBinary: "",
  summaryModel: "sonnet",
  lintTranscripts: true,
  autoSummarize: true,
  offlineMode: false,
  deleteAudioWhenDone: false,
  onboardedAt: "",
  hideFromCapture: true,
  systemCapture: "auto",
};

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const modelsDir = () => path.join(app.getPath("userData"), "models");
const modelDirFor = (repo: string) =>
  path.join(modelsDir(), repo.replace("/", "__"));
const voiceprintsPath = () =>
  path.join(app.getPath("userData"), "voiceprints.json");

/** model repo for a language, honoring per-language overrides */
const modelFor = (s: Settings, lang: string) =>
  (lang !== "auto" && s.modelMap[lang]) || s.activeModel;
/** the on-disk file that marks a model as downloaded, per engine */
const modelMarker = (repo: string) =>
  modelEngine(repo) === "mlx" ? "weights.safetensors" : "model.bin";
const diarizeCache = () => path.join(modelsDir(), "diarization");
// written by FluidAudio only once the Nemotron download is complete
const diarizeModelReady = () =>
  fs.existsSync(
    path.join(diarizeCache(), "nemotron-3-diarization", ".fluidaudio-nemotron3-weights"),
  );
const isDownloaded = (repo: string) =>
  fs.existsSync(path.join(modelDirFor(repo), modelMarker(repo)));

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** sidecar network posture: HF token when allowed, hard offline otherwise */
const sidecarEnv = (s: Settings): Record<string, string> =>
  s.offlineMode
    ? { HF_HUB_OFFLINE: "1" }
    : s.hfToken
      ? { HF_TOKEN: s.hfToken }
      : {};

const sanitizeSpeakers = (list: SpeakerRecord[]): SpeakerInfo[] =>
  list.map(({ cluster, name, matched }) => ({ cluster, name, matched }));

const CLAUDE_MISSING =
  "Claude Code CLI not found. Install it and sign in (claude.com/claude-code), or set its path in Settings.";
const OFFLINE_ON =
  "Offline mode is on (Settings) - AI polish and summaries are disabled.";

async function lintAndSave(dir: string): Promise<LintResult> {
  const s = loadSettings();
  if (s.offlineMode) return { error: OFFLINE_ON };
  const bin = findClaude(s.claudeBinary);
  if (!bin) return { error: CLAUDE_MISSING };
  const metaPath = path.join(dir, "meta.json");
  const meta = await readJson<RecordingMeta>(metaPath);
  const segs = await readJson<TranscriptSegment[]>(
    path.join(dir, "transcript.json"),
  );
  if (!meta || !segs?.length)
    return { error: "Transcribe this recording first." };
  try {
    const { segments, changed, failedBatches, totalBatches } =
      await lintTranscript(bin, s.summaryModel || "sonnet", segs);
    if (changed) {
      // keep the untouched ASR output around; only the first lint writes it
      const rawPath = path.join(dir, "transcript.raw.json");
      if (!fs.existsSync(rawPath))
        await fsp.copyFile(path.join(dir, "transcript.json"), rawPath);
      await fsp.writeFile(
        path.join(dir, "transcript.json"),
        JSON.stringify(segments, null, 1),
      );
      await fsp.writeFile(
        path.join(dir, "transcript.md"),
        buildTranscriptMd(meta.title, segments),
      );
    }
    // mark polished even with zero corrections, so the badge means "swept", not "edited"
    const polishedAt = new Date().toISOString();
    meta.polishedAt = polishedAt;
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
    return { segments, changed, polishedAt, failedBatches, totalBatches };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function summarizeAndSave(dir: string): Promise<SummaryResult> {
  const s = loadSettings();
  if (s.offlineMode) return { error: OFFLINE_ON };
  const bin = findClaude(s.claudeBinary);
  if (!bin) return { error: CLAUDE_MISSING };
  const meta = await readJson<RecordingMeta>(path.join(dir, "meta.json"));
  const segs = await readJson<TranscriptSegment[]>(
    path.join(dir, "transcript.json"),
  );
  if (!meta || !segs?.length)
    return { error: "Transcribe this recording first." };
  try {
    const summary = await generateSummary(bin, s.summaryModel || "sonnet", {
      title: meta.title,
      createdAt: meta.createdAt,
      speakers: meta.speakers ?? [],
      segments: segs,
    });
    await fsp.writeFile(
      path.join(dir, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    return { summary };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Drop the raw track audio once every enabled stage has produced its artifact.
 *  Irreversible - the recording can never be re-transcribed after this. */
async function pruneAudio(dir: string): Promise<boolean> {
  const s = loadSettings();
  if (!s.deleteAudioWhenDone) return false;
  const metaPath = path.join(dir, "meta.json");
  const meta = await readJson<RecordingMeta>(metaPath);
  if (!meta || meta.audioDeletedAt) return false;

  // every stage the user asked for must have landed, or we'd throw away the
  // only input a retry could use
  if (!fs.existsSync(path.join(dir, "transcript.json"))) return false;
  const claudeReachable = !s.offlineMode && !!findClaude(s.claudeBinary);
  if (claudeReachable) {
    if (s.lintTranscripts && !meta.polishedAt) return false;
    if (s.autoSummarize && !fs.existsSync(path.join(dir, "summary.json")))
      return false;
  }

  for (const track of ["mic", "system"] as TrackName[]) {
    await fsp.rm(path.join(dir, `${track}.webm`), { force: true });
  }
  meta.audioDeletedAt = new Date().toISOString();
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
  return true;
}

export function loadSettings(): Settings {
  try {
    return {
      ...DEFAULT_SETTINGS,
      ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const writeStreams = new Map<string, fs.WriteStream>();
const streamKey = (id: string, track: FileTrack) => `${id}:${track}`;

/**
 * Sessions whose files are already closed. A stopped MediaRecorder can still
 * deliver chunks for a while, and an append arriving after the streams are gone
 * would otherwise reopen the track and clobber the take.
 */
const closedSessions = new Set<string>();

/** flush and drop every file stream a session opened (audio tracks + screen) */
async function closeStreams(id: string): Promise<void> {
  closedSessions.add(id);
  for (const track of ["mic", "system", "screen"] as FileTrack[]) {
    const ws = writeStreams.get(streamKey(id, track));
    if (ws) {
      await new Promise((res) => ws.end(res));
      writeStreams.delete(streamKey(id, track));
    }
  }
}

/** live MLX transcription sessions, keyed by recording id */
const liveSessions = new Map<string, StreamSession>();

let restoreOutput: (() => Promise<void>) | null = null;

export async function restoreOutputDevice(): Promise<void> {
  await restoreOutput?.();
  restoreOutput = null;
}

export function registerIpc(win: BrowserWindow): void {
  const send = (channel: string, payload: unknown) => {
    if (win.isDestroyed()) return;
    // mirror transcription progress on the dock icon
    if (channel === "transcribe:progress") {
      const p = payload as { phase?: string; pct?: number };
      if (p.phase === "done" || p.phase === "error") win.setProgressBar(-1);
      else if (typeof p.pct === "number")
        win.setProgressBar(Math.min(p.pct, 100) / 100);
    }
    win.webContents.send(channel, payload);
  };

  // recording state on the dock + window title, visible from any tab or app
  const markRecording = (rec: boolean) => {
    setTrayRecording(win, rec);
    app.dock?.setBadge(rec ? "REC" : "");
    if (!win.isDestroyed())
      win.setTitle(rec ? "● Recording - Meeting Scribe" : "Meeting Scribe");
  };

  // best-effort Claude polish + summary, shared by batch transcribe and live
  // finalize; a Claude failure must never fail the transcription itself
  async function claudePost(id: string, recDir: string): Promise<void> {
    const after = loadSettings();
    if (!after.offlineMode && findClaude(after.claudeBinary)) {
      if (after.lintTranscripts) {
        send("transcribe:progress", { recordingId: id, phase: "linting" });
        await lintAndSave(recDir);
      }
      if (after.autoSummarize) {
        send("transcribe:progress", { recordingId: id, phase: "summarizing" });
        await summarizeAndSave(recDir);
      }
    }
    try {
      await pruneAudio(recDir);
    } catch {
      /* reclaiming space must never fail a finished transcription */
    }
    send("transcribe:progress", { recordingId: id, phase: "done" });
  }

  // shared by the Models tab and the transcribe path's auto-download; always
  // emits models:progress so the Models view stays in sync either way
  async function downloadModelRepo(
    repo: string,
    onPct?: (pct: number) => void,
  ): Promise<number> {
    const reportError = (raw: unknown) => send("models:progress", {
      repo, pct: 0, done: true, ...downloadError(raw, repo),
    });
    try {
      const dest = modelDirFor(repo);
      await fsp.mkdir(dest, { recursive: true });
      const { promise } = runSidecar(
        ["download", "--repo", repo, "--dest", dest],
        (ev) => {
          if (ev.type === "progress") {
            send("models:progress", { repo, pct: ev.pct, done: false });
            onPct?.(Number(ev.pct) || 0);
          } else if (ev.type === "error") {
            reportError(ev.message);
          }
        },
        // the HF token, so gated repos (and stale cached logins) work
        sidecarEnv(loadSettings()),
      );
      const code = await promise;
      if (code === 0) send("models:progress", { repo, pct: 100, done: true });
      return code;
    } catch (error) {
      reportError(error);
      return 1;
    }
  }

  // prefetch the Nemotron speaker model (setup wizard), so the first
  // transcription doesn't stall on it; transcribe still fetches it if skipped
  async function prepareDiarizeModel(): Promise<number> {
    const cache = diarizeCache();
    await fsp.mkdir(cache, { recursive: true });
    return new Promise((resolve) => {
      const child = spawn(diarizeSidecar(), ["--prepare", "--cache", cache], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let buf = "";
      let error: string | undefined;
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const ev = JSON.parse(line) as { progress?: number; error?: string };
            if (ev.error) error = ev.error;
            else if (ev.progress !== undefined)
              send("models:progress", { repo: DIARIZE_MODEL, pct: ev.progress, done: false });
          } catch {
            // non-JSON noise
          }
        }
      });
      let finished = false;
      // 'error' and 'close' can both fire; report once
      const finish = (code: number, err?: string) => {
        if (finished) return;
        finished = true;
        send("models:progress", {
          repo: DIARIZE_MODEL,
          pct: code === 0 ? 100 : 0,
          done: true,
          ...(code === 0 ? {} : downloadError(err ?? `exit ${code}`, DIARIZE_MODEL)),
        });
        resolve(code);
      };
      child.on("error", (e) => finish(1, `speaker model helper failed to start: ${e.message}`));
      child.on("close", (code) => finish(code ?? 1, error));
    });
  }

  // full batch transcription of a recording's tracks (plus diarization and
  // Claude post-processing); the UI follows transcribe:progress
  async function runTranscription(
    id: string,
    language?: string,
  ): Promise<number> {
    const s = loadSettings();
    const lang = language || s.language;
    const model = modelFor(s, lang);
    const recDir = path.join(s.recordingsDir, id);
    // a missing model is not a dead end: fetch it first, then transcribe
    if (!isDownloaded(model)) {
      if (s.offlineMode) {
        send("transcribe:progress", {
          recordingId: id,
          phase: "error",
          message: `model not downloaded: ${model} (offline mode is on)`,
        });
        return 1;
      }
      send("transcribe:progress", {
        recordingId: id,
        phase: "downloading",
        pct: 0,
      });
      const dl = await downloadModelRepo(model, (pct) =>
        send("transcribe:progress", {
          recordingId: id,
          phase: "downloading",
          pct,
        }),
      );
      if (dl !== 0 || !isDownloaded(model)) {
        send("transcribe:progress", {
          recordingId: id,
          phase: "error",
          message:
            "model download failed - see the Models tab (a Hugging Face token may be required)",
        });
        return dl || 1;
      }
    }
    const args = [
      "transcribe",
      "--dir",
      recDir,
      "--model-dir",
      modelDirFor(model),
      "--language",
      lang,
    ];
    args.push("--engine", modelEngine(model));
    if (s.diarize) {
      const cache = diarizeCache();
      await fsp.mkdir(cache, { recursive: true });
      args.push("--diarize-cache", cache, "--voiceprints", voiceprintsPath());
      args.push("--match-threshold", String(s.matchThreshold));
    }
    const { promise } = runSidecar(
      args,
      (ev) => {
        if (ev.type === "error") {
          send("transcribe:progress", {
            recordingId: id,
            phase: "error",
            message: ev.message,
          });
        } else if (ev.type === "progress" || ev.type === "phase") {
          send("transcribe:progress", { recordingId: id, ...ev });
        }
      },
      sidecarEnv(s),
    );
    const code = await promise;
    if (code === 0) await claudePost(id, recDir);
    return code;
  }

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:set", async (_e, patch: Partial<Settings>) => {
    const next = { ...loadSettings(), ...patch };
    await fsp.writeFile(settingsPath(), JSON.stringify(next, null, 2));
    if ("hideFromCapture" in patch && !win.isDestroyed())
      win.setContentProtection(!!next.hideFromCapture);
    return next;
  });

  ipcMain.handle("dialog:pickFolder", async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // native macOS confirmation - window.confirm blocks the renderer and looks
  // like a browser dialog
  ipcMain.handle(
    "dialog:confirm",
    async (
      _e,
      opts: { message: string; detail?: string; confirmLabel?: string },
    ): Promise<boolean> => {
      const res = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: [opts.confirmLabel ?? "OK", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: opts.message,
        detail: opts.detail,
      });
      return res.response === 0;
    },
  );

  ipcMain.handle("clipboard:write", (_e, text: string) => {
    clipboard.writeText(text);
  });

  // volume keys can't control the multi-output aggregate while recording, so
  // the deck exposes a slider that reaches the physical speakers underneath
  ipcMain.handle("volume:get", () => getOutputVolume());
  ipcMain.handle("volume:set", (_e, v: number) =>
    setOutputVolume(Math.min(Math.max(v, 0), 1)),
  );

  ipcMain.handle("audio:status", () => audioStatus(loadSettings()));

  ipcMain.handle("audio:ensure", (_e, rebuild?: boolean) =>
    audioEnsure(loadSettings(), rebuild),
  );

  ipcMain.handle("hf:validate", (_e, token: string) => {
    if (loadSettings().offlineMode) {
      return { ok: false, stage: "network", message: OFFLINE_ON };
    }
    return validateHfToken(token);
  });

  // one-click BlackHole install: brew only downloads the pkg (brew must never
  // run as root); Apple's installer runs it behind the native admin dialog
  ipcMain.handle(
    "blackhole:install",
    async (): Promise<{ ok: boolean; message?: string }> => {
      const run = promisify(execFile);
      const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((p) =>
        fs.existsSync(p),
      );
      if (!brew)
        return {
          ok: false,
          message:
            "Homebrew not found - install it from brew.sh first, or download BlackHole from existential.audio.",
        };
      try {
        await run(brew, ["fetch", "--cask", "blackhole-2ch"], {
          timeout: 180_000,
        });
        const { stdout } = await run(
          brew,
          ["--cache", "--cask", "blackhole-2ch"],
          { timeout: 30_000 },
        );
        const pkg = stdout.trim();
        if (!pkg || !fs.existsSync(pkg))
          return {
            ok: false,
            message:
              "Download failed - try `brew install blackhole-2ch` in a terminal.",
          };
        // path goes in via argv so quoting stays sane; coreaudiod only scans
        // for drivers at startup, so restart it in the same admin prompt
        await run(
          "osascript",
          [
            "-e",
            'on run argv\ndo shell script "installer -pkg " & quoted form of item 1 of argv & " -target / && killall coreaudiod" with administrator privileges\nend run',
            pkg,
          ],
          { timeout: 300_000 },
        );
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/canceled|-128/i.test(msg))
          return { ok: false, message: "Installation canceled." };
        return { ok: false, message: msg };
      }
    },
  );

  // native context menu for a library row; resolves with the picked action
  ipcMain.handle(
    "menu:recording",
    (
      _e,
      opts: {
        canTranscribe: boolean;
        hasTranscript: boolean;
        currentLang: string;
        languages: { code: string; label: string }[];
      },
    ): Promise<string | null> =>
      new Promise((resolve) => {
        let picked: string | null = null;
        const pick = (v: string) => () => {
          picked = v;
        };
        const template: MenuItemConstructorOptions[] = [
          {
            label: opts.hasTranscript ? "Re-transcribe" : "Transcribe",
            enabled: opts.canTranscribe,
            click: pick(`transcribe:${opts.currentLang}`),
          },
          {
            label: "Transcribe in",
            enabled: opts.canTranscribe,
            submenu: opts.languages.map((l) => ({
              label: l.label,
              type: "radio" as const,
              checked: l.code === opts.currentLang,
              click: pick(`transcribe:${l.code}`),
            })),
          },
          { type: "separator" },
          { label: "Rename…", click: pick("rename") },
          { label: "Reveal in Finder", click: pick("reveal") },
          { type: "separator" },
          { label: "Delete…", click: pick("delete") },
        ];
        Menu.buildFromTemplate(template).popup({
          window: win,
          // click handlers run before the close callback's next tick
          callback: () => setTimeout(() => resolve(picked), 50),
        });
      }),
  );

  ipcMain.handle("calendar:upcoming", (_e, hours?: number) =>
    fetchUpcoming(hours),
  );

  ipcMain.handle("calendar:openPrivacySettings", () =>
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
    ),
  );

  ipcMain.handle("screen:openPrivacySettings", () =>
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ),
  );

  ipcMain.handle("shell:openExternal", (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // listing sources is also what triggers the macOS Screen Recording
  // permission prompt on first use
  ipcMain.handle(
    "screen:sources",
    async (_e, withThumbs?: boolean): Promise<ScreenSourcesResult> => {
      const status = systemPreferences.getMediaAccessStatus("screen");
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: withThumbs
            ? { width: 320, height: 180 }
            : { width: 0, height: 0 },
        });
        return {
          status,
          sources: sources.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.id.startsWith("screen")
              ? ("screen" as const)
              : ("window" as const),
            ...(withThumbs ? { thumbnail: s.thumbnail.toDataURL() } : {}),
          })),
        };
      } catch {
        // enumeration fails without Screen Recording permission - report that
        // instead of throwing so the Record view can show the fix
        return {
          status: status === "granted" ? "denied" : status,
          sources: [],
        };
      }
    },
  );

  ipcMain.handle("rec:begin", async () => {
    const s = loadSettings();
    const mode = captureMode(s);
    // the system tap needs no device or output rerouting - that's its point;
    // BlackHole route: ensure the multi-output exists, then switch to it
    if (mode === "blackhole") {
      if (s.outputDevice === "Meeting Scribe")
        await ensureMultiOutput(s.outputDevice);
      if (s.outputDevice)
        restoreOutput = await switchOutputForRecording(s.outputDevice);
    }
    const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    closedSessions.delete(id);
    await fsp.mkdir(path.join(s.recordingsDir, id), { recursive: true });

    // start live transcription when the active model runs on the GPU and is present
    let live = false;
    const model = modelFor(s, s.language);
    if (modelEngine(model) === "mlx" && isDownloaded(model)) {
      const session = new StreamSession(
        modelDirFor(model),
        s.language,
        (seg) => send("live:segment", { recordingId: id, ...seg }),
        (message) => send("live:error", { recordingId: id, message }),
      );
      liveSessions.set(id, session);
      live = true;
    }

    markRecording(true);
    return { id, live, mode };
  });

  // one-way PCM feed for the live transcription sidecar (16 kHz mono int16 LE)
  ipcMain.on(
    "rec:feedPcm",
    (_e, id: string, track: TrackName, data: ArrayBuffer) => {
      liveSessions.get(id)?.feed(track, data);
    },
  );

  // recorder failed to start after rec:begin - clean up the empty session
  ipcMain.handle("rec:abort", async (_e, id: string) => {
    const session = liveSessions.get(id);
    if (session) {
      session.kill();
      liveSessions.delete(id);
    }
    markRecording(false);
    await restoreOutputDevice();
    await closeStreams(id);
    await fsp.rm(path.join(loadSettings().recordingsDir, id), {
      recursive: true,
      force: true,
    });
  });

  ipcMain.handle(
    "rec:append",
    async (_e, id: string, track: FileTrack, data: ArrayBuffer) => {
      if (closedSessions.has(id)) return; // stale chunk from an already-saved take
      const key = streamKey(id, track);
      let ws = writeStreams.get(key);
      if (!ws) {
        ws = fs.createWriteStream(
          path.join(loadSettings().recordingsDir, id, `${track}.webm`),
          { flags: "a" }, // append only: 'w' would wipe the take already on disk
        );
        writeStreams.set(key, ws);
      }
      ws.write(Buffer.from(data));
    },
  );

  ipcMain.handle(
    "rec:finish",
    async (
      _e,
      id: string,
      meta: Omit<RecordingMeta, "id" | "hasTranscript">,
    ) => {
      await closeStreams(id);
      const full: RecordingMeta = { ...meta, id, hasTranscript: false };
      const recDir = path.join(loadSettings().recordingsDir, id);
      await fsp.writeFile(
        path.join(recDir, "meta.json"),
        JSON.stringify(full, null, 2),
      );
      await restoreOutputDevice();
      markRecording(false);

      // live recording: drain the streaming sidecar and keep its segments as a
      // preview record, then re-transcribe the full tracks in batch - whole-file
      // context beats the live path's 15s VAD chunks, so the stored transcript
      // never inherits live-only artifacts
      const session = liveSessions.get(id);
      if (session) {
        liveSessions.delete(id);
        const segments: LiveSegment[] = await session.end();
        await fsp.writeFile(
          path.join(recDir, "live.json"),
          JSON.stringify(segments, null, 1),
        );
        void runTranscription(id);
      }
      return full;
    },
  );

  ipcMain.handle("recordings:list", async (): Promise<RecordingMeta[]> => {
    const dir = loadSettings().recordingsDir;
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out: RecordingMeta[] = [];
    for (const name of entries) {
      const recDir = path.join(dir, name);
      try {
        const meta = JSON.parse(
          await fsp.readFile(path.join(recDir, "meta.json"), "utf8"),
        );
        // an interrupted recording leaves a folder without the base record; the
        // transcribe sidecar then recreates meta.json with only its own fields -
        // fill the gaps so one such folder can't blank the whole library
        meta.id ??= name;
        meta.title ??= name;
        if (typeof meta.createdAt !== "string") {
          const t = new Date(
            name.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3"),
          );
          meta.createdAt = isNaN(t.getTime())
            ? new Date(0).toISOString()
            : t.toISOString();
        }
        meta.durationSec ??= 0;
        meta.tracks ??= (["mic", "system"] as TrackName[]).filter((t) =>
          fs.existsSync(path.join(recDir, `${t}.webm`)),
        );
        meta.hasTranscript = fs.existsSync(path.join(recDir, "transcript.md"));
        meta.hasScreen = fs.existsSync(path.join(recDir, "screen.webm"));
        out.push(meta);
      } catch {
        /* not a recording folder */
      }
    }
    return out.sort((a, b) =>
      (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    );
  });

  ipcMain.handle("recordings:delete", async (_e, id: string) => {
    const dir = path.join(loadSettings().recordingsDir, id);
    try {
      await shell.trashItem(dir); // recoverable beats gone
    } catch {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  ipcMain.handle("recordings:reveal", async (_e, id: string) => {
    shell.showItemInFolder(
      path.join(loadSettings().recordingsDir, id, "meta.json"),
    );
  });

  ipcMain.handle("recordings:folder", (_e, id: string) =>
    recordingFolder(loadSettings().recordingsDir, id),
  );

  ipcMain.handle("recordings:rename", async (_e, id: string, title: string) => {
    const dir = path.join(loadSettings().recordingsDir, id);
    const meta = await readJson<RecordingMeta>(path.join(dir, "meta.json"));
    if (!meta) return null;
    meta.title = title;
    await fsp.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
    const segs = await readJson<TranscriptSegment[]>(
      path.join(dir, "transcript.json"),
    );
    if (segs)
      await fsp.writeFile(
        path.join(dir, "transcript.md"),
        buildTranscriptMd(title, segs),
      );
    return meta;
  });

  ipcMain.handle(
    "speakers:get",
    async (_e, id: string): Promise<SpeakerInfo[]> => {
      const list = await readJson<SpeakerRecord[]>(
        path.join(loadSettings().recordingsDir, id, "speakers.json"),
      );
      return list ? sanitizeSpeakers(list) : [];
    },
  );

  ipcMain.handle(
    "speakers:rename",
    async (
      _e,
      id: string,
      cluster: string,
      rawName: string,
    ): Promise<SpeakerInfo[] | null> => {
      const dir = path.join(loadSettings().recordingsDir, id);
      const list = await readJson<SpeakerRecord[]>(
        path.join(dir, "speakers.json"),
      );
      const sp = list?.find((s) => s.cluster === cluster);
      if (!list || !sp) return null;

      const reg =
        (await readJson<
          Record<string, { embedding: number[]; count?: number }>
        >(voiceprintsPath())) ?? {};

      // One person, one spelling. Names differing only in case are the same
      // identity - otherwise they'd split into two timeline lanes, two colors
      // and an inflated attendee count. What you type wins and propagates, so
      // typing "Danielle" over an enrolled "DANIELLE" re-cases her everywhere
      // instead of snapping back.
      const name = rawName.trim();
      const sameName = (a: string, b: string) =>
        a.toLowerCase() === b.toLowerCase();

      sp.name = name;
      sp.matched = true;
      for (const s of list)
        if (s !== sp && sameName(s.name, name)) s.name = name;
      await fsp.writeFile(
        path.join(dir, "speakers.json"),
        JSON.stringify(list),
      );

      // enroll (or reinforce) this voice under the given name so future
      // recordings auto-match it; default-looking labels would poison the
      // registry (renaming a chip without editing it counts as a rename)
      if (sp.embedding?.length && !/^speaker[\s_]*\d+$/i.test(name)) {
        // re-key an existing voice to the new casing rather than enrolling a
        // second voiceprint for the same person
        const prev = Object.keys(reg).find((k) => sameName(k, name));
        if (prev && prev !== name) {
          reg[name] = reg[prev];
          delete reg[prev];
        }
        const entry = reg[name];
        if (entry?.embedding?.length === sp.embedding.length) {
          const c = entry.count ?? 1;
          entry.embedding = entry.embedding.map(
            (v, i) => (v * c + sp.embedding[i]) / (c + 1),
          );
          entry.count = c + 1;
        } else {
          reg[name] = { embedding: sp.embedding, count: 1 };
        }
        await fsp.writeFile(voiceprintsPath(), JSON.stringify(reg));
      }

      const metaPath = path.join(dir, "meta.json");
      const meta = await readJson<RecordingMeta>(metaPath);
      const segs = await readJson<TranscriptSegment[]>(
        path.join(dir, "transcript.json"),
      );
      if (segs) {
        // the renamed cluster, plus any turn already labeled with a differently
        // cased spelling of the same name
        for (const seg of segs) {
          if (seg.cluster === cluster || sameName(seg.speaker, name))
            seg.speaker = name;
        }
        await fsp.writeFile(
          path.join(dir, "transcript.json"),
          JSON.stringify(segs, null, 1),
        );
        if (meta) {
          await fsp.writeFile(
            path.join(dir, "transcript.md"),
            buildTranscriptMd(meta.title, segs),
          );
          const order: string[] = [];
          for (const seg of segs)
            if (!order.includes(seg.speaker)) order.push(seg.speaker);
          meta.speakers = order;
          meta.attendees = order.length;
          await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
        }
      }
      return sanitizeSpeakers(list);
    },
  );

  ipcMain.handle("transcript:read", async (_e, id: string) => {
    try {
      return await fsp.readFile(
        path.join(loadSettings().recordingsDir, id, "transcript.md"),
        "utf8",
      );
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    "transcript:segments",
    async (_e, id: string): Promise<TranscriptSegment[]> => {
      const segs = await readJson<TranscriptSegment[]>(
        path.join(loadSettings().recordingsDir, id, "transcript.json"),
      );
      return segs ?? [];
    },
  );

  ipcMain.handle("claude:status", () =>
    claudeStatus(loadSettings().claudeBinary),
  );

  ipcMain.handle(
    "transcript:lint",
    async (_e, id: string): Promise<LintResult> => {
      const dir = path.join(loadSettings().recordingsDir, id);
      const res = await lintAndSave(dir);
      if (!res.error) await pruneAudio(dir).catch(() => false);
      return res;
    },
  );

  ipcMain.handle(
    "summary:get",
    (_e, id: string): Promise<MeetingSummary | null> =>
      readJson<MeetingSummary>(
        path.join(loadSettings().recordingsDir, id, "summary.json"),
      ),
  );

  ipcMain.handle(
    "summary:generate",
    async (_e, id: string): Promise<SummaryResult> => {
      const dir = path.join(loadSettings().recordingsDir, id);
      const res = await summarizeAndSave(dir);
      if (!res.error) await pruneAudio(dir).catch(() => false);
      return res;
    },
  );

  ipcMain.handle("transcribe:start", (_e, id: string, language?: string) =>
    runTranscription(id, language),
  );

  ipcMain.handle("models:downloaded", async (): Promise<string[]> => {
    try {
      const names = await fsp.readdir(modelsDir());
      const repos = names
        .map((n) => n.replace("__", "/"))
        .filter((repo) => isDownloaded(repo));
      return diarizeModelReady() ? [...repos, DIARIZE_MODEL] : repos;
    } catch {
      return [];
    }
  });

  ipcMain.handle("models:download", async (_e, repo: string) => {
    if (loadSettings().offlineMode) {
      send("models:progress", { repo, pct: 0, done: true, error: OFFLINE_ON });
      return 1;
    }
    return repo === DIARIZE_MODEL ? prepareDiarizeModel() : downloadModelRepo(repo);
  });
}
