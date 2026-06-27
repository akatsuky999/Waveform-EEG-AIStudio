// Signal Workspace tool execution. Tool schemas/metadata live in
// tool-definitions.js; this module owns only validated dispatch and analysis.

import { getToolDefinition, resolveToolName } from "./tool-definitions.js";
import { requireAction } from "./intent-policy.js";

const BAND_META = [
  ["delta", "δ", "0.5-4"], ["theta", "θ", "4-8"], ["alpha", "α", "8-13"],
  ["beta", "β", "13-30"], ["gamma", "γ", "30-80"],
];
// Per-skill body cap when reading every skill at once via list_agent_skills.
const SKILL_BODY_CHARS = 6000;

function round(number) { return Math.round(number * 100) / 100; }
function ok(name, result, extra = {}) { return { name, ok: true, result, ...extra }; }
function skillSummary(skill = {}) {
  return {
    name: skill.name, title: skill.title, description: skill.description,
    category: skill.category, version: skill.version, source: skill.source,
    triggers: Array.isArray(skill.triggers) ? skill.triggers.slice(0, 12) : [],
    note: "Skill saved to disk. It is now available via list_agent_skills / read_agent_skill. A skill is prior context only and grants no tool permissions.",
  };
}
function windowedWorkflowHint(op = "search") {
  return op === "aggregate"
    ? "Use result.meta.exact to judge precision; for exact morphology, choose a short bounded window and call run_python(startSec,endSec) or render_signal_images."
    : "Pick the strongest candidate window, then call run_python(startSec,endSec) for exact computation and render_signal_images for short-window morphology.";
}
function enabledSkillSet(host) {
  return new Set((host.getAgentConfiguration?.().skills?.enabled || []).map((name) => String(name || "").trim()).filter(Boolean));
}
function compactSkillText(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}
function userNamedSkill(policy, name) {
  const text = compactSkillText(policy?.userText);
  const compactName = compactSkillText(name);
  return !!compactName && text.includes(compactName);
}
function canReadDisabledSkill(policy, name) {
  return Boolean(policy?.skillWrite || policy?.skillInspect || userNamedSkill(policy, name));
}
function redactDisabledSkill(skill) {
  return {
    name: skill.name,
    title: skill.title,
    category: skill.category,
    source: skill.source,
    editable: Boolean(skill.editable),
    deletable: Boolean(skill.deletable),
    enabled: false,
    inactive: true,
    note: "Disabled in Agent settings; do not use for ordinary analysis.",
  };
}

