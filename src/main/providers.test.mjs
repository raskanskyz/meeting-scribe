import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commonBinDirs, detectBinary, parseShellPath } from "./providers/detect.ts";
import { childPath } from "./providers/spawn.ts";
import { unwrapClaude } from "./providers/claude.ts";
import { unwrapCodex } from "./providers/codex.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ms-detect-")));
const fake = (...parts) => {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
  return p;
};
const noShell = async () => null;
const noDirs = [];

test("override wins, and a bad override is not found rather than falling back", async () => {
  const onPath = fake("bin", "tool");
  const custom = fake("custom", "mytool");
  const env = { pathEnv: path.dirname(onPath), shell: noShell, dirs: noDirs };
  assert.equal(await detectBinary("tool", [], custom, env), custom);
  assert.equal(await detectBinary("tool", [], path.join(tmp, "nope"), env), null);
});

test("PATH beats the common install dirs, which beat the login shell", async () => {
  const onPath = fake("a", "tool");
  const candidate = fake("b", "tool");
  const viaShell = fake("c", "tool");
  const shell = async () => viaShell;
  assert.equal(await detectBinary("tool", [candidate], "", { pathEnv: path.dirname(onPath), shell, dirs: noDirs }), onPath);
  assert.equal(await detectBinary("tool", [candidate], "", { pathEnv: "/nonexistent", shell, dirs: noDirs }), candidate);
  assert.equal(await detectBinary("tool", ["/nonexistent/tool"], "", { pathEnv: "/nonexistent", shell, dirs: noDirs }), viaShell);
  assert.equal(await detectBinary("tool", [], "", { pathEnv: "/nonexistent", shell: noShell, dirs: noDirs }), null);
});

test("a directory or non-executable file is not a binary", async () => {
  const dir = path.join(tmp, "d", "tool");
  fs.mkdirSync(dir, { recursive: true });
  const plain = path.join(tmp, "plain");
  fs.writeFileSync(plain, "x", { mode: 0o644 });
  assert.equal(await detectBinary("tool", [dir, plain], "", { pathEnv: "", shell: noShell, dirs: noDirs }), null);
});

test("claude envelope is unwrapped to the reply text", () => {
  assert.equal(unwrapClaude(JSON.stringify({ is_error: false, result: '{"a":1}' })), '{"a":1}');
  assert.equal(unwrapClaude(JSON.stringify({})), "");
  assert.throws(() => unwrapClaude(JSON.stringify({ is_error: true, result: "Invalid API key" })), /Invalid API key/);
  assert.throws(() => unwrapClaude("not json"));
});

test("codex prints only the final message, so unwrapping just trims", () => {
  assert.equal(unwrapCodex('  {"a":1}\n'), '{"a":1}');
});

test("version-manager dirs are probed after PATH and the provider dirs, newest nvm first", async () => {
  const home = path.join(tmp, "home");
  for (const v of ["v18.20.5", "v24.15.0", "v9.1.0"]) fs.mkdirSync(path.join(home, ".nvm/versions/node", v, "bin"), { recursive: true });
  const dirs = commonBinDirs(home);
  assert.deepEqual(
    dirs.slice(0, 3),
    ["v24.15.0", "v18.20.5", "v9.1.0"].map((v) => path.join(home, ".nvm/versions/node", v, "bin")),
  );
  assert.ok(dirs.includes(path.join(home, ".volta/bin")) && dirs.includes("/opt/homebrew/bin"));
  const nvmTool = fake("home", ".nvm/versions/node/v24.15.0/bin", "nvmtool");
  assert.equal(await detectBinary("nvmtool", [], "", { pathEnv: "", dirs, shell: noShell }), nvmTool);
  const cand = fake("cand", "nvmtool");
  assert.equal(await detectBinary("nvmtool", [cand], "", { pathEnv: "", dirs, shell: noShell }), cand);
});

test("shell output noise is ignored: last absolute executable line wins", () => {
  const bin = fake("sh", "codex");
  assert.equal(parseShellPath(`Welcome!\ncompinit: warning\n${bin}\n\n`), bin);
  assert.equal(parseShellPath(`${bin}\nsome trailing prompt\n`), bin);
  assert.equal(parseShellPath("codex not found\nrelative/codex\n"), null);
  assert.equal(parseShellPath(`${path.join(tmp, "missing")}\n`), null);
  assert.equal(parseShellPath(""), null);
});

test("child PATH starts with the binary dir and its symlink target dir", () => {
  const real = fake("lib", "real", "bin.js");
  const link = path.join(tmp, "linkbin", "tool");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const parts = childPath(link, "/usr/bin:/bin").split(":");
  assert.deepEqual(parts, [path.dirname(link), fs.realpathSync(path.dirname(real)), "/usr/bin", "/bin"]);
  assert.deepEqual(childPath(real, "").split(":"), [fs.realpathSync(path.dirname(real))]);
});
