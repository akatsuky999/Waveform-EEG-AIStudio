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
import {
  DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW,
  normalizeContextWindow, readModelContextMap,
} from "./context-budget.js";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES } from "./permissions.js";

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
    <span class="ai-empty-eyebrow">Agent</span>
    <b>EEG-Master</b>
    <p>Works the recording, not a summary.</p>
    <div class="ai-empty-caps">
      <span><i>01</i>Inspect &amp; rank channels</span>
      <span><i>02</i>Run Python on the signal</span>
      <span><i>03</i>Mark onset / offset</span>
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
  // ---- context window: detected, learned, or set by hand --------------------
  // Priority: a value the user typed (never overwritten) > what the provider
  // declared for this model in /v1/models > what the provider told us in an
  // overflow error > the configured default.
  let modelContextMap = new Map();
  let contextSource = "default";

  const CONTEXT_SOURCE_LABEL = {
    provider: "from provider", learned: "from provider limit", manual: "manual", default: "default",
  };

  function setContextWindow(tokens, source) {
    const field = $("aiContextWindow");
    if (!field) return false;
    const value = normalizeContextWindow(tokens);
    if (!Number.isFinite(value)) return false;
    field.value = String(value);
    contextSource = source;
    renderContextSource();
    saveSettings();
    return true;
  }

  function renderContextSource() {
    const badge = $("aiContextSource");
    if (badge) badge.textContent = CONTEXT_SOURCE_LABEL[contextSource] || "";
  }

  /** Adopt the window a provider declares for the selected model, if it does. */
  function applyDetectedContextWindow() {
    if (contextSource === "manual") return false;          // never fight the user
    const declared = modelContextMap.get(selectedModel());
    if (!declared || declared === normalizeContextWindow($("aiContextWindow")?.value)) return false;
    return setContextWindow(declared, "provider");
  }

  /** Called when the provider rejects a request for being too long. */
  function learnContextWindow(tokens) {
    if (contextSource === "manual") return false;
    return setContextWindow(tokens, "learned");
  }

  function currentPermissionMode() {
    const value = $("aiPermissionMode")?.value;
    return PERMISSION_MODES.includes(value) ? value : DEFAULT_PERMISSION_MODE;
  }

  // ---- composer control strip ----
  // The strip mirrors the agent's operating state at the point of typing: what it
  // is allowed to do, what it is attached to, which model, how full the context
  // is. Nothing here needs a label — the value IS the label.
  const MODE_CHIP = { ask: "Ask", readonly: "Read-only", trusted: "Trusted" };

  function syncModeChip() {
    const chip = $("aiModeChip");
    const mode = currentPermissionMode();
    if (chip) {
      chip.dataset.mode = mode;
      chip.textContent = MODE_CHIP[mode] || mode;
    }
    // the settings segmented control is the same state, shown in full
    for (const button of $("aiPermissionSeg")?.querySelectorAll("[data-value]") || []) {
      button.setAttribute("aria-pressed", String(button.dataset.value === mode));
    }
  }

  function setPermissionMode(mode) {
    const select = $("aiPermissionMode");
    if (!select || !PERMISSION_MODES.includes(mode)) return;
    select.value = mode;
    syncModeChip();
    saveSettings();
  }

  function cycleMode() {
    const next = PERMISSION_MODES[(PERMISSION_MODES.indexOf(currentPermissionMode()) + 1) % PERMISSION_MODES.length];
    setPermissionMode(next);
  }

  function syncModelChip() {
    const chip = $("aiBarModel") || $("aiModelChip");
    if (!chip) return;
    const model = selectedModel() || "no model";
    chip.textContent = model;
    chip.title = `${model}${$("aiBaseUrl")?.value.trim() ? ` · ${$("aiBaseUrl").value.trim()}` : ""}`;
  }

  function syncSkillsChip() {
    const count = $("aiSkillsCount");
    if (!count) return;
    const enabled = enabledSkillsForConfig().length;
    count.textContent = enabled ? String(enabled) : "";
    count.classList.toggle("show", enabled > 0);
    $("aiSkillsChip")?.classList.toggle("active", enabled > 0);
  }

  function syncBar() { syncModeChip(); syncModelChip(); syncSkillsChip(); }
  function currentLimits() {
    return {
      maxTurns: boundedInt($("aiMaxTurns")?.value, DEFAULT_MAX_TURNS, MIN_MAX_TURNS, MAX_MAX_TURNS),
      maxAgentImages: boundedInt($("aiMaxAgentImages")?.value, DEFAULT_MAX_AGENT_IMAGES, MIN_AGENT_IMAGES, MAX_AGENT_IMAGES),
      maxImageWindowSec: boundedInt($("aiMaxImageWindowSec")?.value, DEFAULT_MAX_IMAGE_WINDOW_SEC, MIN_IMAGE_WINDOW_SEC, MAX_IMAGE_WINDOW_SEC),
      contextWindow: normalizeContextWindow($("aiContextWindow")?.value),
      autoCompact: $("aiAutoCompact") ? Boolean($("aiAutoCompact").checked) : true,
      permissionMode: currentPermissionMode(),
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
  function setConfigMsg(text, kind = "") {
    const el = $("aiConfigMsg");
    if (!el) return;
    el.textContent = text;
    if (kind) el.dataset.kind = kind;
    else delete el.dataset.kind;
  }
  function showSavedFeedback(message = "Saved") {
    setSaveState("saved", message);
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => setSaveState("ready", "Ready"), 1200);
  }
  function saveSettings({ feedback = false } = {}) {
    if (feedback) setSaveState("busy", "Saving");
    syncBar();
    const limits = currentLimits();
    const fab = currentFabPosition();
    const settings = {
      baseUrl: $("aiBaseUrl").value.trim() || DEFAULT_AI_BASE_URL,
      apiKey: $("aiApiKey").value,
      model: selectedModel(false),
      customModel: $("aiCustomModel").value.trim(),
      drawerWidth: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--ai-drawer-w"), 10) || 468,
      enabledSkills: enabledSkillsForConfig(),
      contextWindowSource: contextSource,
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
    setConfigMsg("");
    if (!baseUrl) { setConfigMsg("Base URL required", "err"); setStatus("err", "URL required"); return; }
    if (!apiKey) { setConfigMsg("API Key required", "err"); setStatus("err", "Key required"); return; }
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
      modelContextMap = readModelContextMap(data);
      const detected = applyDetectedContextWindow();
      const declared = modelContextMap.get(selectedModel());
      setConfigMsg(
        `Connected · ${models.length} model${models.length === 1 ? "" : "s"}`
        + (detected ? ` · context ${Math.round(declared / 1000)}k detected` : ""),
        "ok",
      );
      setStatus("ok", "Ready");
    } catch (err) {
      setConfigMsg(err.message || "Model test failed", "err");
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
  // The drawer may not eat the stage: its ceiling is whatever is left after the
  // sidebar and a minimum waveform width.
  function maxDrawerWidth() {
    // Declared widths, not measured rects — see the matching note in sidebar.js.
    const panel = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-panel-w")) || 294;
    const sidebar = document.getElementById("workspaceSidebar") ? panel + 46 : 0;
    return Math.max(320, Math.min(720, window.innerWidth - sidebar - 340));
  }

  function clampDrawerWidth() {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--ai-drawer-w"), 10) || 468;
    const next = Math.min(current, maxDrawerWidth());
    if (Math.abs(next - current) > 0.5) setDrawerWidth(next);
  }

  function bindResize() {
    const handle = $("aiResizer");
    const drawer = $("aiDrawer");
    let startX = 0, startW = 0, dragId = null;
    const onMove = (e) => {
      if (dragId !== null && e.pointerId !== dragId) return;
      setDrawerWidth(Math.max(320, Math.min(maxDrawerWidth(), startW + startX - e.clientX)));
    };
    // Same hardening as the sidebar handle: capture the pointer, and end the drag
    // on cancel/blur so a swallowed pointerup can never leave it armed.
    const endDrag = (e) => {
      if (dragId !== null && e?.pointerId !== undefined && e.pointerId !== dragId) return;
      if (dragId !== null) { try { handle.releasePointerCapture?.(dragId); } catch { /* already released */ } }
      dragId = null;
      drawer.classList.remove("resizing");
      document.documentElement.classList.remove("is-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", endDrag);
      handle.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
      saveSettings();
    };
    handle.addEventListener("pointerdown", (e) => {
      if (window.matchMedia("(max-width: 860px)").matches) return;
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      dragId = e.pointerId;
      startX = e.clientX;
      startW = drawer.getBoundingClientRect().width;
      drawer.classList.add("resizing");
      document.documentElement.classList.add("is-resizing");
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", endDrag);
      handle.addEventListener("pointercancel", endDrag);
      window.addEventListener("blur", endDrag);
      try { handle.setPointerCapture?.(e.pointerId); } catch { /* capture is an optimisation */ }
    });
    window.addEventListener("resize", clampDrawerWidth);
  }
  function setOpen(open) {
    aiOpen = !!open;
    $("aiDrawer").classList.toggle("hidden", !aiOpen);
    $("aiBtn").classList.toggle("active", aiOpen);
    document.querySelector(".main").classList.toggle("ai-open", aiOpen);
    if (aiOpen) clampDrawerWidth();
    // Opening the drawer changes how much room the sidebar may claim.
    requestAnimationFrame(() => { window.eegSidebar?.reclamp?.(); host.workspace.resize(); });
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

  function appendUserMessage(text, attachments = []) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-msg user";
    el.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
    appendMessageAttachments(el, attachments);
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

  // ---- context meter -------------------------------------------------------
  // Mirrors the "how full is the window" readout of a desktop coding agent: a
  // percentage with a bar, and a breakdown that explains WHY it is full (tool
  // schemas and injected workspace state are re-sent every single turn, which is
  // otherwise invisible and surprising).
  let lastUsage = null;

  function formatTokens(value) {
    const number = Number(value) || 0;
    if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k`;
    return String(Math.round(number));
  }

  function setContextUsage(usage) {
    lastUsage = usage;
    const meter = $("aiContextMeter");
    const fill = $("aiContextFill");
    const label = $("aiContextLabel");
    if (!meter || !fill || !label) return;
    if (!usage) {
      meter.classList.add("hidden");
      return;
    }
    meter.classList.remove("hidden");
    meter.dataset.level = usage.level;
    fill.style.width = `${Math.min(100, usage.percentUsed)}%`;
    label.textContent = `${usage.percentUsed}%`;
    meter.title = `Context ${usage.percentUsed}% used · ${formatTokens(usage.used)} of ${formatTokens(usage.usable)} usable tokens`;
    meter.setAttribute("aria-label", meter.title);
    renderContextPanel(usage);
  }

  // Where the window actually goes, largest slice first — the readout's job is to
  // show that the fixed per-turn overhead (tool schemas, injected state) is often
  // bigger than the conversation itself. One accent for the live part, neutrals
  // for the rest: a five-colour chart would fight everything else in the drawer.
  const CONTEXT_PARTS = [
    { key: "conversation", label: "Conversation", tone: "live" },
    { key: "images", label: "Signal images", tone: "images" },
    { key: "tools", label: "Tool schemas", tone: "fixed" },
    { key: "system", label: "System prompt", tone: "fixed-2" },
    { key: "workspace", label: "Workspace state", tone: "fixed-3" },
  ];

  function renderContextPanel(usage) {
    const panel = $("aiContextPanel");
    if (!panel || panel.classList.contains("hidden")) return;
    const parts = CONTEXT_PARTS
      .map((part) => ({ ...part, value: usage.breakdown[part.key] || 0 }))
      .filter((part) => part.value > 0)
      .sort((a, b) => b.value - a.value);

    // The bar shows the COMPOSITION of what is used, across the full width. Drawing
    // it against the whole window instead would collapse into slivers whenever the
    // context is mostly empty — exactly when a user opens this to understand it.
    // "How full" is already the headline number and the meter in the head.
    $("aiContextStack").innerHTML = parts.map((part) =>
      `<i data-tone="${part.tone}" style="flex:${part.value}" title="${escapeHtml(part.label)}"></i>`).join("");

    $("aiContextBreakdown").innerHTML = parts.map((part) =>
      `<div class="ai-ctx-row">
         <span class="ai-ctx-key" data-tone="${part.tone}"></span>
         <span class="ai-ctx-name">${escapeHtml(part.label)}</span>
         <b>${formatTokens(part.value)}</b>
       </div>`).join("");

    $("aiContextSummary").innerHTML = `<b>${usage.percentUsed}%</b>`
      + `<span>${usage.shouldCompact
        ? "over the threshold — the next step compacts first"
        : `${formatTokens(usage.remaining)} free · ${usage.percentUntilCompact}% before auto-compact`}</span>`;
    $("aiContextLimit").textContent =
      `${formatTokens(usage.used)} of ${formatTokens(usage.usable)} usable · local estimate`;
  }

  function toggleContextPanel(force) {
    const panel = $("aiContextPanel");
    if (!panel) return;
    const open = force ?? panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !open);
    $("aiContextMeter")?.setAttribute("aria-expanded", String(open));
    if (open && lastUsage) renderContextPanel(lastUsage);
  }

  // ---- compaction card -----------------------------------------------------
  function beginCompaction(reason = "auto") {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-compaction running";
    el.innerHTML =
      `<div class="ai-compaction-head">
         <span class="ai-spinner"></span>
         <b>Compacting context</b>
         <span class="ai-compaction-reason"></span>
       </div>
       <p class="ai-compaction-body">Folding earlier steps into a handoff summary. Images are not carried over.</p>`;
    el.querySelector(".ai-compaction-reason").textContent =
      reason === "manual" ? "requested" : reason === "overflow" ? "window full" : "auto";
    $("aiMessages").appendChild(el);
    scrollDown(true);
    return {
      finish(note, summary) {
        el.classList.remove("running");
        el.classList.add("done");
        renderCompactionCard(el, note, summary);
        scrollDown();
      },
      fail(message) {
        el.classList.remove("running");
        el.classList.add("failed");
        el.querySelector(".ai-compaction-head").innerHTML = `<b>Compaction failed</b>`;
        el.querySelector(".ai-compaction-body").textContent = `${message} Continuing with the full transcript.`;
      },
      remove() { el.remove(); },
    };
  }

  function renderCompactionCard(el, note, summary) {
    el.innerHTML =
      `<button class="ai-compaction-head" type="button">
         <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 12h6"/></svg>
         <b>Context compacted</b>
         <svg class="ai-tool-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
       </button>
       <p class="ai-compaction-body"></p>
       <div class="ai-compaction-summary md"></div>`;
    el.querySelector(".ai-compaction-body").textContent = note || "";
    el.querySelector(".ai-compaction-summary").innerHTML = renderMarkdown(summary || "");
    el.querySelector(".ai-compaction-head").addEventListener("click", () => el.classList.toggle("open"));
  }

  function addCompletedCompaction(note, summary) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-compaction done";
    renderCompactionCard(el, note, summary);
    $("aiMessages").appendChild(el);
  }

  // ---- permission prompt ---------------------------------------------------
  // The agent proposes a concrete side effect; the user decides. The promise
  // resolves with the scope so the broker can remember a conversation-wide
  // approval, and resolves to "deny" if the run is stopped while waiting.
  function requestPermission({ capability, meta, request }, signal) {
    clearEmpty();
    return new Promise((resolve) => {
      let settled = false;
      const el = document.createElement("div");
      el.className = "ai-permission";
      el.dataset.risk = request?.risk || "normal";
      el.innerHTML =
        `<div class="ai-permission-head">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 4.4 3.4 8.4 8 9 4.6-.6 8-4.6 8-9V6l-8-3Z"/></svg>
           <b class="ai-permission-title"></b>
           <span class="ai-permission-cap"></span>
         </div>
         <ul class="ai-permission-details"></ul>
         <div class="ai-permission-actions">
           <button type="button" data-choice="once">Allow once</button>
           <button type="button" data-choice="conversation">Allow for this chat</button>
           <button type="button" data-choice="deny">Deny</button>
         </div>`;
      el.querySelector(".ai-permission-title").textContent = request?.title || meta?.label || capability;
      el.querySelector(".ai-permission-cap").textContent = meta?.label || capability;
      const list = el.querySelector(".ai-permission-details");
      for (const detail of request?.details || []) {
        const item = document.createElement("li");
        item.textContent = detail;
        list.appendChild(item);
      }
      const settle = (choice) => {
        if (settled) return;
        settled = true;
        el.classList.add("resolved");
        el.dataset.choice = choice;
        el.querySelector(".ai-permission-actions").innerHTML =
          `<span class="ai-permission-outcome">${choice === "deny" ? "Denied" : choice === "conversation" ? "Allowed for this conversation" : "Allowed once"}</span>`;
        resolve(choice);
      };
      el.querySelectorAll("[data-choice]").forEach((button) => {
        button.addEventListener("click", () => settle(button.dataset.choice));
      });
      signal?.addEventListener?.("abort", () => settle("deny"), { once: true });
      $("aiMessages").appendChild(el);
      scrollDown(true);
      setStatus("busy", "Waiting for your approval");
    });
  }

  function appendStepLimitNotice(maxTurns) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "ai-limit-card";
    el.innerHTML =
      `<b>Paused at step limit</b>
       <p>${Number(maxTurns) || DEFAULT_MAX_TURNS} steps used. Continue keeps the same context.</p>
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
      if (item.kind === "user") appendUserMessage(item.text, item.attachments);
      else if (item.kind === "assistant") addAssistantMessage(item.text);
      else if (item.kind === "tool") addCompletedTool(item.name, item.args, item.outcome);
      else if (item.kind === "compaction") addCompletedCompaction(item.text, item.summary);
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
      contextWindow: cfg.contextWindow,
      autoCompact: cfg.autoCompact,
      permissionMode: cfg.permissionMode,
      skills: cfg.skills,
      storage: "localStorage+IndexedDB+sessionStorage",
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
  if ($("aiContextWindow")) {
    $("aiContextWindow").min = String(MIN_CONTEXT_WINDOW);
    $("aiContextWindow").max = String(MAX_CONTEXT_WINDOW);
    $("aiContextWindow").value = String(normalizeContextWindow(saved.contextWindow ?? DEFAULT_CONTEXT_WINDOW));
  }
  if ($("aiAutoCompact")) $("aiAutoCompact").checked = saved.autoCompact !== false;
  // Only an explicit "manual" pins the value. Inferring it from the presence of a
  // saved contextWindow would pin EVERY existing user forever — the field is
  // written on every save, so detection could never take over.
  contextSource = saved.contextWindowSource === "manual" ? "manual"
    : (saved.contextWindowSource || "default");
  renderContextSource();
  if ($("aiPermissionMode")) {
    $("aiPermissionMode").value = PERMISSION_MODES.includes(saved.permissionMode)
      ? saved.permissionMode : DEFAULT_PERMISSION_MODE;
  }
  syncModeChip();
  skills.hydrate(saved.enabledSkills, Array.isArray(saved.enabledSkills));
  const savedModel = saved.model || DEFAULT_AI_MODEL;
  setModelSelection(LEGACY_DEFAULT_AI_MODELS.has(savedModel) ? DEFAULT_AI_MODEL : savedModel);
  setDrawerWidth(saved.drawerWidth || 468);
  syncCustomField();
  const configured = !!(saved.baseUrl && saved.apiKey);
  setStatus(configured ? "ok" : "", configured ? "Ready" : "Not connected");
  syncBar();
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
  $("aiModelSelect").addEventListener("change", () => {
    syncCustomField();
    applyDetectedContextWindow();
    saveSettings();
  });
  $("aiCustomModel").addEventListener("input", saveSettings);
  $("aiContextWindow")?.addEventListener("change", () => {
    contextSource = "manual";
    renderContextSource();
    saveSettings();
    handlers.onContextSettingsChange?.();
  });
  $("aiAutoCompact")?.addEventListener("change", () => saveSettings());
  $("aiPermissionSeg")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (button) setPermissionMode(button.dataset.value);
  });
  $("aiModeChip")?.addEventListener("click", cycleMode);
  $("aiModelChip")?.addEventListener("click", () => setConfigOpen(true));
  $("aiSkillsChip")?.addEventListener("click", () => setConfigOpen(true));
  $("aiContextMeter")?.addEventListener("click", () => toggleContextPanel());
  $("aiContextClose")?.addEventListener("click", () => toggleContextPanel(false));
  $("aiContextCompactBtn")?.addEventListener("click", () => { toggleContextPanel(false); handlers.onCompact?.(); });
  $("aiContextConfigBtn")?.addEventListener("click", () => { toggleContextPanel(false); setConfigOpen(true); });
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

  // ---- composer file attachments (button + drag/drop) ----
  const attachInput = $("aiAttachInput");
  $("aiAttachBtn")?.addEventListener("click", () => attachInput?.click());
  attachInput?.addEventListener("change", () => {
    if (attachInput.files?.length) handlers.onAttachFiles?.(attachInput.files);
    attachInput.value = "";
  });
  const drawer = $("aiDrawer");
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  // stopPropagation isolates the drawer from the app's window-level EEG file
  // loader (main.js) — a label CSV dropped here must attach, never load as a
  // recording.
  drawer?.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); dragDepth++; drawer.classList.add("dropping"); });
  drawer?.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); });
  drawer?.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; e.stopPropagation(); if (--dragDepth <= 0) { dragDepth = 0; drawer.classList.remove("dropping"); } });
  drawer?.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); dragDepth = 0; drawer.classList.remove("dropping");
    if (e.dataTransfer.files?.length) handlers.onAttachFiles?.(e.dataTransfer.files);
  });
  $("aiAttachments")?.addEventListener("click", (e) => {
    const remove = e.target.closest("[data-remove]");
    if (remove) handlers.onRemoveAttachment?.(remove.dataset.remove);
  });

  msgsEl().addEventListener("scroll", () => { pinned = nearBottom(); updateJump(); });
  $("aiJump")?.addEventListener("click", () => { pinned = true; scrollDown(true); });
  skills.load();

  return {
    appendUserMessage, beginAssistant, beginToolCard, appendNote, appendError, resetMessages,
    renderConversation, renderHistory, closeHistory, focusInput,
    appendStepLimitNotice, renderAttachments: renderComposerAttachments,
    setBusy, setStatus, setOpen, saveSettings, getConfig, getPublicConfig,
    setContextUsage, beginCompaction, requestPermission, learnContextWindow,
    refreshSkills: async (options) => { const r = await skills.load(options); syncSkillsChip(); return r; },
    clearInput: () => { $("aiInput").value = ""; },
  };
}

