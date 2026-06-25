import test from "node:test";
import assert from "node:assert/strict";

import { runToolCall } from "../agent/web/tools.js";

function createWindowedHost({ signalQueryResult, runPythonResult } = {}) {
  const calls = { signalQuery: [], runPython: [], renderImages: 0 };
  const host = {
    calls,
    signal: {
      getState: () => ({ loaded: true, windowed: true }),
      getView: () => ({ startSec: 10, endSec: 20, durationSec: 120, fs: 200 }),
      resolveChannel: (ref) => (Number.isInteger(ref) ? ref : ref === "Fp1" ? 0 : null),
      getChannelMeta: (index) => ({ label: index === 0 ? "Fp1" : `ch${index}`, group: "EEG" }),
    },
    signalQuery: async (spec) => {
      calls.signalQuery.push(spec);
      return signalQueryResult || {
        windows: [{ channel: 0, label: "Fp1", startSec: 12, endSec: 15, score: 3.2, features: { p2p: 42 } }],
        meta: { exact: false },
        channels: [{ index: 0, label: "Fp1", rms: 1.5 }],
      };
    },
    runPython: async (code, signal, window) => {
      calls.runPython.push({ code, window });
      return runPythonResult || { ok: true, result: { p2p: 42 }, stdout: "done\n" };
    },
    artifacts: {
      renderImages: async () => {
        calls.renderImages++;
        return { result: { imageCount: 1, mode: "windowed-short-window" }, attachments: [] };
      },
    },
  };
  return host;
}

test("rank_channels uses signal_query search for windowed recordings", async () => {
  const host = createWindowedHost();
  const result = await runToolCall(host, {
    name: "rank_channels",
    arguments: { metric: "peakToPeak", limit: 3 },
  }, null);

  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.signalQuery, [{ op: "search", metric: "p2p", limit: 3 }]);
  assert.equal(result.result[0].label, "Fp1");
  assert.equal(result.result[0].startSec, 12);
});

test("inspect_time_window uses signal_query aggregate and preserves exactness", async () => {
  const host = createWindowedHost({
    signalQueryResult: {
      meta: { exact: false },
      channels: [{ index: 0, label: "Fp1", rms: 2.25 }],
    },
  });
  const result = await runToolCall(host, {
    name: "inspect_time_window",
    arguments: { startSec: 30, endSec: 45, channels: ["Fp1"] },
  }, null);

  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.signalQuery, [{ op: "aggregate", startSec: 30, endSec: 45, channels: [0] }]);
  assert.equal(result.result.exact, false);
  assert.equal(result.result.channels[0].rms, 2.25);
});

test("signal_query returns a workflow hint for indexed large-recording analysis", async () => {
  const host = createWindowedHost({ signalQueryResult: { windows: [], meta: { exact: true } } });
  const result = await runToolCall(host, {
    name: "signal_query",
    arguments: { op: "search", metric: "rms", limit: 4 },
  }, null);

  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.signalQuery, [{ op: "search", metric: "rms", limit: 4 }]);
  assert.match(result.result.workflowHint, /run_python\(startSec,endSec\)/);
});

test("windowed run_python requires bounded startSec/endSec", async () => {
  const host = createWindowedHost();
  const result = await runToolCall(host, {
    name: "run_python",
    arguments: { code: "result = {'ok': True}" },
  }, null);

  assert.equal(result.ok, false);
  assert.equal(host.calls.runPython.length, 0);
  assert.match(result.error, /startSec\/endSec/);
  assert.match(result.error, /signal_query/);
});

test("windowed run_python forwards bounds and reports exact window metadata", async () => {
  const host = createWindowedHost();
  const result = await runToolCall(host, {
    name: "run_python",
    arguments: { code: "result = {'p2p': 42}", startSec: 12, endSec: 15 },
  }, null);

  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.runPython[0].window, { startSec: 12, endSec: 15 });
  assert.equal(result.result.windowed, true);
  assert.equal(result.result.exact, true);
  assert.deepEqual(result.result.window, { startSec: 12, endSec: 15, durationSec: 3 });
});

test("windowed internal image rendering remains available without export authorization", async () => {
  const host = createWindowedHost();
  const result = await runToolCall(host, {
    name: "render_signal_images",
    arguments: { scope: "range", range: { startSec: 12, endSec: 15 } },
  }, null, { export: false });

  assert.equal(result.ok, true);
  assert.equal(host.calls.renderImages, 1);
  assert.equal(result.result.mode, "windowed-short-window");
});
