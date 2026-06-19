// stream.js — SSE chat streaming with native tool-call accumulation.
// streamAICompletion posts to /api/ai/chat, streams assistant text into
// onUpdate(displayText), accumulates any tool_calls deltas, and resolves to
// { text, rawText, toolCalls, finishReason }. The legacy <eeg-tools> parser is
// kept as an automatic fallback for models/routes that don't do function calls.

export async function streamAICompletion(payload, onUpdate, signal) {
  let raw = "";
  const toolAcc = new Map(); // index -> { id, name, args }
  let finishReason = null;
  onUpdate("");

  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText);
  }

  // Non-streaming fallback (server returned JSON, not an event stream).
  if (!res.body) {
    const data = await res.json().catch(() => ({}));
    raw = data.content || "";
    onUpdate(stripAgentProtocol(raw));
    return finalize(raw, normalizeFullToolCalls(data.toolCalls), data.finishReason || null);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\n\n/);
    buf = parts.pop() || "";
    for (const part of parts) {
      const chunk = parseSSEChunk(part);
      if (chunk.done) return finalize(raw, buildToolCalls(toolAcc), finishReason);
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.text) { raw += chunk.text; onUpdate(stripAgentProtocol(raw) || "Thinking…"); }
      if (chunk.toolCalls) mergeToolDeltas(toolAcc, chunk.toolCalls);
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
  }
  if (buf.trim()) {
    const chunk = parseSSEChunk(buf);
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.text) raw += chunk.text;
    if (chunk.toolCalls) mergeToolDeltas(toolAcc, chunk.toolCalls);
    if (chunk.finishReason) finishReason = chunk.finishReason;
  }
  onUpdate(stripAgentProtocol(raw));
  return finalize(raw, buildToolCalls(toolAcc), finishReason);
}

function finalize(raw, toolCalls, finishReason) {
  return { text: stripAgentProtocol(raw), rawText: raw, toolCalls: toolCalls || [], finishReason };
}

export function parseSSEChunk(block) {
  const lines = block.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  const data = dataLines.join("\n") || block.trim();
  if (!data) return {};
  if (data === "[DONE]") return { done: true };
  let json;
  try { json = JSON.parse(data); }
  catch {
    const pieces = extractChunkTextFromRaw(data);
    return pieces ? { text: pieces } : {};
  }
  if (event === "error" || json.error) return { error: json.error?.message || json.error || "AI stream failed" };
  const choice = json.choices?.[0] || {};
  const delta = choice.delta || {};
  const text = delta.content ?? choice.message?.content ?? json.content ?? "";
  const toolDelta = delta.tool_calls ?? choice.message?.tool_calls ?? null;
  return {
    text,
    toolCalls: Array.isArray(toolDelta) && toolDelta.length ? toolDelta : null,
    finishReason: choice.finish_reason || null,
  };
}

function mergeToolDeltas(acc, deltas) {
  for (const d of deltas) {
    if (!d || typeof d !== "object") continue;
    const idx = Number.isInteger(d.index) ? d.index : acc.size;
    const cur = acc.get(idx) || { id: "", name: "", args: "" };
    if (d.id) cur.id = d.id;
    const f = d.function || {};
    if (f.name) cur.name = f.name;
    if (typeof f.arguments === "string") cur.args += f.arguments;
    acc.set(idx, cur);
  }
}

function buildToolCalls(acc) {
  const out = [];
  for (const [idx, c] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue;
    out.push({ id: c.id || `call_${idx}`, name: c.name, arguments: parseArgs(c.args), rawArguments: c.args || "" });
  }
  return out;
}

function normalizeFullToolCalls(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((tc, i) => {
    const f = (tc && tc.function) || {};
    const rawArgs = typeof f.arguments === "string" ? f.arguments : JSON.stringify(f.arguments || {});
    return { id: tc?.id || `call_${i}`, name: f.name, arguments: parseArgs(rawArgs), rawArguments: rawArgs };
  }).filter((tc) => tc.name);
}

function parseArgs(text) {
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { __raw: text }; }
}

function extractChunkTextFromRaw(raw) {
  const objects = extractJSONObjects(raw);
  if (!objects.length) return "";
  return objects.map((obj) =>
    obj?.choices?.[0]?.delta?.content ??
    obj?.choices?.[0]?.message?.content ??
    obj?.content ??
    ""
  ).join("");
}

export function extractJSONObjects(raw) {
  const found = [];
  let start = null, depth = 0, inString = false, escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (start === null) {
      if (ch === "{") { start = i; depth = 1; inString = false; escape = false; }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { found.push(JSON.parse(raw.slice(start, i + 1))); }
        catch { /* ignore malformed partial chunk */ }
        start = null;
      }
    }
  }
  return found;
}

// ---- legacy <eeg-tools>/<eeg-actions> fallback --------------------------
export function extractAgentProtocol(text) {
  const tools = [];
  const actions = [];
  let clean = String(text || "").replace(/<eeg-tools>([\s\S]*?)<\/eeg-tools>/gi, (_m, jsonText) => {
    try {
      const parsed = JSON.parse(jsonText.trim());
      if (Array.isArray(parsed)) tools.push(...parsed);
    } catch {
      tools.push({ name: "__invalid__", arguments: { reason: "Invalid eeg-tools JSON" } });
    }
    return "";
  });
  clean = clean.replace(/<eeg-actions>([\s\S]*?)<\/eeg-actions>/gi, (_m, jsonText) => {
    try {
      const parsed = JSON.parse(jsonText.trim());
      if (Array.isArray(parsed)) actions.push(...parsed);
    } catch {
      actions.push({ action: "__invalid__", reason: "Invalid eeg-actions JSON" });
    }
    return "";
  }).trim();
  return { text: clean, tools, actions };
}

export function stripAgentProtocol(text) {
  return String(text || "")
    .replace(/<eeg-tools>[\s\S]*?<\/eeg-tools>/gi, "")
    .replace(/<eeg-actions>[\s\S]*?<\/eeg-actions>/gi, "")
    .replace(/<eeg-(tools|actions)>[\s\S]*$/i, "")
    .trim();
}
