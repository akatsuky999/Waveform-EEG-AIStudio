import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWindowedAgentContext,
  WINDOWED_FULL_ARRAY_EXPORT_UNAVAILABLE,
} from "../frontend/js/core/windowed-agent-context.js";

test("windowed agent context exposes first-class large-recording workflow", () => {
  const ctx = buildWindowedAgentContext({
    windowMeta: { fileName: "long.h5", kind: "h5", nChannels: 32, nSamples: 720000 },
    channelMeta: [
      { label: "Fp1", group: "EEG", mean: 1.2, min: -12, max: 15 },
      { label: "Fp2", group: "EEG", mean: 0.4, min: -9, max: 11 },
    ],
    selectedChannel: 1,
    visibleChannels: [0, 1],
    fs: 200,
    duration: 3600,
    nChannels: 32,
    tStart: 120,
    tEnd: 135,
    montageMode: "bipolar",
    normMethod: "robust",
    diffOrder: 1,
    unit: "uV",
    gainMult: 2,
    filterOpts: { low: 1, high: 40, notch: "60" },
  });

  assert.equal(ctx.windowed, true);
  assert.equal(ctx.agentMode, "large-windowed");
  assert.equal(ctx.windowedAccess.status, "available");
  assert.equal(ctx.windowedAccess.query.tool, "signal_query");
  assert.deepEqual(ctx.windowedAccess.query.ops, ["search", "aggregate"]);
  assert.equal(ctx.windowedAccess.python.tool, "run_python");
  assert.deepEqual(ctx.windowedAccess.python.requires, ["startSec", "endSec"]);
  assert.equal(ctx.windowedAccess.images.tool, "render_signal_images");
  assert.equal(ctx.windowedAccess.images.mode, "short-window-exact");
  assert.equal(ctx.windowedAccess.images.fullOverview, false);
  assert.deepEqual(ctx.recommendedWorkflow.map((step) => step.tool), [
    "signal_query",
    "run_python",
    "render_signal_images",
  ]);
  assert.equal(JSON.stringify(ctx).includes("planned follow-up"), false);
  assert.equal(ctx.selectedChannel.label, "Fp2");
  assert.equal(ctx.visibleChannels[0].displayStats.peakToPeak, 27);
});

test("windowed full-array export message does not describe image rendering as planned", () => {
  assert.match(WINDOWED_FULL_ARRAY_EXPORT_UNAVAILABLE, /Full-array export is unavailable/);
  assert.doesNotMatch(WINDOWED_FULL_ARRAY_EXPORT_UNAVAILABLE, /planned follow-up/);
  assert.doesNotMatch(WINDOWED_FULL_ARRAY_EXPORT_UNAVAILABLE, /image rendering .* planned/i);
});
