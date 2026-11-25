import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { modelEngine } from "../shared/types.ts";

const require = createRequire(import.meta.url);

// Execute the actual IPC handlers with real recording files, replacing only
// Electron and external services so this runs without devices, a GPU or models.
function recordingApp(t, model) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recording-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordingsDir = path.join(root, "recordings");
  const modelDir = path.join(root, "models", model.replace("/", "__"));
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir,
    modelEngine(model) === "mlx" ? "weights.safetensors" : "model.bin"), "");
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({
    recordingsDir, activeModel: model, language: "he", diarize: false,
    offlineMode: true, liveTranscription: true,
  }));
  const handlers = new Map();
  const calls = [];
  const events = [];
  let complete;
  const finished = new Promise((resolve) => { complete = resolve; });
  const mocks = {
    electron: {
      app: { getPath: () => root },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
    },
    "./audiosetup": { captureMode: () => "loopback" },
    "./tray": { setTrayRecording: () => {} },
    "./sidecar": { runSidecar: (args) => {
      calls.push(args);
      // The batch job must see flushed audio and persisted recording metadata.
      const dir = args[args.indexOf("--dir") + 1];
      assert.equal(fs.readFileSync(path.join(dir, "mic.webm"), "utf8"), "audio");
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"))).title, "Meeting");
      return { promise: finished };
    } },
    "../shared/types": { modelEngine },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, {
    module, exports: module.exports, Buffer, console,
    require: (id) => id.startsWith("node:") ? require(id) : mocks[id] ?? {},
  });
  module.exports.registerIpc({
    isDestroyed: () => false, setTitle: () => {}, setProgressBar: () => {},
    webContents: { send: (channel, payload) => events.push({ channel, ...payload }) },
  });
  return {
    invoke: (name, ...args) => handlers.get(name)(null, ...args),
    recordingsDir, calls, events, complete,
  };
}

for (const model of [
  "ivrit-ai/whisper-large-v3-turbo-ct2",
  "mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx",
]) {
  test(`${modelEngine(model)}: recording stays idle until stop starts full batch transcription`, async (t) => {
    const app = recordingApp(t, model);
    const { id } = await app.invoke("rec:begin");
    assert.equal(app.calls.length, 0);
    await app.invoke("rec:append", id, "mic", Buffer.from("audio"));
    const meta = await app.invoke("rec:finish", id, {
      title: "Meeting", createdAt: new Date().toISOString(), durationSec: 3, tracks: ["mic"],
    });
    assert.equal(meta.hasTranscript, false);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0][0], "transcribe");
    assert.equal(app.calls[0][app.calls[0].indexOf("--engine") + 1], modelEngine(model));
    assert.equal(fs.existsSync(path.join(app.recordingsDir, id, "live.json")), false);
    // Finishing returns while inference is still pending; late chunks cannot
    // reopen or change the full recording the batch job is reading.
    await app.invoke("rec:append", id, "mic", Buffer.from("late"));
    assert.equal(fs.readFileSync(path.join(app.recordingsDir, id, "mic.webm"), "utf8"), "audio");
    app.complete(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(app.events.some((e) => e.phase === "done" && e.recordingId === id));
  });
}

test("abort deletes the take without starting transcription", async (t) => {
  const app = recordingApp(t, "mlx-community/ivrit-ai-whisper-large-v3-turbo-mlx");
  const { id } = await app.invoke("rec:begin");
  await app.invoke("rec:append", id, "mic", Buffer.from("audio"));
  await app.invoke("rec:abort", id);
  assert.equal(fs.existsSync(path.join(app.recordingsDir, id)), false);
  assert.equal(app.calls.length, 0);
});

test("old settings fields and live preview files do not prevent loading recordings", async (t) => {
  const app = recordingApp(t, "ivrit-ai/whisper-large-v3-turbo-ct2");
  assert.equal((await app.invoke("settings:get")).recordingsDir, app.recordingsDir);
  const dir = path.join(app.recordingsDir, "old-recording");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    id: "old-recording", title: "Old meeting", createdAt: "2026-01-01T00:00:00Z",
    durationSec: 1, tracks: ["mic"],
  }));
  fs.writeFileSync(path.join(dir, "live.json"), "legacy preview");
  const recordings = await app.invoke("recordings:list");
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].title, "Old meeting");
  assert.equal(fs.readFileSync(path.join(dir, "live.json"), "utf8"), "legacy preview");
});
