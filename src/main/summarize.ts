import fs from 'node:fs'
import type { ActionItem, MeetingSummary, TranscriptSegment } from '../shared/types'
import type { Provider } from './providers'
import { sidecarAsset } from './sidecar'
import { fmtTs } from './transcript'
import type { ScreenContext } from './screenContext'
import { framesForRange, renderScreenContext } from './screenPrompt'

const GENERATE_TIMEOUT_MS = 5 * 60 * 1000
const MAX_TRANSCRIPT_CHARS = 300_000

/** the provider chosen in Settings, its resolved binary, and the model to ask for */
export interface Llm {
  provider: Provider
  bin: string
  model: string
}

export interface SummaryInput {
  title: string
  createdAt: string
  speakers: string[]
  segments: TranscriptSegment[]
  /** opt-in screenshots + OCR from the recording; absent means transcript-only */
  screen?: ScreenContext | null
}

function buildPrompt(input: SummaryInput, screen = ''): string {
  let transcript = input.segments
    .map((s) => `[${fmtTs(s.start)}] ${s.speaker}: ${s.text}`)
    .join('\n')
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const half = MAX_TRANSCRIPT_CHARS / 2
    transcript = `${transcript.slice(0, half)}\n[... middle of transcript truncated ...]\n${transcript.slice(-half)}`
  }
  return `You are analyzing a meeting transcript. Respond with ONLY a single JSON object - no markdown fences, no commentary - with exactly these keys:

{
  "executiveSummary": string,   // 3-6 sentences covering what the meeting was about and its outcome
  "actionItems": [{ "owner": string | null, "text": string }],
  "keyDecisions": [string],
  "openQuestions": [string]
}

Rules:
- Write all values in English, regardless of the transcript's language.
- Attribute an action item to a speaker name as "owner" only when clearly stated; otherwise use null.
- Use empty arrays for sections with no content. Never invent content.
- Transcription may contain recognition errors; read past them.

Meeting: ${input.title}
Date: ${input.createdAt}
Participants: ${input.speakers.join(', ') || 'unknown'}
${screen}
Transcript:
${transcript}`
}

/**
 * One model call that must return a JSON object. With screen context it tries
 * that first and, on ANY failure (timeout, bad reply, no image access), reruns
 * with the plain transcript-only prompt - screen context is never a way for
 * polish or summary to fail. A provider without image support gets the OCR text
 * only, so there is nothing to attach.
 */
async function llmJson(
  llm: Llm,
  plain: string,
  withScreen: { prompt: string; dir: string; files: string[] } | null,
  timeoutMs: number = GENERATE_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const attempt = async (
    prompt: string,
    images?: { dir: string; files: string[] }
  ): Promise<Record<string, unknown>> =>
    extractJson(llm.provider.name, await llm.provider.run(llm.bin, prompt, { model: llm.model, timeoutMs, images }))
  if (withScreen)
    try {
      return await attempt(
        withScreen.prompt,
        llm.provider.supportsImages ? { dir: withScreen.dir, files: withScreen.files } : undefined
      )
    } catch {
      /* fall back to transcript-only below */
    }
  return attempt(plain)
}

function extractJson(provider: string, text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(`${provider} did not return JSON`)
  return JSON.parse(text.slice(start, end + 1))
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []

const actionItems = (v: unknown): ActionItem[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        if (typeof x === 'string' && x.trim()) return [{ owner: null, text: x }]
        if (x && typeof x === 'object' && typeof (x as ActionItem).text === 'string')
          return [{ owner: (x as ActionItem).owner || null, text: (x as ActionItem).text }]
        return []
      })
    : []

// A lint batch costs roughly a second per 12 characters of segment text, because
// every corrected segment is rewritten in full on the way out: 2.2 KB of segments
// measured at ~190s. At the old 40 KB the batch could not finish inside the
// 5-minute cap, so long meetings timed out and the whole pass was discarded -
// which is why 42 of 59 local recordings had a summary but no polishedAt. Keep
// batches small enough to land well inside their own, longer, budget.
const LINT_CHUNK_CHARS = 4_000
const LINT_TIMEOUT_MS = 10 * 60 * 1000
const LINT_SCREEN_FRAMES = 3
const SUMMARY_SCREEN_FRAMES = 10

