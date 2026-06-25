import { requestExport, requestImageSet } from "./api.js";
import { downloadBlob, downloadText } from "./util.js";
import { buildSignalImagePlan } from "./signal-image-plan.js";

const DEFAULT_AGENT_IMAGE_LIMITS = { maxAgentImages: 5, maxImageWindowSec: 15 };

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
    events: options.events || viewer.events,
    provenance: series.provenance,
  };
}

function readInputValue(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (el.type === "checkbox") return Boolean(el.checked);
  if (el.type === "number") return Number.isFinite(Number(el.value)) ? Number(el.value) : null;
  return el.value ?? null;
}

function readExportConfiguration() {
  return {
    image: {
      width: readInputValue("imageWidth"),
      height: readInputValue("imageHeight"),
      autoHeight: readInputValue("imageAutoHeight"),
      rowHeight: readInputValue("imageRowHeight"),
      labelFontSizePx: readInputValue("imageLabelSize"),
      ratioLock: readInputValue("imageRatioLock"),
      viewerBackground: readInputValue("viewerBgMode"),
      trainingPalette: readInputValue("trainingPalette"),
      trainingMonoColor: readInputValue("trainingMonoColor"),
    },
  };
}

function clampInt(value, fallback, min, max) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function agentImageLimits(args = {}) {
  const provided = args.__agentLimits || {};
  return {
    maxAgentImages: clampInt(provided.maxAgentImages, DEFAULT_AGENT_IMAGE_LIMITS.maxAgentImages, 1, 5),
    maxImageWindowSec: clampInt(provided.maxImageWindowSec, DEFAULT_AGENT_IMAGE_LIMITS.maxImageWindowSec, 5, 15),
  };
}

