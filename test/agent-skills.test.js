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

test("list_agent_skills can read every skill body at once with includeBodies", async () => {
  const reads = [];
  const host = {
    getAgentConfiguration: () => ({ skills: { enabled: ["b"] } }),
    skills: {
      list: async () => ({ skills: [{ name: "a", title: "A" }, { name: "b", title: "B" }] }),
      read: async (name) => { reads.push(name); return { name, markdown: `# ${name} body` }; },
    },
  };

  const plain = await runToolCall(host, { name: "list_agent_skills", arguments: {} }, null);
  assert.equal(plain.ok, true);
  assert.equal(plain.result.includedBodies, false);
  assert.equal(plain.result.skills[0].markdown, undefined);
  assert.equal(reads.length, 0);

  const full = await runToolCall(host, { name: "list_agent_skills", arguments: { includeBodies: true } }, null);
  assert.equal(full.ok, true);
  assert.equal(full.result.includedBodies, true);
  assert.deepEqual(full.result.skills.map((s) => s.markdown), ["# a body", "# b body"]);
  assert.equal(full.result.skills[1].enabled, true);
  assert.deepEqual(reads, ["a", "b"]);
});

test("skill-write tools are serialized writes, not concurrency safe", () => {
  for (const name of ["create_agent_skill", "update_agent_skill"]) {
    const def = getToolDefinition(name);
    assert.ok(def, `${name} should be registered`);
    assert.equal(def.access, "write");
    assert.equal(def.concurrencySafe, false);
  }
});

test("creating a skill is blocked unless the turn authorizes skill writes", async () => {
  let created = false;
  const host = { skills: { create: async () => { created = true; return { name: "x" }; } } };
  const blocked = await runToolCall(host, {
    name: "create_agent_skill",
    arguments: { name: "center-a", description: "d", body: "# x" },
  }, null, {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /skill/i);
  assert.equal(created, false);
});

test("EEG-Master authors and saves a skill when skill writes are authorized", async () => {
  const received = [];
  const host = {
    skills: {
      create: async (payload) => {
        received.push(payload);
        return { name: payload.name, title: "Center A", source: "user", triggers: ["center-a"] };
      },
    },
  };
  const saved = await runToolCall(host, {
    name: "create_agent_skill",
    arguments: {
      name: "center-a", title: "Center A",
      description: "When reviewing center A recordings.",
      body: "# Center A\n\nUse bounded evidence before reporting.",
    },
  }, null, { skillWrite: true });

  assert.equal(saved.ok, true);
  assert.equal(saved.result.saved, true);
  assert.equal(saved.result.operation, "create");
  assert.equal(saved.result.skill.name, "center-a");
  assert.equal(received[0].body, "# Center A\n\nUse bounded evidence before reporting.");
});

test("updating a skill routes to host.skills.update under authorization", async () => {
  const host = {
    skills: { update: async (name, payload) => ({ name, title: payload.title || name, source: "user" }) },
  };
  const updated = await runToolCall(host, {
    name: "update_agent_skill",
    arguments: { name: "center-a", title: "Center A v2", body: "# v2" },
  }, null, { skillWrite: true });

  assert.equal(updated.ok, true);
  assert.equal(updated.result.operation, "update");
  assert.equal(updated.result.skill.name, "center-a");
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