interface LexiconGroup {
  canonical: string
  variants?: string[]
  risky_variants?: { text: string; why?: string }[]
  normalize?: boolean
}

let glossaryCache: string | null = null

const renderGroup = (g: LexiconGroup): string[] => {
  const safe = (g.variants ?? []).filter(Boolean)
  const risky = (g.risky_variants ?? []).map((r) => r?.text).filter(Boolean)
  if (!g?.canonical || (!safe.length && !risky.length)) return []
  const parts = [safe.length ? `${g.canonical} <- ${safe.join(', ')}` : g.canonical]
  if (risky.length) parts.push(`ambiguous: ${risky.join(', ')}`)
  return [`- ${parts.join('  |  ')}`]
}

/**
 * Renders python/lexicon.json as a glossary block for the lint prompt.
 *
 * Whisper writes foreign technical terms phonetically in the transcript's own
 * script, so the lint can only repair them if it knows what they were meant to
 * be. The lexicon splits those into two kinds and the prompt treats them
 * differently, because they are not the same problem:
 *
 * - Named entities (NATS, kubectl, Configify) have exactly one correct written
 *   form and no Hebrew spelling, so substituting it restores what was said.
 * - Loanwords (stream, pod, staging) are ordinary English words spoken inside
 *   Hebrew sentences. Hebrew script is a legitimate transcription, so rewriting
 *   them is an editorial change masquerading as a correction - it mutates the
 *   record and, measured on one meeting, accounts for over half the edits.
 *
 * Ambiguous variants stay the model's judgement call: several collide with ordinary
 * Hebrew words (נס = miracle, הלם = shock) that a find/replace would corrupt.
 */
function glossary(): string {
  if (glossaryCache !== null) return glossaryCache
  glossaryCache = ''
  try {
    const raw = fs.readFileSync(sidecarAsset('lexicon.json'), 'utf8')
    const groups = (JSON.parse(raw)?.normalization?.groups ?? []) as LexiconGroup[]
    const named = groups.filter((g) => g?.normalize).flatMap(renderGroup)
    const loanwords = groups.filter((g) => g?.canonical && !g.normalize).flatMap(renderGroup)
    const sections: string[] = []
    if (named.length)
      sections.push(`Names in this workspace - the one correct spelling, followed by renderings ASR has actually produced for it. These are product names, services, commands and acronyms: they have no spelling in the speaker's own script, so replace the rendering with the canonical spelling and use it consistently.
Entries marked "ambiguous" are also ordinary words in the speaker's language. Substitute those ONLY when the technical sense is unmistakable from context; otherwise leave the segment alone.

${named.join('\n')}`)
    if (loanwords.length)
      sections.push(`Loanwords - ordinary English words the speakers use inside sentences in their own language. The renderings below are CORRECT transcriptions and must be left as written. Do NOT convert them to Latin script and do NOT treat a change of script as a correction. You may still repair a rendering that is genuinely mangled, staying in the script the speaker was transcribed in.

${loanwords.join('\n')}`)
    if (sections.length) glossaryCache = `\n${sections.join('\n\n')}\n`
  } catch {
    /* no lexicon shipped, or malformed - lint still runs, just without domain hints */
  }
  return glossaryCache
}

const LINT_PROMPT = `You are proofreading a meeting transcript produced by automatic speech recognition (Whisper). Fix ONLY recognition errors:
- misheard or mangled words
- technical terms, acronyms, product and people names rendered wrong or phonetically (e.g. Hebrew "איי-קיו-ג'י" for the acronym "AQG", "ake u g" / "AQGE" for "AQG")
- inconsistent spellings of the same name across segments - normalize every variant to the single most likely intended form

Preserve the speaker's language, wording, intent and colloquial style. Do NOT paraphrase, translate, summarize, or clean up grammar and filler words. When unsure, leave the segment unchanged.

Changing which script a word is written in is NOT a recognition error on its own. A foreign word the speaker genuinely used, transcribed phonetically into their own script, is transcribed correctly - leave it. Only the names listed below get substituted.

The transcript is given as numbered segments. Respond with ONLY a JSON object, no markdown fences:
{"corrections": [{"i": <segment number>, "text": "<full corrected segment text>"}]}
Include ONLY segments whose text you changed. Each correction must contain the COMPLETE segment text - fix the wrong words in place and never drop or shorten the parts you didn't change.

Segments:
`

