// api.js — backend calls that return decoded {header, channels} for small files,
// or {windowed, meta, dataToken} for large recordings served by the LoD store.

import { parseEnvelope, parseWindowTile } from "./parse.js";

async function decode(res) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Failed to read file.");
  }
  // Large recordings come back as JSON metadata (no payload); the viewer then
  // pulls render-ready tiles on demand from /api/signal/window.
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    const json = await res.json();
    if (json.windowed) return { windowed: true, meta: json.meta, dataToken: json.dataToken };
    throw new Error(json.error || "Unexpected response from server.");
  }
  return parseEnvelope(await res.arrayBuffer());
}

/** Fetch one render tile (min/max columns, or raw samples on deep zoom) via the
 *  unified query endpoint the agent also uses. */
export async function fetchWindow(token, startSec, endSec, maxColumns, channels, { signal } = {}) {
  const body = { token, op: "render", startSec, endSec, maxColumns };
  if (channels && channels.length) body.channels = channels;
  const res = await fetch("/api/signal/query", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to fetch signal window.");
  }
  return parseWindowTile(await res.arrayBuffer());
}

/** Stream a large recording straight to the out-of-core store (the file body is
 *  streamed by the browser — never read whole into memory) and poll until ready.
 *  Returns {windowed, meta, dataToken}. */
export async function streamIngest(file, { onProgress, signal } = {}) {
  const res = await fetch(`/api/signal/ingest?name=${encodeURIComponent(file.name)}`, {
    method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" }, signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Upload failed.");
  }
  const { token } = await res.json();
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const status = await (await fetch(`/api/signal/status?token=${token}`, { signal })).json();
    onProgress?.(status);
    if (status.state === "ready") break;
    if (status.state === "error") throw new Error(status.error || "Ingest failed.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const meta = await (await fetch(`/api/signal/meta?token=${token}`, { signal })).json();
  return { windowed: true, dataToken: meta.dataToken || token, meta: meta.meta };
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
