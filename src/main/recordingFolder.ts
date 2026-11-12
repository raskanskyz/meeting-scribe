import fs from "node:fs";
import path from "node:path";

/**
 * Absolute path of a recording's folder (where its transcript and summary
 * live), or null when the id escapes `base` or the folder does not exist.
 */
export function recordingFolder(base: string, id: string): string | null {
  const root = path.resolve(base);
  const full = path.resolve(root, id);
  if (path.dirname(full) !== root) return null;
  try {
    return fs.statSync(full).isDirectory() ? full : null;
  } catch {
    return null;
  }
}
