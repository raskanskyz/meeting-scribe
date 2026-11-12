// node tests/timelineView.test.ts
import assert from "node:assert/strict";
import {
  clampView,
  followView,
  pan,
  ticks,
  zoomAt,
} from "../src/renderer/src/timelineView.ts";

const D = 3600;
const fit = { start: 0, span: D };

// zoom keeps the time under the cursor fixed
const z = zoomAt(fit, 4, 1800, D);
assert.deepEqual(z, { start: 1350, span: 900 });
assert.equal((1800 - z.start) / z.span, 0.5);
// zooming out past fit clamps back to the whole meeting
assert.deepEqual(zoomAt(z, 0.01, 1800, D), fit);
// can't zoom tighter than MIN_SPAN, nor past either end
assert.equal(zoomAt(fit, 1e6, 10, D).span, 5);
assert.deepEqual(zoomAt(fit, 10, 0, D), { start: 0, span: 360 });
assert.deepEqual(zoomAt(fit, 10, D, D), { start: D - 360, span: 360 });
// a meeting shorter than MIN_SPAN still fits
assert.deepEqual(clampView({ start: 0, span: 1 }, 3), { start: 0, span: 3 });

// panning stops at the ends
assert.deepEqual(pan({ start: 100, span: 60 }, -500, D), {
  start: 0,
  span: 60,
});
assert.deepEqual(pan({ start: 100, span: 60 }, 1e5, D), {
  start: D - 60,
  span: 60,
});

// ticks: round steps, inside the window, at most ~8
assert.deepEqual(
  ticks({ start: 0, span: 40 }),
  [0, 5, 10, 15, 20, 25, 30, 35, 40],
);
assert.deepEqual(
  ticks({ start: 3, span: 40 }),
  [5, 10, 15, 20, 25, 30, 35, 40],
);
assert.deepEqual(ticks(fit), [0, 600, 1200, 1800, 2400, 3000, 3600]);

// follow: leave the view alone while the playhead is comfortably inside
const v = { start: 600, span: 100 };
assert.equal(followView(v, 650, D), v);
// page along when it reaches the right edge, or jump to it when outside
assert.deepEqual(followView(v, 695, D), { start: 685, span: 100 });
assert.deepEqual(followView(v, 100, D), { start: 90, span: 100 });

console.log("timelineView ok");
