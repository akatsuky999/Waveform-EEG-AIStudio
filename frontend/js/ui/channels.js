// channels.js — electrode-group legend, channel tools (search/sort/solo/pin/
// hide), analysis toggles, structured event editor, file metadata, channel summary.

import { $, escapeHtml } from "../core/util.js";

const ATTR_LABELS = {
  edf_stem: "source", window_index: "window #", window_start_sec: "start (s)",
  window_dur_sec: "duration (s)", fs_target: "fs target", valid_samples: "valid samples",
  start: "start", patient: "patient", recording: "recording", equipment: "equipment",
  file_duration_sec: "file length (s)",
};

export function initChannels(ctx) {
  const viewer = ctx.viewer;

  function buildLegend(header) {
    const counts = {};
    const metas = viewer.channelMeta.length ? viewer.channelMeta : header.channels;
    metas.forEach((c) => { counts[c.group] = (counts[c.group] || 0) + 1; });
    const wrap = $("legend"); wrap.innerHTML = "";
    Object.keys(counts).forEach((g) => {
      const color = viewer.groupColor.get(g);
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `<span class="swatch" style="background:${color}"></span>` +
        `<span class="name">${escapeHtml(g)}</span><span class="count">${counts[g]}</span>`;
      row.addEventListener("click", () => { viewer.toggleGroup(g); row.classList.toggle("off"); });
      wrap.appendChild(row);
    });
  }

  function buildAttrs(header) {
    const wrap = $("attrList"); wrap.innerHTML = "";
    const a = header.attrs || {};
    const keys = Object.keys(ATTR_LABELS).filter((k) => a[k] !== undefined && a[k] !== "");
    for (const k of Object.keys(a)) {
      if (keys.includes(k)) continue;
      if (typeof a[k] === "object") continue;
      keys.push(k);
    }
    keys.slice(0, 9).forEach((k) => {
      let v = a[k];
      if (typeof v === "number" && !Number.isInteger(v)) v = +v.toFixed(3);
      const row = document.createElement("div");
      row.className = "a";
      row.innerHTML = `<span>${escapeHtml(ATTR_LABELS[k] || k)}</span><span>${escapeHtml(String(v))}</span>`;
      wrap.appendChild(row);
    });
  }

  let focusedEventId = null;

  function renderEvents(events) {
    const wrap = $("markerList");
    if (!events.length) { wrap.innerHTML = `<span>No events yet</span>`; return; }
    wrap.innerHTML = "";
    events.forEach((event) => {
      const row = document.createElement("div");
      row.className = `marker-row${String(event.id) === String(focusedEventId) ? " editing" : ""}`;
      row.dataset.eventId = event.id;
      row.innerHTML = `
        <div class="event-main">
          <span class="event-type">${escapeHtml(event.type)}</span>
          <input class="event-label" aria-label="Event label" value="${escapeHtml(event.label)}" />
          <div class="event-times">
            <label>ONSET<input class="event-onset" type="number" min="0" step="0.001" value="${event.onsetSec.toFixed(3)}" /></label>
            <label>OFFSET<input class="event-offset" type="number" min="0" step="0.001" placeholder="point" value="${event.offsetSec == null ? "" : event.offsetSec.toFixed(3)}" /></label>
          </div>
        </div>
        <button class="event-delete" data-id="${event.id}" title="Delete event">×</button>`;
      const commit = () => viewer.updateEvent(event.id, {
        label: row.querySelector(".event-label").value,
        onsetSec: row.querySelector(".event-onset").value,
        offsetSec: row.querySelector(".event-offset").value,
        type: row.querySelector(".event-offset").value === "" ? "point" : "interval",
      });
      row.querySelectorAll("input").forEach((input) => {
        input.addEventListener("change", commit);
        input.addEventListener("keydown", (keyboardEvent) => {
          if (keyboardEvent.key === "Enter") { input.blur(); commit(); }
        });
      });
      row.querySelector(".event-delete").addEventListener("click", () => viewer.removeEvent(event.id));
      wrap.appendChild(row);
    });
    if (focusedEventId) {
      const row = [...wrap.children].find((node) => String(node.dataset.eventId) === String(focusedEventId));
      requestAnimationFrame(() => {
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        row?.querySelector(".event-label")?.focus();
        row?.querySelector(".event-label")?.select();
      });
      focusedEventId = null;
    }
  }

  function focusEventEditor(id) {
    focusedEventId = id;
    ctx.setSidebarActive?.("controls");
    renderEvents(viewer.events);
  }

  function updateChannelSummary(state) {
    if (!viewer.header) return;
    const parts = [`${state.visible}/${state.total} shown`];
    if (state.montage) parts.push(state.montageLabel || "montage");
    if (state.hidden) parts.push(`${state.hidden} hidden`);
    $("chCount").textContent = parts.join(" · ");
  }

  // ---- channel tools wiring ----
  $("channelSearch").addEventListener("input", (e) => viewer.setChannelSearch(e.target.value));
  $("channelSort").addEventListener("change", (e) => viewer.setChannelSort(e.target.value));
  $("soloBtn").addEventListener("click", () => viewer.toggleSoloSelected());
  $("pinBtn").addEventListener("click", () => viewer.togglePinSelected());
  $("hideBtn").addEventListener("click", () => viewer.hideSelected());
  $("clearFocusBtn").addEventListener("click", () => {
    viewer.clearChannelFocus();
    $("channelSearch").value = "";
    $("channelSort").value = "file";
  });

  $("measureToggle").addEventListener("change", (e) => {
    viewer.setMeasureMode(e.target.checked);
    if (e.target.checked) $("markerToggle").checked = false;
  });
  $("markerToggle").addEventListener("change", (e) => {
    viewer.setMarkerMode(e.target.checked);
    if (e.target.checked) $("measureToggle").checked = false;
  });
  $("addMarkerBtn").addEventListener("click", () => focusEventEditor(viewer.addMarker().id));

  ctx.buildLegend = buildLegend;
  ctx.buildAttrs = buildAttrs;
  ctx.renderMarkers = () => renderEvents(viewer.events);
  ctx.renderEvents = renderEvents;
  ctx.focusEventEditor = focusEventEditor;
  ctx.updateChannelSummary = updateChannelSummary;
  return { buildLegend, buildAttrs, renderEvents, focusEventEditor, updateChannelSummary };
}
