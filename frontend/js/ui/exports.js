// Export workbench: quick text exports plus configurable image/data requests.

import { $, downloadBlob, downloadText } from "../core/util.js";
import { requestExport } from "../core/api.js";

export const MAX_BATCH_WINDOWS = 500;
export const IMAGE_LIMITS = Object.freeze({
  minWidth: 320,
  maxWidth: 8192,
  minHeight: 240,
  maxHeight: 8192,
  minRowHeight: 16,
  maxRowHeight: 96,
  minLabelSize: 6,
  maxLabelSize: 32,
});

export function initExports(ctx) {
  const viewer = ctx.viewer;
  let activeController = null;
  let previewObjectUrl = null;
  let previewBlob = null;
  let previewFileName = "waveform-preview.png";

  const status = (message, error = false) => {
    $("exportStatus").textContent = message || "";
    $("exportStatus").classList.toggle("error", error);
  };

  const run = async (button, task) => {
    activeController?.abort();
    const requestController = new AbortController();
    activeController = requestController;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Preparing…";
    status("Rendering export…");
    try {
      const { blob, fileName } = await task(requestController.signal);
      downloadBlob(blob, fileName);
      status(`Ready · ${fileName}`);
    } catch (error) {
      if (error?.name !== "AbortError") status(error.message || String(error), true);
    } finally {
      button.disabled = false;
      button.textContent = original;
      if (activeController === requestController) activeController = null;
    }
  };

  const preview = async (button, jobFactory) => {
    activeController?.abort();
    const requestController = new AbortController();
    activeController = requestController;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Rendering…";
    status("Rendering preview…");
    try {
      const job = jobFactory(requestController.signal);
      const { blob, fileName } = await job.request;
      openImagePreview({ ...job, blob, fileName });
      status(`Preview ready · ${fileName}`);
    } catch (error) {
      if (error?.name !== "AbortError") status(error.message || String(error), true);
    } finally {
      button.disabled = false;
      button.textContent = original;
      if (activeController === requestController) activeController = null;
    }
  };

  $("csvBtn").addEventListener("click", () => downloadText(viewer.exportVisibleCSV(), "waveform-visible.csv", "text/csv"));
  $("eventsBtn").addEventListener("click", () => downloadText(viewer.exportMarkersJSON(), "waveform-events.json", "application/json"));

  // Snapshot the visible canvas — works for any file size (large recordings only
  // need the current window), so it stays enabled in windowed mode.
  $("pngViewBtn").addEventListener("click", () => {
    if (!viewer.header) return;
    const a = document.createElement("a");
    a.href = viewer.exportPNG();
    a.download = `${(viewer.baseHeader?.fileName || "waveform").replace(/\.[^.]+$/, "")}-view.png`;
    document.body.appendChild(a); a.click(); a.remove();
  });

  // Large (windowed) recordings can't run the full-array image / data / CSV exports
  // (the store ships windows, not whole arrays) — gray + freeze those, keep the
  // current-view PNG and events JSON usable.
  const WINDOWED_DISABLED = ["csvBtn", "viewerPreviewBtn", "viewerImageBtn",
    "trainingPreviewBtn", "trainingCurrentBtn", "trainingBatchBtn", "dataExportBtn"];
  ctx.applyExportWindowedMode = (windowed) => {
    for (const id of WINDOWED_DISABLED) {
      const el = $(id);
      if (!el) continue;
      el.disabled = !!windowed;
      el.classList.toggle("is-frozen", !!windowed);
    }
    status(windowed
      ? "Large recording: image / data export coming soon — use Current view PNG or Events JSON."
      : "");
  };

  $("viewerBgMode").addEventListener("change", () => {
    $("viewerCustomBgWrap").classList.toggle("hidden", $("viewerBgMode").value !== "custom");
  });
  $("trainingPalette").addEventListener("change", () => {
    $("trainingMonoWrap").classList.toggle("hidden", $("trainingPalette").value !== "mono");
  });
  $("trainingBatchToggle").addEventListener("click", () => $("trainingBatchSettings").classList.toggle("hidden"));

  let lockedRatio = positive($("imageWidth").value, 1600) / positive($("imageHeight").value, 1200);

  const visibleChannelCount = () => Math.max(1, viewer.visibleChannels?.length || viewer.nChannels || 1);

  const syncDimensionSummary = () => {
    const dimensions = readImageDimensions(visibleChannelCount(), { style: "training", showEvents: false });
    const labelSize = readLabelSize();
    $("imageHeight").disabled = $("imageAutoHeight").checked;
    $("imageRatioLock").disabled = $("imageAutoHeight").checked;
    $("imageAutoHeightSettings").classList.toggle("hidden", !$("imageAutoHeight").checked);
    $("imageRatioLabel").textContent = formatAspectRatio(dimensions.width, dimensions.height);
    $("imageDimensionSummary").textContent = $("imageAutoHeight").checked
      ? `Output · ${dimensions.width} × ${dimensions.height} px · ${visibleChannelCount()} channels × ${dimensions.rowHeight} px · labels ${labelSize} px`
      : `Output · ${dimensions.width} × ${dimensions.height} px · ${formatAspectRatio(dimensions.width, dimensions.height)} · labels ${labelSize} px`;
  };

  const keepLockedRatio = (changed) => {
    if (!$("imageRatioLock").checked || $("imageAutoHeight").checked) return;
    if (changed === "width") {
      const width = clampInteger($("imageWidth").value, 1600, IMAGE_LIMITS.minWidth, IMAGE_LIMITS.maxWidth);
      $("imageHeight").value = String(clampInteger(width / lockedRatio, 1200, IMAGE_LIMITS.minHeight, IMAGE_LIMITS.maxHeight));
    } else {
      const height = clampInteger($("imageHeight").value, 1200, IMAGE_LIMITS.minHeight, IMAGE_LIMITS.maxHeight);
      $("imageWidth").value = String(clampInteger(height * lockedRatio, 1600, IMAGE_LIMITS.minWidth, IMAGE_LIMITS.maxWidth));
    }
  };

  $("imageWidth").addEventListener("input", () => { keepLockedRatio("width"); syncDimensionSummary(); });
  $("imageHeight").addEventListener("input", () => { keepLockedRatio("height"); syncDimensionSummary(); });
  $("imageRowHeight").addEventListener("input", syncDimensionSummary);
  $("imageLabelSize").addEventListener("input", syncDimensionSummary);
  $("imageRatioLock").addEventListener("change", () => {
    if ($("imageRatioLock").checked) {
      lockedRatio = positive($("imageWidth").value, 1600) / positive($("imageHeight").value, 1200);
    }
    syncDimensionSummary();
  });
  $("imageAutoHeight").addEventListener("change", () => {
    if ($("imageAutoHeight").checked) $("imageRatioLock").checked = false;
    syncDimensionSummary();
  });
  ctx.syncExportDimensions = syncDimensionSummary;
  syncDimensionSummary();

  $("viewerPreviewBtn").addEventListener("click", () => preview($("viewerPreviewBtn"), viewerImageJob));
  $("viewerImageBtn").addEventListener("click", () => run($("viewerImageBtn"), (signal) => viewerImageJob(signal).request));

  $("trainingPreviewBtn").addEventListener("click", () => preview($("trainingPreviewBtn"), trainingImageJob));
  $("trainingCurrentBtn").addEventListener("click", () => run($("trainingCurrentBtn"), (signal) => trainingImageJob(signal).request));

  $("imagePreviewClose").addEventListener("click", () => $("imagePreviewDialog").close());
  $("imagePreviewDialog").addEventListener("click", (event) => {
    if (event.target === $("imagePreviewDialog")) $("imagePreviewDialog").close();
  });
  $("imagePreviewDialog").addEventListener("close", releaseImagePreview);
  $("imagePreviewFit").addEventListener("click", () => setPreviewZoom("fit"));
  $("imagePreviewActual").addEventListener("click", () => setPreviewZoom("actual"));
  $("imagePreviewDownload").addEventListener("click", () => {
    if (previewBlob) downloadBlob(previewBlob, previewFileName);
  });

  function viewerImageJob(signal) {
    const series = viewer.getExportSeries({ source: "processed", channels: "visible" });
    const bgMode = $("viewerBgMode").value;
    const themeBg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#faf9f5";
    const background = bgMode === "transparent" ? "transparent"
      : bgMode === "theme" ? themeBg
      : bgMode === "white" ? "#ffffff"
      : $("viewerCustomBg").value;
    const dimensions = readImageDimensions(series.arrays.length, { style: "viewer", showEvents: $("viewerEvents").checked });
    const labelFontSizePx = readLabelSize();
    const config = imageConfig(viewer, series, {
      style: "viewer",
      mode: "single",
      timeRange: [viewer.tStart, viewer.tEnd],
      ...dimensions,
      background,
      palette: "current",
      showLabels: $("viewerLabels").checked,
      showEvents: $("viewerEvents").checked,
      showGrid: true,
      labelFontSizePx,
    });
    return {
      request: requestExport("/api/export/images", series.arrays, config, { signal }),
      dimensions,
      channelCount: series.arrays.length,
      title: "Viewer image",
      labelFontSizePx,
      showLabels: $("viewerLabels").checked,
    };
  }

  function trainingImageJob(signal) {
    const series = viewer.getExportSeries({ source: $("trainingSource").value, channels: "visible" });
    const dimensions = readImageDimensions(series.arrays.length, { style: "training", showEvents: $("trainingEvents").checked });
    const labelFontSizePx = readLabelSize();
    const config = imageConfig(viewer, series, {
      style: "training",
      mode: "single",
      timeRange: [viewer.tStart, viewer.tEnd],
      ...dimensions,
      background: "#ffffff",
      palette: $("trainingPalette").value,
      monoColor: $("trainingMono").value,
      showLabels: $("trainingLabels").checked,
      showEvents: $("trainingEvents").checked,
      showGrid: false,
      lineWidth: 0.65,
      labelFontSizePx,
    });
    return {
      request: requestExport("/api/export/images", series.arrays, config, { signal }),
      dimensions,
      channelCount: series.arrays.length,
      title: "Training image",
      labelFontSizePx,
      showLabels: $("trainingLabels").checked,
    };
  }

  $("trainingBatchBtn").addEventListener("click", () => run($("trainingBatchBtn"), (signal) => {
    const series = viewer.getExportSeries({ source: $("trainingSource").value, channels: "visible" });
    const windowSec = positive($("batchWindow").value, 10);
    const stepSec = positive($("batchStep").value, 10);
    const includePartial = $("batchPartial").checked;
    const windowCount = countBatchWindows(viewer.duration, windowSec, stepSec, includePartial);
    if (windowCount > MAX_BATCH_WINDOWS) {
      throw new Error(`This batch would create ${windowCount} images. Increase the step size to stay within ${MAX_BATCH_WINDOWS}.`);
    }
    return requestExport("/api/export/images", series.arrays, imageConfig(viewer, series, {
      style: "training",
      mode: "batch",
      timeRange: [0, viewer.duration],
      windowSec,
      stepSec,
      includePartial,
      ...readImageDimensions(series.arrays.length, { style: "training", showEvents: $("trainingEvents").checked }),
      background: "#ffffff",
      palette: $("trainingPalette").value,
      monoColor: $("trainingMono").value,
      showLabels: $("trainingLabels").checked,
      showEvents: $("trainingEvents").checked,
      showGrid: false,
      lineWidth: 0.65,
      labelFontSizePx: readLabelSize(),
    }), { signal });
  }));

  function syncDataExportCopy() {
    const edf = $("dataFormat").value === "edf";
    $("dataExportBtn").textContent = edf ? "Export EDF+" : "Export H5";
    $("dataExportNote").textContent = edf
      ? "EDF+ embeds point/interval annotations. Processed EDF uses montage + filters only; differencing and normalization are omitted to preserve µV meaning."
      : "H5 stores structured events and complete processing provenance.";
  }
  $("dataFormat").addEventListener("change", syncDataExportCopy);
  syncDataExportCopy();

  $("dataExportBtn").addEventListener("click", () => run($("dataExportBtn"), (signal) => {
    const format = $("dataFormat").value;
    const requestedSource = $("dataSource").value;
    const series = viewer.getExportSeries({
      source: requestedSource,
      channels: $("dataChannels").value,
      edfSafe: format === "edf",
    });
    const current = $("dataRange").value === "current";
    return requestExport("/api/export/data", series.arrays, {
      format,
      fileName: viewer.baseHeader?.fileName || "recording",
      fs: series.fs,
      labels: series.labels,
      timeRange: current ? [viewer.tStart, viewer.tEnd] : [0, viewer.duration],
      events: viewer.events,
      provenance: { ...series.provenance, requestedSource },
      sourceAttrs: viewer.baseHeader?.attrs || {},
    }, { signal });
  }));

  function readImageDimensions(channelCount, layout) {
    return resolveImageDimensions({
      width: $("imageWidth").value,
      height: $("imageHeight").value,
      autoHeight: $("imageAutoHeight").checked,
      rowHeight: $("imageRowHeight").value,
      channelCount,
      ...layout,
    });
  }

  function readLabelSize() {
    return resolveLabelSize($("imageLabelSize").value);
  }

  function openImagePreview({ blob, fileName, dimensions, channelCount, title, labelFontSizePx, showLabels }) {
    releaseImagePreview();
    previewBlob = blob;
    previewFileName = fileName;
    previewObjectUrl = URL.createObjectURL(blob);
    $("imagePreviewTitle").textContent = title;
    const labelMeta = showLabels ? ` · labels ${labelFontSizePx} px` : "";
    $("imagePreviewMeta").textContent = `${dimensions.width} × ${dimensions.height} px · ${channelCount} channels${labelMeta} · ${formatFileSize(blob.size)}`;
    $("imagePreviewImage").src = previewObjectUrl;
    $("imagePreviewImage").alt = `${title}, ${dimensions.width} by ${dimensions.height} pixels`;
    setPreviewZoom("fit");
    if (!$("imagePreviewDialog").open) $("imagePreviewDialog").showModal();
  }

  function releaseImagePreview() {
    $("imagePreviewImage").removeAttribute("src");
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
    previewBlob = null;
  }

  function setPreviewZoom(mode) {
    const actual = mode === "actual";
    $("imagePreviewViewport").classList.toggle("fit", !actual);
    $("imagePreviewViewport").classList.toggle("actual", actual);
    $("imagePreviewFit").classList.toggle("active", !actual);
    $("imagePreviewActual").classList.toggle("active", actual);
  }

  return { status };
}

