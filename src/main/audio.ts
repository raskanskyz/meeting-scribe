import { execFile } from "node:child_process";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

// mirrors calendar.ts resolution: dev reads from the project tree, packaged
// reads the binary copied into Resources by electron-builder's extraResources
function binPath(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return app.isPackaged
    ? path.join(base, "audio-sidecar")
    : path.join(base, "swift", "audio-sidecar");
}

function run(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const bin = binPath();
    if (!fs.existsSync(bin)) {
      return reject(
        new Error("audio helper not built - run `npm run build:audio`"),
      );
    }
    execFile(bin, args, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(stdout));
      }
    });
  });
}

export const currentOutput = async (): Promise<string> => {
  const res = await run(["get-default"]);
  if (res.status !== "ok") throw new Error(String(res.message ?? res.status));
  return String(res.name ?? "");
};

export async function setOutput(name: string): Promise<void> {
  const res = await run(["set-default", "--name", name]);
  if (res.status !== "ok") throw new Error(String(res.message ?? res.status));
}

/** Volume of the audible output - the physical sub-device when the default
 *  is our aggregate, whose master volume macOS won't let the keys control. */
export async function getOutputVolume(): Promise<number | null> {
  try {
    const res = await run(["get-volume"]);
    return res.status === "ok" ? Number(res.volume) : null;
  } catch {
    return null;
  }
}

export async function setOutputVolume(volume: number): Promise<void> {
  await run(["set-volume", "--value", volume.toFixed(3)]).catch(() => {});
}

/** Create the `name` multi-output device (real output + BlackHole) when
 *  BlackHole is installed and no such device exists yet. Best-effort:
 *  without BlackHole the Record view explains what to install. */
export async function ensureMultiOutput(name: string): Promise<void> {
  try {
    await run(["setup", "--name", name]);
  } catch {
    /* helper missing or CoreAudio refused - recording still works, mic only */
  }
}

/**
 * Switch system output to `device` for the duration of a recording.
 * Returns a restore function; both directions are best-effort (missing
 * helper or device just means the user keeps manual control).
 */
export async function switchOutputForRecording(
  device: string,
): Promise<() => Promise<void>> {
  try {
    const prev = await currentOutput();
    if (prev === device) return async () => {};
    await setOutput(device);
    return async () => {
      try {
        await setOutput(prev);
      } catch {
        /* device gone - leave as-is */
      }
    };
  } catch {
    return async () => {};
  }
}
