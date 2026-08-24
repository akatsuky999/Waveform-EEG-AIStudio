// permissions.js — how a side effect gets authorized.
//
// The original gate inferred permission from regexes over the user's message:
// if the wording did not match, the tool was refused, and if it did, the tool
// ran unseen. That is a guess in both directions — a request phrased slightly
// differently was blocked, and "标注一下发作" silently authorized every event
// write for the rest of the turn, whatever it turned out to contain.
//
// The frontier pattern replaces guessing with a proposal the user can see:
// the agent states exactly what it is about to do, the harness pauses, and the
// user allows once, allows for the conversation, or denies. The regex is kept
// only as a fast path — when the user's own message already asked for this
// action in this turn, re-asking is noise, not safety.
//
// Two rules are never negotiable, because they are what makes the gate a gate:
//   • an explicit refusal in the current turn ("不要标注", "do not export") is
//     final and is never escalated to a prompt;
//   • read-only mode denies every side effect without asking.

export const PERMISSION_MODES = ["ask", "readonly", "trusted"];
export const DEFAULT_PERMISSION_MODE = "ask";

export const PERMISSION_MODE_LABELS = {
  ask: "Ask before side effects",
  readonly: "Read-only (analysis only)",
  trusted: "Trusted (auto-approve this conversation)",
};

export const CAPABILITIES = {
  annotation: {
    label: "Write events",
    detail: "Adds, edits or removes annotations on the recording's event track.",
    reversible: true,
  },
  fileSwitch: {
    label: "Open another recording",
    detail: "Replaces the loaded recording; unsaved events on the current one are lost.",
    reversible: false,
  },
  export: {
    label: "Download a file",
    detail: "Writes an artifact to your computer through the browser's download flow.",
    reversible: false,
  },
  skillWrite: {
    label: "Save an EEG skill",
    detail: "Writes a SKILL.md into your local skill folder.",
    reversible: true,
  },
};

const NUMBER = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const seconds = (value) => {
  const number = NUMBER(value);
  return number === null ? "?" : `${number.toFixed(number < 10 ? 2 : 1)}s`;
};

function summarizeEventWrite(args = {}, context = {}) {
  const operation = String(args.operation || "add");
  const events = Array.isArray(args.events) ? args.events : [];
  if (operation !== "add") {
    return {
      title: `${operation === "remove" ? "Remove" : "Update"} ${events.length} event(s)`,
      details: [
        `${events.length} existing event(s) targeted by id`,
        `Workspace currently holds ${context.eventCount ?? "?"} event(s)`,
      ],
      risk: operation === "remove" ? "high" : "normal",
    };
  }
  const intervals = events.filter((event) => NUMBER(event?.offsetSec) !== null && NUMBER(event.offsetSec) > NUMBER(event.onsetSec));
  const onsets = events.map((event) => NUMBER(event?.onsetSec ?? event?.timeSec)).filter((value) => value !== null);
  const labels = [...new Set(events.map((event) => String(event?.label || "Event").trim()).filter(Boolean))];
  const span = onsets.length
    ? `${seconds(Math.min(...onsets))} – ${seconds(Math.max(...onsets))}`
    : "unspecified time";
  return {
    title: `Write ${events.length} event(s) to the recording`,
    details: [
      `${intervals.length} interval(s), ${events.length - intervals.length} point marker(s)`,
      `Time span ${span}`,
      labels.length ? `Label(s): ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ` +${labels.length - 3}` : ""}` : null,
      `Workspace currently holds ${context.eventCount ?? 0} event(s)`,
    ].filter(Boolean),
    risk: events.length > 32 ? "high" : "normal",
  };
}

function summarizeExport(args = {}) {
  const format = String(args.format || "artifact");
  const range = args.range === "full" ? "the full recording" : "the current view";
  const channels = args.channels === "all" ? "all channels" : "visible channels";
  const dataLike = ["csv", "h5", "edf", "training-zip"].includes(format);
  return {
    title: `Download a ${format.toUpperCase()} file`,
    details: [
      dataLike ? `Signal data for ${range}, ${channels}` : `Image artifact for ${range}`,
      "The file leaves the workspace and lands in your Downloads folder",
    ],
    risk: dataLike ? "high" : "normal",
  };
}

function summarizeOpenSource(args = {}, context = {}) {
  const target = args.source === "sample" ? "the bundled sample recording" : (args.path || "a project recording");
  const eventCount = context.eventCount ?? 0;
  return {
    title: `Switch the workspace to ${target}`,
    details: [
      "The current recording is unloaded and its view state is reset",
      eventCount
        ? `${eventCount} event(s) on the current recording will be DISCARDED`
        : "No events on the current recording would be lost",
    ],
    risk: eventCount ? "high" : "normal",
  };
}

