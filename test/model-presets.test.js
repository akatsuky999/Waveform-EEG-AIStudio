import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_MODEL_GROUPS, AI_MODEL_PRESETS, DEFAULT_AI_BASE_URL, QWEN_AGENT_MODELS,
} from "../agent/web/prompt.js";

const EXPECTED_QWEN_AGENT_MODELS = [
  "qwen3.7-max",
  "qwen3.6-plus",
  "qwen3.6-flash",
];

test("provider base URL is empty until the user explicitly configures one", () => {
  assert.equal(DEFAULT_AI_BASE_URL, "");
});

test("Qwen agent group contains only undated 3.6+ relay IDs", () => {
  assert.deepEqual(QWEN_AGENT_MODELS, EXPECTED_QWEN_AGENT_MODELS);
  assert.deepEqual(
    AI_MODEL_GROUPS.find((group) => group.label === "Alibaba · Qwen 3.6+")?.models,
    EXPECTED_QWEN_AGENT_MODELS,
  );
});

test("model presets contain no duplicate IDs", () => {
  const grouped = AI_MODEL_GROUPS.flatMap((group) => group.models);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.equal(AI_MODEL_PRESETS.length, grouped.length);
});

test("compact model catalog follows the requested family thresholds", () => {
  const expected = [
    "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro",
    "gpt-5.4-mini", "gpt-5.4-nano",
    "claude-opus-4-8", "claude-opus-4-8-thinking",
    "claude-opus-4-7", "claude-opus-4-7-thinking",
    "claude-opus-4-6", "claude-opus-4-6-thinking",
    "claude-sonnet-4-6", "claude-sonnet-4-6-thinking",
    "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-thinking",
    ...EXPECTED_QWEN_AGENT_MODELS,
  ];
  assert.deepEqual(AI_MODEL_PRESETS, expected);
});

test("model catalog excludes dated IDs and unrelated families", () => {
  AI_MODEL_PRESETS.forEach((model) => assert.equal(/-20\d{2}-\d{2}-\d{2}(?:$|-)/.test(model), false, model));
  const allowedPrefixes = ["gpt-5.4", "gpt-5.5", "claude-opus-4-", "claude-sonnet-4-6", "gemini-3.1-pro", "qwen3.6", "qwen3.7"];
  AI_MODEL_PRESETS.forEach((model) => {
    assert.equal(allowedPrefixes.some((prefix) => model.startsWith(prefix)), true, model);
  });
});

test("the selector always offers exactly the four curated families", () => {
  // The dropdown is built from AI_MODEL_GROUPS directly (plus a Custom option),
  // so testing a provider can never drop a family — the previous bug where GPT
  // and Qwen vanished after a /models refresh that omitted their exact IDs.
  assert.deepEqual(
    AI_MODEL_GROUPS.map((group) => group.label),
    ["OpenAI · GPT 5.4+", "Anthropic · Claude 4.6+", "Google · Gemini 3.1 Pro+", "Alibaba · Qwen 3.6+"],
  );
  // every family is non-empty so it always renders
  AI_MODEL_GROUPS.forEach((group) => assert.equal(group.models.length > 0, true, group.label));
});
