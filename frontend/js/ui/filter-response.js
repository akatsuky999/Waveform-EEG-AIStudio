import { filterGain } from "../viewer/dsp.js";

const positive = (value) => Math.max(0, Number.parseFloat(value) || 0);
const hz = (value) => Number(value.toFixed(2)).toString();

// Presentation only: never clamps or rewrites the viewer's filter settings.
export function describeFilter(fs, opts = {}) {
  const nyquist = fs / 2;
  const low = positive(opts.low), high = positive(opts.high);
  const notch = ["50", "60"].includes(opts.notch) ? Number(opts.notch) : 0;
  const active = Boolean(low || high || notch);
  const range = low && high ? `${hz(low)}–${hz(high)}` : low ? `≥ ${hz(low)}` : high ? `≤ ${hz(high)}` : "Full spectrum";
  const mode = low && high ? "Band-pass" : low ? "High-pass" : high ? "Low-pass" : notch ? "Notch only" : "Unity gain";
  let note = "";
  if (low && high && low >= high) note = "Low cut should be below high cut.";
  else if (low >= nyquist) note = `Low cut is at or above Nyquist (${hz(nyquist)} Hz). Choose a lower cutoff.`;
  else if (high > nyquist) note = `Requested high cut exceeds Nyquist. This recording only contains frequencies up to ${hz(nyquist)} Hz.`;
  else if (notch && notch > nyquist) note = `${notch} Hz is above this recording’s Nyquist limit.`;
  return { nyquist, low, high, notch, active, range, unit: low || high ? "Hz" : "", mode, note };
}

export function drawFilterResponse(canvas, fs, opts, hasData = true) {
  const model = describeFilter(fs, opts);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 248, h = canvas.clientHeight || 108;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const style = getComputedStyle(document.documentElement);
  const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const accent = color("--accent", "#c75f3e"), soft = color("--ink-soft", "#6b6760");
  const line = color("--line", "#e3dfd2"), paper = color("--ws-card", "#fdfcf7");
  const left = 23, right = w - 5, top = 10, bottom = h - 22;
  const width = Math.max(1, right - left), height = bottom - top;
  const xAt = (f) => left + f / model.nyquist * width;
  const yAt = (f) => bottom - filterGain(f, fs, opts) * height;
  g.font = `8px ${color("--mono", "monospace")}`;
  g.textBaseline = "middle"; g.textAlign = "left";
  for (const gain of [0, .5, 1]) {
    const y = bottom - gain * height;
    g.fillStyle = soft; g.fillText(gain === 1 ? "1.0" : String(gain), 0, y);
    g.strokeStyle = line; g.lineWidth = .7; g.setLineDash(gain === .5 ? [2, 3] : []);
    g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
  }
  g.setLineDash([]);
  for (let i = 0; i <= 4; i++) {
    const x = left + width * i / 4;
    g.strokeStyle = line; g.lineWidth = .7;
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom + 3); g.stroke();
    if (hasData) {
      g.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      g.fillStyle = soft;
      g.fillText(hz(model.nyquist * i / 4), x, bottom + 13);
    }
  }
  if (!hasData) { g.textAlign = "center"; g.fillStyle = soft; g.fillText("Frequency · Hz", (left + right) / 2, bottom + 13); }
  const path = () => {
    for (let px = 0; px <= Math.ceil(width); px++) {
      const f = Math.min(1, px / width) * model.nyquist;
      const x = Math.min(right, left + px), y = yAt(f);
      px ? g.lineTo(x, y) : g.moveTo(x, y);
    }
  };
  if (model.active) {
    g.beginPath(); path(); g.lineTo(right, bottom); g.lineTo(left, bottom); g.closePath();
    const fill = g.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, "rgba(199,95,62,.16)"); fill.addColorStop(1, "rgba(199,95,62,.015)");
    g.fillStyle = fill; g.fill();
  }
  g.beginPath(); path(); g.strokeStyle = model.active ? accent : soft;
  g.lineWidth = model.active ? 1.6 : 1.1; g.lineJoin = "round";
  g.setLineDash(model.active ? [] : [4, 3]); g.stroke(); g.setLineDash([]);
  // The markers sample the very same gain function as the waveform filter.
  for (const f of [model.low, model.high]) {
    if (!(f > 0 && f < model.nyquist)) continue;
    const x = xAt(f), y = yAt(f);
    g.strokeStyle = accent; g.lineWidth = .7; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x, bottom); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fillStyle = paper; g.fill();
    g.lineWidth = 1.1; g.stroke();
  }
  canvas.setAttribute("aria-label", hasData
    ? `Filter frequency response: ${model.range}${model.unit ? " Hz" : ""}, ${model.mode}${model.notch ? `, ${model.notch} Hz notch and harmonics` : ""}. Linear gain 0 to 1, frequency 0 to ${hz(model.nyquist)} Hz.`
    : "Filter frequency response preview. Load a recording for its frequency scale.");
  return model;
}
