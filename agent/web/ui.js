// ui.js — EEG-Master drawer UI: settings, model picker, resize, status, and
// message bubbles. Returns an API the controller (agent.js) drives.

import { renderMarkdown, escapeHtml } from "./markdown.js";
import { toolTitle } from "./tools.js";
import {
  AI_MODEL_GROUPS, CUSTOM_MODEL_VALUE,
  DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, LEGACY_DEFAULT_AI_MODELS,
} from "./prompt.js";
import { loadAgentSettings, saveAgentSettings } from "./settings-store.js";
import { createSkillsManager } from "./skills-ui.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_MAX_TURNS = 16;
const MIN_MAX_TURNS = 4;
const MAX_MAX_TURNS = 64;
const DEFAULT_MAX_AGENT_IMAGES = 5;
const MIN_AGENT_IMAGES = 1;
const MAX_AGENT_IMAGES = 5;
const DEFAULT_MAX_IMAGE_WINDOW_SEC = 15;
const MIN_IMAGE_WINDOW_SEC = 5;
const MAX_IMAGE_WINDOW_SEC = 15;

const EMPTY_STATE_HTML = `
  <div class="ai-empty">
    <div class="ai-empty-icon" aria-hidden="true">
      <img src="/pic/agent_logo/eeg-master-ai-scope-rounded-512.png" alt="" />
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
  let suppressFabClick = false;
  let saveStateTimer = null;
  const skills = createSkillsManager({ onChange: () => saveSettings(), onMessage: (message) => showSavedFeedback(message) });

  // ---- settings persistence ----
  function loadSettings() {
    return loadAgentSettings();
  }
  function boundedInt(value, fallback, min, max) {
    const number = parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }
  function currentLimits() {
    return {
      maxTurns: boundedInt($("aiMaxTurns")?.value, DEFAULT_MAX_TURNS, MIN_MAX_TURNS, MAX_MAX_TURNS),
      maxAgentImages: boundedInt($("aiMaxAgentImages")?.value, DEFAULT_MAX_AGENT_IMAGES, MIN_AGENT_IMAGES, MAX_AGENT_IMAGES),
      maxImageWindowSec: boundedInt($("aiMaxImageWindowSec")?.value, DEFAULT_MAX_IMAGE_WINDOW_SEC, MIN_IMAGE_WINDOW_SEC, MAX_IMAGE_WINDOW_SEC),
    };
  }
  function skillManifestForConfig() {
    return skills.getManifest();
  }
  function enabledSkillsForConfig() {
    return skills.getEnabledNames();
  }
  function currentFabPosition() {
    const btn = $("aiBtn");
    if (!btn?.classList.contains("is-positioned")) return null;
    const left = parseFloat(btn.style.left);
    const top = parseFloat(btn.style.top);
    return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
  }
  function setSaveState(kind = "ready", text = "Ready") {
    const state = $("aiSaveState");
    if (!state) return;
    state.className = `ai-save-state ${kind}`;
    state.textContent = text;
  }
  function showSavedFeedback(message = "Saved") {
    setSaveState("saved", message);
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => setSaveState("ready", "Ready"), 1200);
  }
  function saveSettings({ feedback = false } = {}) {
    if (feedback) setSaveState("busy", "Saving");
    const limits = currentLimits();
    const fab = currentFabPosition();
    const settings = {
      baseUrl: $("aiBaseUrl").value.trim() || DEFAULT_AI_BASE_URL,
      apiKey: $("aiApiKey").value,
      model: selectedModel(false),
      customModel: $("aiCustomModel").value.trim(),
      drawerWidth: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--ai-drawer-w"), 10) || 468,
      enabledSkills: enabledSkillsForConfig(),
      ...limits,
      ...(fab ? { fabLeft: fab.left, fabTop: fab.top } : {}),
    };
    saveAgentSettings(settings);
    if (feedback) showSavedFeedback();
    else setSaveState("ready", "Ready");
  }

  // ---- model picker ----
  // The selector always offers the curated families + Custom, independent of what
  // the provider's /models endpoint lists. Providers (e.g. bianxie.ai) often omit
  // exact preset IDs from that listing even though the models work, so filtering
  // the dropdown against it would wrongly drop whole families (GPT, Qwen). "Test
  // models" only validates the connection; it never reshuffles these options.
  function renderModelOptions(preferred = null) {
    const select = $("aiModelSelect");
    const current = preferred || selectedModel(false) || DEFAULT_AI_MODEL;
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
    for (const group of AI_MODEL_GROUPS) addGroup(group.label, group.models);
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
      $("aiConfigMsg").textContent = `Connected · ${models.length} model${models.length === 1 ? "" : "s"} on this provider`;
      setStatus("ok", "Ready");
    } catch (err) {
      $("aiConfigMsg").textContent = err.message || "Model test failed";
      setStatus("err", "Model error");
    }
  }

  // ---- drawer chrome ----
  function setConfigOpen(open) {
    if (!open) return;
    $("aiConfigToggle")?.classList.add("active");
    handlers.onOpenConfig?.();
    setTimeout(() => $("aiConfigToggle")?.classList.remove("active"), 700);
  }
  function setDrawerWidth(width) {
    const w = Math.max(320, Math.min(720, parseInt(width, 10) || 468));
    document.documentElement.style.setProperty("--ai-drawer-w", `${w}px`);
    requestAnimationFrame(() => host.workspace.resize());
  }
  function clampFabPosition(left, top) {
    const btn = $("aiBtn");
    const stage = $("stage");
    const sw = stage?.clientWidth || window.innerWidth;
    const sh = stage?.clientHeight || window.innerHeight;
    const bw = btn?.offsetWidth || 168;
    const bh = btn?.offsetHeight || 52;
    const pad = 10;
    return {
      left: Math.max(pad, Math.min(sw - bw - pad, Number(left) || pad)),
      top: Math.max(pad, Math.min(sh - bh - pad, Number(top) || pad)),
    };
  }
  function setFabPosition(left, top) {
    const btn = $("aiBtn");
    if (!btn) return;
    const pos = clampFabPosition(left, top);
    btn.classList.add("is-positioned");
    btn.style.left = `${Math.round(pos.left)}px`;
    btn.style.top = `${Math.round(pos.top)}px`;
  }
  function bindFabDrag() {
    const btn = $("aiBtn");
    const stage = $("stage");
    if (!btn || !stage) return;
    let drag = null;
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const stageRect = stage.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: btnRect.left - stageRect.left,
        top: btnRect.top - stageRect.top,
        moved: false,
      };
      btn.setPointerCapture?.(e.pointerId);
    });
    btn.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      btn.classList.add("dragging");
      setFabPosition(drag.left + dx, drag.top + dy);
      e.preventDefault();
    });
    const finish = (e) => {
      if (!drag || (e?.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
      btn.releasePointerCapture?.(drag.pointerId);
      btn.classList.remove("dragging");
      if (drag.moved) {
        suppressFabClick = true;
        saveSettings();
        setTimeout(() => { suppressFabClick = false; }, 0);
      }
      drag = null;
    };
    btn.addEventListener("pointerup", finish);
    btn.addEventListener("pointercancel", finish);
    window.addEventListener("resize", () => {
      const pos = currentFabPosition();
      if (pos) setFabPosition(pos.left, pos.top);
    });
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
    el.innerHTML = `<div class="md"><span class="ai-thinking-line"><span class="ai-thinking-text">Thinking</span></span></div>`;
    $("aiMessages").appendChild(el);
    scrollDown(true);
    const md = el.querySelector(".md");
    return {
      update(text) {
        md.innerHTML = text
          ? renderMarkdown(text)
          : `<span class="ai-thinking-line"><span class="ai-thinking-text">Thinking</span></span>`;
        scrollDown();
      },
      finalize(text) {
        if (!text || !text.trim()) { el.remove(); return; }
        md.innerHTML = renderMarkdown(text);
        scrollDown();
      },
    };
  }

  function buildToolCard(name, args) {
    clearEmpty();
    const skill = isSkillTool(name);
    const card = document.createElement("div");
    card.className = "ai-tool";
    card.dataset.status = "running";
    card.dataset.kind = skill ? "skill" : "tool";
    card.innerHTML =
      `<button class="ai-tool-head" type="button">
         <span class="ai-tool-icon">${toolIcon(name)}</span>
         <span class="ai-tool-name"></span>
         ${skill ? '<span class="ai-tool-kind">skill</span>' : ""}
         <span class="ai-tool-state"><span class="ai-spinner"></span>${skillRunningVerb(name)}</span>
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
      state.innerHTML = status === "error" ? `${ERROR_GLYPH}<span>Error</span>` : DONE_CHECK;
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

  function appendStepLimitNotice(maxTurns) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-limit-card";
    el.innerHTML =
      `<b>Paused at step limit</b>
       <p>EEG-Master used ${Number(maxTurns) || DEFAULT_MAX_TURNS} model step(s) and paused before starting another round. Continue keeps the same context and existing tool results.</p>
       <div class="ai-limit-actions">
         <button type="button" data-action="continue">Continue</button>
         <button type="button" data-action="config">Open Config</button>
       </div>`;
    el.querySelector('[data-action="continue"]').addEventListener("click", () => handlers.onContinue?.());
    el.querySelector('[data-action="config"]').addEventListener("click", () => setConfigOpen(true));
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
    const limits = currentLimits();
    return {
      baseUrl: $("aiBaseUrl").value.trim() || DEFAULT_AI_BASE_URL,
      apiKey: $("aiApiKey").value.trim(),
      model: selectedModel(),
      ...limits,
      skills: {
        enabled: enabledSkillsForConfig(),
        available: skillManifestForConfig(),
      },
    };
  }

  function getPublicConfig() {
    const cfg = getConfig();
    return {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKeyConfigured: Boolean(cfg.apiKey),
      maxTurns: cfg.maxTurns,
      maxAgentImages: cfg.maxAgentImages,
      maxImageWindowSec: cfg.maxImageWindowSec,
      skills: cfg.skills,
      storage: "localStorage+sessionStorage",
    };
  }

  // ---- initial wiring ----
  renderModelOptions();
  const saved = loadSettings();
  $("aiBaseUrl").value = saved.baseUrl || DEFAULT_AI_BASE_URL;
  $("aiApiKey").value = saved.apiKey || "";
  $("aiCustomModel").value = saved.customModel || "";
  $("aiMaxTurns").value = boundedInt(saved.maxTurns, DEFAULT_MAX_TURNS, MIN_MAX_TURNS, MAX_MAX_TURNS);
  $("aiMaxAgentImages").value = boundedInt(saved.maxAgentImages, DEFAULT_MAX_AGENT_IMAGES, MIN_AGENT_IMAGES, MAX_AGENT_IMAGES);
  $("aiMaxImageWindowSec").value = boundedInt(saved.maxImageWindowSec, DEFAULT_MAX_IMAGE_WINDOW_SEC, MIN_IMAGE_WINDOW_SEC, MAX_IMAGE_WINDOW_SEC);
  skills.hydrate(saved.enabledSkills, Array.isArray(saved.enabledSkills));
  const savedModel = saved.model || DEFAULT_AI_MODEL;
  setModelSelection(LEGACY_DEFAULT_AI_MODELS.has(savedModel) ? DEFAULT_AI_MODEL : savedModel);
  setDrawerWidth(saved.drawerWidth || 468);
  syncCustomField();
  const configured = !!(saved.baseUrl && saved.apiKey);
  setStatus(configured ? "ok" : "", configured ? "Ready" : "Not connected");
  if (Number.isFinite(Number(saved.fabLeft)) && Number.isFinite(Number(saved.fabTop))) {
    requestAnimationFrame(() => setFabPosition(saved.fabLeft, saved.fabTop));
  }

  $("aiBtn").addEventListener("click", (e) => {
    if (suppressFabClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressFabClick = false;
      return;
    }
    setOpen(!aiOpen);
  });
  $("aiCloseBtn").addEventListener("click", () => setOpen(false));
  $("aiConfigToggle").addEventListener("click", () => setConfigOpen(true));
  $("aiSaveConfigBtn")?.addEventListener("click", () => saveSettings({ feedback: true }));
  bindResize();
  bindFabDrag();
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
  ["aiMaxTurns", "aiMaxAgentImages", "aiMaxImageWindowSec"].forEach((id) => {
    $(id)?.addEventListener("input", saveSettings);
    $(id)?.addEventListener("change", () => {
      const limits = currentLimits();
      $("aiMaxTurns").value = limits.maxTurns;
      $("aiMaxAgentImages").value = limits.maxAgentImages;
      $("aiMaxImageWindowSec").value = limits.maxImageWindowSec;
      saveSettings();
    });
  });
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

  // ---- export menu (format picker) ----
  const exportBtn = $("aiExportBtn");
  const exportMenu = $("aiExportMenu");
  const closeExportMenu = () => { exportMenu.classList.remove("open"); exportBtn.setAttribute("aria-expanded", "false"); };
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = exportMenu.classList.toggle("open");
    exportBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  exportMenu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-format]");
    if (!item) return;
    closeExportMenu();
    handlers.onExport?.(item.dataset.format);
  });
  document.addEventListener("click", (e) => { if (!exportBtn.parentElement.contains(e.target)) closeExportMenu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeExportMenu();
    }
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
  skills.load();

  return {
    appendUserMessage, beginAssistant, beginToolCard, appendNote, appendError, resetMessages,
    renderConversation, renderHistory, closeHistory, focusInput,
    appendStepLimitNotice,
    setBusy, setStatus, setOpen, saveSettings, getConfig, getPublicConfig,
    refreshSkills: (options) => skills.load(options),
    clearInput: () => { $("aiInput").value = ""; },
  };
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

export function renderToolBody(name, outcome = {}) {
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

// Skill-related tool calls get a distinct "using skill" treatment in the
// timeline (a sparkle badge + clay shimmer), mirroring how Claude surfaces skill
// use, so a skill invocation reads differently from an ordinary signal tool.
const SKILL_TOOLS = new Set([
  "list_agent_skills", "read_agent_skill", "create_agent_skill", "update_agent_skill",
]);
export function isSkillTool(name) { return SKILL_TOOLS.has(String(name || "")); }
// A small check that draws itself in on completion (a quiet, Codex-like finish
// cue) and a compact error glyph — both replace the old colored status pills.
const DONE_CHECK = '<svg class="ai-done-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const ERROR_GLYPH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>';
function skillRunningVerb(name) {
  if (name === "read_agent_skill") return "Reading";
  if (name === "list_agent_skills") return "Reading";
  if (name === "create_agent_skill" || name === "update_agent_skill") return "Saving";
  return "Running";
}

function svgIcon(paths) {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
export function toolIcon(name) {
  const map = {
    run_python: '<path d="M8 18l-4-6 4-6"/><path d="M16 6l4 6-4 6"/>',
    signal_query: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3"/><path d="M21 21l-2.5-2.5"/><circle cx="17" cy="17" r="2.2"/>',
    render_signal_images: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="M21 16l-5-5-5 5"/>',
    capture_waveform_view: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="M21 16l-5-5-5 5"/>',
    inspect_channel: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    inspect_time_window: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    rank_channels: '<path d="M4 20V9M10 20V4M16 20v-8M21 20H3"/>',
    detect_artifact_candidates: '<path d="M12 3 21 19H3z"/><path d="M12 10v4M12 17h.01"/>',
    get_current_context: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    get_signal_workspace_state: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    get_workspace_configuration: '<path d="M4 7h10"/><path d="M4 17h10"/><circle cx="18" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    read_signal_workspace_guide: '<path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 0-3-3z"/><path d="M7 7h8M7 11h8"/>',
    list_agent_skills: '<path d="M4 5h7v7H4z"/><path d="M13 5h7v7h-7z"/><path d="M4 14h7v5H4z"/><path d="M13 14h7v5h-7z"/>',
    read_agent_skill: '<path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 0-3-3z"/><path d="M8 8h7M8 12h5"/><path d="M18 3v5"/>',
    create_agent_skill: '<path d="M12 3l1.9 4.6L19 9l-4 3.3L16.2 18 12 15.3 7.8 18 9 12.3 5 9l5.1-1.4z"/>',
    update_agent_skill: '<path d="M12 3l1.9 4.6L19 9l-4 3.3L16.2 18 12 15.3 7.8 18 9 12.3 5 9l5.1-1.4z"/>',
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
