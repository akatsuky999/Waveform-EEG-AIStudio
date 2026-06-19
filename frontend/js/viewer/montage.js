// montage.js — re-reference the channel set into clinical montages.
// Each builder returns { channels: Float32Array[], meta: [] }.

export function buildMontage(channels, meta, mode) {
  if (mode === "bipolar") return buildBipolarMontage(channels, meta);
  if (mode === "car") return buildAverageReference(channels, meta, "all");
  if (mode === "group-car") return buildAverageReference(channels, meta, "group");
  if (mode === "local") return buildLocalReference(channels, meta);
  return { channels, meta };
}

export function montageLabel(mode) {
  return ({
    bipolar: "bipolar",
    car: "common avg",
    "group-car": "group avg",
    local: "local ref",
  })[mode] || "";
}

function buildBipolarMontage(channels, meta) {
  const out = [], outMeta = [];
  for (let i = 0; i < channels.length - 1; i++) {
    const a = meta[i], b = meta[i + 1];
    if (!a || !b || a.group !== b.group) continue;
    const n = Math.min(channels[i].length, channels[i + 1].length);
    const sig = new Float32Array(n);
    for (let j = 0; j < n; j++) sig[j] = channels[i][j] - channels[i + 1][j];
    out.push(sig);
    outMeta.push({
      ...a,
      label: `${a.label}-${b.label}`,
      montage: "bipolar",
      sourceIndex: i,
      sourcePair: [a.label, b.label],
    });
  }
  return { channels: out, meta: outMeta };
}

function buildAverageReference(channels, meta, scope) {
  const groups = scope === "group"
    ? groupIndices(meta, (m) => m.group)
    : [channels.map((_ch, i) => i)];
  const out = new Array(channels.length);
  const outMeta = meta.map((m) => ({
    ...m,
    label: `${m.label}-${scope === "group" ? "GAR" : "CAR"}`,
    montage: scope === "group" ? "group-average-reference" : "common-average-reference",
  }));

  for (const indices of groups) {
    if (!indices.length) continue;
    const n = channels[indices[0]].length;
    const avg = new Float32Array(n);
    for (const idx of indices) {
      const ch = channels[idx];
      for (let i = 0; i < n; i++) avg[i] += ch[i];
    }
    for (let i = 0; i < n; i++) avg[i] /= indices.length;
    for (const idx of indices) {
      const ch = channels[idx];
      const sig = new Float32Array(n);
      for (let i = 0; i < n; i++) sig[i] = ch[i] - avg[i];
      out[idx] = sig;
    }
  }
  return { channels: out, meta: outMeta };
}

function buildLocalReference(channels, meta) {
  const out = [], outMeta = [];
  for (let i = 0; i < channels.length; i++) {
    const neighbors = [];
    if (i > 0 && meta[i - 1]?.group === meta[i].group) neighbors.push(i - 1);
    if (i + 1 < channels.length && meta[i + 1]?.group === meta[i].group) neighbors.push(i + 1);
    if (!neighbors.length) continue;

    const n = channels[i].length;
    const sig = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      let ref = 0;
      for (const idx of neighbors) ref += channels[idx][j];
      sig[j] = channels[i][j] - ref / neighbors.length;
    }
    out.push(sig);
    outMeta.push({
      ...meta[i],
      label: `${meta[i].label}-LAP`,
      montage: "local-neighbor-reference",
      sourceIndex: i,
      sourceNeighbors: neighbors.map((idx) => meta[idx].label),
    });
  }
  return { channels: out, meta: outMeta };
}

function groupIndices(items, keyFn) {
  const groups = new Map();
  items.forEach((item, i) => {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  return [...groups.values()];
}
