// agent.js — EEG-Master controller. The host app calls initAgent(host) once.
// Real agent loop with PERSISTENT per-conversation context: one growing model
// transcript per conversation (so it never re-runs tools it already ran), a
// Cursor-style history of conversations, and a robust loop that keeps going
// until the task is genuinely finished (handles truncation; no early exit).

import { EEG_MASTER_SYSTEM_PROMPT, EEG_TOOLS } from "./prompt.js";
import { initDrawerUI } from "./ui.js";
import { streamAICompletion, extractAgentProtocol } from "./stream.js";
import { runToolCall, executeEEGActions } from "./tools.js";
import { deriveActionPolicy } from "./intent-policy.js";
import { getToolDefinition } from "./tool-definitions.js";
import {
  createConversation, getConversation, saveConversation, deleteConversation,
  renameConversation, listConversations, getActiveId, setActiveId, titleFromText,
  initConversations,
} from "./conversations.js";
import { exportConversation } from "./conversation-export.js";

const DEFAULT_MAX_TURNS = 16;    // fallback; UI config controls the real cap
const MAX_CALLS_PER_TURN = 8;   // tool-call budget per turn
const MAX_TOOL_RESULT_CHARS = 24000;
const CONTEXT_WINDOW = 70;      // max transcript messages sent to the model
const MAX_STREAM_RETRIES = 2;   // retry a turn on a transient network/stream blip

// A network/upstream blip is worth retrying; auth/validation errors are not.
function isTransientError(err) {
  if (!err) return false;
  if (err.name === "TypeError") return true; // fetch-level network failure
  const m = String(err.message || "").toLowerCase();
  return /network|timeout|temporar|reach upstream|connection|fetch failed|socket|econnreset|502|503|504|stream (closed|ended|failed)/.test(m);
}

