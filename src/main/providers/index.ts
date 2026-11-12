import type { ProviderId, ProviderInfo, ProviderStatus, Settings } from '../../shared/types'
import { claude } from './claude'
import { codex } from './codex'
import { detectCached } from './detect'
import type { Provider } from './types'

export type { Provider, RunOptions } from './types'

/** every supported tool, in the order the picker lists them */
export const PROVIDERS: Provider[] = [claude, codex]

export function getProvider(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? claude
}

/** which Settings fields hold a provider's binary override and model */
const KEYS: Record<ProviderId, { binary: keyof Settings; model: keyof Settings }> = {
  claude: { binary: 'claudeBinary', model: 'summaryModel' },
  codex: { binary: 'codexBinary', model: 'codexModel' }
}

export interface Selected {
  provider: Provider
  /** user-set binary path; '' = auto-detect */
  override: string
  /** effective model: the setting, else the provider's default */
  model: string
}

export function selected(s: Settings, id: ProviderId = s.provider): Selected {
  const provider = getProvider(id)
  const k = KEYS[provider.id as ProviderId]
  return {
    provider,
    override: String(s[k.binary] ?? ''),
    model: String(s[k.model] ?? '').trim() || provider.defaultModel
  }
}

export const detect = (p: Provider, override: string, refresh = false): Promise<string | null> =>
  detectCached(p.binaryName, p.candidatePaths, override, refresh)

export async function status(p: Provider, override: string, refresh = false): Promise<ProviderStatus> {
  const bin = await detect(p, override, refresh)
  const o = override.trim()
  return bin
    ? { available: true, path: bin }
    : { available: false, reason: o ? `No executable at ${o}` : `${p.name} CLI not found on this machine` }
}

/** every supported provider with its detection result, for the picker */
export async function listProviders(s: Settings, refresh = false): Promise<ProviderInfo[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => ({
      id: p.id as ProviderId,
      name: p.name,
      installUrl: p.installUrl,
      ...(await status(p, selected(s, p.id as ProviderId).override, refresh))
    }))
  )
}
