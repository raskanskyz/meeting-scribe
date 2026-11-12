import assert from "node:assert/strict";
import { test } from "node:test";
import { framesForRange, renderScreenContext } from "./screenPrompt.ts";

const f = (t, text = "") => ({ t, file: `/tmp/f${t}.jpg`, text });

test("framesForRange keeps the frame already up plus those inside, capped", () => {
  const frames = [f(0), f(10), f(20), f(30), f(40)];
  assert.deepEqual(
    framesForRange(frames, 15, 35, 3).map((x) => x.t),
    [10, 20, 30],
  );
  assert.deepEqual(
    framesForRange(frames, 15, 35, 2).map((x) => x.t),
    [10, 20],
  );
  assert.deepEqual(framesForRange(frames, 100, 120, 3).map((x) => x.t), [40]);
  assert.deepEqual(framesForRange([], 0, 10, 3), []);
});

test("renderScreenContext is empty without frames and bounded with them", () => {
  assert.equal(renderScreenContext([], "x"), "");
  const out = renderScreenContext([f(65, `  Zebra budget  \n\n${"a".repeat(5000)}`)], "Use it lightly.");
  assert.match(out, /at \[00:01:05\] - image file: \/tmp\/f65\.jpg/);
  assert.match(out, /Zebra budget\n/);
  assert.match(out, /untrusted/);
  assert.ok(out.length < 2000, "OCR text is capped");
});