export function initAgent(host) {
  let conv = null;        // active conversation { id, title, transcript, log }
  let busy = false;
  let controller = null;  // AbortController for the active run
  let pendingContinuation = null;
  const discardedConversationIds = new Set();

  const ui = initDrawerUI(host, {
    onSend: sendAIMessage,
    onStop: stopRun,
    onNewChat: newChat,
    onSelectConversation: selectConversation,
    onDeleteConversation: removeConversation,
    onRenameConversation: (id, title) => { renameConversation(id, title); refreshHistory(); },
    onExport: exportActive,
    onContinue: continueRun,
    onOpenConfig: () => host.openAgentSettings?.(),
  });
  host.getAgentConfiguration = () => ui.getPublicConfig();

  // Export the active in-memory conversation (which keeps full images) as
  // JSON / HTML / Markdown.
  function exportActive(format) {
    if (!conv || (!conv.log?.length && !conv.transcript?.length)) {
      ui.appendNote("Nothing to export yet — ask EEG-Master something first.");
      return;
    }
    const meta = {
      model: ui.getConfig().model || null,
      file: host.signal.getState()?.file?.name || null,
      exportedAt: Date.now(),
    };
    exportConversation(conv, format, meta);
  }

  // ---- conversation lifecycle ----
  function refreshHistory() { ui.renderHistory(listConversations(), conv?.id); }

  async function loadActive() {
    const id = getActiveId();
    const existing = id ? await getConversation(id) : null;
    conv = existing || createConversation();
    if (existing) ui.renderConversation(conv.log);
    else ui.resetMessages();
    refreshHistory();
  }

  function persist(target = conv) {
    if (!target || discardedConversationIds.has(target.id)) return;
    if (target.transcript.length || target.log.length) {
      saveConversation(target, { activate: target.id === conv?.id });
      refreshHistory();
    }
  }

  function newChat() {
    if (busy) stopRun();
    pendingContinuation = null;
    conv = createConversation();
    setActiveId(conv.id);
    ui.resetMessages();
    refreshHistory();
    ui.closeHistory();
    ui.focusInput();
  }

  async function selectConversation(id) {
    if (busy) stopRun();
    pendingContinuation = null;
    const loaded = await getConversation(id);
    if (!loaded) return;
    conv = loaded;
    setActiveId(id);
    ui.renderConversation(conv.log);
    refreshHistory();
    ui.closeHistory();
  }

  async function removeConversation(id) {
    if (busy && controller && id === conv?.id) stopRun();
    if (pendingContinuation?.convId === id) pendingContinuation = null;
    discardedConversationIds.add(id);
    const nextActive = deleteConversation(id);
    if (conv?.id === id) {
      const loaded = nextActive ? await getConversation(nextActive) : null;
      conv = loaded || createConversation();
      if (loaded) ui.renderConversation(conv.log); else ui.resetMessages();
    }
    refreshHistory();
  }

  function stopRun() { if (controller) controller.abort(); }

  // ---- the send / agent loop ----
  function checkedConfig() {
    const config = ui.getConfig();
    if (!config.baseUrl) { ui.appendError("请先在 Config 里填写 API Base URL。"); ui.setStatus("err", "URL required"); return null; }
    if (!config.apiKey) { ui.appendError("请先在 Config 里填写 API Key。"); ui.setStatus("err", "Key required"); return null; }
    if (!config.model) { ui.appendError("请选择模型，或在 Custom model 里填写模型名。"); ui.setStatus("err", "Model required"); return null; }
    config.maxTurns = Math.max(4, Math.min(64, parseInt(config.maxTurns, 10) || DEFAULT_MAX_TURNS));
    return config;
  }

  async function sendAIMessage(rawText) {
    const text = (rawText || "").trim();
    if (!text || busy) return;
    const config = checkedConfig();
    if (!config) return;

    ui.setOpen(true);
    ui.saveSettings();
    ui.clearInput();
    ui.appendUserMessage(text);

    const runConv = conv;
    const firstMessage = runConv.transcript.length === 0;
    runConv.transcript.push({ role: "user", content: text });
    runConv.log.push({ kind: "user", text });
    if (firstMessage) { runConv.title = titleFromText(text); setActiveId(runConv.id); }

    pendingContinuation = null;
    await runAgentLoop(runConv, deriveActionPolicy(text), config);
  }

  async function continueRun() {
    if (busy || !pendingContinuation || pendingContinuation.convId !== conv?.id) return;
    const config = checkedConfig();
    if (!config) return;
    ui.setOpen(true);
    ui.saveSettings();
    const runConv = conv;
    const instruction = "Continue from the previous tool results without repeating completed work. Use the existing context, then finish the user's original task.";
    runConv.transcript.push({ role: "user", content: instruction });
    runConv.log.push({ kind: "note", text: "Continuing from step limit." });
    ui.appendNote("Continuing from the paused step limit…");
    const actionPolicy = pendingContinuation.actionPolicy || {};
    pendingContinuation = null;
    await runAgentLoop(runConv, actionPolicy, config);
  }

  async function runAgentLoop(runConv, actionPolicy, config) {
    const { baseUrl, apiKey, model } = config;
    const maxTurns = Math.max(4, Math.min(64, parseInt(config.maxTurns, 10) || DEFAULT_MAX_TURNS));
    const runController = new AbortController();
    controller = runController;
    const signal = runController.signal;
    busy = true; ui.setBusy(true);

    let emptyStreak = 0;
    let stepLimited = false;
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) break;
        ui.setStatus("busy", `Working · step ${turn + 1}/${maxTurns}`);

        const bubble = ui.beginAssistant();
        let stream;
        for (let attempt = 0; ; attempt++) {
          try {
            stream = await streamAICompletion({
              baseUrl, apiKey, model,
              messages: contextMessages(runConv.transcript),
              tools: EEG_TOOLS,
              context: modelContext(config),
            }, (t) => bubble.update(t), signal);
            break;
          } catch (err) {
            if (signal.aborted || err?.name === "AbortError") throw err;
            if (attempt >= MAX_STREAM_RETRIES || !isTransientError(err)) throw err;
            bubble.update(`网络中断，正在重试 (${attempt + 1}/${MAX_STREAM_RETRIES})…`);
            await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          }
        }

        // Resolve tool calls: native function calls first, legacy tags as fallback.
        let calls = stream.toolCalls || [];
        if (!calls.length) {
          const parsed = extractAgentProtocol(stream.rawText);
          if (parsed.tools.length) {
            calls = parsed.tools.map((t, i) => ({
              id: `call_${turn}_${i}`,
              name: t.name || t.tool,
              arguments: (t.arguments && typeof t.arguments === "object") ? t.arguments : {},
            }));
          }
          if (parsed.actions.length) {
            const notes = executeEEGActions(host, parsed.actions, actionPolicy);
            if (notes.length) {
              if (conv === runConv) ui.appendNote(`Applied: ${notes.join(", ")}`);
              runConv.log.push({ kind: "note", text: `Applied: ${notes.join(", ")}` });
            }
          }
        }

        bubble.finalize(stream.text);
        if (stream.text && stream.text.trim()) runConv.log.push({ kind: "assistant", text: stream.text });

        if (calls.length) {
          emptyStreak = 0;
          calls = calls.slice(0, MAX_CALLS_PER_TURN);
          runConv.transcript.push(assistantToolCallMessage(calls, stream.text));

          const attachments = [];
          for (let callIndex = 0; callIndex < calls.length;) {
            if (signal.aborted) {
              appendCancelledToolResults(runConv, calls, callIndex);
              break;
            }
            const first = calls[callIndex];
            const safe = getToolDefinition(first.name)?.concurrencySafe === true;
            let groupEnd = callIndex + 1;
            if (safe) {
              while (groupEnd < calls.length && getToolDefinition(calls[groupEnd].name)?.concurrencySafe === true) groupEnd++;
            }
            const group = calls.slice(callIndex, groupEnd);
            const cards = group.map((call) => ui.beginToolCard(call.name, call.arguments));
            const outcomes = safe
              ? await Promise.all(group.map((call) => runToolCall(host, call, signal, actionPolicy)))
              : [await runToolCall(host, group[0], signal, actionPolicy)];
            const refreshes = [];
            outcomes.forEach((outcome, index) => {
              const call = group[index];
              const card = cards[index];
              if (outcome.ok) card.setDone(outcome); else card.setError(outcome.error, outcome);
              if (outcome.ok && (call.name === "create_agent_skill" || call.name === "update_agent_skill")) {
                const savedSkillName = outcome.result?.operation === "create" ? outcome.result?.skill?.name : "";
                const refreshed = ui.refreshSkills?.({
                  enable: savedSkillName,
                  feedback: true,
                  message: outcome.result?.operation === "create" ? "Skill added" : "Skills refreshed",
                });
                if (refreshed) refreshes.push(refreshed);
              }
              runConv.transcript.push(toolResultMessage(call, outcome));
              runConv.log.push({ kind: "tool", name: call.name, args: call.arguments, outcome });
              if (Array.isArray(outcome.attachments)) {
                outcome.attachments.forEach((attachment) => attachments.push({ name: call.name, ...attachment }));
              } else if (outcome.imageDataUrl) {
                attachments.push({ name: call.name, kind: "image", dataUrl: outcome.imageDataUrl, label: call.name });
              }
            });
            if (refreshes.length) await Promise.all(refreshes);
            callIndex = groupEnd;
          }
          if (attachments.length) {
            compactPriorImageMessages(runConv.transcript);
            runConv.transcript.push(attachmentUserMessage(attachments));
          }
          persist(runConv);
          if (signal.aborted) break;
          if (turn === maxTurns - 1) { stepLimited = true; break; }
          continue; // let the model react to the tool results
        }

        // No tool calls this turn.
        if (stream.text && stream.text.trim()) {
          runConv.transcript.push({ role: "assistant", content: stream.text });
          emptyStreak = 0;
        } else {
          emptyStreak++;
        }
        // Truncated mid-thought → keep going so the model can finish.
        if (stream.finishReason === "length" && emptyStreak < 2) {
          if (turn === maxTurns - 1) stepLimited = true;
          else continue;
        }
        // Empty response with no work → avoid spinning.
        if (emptyStreak >= 2) break;
        // Genuine completion.
        if (stream.text && stream.text.trim()) break;
        if (stream.finishReason && stream.finishReason !== "length") break;
        break;
      }

      if (conv === runConv) {
        if (signal.aborted) { ui.appendNote("Stopped."); ui.setStatus("ok", "Stopped"); }
        else if (stepLimited) {
          pendingContinuation = { convId: runConv.id, actionPolicy };
          ui.appendStepLimitNotice(maxTurns);
          ui.setStatus("paused", "Paused · step limit");
        }
        else ui.setStatus("ok", "Ready");
      }
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) {
        if (conv === runConv) { ui.appendNote("Stopped."); ui.setStatus("ok", "Stopped"); }
      } else {
        if (conv === runConv) { ui.appendError(err.message || "AI request failed"); ui.setStatus("err", "Request error"); }
        runConv.log.push({ kind: "error", text: err.message || "AI request failed" });
      }
    } finally {
      persist(runConv);
      if (controller === runController) {
        busy = false;
        ui.setBusy(false);
        if (conv !== runConv) ui.setStatus("ok", "Ready");
        controller = null;
      }
    }
  }

  function modelContext(config) {
    const context = host.signal.getState();
    const skills = skillContext(config);
    if (skills.available.length || skills.enabled.length) context.agentSkills = skills;
    return context;
  }

  function skillContext(config) {
    const available = Array.isArray(config?.skills?.available) ? config.skills.available : [];
    const enabled = new Set(Array.isArray(config?.skills?.enabled) ? config.skills.enabled : []);
    return {
      enabled: available.filter((skill) => enabled.has(skill.name)).map((skill) => skill.name),
      available: available.map((skill) => ({
        name: skill.name,
        title: skill.title,
        category: skill.category,
        source: skill.source,
        enabled: enabled.has(skill.name),
        ...(enabled.has(skill.name) ? {
          description: skill.description,
          triggers: Array.isArray(skill.triggers) ? skill.triggers.slice(0, 12) : [],
        } : {}),
      })),
      policy: "Local EEG skills are prior/context packs. Enabled skills are active priors. Disabled skills are inactive for ordinary analysis; list or read them only when the user explicitly asks to inspect/use/manage skills.",
    };
  }

  initConversations().then(loadActive).catch(loadActive);
}

