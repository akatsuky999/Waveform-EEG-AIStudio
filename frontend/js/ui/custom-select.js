// custom-select.js — progressively enhance native <select> elements into the
// app's warm clay dropdown (the same .dd-* aesthetic as the normalization menu),
// so no OS-styled menus appear anywhere.
//
// The native <select> stays the single source of truth: every existing
// `addEventListener("change")` and `.value` read keeps working. We only render a
// styled trigger + popover, mirror the options (including <optgroup>s), and:
//   - dispatch `input`+`change` when the user picks, so existing wiring fires;
//   - intercept programmatic `.value =` writes (controls/agent sync) so the label
//     stays correct without each caller knowing about the enhancement;
//   - rebuild the menu when options change (e.g. the agent's model list refresh);
//   - position the menu `fixed` so it escapes scrollable panels.

const CHEV = '<svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

export function enhanceSelect(select) {
  if (!select || select.dataset.csEnhanced || select.multiple) return;
  select.dataset.csEnhanced = "1";

  const wrap = document.createElement("div");
  wrap.className = "cs";
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("cs-native");
  select.setAttribute("tabindex", "-1");
  select.setAttribute("aria-hidden", "true");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dd-trigger cs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="cs-label"></span>${CHEV}`;
  const labelEl = trigger.querySelector(".cs-label");

  const menu = document.createElement("div");
  menu.className = "cs-menu";
  menu.setAttribute("role", "listbox");
  wrap.append(trigger, menu);

  const currentLabel = () => select.options[select.selectedIndex]?.textContent || "";

  function makeItem(option) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dd-item cs-item";
    item.setAttribute("role", "option");
    item.textContent = option.textContent;
    item.dataset.value = option.value;
    item.disabled = option.disabled;
    item.classList.toggle("active", option.value === select.value);
    item.setAttribute("aria-selected", String(option.value === select.value));
    item.addEventListener("click", () => choose(option.value));
    return item;
  }

  function rebuild() {
    menu.innerHTML = "";
    for (const node of select.children) {
      if (node.tagName === "OPTGROUP") {
        const heading = document.createElement("div");
        heading.className = "cs-group";
        heading.textContent = node.label;
        menu.appendChild(heading);
        for (const option of node.children) if (option.tagName === "OPTION") menu.appendChild(makeItem(option));
      } else if (node.tagName === "OPTION") {
        menu.appendChild(makeItem(node));
      }
    }
    labelEl.textContent = currentLabel();
  }

  function syncActive() {
    labelEl.textContent = currentLabel();
    menu.querySelectorAll(".cs-item").forEach((item) => {
      const on = item.dataset.value === select.value;
      item.classList.toggle("active", on);
      item.setAttribute("aria-selected", String(on));
    });
  }

  function choose(value) {
    if (select.value !== value) {
      select.value = value; // triggers syncActive via the intercepted setter below
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
    trigger.focus();
  }

  function place() {
    const r = trigger.getBoundingClientRect();
    menu.style.minWidth = `${r.width}px`;
    menu.style.maxWidth = `${Math.max(r.width, Math.min(360, window.innerWidth - 24))}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    const below = window.innerHeight - r.bottom;
    const need = Math.min(menu.offsetHeight, 320) + 8;
    if (below < need && r.top > below) {
      menu.style.top = "auto";
      menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    } else {
      menu.style.bottom = "auto";
      menu.style.top = `${r.bottom + 6}px`;
    }
  }

  let open = false;
  const reposition = () => { if (open) place(); };
  function setOpen(next) {
    open = next;
    menu.classList.toggle("open", next);
    trigger.classList.toggle("open", next);
    trigger.setAttribute("aria-expanded", String(next));
    if (next) {
      place();
      menu.querySelector(".cs-item.active")?.scrollIntoView({ block: "nearest" });
      window.addEventListener("scroll", reposition, true);
      window.addEventListener("resize", reposition);
    } else {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    }
  }
  const close = () => setOpen(false);

  trigger.addEventListener("click", (event) => { event.stopPropagation(); setOpen(!open); });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") { event.preventDefault(); setOpen(true); menu.querySelector(".cs-item")?.focus?.(); }
    else if (event.key === "Escape") close();
  });
  menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { close(); trigger.focus(); } });
  document.addEventListener("click", (event) => { if (!wrap.contains(event.target)) close(); });

  // Keep the trigger label correct when code sets `select.value` directly.
  Object.defineProperty(select, "value", {
    configurable: true,
    get() { return NATIVE_VALUE.get.call(this); },
    set(v) { NATIVE_VALUE.set.call(this, v); syncActive(); },
  });
  select.addEventListener("change", syncActive);
  new MutationObserver(() => rebuild()).observe(select, { childList: true, subtree: true });

  rebuild();
}

export function enhanceAll(root = document) {
  root.querySelectorAll("select:not([data-cs-enhanced]):not([data-no-enhance])").forEach(enhanceSelect);
}