export async function runToolCall(host, call, signal, policy = {}) {
  const requestedName = String(call?.name || call?.tool || "").trim();
  const name = resolveToolName(requestedName);
  const args = normalizeLegacyArgs(requestedName,
    call?.arguments && typeof call.arguments === "object" ? call.arguments : {});
  try {
    if (!getToolDefinition(name)) throw new Error(`Unsupported tool: ${requestedName || "empty"}`);
    if (name === "read_signal_workspace_guide") return ok(name, { markdown: await host.readGuide(signal) });
    if (name === "get_signal_workspace_state") return ok(name, host.signal.getState());
    if (name === "get_workspace_configuration") return ok(name, host.getWorkspaceConfiguration?.(host.getAgentConfiguration?.()) || {});
    if (name === "list_agent_skills") {
      const listed = await host.skills.list(signal);
      const enabled = enabledSkillSet(host);
      const includeDisabledBodies = canReadDisabledSkill(policy);
      let skills = (listed.skills || []).map((skill) => {
        const active = enabled.has(skill.name);
        const manifest = { ...skill, enabled: active };
        return active || includeDisabledBodies ? manifest : redactDisabledSkill(manifest);
      });
      if (args.includeBodies) {
        skills = await Promise.all(skills.map(async (skill) => {
          if (!skill.enabled && !includeDisabledBodies) {
            return {
              ...skill,
              markdown: "",
              readBlocked: "Skill is disabled. Enable it in Agent settings, or explicitly ask to inspect/use this skill in the current turn.",
            };
          }
          try {
            const full = await host.skills.read(skill.name, signal);
            const body = typeof full?.markdown === "string" ? full.markdown : "";
            return { ...skill, markdown: body.length > SKILL_BODY_CHARS ? `${body.slice(0, SKILL_BODY_CHARS)}…(truncated)` : body };
          } catch (error) {
            return { ...skill, markdown: "", readError: error.message || String(error) };
          }
        }));
      }
      return ok(name, { ...listed, skills, includedBodies: !!args.includeBodies });
    }
    if (name === "read_agent_skill") {
      const skillName = String(args.name || "").trim();
      if (!enabledSkillSet(host).has(skillName) && !canReadDisabledSkill(policy, skillName)) {
        throw new Error("Skill is disabled. Enable it in Agent settings, or explicitly ask to inspect/use this skill in the current turn.");
      }
      return ok(name, await host.skills.read(skillName, signal));
    }
    if (name === "create_agent_skill") {
      requireAction(policy, "skillWrite");
      const saved = await host.skills.create(args, signal);
      return ok(name, { saved: true, operation: "create", skill: skillSummary(saved) });
    }
    if (name === "update_agent_skill") {
      requireAction(policy, "skillWrite");
      const saved = await host.skills.update(args.name, args, signal);
      return ok(name, { saved: true, operation: "update", skill: skillSummary(saved) });
    }
    if (name === "list_signal_sources") return ok(name, await host.project.listSources());
    if (name === "open_signal_source") {
      requireAction(policy, "fileSwitch");
      return ok(name, await host.project.openSource(args));
    }
    if (name === "signal_query") return signalQueryTool(host, args, signal);
    if (name === "inspect_channel") {
      if (isWindowed(host)) return ok(name, await windowedInspectChannel(host, args, signal));
      const index = host.signal.resolveChannel(args.channel ?? args.label ?? args.index);
      if (index === null) throw new Error("Channel not found");
      return ok(name, inspectChannelTool(host, index, args));
    }
    if (name === "rank_channels") {
      if (isWindowed(host)) return ok(name, await windowedRank(host, args, signal));
      return ok(name, rankChannelsTool(host, args.metric || "artifactScore", args.limit));
    }
    if (name === "detect_artifact_candidates") {
      if (isWindowed(host)) return ok(name, await windowedRank(host, { metric: "artifactScore", limit: args.limit }, signal));
      return ok(name, detectArtifactCandidatesTool(host, args.limit));
    }
    if (name === "inspect_time_window") {
      if (isWindowed(host)) return ok(name, await windowedTimeWindow(host, args, signal));
      return ok(name, inspectTimeWindowTool(host, args));
    }
    if (name === "run_python") return runPythonTool(host, args, signal);
    if (name === "control_signal_view") return ok(name, host.workspace.setView(args));
    if (name === "configure_signal_processing") return ok(name, host.workspace.configureProcessing(args));
    if (name === "manage_signal_events") {
      requireAction(policy, "annotation");
      return ok(name, host.workspace.manageEvents(args.operation, args.events));
    }
    if (name === "render_signal_images") {
      const rendered = await host.artifacts.renderImages({ ...args, __agentLimits: host.getAgentConfiguration?.() }, signal);
      return ok(name, rendered.result, { attachments: rendered.attachments || [] });
    }
    if (name === "export_signal_artifact") {
      requireAction(policy, "export");
      return ok(name, await host.artifacts.exportArtifact(args, signal));
    }
    throw new Error(`Unsupported tool: ${requestedName || "empty"}`);
  } catch (error) {
    return { name: name || requestedName || "unknown", ok: false, error: error.message || String(error) };
  }
}
function normalizeLegacyArgs(name, args) {
  if (name === "add_marker") {
    return { operation: "add", events: [{ onsetSec: args.timeSec ?? args.time, label: args.label }] };
  }
  if (name === "mark_events") return { operation: "add", events: args.events || [] };
  if (name === "capture_waveform_view") {
    return { scope: "current", width: args.maxWidthPx, reason: args.reason, channelScope: "visible" };
  }
  if (name === "set_view") return { ...args, analysisOpen: args.openAnalysis ?? args.analysisOpen };
  return args;
}

export function toolTitle(name, args = {}) {
  const canonical = resolveToolName(name);
  const map = {
    read_signal_workspace_guide: "Read Signal Workspace guide",
    get_signal_workspace_state: "Read workspace state",
    get_workspace_configuration: "Read workspace configuration",
    list_agent_skills: "List EEG skills",
    read_agent_skill: `Using skill · ${args.name || "unknown"}`,
    create_agent_skill: `Create skill · ${args.name || "new"}`,
    update_agent_skill: `Update skill · ${args.name || "unknown"}`,
    list_signal_sources: "List signal sources",
    open_signal_source: `Open ${args.path || args.source || "signal source"}`,
    inspect_channel: `Inspect channel ${args.channel ?? args.label ?? args.index ?? ""}`.trim(),
    rank_channels: `Rank channels · ${args.metric || "artifactScore"}`,
    detect_artifact_candidates: "Detect artifact candidates",
    inspect_time_window: `Inspect window ${args.startSec ?? "?"}–${args.endSec ?? "?"}s`,
    run_python: args.purpose ? `Run Python · ${String(args.purpose).slice(0, 60)}` : "Run Python",
    signal_query: args.op === "search"
      ? `Signal search · ${args.metric || "rms"}`
      : `Signal aggregate · ${args.startSec ?? "?"}–${args.endSec ?? "?"}s`,
    control_signal_view: "Control signal view",
    configure_signal_processing: "Configure signal processing",
    manage_signal_events: `${args.operation || "Manage"} signal events`,
    render_signal_images: `Render signal images · ${args.scope || "current"}`,
    export_signal_artifact: `Export ${args.format || "artifact"}`,
  };
  return map[canonical] || canonical || "Tool";
}

