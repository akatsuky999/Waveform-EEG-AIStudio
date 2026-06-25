import test from "node:test";
import assert from "node:assert/strict";

import { runToolCall } from "../agent/web/tools.js";
import { getToolDefinition } from "../agent/web/tool-definitions.js";

test("skill tools are read-only and concurrency safe", () => {
  assert.equal(getToolDefinition("list_agent_skills").access, "read");
  assert.equal(getToolDefinition("list_agent_skills").concurrencySafe, true);
  assert.equal(getToolDefinition("read_agent_skill").access, "read");
  assert.equal(getToolDefinition("read_agent_skill").concurrencySafe, true);
});

test("EEG-Master can list and read curated EEG skills", async () => {
  const calls = [];
  const host = {
    skills: {
      list: async () => {
        calls.push(["list"]);
        return { skills: [{ name: "long-ieeg-seizure-localization", title: "Long iEEG" }] };
      },
      read: async (name) => {
        calls.push(["read", name]);
        return { name, markdown: "# Skill body" };
      },
    },
  };

  const listed = await runToolCall(host, { name: "list_agent_skills", arguments: {} }, null);
  assert.equal(listed.ok, true);
  assert.equal(listed.result.skills[0].name, "long-ieeg-seizure-localization");

  const read = await runToolCall(host, {
    name: "read_agent_skill",
    arguments: { name: "long-ieeg-seizure-localization" },
  }, null);
  assert.equal(read.ok, true);
  assert.equal(read.result.markdown, "# Skill body");
  assert.deepEqual(calls, [["list"], ["read", "long-ieeg-seizure-localization"]]);
});
