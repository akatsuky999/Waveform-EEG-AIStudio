// viewer.js — WebGL multi-channel waveform renderer built on Three.js.
//
// Vertical model
// --------------
// Every channel gets a FIXED on-screen row height (`rowPx`). The total content
// height is nChannels * rowPx, so when there are more channels than fit, you
// scroll vertically (wheel, drag, or the scrollbar) — channels are never
// squashed to fit one screen.
//
// Coordinate model
// ----------------
//   world X = sample index            (time = X / fs)
//   world Y = -channelIndex           (channel 0 at top, increasing downward)
// Each channel is a THREE.Line whose local geometry is (x=i, y=value); the line
// sits at position.y = -channelIndex and is scaled by scale.y = gainWorld so
// amplitude is independent of vertical scroll. An OrthographicCamera frames the
// visible window; a 2-D overlay canvas draws all chrome at any DPI.

import * as THREE from "three";
import { nthDifference, normalizeChannel, globalStats, std, median, NORM_METHODS } from "../core/parse.js";
import {
  BANDS, BAND_LABELS, analyzeSignal, spectrumFor, spectrogramFor,
  applyFrequencyFilter, measureRange,
} from "./dsp.js";
import { buildMontage, montageLabel } from "./montage.js";
import {
  compareEvents, createEvent, legacyMarkersFromEvents, serializeEventsDocument,
} from "../core/events.js";
import { fetchWindow, fetchSamples } from "../core/api.js";

const GROUP_COLORS = ["#c45f3c", "#5f86b3", "#6f8350", "#b08240", "#8a6aa0", "#4f8a86", "#b5654a", "#7a7d52"];

// Windowed DSP budget: when filter/montage/norm/diff is active and the visible
// window's (samples × source-channels) fits this, we fetch the raw window and run
// the full pipeline on it; beyond it the overview stays an unprocessed LoD view.
const PROC_BUDGET_VALUES = 4_000_000;

const colorCache = new Map();
function toThreeColor(css) {
  if (!colorCache.has(css)) colorCache.set(css, new THREE.Color(css));
  return colorCache.get(css);
}

export class WaveformViewer {
  constructor(stageEl, glCanvas, overlayCanvas, eventTrackCanvas = null) {
    this.stage = stageEl;
    this.gl = glCanvas;
    this.overlay = overlayCanvas;
    this.octx = overlayCanvas.getContext("2d");
    this.eventTrack = eventTrackCanvas;
    this.eventCtx = eventTrackCanvas?.getContext("2d") || null;

    this.renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);

    // data
    this.header = null;
    this.baseHeader = null;
    this.baseRawChannels = [];
    this.rawChannels = [];
    this.dispChannels = [];
    this.channelMeta = [];
    this.channelFreqs = [];
    this.channelStats = [];
    this.lines = [];
    this.groupColor = new Map();
    this.channelColor = [];
    this.hiddenGroups = new Set();
    this.hiddenChannels = new Set();
    this.visibleChannels = [];
    this.channelToRow = new Map();
    this.selectedChannel = null;
    this.soloChannel = null;
    this.pinnedChannel = null;
    this.channelSearch = "";
    this.channelSort = "file";
    this.montageMode = "raw";
    this.filterOpts = { low: 0, high: 0, notch: "off" };
    this.events = [];
    this.markers = []; // legacy projection; events are the source of truth
    this.measureMode = false;
    this.markerMode = false;
    this.measureRange = null;
    this.fileContext = { projectName: "", relativePath: "" };

    // geometry / layout
    this.gutter = 124;  // left margin for channel labels (px)
    this.axisH = 22;    // band for time-axis labels (px)
    this.hbarH = 16;    // bottom lane reserved for the horizontal scrollbar (px)
    this.vbarW = 14;    // right lane reserved for the vertical scrollbar (px)
    this.rowPx = 46;    // fixed channel row height (px)
    this._cam = { left: 0, right: 1, top: 1, bottom: 0 };

    // view / signal state
    this.fs = 256;
    this.nSamples = 0;
    this.nChannels = 0;
    this.duration = 0;
    this.tStart = 0;
    this.tEnd = 0;
    this.chTop = 0;
    this.gainMult = 1;
    this.autoGainWorld = 1;
    this.diffOrder = 0;
    this.normMethod = "none";
    this.normOpts = { mmRange: "sym", robLow: 25 };

    // Windowed (out-of-core) mode — set by setWindowedData for large recordings.
    // The viewer then holds only `meta` + the current render tile, fetching new
    // tiles from /api/signal/window on pan/zoom instead of all samples.
    this.windowed = false;
    this.windowToken = null;
    this.windowMeta = null;
    this.tile = null;           // current parsed tile { header, data }
    this._tileSeq = 0;          // drops stale async tile responses
    this._tileTimer = null;
    this._tileRange = null;     // [start,end] the current geometry was requested for
    this._tileCache = new Map();// small LRU of recent tiles
    // Processed-window sub-mode: when DSP is active and the window fits the budget,
    // we load the raw window and run the full pipeline on it (filter/montage/norm/
    // diff + frequency analysis). `_sampleOffset` shifts geometry X to absolute time.
    this._procMode = false;
    this._sampleOffset = 0;
    this._srcModel = null;      // saved source-channel model (to restore in tile mode)