// ---- queryable-store tools (large recordings) ---------------------------
function isWindowed(host) {
  try { return !!host.signal.getState()?.windowed; } catch { return false; }
}

async function signalQueryTool(host, args, signal) {
  const op = String(args.op || "");
  if (op !== "search" && op !== "aggregate") {
    return { name: "signal_query", ok: false, error: "op must be 'search' or 'aggregate'." };
  }
  try {
    const spec = { op };
    if (op === "search") {
      spec.metric = args.metric || "rms";
      if (args.predicate && typeof args.predicate === "object") spec.predicate = args.predicate;
      if (args.limit != null) spec.limit = args.limit;
    }
    if (numberArg(args.startSec) !== null) spec.startSec = numberArg(args.startSec);
    if (numberArg(args.endSec) !== null) spec.endSec = numberArg(args.endSec);
    if (Array.isArray(args.channels) && args.channels.length) {
      spec.channels = args.channels.map((ref) => host.signal.resolveChannel(ref)).filter(Number.isInteger);
    }
    const payload = await host.signalQuery(spec, signal);
    return ok("signal_query", { ...payload, workflowHint: windowedWorkflowHint(op) });
  } catch (error) {
    return { name: "signal_query", ok: false, error: error.message || String(error) };
  }
}

async function windowedInspectChannel(host, args, signal) {
  const index = host.signal.resolveChannel(args.channel ?? args.label ?? args.index);
  if (index === null) throw new Error("Channel not found");
  const view = host.signal.getView();
  const start = numberArg(args.startSec) ?? view.startSec;
  const end = numberArg(args.endSec) ?? view.endSec;
  const payload = await host.signalQuery({ op: "aggregate", startSec: start, endSec: end, channels: [index] }, signal);
  const meta = host.signal.getChannelMeta(index) || {};
  return {
    channel: { index, label: meta.label, group: meta.group },
    exact: payload.meta?.exact, window: payload.channels?.[0] || null,
  };
}

async function windowedTimeWindow(host, args, signal) {
  const start = numberArg(args.startSec), end = numberArg(args.endSec);
  if (start === null || end === null || end <= start) throw new Error("startSec/endSec must define a forward time window");
  const channels = Array.isArray(args.channels) && args.channels.length
    ? args.channels.map((ref) => host.signal.resolveChannel(ref)).filter(Number.isInteger) : undefined;
  const payload = await host.signalQuery({ op: "aggregate", startSec: start, endSec: end, channels }, signal);
  return {
    startSec: round(start), endSec: round(end), durationSec: round(end - start),
    exact: payload.meta?.exact, channels: payload.channels || [],
  };
}

async function windowedRank(host, args, signal) {
  const map = { rms: "rms", peakToPeak: "p2p", artifactScore: "artifact", gammaRatio: "lineLength", dominantFrequency: "zeroCross" };
  const metric = map[args.metric] || "rms";
  const payload = await host.signalQuery({ op: "search", metric, limit: args.limit || 8 }, signal);
  return (payload.windows || []).map((w) => ({
    index: w.channel, label: w.label, metric, score: w.score,
    startSec: w.startSec, endSec: w.endSec, ...w.features,
  }));
}

