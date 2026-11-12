/** Keep the original diagnostic alongside recovery instructions for the download UI. */
export function downloadError(raw: unknown, repo: string): { error: string; errorDetails: string } {
  const details = raw instanceof Error ? raw.message : String(raw)
  let error: string
  if (/^[\w.-]+\/[\w.-]+$/.test(repo) && /GatedRepoError|\b(?:401|403) (?:Client Error|Unauthorized|Forbidden)\b|status(?: code)?:? ?(?:401|403)\b|gated repo|terms.*accept|access.*restricted/i.test(details)) {
    error = `Access to this model was denied. Sign in at https://huggingface.co/${repo}, accept the model's terms or request access, then add a read token from that account in Models > Hugging Face token and retry.`
  } else if (/ENOSPC|Errno 28|No space left|disk.*full/i.test(details)) {
    error = 'There is not enough disk space to download this model. Free space on the drive containing your model storage, then retry.'
  } else if (/EACCES|EPERM|Errno (?:13|1)\b|PermissionError|Permission denied|Read-only file system/i.test(details)) {
    error = 'The model files could not be written. Check permissions and available access to your model storage folder, then retry.'
  } else if (/ConnectionError|ConnectError|ConnectTimeout|ReadTimeout|TimeoutError|timed? ?out|Network.*unreachable|name resolution|\bENOTFOUND\b|\bECONN|certificate verify failed|SSLError|offline|couldn't connect/i.test(details)) {
    error = 'Could not connect to Hugging Face. Check your internet connection, VPN or proxy, and TLS certificate settings, then retry.'
  } else {
    error = 'The model could not be downloaded. Retry the download; if it fails again, use the error details below to diagnose the problem.'
  }
  return { error, errorDetails: details }
}
