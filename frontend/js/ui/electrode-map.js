// electrode-map.js — standard scalp coverage and label-derived contact atlas.
// Labels establish schematic sites or ordered groups, NOT patient anatomy,
// physical spacing or intracranial depth direction. Unknown channels stay visible.

const clean = (label) => String(label || "").trim();

/** Split `PoC2'7` into { stem: "PoC2'", n: 7 }; returns null when unnumbered. */
function splitContact(label) {
  const match = clean(label).match(/^(.*?)[\s_]*(\d{1,3})$/);
  if (!match || !match[1]) return null;
  return { stem: match[1], n: Number(match[2]) };
}

/**
 * A bipolar derivation (`PoC2'1-PoC2'2`, `Fp1-F7`) is not a contact — it is the
 * pair BETWEEN two of them, and that is how EEG draws it: a link along the
 * shank, or a chain across the scalp.
 */
function splitDerivation(label) {
  const parts = clean(label).split(/\s*[-–]\s*/);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { a: parts[0], b: parts[1] };
}

// Canonical positions on the unit circle used for the standard 10-20 projection:
// nose at -y, left at -x. Tiers matter for drawing — the "9/10" row lies BELOW
// the standard perimeter (inferior temporal), and sphenoidal / cerebellar
// electrodes are not surface positions at all.
const SCALP_POSITIONS = {
  // ---- standard 10-20 ----
  fp1: [-0.31, -0.81], fp2: [0.31, -0.81], fpz: [0, -0.86],
  af7: [-0.55, -0.66], af3: [-0.29, -0.62], afz: [0, -0.60], af4: [0.29, -0.62], af8: [0.55, -0.66],
  f7: [-0.72, -0.44], f5: [-0.58, -0.46], f3: [-0.38, -0.44], f1: [-0.19, -0.43],
  fz: [0, -0.42],
  f2: [0.19, -0.43], f4: [0.38, -0.44], f6: [0.58, -0.46], f8: [0.72, -0.44],
  ft7: [-0.83, -0.22], fc5: [-0.62, -0.22], fc3: [-0.42, -0.21], fc1: [-0.21, -0.21],
  fcz: [0, -0.21],
  fc2: [0.21, -0.21], fc4: [0.42, -0.21], fc6: [0.62, -0.22], ft8: [0.83, -0.22],
  t3: [-0.85, 0], t7: [-0.85, 0], c5: [-0.63, 0], c3: [-0.42, 0], c1: [-0.21, 0],
  cz: [0, 0],
  c2: [0.21, 0], c4: [0.42, 0], c6: [0.63, 0], t4: [0.85, 0], t8: [0.85, 0],
  tp7: [-0.83, 0.22], cp5: [-0.62, 0.22], cp3: [-0.42, 0.21], cp1: [-0.21, 0.21],
  cpz: [0, 0.21],
  cp2: [0.21, 0.21], cp4: [0.42, 0.21], cp6: [0.62, 0.22], tp8: [0.83, 0.22],
  t5: [-0.72, 0.44], p7: [-0.72, 0.44], p5: [-0.58, 0.46], p3: [-0.38, 0.44], p1: [-0.19, 0.43],
  pz: [0, 0.42],
  p2: [0.19, 0.43], p4: [0.38, 0.44], p6: [0.58, 0.46], t6: [0.72, 0.44], p8: [0.72, 0.44],
  po7: [-0.55, 0.66], po3: [-0.29, 0.62], poz: [0, 0.60], po4: [0.29, 0.62], po8: [0.55, 0.66],
  o1: [-0.31, 0.81], o2: [0.31, 0.81], oz: [0, 0.86],
};

