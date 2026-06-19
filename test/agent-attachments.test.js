import test from "node:test";
import assert from "node:assert/strict";

import { attachmentUserMessage } from "../agent/web/agent.js";

test("image attachments become one ordered multimodal message capped at five", () => {
  const message = attachmentUserMessage(Array.from({ length: 7 }, (_value, index) => ({
    kind: "image", dataUrl: `data:image/png;base64,${index}`, label: `view ${index}`,
  })));
  assert.equal(message.role, "user");
  assert.equal(message.content.filter((part) => part.type === "image_url").length, 5);
  assert.match(message.content[0].text, /view 0/);
  assert.match(message.content[0].text, /view 4/);
  assert.doesNotMatch(message.content[0].text, /view 5/);
});
