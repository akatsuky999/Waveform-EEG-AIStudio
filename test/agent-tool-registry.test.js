import test from "node:test";
import assert from "node:assert/strict";

import { EEG_TOOLS, TOOL_DEFINITIONS, getToolDefinition, resolveToolName } from "../agent/web/tool-definitions.js";

test("tool registry is the single schema source and exposes only canonical names", () => {
  assert.deepEqual(EEG_TOOLS.map((tool) => tool.function.name), TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.equal(new Set(TOOL_DEFINITIONS.map((tool) => tool.name)).size, TOOL_DEFINITIONS.length);
  assert.equal(EEG_TOOLS.some((tool) => tool.function.name === "capture_waveform_view"), false);
});

test("legacy tool names resolve without being exposed", () => {
  assert.equal(resolveToolName("get_current_context"), "get_signal_workspace_state");
  assert.equal(resolveToolName("mark_events"), "manage_signal_events");
  assert.equal(resolveToolName("capture_waveform_view"), "render_signal_images");
});

test("read tools are concurrent and persistent side effects are marked destructive", () => {
  assert.equal(getToolDefinition("inspect_channel").concurrencySafe, true);
  assert.equal(getToolDefinition("control_signal_view").concurrencySafe, false);
  assert.equal(getToolDefinition("manage_signal_events").destructive, true);
  assert.equal(getToolDefinition("open_signal_source").destructive, true);
  assert.equal(getToolDefinition("export_signal_artifact").destructive, true);
});
