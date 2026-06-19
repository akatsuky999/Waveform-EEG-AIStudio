export const MAX_AGENT_DETAIL_IMAGES = 4;
export const MAX_AGENT_IMAGES = 5;

function clampRange(range, duration) {
  const start = Math.max(0, Math.min(duration, Number(range?.startSec)));
  const end = Math.max(0, Math.min(duration, Number(range?.endSec)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("Each image range needs finite startSec/endSec with endSec > startSec.");
  }
  return { startSec: start, endSec: end };
}
function batchWindows(batch, duration) {
  const start = Number.isFinite(Number(batch?.startSec)) ? Math.max(0, Number(batch.startSec)) : 0;
  const end = Number.isFinite(Number(batch?.endSec)) ? Math.min(duration, Number(batch.endSec)) : duration;
  const windowSec = Number(batch?.windowSec);
  const stepSec = Number(batch?.stepSec ?? batch?.windowSec);
  if (!(end > start) || !(windowSec > 0) || !(stepSec > 0)) {
    throw new Error("batch needs a valid range plus positive windowSec and stepSec.");
  }
  const windows = [];
  for (let cursor = start; cursor < end - 1e-9 && windows.length < 500; cursor += stepSec) {
    windows.push({ startSec: cursor, endSec: Math.min(end, cursor + windowSec) });
  }
  if (!windows.length) throw new Error("Batch settings produced no image windows.");
  let indices = Array.isArray(batch.indices)
    ? [...new Set(batch.indices.filter((index) => Number.isInteger(index) && index >= 0 && index < windows.length))].slice(0, MAX_AGENT_DETAIL_IMAGES)
    : [];
  if (!indices.length) {
    const count = Math.min(MAX_AGENT_DETAIL_IMAGES, windows.length);
    indices = Array.from({ length: count }, (_value, index) =>
      count === 1 ? 0 : Math.round(index * (windows.length - 1) / (count - 1)));
  }
  return { windows: indices.map((index) => ({ ...windows[index], batchIndex: index })), totalWindows: windows.length };
}

export function buildSignalImagePlan({ scope, duration, currentRange, range, detailRanges, batch } = {}) {
  const total = Number(duration);
  if (!(total > 0)) throw new Error("A loaded signal with positive duration is required.");
  const full = { role: "overview", startSec: 0, endSec: total };
  let views;
  let totalWindows = null;
  if (scope === "full") views = [full];
  else if (scope === "current") views = [{ role: "detail", ...clampRange(currentRange, total) }];
  else if (scope === "range") views = [{ role: "detail", ...clampRange(range, total) }];
  else if (scope === "multiscale") {
    const details = (detailRanges || []).slice(0, MAX_AGENT_DETAIL_IMAGES)
      .map((item) => ({ role: "detail", ...clampRange(item, total) }));
    views = [full, ...details];
  } else if (scope === "batch") {
    const resolved = batchWindows(batch, total);
    totalWindows = resolved.totalWindows;
    views = resolved.windows.map((item) => ({ role: "detail", ...item }));
  } else throw new Error(`Unsupported image scope: ${scope}`);
  if (views.length > MAX_AGENT_IMAGES) throw new Error(`Agent image sets are limited to ${MAX_AGENT_IMAGES} images.`);
  return { views: views.map((view, index) => ({ index, ...view })), totalWindows };
}
