import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordingFolder } from "./recordingFolder.ts";

test("recordingFolder resolves existing folders only", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  fs.mkdirSync(path.join(base, "rec1"));
  fs.writeFileSync(path.join(base, "file"), "");
  assert.equal(recordingFolder(base, "rec1"), path.join(base, "rec1"));
  assert.ok(path.isAbsolute(recordingFolder(base + "/", "rec1")));
  assert.equal(recordingFolder(base, "missing"), null);
  assert.equal(recordingFolder(base, "file"), null);
  assert.equal(recordingFolder(base, "../x"), null);
  assert.equal(recordingFolder(base, ""), null);
  assert.equal(recordingFolder(base, "rec1/.."), null);
});
