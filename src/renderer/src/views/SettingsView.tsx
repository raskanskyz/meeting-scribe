import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api";
import type { AudioSetupStatus, Settings } from "../../../shared/types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

export default function SettingsView({ settings, onChange }: Props) {
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [newLang, setNewLang] = useState("");
  const [audioNote, setAudioNote] = useState("");
  // transient "Saved" tick so silent onBlur saves are visible
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  const [audio, setAudio] = useState<AudioSetupStatus | null>(null);

  useEffect(() => {
    api.downloadedModels().then(setDownloaded);
    return () => clearTimeout(savedTimer.current);
  }, []);

  useEffect(() => {
    api.audioStatus().then(setAudio);
  }, [settings.systemCapture]);

  const save = async (patch: Partial<Settings>) => {
    onChange(await api.setSettings(patch));
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1800);
  };

  const pickFolder = async () => {
    const dir = await api.pickFolder();
    if (dir) save({ recordingsDir: dir });
  };

  const addMapping = () => {
    const lang = newLang.trim().toLowerCase();
    if (
      !lang ||
      lang === "auto" ||
      settings.modelMap[lang] ||
      !downloaded.length
    )
      return;
    save({ modelMap: { ...settings.modelMap, [lang]: downloaded[0] } });
    setNewLang("");
  };

  const removeMapping = (lang: string) => {
    const { [lang]: _, ...rest } = settings.modelMap;
    save({ modelMap: rest });
  };

  return (
    <div>
      <header className="view-head">
        <span className="eyebrow">Config</span>
        <div className="panel-title-row">
          <h2>Settings</h2>
          <span
            className={saved ? "saved-tick show" : "saved-tick"}
            aria-live="polite"
          >
            <Check size={12} aria-hidden="true" /> Saved
          </span>
        </div>
      </header>

      <div className="card">
        <div className="field">
          <label>Setup</label>
          <button className="ghost" onClick={() => save({ onboardedAt: "" })}>
            Run setup wizard again
          </button>
        </div>

        <div className="field">
          <label>Meeting audio capture</label>
          <select
            value={settings.systemCapture}
            style={{ maxWidth: 320 }}
            onChange={(e) => {
              save({
                systemCapture: e.target.value as Settings["systemCapture"],
              });
              setAudioNote("");
            }}
          >
            <option value="auto">
              Automatic - system audio when supported
            </option>
            <option value="loopback">System audio (macOS 14.2+)</option>
            <option value="blackhole">BlackHole virtual device</option>
          </select>
          <p className="hint" style={{ marginTop: 8 }}>
            {audio?.mode === "loopback" ? (
              <>
                Using <b>system audio</b> - recorded straight from your Mac's
                output. No driver, no output switching, volume keys keep
                working. Captures what's actually played, so unmute before
                recording.
              </>
            ) : (
              <>
                Using <b>BlackHole</b>
                {audio &&
                  !audio.loopbackSupported &&
                  " (this macOS is older than 14.2)"}{" "}
                - needs the BlackHole driver and a Multi-Output Device, and the
                app switches your sound output while recording (volume keys go
                dead; use the in-deck slider).
              </>
            )}
          </p>
          {audio?.mode === "blackhole" && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="ghost"
                onClick={async () => {
                  const res = await api.audioEnsure(true);
                  setAudioNote(
                    res.error ??
                      `"${res.deviceName}" rebuilt, paired with ${res.pairedWith ?? "your speakers"}.`,
                  );
                }}
              >
                Rebuild audio device for current speakers
              </button>
            </div>
          )}
          {audioNote && (
            <p className="hint" style={{ marginTop: 8 }}>
              {audioNote}
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>Recordings folder</label>
          <div className="row">
            <input
              value={settings.recordingsDir}
              readOnly
              style={{ flex: 1 }}
            />
            <button className="ghost" onClick={pickFolder}>
              Choose…
            </button>
          </div>
        </div>

        {audio?.mode === "blackhole" && (
          <div className="field">
            <label>
              Meeting output device (auto-selected while recording, restored
              after; empty = off)
            </label>
            <input
              defaultValue={settings.outputDevice}
              style={{ maxWidth: 280 }}
              onBlur={(e) =>
                e.target.value.trim() !== settings.outputDevice &&
                save({ outputDevice: e.target.value.trim() })
              }
            />
          </div>
        )}

        <div className="field">
          <label>
            Default transcription language (ISO code, e.g. he, en - or auto)
          </label>
          <input
            defaultValue={settings.language}
            style={{ maxWidth: 120 }}
            onBlur={(e) =>
              e.target.value !== settings.language &&
              save({ language: e.target.value.trim() })
            }
          />
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>Speaker identification</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={settings.diarize}
              onChange={(e) => save({ diarize: e.target.checked })}
            />{" "}
            Split meeting audio into individual speakers (NVIDIA Nemotron,
            runs fully locally)
          </label>
          <p className="hint" style={{ marginTop: 8 }}>
            Requires a free Hugging Face account: accept the terms at{" "}
            <code>hf.co/pyannote/speaker-diarization-community-1</code> (its
            voice-embedding model powers speaker recognition), then paste a read
            token below. The first transcription downloads the models (~200 MB
            speaker model, ~30 MB voice model) plus Python dependencies
            (one-time, ~1 GB); after
            that everything runs offline. Rename a speaker once in the Library
            and they'll be recognized by voice in future recordings.
          </p>
        </div>
        <div className="field">
          <label>Hugging Face token</label>
          <input
            type="password"
            defaultValue={settings.hfToken}
            style={{ maxWidth: 360 }}
            onBlur={(e) =>
              e.target.value.trim() !== settings.hfToken &&
              save({ hfToken: e.target.value.trim() })
            }
          />
        </div>
        <div className="field">
          <label>Voice recognition strictness</label>
          <div className="row">
            <span className="range-end">More matches</span>
            <input
              type="range"
              min={0.3}
              max={0.8}
              step={0.05}
              value={settings.matchThreshold}
              style={{ maxWidth: 220 }}
              onChange={(e) => save({ matchThreshold: Number(e.target.value) })}
            />
            <span className="range-end">Stricter</span>
            <span className="badge">{settings.matchThreshold.toFixed(2)}</span>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            How closely a voice must match a saved voiceprint before it's
            auto-named (default 0.55). Lower it if people you've already named
            keep showing up as "Speaker N"; raise it if speakers get labeled
            with the wrong name. Applies to the next transcription.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>Privacy</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={settings.offlineMode}
              onChange={(e) => save({ offlineMode: e.target.checked })}
            />{" "}
            Offline mode - nothing leaves this Mac
          </label>
          <p className="hint" style={{ marginTop: 8 }}>
            Disables Claude polish and summaries, blocks model downloads, and
            forces the transcription sidecars fully offline (recording, live
            transcription and speaker identification all run from
            already-downloaded local models). Recordings and transcripts are still
            saved locally; recordings made while this is on get no polish or
            summary, and you can generate them by hand later. Also available
            as a toggle at the bottom of the sidebar.
          </p>
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginTop: 12,
            }}
          >
            <input
              type="checkbox"
              checked={settings.hideFromCapture}
              onChange={(e) => save({ hideFromCapture: e.target.checked })}
            />{" "}
            Invisible to screen sharing - the app never appears in shared
            screens or recordings
          </label>
          <p className="hint" style={{ marginTop: 8 }}>
            Applies to every capture path (Zoom, Meet, QuickTime, this app's own
            screen recording). Note it also hides the app from your own
            screenshots - turn it off temporarily if you need one.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>Disk space</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={settings.deleteAudioWhenDone}
              onChange={(e) => save({ deleteAudioWhenDone: e.target.checked })}
            />{" "}
            Delete the raw audio once processing is complete
          </label>
          <p className="hint" style={{ marginTop: 8 }}>
            Removes <code>mic.webm</code> and <code>system.webm</code> after the
            transcript - and any polish and summary passes you have enabled -
            have all been written. The transcript, summary and speaker data are
            kept.
          </p>
          {settings.deleteAudioWhenDone && (
            <div className="warn-banner" style={{ marginTop: 10 }}>
              The audio is deleted permanently and is not sent to the Trash.
              Those recordings can never be re-transcribed, re-diarized or
              played back.
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>AI summaries (Claude Code)</label>
          <p className="hint">
            Meeting summaries are generated by the Claude Code CLI installed on
            this machine, using your own Claude subscription - no API key is
            stored or needed. Leave the path empty to auto-detect.
          </p>
        </div>
        <div className="field">
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={settings.lintTranscripts}
              onChange={(e) => save({ lintTranscripts: e.target.checked })}
            />{" "}
            Automatically polish new transcripts (fix recognition errors,
            normalize terms)
          </label>
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginTop: 8,
            }}
          >
            <input
              type="checkbox"
              checked={settings.autoSummarize}
              onChange={(e) => save({ autoSummarize: e.target.checked })}
            />{" "}
            Automatically generate a summary after transcription
          </label>
        </div>
        <div className="field">
          <label>Claude binary path (empty = auto-detect)</label>
          <input
            defaultValue={settings.claudeBinary}
            placeholder="/opt/homebrew/bin/claude"
            style={{ maxWidth: 360 }}
            onBlur={(e) =>
              e.target.value.trim() !== settings.claudeBinary &&
              save({ claudeBinary: e.target.value.trim() })
            }
          />
        </div>
        <div className="field">
          <label>Summary model (alias passed to claude --model)</label>
          <input
            defaultValue={settings.summaryModel}
            placeholder="sonnet"
            style={{ maxWidth: 160 }}
            onBlur={(e) =>
              e.target.value.trim() !== settings.summaryModel &&
              save({ summaryModel: e.target.value.trim() })
            }
          />
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>Language → model mapping</label>
          <p className="hint" style={{ marginBottom: 10 }}>
            Transcribing in a mapped language uses that model; unmapped
            languages and <code>auto</code> use the active model (
            {settings.activeModel}).
          </p>

          {Object.entries(settings.modelMap).map(([lang, repo]) => (
            <div className="row" style={{ marginBottom: 8 }} key={lang}>
              <span className="badge">{lang}</span>
              <select
                value={repo}
                onChange={(e) =>
                  save({
                    modelMap: { ...settings.modelMap, [lang]: e.target.value },
                  })
                }
              >
                {[...new Set([repo, ...downloaded])].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button className="danger" onClick={() => removeMapping(lang)}>
                Remove
              </button>
            </div>
          ))}

          <div className="row">
            <input
              placeholder="lang code (e.g. en)"
              value={newLang}
              style={{ maxWidth: 160 }}
              onChange={(e) => setNewLang(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addMapping()}
            />
            <button
              className="ghost"
              onClick={addMapping}
              disabled={!newLang.trim() || !downloaded.length}
            >
              Add mapping
            </button>
          </div>
          {!downloaded.length && (
            <p className="hint" style={{ marginTop: 8 }}>
              Download at least one model first (Models tab) to create mappings.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
