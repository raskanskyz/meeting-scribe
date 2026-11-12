import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { ProviderId, ProviderInfo, ProviderTestResult, Settings } from '../../../shared/types'

interface Props {
  settings: Settings
  patch: (p: Partial<Settings>) => unknown
}

/**
 * Which AI command-line tool does polish and summaries: a card per supported
 * tool (installed ones selectable, missing ones disabled with an install link),
 * a re-check, and a Test button, because installed does not mean signed in.
 */
export default function ProviderPicker({ settings, patch }: Props) {
  const [list, setList] = useState<ProviderInfo[] | null>(null)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [busy, setBusy] = useState<'check' | 'test' | null>(null)

  const refresh = useCallback(async (fresh: boolean) => {
    setList(await api.listProviders(fresh))
  }, [])

  useEffect(() => {
    refresh(false)
    // re-check when the user comes back from installing something in a terminal
    const onFocus = () => refresh(true)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // the selected tool is missing and exactly one other is installed: preselect it
  useEffect(() => {
    if (!list) return
    const found = list.filter((p) => p.available)
    if (found.length === 1 && !list.find((p) => p.id === settings.provider)?.available)
      patch({ provider: found[0].id })
  }, [list, settings.provider, patch])

  const pick = (id: ProviderId) => {
    setTest(null)
    patch({ provider: id })
  }
  const current = list?.find((p) => p.id === settings.provider)

  return (
    <div>
      <div className="wiz-choices" style={{ flexDirection: 'column', marginTop: 0 }}>
        {list === null && <p className="hint">Looking for AI tools on this Mac…</p>}
        {list?.map((p) =>
          p.available ? (
            <button
              key={p.id}
              className={p.id === settings.provider ? 'wiz-choice active' : 'wiz-choice'}
              onClick={() => pick(p.id)}
            >
              <span className="wiz-choice-title">{p.name}</span>
              <span className="wiz-choice-detail">
                <span className="badge ok">found</span> <code>{p.path}</code>
              </span>
            </button>
          ) : (
            <div key={p.id} className="wiz-choice" style={{ opacity: 0.6, cursor: 'default' }}>
              <span className="wiz-choice-title">{p.name}</span>
              <span className="wiz-choice-detail">
                Not installed.{' '}
                <button className="link" onClick={() => api.openExternal(p.installUrl)}>
                  Install {p.name}
                </button>
              </span>
            </div>
          )
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="ghost"
          disabled={busy !== null}
          onClick={async () => {
            setBusy('check')
            await refresh(true)
            setBusy(null)
          }}
        >
          {busy === 'check' ? 'Checking…' : 'Check again'}
        </button>
        <button
          className="ghost"
          disabled={busy !== null || !current?.available}
          onClick={async () => {
            setBusy('test')
            setTest(null)
            setTest(await api.testProvider())
            setBusy(null)
          }}
        >
          {busy === 'test' ? 'Testing…' : `Test ${current?.name ?? ''}`.trim()}
        </button>
      </div>
      {test?.ok && (
        <p className="hint">
          <span className="badge ok">works</span> {current?.name} replied: {test.text}
        </p>
      )}
      {test && !test.ok && <div className="warn-banner">{test.error}</div>}
    </div>
  )
}
