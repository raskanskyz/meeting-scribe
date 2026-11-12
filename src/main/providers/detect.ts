import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

async function shellWhich(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(process.env.SHELL || '/bin/zsh', ['-lc', `command -v ${name}`], {
      timeout: 5000,
      encoding: 'utf8'
    })
    const out = stdout.trim()
    return out && executable(out) ? out : null
  } catch {
    return null
  }
}

export interface DetectEnv {
  pathEnv?: string
  /** login-shell lookup, last resort; injectable for tests */
  shell?: (name: string) => Promise<string | null>
}

/**
 * Where is `name`? An explicit override wins and is never second-guessed (a bad
 * override is "not found", not a silent fall back to something else). Otherwise:
 * PATH, then the common install dirs, then a login shell - a packaged app
 * launches with a minimal PATH, so the first two often miss.
 */
export async function detectBinary(
  name: string,
  candidates: string[],
  override: string,
  env: DetectEnv = {}
): Promise<string | null> {
  const o = override.trim()
  if (o) return executable(o) ? o : null
  const fromPath = (env.pathEnv ?? process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((d) => path.join(d, name))
  return [...fromPath, ...candidates].find(executable) ?? (await (env.shell ?? shellWhich)(name))
}

// Only hits are cached: a miss must be retried so an install made while the app
// is open is noticed. The cached path is re-checked, so an uninstall is too.
const found = new Map<string, string>()

export async function detectCached(
  name: string,
  candidates: string[],
  override: string,
  refresh = false
): Promise<string | null> {
  if (override.trim()) return detectBinary(name, candidates, override)
  const hit = found.get(name)
  if (!refresh && hit && executable(hit)) return hit
  const p = await detectBinary(name, candidates, '')
  if (p) found.set(name, p)
  else found.delete(name)
  return p
}
