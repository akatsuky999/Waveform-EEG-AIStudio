// main.js — application entry point.
// Creates the viewer, wires the UI modules through a shared `ctx`, handles file
// loading, and boots the EEG-Master agent plugin via a small host API.

import { WaveformViewer } from "./viewer/viewer.js";
import { $, escapeHtml, round } from "./core/util.js";
import { fetchParsed, fetchSample, streamIngest } from "./core/api.js";
import { initNormalization } from "./ui/normalization.js";
import { initAnalysisPanel } from "./ui/analysis-panel.js";
import { initChannels } from "./ui/channels.js";
import { initControls } from "./ui/controls.js";
import { initExports } from "./ui/exports.js";
import { initSidebar } from "./ui/sidebar.js";
import { initProjectExplorer } from "./ui/project-explorer.js";
import { enhanceAll } from "./ui/custom-select.js";
import { dataFileType, isSupportedDataFile } from "./core/project-tree.js";
import { createSignalWorkspaceHost } from "./core/signal-workspace-host.js";
import { initAgent } from "/agent/agent.js";

const viewer = new WaveformViewer($("stage"), $("gl"), $("overlay"), $("eventTrackCanvas"));
window.eegViewer = viewer; // exposed for debugging / power use

// Shared hub: each UI module attaches its public functions onto ctx.
const ctx = { viewer };
initNormalization(ctx);
initAnalysisPanel(ctx);
initChannels(ctx);
initControls(ctx);
initExports(ctx);

const sidebar = initSidebar({ onResize: () => viewer.resize() });
ctx.setSidebarActive = (name) => sidebar.setActive(name);
let loadRequestId = 0;
let loadController = null;
let noticeTimer = null;

const appState = {
  project: null,
  currentFilePath: "",
  currentFileType: null,
  loadStatus: "idle",
  loadingPath: "",
  error: "",
};

const explorer = initProjectExplorer({
  onLoadFile: (file, options) => loadFile(file, options),
  onProjectChange: (project) => { appState.project = project; },
});
appState.project = explorer.state;
window.eegAppState = appState;
window.eegSidebar = sidebar;
setControlsEnabled(false);
setExportEnabled(false);

// ---- viewer callbacks ----------------------------------------------------
const readoutEl = $("readout");
viewer.onReadout = (info) => {
  if (!info) { readoutEl.style.opacity = "0"; return; }
  readoutEl.style.opacity = "1";
  readoutEl.innerHTML =
    `<b>${escapeHtml(info.label)}</b>&nbsp; ${info.time.toFixed(3)}s &nbsp;` +
    `${info.value.toFixed(2)} <span class="u">${info.unit}</span>` +
    (Number.isFinite(info.freq) ? ` &nbsp; ${info.freq.toFixed(info.freq < 10 ? 1 : 0)} <span class="u">Hz</span>` : "");
  const flipX = info.x > viewer.cssW - 180;
  const flipY = info.y > viewer.cssH - 60;
  readoutEl.style.left = info.x + "px";
  readoutEl.style.top = info.y + "px";
  readoutEl.style.transform =
    `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${flipY ? "calc(-100% - 14px)" : "14px"})`;
};
viewer.onSelectionChange = (a) => { ctx.renderSelected(a); ctx.renderAnalysis(a); };
viewer.onAnalysisChange = (a) => ctx.renderAnalysis(a);
viewer.onEventsChange = (events) => ctx.renderEvents(events);
viewer.onEventEditRequest = (id) => ctx.focusEventEditor(id);
viewer.onChannelsChange = (s) => {
  ctx.updateChannelSummary(s);
  ctx.syncExportDimensions?.();
};
viewer.onView = () => {
  const r = Math.round(viewer.rowPx);
  const rowS = $("row");
  if (rowS && +rowS.value !== r) { rowS.value = r; $("rowVal").textContent = r + " px"; }
};

// ---- file loading --------------------------------------------------------
function showNotice(message, type = "") {
  const notice = $("appNotice");
  clearTimeout(noticeTimer);
  notice.textContent = message || "";
  notice.className = `app-notice${message ? " show" : ""}${type ? ` ${type}` : ""}`;
  if (message) noticeTimer = setTimeout(() => {
    notice.classList.remove("show");
  }, type === "error" ? 8000 : 4200);
}

function showError(msg) {
  $("errorMsg").textContent = msg || "";
  if (msg && viewer.header) showNotice(msg, "error");
}

function setControlsEnabled(enabled) {
  $("rail").classList.toggle("is-disabled", !enabled);
  $("controlsEmpty").classList.toggle("show", !enabled);
  $("rail").querySelectorAll("button, input, select").forEach((control) => { control.disabled = !enabled; });
}

