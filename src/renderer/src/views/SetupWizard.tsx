import DownloadError from "../components/DownloadError";
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import {
  CURATED_MODELS,
  DIARIZE_MODEL,
  type AudioSetupStatus,
  type CalendarResult,
  type ClaudeStatus,
  type DownloadProgress,
  type HfValidation,
  type Settings
} from '../../../shared/types'

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
}

const STEPS = ['Welcome', 'Language', 'Meeting audio', 'Speakers', 'Summaries', 'Calendar', 'Done'] as const

const HEBREW_MODEL = 'mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx'
const ENGLISH_MODEL = 'mlx-community/whisper-large-v3-turbo'
const BREW_CMD = 'brew install blackhole-2ch && sudo killall coreaudiod'

function ChoiceCard({
  title,
  detail,
  active,
  onPick
}: {
  title: string
  detail: string
  active: boolean
  onPick: () => void
}) {
  return (
    <button className={active ? 'wiz-choice active' : 'wiz-choice'} onClick={onPick}>
      <span className="wiz-choice-title">{title}</span>
      <span className="wiz-choice-detail">{detail}</span>
    </button>
  )
}

export default function SetupWizard({ settings, onChange }: Props) {
  const [step, setStep] = useState(0)
  const patch = useCallback(
    async (p: Partial<Settings>) => onChange(await api.setSettings(p)),
    [onChange]
  )

  // ── language & model ──
  const [downloaded, setDownloaded] = useState<string[]>([])
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const refreshModels = () => api.downloadedModels().then(setDownloaded)
  useEffect(() => {
    refreshModels()
  }, [])
  useEffect(
    () =>
      api.onModelProgress((p) => {
        if (p.repo !== settings.activeModel) return
        setProgress(p)
        if (p.done && !p.error) refreshModels()
      }),
    [settings.activeModel]
  )

  const model = CURATED_MODELS.find((m) => m.repo === settings.activeModel)
  const modelReady = downloaded.includes(settings.activeModel)
  const downloading = progress && !progress.done

  const pickLanguage = (language: string, activeModel: string) => {
    setProgress(null)
    patch({ language, activeModel })
  }

  // ── audio routing ──
  const [audio, setAudio] = useState<AudioSetupStatus | null>(null)
  const [audioBusy, setAudioBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tapProbe, setTapProbe] = useState<'idle' | 'busy' | 'ok' | 'denied'>('idle')
  const checkAudio = useCallback(async (ensure: boolean, rebuild = false) => {
    setAudioBusy(true)
    const status = await api.audioStatus()
    // one click saved: creating the device is safe and idempotent, so any
    // check that finds BlackHole but no healthy device just fixes it
    const broken = !status.device || status.deviceHasBlackhole === false
    const needsDevice = status.mode === 'blackhole' && status.blackhole && (broken || rebuild)
    setAudio(ensure && needsDevice ? await api.audioEnsure(rebuild) : status)
    setAudioBusy(false)
  }, [])
  useEffect(() => {
    if (STEPS[step] === 'Meeting audio') void checkAudio(true)
  }, [step, checkAudio])

  // trigger the macOS system-audio consent prompt now, so the first real
  // recording isn't the thing that has to ask
  const grantTap = async () => {
    setTapProbe('busy')
    try {
      // video: false keeps this out of the screen-recording permission class
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })
      // a track is handed over even when the tap is denied - it's just born
      // 'ended', so presence proves nothing and liveness is the real signal
      const granted = stream.getAudioTracks()[0]?.readyState === 'live'
      stream.getTracks().forEach((t) => t.stop())
      setTapProbe(granted ? 'ok' : 'denied')
    } catch {
      // AbortError here usually means the consent dialog is still up - the
      // recorder retries, so treat it as "not confirmed yet", not a hard fail
      setTapProbe('denied')
    }
    void checkAudio(false)
  }
  const loopback = audio?.mode === 'loopback'

  const copyBrew = () => {
    api.copyText(BREW_CMD)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // ── diarization ──
  const [diarProgress, setDiarProgress] = useState<DownloadProgress | null>(null)
  useEffect(
    () =>
      api.onModelProgress((p) => {
        if (p.repo !== DIARIZE_MODEL) return
        setDiarProgress(p)
        if (p.done && !p.error) refreshModels()
      }),
    []
  )
  const diarReady = downloaded.includes(DIARIZE_MODEL)
  const diarDownloading = diarProgress && !diarProgress.done
  const [token, setToken] = useState(settings.hfToken)
  const [hf, setHf] = useState<HfValidation | null>(null)
  const [validating, setValidating] = useState(false)
  const validate = async () => {
    const t = token.trim()
    if (!t) return
    setValidating(true)
    await patch({ hfToken: t })
    setHf(await api.validateHfToken(t))
    setValidating(false)
  }

  // ── summaries ──
  const [claude, setClaude] = useState<ClaudeStatus | null>(null)
  useEffect(() => {
    if (STEPS[step] === 'Summaries') api.claudeStatus().then(setClaude)
  }, [step])

  // ── calendar ──
  const [cal, setCal] = useState<CalendarResult | null>(null)
  const [calBusy, setCalBusy] = useState(false)
  const connectCalendar = async () => {
    setCalBusy(true)
    setCal(await api.upcomingMeetings(24))
    setCalBusy(false)
  }

  const finish = () => patch({ onboardedAt: new Date().toISOString() })

  const name = STEPS[step]
  const last = step === STEPS.length - 1

  return (
    <div className="wizard">
      <div className="wizard-frame">
        <header className="wizard-head">
          <div className="wizard-dots">
            {STEPS.map((s, i) => (
              <span key={s} className={i === step ? 'dot active' : i < step ? 'dot done' : 'dot'} />
            ))}
          </div>
          {!last && (
            <button className="link" onClick={finish}>
              Skip setup
            </button>
          )}
        </header>

        {name === 'Welcome' && (
          <section>
            <span className="eyebrow">First-time setup</span>
            <h2>Welcome to Meeting Scribe</h2>
            <p className="wiz-lead">
              Records your meetings in two tracks - your mic, and everyone else via system audio -
              then transcribes, names the speakers and summarizes. Everything runs on this Mac;
              recordings and transcripts never leave it.
            </p>
            <p className="hint">
              This takes about two minutes and gets everything working: transcription model, meeting
              audio capture, speaker recognition, summaries and your calendar. You can re-run it any
              time from Settings.
            </p>
          </section>
        )}

        {name === 'Language' && (
          <section>
            <span className="eyebrow">Step 1</span>
            <h2>What language are your meetings in?</h2>
            <p className="hint">Picks the transcription model. You can mix - per-language overrides live in Settings.</p>
            <div className="wiz-choices">
              <ChoiceCard
                title="Hebrew (עברית)"
                detail="ivrit.ai fine-tune - the best Hebrew model there is, live transcription on the Apple GPU"
                active={settings.language === 'he'}
                onPick={() => pickLanguage('he', HEBREW_MODEL)}
              />
              <ChoiceCard
                title="English"
                detail="Whisper large-v3-turbo - live transcription on the Apple GPU"
                active={settings.language === 'en'}
                onPick={() => pickLanguage('en', ENGLISH_MODEL)}
              />
              <ChoiceCard
                title="Mixed / other"
                detail="Auto-detect per recording using the multilingual model"
                active={settings.language === 'auto'}
                onPick={() => pickLanguage('auto', ENGLISH_MODEL)}
              />
            </div>
            <div className="card" style={{ marginTop: 16 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div className="rec-title">
                    {model?.label ?? settings.activeModel}{' '}
                    {modelReady && <span className="badge ok">downloaded</span>}
                  </div>
                  <div className="rec-meta">~{model?.sizeGb ?? '?'} GB - one-time download, then it runs offline</div>
                </div>
                {!modelReady && !downloading && (
                  <button
                    className="primary"
                    onClick={() => {
                      setProgress({ repo: settings.activeModel, pct: 0, done: false })
                      api.downloadModel(settings.activeModel)
                    }}
                  >
                    Download
                  </button>
                )}
              </div>
              {downloading && (
                <div style={{ marginTop: 10 }}>
                  <div className="rec-meta" style={{ marginBottom: 6 }}>
                    Downloading - {progress.pct}% (you can keep going, it continues in the background)
                  </div>
                  <div className="progress">
                    <div style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
              )}
              {progress?.error && <DownloadError error={progress.error} details={progress.errorDetails} />}
            </div>
          </section>
        )}

        {name === 'Meeting audio' && (
          <section>
            <span className="eyebrow">Step 2</span>
            <h2>Hearing the other side</h2>
            {!audio && <p className="hint">Checking your audio setup…</p>}

            {loopback && (
              <>
                <p className="hint">
                  Meeting Scribe records the other side straight from your Mac's audio - no driver,
                  no audio plumbing. macOS asks for permission once. Your sound keeps playing
                  normally while recording, and your volume keys keep working.
                </p>
                <div className="card">
                  {tapProbe === 'ok' ? (
                    <p className="hint">
                      <span className="badge ok">ready</span> System audio recording is allowed -
                      nothing else to set up.
                    </p>
                  ) : (
                    <>
                      <div className="rec-title">Allow system audio recording</div>
                      <p className="hint" style={{ margin: '8px 0' }}>
                        macOS will ask once. If you don't see a prompt, approve Meeting Scribe under
                        System Settings → Privacy &amp; Security → Screen &amp; System Audio
                        Recording.
                      </p>
                      <button className="primary" disabled={tapProbe === 'busy'} onClick={grantTap}>
                        {tapProbe === 'busy' ? 'Asking macOS…' : 'Grant permission'}
                      </button>
                      {tapProbe === 'denied' && (
                        <div className="warn-banner" style={{ marginTop: 10 }}>
                          Not allowed yet. If you saw a prompt, approve it and click again -
                          otherwise switch it on manually:{' '}
                          <button className="link" onClick={() => api.openScreenRecordingPrivacy()}>
                            open privacy settings
                          </button>
                          . Recording still works mic-only until this is granted.
                        </div>
                      )}
                    </>
                  )}
                  {(audio?.outputMuted || audio?.outputVolume === 0) && (
                    <div className="warn-banner" style={{ marginTop: 10 }}>
                      Heads up: your output is muted right now. Meeting audio is captured from what's
                      actually played, so unmute before recording.
                    </div>
                  )}
                </div>
              </>
            )}

            {audio && !loopback && (
              <p className="hint">
                This Mac is on macOS {audio.loopbackSupported ? '' : '13 or older, which '}
                {audio.loopbackSupported
                  ? "and you've chosen the BlackHole route in Settings."
                  : "can't tap system audio directly."}{' '}
                Meeting Scribe uses BlackHole - a virtual speaker - plus a Multi-Output Device that
                plays sound to your speakers and BlackHole at once. The app switches to it only while
                recording and switches back after.
              </p>
            )}
            {audio && !loopback && !audio.blackhole && (
              <div className="card">
                <div className="rec-title">BlackHole isn't installed</div>
                <p className="hint" style={{ margin: '8px 0' }}>
                  One-time install (asks for your password - it's an audio driver). If you installed
                  the app with <code>setup.sh</code> this was done for you.
                </p>
                <div className="row">
                  <code className="wiz-cmd">{BREW_CMD}</code>
                  <button className="ghost" onClick={copyBrew}>
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="primary" disabled={audioBusy} onClick={() => checkAudio(true)}>
                    I've run it - check again
                  </button>
                </div>
              </div>
            )}
            {audio && !loopback && audio.blackhole && (
              <div className="card">
                {audio.device && audio.deviceHasBlackhole !== false ? (
                  <>
                    <div className="rec-title">
                      <span className="badge ok">ready</span> "{audio.deviceName}" device is set up
                    </div>
                    <p className="hint" style={{ marginTop: 8 }}>
                      {audio.created
                        ? `Created it for you, paired with ${audio.pairedWith ?? 'your speakers'}. `
                        : 'Found an existing healthy device - left it untouched. '}
                      If you later switch speakers or headphones, rebuild it here or from Settings.
                    </p>
                    <button className="ghost" disabled={audioBusy} onClick={() => checkAudio(true, true)}>
                      Rebuild for current speakers
                    </button>
                  </>
                ) : (
                  <>
                    <div className="rec-title">BlackHole found - creating the device…</div>
                    {audio.error && <div className="warn-banner" style={{ marginTop: 8 }}>{audio.error}</div>}
                    <button className="primary" disabled={audioBusy} onClick={() => checkAudio(true)}>
                      Try again
                    </button>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {name === 'Speakers' && (
          <section>
            <span className="eyebrow">Step 3</span>
            <h2>Who said what</h2>
            <p className="hint">
              Speaker identification splits the meeting into voices. Rename a voice once and it's
              recognized in every future meeting. Runs fully locally - the token below is only used
              to download the model the first time.
            </p>
            <div className="wiz-choices">
              <ChoiceCard
                title="Identify speakers"
                detail="Needs a free Hugging Face token (one minute, below)"
                active={settings.diarize}
                onPick={() => patch({ diarize: true })}
              />
              <ChoiceCard
                title="Skip for now"
                detail="Transcripts label turns as mic / meeting only. Enable later in Settings."
                active={!settings.diarize}
                onPick={() => patch({ diarize: false })}
              />
            </div>
            {settings.diarize && (
              <div className="card" style={{ marginTop: 16 }}>
                <ol className="wiz-steps">
                  <li>
                    <button className="link" onClick={() => api.openExternal('https://huggingface.co/pyannote/speaker-diarization-community-1')}>
                      Accept the model terms
                    </button>{' '}
                    (free account, instant approval)
                  </li>
                  <li>
                    <button className="link" onClick={() => api.openExternal('https://huggingface.co/settings/tokens/new?tokenType=read')}>
                      Create a Read token
                    </button>{' '}
                    and paste it here:
                  </li>
                </ol>
                <div className="row" style={{ marginTop: 8 }}>
                  <input
                    type="password"
                    placeholder="hf_..."
                    value={token}
                    style={{ flex: 1, maxWidth: 360 }}
                    onChange={(e) => {
                      setToken(e.target.value)
                      setHf(null)
                    }}
                  />
                  <button className="primary" disabled={!token.trim() || validating} onClick={validate}>
                    {validating ? 'Checking…' : 'Validate'}
                  </button>
                </div>
                {hf?.ok && (
                  <p className="hint" style={{ marginTop: 8 }}>
                    <span className="badge ok">valid</span> Signed in as {hf.user} with access to the
                    model - you're set.
                  </p>
                )}
                {hf && !hf.ok && <div className="warn-banner" style={{ marginTop: 8 }}>{hf.message}</div>}
              </div>
            )}
            {settings.diarize && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <div className="rec-title">
                      Speaker model (NVIDIA Nemotron) {diarReady && <span className="badge ok">downloaded</span>}
                    </div>
                    <div className="rec-meta">~200 MB, one-time download, then it runs offline</div>
                  </div>
                  {!diarReady && !diarDownloading && (
                    <button
                      className="primary"
                      onClick={() => {
                        setDiarProgress({ repo: DIARIZE_MODEL, pct: 0, done: false })
                        api.downloadModel(DIARIZE_MODEL)
                      }}
                    >
                      Download
                    </button>
                  )}
                </div>
                {diarDownloading && (
                  <div style={{ marginTop: 10 }}>
                    <div className="rec-meta" style={{ marginBottom: 6 }}>
                      Downloading - {diarProgress.pct}% (you can keep going, it continues in the background)
                    </div>
                    <div className="progress">
                      <div style={{ width: `${diarProgress.pct}%` }} />
                    </div>
                  </div>
                )}
                {diarProgress?.error && <DownloadError error={diarProgress.error} details={diarProgress.errorDetails} />}
              </div>
            )}
          </section>
        )}

        {name === 'Summaries' && (
          <section>
            <span className="eyebrow">Step 4</span>
            <h2>After the meeting</h2>
            <p className="hint">
              Meeting Scribe can polish the transcript and write a summary (decisions, action items,
              open questions) using the Claude Code CLI and your existing Claude subscription - the
              transcript goes to Claude and nowhere else. Or stay fully offline.
            </p>
            <div className="wiz-choices">
              <ChoiceCard
                title="Polish + summarize"
                detail="Automatic transcript cleanup and a structured summary after every meeting"
                active={!settings.offlineMode}
                onPick={() => patch({ offlineMode: false, lintTranscripts: true, autoSummarize: true })}
              />
              <ChoiceCard
                title="Fully offline"
                detail="Never touch the network. No summaries - transcription and speakers still work."
                active={settings.offlineMode}
                onPick={() => patch({ offlineMode: true })}
              />
            </div>
            {!settings.offlineMode && (
              <div className="card" style={{ marginTop: 16 }}>
                {claude?.available ? (
                  <p className="hint">
                    <span className="badge ok">found</span> Claude Code at <code>{claude.path}</code>
                  </p>
                ) : (
                  <div className="warn-banner">
                    Claude Code CLI not found - summaries will stay disabled until it's installed.{' '}
                    <button className="link" onClick={() => api.openExternal('https://claude.com/claude-code')}>
                      Install it
                    </button>
                    , sign in once, and this picks it up automatically.
                  </div>
                )}
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Summary model</label>
                  <select
                    value={settings.summaryModel}
                    style={{ maxWidth: 220 }}
                    onChange={(e) => patch({ summaryModel: e.target.value })}
                  >
                    <option value="sonnet">Sonnet - recommended</option>
                    <option value="opus">Opus - deepest, slower</option>
                    <option value="haiku">Haiku - fastest</option>
                  </select>
                </div>
              </div>
            )}
          </section>
        )}

        {name === 'Calendar' && (
          <section>
            <span className="eyebrow">Step 5</span>
            <h2>Your meetings, one click away</h2>
            <p className="hint">
              Meeting Scribe reads the calendars already on this Mac (Apple Calendar - iCloud, Google,
              Exchange accounts all appear there), shows upcoming meetings with video links, and
              prefills the title and attendees when you record. Read-only, no OAuth, nothing leaves
              the machine. If your Google calendar isn't in Apple Calendar yet, add it under System
              Settings → Internet Accounts.
            </p>
            <div className="card">
              {!cal && (
                <button className="primary" disabled={calBusy} onClick={connectCalendar}>
                  {calBusy ? 'Asking macOS…' : 'Connect calendar'}
                </button>
              )}
              {cal?.status === 'ok' && (
                <p className="hint">
                  <span className="badge ok">connected</span>{' '}
                  {cal.events.length
                    ? `${cal.events.length} meeting${cal.events.length === 1 ? '' : 's'} with a video link in the next 24h.`
                    : `Connected - no video meetings in the next 24h. ${cal.message ?? ''}`}
                </p>
              )}
              {cal && cal.status !== 'ok' && (
                <div className="warn-banner">
                  Calendar access was {cal.status === 'denied' ? 'denied' : `not granted (${cal.status})`}.{' '}
                  <button className="link" onClick={() => api.openCalendarPrivacy()}>
                    Open privacy settings
                  </button>{' '}
                  and allow Meeting Scribe, then try again.
                  <div style={{ marginTop: 8 }}>
                    <button className="ghost" disabled={calBusy} onClick={connectCalendar}>
                      Try again
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {name === 'Done' && (
          <section>
            <span className="eyebrow">All set</span>
            <h2>You're ready to record</h2>
            <ul className="wiz-summary">
              <li>{modelReady ? '✓' : '…'} Transcription model {modelReady ? 'downloaded' : 'still downloading - check the Models tab'}</li>
              <li>
                {loopback
                  ? tapProbe === 'ok'
                    ? '✓ Meeting audio captured straight from system audio'
                    : '△ Meeting audio via system audio - macOS will ask for permission on your first recording'
                  : audio?.device
                    ? '✓ Meeting audio captured via the Multi-Output Device'
                    : '✗ Meeting audio not set up - mic only until BlackHole is installed'}
              </li>
              <li>{settings.diarize ? (hf?.ok ? '✓ Speaker recognition on' : '△ Speaker recognition on - token not validated yet') : '- Speaker recognition off'}</li>
              <li>{settings.offlineMode ? '- Fully offline, no summaries' : claude?.available ? '✓ Polish + summaries via Claude Code' : '△ Summaries on, but Claude Code is not installed yet'}</li>
              <li>{cal?.status === 'ok' ? '✓ Calendar connected' : '- Calendar not connected'}</li>
            </ul>
            <p className="hint">
              Pick a meeting from the Meetings tab (or just hit Record), talk, stop - the transcript,
              speakers and summary land in the Library.
            </p>
          </section>
        )}

        <footer className="wizard-foot">
          {step > 0 ? (
            <button className="ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          {last ? (
            <button className="primary" onClick={finish}>
              Start using Meeting Scribe
            </button>
          ) : (
            <button className="primary" onClick={() => setStep(step + 1)}>
              {step === 0 ? 'Start setup' : 'Continue'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
