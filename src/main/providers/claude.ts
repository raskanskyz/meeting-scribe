import os from 'node:os'
import path from 'node:path'
import { runCli } from './spawn.ts'
import type { Provider } from './types'

/**
 * `claude -p --output-format json` wraps the reply in an envelope:
 * { is_error, result }. Unwrap it to the plain model text.
 */
export function unwrapClaude(stdout: string): string {
  const wrapper = JSON.parse(stdout) as { is_error?: boolean; result?: string }
  if (wrapper.is_error) throw new Error(wrapper.result || 'Claude returned an error')
  return String(wrapper.result ?? '')
}

export const claude: Provider = {
  id: 'claude',
  name: 'Claude Code',
  installUrl: 'https://claude.com/claude-code',
  binaryName: 'claude',
  // packaged Electron apps launch with a minimal PATH, so `claude` usually
  // isn't reachable the way it is from a terminal - probe the common installs
  candidatePaths: [
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), 'bin/claude')
  ],
  defaultModel: 'sonnet',
  supportsImages: true,
  imageHint: 'View each image with the Read tool.',

  async run(bin, prompt, { model, timeoutMs, images }) {
    // a stale ANTHROPIC_API_KEY overrides subscription login and fails with
    // "Invalid API key" - strip it so the CLI always uses its own auth
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    // screenshots are handed over as file paths in the prompt; Claude may only
    // Read inside the one temp dir holding them (dontAsk denies everything else)
    const imageArgs = images
      ? ['--tools=Read', '--permission-mode=dontAsk', `--add-dir=${images.dir}`]
      : []
    const out = await runCli(
      'Claude',
      bin,
      ['-p', '--output-format', 'json', '--model', model, ...imageArgs],
      prompt,
      timeoutMs,
      env
    )
    return unwrapClaude(out)
  }
}
