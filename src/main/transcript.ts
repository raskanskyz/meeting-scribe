import type { TranscriptSegment } from '../shared/types'

export type { TranscriptSegment }

export interface SpeakerRecord {
  cluster: string
  name: string
  matched: boolean
  embedding: number[]
}

export function fmtTs(sec: number): string {
  const s = Math.floor(sec)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

// mirrors the markdown the python sidecar writes, so renames don't need a re-transcribe
export function buildTranscriptMd(title: string, segs: TranscriptSegment[]): string {
  const single = new Set(segs.map((s) => s.speaker)).size <= 1
  const lines = [`# ${title}`, '']
  for (const seg of segs) {
    const prefix = single ? '' : `**${seg.speaker}** `
    lines.push(`- ${prefix}\`[${fmtTs(seg.start)}]\` ${seg.text}`)
  }
  return lines.join('\n') + '\n'
}
