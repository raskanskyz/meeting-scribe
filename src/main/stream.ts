import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pythonSidecarEnv } from './sidecarEnv'
import { uvPath, sidecarScript } from './sidecar'
import type { LiveSegment, TrackName } from '../shared/types'

const TRACK_BYTE: Record<TrackName, number> = { mic: 0x30, system: 0x31 }

/**
 * A long-lived MLX streaming-transcription sidecar (python/stream.py) for one
 * recording. PCM frames are fed per track; committed utterance segments come
 * back over stdout and are both surfaced live and accumulated for the finalize
 * pass at stop.
 */
export class StreamSession {
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  private stderr = ''
  private ready: Promise<void>
  readonly segments: LiveSegment[] = []

  constructor(
    modelDir: string,
    language: string,
    onSegment: (s: LiveSegment) => void,
    onError: (message: string) => void,
    extraEnv: Record<string, string> = {}
  ) {
    this.child = spawn(
      uvPath(),
      ['run', '--quiet', sidecarScript('stream.py'), '--model-dir', modelDir, '--language', language],
      { stdio: ['pipe', 'pipe', 'pipe'], env: pythonSidecarEnv(extraEnv) }
    )

    let markReady: () => void = () => {}
    this.ready = new Promise((r) => (markReady = r))

    this.child.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8')
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'ready') markReady()
          else if (ev.type === 'segment') {
            const s: LiveSegment = {
              track: ev.track, speaker: ev.speaker, start: ev.start, end: ev.end, text: ev.text
            }
            this.segments.push(s)
            onSegment(s)
          } else if (ev.type === 'error') onError(ev.message)
        } catch {
          /* non-JSON line: ignore */
        }
      }
    })

    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000)
    })
    this.child.on('error', (e) => onError(String(e)))
  }

  waitReady(): Promise<void> {
    return this.ready
  }

  /** Feed one PCM frame (16 kHz mono int16, little-endian) for a track. */
  feed(track: TrackName, pcm: ArrayBuffer): void {
    const stdin = this.child.stdin
    if (!stdin.writable) return
    const header = Buffer.alloc(5)
    header[0] = TRACK_BYTE[track]
    header.writeUInt32BE(pcm.byteLength, 1)
    stdin.write(header)
    stdin.write(Buffer.from(pcm))
  }

  /** Flush both tracks, close stdin, wait for exit, return all segments. */
  async end(): Promise<LiveSegment[]> {
    const stdin = this.child.stdin
    if (stdin.writable) {
      for (const t of ['mic', 'system'] as TrackName[]) {
        const h = Buffer.alloc(5)
        h[0] = TRACK_BYTE[t]
        h.writeUInt32BE(0, 1)
        stdin.write(h)
      }
      stdin.end()
    }
    await new Promise<void>((res) => this.child.on('close', () => res()))
    return this.segments
  }

  kill(): void {
    this.child.kill('SIGTERM')
  }
}
