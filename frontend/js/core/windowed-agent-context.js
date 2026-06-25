export const WINDOWED_FULL_ARRAY_EXPORT_UNAVAILABLE =
  "Full-array export is unavailable for large windowed recordings. Use bounded window tools for analysis and short-window image rendering.";

const WINDOWED_RECOMMENDED_WORKFLOW = Object.freeze([
  {
    step: "search_candidate_windows",
    tool: "signal_query",
    op: "search",
    purpose: "Use the precomputed feature index to rank candidate channels and time windows before loading raw samples.",
  },
  {
    step: "bounded_exact_analysis",
    tool: "run_python",
    requires: ["startSec", "endSec"],
    purpose: "Load only the selected raw time window for reproducible per-sample computation.",
  },
  {
    step: "short_window_morphology",
    tool: "render_signal_images",
    mode: "short-window-exact",
    purpose: "Render exact raw-sample-backed focused windows for morphology review.",
  },
]);

function roundN(value, digits = 3) {
  return Number.isFinite(value) ? +Number(value).toFixed(digits) : null;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function summarizeChannel(channelMeta, index) {
  const meta = channelMeta[index] || {};
  const min = finiteNumber(meta.min, 0);
  const max = finiteNumber(meta.max, 0);
  return {
    index,
    label: meta.label || `ch${index}`,
    group: meta.group || "",
    sourceIndex: meta.sourceIndex ?? index,
    montage: meta.montage || "raw",
    displayStats: {
      mean: roundN(meta.mean, 4),
      min: roundN(meta.min, 4),
      max: roundN(meta.max, 4),
      peakToPeak: roundN(max - min, 4),
    },
  };
}

export function buildWindowedAgentContext({
  windowMeta = {},
  channelMeta = [],
  selectedChannel = null,
  visibleChannels = [],
  fs = 0,
  duration = 0,
  nChannels = 0,
  tStart = 0,
  tEnd = 0,
  montageMode = "raw",
  normMethod = "none",
  diffOrder = 0,
  unit = "",
  gainMult = 1,
  filterOpts = {},
} = {}) {
  return {
    loaded: true,
    windowed: true,
    agentMode: "large-windowed",
    note: "Large recording in out-of-core windowed mode. Agent analysis is available through indexed search, bounded Python, and exact short-window image rendering.",
    windowedAccess: {
      status: "available",
      query: {
        tool: "signal_query",
        ops: ["search", "aggregate"],
        aggregateExactness: "Wide aggregate requests may be approximate; check result.meta.exact.",
      },
      python: {
        tool: "run_python",
        requires: ["startSec", "endSec"],
        loading: "Only the requested bounded raw time window is loaded into data.",
      },
      images: {
        tool: "render_signal_images",
        mode: "short-window-exact",
        fullOverview: false,
      },
    },
    recommendedWorkflow: WINDOWED_RECOMMENDED_WORKFLOW.map((step) => ({ ...step })),
    file: {
      name: windowMeta.fileName || "",
      format: windowMeta.kind || "h5",
      samplingRateHz: roundN(fs, 4),
      durationSec: roundN(duration, 4),
      sourceChannels: windowMeta.nChannels,
      displayedChannels: nChannels,
      samples: windowMeta.nSamples,
    },
    view: {
      startSec: roundN(tStart, 4),
      endSec: roundN(tEnd, 4),
      spanSec: roundN(tEnd - tStart, 4),
      visibleChannelCount: visibleChannels.length,
      visibleChannelLimit: 24,
    },
    settings: {
      montage: montageMode,
      normalization: normMethod,
      diffOrder,
      unit,
      gain: roundN(gainMult, 4),
      filter: {
        lowHz: Number(filterOpts.low) || 0,
        highHz: Number(filterOpts.high) || 0,
        notchHz: (filterOpts.notch === "50" || filterOpts.notch === "60") ? Number(filterOpts.notch) : 0,
      },
    },
    selectedChannel: selectedChannel === null ? null : summarizeChannel(channelMeta, selectedChannel),
    visibleChannels: visibleChannels.slice(0, 24).map((index) => summarizeChannel(channelMeta, index)),
    events: [],
    privacy: "Summary and feature/index metadata only. Raw waveforms are not included in context.",
  };
}