// Positions that sit outside the standard perimeter or are not surface sites.
const SCALP_EXTRA = {
  // inferior temporal chain (10-10 "9/10" row) — routine in epilepsy monitoring
  f9: [-0.92, -0.56, "inferior"], f10: [0.92, -0.56, "inferior"],
  ft9: [-1.05, -0.28, "inferior"], ft10: [1.05, -0.28, "inferior"],
  t9: [-1.08, 0, "inferior"], t10: [1.08, 0, "inferior"],
  tp9: [-1.05, 0.28, "inferior"], tp10: [1.05, 0.28, "inferior"],
  p9: [-0.92, 0.56, "inferior"], p10: [0.92, 0.56, "inferior"],
  o9: [-0.42, 1.02, "inferior"], o10: [0.42, 1.02, "inferior"],
  // sphenoidal — inserted below the zygoma, not on the scalp
  sp1: [-0.70, -0.14, "deepsurface"], sp2: [0.70, -0.14, "deepsurface"],
  sph1: [-0.70, -0.14, "deepsurface"], sph2: [0.70, -0.14, "deepsurface"],
  // cerebellar row, a convention in many Chinese centres
  cb1: [-0.33, 1.10, "inferior"], cb2: [0.33, 1.10, "inferior"], cbz: [0, 1.14, "inferior"],
  // ears / mastoids
  a1: [-1.12, 0.04, "ear"], a2: [1.12, 0.04, "ear"],
  m1: [-1.05, 0.34, "ear"], m2: [1.05, 0.34, "ear"],
};

// Channels that are recorded alongside EEG but are not electrodes on the head.
const NON_EEG = /^(ekg|ecg|emg|eog|loc|roc|resp|pneumo|photic|spo2|sao2|pulse|hr|trigger|marker|event|annotation|status|dc\d*|bp|chin|leg\d*|snore|flow|thor|abdo|position|light|off|test)$/i;

// Reference tokens: `Fp1-Ref`, `Fp1-A1`, `EEG C3-LE` are MONOPOLAR recordings of
// one electrode, not a derivation between two — centres differ on which token
// they use, so the right-hand side decides.
// A1/A2/M1/M2 are real electrodes on their own, but on the RIGHT of a derivation
// they are the reference (`P4-A1` is monopolar P4), so they belong here too.
const REFERENCE_TOKEN = /^(ref|refe?rence|av|avg|average|car|le|linked|ears?|a1|a2|m1|m2|a1a2|m1m2|com|gnd|cm)$/i;

/**
 * Strip the packaging different centres put around the same electrode name:
 * `EEG Fp1-Ref` → `fp1`, `Fp1-A1` → `fp1`, `EEG_C3` → `c3`.
 */