export function createSignalWorkspaceHost({ viewer, ui, explorer, loadSample }) {
  const largeRecordingAnalysis = () => viewer.windowed ? {
    status: "available",
    mode: "indexed-windowed",
    workflow: ["signal_query.search", "run_python.bounded-window", "render_signal_images.short-window"],
    boundedPythonRequired: true,
    shortWindowImages: true,
    fullOverviewImages: false,
  } : {
    status: "available",
    mode: "full-array",
    boundedPythonRequired: false,
    shortWindowImages: false,
    fullOverviewImages: true,
  };

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
      largeRecordingAnalysis: largeRecordingAnalysis(),
      largeRecordingImages: viewer.windowed ? { mode: "short-window-exact", fullOverview: false } : { mode: "full-array" },
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

  const skills = {
    async list(signalAbort) {
      const response = await fetch("/api/ai/skills", { signal: signalAbort });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "EEG skills are unavailable.");
      return { skills: Array.isArray(payload.skills) ? payload.skills : [] };
    },
    async read(name, signalAbort) {
      const safeName = String(name || "").trim();
      if (!safeName) throw new Error("Skill name is required.");
      const response = await fetch(`/api/ai/skills/${encodeURIComponent(safeName)}`, { signal: signalAbort });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "EEG skill is unavailable.");
      return payload.skill || {};
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

  function focusWindowedSeriesIndices(args, series) {
    if (args.channelScope === "all") return series.arrays.map((_array, index) => index);
    const refs = args.channelScope === "selected"
      ? (Array.isArray(args.channels) && args.channels.length ? args.channels : [viewer.selectedChannel ?? 0])
      : viewer.visibleChannels;
    const resolved = refs.map((ref) => resolveChannel(viewer, ref)).filter(Number.isInteger);
    const expanded = args.channelScope === "selected"
      ? expandNeighbors(resolved, Math.max(0, Math.min(8, Number(args.neighborRadius) || 0)), viewer.nChannels)
      : resolved;
    const wantedSources = new Set(expanded.map((index) => viewer.channelMeta[index]?.sourceIndex ?? index));
    const bySource = (series.sourceIndices || []).map((sourceIndex, index) => wantedSources.has(sourceIndex) ? index : -1).filter((index) => index >= 0);
    if (bySource.length) return bySource;
    const wantedLabels = new Set(expanded.map((index) => String(viewer.channelMeta[index]?.label || "").toLowerCase()));
    const byLabel = (series.labels || []).map((label, index) => wantedLabels.has(String(label).toLowerCase()) ? index : -1).filter((index) => index >= 0);
    return byLabel.length ? byLabel : series.arrays.map((_array, index) => index);
  }

  function shiftedEventsForView(view) {
    const start = view.startSec;
    const end = view.endSec;
    return viewer.events
      .filter((event) => (event.offsetSec ?? event.onsetSec) >= start && event.onsetSec <= end)
      .map((event) => ({
        ...event,
        onsetSec: Math.max(0, event.onsetSec - start),
        offsetSec: event.offsetSec == null ? event.offsetSec : Math.max(0, event.offsetSec - start),
      }));
  }

  function assertImagePlanBudget(views, limits, { windowed = false } = {}) {
    if (views.length > limits.maxAgentImages) {
      throw new Error(`render_signal_images may attach at most ${limits.maxAgentImages} image(s) in the current Config. Ask for fewer windows or rank candidates first.`);
    }
    for (const view of views) {
      const span = view.endSec - view.startSec;
      if (windowed && span > limits.maxImageWindowSec + 1e-6) {
        throw new Error(`Large-recording image windows must be ≤ ${limits.maxImageWindowSec}s. Requested ${span.toFixed(3)}s (${view.startSec.toFixed(3)}–${view.endSec.toFixed(3)}s); use signal_query to choose shorter key segments.`);
      }
    }
  }

  async function renderWindowedImages(args, plan, source, limits, signalAbort) {
    let views = plan.views.filter((view) => view.role !== "overview");
    if (!views.length) {
      throw new Error("Large-recording image rendering needs short current/range/batch/detail windows. Full-recording overview images are disabled; first locate focused windows, then request current/range/batch/multiscale details.");
    }
    assertImagePlanBudget(views, limits, { windowed: true });
    const images = [];
    for (const view of views) {
      if (args.channelScope === "selected") workspace.setView({
        channels: Array.isArray(args.channels) && args.channels.length ? args.channels : [viewer.selectedChannel ?? 0],
        neighborRadius: args.neighborRadius,
      });
      workspace.setView({ startSec: view.startSec, endSec: view.endSec });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const series = await viewer.getWindowedExportSeries({
        source,
        channels: "all",
        startSec: view.startSec,
        endSec: view.endSec,
        signal: signalAbort,
      });
      const detailSeriesIndices = focusWindowedSeriesIndices(args, series);
      const duration = view.endSec - view.startSec;
      const payload = await requestImageSet(series.arrays, imageConfig(viewer, series, {
        views: [{
          ...view,
          startSec: 0,
          endSec: duration,
          channelIndices: detailSeriesIndices,
          absoluteStartSec: view.startSec,
          absoluteEndSec: view.endSec,
        }],
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
        events: shiftedEventsForView(view),
      }), { signal: signalAbort });
      const rendered = (payload.images || [])[0];
      if (rendered) {
        images.push({
          ...rendered,
          startSec: view.startSec,
          endSec: view.endSec,
          durationSec: duration,
          role: view.role,
          channels: rendered.channels,
        });
      }
    }
    return images;
  }

  const artifacts = {
    async renderImages(args = {}, signalAbort) {
      if (!viewer.header) throw new Error("Load an EEG recording before rendering images.");
      const limits = agentImageLimits(args);
      const plan = buildSignalImagePlan({
        ...args,
        duration: viewer.duration,
        currentRange: { startSec: viewer.tStart, endSec: viewer.tEnd },
      });
      const source = args.source || "processed";

      if (viewer.windowed) {
        const images = await renderWindowedImages(args, plan, source, limits, signalAbort);
        return {
          result: {
            scope: args.scope,
            source,
            imageCount: images.length,
            totalWindows: plan.totalWindows,
            limits,
            exact: true,
            mode: "windowed-short-window",
            views: images.map(({ dataUrl: _dataUrl, ...item }) => item),
            finalView: state().view,
          },
          attachments: images.map((item) => ({
            kind: "image", dataUrl: item.dataUrl,
            label: `${item.role} ${item.startSec.toFixed(3)}-${item.endSec.toFixed(3)}s`,
            metadata: { role: item.role, startSec: item.startSec, endSec: item.endSec, channels: item.channels, windowed: true },
          })),
        };
      }

      assertImagePlanBudget(plan.views, limits, { windowed: false });
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
    signal, workspace, project, artifacts, skills,
    getWorkspaceConfiguration(agentConfig = null) {
      const ctx = state();
      const view = ctx.view || {};
      const settings = ctx.settings || {};
      return {
        agent: agentConfig || null,
        model: agentConfig?.model || null,
        viewer: {
          loaded: Boolean(viewer.header),
          file: ctx.file || null,
          view,
          processing: settings,
          selectedChannel: ctx.selectedChannel || null,
          visibleChannelCount: Array.isArray(ctx.visibleChannels) ? ctx.visibleChannels.length : 0,
        },
        export: readExportConfiguration(),
        capabilities: {
          ...ctx.capabilities,
          windowed: Boolean(ctx.windowed),
          shortWindowImageRendering: viewer.windowed
            ? { available: true, maxImages: agentConfig?.maxAgentImages ?? 5, maxWindowSec: agentConfig?.maxImageWindowSec ?? 15 }
            : { available: true, mode: "full-array" },
          currentViewPng: Boolean(viewer.header),
          fullArrayCsvAndDataExport: Boolean(viewer.header && !viewer.windowed),
          downloadsRequireExplicitUserIntent: true,
        },
        safety: {
          apiKeyReturned: false,
          downloadsDisabledForAgentUnlessExplicitlyRequested: true,
          exportToolHasSideEffects: true,
          skillsCannotGrantToolPermissions: true,
        },
        skills: agentConfig?.skills || null,
      };
    },
    async readGuide(signalAbort) {
      const response = await fetch("/api/ai/knowledge/signal-workspace", { signal: signalAbort });
      if (!response.ok) throw new Error("Signal Workspace guide is unavailable.");
      return response.text();
    },
    async runPython(code, signalAbort, window) {
      const token = viewer.header?.dataToken || viewer.windowToken;
      if (!token) throw new Error("No dataset token is available. Reload the EEG file, then retry.");
      const body = { code, dataToken: token, workspace: state() };
      if (window && Number.isFinite(window.startSec) && Number.isFinite(window.endSec)) {
        body.startSec = window.startSec; body.endSec = window.endSec;
      }
      const response = await fetch("/api/ai/execute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: signalAbort,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || response.statusText);
      return payload;
    },
    // Unified declarative query over the out-of-core store (large recordings).
    // The viewer renders via the same endpoint; the agent issues aggregate/search.
    async signalQuery(spec, signalAbort) {
      const token = viewer.windowToken || viewer.header?.dataToken;
      if (!token) throw new Error("No windowed dataset is loaded.");
      const response = await fetch("/api/signal/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...spec }), signal: signalAbort,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || response.statusText);
      return payload;
    },
  };
}