    this.mouse = { x: -1, y: -1, inside: false };
    this.onReadout = null;
    this.onView = null; // notified after view changes (for external UI)
    this.onSelectionChange = null;
    this.onAnalysisChange = null;
    this.onMarkersChange = null;
    this.onEventsChange = null;
    this.onEventEditRequest = null;
    this.onChannelsChange = null;

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(stageEl);
    this._buildScrollbars();
    this._bindInteractions();
    this._bindEventTrack();
  }

  // Beautiful DOM scrollbars for panning the time (x) and channel (y) viewport.
  _buildScrollbars() {
    const mk = (cls) => {
      const track = document.createElement("div");
      track.className = "scrollbar " + cls;
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      track.appendChild(thumb);
      this.stage.appendChild(track);
      return { track, thumb };
    };
    this.sbV = mk("sb-v");
    this.sbH = mk("sb-h");
    this._bindScrollbarDrag(this.sbV, "v");
    this._bindScrollbarDrag(this.sbH, "h");
  }

  _bindScrollbarDrag(sb, axis) {
    let start = 0, startVal = 0;
    // keep scrollbar interaction from triggering the stage's pan/crosshair
    sb.track.addEventListener("mousedown", (e) => e.stopPropagation());
    const onMove = (e) => {
      if (axis === "v") {
        const usable = this._sbV.trackLen - this._sbV.thumbLen || 1;
        this.chTop = startVal + ((e.clientY - start) / usable) * this.maxScroll;
        this._clampChannels();
      } else {
        const span = this.tEnd - this.tStart;
        const usable = this._sbH.trackLen - this._sbH.thumbLen || 1;
        const maxT = Math.max(0, this.duration - span);
        this.tStart = startVal + ((e.clientX - start) / usable) * maxT;
        this.tEnd = this.tStart + span;
        this._clampTime();
      }
      this.render();
    };
    const onUp = () => {
      sb.track.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    sb.thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      sb.track.classList.add("dragging");
      start = axis === "v" ? e.clientY : e.clientX;
      startVal = axis === "v" ? this.chTop : this.tStart;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    // click on the track (not the thumb) pages by one viewport
    sb.track.addEventListener("pointerdown", (e) => {
      if (e.target === sb.thumb) return;
      if (axis === "v") {
        const before = (e.offsetY < this._sbV.thumbPos);
        this.chTop += (before ? -1 : 1) * this.visTracks * 0.9;
        this._clampChannels();
      } else {
        const span = this.tEnd - this.tStart;
        const before = (e.offsetX < this._sbH.thumbPos);
        const d = (before ? -1 : 1) * span * 0.9;
        this.tStart += d; this.tEnd += d; this._clampTime();
      }
      this.render();
    });
  }

  // --------------------------------------------------------------- data load
  setData(header, channels, { preserveSettings = false } = {}) {
    // Leaving windowed mode (e.g. small sample after a large recording): stop any
    // pending tile fetches and clear windowed state so the full-array path owns rendering.
    this.windowed = false;
    this.windowToken = null;
    this.windowMeta = null;
    this.tile = null;
    this._tileRange = null;
    this._procMode = false;
    this._sampleOffset = 0;
    this._srcModel = null;
    this._tileSeq++;            // invalidate any in-flight windowed fetch
    clearTimeout(this._tileTimer);
    const settings = preserveSettings ? {
      diffOrder: this.diffOrder,
      normMethod: this.normMethod,
      normOpts: { ...this.normOpts },
      gainMult: this.gainMult,
      rowPx: this.rowPx,
      montageMode: this.montageMode,
      filterOpts: { ...this.filterOpts },
    } : null;
    this.baseHeader = header;
    this.header = header;
    this.fs = header.fs || 256;
    this.nSamples = header.nSamples;
    this.duration = header.durationSec || header.nSamples / this.fs;
    this.baseRawChannels = channels;

    this.groupColor.clear();
    header.groups.forEach((g, i) => this.groupColor.set(g, GROUP_COLORS[i % GROUP_COLORS.length]));

    this.diffOrder = settings?.diffOrder ?? 0;
    this.normMethod = settings?.normMethod ?? "none";
    this.normOpts = settings?.normOpts ?? { mmRange: "sym", robLow: 25 };
    this.gainMult = settings?.gainMult ?? 1;
    this.rowPx = settings?.rowPx ?? 46;
    this.hiddenGroups.clear();
    this.hiddenChannels.clear();
    this.selectedChannel = 0;
    this.soloChannel = null;
    this.pinnedChannel = null;
    this.channelSearch = "";
    this.channelSort = "file";
    this.montageMode = settings?.montageMode ?? "raw";
    this.filterOpts = settings?.filterOpts ?? { low: 0, high: 0, notch: "off" };
    this.events = [];
    this.markers = [];
    this.measureRange = null;
    this.measureMode = false;
    this.markerMode = false;
    const requestedMontage = this.montageMode;
    this._rebuildSourceChannels({ fallbackInvalidMontage: preserveSettings });
    this.resetView();
    this._emitSelection();
    this._emitEvents();
    return { montageFallback: requestedMontage !== "raw" && this.montageMode === "raw" };
  }

  // ---- windowed (out-of-core) data path -----------------------------------
  // Large recordings never load all samples. We keep `meta` + the current tile
  // and pull render-ready min/max columns (or a raw window on deep zoom) from the
  // server LoD store, so the on-screen geometry is always ~screen-width — payload
  // and vertex count are independent of recording length.
  setWindowedData(meta, token) {
    this.windowed = true;
    this.windowToken = token;
    this.windowMeta = meta;
    this.baseHeader = meta;
    this.header = meta;
    this.fs = meta.fs || 256;
    this.nSamples = meta.nSamples;
    this.nDisp = meta.nSamples;
    this.duration = meta.durationSec || meta.nSamples / this.fs;
    this.nChannels = meta.nChannels;

    this.groupColor.clear();
    (meta.groups || []).forEach((g, i) => this.groupColor.set(g, GROUP_COLORS[i % GROUP_COLORS.length]));

    this.diffOrder = 0; this.normMethod = "none"; this.normOpts = { mmRange: "sym", robLow: 25 };
    this.gainMult = 1; this.montageMode = "raw"; this.filterOpts = { low: 0, high: 0, notch: "off" };
    this.hiddenGroups.clear(); this.hiddenChannels.clear();
    this.soloChannel = null; this.pinnedChannel = null; this.channelSearch = ""; this.channelSort = "file";
    this.selectedChannel = 0;
    this.events = []; this.markers = []; this.measureRange = null; this.measureMode = false; this.markerMode = false;

    this.channelMeta = (meta.channels || []).map((c, i) => ({
      label: c.label, group: c.group, sourceIndex: i, montage: "raw",
      std: c.std, min: c.min, max: c.max, mean: c.mean,
    }));
    this.channelColor = this.channelMeta.map((c) => this.groupColor.get(c.group) || GROUP_COLORS[0]);
    this.channelStats = this.channelMeta.map((c) => ({ rms: c.std, freq: 0, bands: {}, dominantBand: "" }));
    this.channelFreqs = this.channelStats.map(() => 0);
    this.dispChannels = []; // intentionally empty — geometry comes from tiles

    const robust = meta.globalStd
      || median(this.channelMeta.map((c) => c.std).filter((s) => s > 0)) || 1;
    this.autoGainWorld = 0.32 / robust;

    // Snapshot the source-channel model so tile (overview) mode can be restored
    // after a montage in processed-window mode changed the channel set.
    this._srcModel = {
      channelMeta: this.channelMeta, channelColor: this.channelColor,
      channelStats: this.channelStats, channelFreqs: this.channelFreqs,
      nChannels: this.nChannels, autoGainWorld: this.autoGainWorld,
    };
    this._procMode = false;
    this._sampleOffset = 0;

    for (const ln of this.lines) { ln.geometry.dispose(); ln.material.dispose(); this.scene.remove(ln); }
    this.lines = [];
    this._tileCache.clear();
    this._tileRange = null;
    this.tile = null;
    this._rebuildOrder();
    this.resetView();      // tStart=0, tEnd=duration, render()
    this._refreshWindowed(); // initial overview tile (or processed window if DSP on)
    this._emitSelection();
    this._emitChannels();
    this._emitEvents();
    return { montageFallback: false };
  }

  _maybeScheduleTile() {
    const r = this._tileRange;
    if (r) {
      const span = this.tEnd - this.tStart || 1;
      const same = Math.abs(this.tStart - r[0]) < span * 0.02 &&
                   Math.abs(this.tEnd - r[1]) < span * 0.02;
      if (same) return;
    }
    this._scheduleTile();
  }

  _scheduleTile() {
    clearTimeout(this._tileTimer);
    this._tileTimer = setTimeout(() => this._refreshWindowed(), 70);
  }

  async _fetchTile() {
    if (!this.windowed || !this.windowToken) return;
    const maxColumns = Math.max(64, Math.round(this.plotW || 1000));
    const t0 = this.tStart, t1 = this.tEnd;
    this._tileRange = [t0, t1];   // optimistic, so repeated renders don't reschedule
    const key = `${t0.toFixed(3)}|${t1.toFixed(3)}|${maxColumns}`;
    const seq = ++this._tileSeq;
    const cached = this._tileCache.get(key);
    if (cached) { this.tile = cached; this._buildLinesFromTile(); return; }
    try {
      const tile = await fetchWindow(this.windowToken, t0, t1, maxColumns, null);
      if (seq !== this._tileSeq) return; // a newer request superseded this one
      this._tileCache.set(key, tile);
      if (this._tileCache.size > 24) this._tileCache.delete(this._tileCache.keys().next().value);
      this.tile = tile;
      this._buildLinesFromTile();
    } catch (err) {
      if (err?.name !== "AbortError") { /* keep the previous geometry on a blip */ }
    }
  }

  _dspActive() {
    const fo = this.filterOpts;
    return (this.montageMode && this.montageMode !== "raw")
      || this.diffOrder > 0
      || (this.normMethod && this.normMethod !== "none")
      || !!(fo && (Number(fo.low) || Number(fo.high) || (fo.notch && fo.notch !== "off")));
  }

  // Windowed refresh: choose the processed raw window (if DSP is on and the window
  // fits the budget) or the unprocessed LoD tile (overview / no DSP).
  async _refreshWindowed() {
    if (!this.windowed || !this.windowToken) return;
    const spanSamples = Math.max(1, Math.round((this.tEnd - this.tStart) * this.fs));
    const nSource = this.windowMeta?.nChannels || (this._srcModel?.nChannels ?? this.nChannels);
    if (this._dspActive() && spanSamples * nSource <= PROC_BUDGET_VALUES) {
      return this._fetchProcessedWindow();
    }
    if (this._procMode) this._restoreSourceModel();
    this._procMode = false;
    this._sampleOffset = 0;
    this.dispChannels = [];
    return this._fetchTile();
  }

  // Restore the source-channel model after a montage in processed mode changed it.
  _restoreSourceModel() {
    const m = this._srcModel;
    if (!m) return;
    this.channelMeta = m.channelMeta;
    this.channelColor = m.channelColor;
    this.channelStats = m.channelStats;
    this.channelFreqs = m.channelFreqs;
    this.nChannels = m.nChannels;
    this.autoGainWorld = m.autoGainWorld;
    this.nSamples = this.windowMeta.nSamples;
    this.nDisp = this.nSamples;
    this.hiddenChannels.clear(); this.soloChannel = null; this.pinnedChannel = null;
    if (this.selectedChannel === null || this.selectedChannel >= this.nChannels) this.selectedChannel = 0;
    this._rebuildOrder();
  }

  // Load the visible raw window and run the EXISTING full pipeline on it, so
  // filter / montage / normalization / differencing — and frequency analysis —
  // all apply exactly. `_sampleOffset` shifts geometry X back to absolute time.
  async _fetchProcessedWindow() {
    const t0 = this.tStart, t1 = this.tEnd;
    this._tileRange = [t0, t1];
    const seq = ++this._tileSeq;
    let res;
    try {
      res = await fetchSamples(this.windowToken, t0, t1, null);
    } catch (err) {
      if (err?.name !== "AbortError") { /* keep previous geometry on a blip */ }
      return;
    }
    if (seq !== this._tileSeq) return;
    const wasProc = this._procMode;
    this._procMode = true;
    this._sampleOffset = res.header.startSample;
    this.tile = null;
    this.baseRawChannels = res.arrays;
    this.baseHeader = this.windowMeta;
    if (!wasProc) { this.hiddenChannels.clear(); this.soloChannel = null; this.pinnedChannel = null; }
    this._rebuildSourceChannels({ fallbackInvalidMontage: true }); // filter+montage → pipeline → lines
    if (this.selectedChannel === null || this.selectedChannel >= this.nChannels) this.selectedChannel = 0;
    this.render();
    this._emitSelection();
  }

  // Exact client-side DSP applied to a raw (deep-zoom) window. Montage is a
  // follow-up for large recordings; filter / difference / normalization are exact.
  _processWindow(sig, c) {
    let out = sig;
    const fo = this.filterOpts;
    if (fo && (Number(fo.low) || Number(fo.high) || (fo.notch && fo.notch !== "off"))) {
      out = applyFrequencyFilter(out, this.fs, fo);
    }
    if (this.diffOrder > 0) out = nthDifference(out, this.diffOrder);
    if (this.normMethod && this.normMethod !== "none") {
      const g = this.normMethod === "globalz"
        ? { mean: this.channelMeta[c]?.mean ?? 0, std: this.windowMeta?.globalStd || 1 } : null;
      out = normalizeChannel(out, this.normMethod, g, this.normOpts);
    }
    return out;
  }

  _buildLinesFromTile() {
    const tile = this.tile;
    if (!tile) return;
    for (const ln of this.lines) { ln.geometry.dispose(); ln.material.dispose(); this.scene.remove(ln); }
    this.lines = [];
    const h = tile.header, data = tile.data;
    const g = this.autoGainWorld * this.gainMult;
    for (let c = 0; c < this.nChannels; c++) {
      let line;
      if (h.mode === "raw") {
        const n = h.nSamples;
        const sig = this._processWindow(data.subarray(c * n, (c + 1) * n), c);
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { positions[i * 3] = h.startSample + i; positions[i * 3 + 1] = sig[i]; }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: toThreeColor(this.channelColor[c]) }));
      } else {
        // aggregate: a CONNECTED boustrophedon min/max envelope — alternate the
        // (min,max) order each column so consecutive columns join along the top /
        // bottom envelope. Clean channels read as a continuous line; busy channels
        // as a filled band — no disconnected "comb"/"grass" (vs old LineSegments).
        const nCols = h.nCols;
        const step = (h.endSample - h.startSample) / nCols;
        const positions = new Float32Array(nCols * 2 * 3);
        const base = c * nCols * 2;
        for (let j = 0; j < nCols; j++) {
          const x = h.startSample + j * step;
          const lo = data[base + j * 2], hi = data[base + j * 2 + 1];
          const k = j * 6;
          positions[k] = x; positions[k + 3] = x;
          if ((j & 1) === 0) { positions[k + 1] = lo; positions[k + 4] = hi; }
          else { positions[k + 1] = hi; positions[k + 4] = lo; }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: toThreeColor(this.channelColor[c]) }));
      }
      line.position.y = -c;
      line.scale.y = g;
      this.scene.add(line);
      this.lines.push(line);
    }
    this._applyVisibility();
    this.render();
  }

  // Representative value under the crosshair in windowed mode (no full arrays).
  _tileValueAt(c, sampleX) {
    const t = this.tile;
    if (!t) return null;
    const h = t.header, d = t.data;
    if (h.mode === "raw") {
      const i = Math.round(sampleX - h.startSample);
      if (i < 0 || i >= h.nSamples) return null;
      return d[c * h.nSamples + i];
    }
    const span = h.endSample - h.startSample;
    if (span <= 0) return null;
    const j = Math.floor((sampleX - h.startSample) / (span / h.nCols));
    if (j < 0 || j >= h.nCols) return null;
    const base = c * h.nCols * 2 + j * 2;
    return (d[base] + d[base + 1]) / 2;
  }

  _rebuildSourceChannels({ fallbackInvalidMontage = false } = {}) {
    if (!this.baseHeader) return;
    const filtered = this.baseRawChannels.map((a) => applyFrequencyFilter(a, this.fs, this.filterOpts));
    let chans = filtered;
    let meta = this.baseHeader.channels.map((c, i) => ({ ...c, sourceIndex: i }));

    if (this.montageMode !== "raw") {
      const montage = buildMontage(filtered, meta, this.montageMode);
      if (montage.channels.length) {
        chans = montage.channels;
        meta = montage.meta;
      } else if (fallbackInvalidMontage) {
        this.montageMode = "raw";
      }
    }

    this.rawChannels = chans;
    this.channelMeta = meta;
    this.nChannels = chans.length;
    this.nSamples = chans[0] ? chans[0].length : 0;
    this.channelColor = meta.map((c) => this.groupColor.get(c.group) || GROUP_COLORS[0]);
    if (this.selectedChannel !== null && this.selectedChannel >= this.nChannels) this.selectedChannel = this.nChannels ? 0 : null;
    this.hiddenChannels = new Set([...this.hiddenChannels].filter((c) => c < this.nChannels));
    if (this.soloChannel !== null && this.soloChannel >= this.nChannels) this.soloChannel = null;
    if (this.pinnedChannel !== null && this.pinnedChannel >= this.nChannels) this.pinnedChannel = null;
    this._applyPipeline();
    this._emitChannels();
  }

  setFileContext({ projectName = "", relativePath = "" } = {}) {
    this.fileContext = { projectName: String(projectName || ""), relativePath: String(relativePath || "") };
  }

  _applyPipeline() {
    let chans = this.rawChannels;
    if (this.diffOrder > 0) chans = chans.map((a) => nthDifference(a, this.diffOrder));
    if (this.normMethod && this.normMethod !== "none") {
      const gstats = this.normMethod === "globalz" ? globalStats(chans) : null;
      chans = chans.map((a) => normalizeChannel(a, this.normMethod, gstats, this.normOpts));
    }
    this.dispChannels = chans;
    this.nDisp = chans[0] ? chans[0].length : 0;
    this.channelStats = this.dispChannels.map((a) => analyzeSignal(a, this.fs));
    this.channelFreqs = this.channelStats.map((s) => s.freq);
    this._rebuildOrder();

    const stds = this.dispChannels.map((a) => std(a)).filter((s) => s > 0);
    const robust = median(stds) || 1;
    this.autoGainWorld = 0.32 / robust;
    this._buildLines();
    this._emitAnalysis();
  }

  _buildLines() {
    for (const ln of this.lines) { ln.geometry.dispose(); ln.material.dispose(); this.scene.remove(ln); }
    this.lines = [];
    const ox = this._sampleOffset || 0;  // absolute-time offset for a processed window (0 for whole-file)
    for (let c = 0; c < this.nChannels; c++) {
      const sig = this.dispChannels[c];
      const n = sig.length;
      const positions = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { positions[i * 3] = ox + i; positions[i * 3 + 1] = sig[i]; }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: toThreeColor(this.channelColor[c]) }));
      line.position.y = -c;
      line.scale.y = this.autoGainWorld * this.gainMult;
      this.scene.add(line);
      this.lines.push(line);
    }
    this._applyVisibility();
  }

  _applyVisibility() {
    const visible = new Set(this.visibleChannels);
    for (let c = 0; c < this.nChannels; c++) {
      const row = this.channelToRow.get(c);
      this.lines[c].visible = visible.has(c);
      if (row !== undefined) this.lines[c].position.y = -row;
    }
  }

  _rebuildOrder() {
    const q = this.channelSearch.trim().toLowerCase();
    let order = [];
    for (let c = 0; c < this.nChannels; c++) {
      const meta = this.channelMeta[c];
      if (!meta) continue;
      if (this.hiddenGroups.has(meta.group) || this.hiddenChannels.has(c)) continue;
      if (this.soloChannel !== null && c !== this.soloChannel) continue;
      if (q && !`${meta.label} ${meta.group}`.toLowerCase().includes(q)) continue;
      order.push(c);
    }

    if (this.channelSort === "group") {
      order.sort((a, b) => this.channelMeta[a].group.localeCompare(this.channelMeta[b].group) || a - b);
    } else if (this.channelSort === "freq") {
      order.sort((a, b) => (this.channelFreqs[b] || 0) - (this.channelFreqs[a] || 0));
    }

    if (this.pinnedChannel !== null && order.includes(this.pinnedChannel)) {
      order = [this.pinnedChannel, ...order.filter((c) => c !== this.pinnedChannel)];
    }

    this.visibleChannels = order;
    this.channelToRow = new Map(order.map((c, i) => [c, i]));
    this._clampChannels();
  }

  // ----------------------------------------------------------------- controls
  setGain(mult) {
    this.gainMult = Math.max(0.001, Math.min(Number(mult) || 1, 2000));
    const g = this.autoGainWorld * this.gainMult;
    for (const ln of this.lines) ln.scale.y = g;
    this.render();
  }

  setRowHeight(px) {
    const anchorCh = this.chTop + this.visTracks / 2; // keep the middle channel put
    this.rowPx = px;
    this.chTop = anchorCh - this.visTracks / 2;
    this._clampChannels();
    this.render();
  }

  setDiffOrder(n) {
    this.diffOrder = n;
    if (this.windowed) { this._refreshWindowed(); return; }
    this._applyPipeline();
    this.setGain(this.gainMult);
  }

  setNorm(method) {
    this.normMethod = method;
    if (this.windowed) { this._refreshWindowed(); return; }
    this._applyPipeline();
    this.setGain(this.gainMult);
  }

  setNormOpts(opts) {
    Object.assign(this.normOpts, opts);
    if (this.windowed) { this._refreshWindowed(); return; }
    this._applyPipeline();
    this.setGain(this.gainMult);
  }

  setFilter(opts) {
    Object.assign(this.filterOpts, opts);
    if (this.windowed) { this._refreshWindowed(); return; }
    this._rebuildSourceChannels();
    this.setGain(this.gainMult);
  }

  setMontageMode(mode) {
    this.montageMode = typeof mode === "boolean" ? (mode ? "bipolar" : "raw") : (mode || "raw");
    this.hiddenChannels.clear();
    this.soloChannel = null;
    this.pinnedChannel = null;
    this.selectedChannel = 0;
    // Large recording: montage applies on the processed window (when zoomed in);
    // at extreme overview it stays unprocessed with a "zoom in" badge.
    if (this.windowed) { this._refreshWindowed(); this._emitSelection(); return; }
    this._rebuildSourceChannels();
    this.resetView();
    this.setGain(this.gainMult);
    this._emitSelection();
  }

  setChannelSearch(query) {
    this.channelSearch = query || "";
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
  }

  setChannelSort(mode) {
    this.channelSort = mode || "file";
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
  }

  toggleGroup(group) {
    if (this.hiddenGroups.has(group)) this.hiddenGroups.delete(group);
    else this.hiddenGroups.add(group);
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
  }

  selectChannel(channel, scrollIntoView = false) {
    if (channel === null || channel === undefined || channel < 0 || channel >= this.nChannels) return;
    this.selectedChannel = channel;
    if (scrollIntoView) {
      const row = this.channelToRow.get(channel);
      if (row !== undefined) {
        if (row < this.chTop) this.chTop = row;
        else if (row > this.chTop + this.visTracks - 1) this.chTop = row - this.visTracks + 1;
        this._clampChannels();
      }
    }
    this.render();
    this._emitSelection();
  }

  toggleSoloSelected() {
    if (this.selectedChannel === null) return;
    this.soloChannel = this.soloChannel === this.selectedChannel ? null : this.selectedChannel;
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
  }

  hideSelected() {
    if (this.selectedChannel === null) return;
    this.hiddenChannels.add(this.selectedChannel);
    this.soloChannel = null;
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
  }

  togglePinSelected() {
    if (this.selectedChannel === null) return;
    this.pinnedChannel = this.pinnedChannel === this.selectedChannel ? null : this.selectedChannel;
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
  }

  clearChannelFocus() {
    this.hiddenChannels.clear();
    this.hiddenGroups.clear();
    this.soloChannel = null;
    this.pinnedChannel = null;
    this.channelSearch = "";
    this.channelSort = "file";
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
  }

  setChannelFocus(channels = []) {
    const selected = new Set((channels || []).filter((index) =>
      Number.isInteger(index) && index >= 0 && index < this.nChannels));
    if (!selected.size) {
      this.clearChannelFocus();
      return;
    }
    this.hiddenGroups.clear();
    this.soloChannel = null;
    this.pinnedChannel = null;
    this.channelSearch = "";
    this.hiddenChannels = new Set(
      Array.from({ length: this.nChannels }, (_value, index) => index)
        .filter((index) => !selected.has(index)),
    );
    if (!selected.has(this.selectedChannel)) this.selectedChannel = [...selected][0];
    this._rebuildOrder();
    this._applyVisibility();
    this.render();
    this._emitChannels();
    this._emitSelection();
  }

  setMeasureMode(on) {
    this.measureMode = !!on;
    if (this.measureMode) this.markerMode = false;
    this.render();
  }

  setMarkerMode(on) {
    this.markerMode = !!on;
    if (this.markerMode) this.measureMode = false;
    this.render();
  }

  addEvent(input = {}) {
    const event = createEvent(input, {
      duration: this.duration,
      fallbackLabel: input.type === "point" ? `Point ${this.events.length + 1}` : `Event ${this.events.length + 1}`,
    });
    if (event.type === "interval" && event.offsetSec <= event.onsetSec) event.type = "point", event.offsetSec = null;
    this.events.push(event);
    this.events.sort(compareEvents);
    this._syncLegacyMarkers();
    this.render();
    this._emitEvents();
    return event;
  }

  addMarker(time = (this.tStart + this.tEnd) / 2, label = null, source = "manual") {
    return this.addEvent({ type: "point", onsetSec: time, label, source });
  }

  addInterval(onsetSec, offsetSec, label = null, source = "manual") {
    return this.addEvent({ type: "interval", onsetSec, offsetSec, label, source });
  }

  updateEvent(id, patch = {}) {
    const index = this.events.findIndex((event) => String(event.id) === String(id));
    if (index < 0) return null;
    const current = this.events[index];
    const merged = createEvent({ ...current, ...patch, id: current.id }, {
      duration: this.duration,
      fallbackLabel: current.label,
    });
    if (patch.type === "point") { merged.type = "point"; merged.offsetSec = null; }
    if (merged.type === "interval" && merged.offsetSec <= merged.onsetSec) {
      merged.type = "point";
      merged.offsetSec = null;
    }
    this.events[index] = merged;
    this.events.sort(compareEvents);
    this._syncLegacyMarkers();
    this.render();
    this._emitEvents();
    return merged;
  }

  removeEvent(id) {
    this.events = this.events.filter((event) => String(event.id) !== String(id));
    this._syncLegacyMarkers();
    this.render();
    this._emitEvents();
  }

  removeMarker(id) {
    const marker = this.markers.find((item) => String(item.id) === String(id));
    this.removeEvent(marker?.eventId ?? id);
  }

  _syncLegacyMarkers() {
    this.markers = legacyMarkersFromEvents(this.events);
  }

  resetView() {
    this.tStart = 0;
    this.tEnd = this.duration;
    this.chTop = 0;
    this.render();
  }

  setTimeWindow(start, end) {
    if (!this.header) return;
    const a = Number(start), b = Number(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return;
    this.tStart = Math.max(0, Math.min(this.duration, a));
    this.tEnd = Math.max(this.tStart + 0.02, Math.min(this.duration, b));
    this._clampTime();
    this.render();
  }

  get unit() {
    const base = (NORM_METHODS[this.normMethod] || NORM_METHODS.none).unit;
    return this.diffOrder > 0 ? `Δ${this.diffOrder}·${base}` : base;
  }

  getSelectedAnalysis() {
    const c = this.selectedChannel;
    if (c === null || !this.dispChannels[c]) return null;
    return {
      channel: c,
      label: this.channelMeta[c].label,
      group: this.channelMeta[c].group,
      stats: this.channelStats[c],
      spectrum: spectrumFor(this.dispChannels[c], this.fs),
      spectrogram: spectrogramFor(this.dispChannels[c], this.fs),
      measurement: this.measureRange ? measureRange(this.dispChannels[c], this.fs, this.measureRange[0], this.measureRange[1]) : null,
    };
  }

  buildAIContext() {
    if (!this.header) return { loaded: false };
    if (this.windowed) return this._windowedAIContext();
    const summarizeChannel = (c) => {
      const meta = this.channelMeta[c] || {};
      const stats = this.channelStats[c] || {};
      return {
        index: c,
        label: meta.label || `ch${c}`,
        group: meta.group || "",
        sourceIndex: meta.sourceIndex ?? c,
        montage: meta.montage || "raw",
        dominantFrequencyHz: roundN(stats.freq, 3),
        dominantBand: stats.dominantBand || "",
        bandEnergyRatio: summarizeBands(stats.bands),
        displayStats: basicSignalStats(this.dispChannels[c]),
      };
    };
    const selected = this.selectedChannel === null ? null : summarizeChannel(this.selectedChannel);
    const measurement = this.measureRange && this.selectedChannel !== null
      ? measureRange(this.dispChannels[this.selectedChannel], this.fs, this.measureRange[0], this.measureRange[1])
      : null;
    return {
      loaded: true,
      file: {
        name: this.baseHeader?.fileName || this.header.fileName || "",
        format: this.baseHeader?.kind || this.header.kind || "",
        projectName: this.fileContext.projectName || null,
        relativePath: this.fileContext.relativePath || null,
        samplingRateHz: roundN(this.fs, 4),
        durationSec: roundN(this.duration, 4),
        sourceChannels: this.baseHeader?.nChannels ?? this.header.nChannels,
        displayedChannels: this.nChannels,
        samples: this.nSamples,
      },
      view: {
        startSec: roundN(this.tStart, 4),
        endSec: roundN(this.tEnd, 4),
        spanSec: roundN(this.tEnd - this.tStart, 4),
        visibleChannelCount: this.visibleChannels.length,
        visibleChannelLimit: 24,
      },
      settings: {
        montage: this.montageMode,
        filter: {
          lowHz: Number(this.filterOpts.low) || 0,
          highHz: Number(this.filterOpts.high) || 0,
          notchHz: this.filterOpts.notch === "50" || this.filterOpts.notch === "60" ? Number(this.filterOpts.notch) : 0,
        },
        normalization: this.normMethod,
        diffOrder: this.diffOrder,
        unit: this.unit,
        rowHeightPx: roundN(this.rowPx, 2),
        gain: roundN(this.gainMult, 4),
      },
      selectedChannel: selected,
      visibleChannels: this.visibleChannels.slice(0, 24).map(summarizeChannel),
      events: this.events.slice(0, 50).map((event) => ({
        id: event.id,
        type: event.type,
        label: event.label,
        onsetSec: roundN(event.onsetSec, 4),
        offsetSec: event.type === "interval" ? roundN(event.offsetSec, 4) : null,
        source: event.source,
      })),
      markers: this.markers.slice(0, 50).map((m) => ({
        label: m.label,
        timeSec: roundN(m.time, 4),
      })),
      measurement: measurement ? {
        startSec: roundN(measurement.start, 4),
        endSec: roundN(measurement.end, 4),
        durationSec: roundN(measurement.duration, 4),
        mean: roundN(measurement.mean, 4),
        rms: roundN(measurement.rms, 4),
        peakToPeak: roundN(measurement.p2p, 4),
        dominantFrequencyHz: roundN(measurement.freq, 3),
      } : null,
      focus: {
        search: this.channelSearch,
        sort: this.channelSort,
        soloChannel: this.soloChannel === null ? null : summarizeChannel(this.soloChannel),
        pinnedChannel: this.pinnedChannel === null ? null : summarizeChannel(this.pinnedChannel),
        hiddenChannelCount: this.hiddenChannels.size,
        hiddenGroups: [...this.hiddenGroups],
      },
      privacy: "Summary only. Raw waveforms and full CSV data are not included.",
    };
  }

  // Minimal agent context for a large recording. Full windowed agent access
  // (run_python / inspect over time-windows + a queryable feature index) is the
  // planned follow-up; here the agent gets the current view summary only.
  _windowedAIContext() {
    const m = this.windowMeta || {};
    const summarize = (c) => {
      const meta = this.channelMeta[c] || {};
      return {
        index: c, label: meta.label || `ch${c}`, group: meta.group || "",
        sourceIndex: c, montage: "raw",
        displayStats: {
          mean: roundN(meta.mean, 4), min: roundN(meta.min, 4), max: roundN(meta.max, 4),
          peakToPeak: roundN((meta.max || 0) - (meta.min || 0), 4),
        },
      };
    };
    return {
      loaded: true,
      windowed: true,
      note: "Large recording in out-of-core windowed mode. Windowed agent analysis "
        + "(run_python / inspect over time-windows + a queryable feature index) is a "
        + "planned follow-up; only the current view summary is available.",
      file: {
        name: m.fileName || "", format: m.kind || "h5",
        samplingRateHz: roundN(this.fs, 4), durationSec: roundN(this.duration, 4),
        sourceChannels: m.nChannels, displayedChannels: this.nChannels, samples: m.nSamples,
      },
      view: {
        startSec: roundN(this.tStart, 4), endSec: roundN(this.tEnd, 4),
        spanSec: roundN(this.tEnd - this.tStart, 4),
        visibleChannelCount: this.visibleChannels.length, visibleChannelLimit: 24,
      },
      settings: {
        montage: this.montageMode, normalization: this.normMethod, diffOrder: this.diffOrder,
        unit: this.unit, gain: roundN(this.gainMult, 4),
        filter: {
          lowHz: Number(this.filterOpts.low) || 0, highHz: Number(this.filterOpts.high) || 0,
          notchHz: (this.filterOpts.notch === "50" || this.filterOpts.notch === "60") ? Number(this.filterOpts.notch) : 0,
        },
      },
      selectedChannel: this.selectedChannel === null ? null : summarize(this.selectedChannel),
      visibleChannels: this.visibleChannels.slice(0, 24).map(summarize),
      events: [],
      privacy: "Summary only. Raw waveforms are not included.",
    };
  }

  exportVisibleCSV() {
    if (this.windowed || !this.header) return "";
    const start = Math.max(0, Math.floor(this.tStart * this.fs));
    const end = Math.min(this.nDisp, Math.ceil(this.tEnd * this.fs));
    const labels = this.visibleChannels.map((c) => this.channelMeta[c].label);
    const rows = [`time_s,${labels.map(csvCell).join(",")}`];
    for (let i = start; i < end; i++) {
      const vals = this.visibleChannels.map((c) => this.dispChannels[c][i]?.toPrecision(7) ?? "");
      rows.push(`${(i / this.fs).toFixed(6)},${vals.join(",")}`);
    }
    return rows.join("\n");
  }

  exportMarkersJSON() {
    return JSON.stringify(serializeEventsDocument(this.events, this.baseHeader?.fileName || ""), null, 2);
  }

  getExportSeries({ source = "processed", channels = "visible", edfSafe = false } = {}) {
    if (this.windowed) {
      throw new Error("Export and image rendering for large (windowed) recordings is a planned follow-up.");
    }
    const effectiveSource = edfSafe && source === "processed" ? "physical" : source;
    let arrays;
    let meta;
    let indices;
    if (effectiveSource === "raw") {
      arrays = this.baseRawChannels;
      meta = this.baseHeader.channels;
      if (channels === "visible") {
        indices = [...new Set(this.visibleChannels.map((index) => this.channelMeta[index]?.sourceIndex).filter(Number.isInteger))];
      } else indices = arrays.map((_array, index) => index);
    } else {
      arrays = effectiveSource === "physical" ? this.rawChannels : this.dispChannels;
      meta = this.channelMeta;
      indices = channels === "visible" ? this.visibleChannels.slice() : arrays.map((_array, index) => index);
    }
    const selected = indices.filter((index) => arrays[index]);
    return {
      arrays: selected.map((index) => arrays[index]),
      labels: selected.map((index) => meta[index]?.label || `ch${index}`),
      colors: selected.map((index) => this.channelColor[index] || GROUP_COLORS[index % GROUP_COLORS.length]),
      source: effectiveSource,
      fs: this.fs,
      nSamples: selected.length ? selected[0].length : 0,
      provenance: {
        requestedSource: source,
        effectiveSource,
        montage: effectiveSource === "raw" ? "raw" : this.montageMode,
        filter: effectiveSource === "raw" ? { low: 0, high: 0, notch: "off" } : { ...this.filterOpts },
        diffOrder: effectiveSource === "processed" ? this.diffOrder : 0,
        normalization: effectiveSource === "processed" ? this.normMethod : "none",
        normalizationOptions: effectiveSource === "processed" ? { ...this.normOpts } : {},
        unit: effectiveSource === "processed" ? this.unit : "µV",
      },
    };
  }

  async getWindowedExportSeries({ source = "processed", channels = "all", startSec = this.tStart, endSec = this.tEnd, signal } = {}) {
    if (!this.windowed) return this.getExportSeries({ source, channels });
    if (!this.windowToken) throw new Error("No large-recording data token is available.");
    const t0 = Math.max(0, Number(startSec) || 0);
    const t1 = Math.min(this.duration, Number(endSec) || 0);
    if (!(t1 > t0)) throw new Error("startSec/endSec must define a forward time window.");
    const res = await fetchSamples(this.windowToken, t0, t1, null, { signal });
    const sourceIndices = Array.isArray(res.header.channels)
      ? res.header.channels : res.arrays.map((_array, index) => index);
    const baseMeta = sourceIndices.map((sourceIndex, localIndex) => {
      const c = this.windowMeta?.channels?.[sourceIndex] || {};
      return {
        ...c,
        label: c.label || `ch${sourceIndex ?? localIndex}`,
        group: c.group || "",
        sourceIndex,
        montage: "raw",
      };
    });

    const effectiveSource = source;
    let arrays;
    let meta;
    if (effectiveSource === "raw") {
      arrays = res.arrays;
      meta = baseMeta;
    } else {
      const filtered = res.arrays.map((a) => applyFrequencyFilter(a, this.fs, this.filterOpts));
      let chans = filtered;
      meta = baseMeta.map((c) => ({ ...c }));
      if (this.montageMode !== "raw") {
        const montage = buildMontage(filtered, meta, this.montageMode);
        if (montage.channels.length) {
          chans = montage.channels;
          meta = montage.meta;
        }
      }
      if (effectiveSource === "physical") {
        arrays = chans;
      } else {
        arrays = chans;
        if (this.diffOrder > 0) arrays = arrays.map((a) => nthDifference(a, this.diffOrder));
        if (this.normMethod && this.normMethod !== "none") {
          const gstats = this.normMethod === "globalz" ? globalStats(arrays) : null;
          arrays = arrays.map((a) => normalizeChannel(a, this.normMethod, gstats, this.normOpts));
        }
      }
    }

    let selected;
    if (channels === "visible") {
      if (this._procMode && this.channelMeta.length === meta.length) selected = this.visibleChannels.slice();
      else {
        const visibleSources = new Set(this.visibleChannels.map((index) => this.channelMeta[index]?.sourceIndex ?? index));
        selected = meta.map((item, index) => visibleSources.has(item.sourceIndex ?? index) ? index : -1).filter((index) => index >= 0);
      }
    } else selected = arrays.map((_array, index) => index);
    selected = [...new Set(selected)].filter((index) => arrays[index]);
    if (!selected.length) selected = arrays.map((_array, index) => index);

    return {
      arrays: selected.map((index) => arrays[index]),
      labels: selected.map((index) => meta[index]?.label || `ch${index}`),
      colors: selected.map((index) => this.groupColor.get(meta[index]?.group) || GROUP_COLORS[index % GROUP_COLORS.length]),
      source: effectiveSource,
      fs: this.fs,
      nSamples: selected.length ? selected[0].length : 0,
      timeOffsetSec: res.header.startSec ?? t0,
      startSec: res.header.startSec ?? t0,
      endSec: res.header.endSec ?? t1,
      sourceIndices: selected.map((index) => meta[index]?.sourceIndex ?? index),
      provenance: {
        requestedSource: source,
        effectiveSource,
        montage: effectiveSource === "raw" ? "raw" : this.montageMode,
        filter: effectiveSource === "raw" ? { low: 0, high: 0, notch: "off" } : { ...this.filterOpts },
        diffOrder: effectiveSource === "processed" ? this.diffOrder : 0,
        normalization: effectiveSource === "processed" ? this.normMethod : "none",
        normalizationOptions: effectiveSource === "processed" ? { ...this.normOpts } : {},
        unit: effectiveSource === "processed" ? this.unit : "µV",
        windowed: true,
        sourceWindowSec: [t0, t1],
      },
    };
  }

  exportPNG() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = this.cssW * dpr;
    canvas.height = this.cssH * dpr;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.gl, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.overlay, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  // ----------------------------------------------------------------- sizing
  resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.overlay.width = w * dpr; this.overlay.height = h * dpr;
    this.overlay.style.width = w + "px"; this.overlay.style.height = h + "px";
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.eventTrack && this.eventCtx) {
      const trackW = this.eventTrack.clientWidth || w;
      const trackH = this.eventTrack.clientHeight || 68;
      this.eventTrack.width = Math.round(trackW * dpr);
      this.eventTrack.height = Math.round(trackH * dpr);
      this.eventCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.eventCssW = trackW;
      this.eventCssH = trackH;
    }
    this.cssW = w; this.cssH = h;
    this._clampChannels();
    if (this.windowed) this._scheduleTile(); // column budget tracks the plot width
    this.render();
  }

  // ------------------------------------------------------------- projection
  // The plot area is inset by the label gutter (left), the time-axis band +
  // horizontal-scrollbar lane (bottom) and the vertical-scrollbar lane (right).
  get plotW() { return this.cssW - this.gutter - this.vbarW; }
  get plotH() { return this.cssH - this.axisH - this.hbarH; }
  get visTracks() { return Math.max(1, this.plotH / this.rowPx); }
  get contentTracks() { return Math.max(1, this.visibleChannels.length); }
  get maxScroll() { return Math.max(0, this.contentTracks - this.visTracks); }

  _computeCam() {
    const dataLeft = this.tStart * this.fs;
    const dataRight = this.tEnd * this.fs;
    const perpx = (dataRight - dataLeft) / Math.max(1, this.plotW);
    const dataTop = -this.chTop + 0.5;
    const perpy = this.visTracks / Math.max(1, this.plotH);
    this._cam = {
      left: dataLeft - this.gutter * perpx,        // world X at screen x = 0
      right: dataRight + this.vbarW * perpx,        // world X at screen x = cssW
      top: dataTop,                                 // world Y at screen y = 0
      bottom: dataTop - this.cssH * perpy,          // world Y at screen y = cssH
    };
    return this._cam;
  }

  worldToScreenX(wx) { const c = this._cam; return ((wx - c.left) / (c.right - c.left)) * this.cssW; }
  worldToScreenY(wy) { const c = this._cam; return ((c.top - wy) / (c.top - c.bottom)) * this.cssH; }
  screenToWorldX(sx) { const c = this._cam; return c.left + (sx / this.cssW) * (c.right - c.left); }
  screenToWorldY(sy) { const c = this._cam; return c.top - (sy / this.cssH) * (c.top - c.bottom); }

  // ----------------------------------------------------------------- render
  render() {
    if (!this.cssW) this.resize();
    if (!this.header) return;
    const c = this._computeCam();
    this.camera.left = c.left; this.camera.right = c.right;
    this.camera.top = c.top; this.camera.bottom = c.bottom;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    this._drawChrome();
    this._drawEventTrack();
    // Reframing existing min/max geometry gives instant visual zoom; the sharper
    // tile for the new range is fetched in the background and swapped in.
    if (this.windowed) this._maybeScheduleTile();
    if (this.onView) this.onView();
  }

  _drawChrome() {
    const ctx = this.octx, W = this.cssW, H = this.cssH;
    const G = this.gutter, plotBottom = H - this.axisH - this.hbarH, plotRight = W - this.vbarW;
    ctx.clearRect(0, 0, W, H);

    const s = getComputedStyle(document.documentElement);
    const cBg = s.getPropertyValue("--bg").trim() || "#faf9f5";
    const cLine = s.getPropertyValue("--grid").trim() || "#ece9df";
    const cAxis = s.getPropertyValue("--line").trim() || "#e1ddd1";
    const cInk = s.getPropertyValue("--ink").trim() || "#1a1915";
    const cSoft = s.getPropertyValue("--ink-soft").trim() || "#6b6862";
    const cAccent = s.getPropertyValue("--accent").trim() || "#c75f3e";

    // time grid
    const span = this.tEnd - this.tStart;
    const step = niceStep(span / 9);
    ctx.lineWidth = 1;
    const first = Math.ceil(this.tStart / step) * step;
    for (let t = first; t <= this.tEnd + 1e-9; t += step) {
      const x = this.worldToScreenX(t * this.fs);
      if (x < G - 0.5) continue;
      ctx.strokeStyle = cLine;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotBottom); ctx.stroke();
    }

    const selectedRow = this.selectedChannel === null ? undefined : this.channelToRow.get(this.selectedChannel);
    if (selectedRow !== undefined) {
      const y = this.worldToScreenY(-selectedRow);
      if (y > -this.rowPx && y < plotBottom + this.rowPx) {
        ctx.fillStyle = cAccent;
        ctx.globalAlpha = 0.075;
        ctx.fillRect(G, y - this.rowPx / 2, plotRight - G, this.rowPx);
        ctx.globalAlpha = 1;
      }
    }

    if (this.measureRange) this._drawMeasureRange(ctx, plotBottom, plotRight, cAccent);
    this._drawEventLines(ctx, plotBottom, plotRight, cAccent);

    // channel baselines
    for (let row = 0; row < this.visibleChannels.length; row++) {
      const y = this.worldToScreenY(-row);
      if (y < -6 || y > plotBottom + 6) continue;
      ctx.strokeStyle = cLine; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(G, y); ctx.lineTo(plotRight, y); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // crosshair (under the gutter/axis masks)
    if (this.mouse.inside) this._drawCrosshair(ctx, W, H, cInk);

    // mask margins so waveforms never bleed under labels / axis / scrollbars
    ctx.fillStyle = cBg;
    ctx.fillRect(0, 0, G, H);                       // left gutter
    ctx.fillRect(0, plotBottom, W, H - plotBottom); // bottom (axis + h-bar)
    ctx.fillRect(plotRight, 0, this.vbarW, H);      // right (v-bar)

    ctx.strokeStyle = cAxis; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(G + 0.5, 0); ctx.lineTo(G + 0.5, plotBottom);
    ctx.moveTo(G, plotBottom + 0.5); ctx.lineTo(plotRight, plotBottom + 0.5);
    ctx.stroke();

    // channel labels
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const showEvery = this.rowPx < 13 ? Math.ceil(13 / this.rowPx) : 1;
    for (let row = 0; row < this.visibleChannels.length; row++) {
      if (row % showEvery !== 0) continue;
      const c = this.visibleChannels[row];
      const y = this.worldToScreenY(-row);
      if (y < 7 || y > plotBottom - 2) continue;
      ctx.fillStyle = this.channelColor[c];
      ctx.fillRect(10, y - 5, 3, 10);

      // Channel name only — uses the full gutter so montage labels never clip.
      ctx.font = '12px "Inter", system-ui, sans-serif';
      const label = truncate(ctx, this.channelMeta[c].label, G - 24);
      ctx.fillStyle = cInk;
      ctx.fillText(label, 18, y);
    }

    // time tick labels
    ctx.fillStyle = cSoft;
    ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    for (let t = first; t <= this.tEnd + 1e-9; t += step) {
      const x = this.worldToScreenX(t * this.fs);
      if (x < G + 10 || x > plotRight - 12) continue;
      ctx.fillText(fmtTime(t, step), x, plotBottom + this.axisH / 2);
    }
    ctx.textAlign = "left"; ctx.fillStyle = cSoft;
    ctx.font = '10px "Inter", sans-serif';
    ctx.fillText("time (s)", G + 8, plotBottom + this.axisH / 2);

    // Windowed mode: badge what the on-screen geometry is — processed/exact vs an
    // approximate LoD overview (and, when DSP is on but the window is too wide, a
    // hint to zoom in) — the exact/approx contract made visible.
    if (this.windowed) {
      let label = null, ok = false;
      if (this._procMode) { label = "EXACT · processed"; ok = true; }
      else if (this._dspActive()) { label = "ZOOM IN TO APPLY filter/montage"; ok = false; }
      else if (this.tile?.header) {
        const h = this.tile.header;
        ok = !!h.exact;
        label = ok ? "EXACT" : `OVERVIEW ≈${(((h.resolution || 1) / this.fs) * 1000).toFixed(0)} ms/col`;
      }
      if (label) {
        ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        const bw = ctx.measureText(label).width + 16, bh = 17;
        const bx = plotRight - bw - 8, by = 7;
        ctx.fillStyle = ok ? "rgba(71,112,81,.16)" : "rgba(176,130,64,.18)";
        this._roundRect(ctx, bx, by, bw, bh, 8); ctx.fill();
        ctx.fillStyle = ok ? "#477051" : "#8a6418";
        ctx.fillText(label, bx + 8, by + bh / 2 + 0.5);
      }
    }

    this._updateScrollbars(plotBottom, plotRight);
  }

  _drawMeasureRange(ctx, plotBottom, plotRight, cAccent) {
    const [a, b] = this.measureRange;
    const x1 = Math.max(this.gutter, Math.min(plotRight, this.worldToScreenX(Math.min(a, b) * this.fs)));
    const x2 = Math.max(this.gutter, Math.min(plotRight, this.worldToScreenX(Math.max(a, b) * this.fs)));
    if (x2 <= this.gutter || x1 >= plotRight) return;
    ctx.fillStyle = cAccent;
    ctx.globalAlpha = 0.11;
    ctx.fillRect(x1, 0, Math.max(1, x2 - x1), plotBottom);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = cAccent;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, 0); ctx.lineTo(x1, plotBottom);
    ctx.moveTo(x2, 0); ctx.lineTo(x2, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _drawEventLines(ctx, plotBottom, plotRight, cAccent) {
    ctx.save();
    for (const event of this.events) {
      const endpoints = event.type === "interval" ? [event.onsetSec, event.offsetSec] : [event.onsetSec];
      for (const time of endpoints) {
        const x = this.worldToScreenX(time * this.fs);
        if (x < this.gutter || x > plotRight) continue;
        ctx.strokeStyle = cAccent;
        ctx.globalAlpha = event.type === "interval" ? 0.48 : 0.38;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, plotBottom); ctx.stroke();
      }
    }
    if (this.eventDraft) {
      for (const time of [this.eventDraft.onsetSec, this.eventDraft.offsetSec]) {
        const x = this.worldToScreenX(time * this.fs);
        if (x < this.gutter || x > plotRight) continue;
        ctx.strokeStyle = cAccent;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, plotBottom); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // Minimal event ribbon: a slim lane that blends with the waveform. Events are
  // colour-coded by source (AI / Python / manual); point = flagged tick, interval
  // = rounded bar. Labels render inline where they fit; the rest live on hover.
  _eventColor(source) {
    const s = String(source || "manual").toLowerCase();
    if (s === "ai") return "#5b7a99";       // slate blue
    if (s === "python") return "#5f9d68";   // green
    if (s === "user" || s === "manual") return "#c75f3e"; // clay
    return "#b08240";                        // amber (other)
  }
  _rgba(hex, a) {
    const h = String(hex).replace("#", "");
    const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  _roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
  }

  _drawEventTrack() {
    if (!this.eventCtx || !this.eventCssW) return;
    const ctx = this.eventCtx;
    const W = this.eventCssW, H = this.eventCssH || 36;
    const G = this.gutter, plotRight = W - this.vbarW, cy = Math.round(H / 2);
    const style = getComputedStyle(document.documentElement);
    const line = style.getPropertyValue("--line").trim() || "#e3dfd2";
    const soft = style.getPropertyValue("--ink-soft").trim() || "#6b6760";

    ctx.clearRect(0, 0, W, H);
    // gutter: a quiet lowercase tag + a thin divider (no heavy beige block)
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = soft; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.globalAlpha = 0.7; ctx.fillText("events", 14, cy); ctx.globalAlpha = 1;
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(G + 0.5, 5); ctx.lineTo(G + 0.5, H - 5); ctx.stroke();

    const visible = this.events.filter((event) => {
      const end = event.type === "interval" ? event.offsetSec : event.onsetSec;
      return end >= this.tStart && event.onsetSec <= this.tEnd;
    });
    const hits = [];
    let lastLabelEnd = G + 46;
    ctx.font = '9.5px "Inter", system-ui, sans-serif';

    for (const event of visible) {
      const color = this._eventColor(event.source);
      const x1 = Math.max(G, Math.min(plotRight, this.worldToScreenX(event.onsetSec * this.fs)));
      let labelX = x1 + 8, labelAlign = "left";

      if (event.type === "interval") {
        const x2 = Math.max(G, Math.min(plotRight, this.worldToScreenX(event.offsetSec * this.fs)));
        const w = Math.max(3, x2 - x1);
        ctx.fillStyle = this._rgba(color, 0.16);
        this._roundRect(ctx, x1, cy - 6, w, 12, 4); ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1.2;
        this._roundRect(ctx, x1 + 0.6, cy - 6, w - 1.2, 12, 4); ctx.stroke();
        hits.push({ eventId: event.id, x1: x1 - 3, x2: x2 + 3, y1: cy - 9, y2: cy + 9 });
        labelX = (x1 + x2) / 2; labelAlign = "center";
      } else {
        ctx.strokeStyle = color; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x1 + 0.5, cy - 9); ctx.lineTo(x1 + 0.5, cy + 9); ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(x1 + 1, cy - 9); ctx.lineTo(x1 + 6, cy - 6); ctx.lineTo(x1 + 1, cy - 3); ctx.closePath(); ctx.fill();
        hits.push({ eventId: event.id, x1: x1 - 5, x2: x1 + 12, y1: cy - 11, y2: cy + 11 });
      }

      // inline label where it fits; otherwise rely on the hover tooltip
      const text = event.label || "";
      const tw = Math.min(150, ctx.measureText(text).width);
      const left = labelAlign === "center" ? labelX - tw / 2 : labelX;
      if (text && left > lastLabelEnd + 6 && left + tw < plotRight - 2) {
        ctx.fillStyle = color; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(text, left, cy);
        lastLabelEnd = left + tw;
      }
    }
    this._eventTrackHits = hits;
  }

  // Show the ribbon only when there are events; collapse it otherwise.
  _syncEventTrack() {
    const wrap = this.eventTrack?.parentElement;
    if (!wrap) return;
    const show = this.events.length > 0;
    if (show === !wrap.classList.contains("hidden")) return;
    wrap.classList.toggle("hidden", !show);
    requestAnimationFrame(() => this.resize());
  }

  // Re-centre the time view on a point in time, preserving the current span.
  _centerView(timeSec) {
    const span = this.tEnd - this.tStart;
    const start = Math.max(0, Math.min(this.duration - span, timeSec - span / 2));
    this.setTimeWindow(start, start + span);
  }

  // Position & size the DOM scrollbar thumbs; hide a bar when its axis fits.
  _updateScrollbars(plotBottom, plotRight) {
    const G = this.gutter;
    // vertical (channels)
    const vScrollable = this.maxScroll > 0.01;
    this.sbV.track.classList.toggle("show", vScrollable);
    if (vScrollable) {
      const top = 6, len = plotBottom - 12;
      const thumbLen = Math.max(28, len * Math.min(1, this.visTracks / this.contentTracks));
      const thumbPos = top + (this.chTop / this.maxScroll) * (len - thumbLen);
      this.sbV.track.style.cssText =
        `top:${top}px; bottom:${this.cssH - plotBottom + 6}px; right:${(this.vbarW - 6) / 2}px;`;
      this.sbV.thumb.style.cssText = `height:${thumbLen}px; transform:translateY(${thumbPos - top}px);`;
      this._sbV = { trackLen: len, thumbLen, thumbPos };
    }
    // horizontal (time)
    const span = this.tEnd - this.tStart;
    const hScrollable = span < this.duration - 1e-6;
    this.sbH.track.classList.toggle("show", hScrollable);
    if (hScrollable) {
      const left = G + 6, len = (plotRight - left) - 6;
      const thumbLen = Math.max(28, len * Math.min(1, span / this.duration));
      const maxT = this.duration - span;
      const thumbPos = left + (maxT > 0 ? this.tStart / maxT : 0) * (len - thumbLen);
      this.sbH.track.style.cssText =
        `left:${left}px; right:${this.cssW - plotRight + 6}px; bottom:${(this.hbarH - 6) / 2}px;`;
      this.sbH.thumb.style.cssText = `width:${thumbLen}px; transform:translateX(${thumbPos - left}px);`;
      this._sbH = { trackLen: len, thumbLen, thumbPos };
    }
  }

  _drawCrosshair(ctx, W, H, cInk) {
    const { x, y } = this.mouse;
    const plotBottom = H - this.axisH - this.hbarH, plotRight = W - this.vbarW;
    if (x < this.gutter || x > plotRight || y > plotBottom) { if (this.onReadout) this.onReadout(null); return; }
    ctx.save();
    ctx.strokeStyle = cInk; ctx.globalAlpha = 0.3; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotBottom); ctx.stroke();
    ctx.restore();

    const row = Math.round(-this.screenToWorldY(y));
    const ch = this.visibleChannels[row];
    const i = Math.round(this.screenToWorldX(x));          // absolute sample index
    const ri = this._procMode ? i - (this._sampleOffset || 0) : i; // index into dispChannels
    let info = null;
    const inRange = this._procMode
      ? (ri >= 0 && ri < this.nDisp)
      : (i >= 0 && i < this.nDisp);
    if (ch !== undefined && inRange) {
      const value = this._procMode ? this.dispChannels[ch]?.[ri]
        : this.windowed ? this._tileValueAt(ch, i) : this.dispChannels[ch]?.[i];
      if (value !== null && value !== undefined) {
        info = {
          x, y,
          label: this.channelMeta[ch].label,
          color: this.channelColor[ch],
          time: i / this.fs,
          value,
          unit: this.unit,
          freq: (this.windowed && !this._procMode) ? NaN : this.channelFreqs[ch],
        };
        const by = this.worldToScreenY(-row);
        ctx.fillStyle = info.color;
        ctx.beginPath(); ctx.arc(x, by, 3.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (this.onReadout) this.onReadout(info);
  }

  _bindEventTrack() {
    if (!this.eventTrack) return;
    const tooltip = document.getElementById("eventTrackTooltip");
    const hitAt = (event) => (this._eventTrackHits || []).find((hit) =>
      event.offsetX >= hit.x1 && event.offsetX <= hit.x2 && event.offsetY >= hit.y1 && event.offsetY <= hit.y2);
    this.eventTrack.addEventListener("mousemove", (event) => {
      const hit = hitAt(event);
      this.eventTrack.style.cursor = hit ? "pointer" : "default";
      if (!tooltip) return;
      const item = hit && this.events.find((candidate) => String(candidate.id) === String(hit.eventId));
      if (!item) { tooltip.classList.remove("show"); return; }
      const range = item.type === "interval"
        ? `${item.onsetSec.toFixed(2)}–${item.offsetSec.toFixed(2)} s`
        : `${item.onsetSec.toFixed(2)} s`;
      tooltip.textContent = `${item.label} · ${range} · ${item.source}`;
      tooltip.style.left = `${Math.min(event.offsetX + 12, Math.max(12, this.eventCssW - 220))}px`;
      tooltip.style.top = `${Math.max(4, event.offsetY - 24)}px`;
      tooltip.classList.add("show");
    });
    this.eventTrack.addEventListener("mouseleave", () => tooltip?.classList.remove("show"));
    this.eventTrack.addEventListener("click", (event) => {
      const hit = hitAt(event);
      if (!hit) return;
      const item = this.events.find((candidate) => String(candidate.id) === String(hit.eventId));
      if (item) this._centerView(item.type === "interval" ? (item.onsetSec + item.offsetSec) / 2 : item.onsetSec);
      this.onEventEditRequest?.(hit.eventId);
    });
  }

  // ---------------------------------------------------------- interactions
  _bindInteractions() {
    const el = this.stage;
    let dragging = false, measuring = false, marking = false;
    let lastX = 0, lastY = 0, downX = 0, downY = 0, measureStart = 0, eventStart = 0;

    el.addEventListener("mousedown", (e) => {
      if (!this.header || !this._plotContains(e.offsetX, e.offsetY)) return;
      if (this.markerMode) {
        marking = true;
        downX = e.offsetX;
        eventStart = this._screenToTime(e.offsetX);
        this.eventDraft = { onsetSec: eventStart, offsetSec: eventStart };
        this.render();
        return;
      }
      if (this.measureMode) {
        measuring = true;
        measureStart = this._screenToTime(e.offsetX);
        this.measureRange = [measureStart, measureStart];
        this._emitAnalysis();
        this.render();
        return;
      }
      dragging = true;
      lastX = downX = e.offsetX;
      lastY = downY = e.offsetY;
      el.style.cursor = "grabbing";
    });
    window.addEventListener("mouseup", () => {
      if (marking) {
        marking = false;
        const draft = this.eventDraft;
        this.eventDraft = null;
        const span = Math.abs((draft?.offsetSec ?? eventStart) - eventStart);
        const clickThreshold = Math.max(0.003, (this.tEnd - this.tStart) * 3 / Math.max(1, this.plotW));
        const created = span > clickThreshold
          ? this.addInterval(Math.min(eventStart, draft.offsetSec), Math.max(eventStart, draft.offsetSec), null, "manual")
          : this.addMarker(eventStart, null, "manual");
        this.onEventEditRequest?.(created.id);
      }
      if (measuring) {
        measuring = false;
        this._emitAnalysis();
      }
      if (dragging) {
        const moved = Math.hypot(lastX - downX, lastY - downY);
        if (moved < 4) {
          const ch = this._channelAtPoint(downX, downY);
          if (ch !== null) this.selectChannel(ch);
        }
      }
      dragging = false;
      el.style.cursor = this.measureMode || this.markerMode ? "crosshair" : "default";
    });

    el.addEventListener("mousemove", (e) => {
      this.mouse.x = e.offsetX; this.mouse.y = e.offsetY; this.mouse.inside = true;
      if (marking) {
        this.eventDraft = { onsetSec: eventStart, offsetSec: this._screenToTime(e.offsetX) };
        this.render();
      } else if (measuring) {
        this.measureRange = [measureStart, this._screenToTime(e.offsetX)];
        this._emitAnalysis();
        this.render();
      } else if (dragging) this._panBy(e.offsetX - lastX, e.offsetY - lastY);
      else this.render();
      lastX = e.offsetX; lastY = e.offsetY;
    });

    el.addEventListener("mouseleave", () => {
      this.mouse.inside = false;
      if (this.onReadout) this.onReadout(null);
      this.render();
    });

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this._zoomRows(e.deltaY, e.offsetY);
      else if (e.shiftKey) this._scrollChannels(e.deltaY);
      else this._zoomTime(e.deltaY, e.offsetX);
    }, { passive: false });

    el.addEventListener("dblclick", () => this.resetView());
  }

  _plotContains(x, y) {
    return x >= this.gutter && x <= this.cssW - this.vbarW && y >= 0 && y <= this.plotH;
  }

  _screenToTime(x) {
    return Math.max(0, Math.min(this.duration, this.screenToWorldX(x) / this.fs));
  }

  _channelAtPoint(x, y) {
    if (!this._plotContains(x, y)) return null;
    const row = Math.round(-this.screenToWorldY(y));
    return this.visibleChannels[row] ?? null;
  }

  _panBy(dxPx, dyPx) {
    const span = this.tEnd - this.tStart;
    const dt = -(dxPx / this.plotW) * span;
    this.tStart += dt; this.tEnd += dt; this._clampTime();
    this.chTop -= (dyPx / this.plotH) * this.visTracks;
    this._clampChannels();
    this.render();
  }

  _scrollChannels(deltaY) {
    this.chTop += deltaY / this.rowPx;
    this._clampChannels();
    this.render();
  }

  // ⌘/Ctrl + wheel: vertical zoom by changing row height, keeping the channel
  // under the cursor fixed.
  _zoomRows(deltaY, anchorPy) {
    const f = Math.min(1, Math.max(0, anchorPy / this.plotH));
    const anchorCh = this.chTop + f * this.visTracks;
    this.rowPx = Math.max(20, Math.min(this.rowPx / Math.pow(1.0015, deltaY), 130));
    this.chTop = anchorCh - f * this.visTracks;
    this._clampChannels();
    this.render();
  }

  _panTime(deltaY) {
    const span = this.tEnd - this.tStart;
    const dt = (deltaY / 600) * span;
    this.tStart += dt; this.tEnd += dt; this._clampTime();
    this.render();
  }

  _zoomTime(deltaY, anchorPx) {
    const factor = Math.pow(1.0015, deltaY);
    const span = this.tEnd - this.tStart;
    const f = Math.min(1, Math.max(0, (anchorPx - this.gutter) / this.plotW));
    const anchorT = this.tStart + f * span;
    const newSpan = Math.max(0.02, Math.min(span * factor, this.duration));
    this.tStart = anchorT - f * newSpan;
    this.tEnd = this.tStart + newSpan;
    this._clampTime();
    this.render();
  }

  _clampTime() {
    const span = this.tEnd - this.tStart;
    if (this.tStart < 0) { this.tStart = 0; this.tEnd = span; }
    if (this.tEnd > this.duration) { this.tEnd = this.duration; this.tStart = this.duration - span; }
    if (this.tStart < 0) this.tStart = 0;
  }

  _clampChannels() {
    if (this.chTop < 0) this.chTop = 0;
    if (this.chTop > this.maxScroll) this.chTop = this.maxScroll;
  }

  _emitSelection() {
    if (this.onSelectionChange) this.onSelectionChange(this.getSelectedAnalysis());
    this._emitAnalysis();
  }

  _emitAnalysis() {
    if (this.onAnalysisChange) this.onAnalysisChange(this.getSelectedAnalysis());
  }

  _emitEvents() {
    this._syncEventTrack();
    if (this.onEventsChange) this.onEventsChange(this.events.map((event) => ({ ...event })));
    if (this.onMarkersChange) this.onMarkersChange(this.markers.slice());
  }

  _emitMarkers() { this._emitEvents(); }

  _emitChannels() {
    if (this.onChannelsChange) {
      this.onChannelsChange({
        total: this.nChannels,
        visible: this.visibleChannels.length,
        montage: this.montageMode !== "raw",
        montageLabel: montageLabel(this.montageMode),
        solo: this.soloChannel,
        hidden: this.hiddenChannels.size,
        search: this.channelSearch,
        sort: this.channelSort,
      });
    }
  }
}

// ---------------------------------------------------------------- helpers
function roundN(value, digits = 3) {
  return Number.isFinite(value) ? +Number(value).toFixed(digits) : null;
}

function summarizeBands(bands) {
  const out = {};
  for (const [id] of BANDS) out[id] = roundN(bands?.[id] ?? 0, 4);
  return out;
}

function basicSignalStats(arr) {
  if (!arr || !arr.length) return null;
  const stride = Math.max(1, Math.floor(arr.length / 5000));
  let n = 0, sum = 0, ss = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < arr.length; i += stride) {
    const v = arr[i];
    n++;
    sum += v;
    ss += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const mean = n ? sum / n : 0;
  return {
    mean: roundN(mean, 4),
    rms: roundN(n ? Math.sqrt(ss / n) : 0, 4),
    min: roundN(mn, 4),
    max: roundN(mx, 4),
    peakToPeak: roundN(mx - mn, 4),
  };
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return m * pow;
}
function fmtTime(t, step) {
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return t.toFixed(dec);
}
function fmtFreq(f) {
  return f < 10 ? f.toFixed(1) : f.toFixed(0);
}
function truncate(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function csvCell(s) {
  const text = String(s);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
