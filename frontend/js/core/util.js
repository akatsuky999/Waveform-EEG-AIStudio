// util.js — small shared helpers (DOM, formatting, downloads).

export const DEFAULT_GAIN_LOG10 = 0;

export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function css(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function round(n) { return Math.round(n * 100) / 100; }
export function fmtFreq(f) { return f < 10 ? f.toFixed(1) : f.toFixed(0); }

export function gainFromSlider(value) {
  const log10 = Number(value);
  return Math.pow(10, Number.isFinite(log10) ? log10 : DEFAULT_GAIN_LOG10);
}

export function formatGain(mult) {
  if (!Number.isFinite(mult) || mult <= 0) return "1.0×";
  if (mult < 0.1) return `${mult.toFixed(2)}×`;
  if (mult < 10) return `${mult.toFixed(1)}×`;
  if (mult < 100) return `${mult.toFixed(0)}×`;
  return `${Math.round(mult).toLocaleString("en-US")}×`;
}

export function downloadText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  downloadUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadDataUrl(url, name) { downloadUrl(url, name); }

export function downloadUrl(url, name) {
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
