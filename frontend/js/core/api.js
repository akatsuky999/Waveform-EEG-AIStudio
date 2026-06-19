// api.js — backend calls that return decoded {header, channels}.

import { parseEnvelope } from "./parse.js";

async function decode(res) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Failed to read file.");
  }
  return parseEnvelope(await res.arrayBuffer());
}

/** Upload a file to /api/parse → {header, channels}. */
export async function fetchParsed(file, { signal } = {}) {
  const fd = new FormData();
  fd.append("file", file);
  return decode(await fetch("/api/parse", { method: "POST", body: fd, signal }));
}

/** Load the bundled sample window → {header, channels}. */
export async function fetchSample({ signal } = {}) {
  return decode(await fetch("/api/sample", { signal }));
}

export async function requestExport(path, arrays, config, { signal } = {}) {
  if (!arrays?.length) throw new Error("No channels are available for export.");
  const form = signalForm(arrays, config);
  const response = await fetch(path, { method: "POST", body: form, signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 404 || response.status === 405) {
      throw new Error("Export service is not loaded. Restart EEGViewer with ./run.sh and retry.");
    }
    throw new Error(payload.error || response.statusText || "Export failed");
  }
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return { blob: await response.blob(), fileName: match?.[1] || "waveform-export" };
}

export async function requestImageSet(arrays, config, { signal } = {}) {
  if (!arrays?.length) throw new Error("No channels are available for rendering.");
  const response = await fetch("/api/render/images", {
    method: "POST", body: signalForm(arrays, config), signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || response.statusText || "Image rendering failed");
  return payload;
}

function signalForm(arrays, config) {
  const nSamples = arrays[0].length;
  const packed = new Float32Array(arrays.length * nSamples);
  arrays.forEach((array, index) => packed.set(array.subarray(0, nSamples), index * nSamples));
  const form = new FormData();
  form.append("data", new Blob([packed.buffer], { type: "application/octet-stream" }), "signals.f32");
  form.append("config", JSON.stringify({ ...config, nChannels: arrays.length, nSamples, dtype: "float32", layout: "channelMajor" }));
  return form;
}
