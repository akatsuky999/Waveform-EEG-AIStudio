import { $ } from "../core/util.js";

const ACTIVE_KEY = "waveform.sidebar.active";
const WIDTH_KEY = "waveform.sidebar.width";
const MIN_WIDTH = 250;
const MAX_WIDTH = 520;
// The waveform is the point of the app: never let a panel drag squeeze it away.
const MIN_STAGE_WIDTH = 340;
const ACTIVITY_BAR_WIDTH = 46;

// Read the drawer's declared width, not its measured box: a rect read while the
// browser has layout throttled (background tab, mid-transition) comes back wrong
// and would clamp the sidebar to a width the user never asked for.
function drawerWidth() {
  const drawer = document.getElementById("aiDrawer");
  if (!drawer || drawer.classList.contains("hidden")) return 0;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ai-drawer-w")) || 468;
}

/** The widest the panel may be right now, given the stage and the agent drawer. */
function availableMax() {
  const room = window.innerWidth - ACTIVITY_BAR_WIDTH - drawerWidth() - MIN_STAGE_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, room));
}

function readSetting(key, fallback = "") {
  try { return localStorage.getItem(key) || fallback; }
  catch { return fallback; }
}

function writeSetting(key, value) {
  try { localStorage.setItem(key, value); }
  catch { /* storage can be blocked in private contexts */ }
}

export function initSidebar({ onResize } = {}) {
  const shell = $("workspaceSidebar");
  const handle = $("sidebarResizer");
  const buttons = [...document.querySelectorAll("[data-sidebar-module]")];
  const panels = [...document.querySelectorAll("[data-sidebar-panel]")];
  const registered = new Map(panels.map((panel) => [panel.dataset.sidebarPanel, panel]));
  let active = readSetting(ACTIVE_KEY, "explorer");
  if (!registered.has(active)) active = "explorer";

  function setActive(name) {
    if (!registered.has(name)) return;
    active = name;
    buttons.forEach((button) => {
      const selected = button.dataset.sidebarModule === name;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.sidebarPanel === name));
    writeSetting(ACTIVE_KEY, name);
    requestAnimationFrame(() => onResize?.());
  }

  function currentWidth() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-panel-w")) || 294;
  }

  function setWidth(value, persist = false) {
    const width = Math.max(MIN_WIDTH, Math.min(availableMax(), Number(value) || 294));
    document.documentElement.style.setProperty("--sidebar-panel-w", `${width}px`);
    if (persist) writeSetting(WIDTH_KEY, String(Math.round(width)));
    requestAnimationFrame(() => onResize?.());
  }

  // Opening the drawer or shrinking the window changes what "too wide" means, so
  // re-clamp instead of leaving the stage crushed. The stored preference is left
  // alone: widen the window again and the panel returns to the width you chose.
  function reclamp() {
    const wanted = Number(readSetting(WIDTH_KEY, 294)) || 294;
    const width = Math.max(MIN_WIDTH, Math.min(availableMax(), Math.max(currentWidth(), 0) || wanted));
    const target = Math.min(Math.max(wanted, MIN_WIDTH), availableMax());
    if (Math.abs(target - currentWidth()) > 0.5) setWidth(target);
    else if (Math.abs(width - currentWidth()) > 0.5) setWidth(width);
  }

  buttons.forEach((button) => button.addEventListener("click", () => setActive(button.dataset.sidebarModule)));
  setWidth(readSetting(WIDTH_KEY, 294));
  setActive(active);

  let startX = 0;
  let startWidth = 0;
  let dragId = null;

  const onMove = (event) => {
    if (dragId !== null && event.pointerId !== dragId) return;
    setWidth(startWidth + event.clientX - startX);
  };
  // pointerup alone is not enough: a cancelled gesture (or a pointerup swallowed
  // by the WebGL canvas) used to leave the drag armed, so the panel kept
  // following the cursor with no button held. Capture the pointer and end on
  // cancel too.
  const endDrag = (event) => {
    if (dragId !== null && event?.pointerId !== undefined && event.pointerId !== dragId) return;
    if (dragId !== null) { try { handle.releasePointerCapture?.(dragId); } catch { /* already released */ } }
    dragId = null;
    shell.classList.remove("resizing");
    document.documentElement.classList.remove("is-resizing");
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);
    window.removeEventListener("blur", endDrag);
    setWidth(currentWidth(), true);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (matchMedia("(max-width: 860px)").matches) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    dragId = event.pointerId;
    startX = event.clientX;
    startWidth = currentWidth();          // the CSS var is the source of truth, not the rendered box
    shell.classList.add("resizing");
    document.documentElement.classList.add("is-resizing");
    // Wire the listeners FIRST: if capture throws (it can, e.g. when the pointer
    // is already gone) the drag must still be releasable, not stuck armed.
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* capture is an optimisation */ }
  });

  window.addEventListener("resize", reclamp);

  return { setActive, setWidth, reclamp, get active() { return active; } };
}
