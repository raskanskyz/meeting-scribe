import { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Settings } from '../shared/types'
import { ocrSidecar } from './sidecar'
import type { ScreenFrame } from './screenPrompt'

const run = promisify(execFile)

const MAX_FRAMES = 10
const MAX_WIDTH = 1280
// the whole extraction must end well before a long meeting would make it a burden
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000

export interface ScreenContext {
  /** temp directory holding the frame JPEGs - the only place Claude may read */
  dir: string
  frames: ScreenFrame[]
  cleanup: () => Promise<void>
}

interface RawFrame {
  t: number
  jpeg: string
}

/**
 * Runs inside a hidden window: plays the video fast and muted, and keeps a
 * downscaled JPEG whenever the picture differs enough from the last kept one
 * (scene-change detection on a 64x36 grayscale grid). Playing instead of
 * seeking because MediaRecorder webm has no duration or cue points to seek by.
 * ponytail: a change caught mid-animation can be a blurry frame; no settle wait.
 */
const EXTRACT_SCRIPT = (src: string, deadlineMs: number): string => `
new Promise((resolve) => {
  const MAX = ${MAX_FRAMES}, W = ${MAX_WIDTH}, GW = 64, GH = 36, THRESH = 10, MIN_GAP = 4;
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.defaultPlaybackRate = v.playbackRate = 16; v.src = ${JSON.stringify(src)};
  const grid = document.createElement('canvas'); grid.width = GW; grid.height = GH;
  const gctx = grid.getContext('2d', { willReadFrequently: true });
  const big = document.createElement('canvas');
  const kept = []; let ref = null, lastT = 0, done = false;
  const finish = () => {
    if (done) return; done = true; v.pause();
    resolve(kept.sort((a, b) => a.t - b.t).map(({ t, jpeg }) => ({ t, jpeg })));
  };
  const snap = (t, score) => {
    big.width = W; big.height = Math.round(W * (v.videoHeight / v.videoWidth)) || 720;
    big.getContext('2d').drawImage(v, 0, 0, big.width, big.height);
    kept.push({ t, score, jpeg: big.toDataURL('image/jpeg', 0.7).split(',')[1] });
    if (kept.length > MAX) { // drop the weakest change, never the opening frame
      let w = 1; for (let i = 2; i < kept.length; i++) if (kept[i].score < kept[w].score) w = i;
      kept.splice(w, 1);
    }
  };
  const onFrame = (_now, meta) => {
    if (done) return;
    gctx.drawImage(v, 0, 0, GW, GH);
    const px = gctx.getImageData(0, 0, GW, GH).data, g = new Uint8Array(GW * GH);
    for (let i = 0; i < g.length; i++) g[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    const t = meta.mediaTime;
    if (!ref) { snap(t, 255); ref = g; lastT = t; }
    else {
      let d = 0; for (let i = 0; i < g.length; i++) d += Math.abs(g[i] - ref[i]);
      d /= g.length;
      if (d > THRESH && t - lastT >= MIN_GAP) { snap(t, d); ref = g; lastT = t; }
    }
    v.requestVideoFrameCallback(onFrame);
  };
  v.addEventListener('ended', finish);
  v.addEventListener('error', finish);
  setTimeout(finish, ${deadlineMs});
  v.requestVideoFrameCallback(onFrame);
  v.play().catch(finish);
})`

async function extractFrames(webm: string): Promise<RawFrame[]> {
  // webSecurity off so the canvas is not tainted by the file:// video; the window
  // never loads anything but about:blank and the script above
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      webSecurity: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  try {
    await win.loadURL('about:blank')
    return (await win.webContents.executeJavaScript(
      EXTRACT_SCRIPT(pathToFileURL(webm).href, EXTRACT_TIMEOUT_MS)
    )) as RawFrame[]
  } finally {
    win.destroy()
  }
}

async function ocr(files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const { stdout } = await run(ocrSidecar(), files, { timeout: 120_000, maxBuffer: 16 << 20 })
    for (const r of JSON.parse(stdout) as { file: string; text: string }[]) out.set(r.file, r.text)
  } catch {
    /* no OCR binary or a Vision error: the screenshots still help on their own */
  }
  return out
}

/**
 * Screenshots plus OCR for one recording, or null when the feature is off,
 * blocked by offline mode, there is no screen.webm, or anything goes wrong -
 * callers then simply run transcript-only.
 */
export async function collectScreenContext(
  recDir: string,
  s: Settings
): Promise<ScreenContext | null> {
  if (!s.screenContext || s.offlineMode) return null
  const webm = path.join(recDir, 'screen.webm')
  if (!fs.existsSync(webm)) return null
  let dir: string | undefined
  try {
    dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'meeting-scribe-screen-')))
    const d = dir
    const raw = await extractFrames(webm)
    if (!raw.length) throw new Error('no frames')
    const files: string[] = []
    for (const [i, f] of raw.entries()) {
      const file = path.join(d, `frame-${String(i + 1).padStart(2, '0')}.jpg`)
      await fsp.writeFile(file, Buffer.from(f.jpeg, 'base64'))
      files.push(file)
    }
    const text = await ocr(files)
    return {
      dir: d,
      frames: raw.map((f, i) => ({ t: f.t, file: files[i], text: text.get(files[i]) ?? '' })),
      cleanup: () => fsp.rm(d, { recursive: true, force: true })
    }
  } catch {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    return null
  }
}
