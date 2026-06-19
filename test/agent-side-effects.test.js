import test from "node:test";
import assert from "node:assert/strict";

import { runToolCall } from "../agent/web/tools.js";

test("source switching is hard-gated by the current user turn", async () => {
  let opened = 0;
  const host = { project: { openSource: async () => { opened++; return { loaded: true }; } } };
  const blocked = await runToolCall(host, {
    name: "open_signal_source", arguments: { source: "sample" },
  }, null, { fileSwitch: false });
  assert.equal(blocked.ok, false);
  assert.equal(opened, 0);

  const allowed = await runToolCall(host, {
    name: "open_signal_source", arguments: { source: "sample" },
  }, null, { fileSwitch: true });
  assert.equal(allowed.ok, true);
  assert.equal(opened, 1);
});

test("downloads are hard-gated while internal image rendering remains available", async () => {
  let exported = 0;
  let rendered = 0;
  const host = {
    artifacts: {
      exportArtifact: async () => { exported++; return { downloaded: true }; },
      renderImages: async () => { rendered++; return { result: { imageCount: 1 }, attachments: [] }; },
    },
  };
  const blocked = await runToolCall(host, {
    name: "export_signal_artifact", arguments: { format: "h5" },
  }, null, { export: false });
  assert.equal(blocked.ok, false);
  assert.equal(exported, 0);

  const observed = await runToolCall(host, {
    name: "render_signal_images", arguments: { scope: "current" },
  }, null, {});
  assert.equal(observed.ok, true);
  assert.equal(rendered, 1);
});
