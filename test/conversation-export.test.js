import test from "node:test";
import assert from "node:assert/strict";

import { buildHTML } from "../agent/web/conversation-export.js";

const conv = {
  title: "Seizure screen",
  log: [
    { kind: "user", text: "Find candidate windows and save the workflow." },
    { kind: "assistant", text: "Working on it." },
    { kind: "tool", name: "signal_query", args: { op: "search", metric: "lineLength" }, outcome: { ok: true, result: { windows: [] } } },
    { kind: "tool", name: "read_agent_skill", args: { name: "skill-creator" }, outcome: { ok: true, result: { markdown: "x" } } },
    { kind: "tool", name: "create_agent_skill", args: { name: "center-review" }, outcome: { ok: false, error: "blocked" } },
  ],
};

test("exported HTML uses the quiet timeline with tagged skill rows", () => {
  const html = buildHTML(conv, { model: "gpt-5.5" });
  // skill tool rows carry the clay data-kind + an inline skill tag
  assert.match(html, /data-kind="skill"/);
  assert.match(html, /class="tool-kind">skill</);
  assert.match(html, /Using skill · skill-creator/);
  // non-skill tool rows are plain
  assert.match(html, /data-kind="tool"/);
});

test("exported HTML drops the old colored status pills for quiet glyphs", () => {
  const html = buildHTML(conv, {});
  assert.match(html, /tool-done-check/);              // a check, not a "Done" pill
  assert.doesNotMatch(html, /<span class="tool-state">Done<\/span>/);
  assert.match(html, /tool-chev/);                    // expand affordance present
  // an errored tool call still surfaces, expanded
  assert.match(html, /data-status="error"[^>]* open/);
});