function setExportEnabled(enabled) {
  $("exportPanel").classList.toggle("is-disabled", !enabled);
  $("exportEmpty").classList.toggle("show", !enabled);
  $("exportPanel").querySelectorAll("button, input, select").forEach((control) => { control.disabled = !enabled; });
}

function beginLoad(path, projectPath = "") {
  loadController?.abort();
  // A project load owns its explorer sequence. Only loads originating outside
  // the explorer (sample, picker, drop) should cancel a pending project open.
  if (!projectPath) explorer.cancelPendingFileOpen();
  if (explorer.state.loadingPath && explorer.state.loadingPath !== projectPath) explorer.setLoadState("", "idle");
  loadController = new AbortController();
  const requestId = ++loadRequestId;
  appState.loadStatus = "loading";
  appState.loadingPath = path;
  appState.error = "";
  showError("");
  $("loading").classList.add("show");
  if (projectPath) explorer.setLoadState(projectPath, "loading");
  return { requestId, signal: loadController.signal };
}

function finishLoad(requestId) {
  if (requestId !== loadRequestId) return;
  $("loading").classList.remove("show");
  loadController = null;
}

async function loadFile(file, {
  source = "single", projectName = "", relativePath = "", preserveProcessing = false,
} = {}) {
  if (!file) return;
  if (!isSupportedDataFile(file.name)) {
    const message = "Unsupported file — choose a .h5 / .hdf5 or .edf / .bdf file.";
    showError(message);
    if (relativePath) explorer.setLoadState(relativePath, "error", message);
    return false;
  }
  const path = source === "project" ? relativePath : file.name;
  const { requestId, signal } = beginLoad(path, relativePath);
  try {
    // Large HDF5/EDF → stream straight into the out-of-core store (bounded RAM, no
    // whole-file upload buffer); smaller files take the legacy decode path.
    const STREAM_THRESHOLD_BYTES = 40 * 1024 * 1024;
    const bigFile = file.size > STREAM_THRESHOLD_BYTES && /\.(h5|hdf5|hdf|edf|edf\+|bdf)$/i.test(file.name);
    const parsed = bigFile
      ? await streamIngest(file, {
          signal,
          onProgress: (st) => showNotice(`Ingesting ${file.name} — ${Math.round((st.progress || 0) * 100)}%`),
        })
      : await fetchParsed(file, { signal });
    if (requestId !== loadRequestId) return false;
    let header, montageFallback = false;
    if (parsed.windowed) {
      viewer.setWindowedData(parsed.meta, parsed.dataToken);
      header = parsed.meta;
    } else {
      const result = viewer.setData(parsed.header, parsed.channels, { preserveSettings: preserveProcessing });
      header = parsed.header;
      montageFallback = result.montageFallback;
    }
    viewer.setFileContext(source === "project" ? { projectName, relativePath } : {});
    onLoaded(header, { preserveProcessing, montageFallback });
    appState.currentFilePath = path;
    appState.currentFileType = dataFileType(file.name) || header.kind;
    appState.loadStatus = "ready";
    appState.loadingPath = "";
    appState.error = "";
    if (source === "project") explorer.setActiveFile(relativePath, appState.currentFileType);
    else explorer.clearActiveFile();
    return true;
  } catch (e) {
    if (e?.name === "AbortError" || requestId !== loadRequestId) return false;
    const message = e.message || String(e);
    appState.loadStatus = "error";
    appState.loadingPath = "";
    appState.error = message;
    showError(message);
    if (relativePath) explorer.setLoadState(relativePath, "error", message);
    if (!viewer.header) $("dropzone").classList.remove("hidden");
    return false;
  } finally { finishLoad(requestId); }
}

async function loadSample() {
  const { requestId, signal } = beginLoad("Sample window");
  try {
    const { header, channels } = await fetchSample({ signal });
    if (requestId !== loadRequestId) return false;
    viewer.setData(header, channels);
    viewer.setFileContext({});
    onLoaded(header, { preserveProcessing: false });
    appState.currentFilePath = header.fileName;
    appState.currentFileType = header.kind;
    appState.loadStatus = "ready";
    appState.loadingPath = "";
    appState.error = "";
    explorer.clearActiveFile();
    return true;
  } catch (e) {
    if (e?.name === "AbortError" || requestId !== loadRequestId) return false;
    const message = e.message || String(e);
    appState.loadStatus = "error";
    appState.error = message;
    showError(message);
    return false;
  } finally { finishLoad(requestId); }
}

function openFilePicker() {
  const input = $("fileInput");
  input.value = "";
  input.click();
}

