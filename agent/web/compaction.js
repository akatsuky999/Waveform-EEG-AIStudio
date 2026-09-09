// compaction.js — fold a long run into a structured handoff so it can continue.
//
// Generic chat summarisation is not enough for a signal workspace. What must
// survive compaction is exactly what makes the report defensible: the measured
// numbers, which channel and which second they came from, the montage/filter the
// morphology was read under, and — critically — what the user did and did NOT
// authorize. Images are dropped by compaction, so any conclusion drawn from an
// image has to be written down before it goes.
//
// Shape of a compacted transcript:
//   [ original task (verbatim) , summary handoff , recent messages (verbatim) ]
// The tail stays verbatim because the last exchanges are usually the working
// set; the head anchor keeps the actual question from ever being paraphrased
// away.

import { estimateTokens } from "./context-budget.js";

export const COMPACTION_KEEP_TAIL = 10;
export const COMPACTION_MIN_MESSAGES = 8;
export const COMPACTION_MAX_TOKENS_HINT = 1800;

export const COMPACTION_INSTRUCTION = [
  "You are compacting your own EEG-Master session transcript because the context window is nearly full.",
  "Write a handoff note for yourself, not a report for the user. The next turn will see ONLY this note plus the last few messages: anything you leave out is lost, and rendered images are gone for good.",
  "",
  "Output these sections as Markdown, omitting a section only when it is genuinely empty:",
  "1. **Task** — the user's request in their own terms, including any constraint or explicit refusal (for example 'do not annotate', 'only analyse'). Authorization state is safety-critical: never soften or drop it.",
  "2. **Recording & workspace** — file, sampling rate, channel count, windowed or fully loaded, plus the montage, filter, normalization and time window currently applied. Morphology only means something with its processing chain attached.",
  "3. **Measured evidence** — the quantitative findings so far, each with its channel label, time window in seconds, the value, and the tool that produced it (run_python / signal_query / inspect_*). Keep the numbers; do not round them away or replace them with adjectives.",
  "4. **Visual findings** — what you actually observed in rendered signal images, with the exact windows and channels shown. The images themselves will not survive this compaction, so any morphology claim must be written out here or it cannot be cited again.",
  "5. **Events & candidates** — candidate or written onset/offset times with labels, and clearly mark which were written to the workspace and which are still only candidates.",
  "5a. **Shared similarity evidence** — preserve recordingId, referenceId, setId and candidate evidenceId, frozen processing, coverage limits, and HUMAN decisions separately from your observations. Saved sets can be re-read with read_similarity_candidates only while the same recording session remains loaded; verify IDs against current state after resuming. Never summarize a partial/approximate search as absence of abnormalities.",
  "6. **Side effects performed** — events written, files opened, artifacts exported, skills saved. State them as completed facts so you never repeat or double-count them.",
  "7. **Dead ends** — approaches, windows or channels already ruled out, and failed tool calls with the reason, so you do not retry them.",
  "8. **Next steps** — the concrete remaining plan to finish the user's task.",
  "",
  "Be dense and specific. Prefer a table or tight bullets over prose. Do not invent anything that is not in the transcript, and do not claim a measurement you cannot point to.",
].join("\n");

export const COMPACTION_HANDOFF_PREFIX = [
  "This session is continuing from an earlier part of the conversation that ran out of context.",
  "The transcript below this line was compacted into the following handoff note. Treat it as your own prior work: its measurements are first-hand evidence you already gathered, but any claim not recorded here must be re-measured before you rely on it.",
  "",
].join("\n");

/**
 * Split a transcript into the part to summarise and the part to keep verbatim.
 *
 * The boundary never lands between an assistant tool_calls message and its
 * results, because that pairing is a hard provider requirement.
 */
export function splitForCompaction(transcript = [], { keepTail = COMPACTION_KEEP_TAIL } = {}) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const anchorIndex = messages.findIndex((message) => message?.role === "user");
  const anchor = anchorIndex >= 0 ? messages[anchorIndex] : null;
  if (messages.length <= COMPACTION_MIN_MESSAGES) {
    return { anchor: null, head: [], tail: messages, boundary: 0 };
  }
  let boundary = Math.max(0, messages.length - Math.max(2, keepTail));
  // Walk forward off any tool result whose tool_calls parent sits in the head.
  while (boundary < messages.length && messages[boundary]?.role === "tool") boundary++;
  // Never start the tail on an assistant tool_calls block whose results follow —
  // that is fine — but do not strand the anchor inside the head twice.
  if (boundary >= messages.length) boundary = messages.length - 1;
  const head = messages.slice(0, boundary);
  const tail = messages.slice(boundary);
  return {
    anchor: anchor && !tail.includes(anchor) ? anchor : null,
    head,
    tail,
    boundary,
  };
}

/** Flatten messages into a plain transcript the model can summarise. */
export function renderTranscriptForSummary(messages = []) {
  const lines = [];
  for (const message of messages) {
    const role = message?.role || "unknown";
    if (role === "tool") {
      const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      lines.push(`[tool result] ${body.slice(0, 4000)}`);
      continue;
    }
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls
        .map((call) => `${call?.function?.name}(${String(call?.function?.arguments || "").slice(0, 600)})`)
        .join(", ");
      if (typeof message.content === "string" && message.content.trim()) lines.push(`[assistant] ${message.content}`);
      lines.push(`[tool calls] ${calls}`);
      continue;
    }
    const content = Array.isArray(message.content)
      ? message.content.map((part) => (part?.type === "image_url" ? "[signal image]" : part?.text || "")).join(" ")
      : String(message?.content ?? "");
    if (content.trim()) lines.push(`[${role}] ${content}`);
  }
  return lines.join("\n");
}

/** The one-shot request that produces the handoff note (no tools, no images). */
export function buildCompactionMessages(head = [], { extraInstruction = "" } = {}) {
  const transcript = renderTranscriptForSummary(head);
  return [
    { role: "system", content: COMPACTION_INSTRUCTION },
    {
      role: "user",
      content: `${extraInstruction ? `${extraInstruction}\n\n` : ""}Compact this EEG-Master transcript into the handoff note:\n\n${transcript}`,
    },
  ];
}

/** Rebuild the transcript around a finished summary. */
export function applyCompaction(transcript = [], summaryText = "", options = {}) {
  const { anchor, head, tail } = splitForCompaction(transcript, options);
  const summary = String(summaryText || "").trim();
  if (!head.length || !summary) return { transcript, compacted: false, removedMessages: 0 };
  const handoff = { role: "user", content: `${COMPACTION_HANDOFF_PREFIX}${summary}` };
  const next = [...(anchor ? [anchor] : []), handoff, ...tail];
  return {
    transcript: next,
    compacted: true,
    removedMessages: head.length - (anchor ? 1 : 0),
    keptMessages: tail.length,
    summaryTokens: estimateTokens(summary),
  };
}

/** A short line for the timeline / saved log. */
export function compactionNote(result, usageBefore, usageAfter) {
  const before = usageBefore?.percentUsed;
  const after = usageAfter?.percentUsed;
  const shrink = Number.isFinite(before) && Number.isFinite(after) ? ` · ${before}% → ${after}% of context` : "";
  return `Compacted ${result.removedMessages} earlier message(s) into a handoff summary${shrink}. Measurements, events and authorizations were carried over; images were not.`;
}