function summarizeSkillWrite(toolName, args = {}) {
  const body = typeof args.body === "string" ? args.body : (args.markdown || "");
  return {
    title: `${toolName === "create_agent_skill" ? "Create" : "Overwrite"} skill "${args.name || "unnamed"}"`,
    details: [
      `${body.length} character SKILL.md written to your local skill folder`,
      args.description ? `Trigger: ${String(args.description).slice(0, 120)}` : null,
      toolName === "update_agent_skill" ? "The existing skill body is replaced" : null,
    ].filter(Boolean),
    risk: toolName === "update_agent_skill" ? "high" : "normal",
  };
}

/**
 * Turn a pending tool call into a concrete, checkable proposal.
 *
 * The user is approving THIS action with THESE arguments — a generic
 * "allow annotations?" prompt would just train them to click yes.
 */
export function describeToolRequest(toolName, args = {}, context = {}) {
  const name = String(toolName || "");
  const base = name === "manage_signal_events" ? summarizeEventWrite(args, context)
    : name === "export_signal_artifact" ? summarizeExport(args)
    : name === "open_signal_source" ? summarizeOpenSource(args, context)
    : (name === "create_agent_skill" || name === "update_agent_skill") ? summarizeSkillWrite(name, args)
    : { title: `Run ${name}`, details: [], risk: "normal" };
  return { tool: name, ...base };
}

function permissionError(capability, decision) {
  const meta = CAPABILITIES[capability];
  const reason = decision?.source === "readonly-mode"
    ? "The workspace is in read-only mode; no side effects are permitted this session. Report findings instead and tell the user how to enable the action."
    : decision?.source === "explicit-refusal"
      ? "The user explicitly refused this action in the current turn. Do not retry it; report findings instead."
      : decision?.source === "user-denied"
        ? "The user reviewed this exact action and denied it. Do not retry the same action; ask what they would prefer."
        : decision?.source === "aborted"
          ? "The run was stopped while this action was awaiting approval."
          : `${meta?.label || capability} is not authorized in this turn.`;
  const error = new Error(reason);
  error.errorCode = "PERMISSION_DENIED";
  error.capability = capability;
  error.decisionSource = decision?.source || "unauthorized";
  error.retryable = false;
  return error;
}

/**
 * @param mode             one of PERMISSION_MODES
 * @param intent           the per-turn regex reading (deriveActionPolicy)
 * @param requestDecision  async ({capability, request, meta}) => "once"|"conversation"|"deny"
 * @param grants           Map shared across a conversation, so "allow for this
 *                         conversation" survives between runs
 * @param isAborted        () => boolean, so a stopped run never hangs on a prompt
 */
export function createPermissionBroker({
  mode = DEFAULT_PERMISSION_MODE,
  intent = {},
  requestDecision = null,
  grants = new Map(),
  isAborted = () => false,
  onDecision = null,
} = {}) {
  const activeMode = PERMISSION_MODES.includes(mode) ? mode : DEFAULT_PERMISSION_MODE;
  const decisions = [];

  function record(capability, decision) {
    const entry = { capability, ...decision, at: Date.now() };
    decisions.push(entry);
    onDecision?.(entry);
    return entry;
  }

  async function request(capability, { tool, args, context } = {}) {
    const denied = intent?.denied?.[capability];
    if (activeMode === "readonly") {
      return record(capability, { granted: false, source: "readonly-mode" });
    }
    if (denied) {
      // An explicit "do not do X" is never escalated to a prompt: asking anyway
      // would be a second chance at something the user already refused.
      return record(capability, { granted: false, source: "explicit-refusal" });
    }
    if (grants.get(capability) === "conversation") {
      return record(capability, { granted: true, source: "conversation-grant" });
    }
    if (activeMode === "trusted") {
      return record(capability, { granted: true, source: "trusted-mode" });
    }
    if (intent?.[capability]) {
      return record(capability, { granted: true, source: "turn-intent" });
    }
    if (!requestDecision) {
      // No UI attached (tests, headless): fall back to the conservative default.
      return record(capability, { granted: false, source: "unauthorized" });
    }
    if (isAborted()) return record(capability, { granted: false, source: "aborted" });
    const proposal = describeToolRequest(tool, args, context);
    const choice = await requestDecision({
      capability,
      meta: CAPABILITIES[capability] || { label: capability },
      request: proposal,
    });
    if (isAborted()) return record(capability, { granted: false, source: "aborted" });
    if (choice === "conversation") {
      grants.set(capability, "conversation");
      return record(capability, { granted: true, source: "user-prompt", scope: "conversation", proposal });
    }
    if (choice === "once") {
      return record(capability, { granted: true, source: "user-prompt", scope: "once", proposal });
    }
    return record(capability, { granted: false, source: "user-denied", proposal });
  }

  return {
    mode: activeMode,
    grants,
    decisions,
    request,
    async require(capability, details) {
      const decision = await request(capability, details);
      if (!decision.granted) throw permissionError(capability, decision);
      return decision;
    },
  };
}
