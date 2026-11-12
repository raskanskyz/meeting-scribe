import type { HfValidation } from '../shared/types'

const GATED_REPO = 'pyannote/speaker-diarization-community-1'
const GATED_PROBE = `https://huggingface.co/${GATED_REPO}/resolve/main/config.yaml`

/**
 * Validate a Hugging Face token for diarization: the token itself must be
 * valid, and it must have access to the gated pyannote model. Distinguishing
 * the two failure modes matters - "bad token" and "terms not accepted" have
 * different fixes and both used to surface as an opaque 401 at transcription
 * time.
 */
export async function validateHfToken(token: string): Promise<HfValidation> {
  const auth = { Authorization: `Bearer ${token}` }
  try {
    const who = await fetch('https://huggingface.co/api/whoami-v2', { headers: auth })
    if (who.status === 401) {
      return {
        ok: false,
        stage: 'token',
        message: 'Hugging Face rejected this token. Create a new one with Read access at hf.co/settings/tokens.'
      }
    }
    if (!who.ok) {
      return { ok: false, stage: 'network', message: `Hugging Face returned ${who.status}.` }
    }
    const user = ((await who.json()) as { name?: string }).name

    const gated = await fetch(GATED_PROBE, { method: 'HEAD', headers: auth, redirect: 'follow' })
    if (gated.status === 401 || gated.status === 403) {
      return {
        ok: false,
        user,
        stage: 'gated',
        message: `Token is valid, but this account hasn't accepted the model terms yet - visit hf.co/${GATED_REPO}, accept, then validate again.`
      }
    }
    if (!gated.ok) {
      return { ok: false, user, stage: 'network', message: `Model access check returned ${gated.status}.` }
    }
    return { ok: true, user }
  } catch (e) {
    return {
      ok: false,
      stage: 'network',
      message: `Could not reach huggingface.co - ${e instanceof Error ? e.message : e}`
    }
  }
}
