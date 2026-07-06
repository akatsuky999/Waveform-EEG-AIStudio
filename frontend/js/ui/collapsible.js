// Collapsible "module cards" for the Signal workspace + Output workbench panels.
//
// Mechanics: the resting open/closed state is a plain `hidden` attribute on
// `.ws-body` (display:none — bulletproof in every browser, nothing can bleed out
// of a collapsed card), with a measured WAAPI height tween between the two states.
// No overflow clipping remains once a section is open, so absolutely-positioned
// menus inside (e.g. the normalization dropdown) escape the card freely.
//
// Open/closed is remembered per section in localStorage; a section's default
// (when nothing is stored) comes from `data-ws-default="collapsed"`. Headers carry
// a compact live readout (`[data-ws-meta]`) so a collapsed module still tells you
// what it is set to.

import { $ } from "../core/util.js";

const KEY = "waveform.ws.collapsed";
const DURATION = 220;
const EASE = "cubic-bezier(.33, 0, .2, 1)";

function readState() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; }
  catch { return {}; }
}
function writeState(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { /* storage can be blocked in private contexts */ }
}

// ---- at-a-glance header readouts (read-only DOM lookups) ---------------------
const text = (id) => ($(id)?.textContent || "").trim();

const MONTAGE_SHORT = {
  raw: "Raw", bipolar: "Bipolar", car: "CAR", "group-car": "Group CAR", local: "Local",
};

function displayMeta() {
  const gain = text("gainVal");
  const montage = MONTAGE_SHORT[$("montageMode")?.value] || "";
  return [gain, montage].filter(Boolean).join(" · ");
}
function filterMeta() {
  const low = parseFloat($("filterLow")?.value) || 0;
  const high = parseFloat($("filterHigh")?.value) || 0;
  const notch = $("filterNotch")?.value;
  const parts = [];
  if (low > 0 || high > 0) parts.push(`${low > 0 ? low : 0}–${high > 0 ? high : "∞"} Hz`);
  if (notch === "50" || notch === "60") parts.push(`${notch} Hz`);
  return parts.join(" · ") || "Off";
}
function transformMeta() {
  const norm = text("normCurrent") || "Raw";
  const active = document.querySelector("#diffSeg button.active");
  const diff = active && active.dataset.n !== "0" ? active.textContent.trim() : "";
  return diff ? `${norm} · ${diff}` : norm;
}
function imageMeta() {
  const w = ($("imageWidth")?.value || "").trim();
  const h = ($("imageHeight")?.value || "").trim();
  const ratio = text("imageRatioLabel");
  return w && h ? `${w}×${h}${ratio ? ` · ${ratio}` : ""}` : "";
}
function providerMeta() {
  const select = $("aiModelSelect");
  return select?.value === "__custom__"
    ? ($("aiCustomModel")?.value || "").trim()
    : (select?.options?.[select.selectedIndex]?.textContent || "").trim();
}
function runtimeMeta() {
  const steps = ($("aiMaxTurns")?.value || "").trim();
  const imgs = ($("aiMaxAgentImages")?.value || "").trim();
  return [steps && `${steps} steps`, imgs && `${imgs} img`].filter(Boolean).join(" · ");
}

const META = {
  display: displayMeta, filters: filterMeta, transform: transformMeta, image: imageMeta,
  provider: providerMeta, runtime: runtimeMeta,
};
const COUNT = {
  events: () => {
    const rows = document.querySelectorAll("#markerList .marker-row").length;
    return rows ? String(rows) : "";
  },
  skills: () => {
    const rows = document.querySelectorAll("#aiSkillList .ai-skill-row").length;
    if (!rows) return "";
    const on = document.querySelectorAll('#aiSkillList .ai-skill-row input[type="checkbox"]:checked').length;
    return `${on}/${rows}`;
  },
};

function refreshSection(section) {
  const id = section.dataset.wsSection;
  const meta = section.querySelector("[data-ws-meta]");
  if (meta && META[id]) meta.textContent = META[id]();
  const count = section.querySelector("[data-ws-count]");
  if (count && COUNT[id]) count.textContent = COUNT[id]();
}

let sections = [];

export function refreshWsMeta() {
  sections.forEach(refreshSection);
}

// ---- collapse mechanics -------------------------------------------------------
// Every call takes an op token; stale animation callbacks (finish events are
// dispatched async, so a rapid collapse→expand can see the collapse's finish fire
// AFTER the expand) validate the token and no-op. A wall-clock settle timer forces
// the resting state even if rendering frames are throttled (occluded tab).
function setCollapsed(section, collapsed, { animate = true, onExpand } = {}) {
  const body = section.querySelector(".ws-body");
  const toggle = section.querySelector(".ws-toggle");
  if (!body) return;

  const op = (body._wsOp = (body._wsOp || 0) + 1);
  const midHeight = body.hidden ? 0 : body.offsetHeight; // measured before cancel → mid-flight on reversal
  body.getAnimations().forEach((animation) => animation.cancel());
  if (body._wsSettle) { clearTimeout(body._wsSettle); body._wsSettle = null; }

  section.classList.toggle("collapsed", collapsed);
  toggle?.setAttribute("aria-expanded", String(!collapsed));

  const settle = () => {
    if (body._wsOp !== op) return;
    body.hidden = collapsed;
    body.style.overflow = "";
    body._wsSettle = null;
  };

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduced) {
    settle();
    if (!collapsed) onExpand?.();
    return;
  }

  if (!collapsed) {
    body.hidden = false;
    onExpand?.(); // canvases re-measure at natural layout before the tween starts
  }
  const endHeight = collapsed ? 0 : body.offsetHeight;
  body.style.overflow = "hidden";
  const tween = body.animate(
    [{ height: `${midHeight}px` }, { height: `${endHeight}px` }],
    { duration: DURATION, easing: EASE },
  );
  tween.onfinish = settle;
  tween.oncancel = () => { if (body._wsOp === op) body.style.overflow = ""; };
  body._wsSettle = setTimeout(settle, DURATION + 130);
}

export function initCollapsibles({ onExpand } = {}) {
  const state = readState();
  sections = [...document.querySelectorAll(".ws-section[data-ws-section]")];

  sections.forEach((section) => {
    const id = section.dataset.wsSection;
    const toggle = section.querySelector(".ws-toggle");
    if (!toggle) return;

    const collapsed = id in state ? !!state[id] : section.dataset.wsDefault === "collapsed";
    setCollapsed(section, collapsed, { animate: false });

    toggle.addEventListener("click", () => {
      const next = !section.classList.contains("collapsed");
      setCollapsed(section, next, { onExpand: () => onExpand?.(id) });
      state[id] = next;
      writeState(state);
      refreshSection(section);
    });

    // keep the header readout fresh as this section's own controls change
    section.addEventListener("input", () => refreshSection(section));
    section.addEventListener("change", () => refreshSection(section));
    section.addEventListener("click", (event) => {
      if (event.target.closest(".ws-toggle")) return;
      refreshSection(section);
    });

    refreshSection(section);
  });

  // event / skill rows are re-rendered wholesale, and the agent hydrates its
  // model list async — observe them so header readouts stay live without events
  if ("MutationObserver" in window) {
    for (const id of ["markerList", "aiSkillList", "aiModelSelect"]) {
      const host = $(id);
      if (host) new MutationObserver(() => refreshWsMeta()).observe(host, { childList: true, subtree: true });
    }
  }
}
