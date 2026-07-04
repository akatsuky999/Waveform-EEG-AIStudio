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
import {
  ATTACHMENT_FILE_LIMIT_BYTES,
  getPersistentAttachment,
  listPersistentAttachments,
  markPersistentAttachmentsSent,
  prunePersistentAttachments,
  removePersistentAttachment,
  removePersistentConversation,
  savePersistentAttachment,
} from "./attachment-cache.js";

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
  // Companion files are cached in memory for the live UI and persisted in
  // IndexedDB so the backend scratch cache can be rebuilt after a hot reload.
  const attachmentsByConv = new Map();  // convId -> [{ id?, name, kind, sizeBytes, status, sent, error }]
  let attachmentUploadQueue = Promise.resolve();

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
    onAttachFiles: attachFiles,
    onRemoveAttachment: removeAttachment,
  });
  host.getAgentConfiguration = () => ui.getPublicConfig();

  // ---- companion-file attachments ----
  function conversationAttachments(id = conv?.id) {
    return id ? (attachmentsByConv.get(id) || []) : [];
  }
  function pendingAttachments(id = conv?.id) {
    return conversationAttachments(id).filter((item) => !item.sent);
  }
  function readyPendingAttachments(id = conv?.id) {
    return pendingAttachments(id).filter((item) => item.status === "ready" && item.id);
  }
  function mergeAttachmentSummary(id, summary, defaults = {}) {
    if (!id || !summary?.id) return null;
    const list = attachmentsByConv.get(id) || [];
    attachmentsByConv.set(id, list);
    let entry = list.find((item) => item.id === summary.id);
    if (!entry) {
      entry = { status: "ready", error: null, ...defaults };
      list.push(entry);
    }
    Object.assign(entry, summary, { status: "ready", error: null, persisted: !!summary.persisted || !!defaults.persisted });
    if (defaults.sent != null && entry.sent == null) entry.sent = !!defaults.sent;
    return entry;
  }
  async function restorePersistentAttachments(id = conv?.id) {
    if (!id) return [];
    const persisted = await listPersistentAttachments(id).catch(() => []);
    persisted.forEach((item) => mergeAttachmentSummary(id, item, { sent: !!item.sent, persisted: true }));
    return persisted;
  }
  async function syncAttachments({ restore = true } = {}) {
    host.attachments.setConversation(conv?.id || null);
    if (restore && conv?.id) await restorePersistentAttachments(conv.id);
    ui.renderAttachments(pendingAttachments());
  }
  function renderAttachmentsFor(id) {
    if (conv?.id === id) ui.renderAttachments(pendingAttachments(id));
  }
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsText(file);
    });
  }
  async function attachFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length || !conv) return;
    host.attachments.setConversation(conv.id);
    const convId = conv.id;
    const list = attachmentsByConv.get(convId) || [];
    attachmentsByConv.set(convId, list);
    const task = (async () => {
      for (const file of files) {
        const entry = { name: file.name, kind: null, sizeBytes: file.size, status: "reading", error: null, sent: false };
        list.push(entry);
        renderAttachmentsFor(convId);
        try {
          if (file.size > ATTACHMENT_FILE_LIMIT_BYTES) throw new Error("File is larger than the 4 MB attachment limit.");
          const text = await readFileText(file);
          entry.status = "uploading";
          renderAttachmentsFor(convId);
          const summary = await host.attachments.upload({ conversationId: convId, name: file.name, text, source: "attach" });
          const persistent = await savePersistentAttachment(convId, summary, text, { sent: false });
          Object.assign(entry, persistent, { status: "ready", error: null });
        } catch (error) {
          entry.status = "error";
          entry.error = error.message || "Attach failed.";
        }
        renderAttachmentsFor(convId);
      }
    })();
    attachmentUploadQueue = attachmentUploadQueue.catch(() => {}).then(() => task);
    return task;
  }
  async function removeAttachment(target) {
    const list = attachmentsByConv.get(conv?.id);
    if (!list) return;
    const index = list.findIndex((item) => (item.id && item.id === target) || item === target || item.name === target);
    if (index < 0) return;
    const [removed] = list.splice(index, 1);
    if (removed?.id) {
      await Promise.allSettled([
        host.attachments.remove(removed.id),
        removePersistentAttachment(conv?.id, removed.id),
      ]);
    }
    ui.renderAttachments(pendingAttachments());
  }
  async function markAttachmentsSent(id, files = []) {
    const sentIds = new Set(files.map((file) => file.id).filter(Boolean));
    if (!sentIds.size) return;
    for (const item of conversationAttachments(id)) {
      if (item.id && sentIds.has(item.id)) item.sent = true;
    }
    await markPersistentAttachmentsSent(id, sentIds).catch(() => {});
  }
  async function ensureBackendAttachments(id = conv?.id, signal = null) {
    if (!id) return [];
    host.attachments.setConversation(id);
    const persisted = await restorePersistentAttachments(id);
    if (!persisted.length) return [];
    let backend = [];
    try {
      backend = await host.attachments.list(signal);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      return persisted;
    }
    const backendIds = new Set(backend.map((item) => item.id).filter(Boolean));
    for (const summary of persisted) {
      if (backendIds.has(summary.id)) continue;
      const record = await getPersistentAttachment(id, summary.id).catch(() => null);
      if (!record?.text) continue;
      try {
        const restored = await host.attachments.upload({
          conversationId: id,
          id: record.id,
          name: record.name,
          text: record.text,
          source: "indexeddb-restore",
        }, signal);
        mergeAttachmentSummary(id, { ...restored, sent: !!record.sent, persisted: true }, { sent: !!record.sent, persisted: true });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        const entry = mergeAttachmentSummary(id, summary, { sent: !!summary.sent, persisted: true });
        if (entry) {
          entry.status = "error";
          entry.error = error.message || "Could not restore attachment.";
        }
      }
    }
    return persisted;
  }

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
    await prunePersistentAttachments(listConversations().map((item) => item.id)).catch(() => {});
    await syncAttachments();
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
    syncAttachments({ restore: false }).catch(() => {});
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
    await syncAttachments();
    refreshHistory();
    ui.closeHistory();
  }

  async function removeConversation(id) {
    if (busy && controller && id === conv?.id) stopRun();
    if (pendingContinuation?.convId === id) pendingContinuation = null;
    discardedConversationIds.add(id);
    attachmentsByConv.delete(id);
    await removePersistentConversation(id).catch(() => {});
    const nextActive = deleteConversation(id);
    if (conv?.id === id) {
      const loaded = nextActive ? await getConversation(nextActive) : null;
      conv = loaded || createConversation();
      if (loaded) ui.renderConversation(conv.log); else ui.resetMessages();
      await syncAttachments();
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
    let text = (rawText || "").trim();
    if (busy) return;
    await attachmentUploadQueue.catch(() => {});
    const messageFiles = readyPendingAttachments();
    if (!text && !messageFiles.length) return;
    if (!text) text = "Please inspect the attached file(s).";
    const config = checkedConfig();
    if (!config) return;

    ui.setOpen(true);
    ui.saveSettings();
    ui.clearInput();
    const fileSummaries = messageFiles.map(messageAttachmentSummary);
    ui.appendUserMessage(text, fileSummaries);

    const runConv = conv;
    const firstMessage = runConv.transcript.length === 0;
    runConv.transcript.push({ role: "user", content: userMessageContent(text, fileSummaries) });
    runConv.log.push({ kind: "user", text, attachments: fileSummaries });
    await markAttachmentsSent(runConv.id, fileSummaries);
    await syncAttachments();
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
    host.attachments.setConversation(runConv.id);
    busy = true; ui.setBusy(true);

    let emptyStreak = 0;
    let stepLimited = false;
    try {
      await ensureBackendAttachments(runConv.id, signal);
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
            if (group.some((call) => toolMayNeedAttachments(call.name))) {
              await ensureBackendAttachments(runConv.id, signal);
            }
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
    const files = conversationAttachments().filter((item) => item.status === "ready" && item.id && item.sent);
    if (files.length) {
      context.contextFiles = {
        count: files.length,
        files: files.map((item) => ({ id: item.id, name: item.name, kind: item.kind, sizeBytes: item.sizeBytes, preview: compactFilePreview(item.preview) })),
        policy: "Companion files the user attached to THIS conversation. They are stored locally with the conversation and restored into the backend tool cache when needed. Inspect with read_context_file/grep_context_file and use in run_python via the `attachments` global. Align any time column to the recording and preview before importing events; only write events when the user explicitly asks in this turn.",
      };
    }
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

// Keep the injected manifest small: enough for the model to know a file exists
// and how it is shaped, without dumping every row into the system context.
function compactFilePreview(preview) {
  if (!preview || typeof preview !== "object") return null;
  const out = {};
  if (Array.isArray(preview.header)) out.header = preview.header.slice(0, 24);
  if (preview.delimiter) out.delimiter = preview.delimiter;
  if (Number.isFinite(preview.rowCount)) out.rowCount = preview.rowCount;
  if (Array.isArray(preview.timeColumns) && preview.timeColumns.length) {
    out.timeColumns = preview.timeColumns.map((col) => col.name);
  }
  if (preview.shape) out.shape = preview.shape;
  if (preview.form === "text" && Number.isFinite(preview.lineCount)) out.lineCount = preview.lineCount;
  return Object.keys(out).length ? out : null;
}

function messageAttachmentSummary(item) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    sizeBytes: item.sizeBytes,
    preview: compactFilePreview(item.preview),
  };
}

function userMessageContent(text, files = []) {
  if (!files.length) return text;
  const manifest = files.map((file, index) => {
    const preview = file.preview ? `; preview=${JSON.stringify(file.preview)}` : "";
    return `${index + 1}. ${file.name} (id=${file.id}, kind=${file.kind || "text"}, size=${file.sizeBytes || 0} bytes${preview})`;
  }).join("\n");
  return `${text}\n\nAttached companion files sent with this message:\n${manifest}\nUse list_context_files/read_context_file/grep_context_file before parsing, and align any time column to the current recording before adding events.`;
}

function toolMayNeedAttachments(name) {
  return name === "list_context_files"
    || name === "read_context_file"
    || name === "grep_context_file"
    || name === "run_python";
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