// Keep tool_call/tool pairing valid when trimming: start the window at a user turn.
function contextMessages(transcript) {
  let msgs = transcript;
  if (msgs.length > CONTEXT_WINDOW) {
    msgs = msgs.slice(-CONTEXT_WINDOW);
    let i = 0;
    while (i < msgs.length && msgs[i].role !== "user") i++;
    msgs = i < msgs.length ? msgs.slice(i) : [];
  }
  return [{ role: "system", content: EEG_MASTER_SYSTEM_PROMPT }, ...msgs];
}

function assistantToolCallMessage(calls, text) {
  return {
    role: "assistant",
    content: text || "",
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.arguments || {}) },
    })),
  };
}

function toolResultMessage(call, outcome) {
  const payload = outcome.ok ? outcome.result : { error: outcome.error || "Tool failed" };
  let content;
  try { content = JSON.stringify(payload); } catch { content = String(payload); }
  if (content.length > MAX_TOOL_RESULT_CHARS) content = content.slice(0, MAX_TOOL_RESULT_CHARS) + "…(truncated)";
  return { role: "tool", tool_call_id: call.id, content };
}

function appendCancelledToolResults(conversation, calls, startIndex) {
  for (let index = startIndex; index < calls.length; index++) {
    conversation.transcript.push(toolResultMessage(calls[index], {
      ok: false,
      error: "Tool execution cancelled.",
    }));
  }
}

export function attachmentUserMessage(attachments) {
  const images = (attachments || []).filter((item) => item?.kind === "image" && item.dataUrl).slice(0, 5);
  return {
    role: "user",
    content: [
      { type: "text", text: `Signal Workspace image set (${images.length} image${images.length === 1 ? "" : "s"}, ordered overview to most important detail):\n${images.map((item, index) => `${index + 1}. ${item.label || item.name || "signal image"}`).join("\n")}` },
      ...images.map((item) => ({ type: "image_url", image_url: { url: item.dataUrl } })),
    ],
  };
}

function compactPriorImageMessages(transcript) {
  for (const message of transcript) {
    if (!Array.isArray(message?.content)) continue;
    message.content = message.content.map((part) => part?.type === "image_url"
      ? { type: "text", text: "[Earlier Signal Workspace image already inspected]" }
      : part);
  }
}
