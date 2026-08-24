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
// Agent-authored skills should be compact priors/workflows, not full reports.
const SKILL_WRITE_BODY_CHARS = 24000;
const SKILL_WRITE_ARG_ERROR = "工具参数损坏或过长，请用更短 skill body 重试。";

function round(number) { return Math.round(number * 100) / 100; }
function ok(name, result, extra = {}) { return { name, ok: true, result, ...extra }; }
function toolErrorPayload(name, error, extra = {}) {
  const payload = { name: name || "unknown", ok: false, error: error.message || String(error), ...extra };
  for (const key of ["errorCode", "workflowHint", "expired", "retryable"]) {
    if (error?.[key] != null && payload[key] == null) payload[key] = error[key];
  }
  return payload;
}
function skillSummary(skill = {}) {
  return {
    name: skill.name, title: skill.title, description: skill.description,
    category: skill.category, version: skill.version, source: skill.source,
    triggers: Array.isArray(skill.triggers) ? skill.triggers.slice(0, 12) : [],
    note: "Skill saved to disk. It is now available via list_agent_skills / read_agent_skill. A skill is prior context only and grants no tool permissions.",
  };
}
function skillWriteInputError(message = SKILL_WRITE_ARG_ERROR) {
  const error = new Error(message);
  error.errorCode = "SKILL_WRITE_INVALID_ARGUMENTS";
  error.workflowHint = "把完整报告留在聊天里；skill 只保存可复用核心、触发条件、证据流程、迁移限制和验证标准。";
  error.retryable = true;
  return error;
}
function skillBodyArg(args = {}) {
  if (typeof args.body === "string") return args.body;
  if (typeof args.markdown === "string") return args.markdown;
  return "";
}
function validateSkillWriteArgs(toolName, args = {}) {
  if (!args || typeof args !== "object" || typeof args.__raw === "string") {
    throw skillWriteInputError();
  }
  if (!String(args.name || "").trim()) throw skillWriteInputError();
  const body = skillBodyArg(args).trim();
  if (!body) throw skillWriteInputError();
  if (body.length > SKILL_WRITE_BODY_CHARS) throw skillWriteInputError();
  if (toolName === "create_agent_skill" && !String(args.description || "").trim()) {
    throw skillWriteInputError();
  }
  return args;
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

// Side effects go through the permission broker when one is attached (the live
// agent), and fall back to the per-turn intent read when it is not (tests,
// legacy callers). Both paths end in the same refusal error, so the model sees
// one consistent contract.
async function authorize(host, policy, capability, tool, args) {
  if (policy?.broker?.require) {
    let eventCount;
    try { eventCount = host?.signal?.getEvents?.().length; } catch { eventCount = undefined; }
    return policy.broker.require(capability, { tool, args, context: { eventCount } });
  }
  requireAction(policy, capability);
  return { granted: true, source: "turn-intent" };
}

function authorizationNote(decision) {
  if (!decision?.source) return {};
  const label = {
    "user-prompt": decision.scope === "conversation"
      ? "The user approved this action and allowed it for the rest of this conversation."
      : "The user reviewed and approved this exact action.",
    "conversation-grant": "Covered by an approval the user already gave for this conversation.",
    "turn-intent": "Authorized by the user's request in this turn.",
    "trusted-mode": "Auto-approved because the workspace is in trusted mode.",
  }[decision.source];
  return label ? { authorizedBy: decision.source, authorization: label } : {};
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
      validateSkillWriteArgs(name, args);   // validate before asking the user to approve
      const decision = await authorize(host, policy, "skillWrite", name, args);
      const saved = await host.skills.create(args, signal);
      return ok(name, { saved: true, operation: "create", skill: skillSummary(saved), ...authorizationNote(decision) });
    }
    if (name === "update_agent_skill") {
      validateSkillWriteArgs(name, args);
      const decision = await authorize(host, policy, "skillWrite", name, args);
      const saved = await host.skills.update(args.name, args, signal);
      return ok(name, { saved: true, operation: "update", skill: skillSummary(saved), ...authorizationNote(decision) });
    }
    if (name === "list_context_files") return ok(name, await listContextFilesTool(host, signal));
    if (name === "read_context_file") return ok(name, await readContextFileTool(host, args, signal));
    if (name === "grep_context_file") return ok(name, await grepContextFileTool(host, args, signal));
    if (name === "list_signal_sources") return ok(name, await host.project.listSources());
    if (name === "open_signal_source") {
      const decision = await authorize(host, policy, "fileSwitch", name, args);
      return ok(name, { ...await host.project.openSource(args), ...authorizationNote(decision) });
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
      const decision = await authorize(host, policy, "annotation", name, args);
      return ok(name, {
        ...compactEventWriteResult(host.workspace.manageEvents(args.operation, args.events)),
        ...authorizationNote(decision),
      });
    }
    if (name === "render_signal_images") {
      const rendered = await host.artifacts.renderImages({ ...args, __agentLimits: host.getAgentConfiguration?.() }, signal);
      return ok(name, rendered.result, { attachments: rendered.attachments || [] });
    }
    if (name === "export_signal_artifact") {
      const decision = await authorize(host, policy, "export", name, args);
      return ok(name, { ...await host.artifacts.exportArtifact(args, signal), ...authorizationNote(decision) });
    }
    throw new Error(`Unsupported tool: ${requestedName || "empty"}`);
  } catch (error) {
    return toolErrorPayload(name || requestedName || "unknown", error);
  }
}