async function runPythonTool(host, args, signal) {
  const code = String(args.code || "");
  if (!code.trim()) return { name: "run_python", ok: false, error: "code is required", code };
  const windowed = isWindowed(host);
  const window = { startSec: numberArg(args.startSec), endSec: numberArg(args.endSec) };
  if (windowed && (window.startSec === null || window.endSec === null || window.endSec <= window.startSec)) {
    return {
      name: "run_python",
      ok: false,
      error: "Large/windowed run_python requires a bounded startSec/endSec window. Use signal_query op='search' first to choose candidate windows.",
      workflowHint: windowedWorkflowHint("search"),
      code,
    };
  }
  try {
    const data = await host.runPython(code, signal, window);
    const figure = data.figurePngDataUrl || null;
    const candidates = Array.isArray(data.eventCandidates) ? data.eventCandidates
      : Array.isArray(data.markers) ? data.markers : [];
    const result = {
      ok: data.ok,
      timedOut: data.timedOut || false,
      stdout: data.stdout || "",
      stderr: data.stderr || "",
      result: data.result ?? null,
      error: data.error || null,
      eventCandidates: candidates.slice(0, 64),
      eventsApplied: 0,
      figureAttached: !!figure,
    };
    if (windowed) {
      result.windowed = true;
      result.window = {
        startSec: round(window.startSec),
        endSec: round(window.endSec),
        durationSec: round(window.endSec - window.startSec),
      };
      result.exact = true;
      result.workflowHint = "Use render_signal_images on this short window for morphology evidence before making visual claims.";
    }
    const attachments = figure ? [{ kind: "image", dataUrl: figure, label: "Python analysis figure" }] : [];
    return { name: "run_python", ok: !!data.ok, result, attachments, code };
  } catch (error) {
    return { name: "run_python", ok: false, error: error.message || String(error), code };
  }
}

function inspectChannelTool(host, index, args = {}) {
  const view = host.signal.getView();
  const start = numberArg(args.startSec) ?? view.startSec;
  const end = numberArg(args.endSec) ?? view.endSec;
  const window = summarizeChannelWindow(host, index, start, end);
  const meta = host.signal.getChannelMeta(index) || {};
  const stats = host.signal.getChannelStats(index) || {};
  return {
    channel: { index, label: meta.label, group: meta.group, montage: meta.montage || "raw" },
    window,
    wholeWindowFrequencyHz: round(stats.freq || 0),
    dominantBand: stats.dominantBand || "",
    bandEnergyRatio: Object.fromEntries(BAND_META.map(([id]) => [id, round(stats.bands?.[id] || 0)])),
    nearbyEvents: host.signal.getEvents()
      .filter((event) => (event.offsetSec ?? event.onsetSec) >= start && event.onsetSec <= end)
      .slice(0, 8).map((event) => ({
        label: event.label, type: event.type, onsetSec: round(event.onsetSec),
        offsetSec: event.offsetSec == null ? null : round(event.offsetSec),
      })),
  };
}

function rankChannelsTool(host, metric = "artifactScore", limit = 8) {
  const view = host.signal.getView();
  const rows = host.signal.getVisibleChannels().map((index) => {
    const summary = summarizeChannelWindow(host, index, view.startSec, view.endSec);
    const whole = host.signal.getChannelStats(index) || {};
    const gamma = whole.bands?.gamma || 0;
    const score = metric === "rms" ? summary.rms
      : metric === "peakToPeak" ? summary.peakToPeak
      : metric === "gammaRatio" ? gamma
      : metric === "dominantFrequency" ? (whole.freq || 0)
      : artifactScore(host, summary, whole);
    const meta = host.signal.getChannelMeta(index) || {};
    return {
      index, label: meta.label, group: meta.group, metric, score: round(score),
      rms: summary.rms, peakToPeak: summary.peakToPeak,
      dominantFrequencyHz: round(whole.freq || 0), dominantBand: whole.dominantBand || "",
      gammaRatio: round(gamma),
    };
  });
  rows.sort((a, b) => (b.score || 0) - (a.score || 0));
  return rows.slice(0, Math.max(1, Math.min(24, parseInt(limit, 10) || 8)));
}

function detectArtifactCandidatesTool(host, limit = 8) {
  return rankChannelsTool(host, "artifactScore", limit).map((row) => {
    const reasons = [];
    if (row.gammaRatio > 0.35) reasons.push("high gamma/high-frequency ratio");
    if (row.dominantFrequencyHz >= 48 && row.dominantFrequencyHz <= 62) reasons.push("line-noise-like dominant frequency");
    if (row.peakToPeak > medianVisiblePeakToPeak(host) * 2.5) reasons.push("large peak-to-peak relative to visible channels");
    if (row.rms < medianVisibleRms(host) * 0.15) reasons.push("near-flat/low variance channel");
    return { ...row, reasons: reasons.length ? reasons : ["relative outlier by mixed artifact score"] };
  });
}

function inspectTimeWindowTool(host, args = {}) {
  const start = numberArg(args.startSec), end = numberArg(args.endSec);
  if (start === null || end === null || end <= start) throw new Error("startSec/endSec must define a forward time window");
  const requested = Array.isArray(args.channels) && args.channels.length
    ? args.channels.map((ref) => host.signal.resolveChannel(ref)).filter(Number.isInteger)
    : host.signal.getVisibleChannels();
  const channels = [...new Set(requested)].slice(0, 32).map((index) => {
    const meta = host.signal.getChannelMeta(index) || {};
    return { index, label: meta.label, group: meta.group, ...summarizeChannelWindow(host, index, start, end) };
  });
  return { startSec: round(start), endSec: round(end), durationSec: round(end - start), channels };
}

