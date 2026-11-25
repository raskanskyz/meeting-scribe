import type { MeetingSummary, TranscriptSegment } from '../shared/types'

export type { TranscriptSegment }

export interface SpeakerRecord {
  cluster: string
  name: string
  matched: boolean
  embedding: number[]
}

/** the recording facts the transcript header shows; RecordingMeta fits */
export interface TranscriptHeader {
  title: string
  createdAt?: string
  durationSec?: number
  /** calendar attendees, when the recording came from an event */
  invitees?: string[]
}

export function fmtTs(sec: number): string {
  const s = Math.floor(sec)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

/** YYYY-MM-DD HH:MM in local time; fixed so the python writer can match it */
export function fmtDate(iso: string): string | null {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Collapse consecutive segments from the same speaker into one turn. */
export function speakerTurns(segs: TranscriptSegment[]) {
  const turns: { speaker: string; start: number; text: string }[] = []
  for (const seg of segs) {
    const text = seg.text.trim()
    if (!text) continue
    const last = turns[turns.length - 1]
    if (last && last.speaker === seg.speaker) last.text += ' ' + text
    else turns.push({ speaker: seg.speaker, start: seg.start, text })
  }
  return turns
}

function summaryLines(summary: MeetingSummary): string[] {
  const lines = ['## Summary', '', summary.executiveSummary.trim(), '']
  const list = (heading: string, items: string[]) => {
    if (!items.length) return
    lines.push(`### ${heading}`, '', ...items.map((i) => `- ${i}`), '')
  }
  list(
    'Action items',
    summary.actionItems.map((a) => `${a.owner ? `${a.owner}: ` : ''}${a.text}`),
  )
  list('Key decisions', summary.keyDecisions)
  list('Open questions', summary.openQuestions)
  return lines
}

/**
 * The transcript as Markdown: header facts, then one paragraph per speaker
 * turn with its start time. transcript.md on disk is this without a summary;
 * Copy adds the summary. python/transcribe.py writes the same format, so keep
 * write_transcript_md there in step with this.
 */
export function buildTranscriptMd(
  header: TranscriptHeader,
  segs: TranscriptSegment[],
  summary?: MeetingSummary | null,
): string {
  const speakers = [...new Set(segs.map((s) => s.speaker))]
  const single = speakers.length <= 1
  const lines = [`# ${header.title || 'Meeting'}`, '']

  const date = header.createdAt ? fmtDate(header.createdAt) : null
  if (date) lines.push(`- **Date:** ${date}`)
  if (header.durationSec && header.durationSec > 0)
    lines.push(`- **Duration:** ${fmtTs(header.durationSec)}`)
  if (speakers.length) lines.push(`- **Speakers:** ${speakers.join(', ')}`)
  if (header.invitees?.length)
    lines.push(`- **Invited:** ${header.invitees.join(', ')}`)
  lines.push(
    '',
    '_Speaker labels are automatic and may be wrong. Timestamps are from the start of the recording._',
    '',
  )

  if (summary) lines.push(...summaryLines(summary))

  lines.push('## Transcript', '')
  for (const turn of speakerTurns(segs)) {
    const who = single ? '' : `**${turn.speaker}** `
    lines.push(`${who}[${fmtTs(turn.start)}] ${turn.text}`, '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
