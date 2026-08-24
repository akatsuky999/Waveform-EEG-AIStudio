// context-budget.js — what EEG-Master is actually about to send, in tokens.
//
// Every turn re-sends the whole transcript, so context is the resource that
// decides how long a run can go. This module measures it BEFORE the request, so
// the UI can show the remaining headroom and the loop can compact ahead of an
// overflow instead of dying on a provider 400.
//
// The estimate is deliberately local and dependency-free (no tokenizer ships
// with a zero-build frontend, and the provider is user-chosen so its tokenizer
// is unknown). It is tuned to be *conservative* — it should read slightly high
// rather than let a run walk into an overflow:
//   • CJK text costs ≈ 1 token per character;
//   • Latin text/JSON costs ≈ 1 token per 4 characters;
//   • each message carries a small envelope overhead;
//   • an inline signal image is billed at a flat vision-tile estimate, because
//     its data-URL length says nothing about how the model tiles it.
// Treat the readout as "roughly this full", not as provider billing truth.

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const MIN_CONTEXT_WINDOW = 8_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;
// Room the model's own reply (plus a long tool_calls block) needs to fit.
export const OUTPUT_RESERVE_TOKENS = 12_000;
// Compact once this much of the usable budget is gone.
export const COMPACT_AT = 0.82;
export const WARN_AT = 0.65;
// A rendered waveform PNG or a matplotlib figure, as vision tiles.
export const IMAGE_TOKEN_COST = 1_500;
const MESSAGE_OVERHEAD_TOKENS = 4;

// CJK ideographs/kana, Hangul, and CJK punctuation & full-width forms.
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/;

export function estimateTokens(value) {
  if (value === null || value === undefined) return 0;
  let text;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  if (!text) return 0;
  let wide = 0;
  for (const char of text) if (CJK.test(char)) wide++;
  return Math.ceil(wide + (text.length - wide) / 4);
}

function contentTokens(content) {
  if (typeof content === "string") return { text: estimateTokens(content), images: 0 };
  if (!Array.isArray(content)) return { text: estimateTokens(content), images: 0 };
  let text = 0;
  let images = 0;
  for (const part of content) {
    if (part?.type === "image_url") images += IMAGE_TOKEN_COST;
    else text += estimateTokens(part?.text ?? part);
  }
  return { text, images };
}

/** Tokens for one chat message, split so the UI can explain where they went. */
export function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") return { total: 0, text: 0, images: 0 };
  const { text, images } = contentTokens(message.content);
  let calls = 0;
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      calls += estimateTokens(call?.function?.name) + estimateTokens(call?.function?.arguments) + 6;
    }
  }
  const total = text + images + calls + MESSAGE_OVERHEAD_TOKENS;
  return { total, text: text + calls, images };
}

export function estimateTranscriptTokens(messages = []) {
  let total = 0;
  let images = 0;
  for (const message of messages) {
    const item = estimateMessageTokens(message);
    total += item.total;
    images += item.images;
  }
  return { total, images, text: total - images };
}

/** The tool schemas are re-sent on every request — a fixed, invisible tax. */
export function estimateToolTokens(tools = []) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  return estimateTokens(tools) + tools.length * 4;
}

export function normalizeContextWindow(value) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return DEFAULT_CONTEXT_WINDOW;
  return Math.max(MIN_CONTEXT_WINDOW, Math.min(MAX_CONTEXT_WINDOW, number));
}

/**
 * Measure a pending request against the configured window.
 *
 * `usable` is the window minus the output reserve: the transcript may not fill
 * the context to the brim or there is no room left for the answer. Percentages
 * are reported against `usable`, which is what the user actually has to spend.
 */
