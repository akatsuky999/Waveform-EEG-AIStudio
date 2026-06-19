// controls.js — display (gain, row height), montage, frequency filters, and
// n-th differencing controls.

import { $, formatGain, gainFromSlider } from "../core/util.js";
import { filterGain } from "../viewer/dsp.js";

const DIFF_HINTS = [
  "Raw signal — each higher order plots the discrete derivative, emphasising progressively faster transients.",
  "1st difference Δx[i] = x[i+1] − x[i]. Approximates the first derivative; removes slow drift / DC offset.",
  "2nd difference — discrete acceleration. Sharpens spikes & curvature, suppresses linear trends.",
  "3rd difference — strongly high-pass; fast oscillations dominate.",
  "4th difference — extreme high-pass for isolating very-high-frequency content.",
];

export function initControls(ctx) {
  const viewer = ctx.viewer;
  let filterTimer = null;

  // Paint a two-tone fill (filled accent up to the thumb) via a CSS custom prop.
  function paintRange(el) {
    const min = +el.min || 0, max = +el.max || 100;
    const pct = max > min ? ((+el.value - min) / (max - min)) * 100 : 0;
    el.style.setProperty("--p", `${Math.max(0, Math.min(100, pct))}%`);
  }

  $("gain").addEventListener("input", (e) => {
    const mult = gainFromSlider(e.target.value);
    viewer.setGain(mult);
    $("gainVal").textContent = formatGain(mult);
    paintRange(e.target);
  });
  $("row").addEventListener("input", (e) => {
    const px = parseInt(e.target.value, 10);
    viewer.setRowHeight(px);
    $("rowVal").textContent = px + " px";
    paintRange(e.target);
  });
  paintRange($("gain"));
  paintRange($("row"));

  function setMontage(mode) {
    $("montageMode").value = mode;
    viewer.setMontageMode(mode);
    ctx.buildLegend(viewer.baseHeader || viewer.header);
  }
  $("montageMode").addEventListener("change", (e) => setMontage(e.target.value));

  function currentFilterOpts() {
    return { low: $("filterLow").value, high: $("filterHigh").value, notch: $("filterNotch").value };
  }
  function applyFilter() {
    viewer.setFilter(currentFilterOpts());
    renderFilterResponse();
    syncPresetActive();
  }
  function queueFilterUpdate() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 140);
  }
  // Programmatic filter setter (used by the agent): sync inputs then apply.
  function setFilter({ low, high, notch } = {}) {
    if (low !== undefined && low !== null) $("filterLow").value = +low > 0 ? String(low) : "";
    if (high !== undefined && high !== null) $("filterHigh").value = +high > 0 ? String(high) : "";
    if (notch) $("filterNotch").value = notch;
    applyFilter();
  }
  $("filterLow").addEventListener("input", queueFilterUpdate);
  $("filterHigh").addEventListener("input", queueFilterUpdate);
  $("filterNotch").addEventListener("change", queueFilterUpdate);

  // ---- clinical presets ----
  $("filterPresets").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-low]");
    if (!btn) return;
    $("filterLow").value = +btn.dataset.low > 0 ? btn.dataset.low : "";
    $("filterHigh").value = +btn.dataset.high > 0 ? btn.dataset.high : "";
    if (btn.dataset.notch === "off") $("filterNotch").value = "off";
    applyFilter();
  });
  function presetMatches(btn) {
    const low = parseFloat($("filterLow").value) || 0;
    const high = parseFloat($("filterHigh").value) || 0;
    const bl = parseFloat(btn.dataset.low) || 0;
    const bh = parseFloat(btn.dataset.high) || 0;
    if (btn.dataset.notch === "off") return low === 0 && high === 0 && $("filterNotch").value === "off";
    return low === bl && high === bh;
  }
  function syncPresetActive() {
    document.querySelectorAll("#filterPresets button").forEach((b) =>
      b.classList.toggle("active", presetMatches(b)));
  }

  // ---- filter frequency-response curve ----
  function renderFilterResponse() {
    const canvas = $("filterResponse");
    if (!canvas) return;
    const fs = viewer.fs || 256;
    const nyq = fs / 2;
    const opts = currentFilterOpts();
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 248;
    const h = canvas.clientHeight || 48;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cssVar = (v, f) => (getComputedStyle(document.documentElement).getPropertyValue(v).trim() || f);
    const accent = cssVar("--accent", "#c75f3e");
    const grid = cssVar("--line", "#e3dfd2");
    const soft = cssVar("--ink-soft", "#6b6760");
    const top = 4, bot = h - 11, span = bot - top;

    // freq gridlines + ticks every ~quarter Nyquist
    g.strokeStyle = grid; g.lineWidth = 1; g.font = '8px "JetBrains Mono", monospace'; g.fillStyle = soft;
    g.textAlign = "center"; g.textBaseline = "top";
    for (let i = 1; i <= 3; i++) {
      const x = (i / 4) * w;
      g.globalAlpha = 0.5; g.beginPath(); g.moveTo(x, top); g.lineTo(x, bot); g.stroke(); g.globalAlpha = 1;
      g.fillText(`${Math.round((i / 4) * nyq)}`, x, bot + 1);
    }
    g.textAlign = "left"; g.fillText("Hz", 1, bot + 1);

    const yAt = (px) => bot - filterGain((px / w) * nyq, fs, opts) * span;
    // filled passband
    g.beginPath(); g.moveTo(0, bot);
    for (let px = 0; px <= w; px++) g.lineTo(px, yAt(px));
    g.lineTo(w, bot); g.closePath();
    g.fillStyle = "rgba(199,95,62,0.13)"; g.fill();
    // response line
    g.beginPath();
    for (let px = 0; px <= w; px++) { const y = yAt(px); px === 0 ? g.moveTo(px, y) : g.lineTo(px, y); }
    g.strokeStyle = accent; g.lineWidth = 1.6; g.lineJoin = "round"; g.stroke();
  }
  ctx.renderFilterResponse = renderFilterResponse;
  ctx.repaintSliders = () => { paintRange($("gain")); paintRange($("row")); };
  renderFilterResponse();

  function setDiff(n) {
    viewer.setDiffOrder(n);
    syncDiff(n);
  }
  function syncDiff(n) {
    document.querySelectorAll("#diffSeg button").forEach((b) => b.classList.toggle("active", +b.dataset.n === n));
    $("diffHint").textContent = DIFF_HINTS[n] || "";
  }
  document.querySelectorAll("#diffSeg button").forEach((b) =>
    b.addEventListener("click", () => setDiff(+b.dataset.n)));

  ctx.setDiff = setDiff;
  ctx.setMontage = setMontage;
  ctx.setFilter = setFilter;
  ctx.syncControlsFromViewer = () => {
    $("gain").value = String(Math.log10(viewer.gainMult || 1));
    $("gainVal").textContent = formatGain(viewer.gainMult);
    $("row").value = String(Math.round(viewer.rowPx));
    $("rowVal").textContent = `${Math.round(viewer.rowPx)} px`;
    $("montageMode").value = viewer.montageMode;
    $("filterLow").value = Number(viewer.filterOpts.low) > 0 ? String(viewer.filterOpts.low) : "";
    $("filterHigh").value = Number(viewer.filterOpts.high) > 0 ? String(viewer.filterOpts.high) : "";
    $("filterNotch").value = viewer.filterOpts.notch || "off";
    syncDiff(viewer.diffOrder);
    syncPresetActive();
    ctx.repaintSliders();
    renderFilterResponse();
  };
  return { setDiff, setMontage, setFilter };
}
