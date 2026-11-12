import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * PATH for the child with the binary's own dir (and its symlink target's dir)
 * first: node-script CLIs start with `#!/usr/bin/env node`, and the node that
 * installed them lives next to them, not on an app launched with a minimal PATH.
 */
export function childPath(bin: string, pathEnv = ''): string {
  let real = bin
  try {
    real = fs.realpathSync(bin)
  } catch {
    /* keep the given path */
  }
  return [...new Set([path.dirname(bin), path.dirname(real), ...pathEnv.split(':').filter(Boolean)])].join(':')
}

/** Spawn a CLI with the prompt on stdin; resolve its stdout, reject with stderr's tail. */
export function runCli(
  name: string,
  bin: string,
  args: string[],
  prompt: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: os.tmpdir(), // neutral cwd so no project instructions file leaks into the prompt
      env: { ...env, PATH: childPath(bin, env.PATH) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${name} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim().slice(-400) || `${path.basename(bin)} exited with code ${code}`))
    })
    child.stdin.on('error', () => {}) // EPIPE if the CLI exits before reading; close reports it
    child.stdin.end(prompt)
  })
}
