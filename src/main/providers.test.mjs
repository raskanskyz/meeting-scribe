import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectBinary } from "./providers/detect.ts";
import { unwrapClaude } from "./providers/claude.ts";
import { unwrapCodex } from "./providers/codex.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ms-detect-"));
const fake = (...parts) => {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
  return p;
};
const noShell = async () => null;

test("override wins, and a bad override is not found rather than falling back", async () => {
  const onPath = fake("bin", "tool");
  const custom = fake("custom", "mytool");
  const env = { pathEnv: path.dirname(onPath), shell: noShell };
  assert.equal(await detectBinary("tool", [], custom, env), custom);
  assert.equal(await detectBinary("tool", [], path.join(tmp, "nope"), env), null);
});

test("PATH beats the common install dirs, which beat the login shell", async () => {
  const onPath = fake("a", "tool");
  const candidate = fake("b", "tool");
  const viaShell = fake("c", "tool");
  const shell = async () => viaShell;
  assert.equal(await detectBinary("tool", [candidate], "", { pathEnv: path.dirname(onPath), shell }), onPath);
  assert.equal(await detectBinary("tool", [candidate], "", { pathEnv: "/nonexistent", shell }), candidate);
  assert.equal(await detectBinary("tool", ["/nonexistent/tool"], "", { pathEnv: "/nonexistent", shell }), viaShell);
  assert.equal(await detectBinary("tool", [], "", { pathEnv: "/nonexistent", shell: noShell }), null);
});

test("a directory or non-executable file is not a binary", async () => {
  const dir = path.join(tmp, "d", "tool");
  fs.mkdirSync(dir, { recursive: true });
  const plain = path.join(tmp, "plain");
  fs.writeFileSync(plain, "x", { mode: 0o644 });
  assert.equal(await detectBinary("tool", [dir, plain], "", { pathEnv: "", shell: noShell }), null);
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
