import test from "node:test";
import assert from "node:assert/strict";

import { runToolCall } from "../agent/web/tools.js";

test("EEG-Master mark_events creates one canonical interval", async () => {
  const calls = [];
  const host = {
    workspace: { manageEvents(operation, events) { calls.push({ operation, events }); return { operation, changed: events, eventCount: 1 }; } },
  };
  const result = await runToolCall(host, {
    name: "mark_events",
    arguments: { events: [{ onsetSec: 1.2, offsetSec: 4.8, label: "seizure" }] },
  }, null, { annotation: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ operation: "add", events: [{ onsetSec: 1.2, offsetSec: 4.8, label: "seizure" }] }]);
  assert.equal(result.result.eventCount, 1);
});

test("EEG-Master mark_events keeps point annotations as points", async () => {
  const calls = [];
  const host = { workspace: { manageEvents(operation, events) { calls.push({ operation, events }); return { eventCount: 1 }; } } };
  const result = await runToolCall(host, {
    name: "mark_events",
    arguments: { events: [{ onsetSec: 2, label: "spike" }] },
  }, null, { annotation: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ operation: "add", events: [{ onsetSec: 2, label: "spike" }] }]);
});

test("event writes are blocked without explicit per-turn authorization", async () => {
  let called = false;
  const host = { workspace: { manageEvents() { called = true; } } };
  const result = await runToolCall(host, {
    name: "manage_signal_events",
    arguments: { operation: "add", events: [{ onsetSec: 2, label: "candidate" }] },
  }, null, { annotation: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not explicitly request annotation/);
  assert.equal(called, false);
});

test("run_python returns marker output as candidates without applying events", async () => {
  const host = {
    runPython: async () => ({ ok: true, result: { count: 1 }, markers: [{ timeSec: 3, label: "legacy" }] }),
  };
  const result = await runToolCall(host, { name: "run_python", arguments: { code: "result = {}" } });
  assert.equal(result.ok, true);
  assert.equal(result.result.eventsApplied, 0);
  assert.deepEqual(result.result.eventCandidates, [{ timeSec: 3, label: "legacy" }]);
});