export function formatFileSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function resolveLabelSize(value) {
  return clampInteger(value, 12, IMAGE_LIMITS.minLabelSize, IMAGE_LIMITS.maxLabelSize);
}

function imageConfig(viewer, series, options) {
  return {
    ...options,
    fileName: viewer.baseHeader?.fileName || "recording",
    fs: series.fs,
    labels: series.labels,
    colors: series.colors,
    events: viewer.events,
    provenance: series.provenance,
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function resolveImageDimensions({
  width = 1600,
  height = 1200,
  autoHeight = false,
  rowHeight = 32,
  channelCount = 1,
  style = "training",
  showEvents = false,
} = {}) {
  const safeWidth = clampInteger(width, 1600, IMAGE_LIMITS.minWidth, IMAGE_LIMITS.maxWidth);
  const safeRowHeight = clampInteger(rowHeight, 32, IMAGE_LIMITS.minRowHeight, IMAGE_LIMITS.maxRowHeight);
  const safeChannels = Math.max(1, clampInteger(channelCount, 1, 1, 10000));
  const chromeHeight = style === "viewer" ? (showEvents ? 148 : 56) : 28;
  const requestedHeight = autoHeight ? safeChannels * safeRowHeight + chromeHeight : height;
  return {
    width: safeWidth,
    height: clampInteger(requestedHeight, 1200, IMAGE_LIMITS.minHeight, IMAGE_LIMITS.maxHeight),
    autoHeight: Boolean(autoHeight),
    rowHeight: safeRowHeight,
  };
}

export function formatAspectRatio(width, height) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const divisor = greatestCommonDivisor(w, h);
  const rw = w / divisor;
  const rh = h / divisor;
  return rw <= 40 && rh <= 40 ? `${rw}:${rh}` : `${(w / h).toFixed(2)}:1`;
}

function greatestCommonDivisor(a, b) {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(safe)));
}

export function countBatchWindows(duration, windowSec, stepSec, includePartial = true) {
  const total = Number(duration);
  const window = Number(windowSec);
  const step = Number(stepSec);
  if (![total, window, step].every(Number.isFinite) || total <= 0 || window <= 0 || step <= 0) return 0;
  if (includePartial) return Math.max(0, Math.ceil((total - 1e-9) / step));
  if (total + 1e-9 < window) return 0;
  return Math.floor((total - window + 1e-9) / step) + 1;
}
