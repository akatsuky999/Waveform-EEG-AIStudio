// controls.js — display (gain, row height), montage, frequency filters, and
// n-th differencing controls.

import { $, formatGain, gainFromSlider } from "../core/util.js";
import { drawFilterResponse } from "./filter-response.js";
import { MONTAGE_PRESENTATION } from "./workspace-presentation.js";

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
    renderMontageSummary();
  }
  function renderMontageSummary() {
    const mode = viewer.montageMode || "raw";
    const presentation = MONTAGE_PRESENTATION[mode] || MONTAGE_PRESENTATION.raw;
    $("montageEquation").textContent = presentation.equation;
    $("montageDescription").textContent = presentation.description;
    $("montageKind").textContent = mode === "raw" ? "Original" : "Derived";
    $("montageOutput").textContent = viewer.header ? String(viewer.nChannels) : "—";
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
  $("filterNotchOptions").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-notch]");
    if (button) setFilter({ notch: button.dataset.notch });
  });

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
    document.querySelectorAll("#filterPresets button").forEach((b) => {
      const active = presetMatches(b);
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    document.querySelectorAll("#filterNotchOptions button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.notch === $("filterNotch").value)));
  }

  // ---- calibrated frequency-response display (presentation only) ----
  function renderFilterResponse() {
    const canvas = $("filterResponse");
    if (!canvas) return;
    const model = drawFilterResponse(canvas, viewer.fs || 256, currentFilterOpts(), Boolean(viewer.header));
    $("filterBandReadout").textContent = model.range;
    $("filterBandUnit").textContent = model.unit;
    $("filterState").textContent = model.active ? "Active" : "Bypass";
    $("filterState").dataset.active = String(model.active);
    $("filterModeLabel").textContent = model.mode;
    $("filterNyquist").textContent = viewer.header ? `Nyquist ${Number(model.nyquist.toFixed(2))} Hz` : "Load a recording";
    $("filterRangeNote").textContent = viewer.header ? model.note : "";
    $("filterRangeNote").hidden = !viewer.header || !model.note;
  }
  ctx.renderFilterResponse = renderFilterResponse;
  ctx.repaintSliders = () => { paintRange($("gain")); paintRange($("row")); };
  renderFilterResponse();
  syncPresetActive();
  // Repaint at the actual sidebar width after resizing or expanding the panel.
  new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.contentRect.width > 0)) renderFilterResponse();
  }).observe($("filterResponse"));

  function setDiff(n) {
    viewer.setDiffOrder(n);
    syncDiff(n);
  }
  function syncDiff(n) {
    document.querySelectorAll("#diffSeg button").forEach((b) => {
      b.classList.toggle("active", +b.dataset.n === n);
      b.setAttribute("aria-pressed", String(+b.dataset.n === n));
    });
    $("diffHint").textContent = DIFF_HINTS[n] || "";
    $("diffReadout").textContent = ["Original signal", "First difference", "Second difference", "Third difference", "Fourth difference"][n] || "";
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
    renderMontageSummary();
    syncDiff(viewer.diffOrder);
    syncPresetActive();
    ctx.repaintSliders();
    renderFilterResponse();
  };
  return { setDiff, setMontage, setFilter };
}