function normalizeScalpName(label) {
  let text = clean(label);
  text = text.replace(/^\s*(eeg|ecog|seeg|ieeg)[\s._-]+/i, "");
  const parts = text.split(/\s*[-–]\s*/);
  if (parts.length === 2 && REFERENCE_TOKEN.test(parts[1].replace(/[^a-z0-9]/gi, ""))) {
    text = parts[0];
  }
  return text.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function scalpSite(label) {
  // A'1 is a depth-contact name, not the scalp/mastoid site A1.
  if (/['’′]/.test(label) || /^\s*(ecog|seeg|ieeg)[\s._-]+/i.test(label)) return null;
  const key = normalizeScalpName(label);
  if (!key || NON_EEG.test(key)) return null;
  if (SCALP_POSITIONS[key]) return { x: SCALP_POSITIONS[key][0], y: SCALP_POSITIONS[key][1], tier: "standard" };
  const extra = SCALP_EXTRA[key];
  if (extra) return { x: extra[0], y: extra[1], tier: extra[2] };
  return null;
}

/**
 * Read the electrode arrangement out of the channel labels.
 * @returns {{kind: "scalp"|"depth"|"none", shanks: Array, scalp: Array, unplaced: Array}}
 */
export function parseElectrodes(channelMeta = []) {
  const items = channelMeta.map((meta, index) => ({ index, label: clean(meta?.label),
    siteLabel: clean(meta?.label).replace(/-(CAR|GAR|LAP)$/i, "") }));

  const scalp = [];
  const chains = [];        // bipolar derivations drawn across the scalp
  const rest = [];
  for (const item of items) {
    const site = scalpSite(item.siteLabel);
    if (site) { scalp.push({ ...item, ...site }); continue; }
    const pair = splitDerivation(item.siteLabel);
    const from = pair && scalpSite(pair.a);
    const to = pair && scalpSite(pair.b);
    if (from && to) chains.push({ ...item, from: [from.x, from.y], to: [to.x, to.y] });
    else rest.push(item);
  }

  // Whatever is not on the head is examined for electrode shanks. A recording
  // may legitimately hold BOTH — scalp coverage plus implanted electrodes — so
  // the two are parsed independently and both are drawn.
  const byStem = new Map();
  const unplaced = [];
  for (const item of rest) {
    const pair = splitDerivation(item.siteLabel);
    const a = pair && splitContact(pair.a);
    const b = pair && splitContact(pair.b);
    if (a && b && a.stem === b.stem) {
      if (!byStem.has(a.stem)) byStem.set(a.stem, []);
      byStem.get(a.stem).push({ ...item, n: Math.min(a.n, b.n), span: Math.abs(b.n - a.n) || 1 });
      continue;
    }
    const parsed = splitContact(item.siteLabel);
    if (!parsed || NON_EEG.test(parsed.stem.replace(/[^a-z0-9]/gi, ""))) { unplaced.push(item); continue; }
    if (!byStem.has(parsed.stem)) byStem.set(parsed.stem, []);
    byStem.get(parsed.stem).push({ ...item, n: parsed.n, span: 0 });
  }
  const shanks = [];
  for (const [stem, contacts] of byStem) {
    // Three numbered labels suffice for a group display, not anatomical inference.
    if (contacts.length < 3) { unplaced.push(...contacts); continue; }
    contacts.sort((a, b) => a.n - b.n);
    shanks.push({ stem, contacts });
  }
  shanks.sort((a, b) => b.contacts.length - a.contacts.length || a.stem.localeCompare(b.stem));

  const hasScalp = scalp.length + chains.length >= 3;
  if (!hasScalp) unplaced.push(...scalp, ...chains);
  const hasDepth = shanks.length > 0;
  const kind = hasScalp && hasDepth ? "mixed" : hasScalp ? "scalp" : hasDepth ? "depth" : "none";
  return { kind, scalp: hasScalp ? scalp : [], chains: hasScalp ? chains : [], shanks, unplaced };
}

/** Normalise a per-channel value to 0..1 across the recording, robustly. */
function intensityScale(values) {
  const finite = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!finite.length) return () => 0;
  const lo = finite[Math.floor(finite.length * 0.05)];
  const hi = finite[Math.floor(finite.length * 0.95)] || finite[finite.length - 1];
  const span = hi - lo || 1;
  return (value) => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.min(1, (value - lo) / span));
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

function contactTitle(item, state) {
  const value = state.values[item.index];
  return `${item.label}${Number.isFinite(value) && value > 0 ? ` · ${value.toFixed(1)} source SD` : ""}`;
}

function contactNode({ x, y, r, item, level, state, onSelect }) {
  const group = el("g", { class: "em-contact", tabindex: "0", role: "button" });
  group.dataset.index = String(item.index);
  if (state.selected === item.index) group.classList.add("is-selected");
  if (state.hidden.has(item.index)) group.classList.add("is-hidden");
  group.setAttribute("aria-label", contactTitle(item, state));
  group.setAttribute("aria-pressed", String(state.selected === item.index));

  group.appendChild(el("circle", { cx: x, cy: y, r, class: "em-fill", "fill-opacity": (0.12 + level * 0.82).toFixed(3) }));
  group.appendChild(el("circle", { cx: x, cy: y, r, class: "em-ring" }));
  const title = el("title");
  title.textContent = contactTitle(item, state);
  group.appendChild(title);

  const activate = () => onSelect?.(item.index);
  group.addEventListener("click", activate);
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
  });
  return group;
}


