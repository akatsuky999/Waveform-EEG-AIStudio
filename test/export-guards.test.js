import test from "node:test";
import assert from "node:assert/strict";

import {
  countBatchWindows,
  formatAspectRatio,
  formatFileSize,
  MAX_BATCH_WINDOWS,
  resolveLabelSize,
  resolveImageDimensions,
} from "../frontend/js/ui/exports.js";

test("counts complete and partial batch windows consistently", () => {
  assert.equal(countBatchWindows(2, 1, 1, true), 2);
  assert.equal(countBatchWindows(2.2, 1, 1, true), 3);
  assert.equal(countBatchWindows(2.2, 1, 1, false), 2);
  assert.equal(countBatchWindows(0.5, 1, 1, false), 0);
});

test("detects batch requests beyond the server guard", () => {
  assert.ok(countBatchWindows(2, 0.001, 0.001, true) > MAX_BATCH_WINDOWS);
});

test("uses exact manual image dimensions and reports familiar aspect ratios", () => {
  assert.deepEqual(resolveImageDimensions({ width: 1920, height: 1080 }), {
    width: 1920, height: 1080, autoHeight: false, rowHeight: 32,
  });
  assert.equal(formatAspectRatio(1920, 1080), "16:9");
  assert.equal(formatAspectRatio(1600, 1200), "4:3");
});

test("auto height preserves width and adds one row per visible channel", () => {
  const channels33 = resolveImageDimensions({
    width: 1800, autoHeight: true, rowHeight: 30, channelCount: 33, style: "training",
  });
  const channels100 = resolveImageDimensions({
    width: 1800, autoHeight: true, rowHeight: 30, channelCount: 100, style: "training",
  });
  assert.equal(channels33.width, channels100.width);
  assert.equal(channels33.height, 33 * 30 + 28);
  assert.equal(channels100.height, 100 * 30 + 28);
});

test("viewer auto height reserves extra room for its event track", () => {
  const plain = resolveImageDimensions({ autoHeight: true, rowHeight: 32, channelCount: 10, style: "viewer" });
  const withEvents = resolveImageDimensions({
    autoHeight: true, rowHeight: 32, channelCount: 10, style: "viewer", showEvents: true,
  });
  assert.equal(withEvents.height - plain.height, 92);
});

test("formats preview PNG sizes for the metadata bar", () => {
  assert.equal(formatFileSize(900), "900 B");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(2.25 * 1024 * 1024), "2.3 MB");
});

test("keeps export label size explicit and bounded", () => {
  assert.equal(resolveLabelSize(14), 14);
  assert.equal(resolveLabelSize(2), 6);
  assert.equal(resolveLabelSize(80), 32);
  assert.equal(resolveLabelSize("invalid"), 12);
});
