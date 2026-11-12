// node tests/download.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pythonSidecarEnv } from '../src/main/sidecarEnv.ts'
import { downloadError } from '../src/shared/downloadError.ts'
import { DIARIZE_MODEL } from '../src/shared/types.ts'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-download-'))
const original = process.env.SSLKEYLOGFILE
try {
  const missing = path.join(base, 'missing', 'tls-keys.log')
  const probe = (env: NodeJS.ProcessEnv) => spawnSync('python3', ['-c', 'import ssl; ssl.create_default_context()'], { env, encoding: 'utf8' })
  const broken = probe({ ...process.env, SSLKEYLOGFILE: missing })
  assert.notEqual(broken.status, 0)
  assert.match(broken.stderr, /FileNotFoundError/)
  process.env.SSLKEYLOGFILE = missing
  const filtered = pythonSidecarEnv({ HF_TOKEN: 'test-token' })
  assert.equal(filtered.SSLKEYLOGFILE, undefined)
  assert.equal(filtered.HF_TOKEN, 'test-token')
  assert.equal(process.env.SSLKEYLOGFILE, missing)
  const fixed = probe(filtered)
  assert.equal(fixed.status, 0, fixed.stderr)

  const valid = path.join(base, 'tls-keys.log')
  const kept = pythonSidecarEnv({ SSLKEYLOGFILE: valid })
  assert.equal(kept.SSLKEYLOGFILE, valid)
  assert.equal(probe(kept).status, 0)
  assert.ok(fs.existsSync(valid))
  assert.equal(pythonSidecarEnv({ SSLKEYLOGFILE: missing }).SSLKEYLOGFILE, undefined)
  assert.equal(pythonSidecarEnv({ SSLKEYLOGFILE: path.join(valid, 'keys.log') }).SSLKEYLOGFILE, undefined)

  const locked = path.join(base, 'locked')
  fs.mkdirSync(locked, { mode: 0o500 })
  const lockedLog = path.join(locked, 'tls-keys.log')
  if (process.getuid?.() !== 0) {
    assert.match(probe({ ...process.env, SSLKEYLOGFILE: lockedLog }).stderr, /PermissionError/)
    const unlocked = pythonSidecarEnv({ SSLKEYLOGFILE: lockedLog })
    assert.equal(unlocked.SSLKEYLOGFILE, undefined)
    assert.equal(probe(unlocked).status, 0)
  }
  fs.chmodSync(locked, 0o700)
} finally {
  if (original === undefined) delete process.env.SSLKEYLOGFILE
  else process.env.SSLKEYLOGFILE = original
  fs.rmSync(base, { recursive: true, force: true })
}

const repo = 'ivrit-ai/whisper-large-v3-turbo'
for (const raw of ['GatedRepoError: access denied', 'HTTPError: 401 Client Error', '403 Forbidden']) {
  const result = downloadError(raw, repo)
  assert.match(result.error, /accept the model's terms/)
  assert.ok(result.error.includes('https://huggingface.co/' + repo))
  assert.match(result.error, /Sign in/)
  assert.match(result.error, /read token/)
  assert.equal(result.errorDetails, raw)
}
for (const raw of ['ConnectionError: unreachable', 'ReadTimeout: timed out', 'SSLError: certificate verify failed']) {
  assert.match(downloadError(raw, repo).error, /internet connection/)
}
for (const raw of ['OSError: [Errno 28] No space left on device', 'ENOSPC']) {
  assert.match(downloadError(raw, repo).error, /Free space/)
}
for (const raw of ['PermissionError: [Errno 13] Permission denied', 'EACCES', 'Read-only file system']) {
  assert.match(downloadError(raw, repo).error, /Check permissions/)
}
assert.doesNotMatch(downloadError("FileNotFoundError: [Errno 2] No such file or directory: '/m/a__b/config.json'", repo).error, /internet connection/)
const traceback = 'Traceback:\n  File "/x/huggingface_hub/file_download.py", line 403, in hf_hub_download\nRuntimeError: boom'
assert.doesNotMatch(downloadError(traceback, repo).error, /accept the model's terms/)
assert.match(downloadError('GatedRepoError: 403 Forbidden', DIARIZE_MODEL).error, new RegExp('huggingface.co/' + DIARIZE_MODEL))
const diarizeExit = downloadError('exit 1', DIARIZE_MODEL)
assert.match(diarizeExit.error, /Retry/)
assert.equal(diarizeExit.errorDetails, 'exit 1')
assert.doesNotMatch(downloadError('403 Forbidden', 'local-model').error, /huggingface/)
const unknown = downloadError(new Error('unexpected download failure'), repo)
assert.match(unknown.error, /Retry/)
assert.equal(unknown.errorDetails, 'unexpected download failure')
console.log('download error and Python SSL environment regression ok')