function renderScalp(svg, layout, state, onSelect, width, offsetY = 0) {
  // The head is drawn the way an EEG report draws it: nasion up, inion down,
  // ears at the sides, dashed guides on the standard planes. Electrodes outside
  // the standard perimeter (the 9/10 inferior row, cerebellar) need the extra
  // radius, so the circle is inset inside the box.
  const box = Math.min(width, 300);
  const cx = width / 2;
  const R = (box / 2) * 0.72;
  const cy = offsetY + box / 2;
  const labelled = layout.scalp.length <= 40;
  const r = labelled ? Math.max(6, R * 0.08) : Math.max(3, R * 0.045);

  const head = el("g", { class: "em-head-group" });
  head.appendChild(el("circle", { cx, cy, r: R, class: "em-head" }));
  head.appendChild(el("path", {                                  // nose
    d: `M ${cx - R * 0.11} ${cy - R + 1.5} L ${cx} ${cy - R - R * 0.16} L ${cx + R * 0.11} ${cy - R + 1.5}`,
    class: "em-head",
  }));
  head.appendChild(el("path", { d: `M ${cx - R} ${cy - R * 0.13} q ${-R * 0.11} ${R * 0.13} 0 ${R * 0.26}`, class: "em-head" }));
  head.appendChild(el("path", { d: `M ${cx + R} ${cy - R * 0.13} q ${R * 0.11} ${R * 0.13} 0 ${R * 0.26}`, class: "em-head" }));
  // guides: the perimeter chain and the two standard planes
  head.appendChild(el("circle", { cx, cy, r: R * 0.81, class: "em-guide" }));
  head.appendChild(el("line", { x1: cx, y1: cy - R * 0.81, x2: cx, y2: cy + R * 0.81, class: "em-guide" }));
  head.appendChild(el("line", { x1: cx - R * 0.85, y1: cy, x2: cx + R * 0.85, y2: cy, class: "em-guide" }));
  svg.appendChild(head);

  const mark = (text, x, y, anchor = "middle") => {
    const node = el("text", { x, y, class: "em-fiducial", "text-anchor": anchor });
    node.textContent = text;
    svg.appendChild(node);
  };
  mark("NASION", cx, cy - R - R * 0.24);
  mark("INION", cx, cy + R + R * 0.30);
  mark("L", cx - R * 1.27, cy);
  mark("R", cx + R * 1.27, cy);

  for (const link of layout.chains || []) {
    const group = el("g", { class: "em-contact is-chain", tabindex: "0", role: "button" });
    group.dataset.index = String(link.index);
    if (state.selected === link.index) group.classList.add("is-selected");
    if (state.hidden.has(link.index)) group.classList.add("is-hidden");
    group.setAttribute("aria-label", contactTitle(link, state));
    group.setAttribute("aria-pressed", String(state.selected === link.index));
    const level = state.scale(state.values[link.index]);
    group.appendChild(el("line", {
      x1: cx + link.from[0] * R, y1: cy + link.from[1] * R,
      x2: cx + link.to[0] * R, y2: cy + link.to[1] * R,
      class: "em-link", "stroke-opacity": (0.22 + level * 0.7).toFixed(3),
    }));
    const title = el("title");
    title.textContent = contactTitle(link, state);
    group.appendChild(title);
    group.addEventListener("click", () => onSelect?.(link.index));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(link.index); }
    });
    svg.appendChild(group);
  }

  for (const item of layout.scalp) {
    const node = contactNode({
      x: cx + item.x * R, y: cy + item.y * R, r, item,
      level: state.scale(state.values[item.index]), state, onSelect,
    });
    node.classList.add(`tier-${item.tier}`);
    if (labelled) {
      const text = el("text", { x: cx + item.x * R, y: cy + item.y * R + 2.6, class: "em-site", "text-anchor": "middle" });
      text.textContent = item.siteLabel.replace(/^\s*eeg[\s._-]+/i, "").split(/[-–]/)[0].slice(0, 4);
      node.appendChild(text);
    }
    svg.appendChild(node);
  }
  return box;
}

/**
 * Draw the map into `container`. A recording may be scalp, depth, or both —
 * when both are present the head and the shanks are drawn together, because
 * that IS the study, and reading either half alone would misrepresent it.
 */
