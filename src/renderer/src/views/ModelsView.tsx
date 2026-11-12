import DownloadError from "../components/DownloadError";
import { useEffect, useState } from "react";
import { api } from "../api";
import {
  CURATED_MODELS,
  type DownloadProgress,
  type Settings,
} from "../../../shared/types";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

export default function ModelsView({ settings, onChange }: Props) {
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>(
    {},
  );

  const refresh = () => api.downloadedModels().then(setDownloaded);
  useEffect(() => {
    refresh();
  }, []);

  useEffect(
    () =>
      api.onModelProgress((p) => {
        setProgress((prev) => ({ ...prev, [p.repo]: p }));
        if (p.done && !p.error) refresh();
      }),
    [],
  );

  const download = (repo: string) => {
    setProgress((prev) => ({ ...prev, [repo]: { repo, pct: 0, done: false } }));
    api.downloadModel(repo);
  };

  const activate = async (repo: string) => {
    onChange(await api.setSettings({ activeModel: repo }));
  };

  return (
    <div>
      <header className="view-head">
        <span className="eyebrow">Engines</span>
        <h2>Models</h2>
      </header>
      <p className="hint" style={{ marginBottom: 16 }}>
        Models are downloaded from Hugging Face and run fully locally
        (faster-whisper, CPU int8).
      </p>
      <div className="card">
        <div
          className="row"
          style={{ justifyContent: "space-between", alignItems: "center" }}
        >
          <div>
            <div className="rec-title">Hugging Face token</div>
            <div className="rec-meta">
              Fixes 401 download errors and unlocks gated repos - paste a read
              token and retry.
            </div>
          </div>
          <div className="row">
            <input
              type="password"
              placeholder="hf_…"
              defaultValue={settings.hfToken}
              style={{ maxWidth: 280 }}
              onBlur={async (e) =>
                e.target.value.trim() !== settings.hfToken &&
                onChange(
                  await api.setSettings({ hfToken: e.target.value.trim() }),
                )
              }
            />
            <button
              className="ghost"
              title="Opens huggingface.co/settings/tokens in your browser"
              onClick={() =>
                api.openExternal("https://huggingface.co/settings/tokens")
              }
            >
              Get token ↗
            </button>
          </div>
        </div>
      </div>
      {CURATED_MODELS.map((m) => {
        const isDownloaded = downloaded.includes(m.repo);
        const isActive = settings.activeModel === m.repo;
        const p = progress[m.repo];
        const downloading = p && !p.done;
        return (
          <div className="card" key={m.repo}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="rec-title">
                  {m.label}{" "}
                  {m.recommended && (
                    <span className="badge ok">recommended</span>
                  )}{" "}
                  {isActive && <span className="badge ok">active</span>}
                </div>
                <div className="rec-meta">
                  {m.repo} · ~{m.sizeGb} GB - {m.detail}
                </div>
              </div>
              <div className="row">
                {!isDownloaded && !downloading && (
                  <button className="ghost" onClick={() => download(m.repo)}>
                    Download
                  </button>
                )}
                {isDownloaded && !isActive && (
                  <button className="primary" onClick={() => activate(m.repo)}>
                    Use
                  </button>
                )}
              </div>
            </div>
            {downloading && (
              <div style={{ marginTop: 10 }}>
                <div className="rec-meta" style={{ marginBottom: 6 }}>
                  Downloading - {p.pct}%
                </div>
                <div className="progress">
                  <div style={{ width: `${p.pct}%` }} />
                </div>
              </div>
            )}
            {p?.error && (
              <DownloadError error={p.error} details={p.errorDetails} />
            )}
          </div>
        );
      })}
    </div>
  );
}