function onLoaded(header, { preserveProcessing = false, montageFallback = false } = {}) {
  $("dropzone").classList.add("hidden");
  $("fileMeta").classList.remove("hidden");
  // The event ribbon shows itself only when events exist (viewer._syncEventTrack).
  $("aiBtn").classList.remove("hidden");
  setControlsEnabled(true);
  setExportEnabled(true);
  ctx.applyExportWindowedMode?.(viewer.windowed); // gray full-array exports for large files
  ctx.syncExportDimensions?.();
  requestAnimationFrame(() => viewer.resize());

  $("cFile").textContent = header.fileName;
  $("cKind").textContent = header.kind === "edf" ? "EDF" : "HDF5";
  $("cChans").textContent = header.nChannels;
  $("cFs").textContent = round(header.fs);
  $("cDur").textContent = (header.durationSec ?? 0).toFixed(1);
  $("chCount").textContent = `${header.nChannels} · ${header.groups.length} groups`;

  ctx.buildLegend(header);
  ctx.buildAttrs(header);

  // Project switches retain the processing chain. File-specific focus and
  // annotations are reset by viewer.setData for every newly loaded recording.
  ctx.syncControlsFromViewer?.();
  ctx.syncNormFromViewer?.();
  $("channelSearch").value = ""; $("channelSort").value = "file";
  $("measureToggle").checked = false; $("markerToggle").checked = false;
  ctx.renderEvents([]);
  if (!preserveProcessing) ctx.setAnalysisOpen(false);
  viewer.selectChannel(0);

  if (montageFallback) showNotice("The previous montage is not compatible with this file. Switched to Original channels.");

  const hint = $("hintBar");
  hint.classList.remove("faded");
  clearTimeout(window.__hintTimer);
  window.__hintTimer = setTimeout(() => hint.classList.add("faded"), 6500);
}

// ---- workspace / dropzone buttons ---------------------------------------
$("resetBtn").addEventListener("click", () => viewer.resetView());
$("openFileBtn").addEventListener("click", openFilePicker);
$("explorerOpenFile").addEventListener("click", openFilePicker);
$("browseBtn").addEventListener("click", openFilePicker);
$("sampleBtn").addEventListener("click", () => loadSample());
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  loadFile(file);
});

// ---- drag & drop ---------------------------------------------------------
const dz = $("dropzone");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault(); dragDepth++;
  dz.classList.remove("hidden"); dz.classList.add("drag");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", (e) => {
  e.preventDefault(); dragDepth--;
  if (dragDepth <= 0) { dz.classList.remove("drag"); if (viewer.header) dz.classList.add("hidden"); }
});
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; dz.classList.remove("drag");
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
  else if (viewer.header) dz.classList.add("hidden");
});

// ---- keyboard ------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (!viewer.header) return;
  // Never hijack keys while the user is typing in a field (AI composer, filter
  // inputs, channel search, config). Otherwise "0", arrows, +/- get swallowed.
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" ||
             ae.tagName === "SELECT" || ae.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const W = viewer.plotW || 1000;
  switch (e.key) {
    case "ArrowLeft": viewer._panBy(W * 0.12, 0); break;
    case "ArrowRight": viewer._panBy(-W * 0.12, 0); break;
    case "ArrowUp": viewer._scrollChannels(-viewer.rowPx * 1.5); break;
    case "ArrowDown": viewer._scrollChannels(viewer.rowPx * 1.5); break;
    case "+": case "=": viewer._zoomTime(-120, viewer.gutter + W / 2); break;
    case "-": case "_": viewer._zoomTime(120, viewer.gutter + W / 2); break;
    case "0": viewer.resetView(); break;
    default: return;
  }
  e.preventDefault();
});

// ---- EEG-Master agent plugin --------------------------------------------
// Host API: the agent operates the app only through these functions.
const host = createSignalWorkspaceHost({
  viewer,
  explorer,
  loadSample,
  ui: {
    setNorm: (m) => ctx.setNorm(m),
    setDiff: (n) => ctx.setDiff(n),
    setMontage: (m) => ctx.setMontage(m),
    setFilter: (o) => ctx.setFilter(o),
    setSearch: (q) => { $("channelSearch").value = q; viewer.setChannelSearch(q); },
    setSort: (m) => { $("channelSort").value = m; viewer.setChannelSort(m); },
    setAnalysisOpen: (b) => ctx.setAnalysisOpen(b),
    setAnalysisMode: (m) => ctx.setAnalysisMode(m),
    syncControlsFromViewer: () => ctx.syncControlsFromViewer?.(),
  },
});
host.openAgentSettings = () => sidebar.setActive("agent");
initAgent(host);

// Replace every native <select> with the app's clay dropdown (workspace controls
// + the agent model picker). Runs after initAgent so the model <select> exists;
// the enhancer self-updates when the agent later refreshes its model list.
enhanceAll(document);
