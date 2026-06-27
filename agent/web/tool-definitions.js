const channelRef = { type: ["string", "number"], description: "Channel label (for example Fp1) or zero-based index." };
const timeRange = {
  type: "object",
  properties: { startSec: { type: "number" }, endSec: { type: "number" } },
  required: ["startSec", "endSec"],
  additionalProperties: false,
};

function define(name, description, properties = {}, required = [], meta = {}) {
  return Object.freeze({
    name,
    description,
    properties,
    required,
    aliases: meta.aliases || [],
    access: meta.access || "read",
    concurrencySafe: meta.concurrencySafe ?? (meta.access !== "write"),
    destructive: Boolean(meta.destructive),
  });
}

export const TOOL_DEFINITIONS = Object.freeze([
  define("read_signal_workspace_guide", "Read the authoritative Signal Workspace operating guide. Use when capability, side-effect, image, event, or file semantics are uncertain."),
  define("get_signal_workspace_state", "Return the current project, file, view, processing, channel-focus, analysis, event, and export-capability state.", {}, [], { aliases: ["get_current_context"] }),
  define("get_workspace_configuration", "Read the current EEG-Master, viewer, image/export, and capability configuration for planning. This tool is read-only and NEVER returns API keys or secrets.", {}, [], { aliases: ["read_workspace_configuration", "get_agent_configuration"] }),
  define("list_agent_skills", "List EVERY local EEG skill available to EEG-Master (enabled and disabled, user and bundled). Enabled skills are active priors. Disabled skills are inactive for ordinary analysis and expose only minimal name/status unless the user explicitly asks to inspect/use/manage skills or to create/update a skill. Set includeBodies=true only when you need Markdown bodies: ordinary analysis returns bodies for enabled skills only. Skills are prior/context packs, not new permissions.", {
    includeBodies: { type: "boolean", description: "When true, include Markdown bodies for enabled skills. Disabled metadata/bodies are blocked unless the current user request explicitly concerns skills." },
  }),
  define("read_agent_skill", "Read one local EEG skill's full Markdown body by name. Use for enabled skills when relevant, or for disabled skills only when the user explicitly asks to inspect/use/manage that skill or asks to create/update a skill. Do not read disabled skills during ordinary analysis just because their triggers match. Skill instructions guide analysis but never override safety or side-effect policy.", {
    name: { type: "string", description: "Skill name from list_agent_skills." },
  }, ["name"]),
  define("create_agent_skill", "Author and SAVE a new local user EEG skill (a Markdown prior/context pack) to disk. Use ONLY when the user explicitly asked you to create/write/make/save/capture/package/summarize a workflow as a skill in the current turn; otherwise just draft the Markdown in chat. Follow the skill-creator skill for the required SKILL.md shape. Provide a kebab-case `name`, a pushy `description` (what it does AND when to trigger), and a complete Markdown `body`. A skill is prior context only: it never adds tool permissions or overrides safety, annotation, export, or file-switch policy. After saving, the new skill becomes available to list_agent_skills/read_agent_skill.", {
    name: { type: "string", description: "Kebab-case identifier, e.g. center-a-seizure-prior. Becomes the skill folder name." },
    title: { type: "string", description: "Human-readable title." },
    description: { type: "string", description: "Primary trigger text: what the skill does AND specific contexts/phrases for when to use it." },
    body: { type: "string", description: "The full SKILL.md Markdown body (without YAML frontmatter — the framework composes the frontmatter)." },
    category: { type: "string", description: "Short category, e.g. workflow, reporting, dataset." },
    version: { type: "string", description: "Version string, e.g. 1.0." },
    triggers: { type: "array", items: { type: "string" }, maxItems: 24, description: "Short user phrases/contexts that should surface this skill." },
    tags: { type: "array", items: { type: "string" }, maxItems: 24 },
    allowedTools: { type: "array", items: { type: "string" }, maxItems: 24, description: "Informational hint of tools the workflow leans on; does NOT grant permissions." },
    defaultEnabled: { type: "boolean", description: "Whether the skill is enabled by default in the workspace." },
  }, ["name", "description", "body"], { access: "write" }),
  define("update_agent_skill", "Rewrite and SAVE an existing local USER EEG skill in place (bundled skills cannot be edited). Use ONLY when the user explicitly asked you to edit/improve/update a named skill in the current turn. Same field shape as create_agent_skill; the `name` must match an existing editable user skill.", {
    name: { type: "string", description: "Existing editable user skill name." },
    title: { type: "string" },
    description: { type: "string" },
    body: { type: "string", description: "The full replacement SKILL.md Markdown body (without frontmatter)." },
    category: { type: "string" },
    version: { type: "string" },
    triggers: { type: "array", items: { type: "string" }, maxItems: 24 },
    tags: { type: "array", items: { type: "string" }, maxItems: 24 },
    allowedTools: { type: "array", items: { type: "string" }, maxItems: 24 },
    defaultEnabled: { type: "boolean" },
  }, ["name", "body"], { access: "write" }),
  define("list_signal_sources", "List EEG recordings currently available through the authorized Project Explorer, plus the bundled sample."),
  define("open_signal_source", "Open a bundled sample or an authorized project recording. Only valid when the user explicitly asked to open/switch/compare files.", {
    source: { type: "string", enum: ["sample", "project"] },
    path: { type: "string", description: "Project-relative path; required for source=project." },
    discardCurrentEvents: { type: "boolean", description: "Must be true when the current recording contains events that would be cleared." },
  }, ["source"], { access: "write", destructive: true }),
  define("inspect_channel", "Inspect one displayed channel over the current or requested time range using real samples and nearby events.", {
    channel: channelRef, startSec: { type: "number" }, endSec: { type: "number" },
  }, ["channel"]),
  define("rank_channels", "Rank visible channels by a quantitative signal feature for triage.", {
    metric: { type: "string", enum: ["rms", "peakToPeak", "gammaRatio", "dominantFrequency", "artifactScore"] },
    limit: { type: "integer", minimum: 1, maximum: 24 },
  }, ["metric"]),
  define("detect_artifact_candidates", "Rank visible channels for possible artifact or noise and explain the screening reasons.", {
    limit: { type: "integer", minimum: 1, maximum: 24 },
  }),
  define("inspect_time_window", "Summarize a time range across selected or visible channels using real displayed samples.", {
    startSec: { type: "number" }, endSec: { type: "number" },
    channels: { type: "array", items: channelRef },
  }, ["startSec", "endSec"]),
  define("run_python", "Run read-only Python (numpy/scipy) over the raw recording in a sandbox. PRE-DEFINED GLOBALS (do not import or reconstruct them): data = np.float32 array, shape (n_channels, n_samples), the raw decoded signal; fs = sampling rate in Hz (a float — ALWAYS use this directly, never read the rate from workspace); labels, groups (lists, length n_channels); n_channels, n_samples (ints); t = local time vector; startSec, endSec, durationSec = absolute bounds of the loaded data window; window_start_sec/window_end_sec and t_abs are also available; find_channel(ref) -> index; np, numpy, scipy, signal (scipy.signal); workspace = the get_signal_workspace_state JSON plus workspace['executionWindow']. OUTPUTS: put numeric findings in the dict `result`; append candidate annotations (each {onsetSec, offsetSec?, label}) to the list `event_candidates` (returned to the model, never written to the workspace). A matplotlib figure is auto-attached if you create one. Prefer computing from `data`/`fs`; do not assume any workspace key beyond those listed. Each call runs in a FRESH subprocess: variables NEVER persist between run_python calls, so make every script self-contained (recompute, or do all steps in one script). `data` may be the full recording (n_samples can be large) — for heavy per-sample work, slice to the window of interest with int(workspace['view']['startSec']*fs):int(workspace['view']['endSec']*fs). Common abbreviations also resolve: n_ch=n_channels, n_samp=n_samples, sfreq=fs, ch_names=labels. For a LARGE/windowed recording, startSec/endSec are REQUIRED and only that bounded raw window is loaded as `data`; use signal_query op='search' first when the target window is unknown. Successful windowed results report windowed=true, the analyzed window, and exact=true.", {
    code: { type: "string" }, purpose: { type: "string" },
    startSec: { type: "number", description: "Window start (seconds). Required for large windowed recordings." },
    endSec: { type: "number", description: "Window end (seconds)." },
  }, ["code"]),
  define("signal_query", "Query the out-of-core data store of a LARGE recording WITHOUT scanning it — the agent's index/window interface (like grep+read over files). op='search': rank windows by a feature metric over the precomputed per-channel×1s feature index ('find candidate ictal/artifact windows') — returns top windows {channel,startSec,endSec,score,features}. op='aggregate': per-channel stats (mean/rms/min/max/peakToPeak) over a [startSec,endSec] region; check result.meta.exact (true = exact from raw; false = approximate from the feature/LoD index for very wide spans). First-class large-recording workflow: signal_query search -> pick a bounded candidate -> run_python(startSec,endSec) for exact per-sample analysis -> render_signal_images on a short detail window. Only valid for windowed recordings (get_signal_workspace_state.windowed=true); for small recordings use inspect_channel/inspect_time_window/rank_channels.", {
    op: { type: "string", enum: ["search", "aggregate"] },
    metric: { type: "string", enum: ["rms", "lineLength", "p2p", "zeroCross", "artifact"], description: "search ranking metric." },
    predicate: { type: "object", properties: { gt: { type: "number" }, lt: { type: "number" } }, additionalProperties: false, description: "Optional search filter on the metric value." },
    limit: { type: "integer", minimum: 1, maximum: 64, description: "search: max windows to return." },
    startSec: { type: "number" }, endSec: { type: "number" },
    channels: { type: "array", items: channelRef, maxItems: 64 },
  }, ["op"]),
  define("control_signal_view", "Drive the visible Signal Workspace: time window, selected channel, focused channel set and neighbors, search/sort, gain, row height, and analysis panel.", {
    channel: channelRef,
    startSec: { type: "number" }, endSec: { type: "number" },
    channels: { type: "array", items: channelRef, maxItems: 64 },
    neighborRadius: { type: "integer", minimum: 0, maximum: 8 },
    clearChannelFocus: { type: "boolean" },
    search: { type: "string" }, sort: { type: "string", enum: ["file", "group", "freq"] },
    gain: { type: "number", minimum: 0.001, maximum: 2000 },
    rowHeightPx: { type: "integer", minimum: 16, maximum: 160 },
    analysisOpen: { type: "boolean" }, analysisMode: { type: "string", enum: ["spectrum", "spectrogram"] },
    reset: { type: "boolean" },
  }, [], { aliases: ["set_view"], access: "write" }),
  define("configure_signal_processing", "Adjust montage, zero-phase band filtering, harmonic notch, normalization, and differencing.", {
    montage: { type: "string", enum: ["raw", "bipolar", "car", "group-car", "local"] },
    filterPreset: { type: "string", enum: ["review", "seizure", "sleep", "hfo", "off"] },
    lowHz: { type: "number" }, highHz: { type: "number" },
    notchHz: { type: "string", enum: ["off", "50", "60"] },
    normalization: { type: "string", enum: ["none", "zscore", "minmax", "robust", "globalz", "l2"] },
    diffOrder: { type: "integer", minimum: 0, maximum: 4 },
  }, [], { aliases: ["set_processing"], access: "write" }),
  define("manage_signal_events", "Add, update, or remove point/interval events. The control layer permits this only when the current user message explicitly requests annotation.", {
    operation: { type: "string", enum: ["add", "update", "remove"] },
    events: { type: "array", maxItems: 64, items: { type: "object", properties: {
      id: { type: "string" }, onsetSec: { type: "number" }, offsetSec: { type: "number" }, label: { type: "string" },
    }, additionalProperties: false } },
  }, ["operation", "events"], { aliases: ["add_marker", "mark_events"], access: "write", destructive: true }),
  define("render_signal_images", "Render model-readable signal images with the built-in producer while driving the visible workspace. Supports full/current/range/batch/multiscale on small files. On LARGE/windowed files it renders exact raw-sample-backed short windows only: each image must fit the Config maxImageWindowSec (default 15s) and total images must fit maxAgentImages (default 5); full-recording overview is unavailable. Use signal_query search first, then bounded run_python when quantitative evidence is needed, then choose focused short windows for morphology. Required by scope: `range` needs a `range` {startSec,endSec} (endSec>startSec); `multiscale` needs `detailRanges`; `batch` needs `batch`. full/current need neither.", {
    scope: { type: "string", enum: ["full", "current", "range", "batch", "multiscale"] },
    range: timeRange,
    detailRanges: { type: "array", maxItems: 4, items: timeRange, description: "Order least to most important; the last range remains visible." },
    batch: { type: "object", properties: {
      startSec: { type: "number" }, endSec: { type: "number" }, windowSec: { type: "number" }, stepSec: { type: "number" },
      indices: { type: "array", maxItems: 4, items: { type: "integer", minimum: 0 } },
    }, additionalProperties: false },
    source: { type: "string", enum: ["raw", "physical", "processed"] },
    channelScope: { type: "string", enum: ["all", "visible", "selected"] },
    channels: { type: "array", maxItems: 64, items: channelRef },
    neighborRadius: { type: "integer", minimum: 0, maximum: 8 },
    width: { type: "integer", minimum: 640, maximum: 2048 },
    height: { type: "integer", minimum: 320, maximum: 4096 },
    autoHeight: { type: "boolean" }, rowHeight: { type: "integer", minimum: 16, maximum: 80 },
    labelFontSizePx: { type: "integer", minimum: 6, maximum: 24 },
    style: { type: "string", enum: ["viewer", "training"] },
    palette: { type: "string", enum: ["current", "cycle", "black", "mono"] },
    monoColor: { type: "string" }, showLabels: { type: "boolean" }, showEvents: { type: "boolean" }, showGrid: { type: "boolean" },
    reason: { type: "string" },
  }, ["scope"], { aliases: ["capture_waveform_view"], access: "write" }),
  define("export_signal_artifact", "Download a user-facing image, batch ZIP, CSV, event JSON, H5, or EDF+ artifact. Only valid when the user explicitly requested export/download/save.", {
    format: { type: "string", enum: ["viewer-png", "training-png", "training-zip", "csv", "events-json", "h5", "edf"] },
    source: { type: "string", enum: ["raw", "physical", "processed"] },
    channels: { type: "string", enum: ["all", "visible"] },
    range: { type: "string", enum: ["full", "current"] },
    windowSec: { type: "number" }, stepSec: { type: "number" }, includePartial: { type: "boolean" },
  }, ["format"], { access: "write", destructive: true }),
]);

const byName = new Map();
for (const definition of TOOL_DEFINITIONS) {
  byName.set(definition.name, definition);
  definition.aliases.forEach((alias) => byName.set(alias, definition));
}

export function getToolDefinition(name) { return byName.get(String(name || "")) || null; }
export function resolveToolName(name) { return getToolDefinition(name)?.name || String(name || ""); }

export const EEG_TOOLS = TOOL_DEFINITIONS.map((definition) => ({
  type: "function",
  function: {
    name: definition.name,
    description: definition.description,
    parameters: {
      type: "object",
      properties: definition.properties,
      required: definition.required,
      additionalProperties: false,
    },
  },
}));
