// ui.js — EEG-Master drawer UI: settings, model picker, resize, status, and
// message bubbles. Returns an API the controller (agent.js) drives.

import { renderMarkdown, escapeHtml } from "./markdown.js";
import { toolTitle } from "./tools.js";
import {
  AI_MODEL_GROUPS, AI_MODEL_PRESETS, AI_STORAGE_KEY, CUSTOM_MODEL_VALUE,
  DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, LEGACY_DEFAULT_AI_MODELS,
} from "./prompt.js";

const $ = (id) => document.getElementById(id);

const EMPTY_STATE_HTML = `
  <div class="ai-empty">
    <div class="ai-empty-icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>
        <circle cx="12" cy="12" r="3.2"/>
      </svg>
    </div>
    <b>EEG-Master</b>
    <p>I work like an agent: I dig into the actual recording to answer you — inspecting channels, running Python on the real signal, reading the waveform, and annotating events — rather than guessing from a summary.</p>
    <div class="ai-empty-caps">
      <span>Inspect &amp; rank channels</span>
      <span>Run Python on the real signal</span>
      <span>Detect &amp; mark onset / offset</span>
    </div>
  </div>`;

export function initDrawerUI(host, handlers = {}) {
  let aiOpen = false;
  let aiConfigOpen = false;

  // ---- settings persistence ----
  function loadSettings() {
    try { return JSON.parse(sessionStorage.getItem(AI_STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveSettings() {
    const settings = {
      baseUrl: $("aiBaseUrl").value.trim() || DEFAULT_AI_BASE_URL,
      apiKey: $("aiApiKey").value,
      model: selectedModel(false),
      customModel: $("aiCustomModel").value.trim(),
      drawerWidth: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--ai-drawer-w"), 10) || 468,
    };
    try { sessionStorage.setItem(AI_STORAGE_KEY, JSON.stringify(settings)); }
    catch { /* session storage can be unavailable in private contexts */ }
  }

  // ---- model picker ----
  function renderModelOptions(models, preferred = null) {
    const select = $("aiModelSelect");
    const current = preferred || selectedModel(false) || DEFAULT_AI_MODEL;
    const providerModels = [...new Set((models || []).filter(Boolean))];
    select.innerHTML = "";
    const addGroup = (label, values) => {
      const unique = [...new Set(values.filter(Boolean))];
      if (!unique.length) return;
      const groupEl = document.createElement("optgroup");
      groupEl.label = label;
      for (const model of unique) {
        const opt = document.createElement("option");
        opt.value = model;
        opt.textContent = model;
        groupEl.appendChild(opt);
      }
      select.appendChild(groupEl);
    };
    for (const group of filterPresetGroups(providerModels)) addGroup(group.label, group.models);
    const custom = document.createElement("option");
    custom.value = CUSTOM_MODEL_VALUE;
    custom.textContent = "Custom...";
    select.appendChild(custom);
    setModelSelection(current);
  }
  function setModelSelection(model) {
    const select = $("aiModelSelect");
    const hasModel = [...select.options].some((opt) => opt.value === model);
    if (model && hasModel) select.value = model;
    else {
      select.value = CUSTOM_MODEL_VALUE;
      if (model && model !== CUSTOM_MODEL_VALUE) $("aiCustomModel").value = model;
    }
    syncCustomField();
  }
  function selectedModel(trim = true) {
    const select = $("aiModelSelect");
    const value = select.value === CUSTOM_MODEL_VALUE ? $("aiCustomModel").value : select.value;
    return trim ? value.trim() : value;
  }
  function syncCustomField() {
    $("aiCustomWrap").classList.toggle("hidden", $("aiModelSelect").value !== CUSTOM_MODEL_VALUE);
  }
  function parseModels(data) {
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return [...new Set(list.map((item) => {
      if (typeof item === "string") return item;
      return item?.id || item?.name || item?.model;
    }).filter(Boolean))].slice(0, 120);
  }
  async function loadModels() {
    const baseUrl = $("aiBaseUrl").value.trim() || DEFAULT_AI_BASE_URL;
    const apiKey = $("aiApiKey").value.trim();
    $("aiConfigMsg").textContent = "";
    if (!baseUrl) { $("aiConfigMsg").textContent = "Base URL required"; setStatus("err", "URL required"); return; }
    if (!apiKey) { $("aiConfigMsg").textContent = "API Key required"; setStatus("err", "Key required"); return; }
    saveSettings();
    setStatus("busy", "Testing");
    try {
      const res = await fetch("/api/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      const models = parseModels(data);
      if (!models.length) throw new Error("No model list returned");
      const eligible = filterPresetGroups(models).flatMap((group) => group.models).length;
      renderModelOptions(models, selectedModel(false));
      $("aiConfigMsg").textContent = `${eligible} configured models available`;
      setStatus("ok", "Ready");
    } catch (err) {
      $("aiConfigMsg").textContent = err.message || "Model test failed";
      setStatus("err", "Model error");
      renderModelOptions(AI_MODEL_PRESETS, selectedModel(false));
    }
  }

  // ---- drawer chrome ----
  function setConfigOpen(open) {
    aiConfigOpen = !!open;
    $("aiSettings").classList.toggle("collapsed", !aiConfigOpen);
    $("aiConfigToggle").classList.toggle("active", aiConfigOpen);
  }
  function setDrawerWidth(width) {
    const w = Math.max(320, Math.min(720, parseInt(width, 10) || 468));
    document.documentElement.style.setProperty("--ai-drawer-w", `${w}px`);
    requestAnimationFrame(() => host.workspace.resize());
  }
  function bindResize() {
    const handle = $("aiResizer");
    const drawer = $("aiDrawer");
    let startX = 0, startW = 0;
    const onMove = (e) => {
      const maxW = Math.max(320, Math.min(720, window.innerWidth - 360));
      const next = Math.max(320, Math.min(maxW, startW + startX - e.clientX));
      setDrawerWidth(next);
    };
    const onUp = () => {
      drawer.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      saveSettings();
    };
    handle.addEventListener("pointerdown", (e) => {
      if (window.matchMedia("(max-width: 860px)").matches) return;
      e.preventDefault();
      startX = e.clientX;
      startW = drawer.getBoundingClientRect().width;
      drawer.classList.add("resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }
  function setOpen(open) {
    aiOpen = !!open;
    $("aiDrawer").classList.toggle("hidden", !aiOpen);
    $("aiBtn").classList.toggle("active", aiOpen);
    document.querySelector(".main").classList.toggle("ai-open", aiOpen);
    requestAnimationFrame(() => host.workspace.resize());
    setTimeout(() => host.workspace.resize(), 180);
  }
  function setStatus(kind, text) {
    const el = $("aiStatus");
    el.className = "ai-status";
    if (kind) el.classList.add(kind);
    el.textContent = text;
  }
  function setBusy(on) {
    $("aiSendBtn").classList.toggle("hidden", !!on);
    $("aiStopBtn").classList.toggle("hidden", !on);
    $("aiTestModelsBtn").disabled = !!on;
    if (on) setStatus("busy", "Working");
  }

  // ---- run timeline (messages + tool cards) ----
  // Auto-scroll only while the user is pinned to the bottom, so they can scroll
  // up to review earlier content mid-stream without being yanked back down.
  let pinned = true;
  const msgsEl = () => $("aiMessages");
  const nearBottom = () => {
    const el = msgsEl();
    return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  };
  function updateJump() {
    const btn = $("aiJump");
    if (btn) btn.classList.toggle("show", !pinned);
  }
  function scrollDown(force) {
    const el = msgsEl();
    if (force) pinned = true;
    if (pinned) el.scrollTop = el.scrollHeight;
    updateJump();
  }
  const clearEmpty = () => msgsEl().querySelector(".ai-empty")?.remove();

  function appendUserMessage(text) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-msg user";
    el.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
    $("aiMessages").appendChild(el);
    scrollDown(true);
  }

  function beginAssistant() {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-msg assistant";
    el.innerHTML = `<div class="md"></div>`;
    $("aiMessages").appendChild(el);
    scrollDown(true);
    const md = el.querySelector(".md");
    return {
      update(text) { md.innerHTML = renderMarkdown(text || "Thinking…"); scrollDown(); },
      finalize(text) {
        if (!text || !text.trim()) { el.remove(); return; }
        md.innerHTML = renderMarkdown(text);
        scrollDown();
      },
    };
  }

  function buildToolCard(name, args) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "ai-tool";
    card.dataset.status = "running";
    card.innerHTML =
      `<button class="ai-tool-head" type="button">
         <span class="ai-tool-icon">${toolIcon(name)}</span>
         <span class="ai-tool-name"></span>
         <span class="ai-tool-state"><span class="ai-spinner"></span>Running</span>
         <svg class="ai-tool-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
       </button>
       <div class="ai-tool-body"></div>`;
    card.querySelector(".ai-tool-name").textContent = toolTitle(name, args);
    card.querySelector(".ai-tool-head").addEventListener("click", () => card.classList.toggle("open"));
    $("aiMessages").appendChild(card);
    const body = card.querySelector(".ai-tool-body");
    const state = card.querySelector(".ai-tool-state");
    const finish = (status, outcome, autoOpen) => {
      card.dataset.status = status;
      state.innerHTML = status === "error" ? "Error" : "Done";
      body.innerHTML = renderToolBody(name, outcome);
      card.classList.toggle("open", !!autoOpen);
    };
    return { card, finish };
  }

  function beginToolCard(name, args) {
    const { finish } = buildToolCard(name, args);
    scrollDown();
    return {
      setDone: (outcome) => { finish("done", outcome, name === "run_python" || name === "render_signal_images" || name === "capture_waveform_view"); scrollDown(); },
      setError: (msg, outcome) => { finish("error", outcome || { ok: false, error: msg }, true); scrollDown(); },
    };
  }

  // Render an already-finished tool card (used when replaying a saved
  // conversation). Replayed cards stay collapsed for a tidy overview; only
  // errors auto-expand so problems are visible.
  function addCompletedTool(name, args, outcome) {
    const { finish } = buildToolCard(name, args);
    if (outcome && outcome.ok === false) finish("error", outcome, true);
    else finish("done", outcome || {}, false);
  }

  function addAssistantMessage(text) {
    if (!text || !text.trim()) return;
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-msg assistant";
    el.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
    $("aiMessages").appendChild(el);
  }

  function appendNote(text) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-action-note";
    el.textContent = text;
    $("aiMessages").appendChild(el);
    scrollDown();
  }

  function appendError(text) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-msg error";
    el.innerHTML = `<div class="md">${renderMarkdown(text || "Request failed")}</div>`;
    $("aiMessages").appendChild(el);
    scrollDown(true);
  }

  function resetMessages() {
    $("aiMessages").innerHTML = EMPTY_STATE_HTML;
    pinned = true; updateJump();
  }

  // Replay a saved conversation's display log into the timeline.
  function renderConversation(log) {
    $("aiMessages").innerHTML = "";
    pinned = true;
    if (!Array.isArray(log) || !log.length) { resetMessages(); return; }
    for (const item of log) {
      if (item.kind === "user") appendUserMessage(item.text);
      else if (item.kind === "assistant") addAssistantMessage(item.text);
      else if (item.kind === "tool") addCompletedTool(item.name, item.args, item.outcome);
      else if (item.kind === "note") appendNote(item.text);
      else if (item.kind === "error") appendError(item.text);
    }
    scrollDown(true);
  }

  // ---- conversation history panel ----
  function closeHistory() { $("aiHistory").classList.add("hidden"); }
  function toggleHistory() { $("aiHistory").classList.toggle("hidden"); }
  function focusInput() { $("aiInput").focus(); }

  function renderHistory(list, activeId) {
    const el = $("aiHistoryList");
    if (!Array.isArray(list) || !list.length) {
      el.innerHTML = `<div class="ai-history-empty">No saved conversations yet.</div>`;
      return;
    }
    el.innerHTML = "";
    for (const c of list) {
      const row = document.createElement("div");
      row.className = "ai-history-row" + (c.id === activeId ? " active" : "");
      row.dataset.id = c.id;
      row.innerHTML =
        `<button class="ai-history-open" type="button">
           <span class="ai-history-title"></span>
           <span class="ai-history-meta">${c.messages} msg · ${timeAgo(c.updatedAt)}</span>
         </button>
         <button class="ai-history-del" title="Delete conversation" aria-label="Delete conversation">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
         </button>`;
      row.querySelector(".ai-history-title").textContent = c.title || "Untitled";
      el.appendChild(row);
    }
  }

  function getConfig() {
    return {
      baseUrl: $("aiBaseUrl").value.trim() || DEFAULT_AI_BASE_URL,
      apiKey: $("aiApiKey").value.trim(),
      model: selectedModel(),
    };
  }

  // ---- initial wiring ----
  renderModelOptions(AI_MODEL_PRESETS);
  const saved = loadSettings();
  $("aiBaseUrl").value = saved.baseUrl || DEFAULT_AI_BASE_URL;
  $("aiApiKey").value = saved.apiKey || "";
  $("aiCustomModel").value = saved.customModel || "";
  const savedModel = saved.model || DEFAULT_AI_MODEL;
  setModelSelection(LEGACY_DEFAULT_AI_MODELS.has(savedModel) ? DEFAULT_AI_MODEL : savedModel);
  setDrawerWidth(saved.drawerWidth || 468);
  setConfigOpen(false);
  syncCustomField();
  const configured = !!(saved.baseUrl && saved.apiKey);
  setStatus(configured ? "ok" : "", configured ? "Ready" : "Not connected");

  $("aiBtn").addEventListener("click", () => setOpen(!aiOpen));
  $("aiCloseBtn").addEventListener("click", () => setOpen(false));
  $("aiConfigToggle").addEventListener("click", () => setConfigOpen(!aiConfigOpen));
  bindResize();
  function syncConfigStatus() {
    const ready = !!($("aiBaseUrl").value.trim() && $("aiApiKey").value.trim());
    setStatus(ready ? "ok" : "", ready ? "Ready" : "Not connected");
  }
  $("aiBaseUrl").addEventListener("input", () => { saveSettings(); syncConfigStatus(); });
  $("aiApiKey").addEventListener("input", () => {
    saveSettings();
    syncConfigStatus();
  });
  $("aiModelSelect").addEventListener("change", () => { syncCustomField(); saveSettings(); });
  $("aiCustomModel").addEventListener("input", saveSettings);
  $("aiTestModelsBtn").addEventListener("click", loadModels);
  $("aiSendBtn").addEventListener("click", () => handlers.onSend?.($("aiInput").value));
  $("aiStopBtn").addEventListener("click", () => handlers.onStop?.());
  $("aiNewBtn").addEventListener("click", () => handlers.onNewChat?.());
  $("aiHistoryBtn").addEventListener("click", toggleHistory);
  $("aiHistoryClose").addEventListener("click", closeHistory);
  $("aiHistoryList").addEventListener("click", (e) => {
    const row = e.target.closest(".ai-history-row");
    if (!row) return;
    if (e.target.closest(".ai-history-del")) handlers.onDeleteConversation?.(row.dataset.id);
    else handlers.onSelectConversation?.(row.dataset.id);
  });
  $("aiInput").addEventListener("keydown", (e) => {
    // Ignore Enter while an IME is composing (e.g. confirming a Chinese
    // candidate), so picking a candidate doesn't send a half-finished message.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handlers.onSend?.($("aiInput").value);
    }
  });
  msgsEl().addEventListener("scroll", () => { pinned = nearBottom(); updateJump(); });
  $("aiJump")?.addEventListener("click", () => { pinned = true; scrollDown(true); });

  return {
    appendUserMessage, beginAssistant, beginToolCard, appendNote, appendError, resetMessages,
    renderConversation, renderHistory, closeHistory, focusInput,
    setBusy, setStatus, setOpen, saveSettings, getConfig,
    clearInput: () => { $("aiInput").value = ""; },
  };
}

// Keep the selector compact after loading a provider's much larger model list.
// An empty input means "no provider filter" and is useful for initial render.
export function filterPresetGroups(models = []) {
  const available = new Set((models || []).filter(Boolean));
  const shouldFilter = available.size > 0;
  return AI_MODEL_GROUPS
    .map((group) => ({
      label: group.label,
      models: shouldFilter ? group.models.filter((model) => available.has(model)) : group.models.slice(),
    }))
    .filter((group) => group.models.length > 0);
}

// ---- tool-card body rendering (module scope) ----------------------------
function prettyJSON(value, max = 4000) {
  let text;
  try { text = JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  if (text == null) text = "null";
  if (text.length > max) text = text.slice(0, max) + `\n…(${text.length} chars)`;
  return text;
}

function renderToolBody(name, outcome = {}) {
  const parts = [];
  if (name === "run_python") {
    const r = outcome.result || {};
    if (outcome.code) parts.push(`<div class="ai-tool-label">code</div><pre class="ai-code"><code>${escapeHtml(outcome.code)}</code></pre>`);
    if (r.stdout) parts.push(`<div class="ai-tool-label">stdout</div><pre class="ai-out">${escapeHtml(r.stdout)}</pre>`);
    if (r.result != null) parts.push(`<div class="ai-tool-label">result</div><pre class="ai-out">${escapeHtml(prettyJSON(r.result))}</pre>`);
    if (r.eventCandidates?.length) parts.push(`<div class="ai-tool-label">event candidates (not applied)</div><pre class="ai-out">${escapeHtml(prettyJSON(r.eventCandidates, 1600))}</pre>`);
    parts.push(...renderAttachments(outcome.attachments, "sandbox figure"));
    const err = outcome.error || r.error || (r.stderr && !r.ok ? r.stderr : "");
    if (err) parts.push(`<div class="ai-tool-label">error</div><pre class="ai-err">${escapeHtml(err)}</pre>`);
    return parts.join("") || `<pre class="ai-out">(no output)</pre>`;
  }
  if (name === "render_signal_images" || name === "capture_waveform_view") {
    parts.push(...renderAttachments(outcome.attachments, "signal image"));
    if (outcome.imageDataUrl) parts.push(imgTag(outcome.imageDataUrl, "waveform view"));
    if (outcome.result) parts.push(`<pre class="ai-out">${escapeHtml(prettyJSON(outcome.result, 1200))}</pre>`);
    return parts.join("") || `<pre class="ai-out">(captured)</pre>`;
  }
  if (!outcome.ok) return `<pre class="ai-err">${escapeHtml(outcome.error || "Tool failed")}</pre>`;
  return `<pre class="ai-out">${escapeHtml(prettyJSON(outcome.result))}</pre>`;
}

function renderAttachments(attachments, fallbackAlt) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((attachment, index) => {
    const label = attachment?.label || `${fallbackAlt} ${index + 1}`;
    return `<div class="ai-tool-label">${escapeHtml(label)}</div>${imgTag(attachment?.dataUrl, label)}`;
  });
}

function imgTag(url, alt) {
  if (typeof url === "string" && url.startsWith("data:")) return `<img class="ai-figure" src="${url}" alt="${alt}" />`;
  return `<div class="ai-note-line">🖼 ${alt} — not stored in history</div>`;
}

function svgIcon(paths) {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
function toolIcon(name) {
  const map = {
    run_python: '<path d="M8 18l-4-6 4-6"/><path d="M16 6l4 6-4 6"/>',
    render_signal_images: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="M21 16l-5-5-5 5"/>',
    capture_waveform_view: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="M21 16l-5-5-5 5"/>',
    inspect_channel: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    inspect_time_window: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    rank_channels: '<path d="M4 20V9M10 20V4M16 20v-8M21 20H3"/>',
    detect_artifact_candidates: '<path d="M12 3 21 19H3z"/><path d="M12 10v4M12 17h.01"/>',
    get_current_context: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    get_signal_workspace_state: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    read_signal_workspace_guide: '<path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 0-3-3z"/><path d="M7 7h8M7 11h8"/>',
    list_signal_sources: '<path d="M3 6h7l2 2h9v10H3z"/>',
    open_signal_source: '<path d="M3 6h7l2 2h9v10H3z"/><path d="m11 11 3 2-3 2z"/>',
    set_view: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    set_processing: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    control_signal_view: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    configure_signal_processing: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    add_marker: '<path d="M6 3v18l6-4 6 4V3z"/>',
    mark_events: '<path d="M4 22V4h13l-2 4 2 4H4"/>',
    manage_signal_events: '<path d="M4 22V4h13l-2 4 2 4H4"/>',
    export_signal_artifact: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  };
  return svgIcon(map[name] || '<circle cx="12" cy="12" r="3.2"/>');
}
function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - (ts || 0)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