function summarizeChannelWindow(host, index, start, end) {
  const values = host.signal.getDisplayedChannel(index);
  const view = host.signal.getView();
  if (!values) return { startSec: round(start), endSec: round(end), samples: 0, mean: 0, rms: 0, peakToPeak: 0, min: 0, max: 0 };
  const i0 = Math.max(0, Math.min(values.length - 1, Math.floor(start * view.fs)));
  const i1 = Math.max(i0 + 1, Math.min(values.length, Math.ceil(end * view.fs)));
  let sum = 0, sumSq = 0, min = Infinity, max = -Infinity;
  for (let i = i0; i < i1; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    sum += value; sumSq += value * value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const count = i1 - i0;
  return {
    startSec: round(i0 / view.fs), endSec: round(i1 / view.fs), samples: count,
    mean: round(sum / count), rms: round(Math.sqrt(sumSq / count)),
    peakToPeak: round((Number.isFinite(max) ? max : 0) - (Number.isFinite(min) ? min : 0)),
    min: round(Number.isFinite(min) ? min : 0), max: round(Number.isFinite(max) ? max : 0),
  };
}

function artifactScore(host, summary, whole) {
  const medP2P = medianVisiblePeakToPeak(host) || 1;
  const medRms = medianVisibleRms(host) || 1;
  const highFreq = whole.bands?.gamma || 0;
  const amplitude = Math.min(5, summary.peakToPeak / medP2P);
  const flat = summary.rms < medRms * 0.15 ? 2 : 0;
  const line = whole.freq >= 48 && whole.freq <= 62 ? 1.5 : 0;
  return highFreq * 4 + amplitude + flat + line;
}

function medianVisiblePeakToPeak(host) {
  const view = host.signal.getView();
  return median(host.signal.getVisibleChannels().map((index) =>
    summarizeChannelWindow(host, index, view.startSec, view.endSec).peakToPeak).filter((value) => value > 0));
}

function medianVisibleRms(host) {
  const view = host.signal.getView();
  return median(host.signal.getVisibleChannels().map((index) =>
    summarizeChannelWindow(host, index, view.startSec, view.endSec).rms).filter((value) => value > 0));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numberArg(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Legacy text-protocol actions are intentionally narrow and share the same
// host control surface. Event writes still pass through the per-turn hard gate.
export function executeEEGActions(host, actions, policy = {}) {
  if (!Array.isArray(actions) || !actions.length) return [];
  const notes = [];
  for (const item of actions.slice(0, 8)) {
    const action = String(item?.action || item?.type || "");
    try {
      if (action === "selectChannel") notes.push(...host.workspace.setView({ channel: item.channel ?? item.label ?? item.index }).applied);
      else if (action === "setTimeWindow") notes.push(...host.workspace.setView({ startSec: item.start ?? item.startSec, endSec: item.end ?? item.endSec }).applied);
      else if (action === "setMontage") notes.push(...host.workspace.configureProcessing({ montage: item.mode ?? item.montage }).applied);
      else if (action === "setFilter") notes.push(...host.workspace.configureProcessing({ lowHz: item.low ?? item.lowHz, highHz: item.high ?? item.highHz, notchHz: item.notch ?? item.notchHz }).applied);
      else if (action === "setNormalization") notes.push(...host.workspace.configureProcessing({ normalization: item.method ?? item.normalization }).applied);
      else if (action === "setDiff") notes.push(...host.workspace.configureProcessing({ diffOrder: item.order ?? item.n }).applied);
      else if (action === "searchChannels") notes.push(...host.workspace.setView({ search: item.query ?? item.search }).applied);
      else if (action === "setSort") notes.push(...host.workspace.setView({ sort: item.mode ?? item.sort }).applied);
      else if (action === "openAnalysis") notes.push(...host.workspace.setView({ analysisOpen: true, analysisMode: item.mode }).applied);
      else if (action === "resetView") notes.push(...host.workspace.setView({ reset: true }).applied);
      else if (action === "addMarker") {
        requireAction(policy, "annotation");
        host.workspace.manageEvents("add", [{ onsetSec: item.time ?? item.timeSec, label: item.label }]);
        notes.push("event added");
      }
    } catch { /* Invalid legacy action: ignore and continue. */ }
  }
  return notes;
}
