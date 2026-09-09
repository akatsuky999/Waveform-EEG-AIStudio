// channels.js — electrode-group legend, channel tools (search/sort/solo/pin/
import { renderElectrodeMap } from "./electrode-map.js";
// hide), analysis toggles, structured event editor, file metadata, channel summary.

import { $, escapeHtml } from "../core/util.js";
import { recordingReadout } from "./workspace-presentation.js";

const ATTR_LABELS = {
  edf_stem: "source", window_index: "window #", window_start_sec: "start (s)",
  window_dur_sec: "duration (s)", fs_target: "fs target", valid_samples: "valid samples",
  start: "start", patient: "patient", recording: "recording", equipment: "equipment",
  file_duration_sec: "file length (s)",
};

export function initChannels(ctx) {
  const viewer = ctx.viewer;

  // The electrode map is the primary channel affordance: geometry first, list
  // second. It redraws when the channel model changes (a montage rebuilds the
  // channel set) and when amplitudes are recomputed.
  function drawElectrodeMap() {
    if (!viewer.header) return;
    renderElectrodeMap($("electrodeMap"), {
      channelMeta: viewer.channelMeta,
      // channelStats holds spectral features; amplitude lives on channelMeta.std
      // (per-channel SD, which is what "how hot is this contact" means here).
      values: (viewer.channelMeta || []).map((meta) => Number(meta?.std) || 0),
      selected: viewer.selectedChannel,
      hidden: new Set((viewer.channelMeta || []).flatMap((meta, i) =>
        viewer.hiddenChannels?.has(i) || viewer.hiddenGroups?.has(meta.group) ? [i] : [])),
      onSelect: (index) => viewer.selectChannel(index, true),
    });
  }

  function buildLegend(header) {
    const counts = {};
    const metas = viewer.channelMeta.length ? viewer.channelMeta : header.channels;
    metas.forEach((c) => { counts[c.group] = (counts[c.group] || 0) + 1; });
    const wrap = $("legend"); wrap.innerHTML = "";
    Object.keys(counts).forEach((g) => {
      const color = viewer.groupColor.get(g);
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.group = g;
      row.setAttribute("aria-label", `Show group ${g}`);
      row.setAttribute("aria-pressed", String(!viewer.hiddenGroups.has(g)));
      row.className = "item";
      row.classList.toggle("off", viewer.hiddenGroups.has(g));
      row.innerHTML = `<span class="swatch" style="background:${color}"></span>` +
        `<span class="name">${escapeHtml(g)}</span><span class="count">${counts[g]}</span>`;
      row.addEventListener("click", () => { viewer.toggleGroup(g); });
      wrap.appendChild(row);
    });
  }

  function buildAttrs(header) {
    const info = recordingReadout(header);
    $("fileReadout").innerHTML = `<div class="ws-specimen-head"><span>Source recording</span><span>${escapeHtml(info.format)}</span></div>
      <b class="ws-file-name">${escapeHtml(info.file)}</b><div class="ws-file-stats">
      <div><span>${escapeHtml(info.channels)}</span><small>channels</small></div><div><span>${escapeHtml(info.rate)}</span><small>sample rate</small></div><div><span>${escapeHtml(info.duration)}</span><small>duration</small></div></div>`;
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
    if (!wrap.children.length) wrap.innerHTML = '<p class="ws-caption">No additional metadata supplied.</p>';
  }

  let focusedEventId = null;

  function renderEvents(events) {
    const wrap = $("markerList");
    if (!events.length) {
      wrap.innerHTML = `<div class="ws-empty-state"><svg viewBox="0 0 32 24" aria-hidden="true"><path d="M2 18h28M8 6v12m16-8v8M8 6h8v6H8"/><circle cx="24" cy="7" r="2"/></svg><b>No events yet</b><p>Use Drag events to mark an interval, or add a point from Interaction.</p></div>`;
      return;
    }
    wrap.innerHTML = "";
    events.forEach((event, index) => {
      const row = document.createElement("div");
      row.className = `marker-row${String(event.id) === String(focusedEventId) ? " editing" : ""}`;
      row.dataset.eventId = event.id;
      row.innerHTML = `
        <div class="event-main">
          <div class="ws-event-heading"><span class="ws-event-index">${String(index + 1).padStart(2, "0")}</span><span class="event-type">${escapeHtml(event.type)}</span></div>
          <input class="event-label" aria-label="Event label" value="${escapeHtml(event.label)}" />
          <div class="event-times">
            <label>ONSET<input class="event-onset" type="number" min="0" step="0.001" value="${event.onsetSec.toFixed(3)}" /></label>
            <label>OFFSET<input class="event-offset" type="number" min="0" step="0.001" placeholder="point" value="${event.offsetSec == null ? "" : event.offsetSec.toFixed(3)}" /></label>
          </div>
        </div>
        <button class="event-delete" data-id="${event.id}" title="Delete event" aria-label="Delete event ${escapeHtml(event.label)}">×</button>`;
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
    drawElectrodeMap();
    const parts = [`${state.visible}/${state.total} shown`];
    if (state.montage) parts.push(state.montageLabel || "montage");
    if (state.hidden) parts.push(`${state.hidden} hidden`);
    $("chCount").textContent = parts.join(" · ");
    $("soloBtn").setAttribute("aria-pressed", String(viewer.selectedChannel != null && viewer.soloChannel === viewer.selectedChannel));
    $("pinBtn").setAttribute("aria-pressed", String(viewer.selectedChannel != null && viewer.pinnedChannel === viewer.selectedChannel));
    $("legend").querySelectorAll("[data-group]").forEach((row) => {
      const visible = !viewer.hiddenGroups.has(row.dataset.group);
      row.classList.toggle("off", !visible);
      row.setAttribute("aria-pressed", String(visible));
    });
  }

  // ---- channel tools wiring ----
  let mapWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width > 0 && width !== mapWidth) { mapWidth = width; drawElectrodeMap(); }
  }).observe($("channelMapDetails"));
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

  ctx.buildLegend = (header) => { buildLegend(header); drawElectrodeMap(); };
  ctx.drawElectrodeMap = drawElectrodeMap;
  ctx.buildAttrs = buildAttrs;
  ctx.renderMarkers = () => renderEvents(viewer.events);
  ctx.renderEvents = renderEvents;
  ctx.focusEventEditor = focusEventEditor;
  ctx.updateChannelSummary = updateChannelSummary;
  return { buildLegend, buildAttrs, renderEvents, focusEventEditor, updateChannelSummary, drawElectrodeMap };
}