export function renderElectrodeMap(container, {
  channelMeta = [], values = [], selected = null, hidden = new Set(), onSelect,
} = {}) {
  if (!container) return null;
  container.innerHTML = "";
  const layout = parseElectrodes(channelMeta);
  container.classList.remove("hidden");

  const width = Math.max(180, container.clientWidth || 240);
  const state = {
    values, selected, hidden,
    scale: intensityScale(channelMeta.map((_m, i) => values[i])),
  };
  const parts = [];

  const heading = (title, note) => {
    const head = document.createElement("div"); head.className = "em-atlas-head";
    const strong = document.createElement("b"); strong.textContent = title;
    const small = document.createElement("span"); small.textContent = note;
    head.append(strong, small); container.appendChild(head);
  };
  const contacts = (items, numbered = false) => {
    const grid = document.createElement("div"); grid.className = numbered ? "em-contact-grid" : "em-unplaced-grid";
    for (const item of items) {
      const button = document.createElement("button"); button.type = "button";
      button.className = "em-contact-key";
      button.textContent = numbered ? (item.span ? `${item.n}–${item.n + item.span}` : String(item.n)) : item.label;
      button.title = contactTitle(item, state);
      button.setAttribute("aria-label", contactTitle(item, state));
      button.setAttribute("aria-pressed", String(selected === item.index));
      button.classList.toggle("is-hidden", hidden.has(item.index));
      button.style.setProperty("--contact-level", String(.05 + .2 * state.scale(values[item.index])));
      button.addEventListener("click", () => onSelect?.(item.index)); grid.appendChild(button);
    }
    return grid;
  };

  if (layout.scalp.length || layout.chains.length) {
    heading("Scalp coverage", "10–20 / 10–10 · standard schematic");
    const svg = el("svg", { class: "electrode-map em-scalp", width: "100%", xmlns: SVG_NS,
      role: "img", "aria-label": "Scalp electrode map" });
    const box = renderScalp(svg, layout, state, onSelect, width, 6);
    svg.setAttribute("viewBox", `0 0 ${width} ${box + 12}`);
    svg.setAttribute("height", box + 12);
    container.appendChild(svg);
    const regions = document.createElement("div"); regions.className = "em-region-key";
    regions.setAttribute("aria-label", "Scalp region nomenclature, not cortical localization");
    for (const [code, name] of [["Fp","Frontopolar"],["F","Frontal"],["C","Central"],["T","Temporal"],["P","Parietal"],["O","Occipital"]]) {
      const item = document.createElement("span");
      const key = document.createElement("b"); key.textContent = code;
      item.append(key, document.createTextNode(name)); regions.appendChild(item);
    }
    container.appendChild(regions);
    parts.push(`${layout.scalp.length || layout.chains.length} scalp ${layout.chains.length ? "derivations" : "electrodes"}`);
  }

  if (layout.shanks.length) {
    heading("Contact architecture", "Label groups · not anatomical coordinates");
    for (const shank of layout.shanks) {
      const card = document.createElement("section"); card.className = "em-shank-card";
      const head = document.createElement("div"); head.className = "em-shank-head";
      const name = document.createElement("b"); name.textContent = shank.stem.replace(/['’]$/, "′");
      const count = document.createElement("span"); count.textContent = `${shank.contacts.length} channels`;
      head.append(name, count); card.append(head, contacts(shank.contacts, true)); container.appendChild(card);
    }
    parts.push(`${layout.shanks.length} label groups`);
  }

  if (layout.unplaced.length) {
    heading("Other channels", "Location not established");
    container.appendChild(contacts(layout.unplaced));
  }

  const caption = document.createElement("p");
  caption.className = "em-caption";
  caption.textContent = channelMeta.length ? `${parts.join(" · ")}${parts.length ? ". " : ""}Select a contact to focus. Shading: relative source SD. No patient-specific localization inferred.` : "Load a recording to see its electrode coverage.";
  container.appendChild(caption);
  return layout;
}
