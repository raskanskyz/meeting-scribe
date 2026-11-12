import { execFile } from 'node:child_process'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AudioSetupStatus, Settings, SystemCaptureMode } from '../shared/types'

// mirrors calendar.ts resolution: dev reads from the project tree, packaged
// reads the binary copied into Resources by electron-builder's extraResources
function binPath(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return app.isPackaged
    ? path.join(base, 'audiosetup-sidecar')
    : path.join(base, 'swift', 'audiosetup-sidecar')
}

/** Direct system-audio tap (ScreenCaptureKit/CATap) needs macOS 14.2+. */
export function loopbackSupported(): boolean {
  const [major, minor] = process.getSystemVersion().split('.').map(Number)
  return major > 14 || (major === 14 && minor >= 2)
}

/** The capture route in effect: what the user asked for, narrowed by what this
 *  Mac can actually do. 'auto' prefers the tap and falls back to BlackHole. */
export function captureMode(s: Settings): SystemCaptureMode {
  if (s.systemCapture === 'blackhole') return 'blackhole'
  if (s.systemCapture === 'loopback') return 'loopback'
  return loopbackSupported() ? 'loopback' : 'blackhole'
}

function run(args: string[], mode: SystemCaptureMode): Promise<AudioSetupStatus> {
  const base = { loopbackSupported: loopbackSupported(), mode }
  return new Promise((resolve) => {
    const bin = binPath()
    if (!fs.existsSync(bin)) {
      resolve({
        ...base,
        blackhole: false,
        device: false,
        deviceName: 'Meeting Scribe',
        error: 'Audio helper not built - run `npm run build:audio`.'
      })
      return
    }
    execFile(bin, args, { timeout: 15000 }, (err, stdout) => {
      try {
        resolve({ ...base, ...JSON.parse(stdout) })
      } catch {
        resolve({
          ...base,
          blackhole: false,
          device: false,
          deviceName: 'Meeting Scribe',
          error: err?.message ?? 'unreadable audio helper output'
        })
      }
    })
  })
}

export const audioStatus = (s: Settings): Promise<AudioSetupStatus> =>
  run(['status', '--name', s.outputDevice || 'Meeting Scribe'], captureMode(s))

/**
 * Create the Multi-Output Device (BlackHole + the current speakers) if it
 * doesn't exist. `rebuild` re-points an existing device at whatever the
 * default output is now - for when the user switched speakers.
 */
export const audioEnsure = (s: Settings, rebuild = false): Promise<AudioSetupStatus> => {
  const name = s.outputDevice || 'Meeting Scribe'
  return run(rebuild ? ['ensure', '--name', name, '--rebuild'] : ['ensure', '--name', name], captureMode(s))
}
