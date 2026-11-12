import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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

/**
 * The last line of a shell's output that is an absolute path to an executable.
 * An interactive shell prints prompts, banners and rc-file noise around the
 * answer, so take the last line that qualifies, not the whole output.
 */
export function parseShellPath(out: string, isExec: (p: string) => boolean = executable): string | null {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) if (path.isAbsolute(lines[i]) && isExec(lines[i])) return lines[i]
  return null
}

// Interactive (-i) on purpose: nvm, fnm and friends are loaded from ~/.zshrc,
// which a plain login shell never reads, so `-lc` misses node-installed CLIs
// (codex) when the app is launched from Spotlight with a minimal PATH.
async function shellWhich(name: string): Promise<string | null> {
  try {
    const p = execFileP(process.env.SHELL || '/bin/zsh', ['-ilc', `command -v ${name}`], {
      timeout: 8000,
      killSignal: 'SIGKILL',
      encoding: 'utf8'
    })
    p.child.stdin?.end() // never wait on input
    return parseShellPath((await p).stdout)
  } catch {
    return null
  }
}

const semverDesc = (a: string, b: string): number => {
  const n = (v: string) => v.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const [x, y] = [n(a), n(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]
  return 0
}

/**
 * Bin dirs of the usual node/version-manager installs, which a minimal PATH
 * never contains. Version-numbered dirs (nvm, fnm) are listed newest first.
 */
export function commonBinDirs(
  home: string = os.homedir(),
  list: (dir: string) => string[] = (d) => {
    try {
      return fs.readdirSync(d)
    } catch {
      return []
    }
  }
): string[] {
  const versioned = (root: string, bin: (v: string) => string): string[] =>
    list(root).sort(semverDesc).map((v) => path.join(root, bin(v)))
  return [
    ...versioned(path.join(home, '.nvm/versions/node'), (v) => `${v}/bin`),
    ...versioned(path.join(home, '.local/share/fnm/node-versions'), (v) => `${v}/installation/bin`),
    ...versioned(path.join(home, '.fnm/node-versions'), (v) => `${v}/installation/bin`),
    ...versioned(path.join(home, 'Library/Application Support/fnm/node-versions'), (v) => `${v}/installation/bin`),
    path.join(home, '.volta/bin'),
    path.join(home, '.asdf/shims'),
    path.join(home, '.npm-global/bin'),
    '/opt/homebrew/bin'
  ]
}

export interface DetectEnv {
  pathEnv?: string
  /** version-manager bin dirs; defaults to commonBinDirs() */
  dirs?: string[]
  /** login-shell lookup, last resort; injectable for tests */
  shell?: (name: string) => Promise<string | null>
}

/**
 * Where is `name`? An explicit override wins and is never second-guessed (a bad
 * override is "not found", not a silent fall back to something else). Otherwise:
 * PATH, then the provider's install dirs and the version-manager dirs, then an
 * interactive login shell - a packaged app
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
  const common = (env.dirs ?? commonBinDirs()).map((d) => path.join(d, name))
  return [...fromPath, ...candidates, ...common].find(executable) ?? (await (env.shell ?? shellWhich)(name))
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
