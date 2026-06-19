import { $ } from "../core/util.js";

const ACTIVE_KEY = "waveform.sidebar.active";
const WIDTH_KEY = "waveform.sidebar.width";
const MIN_WIDTH = 250;
const MAX_WIDTH = 520;

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

  function setWidth(value, persist = false) {
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(value) || 294));
    document.documentElement.style.setProperty("--sidebar-panel-w", `${width}px`);
    if (persist) writeSetting(WIDTH_KEY, String(Math.round(width)));
    requestAnimationFrame(() => onResize?.());
  }

  buttons.forEach((button) => button.addEventListener("click", () => setActive(button.dataset.sidebarModule)));
  setWidth(readSetting(WIDTH_KEY, 294));
  setActive(active);

  let startX = 0;
  let startWidth = 0;
  const onMove = (event) => setWidth(startWidth + event.clientX - startX);
  const onUp = () => {
    shell.classList.remove("resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    setWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-panel-w")), true);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (matchMedia("(max-width: 860px)").matches) return;
    event.preventDefault();
    startX = event.clientX;
    startWidth = $("sidebarPanel").getBoundingClientRect().width;
    shell.classList.add("resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  return { setActive, setWidth, get active() { return active; } };
}
