// analysis-panel.js — the floating spectrum / spectrogram / band-power panel.

import { $, css, escapeHtml, fmtFreq } from "../core/util.js";

const BAND_META = [
  ["delta", "δ", "0.5-4"],
  ["theta", "θ", "4-8"],
  ["alpha", "α", "8-13"],
  ["beta", "β", "13-30"],
  ["gamma", "γ", "30-80"],
];

export function initAnalysisPanel(ctx) {
  const viewer = ctx.viewer;
  let analysisMode = "spectrum";
  let analysisOpen = false;

  function renderSelected(analysis) {
    if (!analysis) {
      $("selectedCard").textContent = "No channel selected";
      setAnalysisOpen(false);
      return;
    }
    const freq = analysis.stats?.freq;
    $("selectedCard").innerHTML =
      `<b>${escapeHtml(analysis.label)}</b>` +
      `${escapeHtml(analysis.group)} · <span class="accent">${Number.isFinite(freq) ? fmtFreq(freq) + " Hz" : "—"}</span>`;
    renderAnalysis(analysis);
  }

  function renderAnalysis(analysis) {
    if (!analysis || !analysisOpen) return;
    $("analysisTitle").textContent = analysis.label;
    $("analysisSub").textContent = analysisMode === "spectrum" ? "Dominant spectrum" : "Short-time spectrum";
    drawBandBars(analysis.stats?.bands || {});
    drawMeasureStats(analysis.measurement);
    if (analysisMode === "spectrogram") drawSpectrogram(analysis.spectrogram);
    else drawSpectrum(analysis.spectrum);
  }

  function setAnalysisOpen(open) {
    analysisOpen = !!open;
    $("analysisPanel").classList.toggle("hidden", !analysisOpen);
    $("analysisBtn").classList.toggle("active", analysisOpen);
    if (analysisOpen) {
      ctx.setSidebarActive?.("controls");
      renderAnalysis(viewer.getSelectedAnalysis());
      requestAnimationFrame(() => $("analysisPanel").scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
  }

  function setAnalysisMode(mode) {
    if (!["spectrum", "spectrogram"].includes(mode)) return;
    analysisMode = mode;
    document.querySelectorAll("#analysisTabs button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    renderAnalysis(viewer.getSelectedAnalysis());
  }

  function drawSpectrum(spec) {
    const canvas = $("analysisCanvas");
    const c = prepCanvas(canvas);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    clearMiniPlot(c, W, H);
    if (!spec || !spec.freqs.length) return;
    const maxP = spec.maxPower || 1;
    c.strokeStyle = css("--accent", "#c75f3e");
    c.lineWidth = 1.6;
    c.beginPath();
    for (let i = 0; i < spec.freqs.length; i++) {
      const x = 34 + (spec.freqs[i] / 80) * (W - 48);
      const y = H - 24 - Math.sqrt(spec.powers[i] / maxP) * (H - 38);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    drawMiniAxes(c, W, H, "Hz");
  }

  function drawSpectrogram(sg) {
    const canvas = $("analysisCanvas");
    const c = prepCanvas(canvas);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    clearMiniPlot(c, W, H);
    if (!sg || !sg.frames.length || !sg.freqs.length) return;
    const left = 34, top = 10, width = W - 48, height = H - 34;
    const maxP = sg.maxPower || 1;
    const cellW = width / sg.frames.length;
    const cellH = height / sg.freqs.length;
    for (let x = 0; x < sg.frames.length; x++) {
      const pows = sg.frames[x].powers;
      for (let y = 0; y < sg.freqs.length; y++) {
        const v = Math.sqrt((pows[y] || 0) / maxP);
        c.fillStyle = heat(v);
        c.fillRect(left + x * cellW, top + height - (y + 1) * cellH, Math.ceil(cellW), Math.ceil(cellH));
      }
    }
    drawMiniAxes(c, W, H, "time");
  }

  function drawBandBars(bands) {
    $("bandBars").innerHTML = BAND_META.map(([id, label, range]) => {
      const pct = Math.round((bands[id] || 0) * 100);
      return `<div class="band">${label} ${pct}%<div class="track"><div class="fill" style="width:${pct}%"></div></div><span>${range}</span></div>`;
    }).join("");
  }

  function drawMeasureStats(m) {
    const wrap = $("measureStats");
    if (!m) { wrap.innerHTML = `<div>Drag in measure mode<span>—</span></div>`; return; }
    wrap.innerHTML =
      `<div>Duration<span>${m.duration.toFixed(3)}s</span></div>` +
      `<div>P-P<span>${m.p2p.toFixed(2)}</span></div>` +
      `<div>RMS<span>${m.rms.toFixed(2)}</span></div>` +
      `<div>Freq<span>${Number.isFinite(m.freq) ? fmtFreq(m.freq) + "Hz" : "—"}</span></div>`;
  }

  $("analysisBtn").addEventListener("click", () => setAnalysisOpen(!analysisOpen));
  $("analysisClose").addEventListener("click", () => setAnalysisOpen(false));
  document.querySelectorAll("#analysisTabs button").forEach((b) =>
    b.addEventListener("click", () => setAnalysisMode(b.dataset.mode)));

  ctx.renderSelected = renderSelected;
  ctx.renderAnalysis = renderAnalysis;
  ctx.setAnalysisOpen = setAnalysisOpen;
  ctx.setAnalysisMode = setAnalysisMode;
  return { renderSelected, renderAnalysis, setAnalysisOpen, setAnalysisMode };
}

// ---- mini-plot canvas helpers -------------------------------------------
function prepCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function clearMiniPlot(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = css("--paper", "#fff");
  ctx.fillRect(0, 0, W, H);
}

function drawMiniAxes(ctx, W, H, label) {
  ctx.strokeStyle = css("--line", "#e3dfd2");
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(34.5, 8); ctx.lineTo(34.5, H - 23.5); ctx.lineTo(W - 10, H - 23.5); ctx.stroke();
  ctx.fillStyle = css("--ink-soft", "#6b6760");
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(label, W - 42, H - 8);
  ctx.fillText("80", W - 28, H - 27);
}

function heat(v) {
  const a = Math.max(0, Math.min(1, v));
  const r = Math.round(245 * a + 250 * (1 - a));
  const g = Math.round(120 * a + 249 * (1 - a));
  const b = Math.round(84 * a + 244 * (1 - a));
  return `rgb(${r},${g},${b})`;
}