export function contextUsage({
  transcript = [],
  systemPrompt = "",
  tools = [],
  // The workspace-state JSON the proxy injects as its own message each request.
  // It is not part of the transcript but the model pays for it every turn.
  injectedContext = null,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  reserveTokens = OUTPUT_RESERVE_TOKENS,
  compactAt = COMPACT_AT,
} = {}) {
  const limit = normalizeContextWindow(contextWindow);
  const reserve = Math.max(0, Math.min(Math.floor(limit / 2), reserveTokens));
  const usable = Math.max(1, limit - reserve);
  const system = estimateTokens(systemPrompt) + MESSAGE_OVERHEAD_TOKENS;
  const toolSchema = estimateToolTokens(tools);
  const workspace = injectedContext ? estimateTokens(injectedContext) + MESSAGE_OVERHEAD_TOKENS : 0;
  const conversation = estimateTranscriptTokens(transcript);
  const used = system + toolSchema + workspace + conversation.total;
  const ratio = used / usable;
  return {
    limit,
    reserve,
    usable,
    used,
    remaining: Math.max(0, usable - used),
    ratio,
    percentUsed: Math.min(100, Math.round(ratio * 100)),
    // What the UI shows, mirroring Claude Code's "context left until auto-compact".
    percentUntilCompact: Math.max(0, Math.round((compactAt - ratio) * 100)),
    shouldCompact: ratio >= compactAt,
    level: ratio >= compactAt ? "critical" : ratio >= WARN_AT ? "warn" : "ok",
    breakdown: {
      system,
      tools: toolSchema,
      workspace,
      conversation: conversation.text,
      images: conversation.images,
    },
    messageCount: transcript.length,
  };
}

// ---- where the window size comes from ------------------------------------
// The OpenAI-compatible spec does not expose a model's context length: /v1/models
// returns id/object/created/owned_by and nothing else. Many providers add it
// anyway under their own key, and every provider states the real number in the
// error it returns when you exceed it. So: read it when offered, learn it when
// told, and only fall back to a configured default.

const CONTEXT_KEYS = [
  "context_length", "context_window", "max_context_length", "max_context_tokens",
  "max_model_len", "max_input_tokens", "max_tokens", "n_ctx",
];

/** Pull a context length out of one /v1/models entry, if the provider ships one. */
export function readModelContextWindow(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pools = [entry, entry.limits, entry.top_provider, entry.architecture, entry.meta, entry.config];
  for (const pool of pools) {
    if (!pool || typeof pool !== "object") continue;
    for (const key of CONTEXT_KEYS) {
      const value = Number(pool[key]);
      // Guard against a max_tokens that is really an output cap, not a window.
      if (Number.isFinite(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW) {
        return Math.round(value);
      }
    }
  }
  return null;
}

/** Map model id -> context window for every entry that declares one. */
export function readModelContextMap(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  const map = new Map();
  for (const entry of list) {
    const id = typeof entry === "string" ? entry : (entry?.id || entry?.name || entry?.model);
    const window = readModelContextWindow(entry);
    if (id && window) map.set(String(id), window);
  }
  return map;
}

/**
 * Recover the true limit from a provider's overflow complaint, e.g.
 * "This model's maximum context length is 128000 tokens, however you requested…".
 * This is the most reliable source there is: it comes from the model serving you.
 */
export function parseContextLimitFromError(message) {
  const text = String(message || "");
  if (!text) return null;
  const patterns = [
    /maximum context length is\s*([\d,_]+)/i,
    /context (?:window|length)(?: of| is|:)?\s*([\d,_]+)/i,
    /max(?:imum)?[ _-]?(?:input[ _-]?)?tokens?(?: is|:)?\s*([\d,_]+)/i,
    /supports? (?:at most|up to)\s*([\d,_]+)\s*tokens/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number(String(match[1]).replace(/[,_]/g, ""));
    if (Number.isFinite(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW) {
      return Math.round(value);
    }
  }
  return null;
}

/** Providers word context overflow differently; catch the common shapes. */
export function isContextOverflowError(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return /context[_ -]?length|context window|maximum context|too many tokens|reduce the length|prompt is too long|exceeds? the (model|maximum) (context|token)/.test(text);
}
