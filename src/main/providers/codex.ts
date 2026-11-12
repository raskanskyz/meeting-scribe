import os from 'node:os'
import path from 'node:path'
import { runCli } from './spawn.ts'
import type { Provider } from './types'

/**
 * `codex exec` prints progress and the banner on stderr and ONLY the final
 * agent message on stdout, so there is no envelope - just trim.
 */
export function unwrapCodex(stdout: string): string {
  return stdout.trim()
}

export const codex: Provider = {
  id: 'codex',
  name: 'Codex',
  installUrl: 'https://developers.openai.com/codex/cli',
  binaryName: 'codex',
  candidatePaths: [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(os.homedir(), '.local/bin/codex'),
    path.join(os.homedir(), '.codex/bin/codex'),
    path.join(os.homedir(), 'bin/codex')
  ],
  defaultModel: '', // whatever the user's Codex login defaults to
  supportsImages: true,
  imageHint: 'The images are attached to this message.',

  async run(bin, prompt, { model, timeoutMs, images }) {
    const args = [
      'exec',
      '--skip-git-repo-check', // cwd is the temp dir, not a repo
      '--ephemeral', // no session files left behind
      '--ignore-user-config', // user hooks/MCP servers/profiles must not run for a one-shot prompt
      '--ignore-rules',
      '--sandbox',
      'read-only', // nothing to write; approvals never prompt in exec mode
      ...(model ? ['--model', model] : []),
      ...(images?.files ?? []).map((f) => `--image=${f}`),
      '-' // prompt from stdin
    ]
    return unwrapCodex(await runCli('Codex', bin, args, prompt, timeoutMs))
  }
}
