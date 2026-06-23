import test from "node:test";
import assert from "node:assert/strict";

import {
  createConversation, getActiveId, getConversation, saveConversation,
} from "../agent/web/conversations.js";

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("saved image messages restore as valid text content", async () => {
  installStorage();
  const conversation = createConversation();
  conversation.transcript.push({
    role: "user",
    content: [
      { type: "text", text: "Inspect this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  });
  saveConversation(conversation);

  const restored = await getConversation(conversation.id);
  assert.deepEqual(restored.transcript[0].content[1], {
    type: "text",
    text: "[image omitted from saved transcript]",
  });
});

test("legacy invalid image placeholders are migrated when read", async () => {
  installStorage();
  const conversation = createConversation();
  conversation.transcript.push({
    role: "user",
    content: [{ type: "image_url", image_url: { url: "[image omitted from history]" } }],
  });
  saveConversation(conversation);
  assert.equal((await getConversation(conversation.id)).transcript[0].content[0].type, "text");
});

test("background conversation saves do not steal active selection", async () => {
  installStorage();
  const active = createConversation();
  active.log.push({ kind: "user", text: "active" });
  saveConversation(active);
  const background = createConversation();
  background.log.push({ kind: "user", text: "background" });
  saveConversation(background, { activate: false });

  assert.equal(getActiveId(), active.id);
  assert.equal((await getConversation(background.id)).log[0].text, "background");
});
