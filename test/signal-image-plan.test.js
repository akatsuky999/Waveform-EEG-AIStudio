import test from "node:test";
import assert from "node:assert/strict";

import { buildSignalImagePlan } from "../frontend/js/core/signal-image-plan.js";

test("multiscale keeps one overview plus ordered details", () => {
  const plan = buildSignalImagePlan({
    scope: "multiscale", duration: 100,
    detailRanges: [
      { startSec: 10, endSec: 20 }, { startSec: 40, endSec: 45 },
      { startSec: 60, endSec: 62 }, { startSec: 80, endSec: 81 },
      { startSec: 90, endSec: 91 },
    ],
  });
  assert.equal(plan.views.length, 5);
  assert.deepEqual(plan.views.at(-1), { index: 4, role: "detail", startSec: 80, endSec: 81 });
});

test("batch chooses four evenly spaced windows by default", () => {
  const plan = buildSignalImagePlan({
    scope: "batch", duration: 100,
    batch: { startSec: 0, endSec: 100, windowSec: 10, stepSec: 10 },
  });
  assert.equal(plan.totalWindows, 10);
  assert.deepEqual(plan.views.map((view) => view.batchIndex), [0, 3, 6, 9]);
  assert.deepEqual([plan.views.at(-1).startSec, plan.views.at(-1).endSec], [90, 100]);
});

test("full/current/range plans clamp to the recording", () => {
  assert.deepEqual(buildSignalImagePlan({ scope: "full", duration: 20 }).views[0], {
    index: 0, role: "overview", startSec: 0, endSec: 20,
  });
  assert.deepEqual(buildSignalImagePlan({
    scope: "range", duration: 20, range: { startSec: -2, endSec: 40 },
  }).views[0], { index: 0, role: "detail", startSec: 0, endSec: 20 });
});
