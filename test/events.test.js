import test from "node:test";
import assert from "node:assert/strict";

import {
  createEvent, eventIntersects, legacyMarkersFromEvents, normalizeEvents, serializeEventsDocument,
} from "../frontend/js/core/events.js";

test("normalizes point and interval events into one model", () => {
  const events = normalizeEvents([
    { label: "later", timeSec: 4 },
    { label: "seizure", onsetSec: 1.25, offsetSec: 3.75, source: "ai" },
  ], { duration: 10 });
  assert.equal(events[0].type, "interval");
  assert.equal(events[0].offsetSec, 3.75);
  assert.equal(events[1].type, "point");
  assert.equal(events[1].offsetSec, null);
});

test("clamps event boundaries and rejects backwards intervals as points", () => {
  const event = createEvent({ onsetSec: -2, offsetSec: -1, label: "<unsafe>" }, { duration: 5 });
  assert.equal(event.onsetSec, 0);
  assert.equal(event.type, "point");
  assert.equal(event.label, "unsafe");
});

test("derives legacy onset/offset markers without losing the canonical interval", () => {
  const [event] = normalizeEvents([{ id: "a", label: "ictal", onsetSec: 2, offsetSec: 6 }]);
  const markers = legacyMarkersFromEvents([event]);
  assert.deepEqual(markers.map((marker) => marker.time), [2, 6]);
  assert.equal(markers[1].eventId, "a");
});

test("serializes versioned events and keeps timeSec for point compatibility", () => {
  const point = createEvent({ id: "p", timeSec: 1.5, label: "spike" });
  const document = serializeEventsDocument([point], "sample.edf");
  assert.equal(document.version, 2);
  assert.equal(document.events[0].timeSec, 1.5);
  assert.equal(document.events[0].offsetSec, null);
});

test("detects interval overlap at both window boundaries", () => {
  const event = createEvent({ onsetSec: 4, offsetSec: 8 });
  assert.equal(eventIntersects(event, 1, 4), true);
  assert.equal(eventIntersects(event, 8, 10), true);
  assert.equal(eventIntersects(event, 8.01, 10), false);
});
