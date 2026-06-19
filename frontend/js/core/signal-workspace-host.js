import { requestExport, requestImageSet } from "./api.js";
import { downloadBlob, downloadText } from "./util.js";
import { buildSignalImagePlan } from "./signal-image-plan.js";

const FILTER_PRESETS = {
  review: { low: 1, high: 70 }, seizure: { low: 1, high: 40 },
  sleep: { low: 0.3, high: 35 }, hfo: { low: 80, high: 250 },
  off: { low: 0, high: 0, notch: "off" },
};

function finite(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolveChannel(viewer, ref) {
  if (!viewer.header) return null;
  if (Number.isInteger(ref) && ref >= 0 && ref < viewer.nChannels) return ref;
  const text = String(ref ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (index >= 0 && index < viewer.nChannels) return index;
  }
  let index = viewer.channelMeta.findIndex((item) => item.label.toLowerCase() === text);
  if (index < 0) index = viewer.channelMeta.findIndex((item) => item.label.toLowerCase().includes(text));
  return index >= 0 ? index : null;
}

function expandNeighbors(indices, radius, count) {
  const expanded = new Set();
  for (const index of indices) {
    for (let offset = -radius; offset <= radius; offset++) {
      const candidate = index + offset;
      if (candidate >= 0 && candidate < count) expanded.add(candidate);
    }
  }
  return [...expanded].sort((a, b) => a - b);
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

export function createSignalWorkspaceHost({ viewer, ui, explorer, loadSample }) {
  const state = () => ({
    ...viewer.buildAIContext(),
    project: {
      name: explorer.state.projectName || null,
      source: explorer.state.source || null,
      permission: explorer.state.permission,
      activePath: explorer.state.activePath || null,
      selectedPath: explorer.state.selectedPath || null,
    },
    capabilities: {
      projectFiles: explorer.state.permission === "granted",
      imageProducer: true,
      multiScaleImages: { overview: 1, details: 4 },
      eventWritesRequireExplicitUserIntent: true,
      fileSwitchRequiresExplicitUserIntent: true,
      downloadsRequireExplicitUserIntent: true,
    },
  });

  const signal = {
    getState: state,
    resolveChannel: (ref) => resolveChannel(viewer, ref),
    getChannelMeta: (index) => viewer.channelMeta[index] || null,
    getChannelStats: (index) => viewer.channelStats[index] || null,
    getDisplayedChannel: (index) => viewer.dispChannels[index] || null,
    getVisibleChannels: () => viewer.visibleChannels.slice(),
    getEvents: () => viewer.events.map((event) => ({ ...event })),
    getView: () => ({ startSec: viewer.tStart, endSec: viewer.tEnd, durationSec: viewer.duration, fs: viewer.fs }),
  };

  const workspace = {
    resize() { viewer.resize(); },
    setView(args = {}) {
      const applied = [];
      if (args.reset) { viewer.resetView(); applied.push("view reset"); }
      if (args.clearChannelFocus) { viewer.clearChannelFocus(); ui.setSearch?.(""); applied.push("channel focus cleared"); }
      const refs = Array.isArray(args.channels) ? args.channels : [];
      if (refs.length) {
        const resolved = refs.map((ref) => resolveChannel(viewer, ref)).filter(Number.isInteger);
        const focused = expandNeighbors(resolved, Math.max(0, Math.min(8, Number(args.neighborRadius) || 0)), viewer.nChannels);
        if (focused.length) {
          viewer.setChannelFocus(focused);
          ui.setSearch?.("");
          applied.push(`focused ${focused.length} channel(s)`);
        }
      }
      if (args.search !== undefined) { ui.setSearch?.(String(args.search).slice(0, 80)); applied.push("channel search updated"); }
      if (args.sort && ["file", "group", "freq"].includes(args.sort)) { ui.setSort?.(args.sort); applied.push(`sort ${args.sort}`); }
      if (args.channel !== undefined) {
        const index = resolveChannel(viewer, args.channel);
        if (index === null) throw new Error(`Channel not found: ${args.channel}`);
        viewer.selectChannel(index, true);
        applied.push(`selected ${viewer.channelMeta[index]?.label || index}`);
      }
      const start = finite(args.startSec), end = finite(args.endSec);
      if (start !== null || end !== null) {
        if (start === null || end === null || end <= start) throw new Error("startSec/endSec must define a forward time window.");
        viewer.setTimeWindow(start, end);
        applied.push(`window ${start.toFixed(3)}-${end.toFixed(3)}s`);
      }
      if (args.gain !== undefined) { viewer.setGain(Number(args.gain)); applied.push(`gain ${viewer.gainMult}`); }
      if (args.rowHeightPx !== undefined) { viewer.setRowHeight(Math.max(16, Math.min(160, Number(args.rowHeightPx)))); applied.push(`row height ${viewer.rowPx}px`); }
      if (args.analysisMode) { ui.setAnalysisMode?.(args.analysisMode); applied.push(`analysis ${args.analysisMode}`); }
      if (args.analysisOpen !== undefined) { ui.setAnalysisOpen?.(Boolean(args.analysisOpen)); applied.push(args.analysisOpen ? "analysis opened" : "analysis closed"); }
      ui.syncControlsFromViewer?.();
      return { applied, state: state() };
    },

    configureProcessing(args = {}) {
      const applied = [];
      if (args.montage) { ui.setMontage(args.montage); applied.push(`montage ${args.montage}`); }
      const preset = args.filterPreset ? FILTER_PRESETS[args.filterPreset] : null;
      if (preset || args.lowHz !== undefined || args.highHz !== undefined || args.notchHz !== undefined) {
        ui.setFilter({
          low: args.lowHz ?? preset?.low,
          high: args.highHz ?? preset?.high,
          notch: args.notchHz ?? preset?.notch,
        });
        applied.push("filter updated");
      }
      if (args.normalization) { ui.setNorm(args.normalization); applied.push(`normalization ${args.normalization}`); }
      if (args.diffOrder !== undefined) { ui.setDiff(Number(args.diffOrder)); applied.push(`difference ${args.diffOrder}`); }
      return { applied, settings: state().settings };
    },

    manageEvents(operation, events = []) {
      const changed = [];
      for (const item of events.slice(0, 64)) {
        if (operation === "remove") {
          if (!item?.id) throw new Error("Removing an event requires its id.");
          viewer.removeEvent(item.id);
          changed.push({ id: item.id, removed: true });
        } else if (operation === "update") {
          if (!item?.id) throw new Error("Updating an event requires its id.");
          const updated = viewer.updateEvent(item.id, item);
          if (updated) changed.push(updated);
        } else if (operation === "add") {
          const onset = finite(item?.onsetSec ?? item?.timeSec);
          const offset = finite(item?.offsetSec);
          if (onset === null) throw new Error("Adding an event requires onsetSec.");
          const label = String(item?.label || "Event").replace(/[<>]/g, "").slice(0, 120) || "Event";
          changed.push(offset !== null && offset > onset
            ? viewer.addInterval(onset, offset, label, "ai")
            : viewer.addEvent({ type: "point", onsetSec: onset, label, source: "ai" }));
        } else throw new Error(`Unsupported event operation: ${operation}`);
      }
      return { operation, changed, eventCount: viewer.events.length };
    },
  };

  const project = {
    async listSources() {
      return {
        project: { name: explorer.state.projectName || null, permission: explorer.state.permission },
        sources: [{ source: "sample", path: null, name: "Bundled sample", type: "sample" },
          ...(await explorer.listSupportedFiles()).map((item) => ({ source: "project", ...item }))],
      };
    },
    async openSource({ source, path, discardCurrentEvents = false } = {}) {
      if (viewer.events.length && !discardCurrentEvents) {
        throw new Error(`The current recording has ${viewer.events.length} event(s). Set discardCurrentEvents=true only after the user confirms they may be cleared.`);
      }
      if (source === "sample") await loadSample();
      else if (source === "project") {
        if (!path) throw new Error("path is required for a project source.");
        await explorer.openPath(path);
      } else throw new Error(`Unsupported signal source: ${source}`);
      return state();
    },
  };

  function displayedToSeriesIndices(series, source, displayedIndices) {
    const result = [];
    for (const displayedIndex of displayedIndices) {
      let index = displayedIndex;
      if (source === "raw") index = viewer.channelMeta[displayedIndex]?.sourceIndex;
      if (Number.isInteger(index) && index >= 0 && index < series.arrays.length) result.push(index);
    }
    return [...new Set(result)];
  }

  function focusIndices(args, series, source) {
    if (args.channelScope === "all") return series.arrays.map((_array, index) => index);
    if (args.channelScope === "visible" || !args.channelScope) {
      return displayedToSeriesIndices(series, source, viewer.visibleChannels);
    }
    const refs = Array.isArray(args.channels) && args.channels.length
      ? args.channels : [viewer.selectedChannel ?? 0];
    const displayed = refs.map((ref) => resolveChannel(viewer, ref)).filter(Number.isInteger);
    const expanded = expandNeighbors(displayed, Math.max(0, Math.min(8, Number(args.neighborRadius) || 0)), viewer.nChannels);
    return displayedToSeriesIndices(series, source, expanded);
  }

  const artifacts = {
    async renderImages(args = {}, signalAbort) {
      if (!viewer.header) throw new Error("Load an EEG recording before rendering images.");
      const plan = buildSignalImagePlan({
        ...args,
        duration: viewer.duration,
        currentRange: { startSec: viewer.tStart, endSec: viewer.tEnd },
      });
      const source = args.source || "processed";
      const series = viewer.getExportSeries({ source, channels: "all" });
      const detailSeriesIndices = focusIndices(args, series, source);
      const overviewSeriesIndices = args.channelScope === "selected"
        ? series.arrays.map((_array, index) => index)
        : detailSeriesIndices;
      const backendViews = plan.views.map((view) => ({
        ...view,
        channelIndices: view.role === "overview" ? overviewSeriesIndices : detailSeriesIndices,
      }));

      for (const view of plan.views) {
        if (view.role === "overview" && args.channelScope === "selected") workspace.setView({ clearChannelFocus: true });
        else if (args.channelScope === "selected") workspace.setView({
          channels: Array.isArray(args.channels) && args.channels.length ? args.channels : [viewer.selectedChannel ?? 0],
          neighborRadius: args.neighborRadius,
        });
        workspace.setView({ startSec: view.startSec, endSec: view.endSec });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      const payload = await requestImageSet(series.arrays, imageConfig(viewer, series, {
        views: backendViews,
        width: args.width || 1600,
        height: args.height || 1200,
        autoHeight: args.autoHeight ?? true,
        rowHeight: args.rowHeight || 32,
        labelFontSizePx: args.labelFontSizePx || 12,
        style: args.style || "viewer",
        palette: args.palette || "current",
        monoColor: args.monoColor || "#111111",
        background: "#ffffff",
        showLabels: args.showLabels ?? true,
        showEvents: args.showEvents ?? false,
        showGrid: args.showGrid ?? true,
        lineWidth: args.style === "training" ? 0.65 : 0.8,
      }), { signal: signalAbort });
      return {
        result: {
          scope: args.scope,
          source,
          imageCount: payload.images?.length || 0,
          totalWindows: plan.totalWindows,
          views: (payload.images || []).map(({ dataUrl: _dataUrl, ...item }) => item),
          finalView: state().view,
        },
        attachments: (payload.images || []).map((item) => ({
          kind: "image", dataUrl: item.dataUrl,
          label: `${item.role} ${item.startSec.toFixed(3)}-${item.endSec.toFixed(3)}s`,
          metadata: { role: item.role, startSec: item.startSec, endSec: item.endSec, channels: item.channels },
        })),
      };
    },

    async exportArtifact(args = {}, signalAbort) {
      if (!viewer.header) throw new Error("Load an EEG recording before exporting.");
      const format = args.format;
      if (format === "csv") {
        const name = "waveform-visible.csv";
        downloadText(viewer.exportVisibleCSV(), name, "text/csv");
        return { downloaded: true, fileName: name, format };
      }
      if (format === "events-json") {
        const name = "waveform-events.json";
        downloadText(viewer.exportMarkersJSON(), name, "application/json");
        return { downloaded: true, fileName: name, format, eventCount: viewer.events.length };
      }
      const source = args.source || "processed";
      const channelMode = args.channels || "visible";
      const full = args.range === "full";
      const timeRange = full ? [0, viewer.duration] : [viewer.tStart, viewer.tEnd];
      let job;
      if (["h5", "edf"].includes(format)) {
        const series = viewer.getExportSeries({ source, channels: channelMode, edfSafe: format === "edf" });
        job = requestExport("/api/export/data", series.arrays, {
          format, fileName: viewer.baseHeader?.fileName || "recording", fs: series.fs,
          labels: series.labels, timeRange, events: viewer.events,
          provenance: series.provenance, sourceAttrs: viewer.baseHeader?.attrs || {},
        }, { signal: signalAbort });
      } else {
        const series = viewer.getExportSeries({ source, channels: channelMode });
        const batch = format === "training-zip";
        job = requestExport("/api/export/images", series.arrays, imageConfig(viewer, series, {
          style: format === "viewer-png" ? "viewer" : "training",
          mode: batch ? "batch" : "single", timeRange,
          windowSec: args.windowSec || 10, stepSec: args.stepSec || args.windowSec || 10,
          includePartial: args.includePartial ?? true,
          width: 1600, height: 1200, background: "#ffffff",
          palette: format === "viewer-png" ? "current" : "black",
          showLabels: true, showEvents: format === "viewer-png", showGrid: format === "viewer-png",
          labelFontSizePx: 12,
        }), { signal: signalAbort });
      }
      const { blob, fileName } = await job;
      downloadBlob(blob, fileName);
      return { downloaded: true, fileName, format, bytes: blob.size };
    },
  };

  return {
    signal, workspace, project, artifacts,
    async readGuide(signalAbort) {
      const response = await fetch("/api/ai/knowledge/signal-workspace", { signal: signalAbort });
      if (!response.ok) throw new Error("Signal Workspace guide is unavailable.");
      return response.text();
    },
    async runPython(code, signalAbort) {
      const token = viewer.header?.dataToken;
      if (!token) throw new Error("No dataset token is available. Reload the EEG file, then retry.");
      const response = await fetch("/api/ai/execute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, dataToken: token, workspace: state() }), signal: signalAbort,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || response.statusText);
      return payload;
    },
  };
}