function compactEventWriteResult(result = {}) {
  const changed = Array.isArray(result.changed) ? result.changed : [];
  if (changed.length <= 24) return result;
  const preview = [...changed.slice(0, 8), ...changed.slice(-4)].map((event) => ({
    id: event.id, type: event.type, label: event.label,
    onsetSec: event.onsetSec, offsetSec: event.offsetSec ?? null,
    removed: event.removed || undefined,
  }));
  return {
    ...result,
    changed: preview,
    changedPreviewCount: preview.length,
    changedOmitted: changed.length - preview.length,
    note: "Bulk event result compacted for the model context; the workspace contains the full applied event set.",
  };
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
    list_context_files: "List attached files",
    read_context_file: `Read file · ${args.file || "attachment"}`,
    grep_context_file: `Search file · ${args.file || "attachment"}`,
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

// Two channel-index spaces exist and they are NOT the same list once a montage
// is on: the viewer shows DERIVED rows (e.g. the bipolar pair FP1-F7), while the
// out-of-core store only knows the RECORDING's source electrodes. Every index
// crossing into signal_query must be translated through channelMeta.sourceIndex,
// or the store answers about a different electrode than the one the model asked
// about — silently, with confident numbers.
function toSourceIndex(host, displayedIndex) {
  if (!Number.isInteger(displayedIndex)) return null;
  const source = host.signal.getChannelMeta?.(displayedIndex)?.sourceIndex;
  return Number.isInteger(source) ? source : displayedIndex;
}

function resolveSourceChannel(host, ref) {
  const displayed = host.signal.resolveChannel(ref);
  return displayed === null || displayed === undefined ? null : toSourceIndex(host, displayed);
}

function resolveSourceChannels(host, refs) {
  if (!Array.isArray(refs) || !refs.length) return undefined;
  const mapped = refs.map((ref) => resolveSourceChannel(host, ref)).filter(Number.isInteger);
  return mapped.length ? [...new Set(mapped)] : undefined;
}

async function signalQueryTool(host, args, signal) {
  const op = String(args.op || "");
  if (op !== "search" && op !== "aggregate") {
    return { name: "signal_query", ok: false, error: "op must be 'search' or 'aggregate'." };
  }
  if (!isWindowed(host)) {
    return {
      name: "signal_query", ok: false,
      error: "signal_query only applies to large/windowed recordings (get_signal_workspace_state.windowed=true). This recording is fully loaded — use inspect_channel, inspect_time_window, rank_channels, or run_python instead.",
      workflowHint: "Check get_signal_workspace_state.windowed before calling signal_query.",
    };
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
    const channels = resolveSourceChannels(host, args.channels);
    if (channels) spec.channels = channels;
    const payload = await host.signalQuery(spec, signal);
    return ok("signal_query", {
      ...payload,
      channelIndexSpace: "recording-source",
      workflowHint: windowedWorkflowHint(op),
    });
  } catch (error) {
    return { name: "signal_query", ok: false, error: error.message || String(error) };
  }
}

async function windowedInspectChannel(host, args, signal) {
  const index = host.signal.resolveChannel(args.channel ?? args.label ?? args.index);
  if (index === null) throw new Error("Channel not found");
  const sourceIndex = toSourceIndex(host, index);
  const view = host.signal.getView();
  const start = numberArg(args.startSec) ?? view.startSec;
  const end = numberArg(args.endSec) ?? view.endSec;
  const payload = await host.signalQuery({ op: "aggregate", startSec: start, endSec: end, channels: [sourceIndex] }, signal);
  const meta = host.signal.getChannelMeta(index) || {};
  return {
    channel: {
      index, sourceIndex, label: meta.label, group: meta.group,
      ...(meta.montage && meta.montage !== "raw" ? {
        montage: meta.montage,
        note: "The view shows a derived montage row; the measurements below come from its source recording channel.",
      } : {}),
    },
    exact: payload.meta?.exact, window: payload.channels?.[0] || null,
  };
}

async function windowedTimeWindow(host, args, signal) {
  const start = numberArg(args.startSec), end = numberArg(args.endSec);
  if (start === null || end === null || end <= start) throw new Error("startSec/endSec must define a forward time window");
  const channels = resolveSourceChannels(host, args.channels);
  const payload = await host.signalQuery({ op: "aggregate", startSec: start, endSec: end, channels }, signal);
  return {
    startSec: round(start), endSec: round(end), durationSec: round(end - start),
    exact: payload.meta?.exact, channels: payload.channels || [],
    channelIndexSpace: "recording-source",
  };
}

// The feature index only carries time-domain features, so a spectral metric has
// no exact equivalent. Substituting one silently (gammaRatio → lineLength) would
// make the model report a band-power ranking it never measured, so the
// substitution is now declared in the result.
const WINDOWED_METRIC = {
  rms: { metric: "rms" },
  peakToPeak: { metric: "p2p" },
  artifactScore: { metric: "artifact" },
  gammaRatio: {
    metric: "lineLength",
    proxy: "The 1 s feature index has no band power. lineLength is used as a high-frequency-content proxy; confirm any gamma claim with run_python on a bounded window.",
  },
  dominantFrequency: {
    metric: "zeroCross",
    proxy: "The 1 s feature index has no spectrum. zeroCross is used as a rate proxy; confirm any dominant-frequency claim with run_python on a bounded window.",
  },
};

async function windowedRank(host, args, signal) {
  const requested = String(args.metric || "artifactScore");
  const mapping = WINDOWED_METRIC[requested] || WINDOWED_METRIC.artifactScore;
  const metric = mapping.metric;
  const limit = Math.max(1, Math.min(24, parseInt(args.limit, 10) || 8));
  // search ranks WINDOWS, and its top-k can be many windows of one channel. This
  // tool promises a CHANNEL ranking, so ask for a deeper window list and keep the
  // strongest window per channel.
  const payload = await host.signalQuery({ op: "search", metric, limit: Math.min(64, limit * 4) }, signal);
  const best = new Map();
  for (const window of payload.windows || []) {
    const current = best.get(window.channel);
    if (!current || (window.score || 0) > (current.score || 0)) best.set(window.channel, window);
  }
  const channels = [...best.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit)
    .map((w) => ({
      index: w.channel, sourceIndex: w.channel, label: w.label,
      metric, metricRequested: requested, score: w.score,
      strongestWindow: { startSec: w.startSec, endSec: w.endSec },
      ...w.features,
    }));
  return {
    metric, metricRequested: requested,
    ...(mapping.proxy ? { metricIsProxy: true, metricNote: mapping.proxy } : {}),
    grain: payload.meta?.grain || "featureGrid:1s",
    channelIndexSpace: "recording-source",
    scannedChannels: payload.meta?.scannedChannels,
    partial: payload.meta?.partial || false,
    channels,
  };
}

// ---- companion-file (attachment) tools ----------------------------------
async function listContextFilesTool(host, signal) {
  const files = await host.attachments.list(signal);
  return {
    count: files.length,
    files,
    note: files.length
      ? "Conversation-scoped companion files restored into the backend tool cache. Use read_context_file / grep_context_file only for bounded inspection. For full-file parsing/import, call run_python and read the file from the `attachments` global; do not stream the whole file through chat."
      : "No companion files are attached to this conversation. Ask the user to attach a label/annotation file (drag onto the chat or use the attach button).",
  };
}

async function resolveAttachmentId(host, ref, signal) {
  const wanted = String(ref || "").trim();
  if (!wanted) throw new Error("file (attachment id or name) is required.");
  const files = await host.attachments.list(signal);
  if (!files.length) {
    const error = new Error("No companion files are attached to this conversation.");
    error.errorCode = "CONTEXT_FILE_UNAVAILABLE";
    error.expired = true;
    error.workflowHint = "The companion-file cache is unavailable. Stop and ask the user to re-attach the file; do not reconstruct labels from partial previews.";
    throw error;
  }
  const byId = files.find((file) => file.id === wanted);
  if (byId) return byId.id;
  const lower = wanted.toLowerCase();
  const byName = files.find((file) => String(file.name || "").toLowerCase() === lower)
    || files.find((file) => String(file.name || "").toLowerCase().includes(lower));
  if (byName) return byName.id;
  const error = new Error(`No attached file matches "${wanted}". Call list_context_files to see available files.`);
  error.errorCode = "CONTEXT_FILE_NOT_FOUND";
  error.workflowHint = "Use list_context_files and only operate on files that are actually available in this conversation.";
  throw error;
}

async function readContextFileTool(host, args, signal) {
  const id = await resolveAttachmentId(host, args.file, signal);
  return host.attachments.read({ id, offset: args.offset, limit: args.limit }, signal);
}

async function grepContextFileTool(host, args, signal) {
  const id = await resolveAttachmentId(host, args.file, signal);
  return host.attachments.grep({
    id, pattern: args.pattern, mode: args.mode,
    ignoreCase: args.ignoreCase, maxMatches: args.maxMatches,
  }, signal);
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
      // Report the window the sandbox ACTUALLY loaded, not the one that was
      // requested: the store caps samples per channel, so a wide request can come
      // back short. Claiming `exact` over the requested span would make the model
      // report findings for seconds it never saw.
      const analyzed = data.window && Number.isFinite(data.window.startSec) && Number.isFinite(data.window.endSec)
        ? data.window
        : null;
      const startSec = analyzed ? analyzed.startSec : window.startSec;
      const endSec = analyzed ? analyzed.endSec : window.endSec;
      const truncated = Boolean(analyzed?.truncated);
      result.windowed = true;
      result.window = {
        startSec: round(startSec),
        endSec: round(endSec),
        durationSec: round(endSec - startSec),
        requested: { startSec: round(window.startSec), endSec: round(window.endSec) },
        ...(truncated ? { truncated: true } : {}),
      };
      result.exact = !truncated;
      result.workflowHint = truncated
        ? `Only ${round(startSec)}–${round(endSec)}s was loaded (the store caps samples per window). Analyse the remainder in further bounded calls; do not describe the un-analysed part.`
        : "Use render_signal_images on this short window for morphology evidence before making visual claims.";
    }
    const attachments = figure ? [{ kind: "image", dataUrl: figure, label: "Python analysis figure" }] : [];
    return { name: "run_python", ok: !!data.ok, result, attachments, code };
  } catch (error) {
    const message = error.message || String(error);
    const tokenExpired = /No cached dataset|No windowed dataset|No dataset token|Reload the EEG file/i.test(message);
    return toolErrorPayload("run_python", error, {
      code,
      ...(tokenExpired ? {
        errorCode: "DATASET_TOKEN_EXPIRED",
        workflowHint: "The EEG data cache is unavailable. Stop signal-dependent Python analysis and ask the user to reopen/reload the EEG recording; do not keep retrying code variants.",
        retryable: false,
      } : {}),
    });
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
