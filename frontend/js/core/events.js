// Canonical point/interval event helpers. Kept DOM-free so the model can be
// shared by the viewer, exports, the agent bridge, and unit tests.

let sequence = 0;

export function createEvent(input = {}, { duration = Infinity, fallbackLabel = "Event" } = {}) {
  const rawOnset = numberOr(input.onsetSec ?? input.timeSec ?? input.time ?? input.startSec, 0);
  const onsetSec = clamp(rawOnset, 0, duration);
  const rawOffset = numberOrNull(input.offsetSec ?? input.endSec ?? input.end);
  const hasInterval = rawOffset !== null && rawOffset > onsetSec;
  const offsetSec = hasInterval ? clamp(rawOffset, onsetSec, duration) : null;
  const type = hasInterval || input.type === "interval" ? "interval" : "point";
  const normalizedOffset = type === "interval"
    ? Math.max(onsetSec, offsetSec ?? onsetSec)
    : null;
  return {
    id: String(input.id ?? `ev-${Date.now().toString(36)}-${(++sequence).toString(36)}`),
    type,
    label: sanitizeLabel(input.label || fallbackLabel),
    onsetSec,
    offsetSec: normalizedOffset,
    source: String(input.source || "manual"),
  };
}

export function normalizeEvents(events, options = {}) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => createEvent(event, { ...options, fallbackLabel: event?.label || `Event ${index + 1}` }))
    .sort(compareEvents);
}

export function compareEvents(a, b) {
  return a.onsetSec - b.onsetSec
    || (a.offsetSec ?? a.onsetSec) - (b.offsetSec ?? b.onsetSec)
    || String(a.id).localeCompare(String(b.id));
}

export function eventIntersects(event, startSec, endSec) {
  const end = event.type === "interval" ? (event.offsetSec ?? event.onsetSec) : event.onsetSec;
  return end >= startSec && event.onsetSec <= endSec;
}

export function legacyMarkersFromEvents(events) {
  const markers = [];
  for (const event of events || []) {
    markers.push({
      id: event.id,
      eventId: event.id,
      time: event.onsetSec,
      timeSec: event.onsetSec,
      label: event.label,
      source: event.source,
    });
    if (event.type === "interval" && Number.isFinite(event.offsetSec) && event.offsetSec > event.onsetSec) {
      markers.push({
        id: `${event.id}:offset`,
        eventId: event.id,
        time: event.offsetSec,
        timeSec: event.offsetSec,
        label: `${event.label} ▸end`,
        source: event.source,
      });
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

export function serializeEventsDocument(events, fileName = "") {
  return {
    version: 2,
    fileName,
    events: (events || []).map((event) => ({
      id: String(event.id),
      type: event.type,
      label: event.label,
      onsetSec: event.onsetSec,
      offsetSec: event.type === "interval" ? event.offsetSec : null,
      source: event.source || "manual",
      ...(event.type === "point" ? { timeSec: event.onsetSec } : {}),
    })),
  };
}

function sanitizeLabel(value) {
  return String(value || "Event").replace(/[<>]/g, "").trim().slice(0, 120) || "Event";
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(Number.isFinite(high) ? high : value, value));
}
