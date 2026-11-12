import fs from 'node:fs'

/** Ignore login-session TLS logging paths Python could not open before it initializes SSL. */
export function pythonSidecarEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', ...extraEnv }
  if (env.SSLKEYLOGFILE) {
    try {
      fs.closeSync(fs.openSync(env.SSLKEYLOGFILE, 'a'))
    } catch {
      delete env.SSLKEYLOGFILE
    }
  }
  return env
}
