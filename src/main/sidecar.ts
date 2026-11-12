import { spawn } from 'node:child_process'
import { app } from 'electron'
import { pythonSidecarEnv } from './sidecarEnv'
import fs from 'node:fs'
import path from 'node:path'

// Finder-launched apps get a minimal PATH, so resolve uv explicitly
export function uvPath(): string {
  const candidates = [
    path.join(app.getPath('home'), '.local/bin/uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv'
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? 'uv'
}

/** Absolute path to a file shipped in python/, packaged or in-repo. */
export function sidecarAsset(name: string): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return path.join(base, 'python', name)
}

/** The Nemotron diarization binary, packaged or built in-repo (npm run build:diarize). */
export function diarizeSidecar(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'diarize-sidecar')
    : path.join(app.getAppPath(), 'swift', 'diarize-sidecar')
}

/** The Vision OCR binary, packaged or built in-repo (npm run build:ocr). */
export function ocrSidecar(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ocr-sidecar')
    : path.join(app.getAppPath(), 'swift', 'ocr-sidecar')
}

/** Absolute path to a python sidecar script, packaged or in-repo. */
export function sidecarScript(name: string): string {
  return sidecarAsset(name)
}

export interface SidecarEvent {
  [key: string]: unknown
  type: string
}

/**
 * Runs python/transcribe.py via `uv run` and emits each JSON line on stdout.
 * Returns exit code; rejects only on spawn failure (uv missing).
 */
export function runSidecar(
  args: string[],
  onEvent: (ev: SidecarEvent) => void,
  extraEnv: Record<string, string> = {},
  scriptName = 'transcribe.py'
): { promise: Promise<number>; cancel: () => void } {
  const script = sidecarScript(scriptName)
  const child = spawn(uvPath(), ['run', '--quiet', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: pythonSidecarEnv({ DIARIZE_SIDECAR: diarizeSidecar(), ...extraEnv })
  })

  let buf = ''
  let sawError = false
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev.type === 'error') sawError = true
        onEvent(ev)
      } catch {
        onEvent({ type: 'log', message: line })
      }
    }
  })

  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-4000)
  })

  const promise = new Promise<number>((resolve, reject) => {
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      // the sidecar reports its own errors as JSON; only fall back to stderr
      // when it died without one, so the useful message isn't clobbered
      if (code !== 0 && !sawError) onEvent({ type: 'error', message: stderr.trim() || `exit ${code}` })
      resolve(code ?? 1)
    })
  })

  return { promise, cancel: () => child.kill('SIGTERM') }
}