export async function lintTranscript(
  llm: Llm,
  segs: TranscriptSegment[],
  screen?: ScreenContext | null
): Promise<{
  segments: TranscriptSegment[]
  changed: number
  failedBatches: number
  totalBatches: number
}> {
  const out = segs.map((s) => ({ ...s }))
  const batches: number[][] = []
  let batch: number[] = []
  let size = 0
  for (let i = 0; i < segs.length; i++) {
    const len = segs[i].text.length + 12
    if (size + len > LINT_CHUNK_CHARS && batch.length) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(i)
    size += len
  }
  if (batch.length) batches.push(batch)

  const prompt = LINT_PROMPT.replace('\nSegments:\n', `${glossary()}\nSegments:\n`)

  let changed = 0
  // one flaky batch used to throw straight out of here, so a single malformed
  // model reply discarded the corrections from every other batch and left
  // polishedAt unset. Isolate each batch and keep whatever succeeds.
  const failures: string[] = []
  for (const b of batches) {
    try {
      const numbered = b.map((i) => `${i}: ${segs[i].text}`).join('\n')
      // only the screenshots from around this batch's slice of the meeting
      const shown = screen
        ? framesForRange(screen.frames, segs[b[0]].start, segs[b[b.length - 1]].end, LINT_SCREEN_FRAMES)
        : []
      const block = renderScreenContext(
        shown,
        'Use it ONLY to decide how a misheard name, term or acronym was really spelled. It never justifies adding words that were not spoken.',
        llm.provider.imageHint
      )
      const parsed = await llmJson(
        llm,
        prompt + numbered,
        screen && block
          ? {
              prompt: prompt.replace('\nSegments:\n', `${block}\nSegments:\n`) + numbered,
              dir: screen.dir,
              files: shown.map((f) => f.file)
            }
          : null,
        LINT_TIMEOUT_MS
      )
      const corrections = Array.isArray(parsed.corrections) ? parsed.corrections : []
      for (const c of corrections) {
        const i = Number((c as { i?: unknown })?.i)
        const text = (c as { text?: unknown })?.text
        if (
          Number.isInteger(i) &&
          i >= 0 &&
          i < out.length &&
          typeof text === 'string' &&
          text.trim() &&
          text !== out[i].text
        ) {
          out[i].text = text
          changed++
        }
      }
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e))
    }
  }
  // total failure is a real error; a partial one is worth reporting but not losing
  if (failures.length === batches.length && batches.length > 0)
    throw new Error(
      `lint failed on all ${batches.length} batch(es): ${failures[0]}`
    )
  return {
    segments: out,
    changed,
    failedBatches: failures.length,
    totalBatches: batches.length
  }
}

export async function generateSummary(llm: Llm, input: SummaryInput): Promise<MeetingSummary> {
  const shown = input.screen?.frames.slice(0, SUMMARY_SCREEN_FRAMES) ?? []
  const block = input.screen
    ? renderScreenContext(
        shown,
        'Use it ONLY as supporting context for what the meeting covered (names, documents, tools, figures on screen). The summary must still be grounded in what was said.',
        llm.provider.imageHint
      )
    : ''
  const parsed = await llmJson(
    llm,
    buildPrompt(input),
    input.screen && block
      ? { prompt: buildPrompt(input, block), dir: input.screen.dir, files: shown.map((f) => f.file) }
      : null
  )
  return {
    executiveSummary: typeof parsed.executiveSummary === 'string' ? parsed.executiveSummary : '',
    actionItems: actionItems(parsed.actionItems),
    keyDecisions: strArr(parsed.keyDecisions),
    openQuestions: strArr(parsed.openQuestions),
    model: llm.model || 'default model',
    provider: llm.provider.name,
    generatedAt: new Date().toISOString()
  }
}
