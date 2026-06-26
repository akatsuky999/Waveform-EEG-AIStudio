import test from "node:test";
import assert from "node:assert/strict";

import { runToolCall } from "../agent/web/tools.js";
import { getToolDefinition } from "../agent/web/tool-definitions.js";
import { skillToDocument } from "../agent/web/skills-client.js";

test("skill tools are read-only and concurrency safe", () => {
  assert.equal(getToolDefinition("list_agent_skills").access, "read");
  assert.equal(getToolDefinition("list_agent_skills").concurrencySafe, true);
  assert.equal(getToolDefinition("read_agent_skill").access, "read");
  assert.equal(getToolDefinition("read_agent_skill").concurrencySafe, true);
});

test("EEG-Master can list and read local EEG skills", async () => {
  const calls = [];
  const host = {
    getAgentConfiguration: () => ({ skills: { enabled: ["long-ieeg-seizure-localization"] } }),
    skills: {
      list: async () => {
        calls.push(["list"]);
        return { skills: [{ name: "long-ieeg-seizure-localization", title: "Long iEEG", source: "user" }] };
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
  assert.equal(listed.result.skills[0].source, "user");
  assert.equal(listed.result.skills[0].enabled, true);

  const read = await runToolCall(host, {
    name: "read_agent_skill",
    arguments: { name: "long-ieeg-seizure-localization" },
  }, null);
  assert.equal(read.ok, true);
  assert.equal(read.result.markdown, "# Skill body");
  assert.deepEqual(calls, [["list"], ["read", "long-ieeg-seizure-localization"]]);
});

test("skill export serializes Markdown frontmatter for user skills", () => {
  const text = skillToDocument({
    name: "center-a-prior",
    title: "Center A Prior",
    description: "Artifact-first center prior.",
    version: "1.0",
    category: "center",
    triggers: ["center-a", "发作定位"],
    tags: ["iEEG"],
    allowedTools: ["signal_query", "run_python"],
    markdown: "# Center A Prior\n\nUse bounded evidence before reporting.",
  });

  assert.match(text, /^---\nname: center-a-prior/m);
  assert.match(text, /triggers:\n  - center-a\n  - 发作定位/m);
  assert.match(text, /allowed_tools:\n  - signal_query\n  - run_python/m);
  assert.match(text, /# Center A Prior\n\nUse bounded evidence before reporting\./m);
});