// ---- composer attachment chips ------------------------------------------
const ATTACH_KIND_LABEL = { csv: "CSV", tsv: "TSV", json: "JSON", annot: "ANNOT", text: "TXT" };
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function renderComposerAttachments(list) {
  const wrap = document.getElementById("aiAttachments");
  if (!wrap) return;
  const items = Array.isArray(list) ? list : [];
  wrap.classList.toggle("show", items.length > 0);
  wrap.innerHTML = "";
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = `ai-attach-chip ${item.status || "ready"}`;
    if (item.error) chip.title = item.error;
    const busy = item.status === "reading" || item.status === "uploading";
    const kind = ATTACH_KIND_LABEL[item.kind] || (item.status === "error" ? "!" : "•");
    const meta = item.status === "error" ? "failed"
      : item.status === "ready" ? formatBytes(item.sizeBytes)
      : (item.status === "uploading" ? "uploading…" : "reading…");
    chip.innerHTML = `
      <span class="ai-attach-kind">${busy ? '<span class="ai-spinner"></span>' : escapeAttachText(kind)}</span>
      <span class="ai-attach-name">${escapeAttachText(item.name || "file")}</span>
      <span class="ai-attach-meta">${escapeAttachText(meta)}</span>
      <button type="button" class="ai-attach-x" data-remove="${escapeAttachText(item.id || item.name || "")}" title="Remove" aria-label="Remove attachment">×</button>`;
    wrap.appendChild(chip);
  }
}
function appendMessageAttachments(container, list) {
  const files = Array.isArray(list) ? list.filter((item) => item?.name) : [];
  if (!files.length) return;
  const wrap = document.createElement("div");
  wrap.className = "ai-msg-files";
  for (const item of files) {
    const chip = document.createElement("span");
    chip.className = "ai-msg-file";
    const kind = document.createElement("span");
    kind.className = "ai-attach-kind";
    kind.textContent = ATTACH_KIND_LABEL[item.kind] || "FILE";
    const name = document.createElement("span");
    name.className = "ai-attach-name";
    name.textContent = item.name || "file";
    const meta = document.createElement("span");
    meta.className = "ai-attach-meta";
    meta.textContent = formatBytes(item.sizeBytes);
    chip.append(kind, name, meta);
    wrap.appendChild(chip);
  }
  container.appendChild(wrap);
}
function escapeAttachText(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
