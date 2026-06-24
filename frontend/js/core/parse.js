// parse.js — decode the backend binary envelope + signal-processing helpers.

/**
 * Parse the binary envelope returned by /api/parse.
 *
 *   [uint32 LE header length][UTF-8 JSON header][float32 LE channel-major data]
 *
 * Returns { header, channels } where `channels` is an array of Float32Array,
 * one contiguous view per channel (zero-copy subarrays over one backing buffer).
 */
export function parseEnvelope(buffer) {
  const dv = new DataView(buffer);
  const headerLen = dv.getUint32(0, true);
  const headerBytes = new Uint8Array(buffer, 4, headerLen);
  const header = JSON.parse(new TextDecoder("utf-8").decode(headerBytes));

  const dataOffset = 4 + headerLen;
  const { nChannels, nSamples } = header;
  const flat = dataOffset % 4 === 0
    ? new Float32Array(buffer, dataOffset, nChannels * nSamples)
    : new Float32Array(buffer.slice(dataOffset, dataOffset + nChannels * nSamples * 4));

  const channels = [];
  for (let c = 0; c < nChannels; c++) {
    channels.push(flat.subarray(c * nSamples, (c + 1) * nSamples));
  }
  return { header, channels };
}

/**
 * Parse a windowed render tile from /api/signal/window.
 *
 *   [uint32 LE header length][UTF-8 JSON header][float32 LE payload]
 *
 * header.mode === "agg": payload is channel-major min/max columns —
 *   for channel c, column j: data[(c*nCols + j)*2 + 0]=min, +1=max.
 * header.mode === "raw": payload is channel-major raw samples —
 *   for channel c, sample i: data[c*nSamples + i].
 *
 * Returns { header, data } where data is one Float32Array over the payload.
 */
export function parseWindowTile(buffer) {
  const dv = new DataView(buffer);
  const headerLen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(buffer, 4, headerLen)));
  const dataOffset = 4 + headerLen;
  const data = dataOffset % 4 === 0
    ? new Float32Array(buffer, dataOffset)
    : new Float32Array(buffer.slice(dataOffset));
  return { header, data };
}

/**
 * Forward n-th order discrete difference. Order 0 returns the input untouched;
 * each order shortens the array by one sample: d[i] = x[i+1] - x[i].
 */
export function nthDifference(arr, order) {
  if (order <= 0) return arr;
  let cur = arr;
  for (let o = 0; o < order; o++) {
    const next = new Float32Array(cur.length - 1);
    for (let i = 0; i < next.length; i++) next[i] = cur[i + 1] - cur[i];
    cur = next;
  }
  return cur;
}

// --------------------------------------------------------------- basic stats
export function mean(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) m += arr[i];
  return arr.length ? m / arr.length : 0;
}

export function std(arr, m = null) {
  const n = arr.length;
  if (n === 0) return 0;
  if (m === null) m = mean(arr);
  let v = 0;
  for (let i = 0; i < n; i++) { const d = arr[i] - m; v += d * d; }
  return Math.sqrt(v / n);
}

export function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Quantile of an array (linear interpolation), q in [0,1]. */
export function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// ----------------------------------------------------------- normalisation
//
// Per-channel (a.k.a. instance) normalisation is standard practice for
// multivariate time series in ML — it puts every channel on a comparable scale
// so morphology can be compared regardless of raw amplitude. We offer the
// methods most common in the time-series literature.

// MathML fragment helpers (native rendering, no external library) -----------
const xp = `<msup><mi>x</mi><mo>&#x2032;</mo></msup>`;       // x′
const frac = (num, den) => `<mfrac>${num}${den}</mfrac>`;
const sub = (b, s) => `<msub><mi>${b}</mi><mrow>${s}</mrow></msub>`;
const eq = (rhs) => `<math display="block">${xp}<mo>=</mo>${rhs}</math>`;

export const NORM_METHODS = {
  none: {
    label: "Raw", unit: "µV",
    desc: "Original amplitude in microvolts — no scaling applied.",
    formula: () => eq(`<mi>x</mi>`),
  },
  zscore: {
    label: "Z-score", unit: "σ",
    desc: "Per-channel standardisation. The default instance-norm in time-series models (RevIN, N-BEATS, PatchTST). Each channel ends with zero mean and unit variance.",
    formula: () => eq(frac(`<mrow><mi>x</mi><mo>&#x2212;</mo><mi>&#x3BC;</mi></mrow>`, `<mi>&#x3C3;</mi>`)),
  },
  minmax: {
    label: "Min–Max", unit: "n",
    desc: "Per-channel rescaling to a fixed range. Bounded output; sensitive to outliers (one spike sets the range).",
    formula: (o) => {
      const range = frac(
        `<mrow><mi>x</mi><mo>&#x2212;</mo>${sub("x", "min")}</mrow>`,
        `<mrow>${sub("x", "max")}<mo>&#x2212;</mo>${sub("x", "min")}</mrow>`);
      return (o && o.mmRange === "unit")
        ? eq(range)
        : eq(`<mn>2</mn><mo>&#x2062;</mo>${range}<mo>&#x2212;</mo><mn>1</mn>`);
    },
    params: { type: "mmRange" },
  },
  robust: {
    label: "Robust", unit: "r",
    desc: "Centred on the median, scaled by the inter-percentile range. Like z-score but resistant to spikes & artefacts.",
    formula: (o) => {
      const lo = o ? o.robLow : 25, hi = 100 - (o ? o.robLow : 25);
      return eq(frac(
        `<mrow><mi>x</mi><mo>&#x2212;</mo>${sub("Q", "<mn>50</mn>")}</mrow>`,
        `<mrow>${sub("Q", `<mn>${hi}</mn>`)}<mo>&#x2212;</mo>${sub("Q", `<mn>${lo}</mn>`)}</mrow>`));
    },
    params: { type: "robust" },
  },
  globalz: {
    label: "Global Z", unit: "σg",
    desc: "A single mean & std pooled over all channels. Preserves the relative amplitude differences between channels.",
    formula: () => eq(frac(
      `<mrow><mi>x</mi><mo>&#x2212;</mo>${sub("&#x3BC;", "g")}</mrow>`, sub("&#x3C3;", "g"))),
  },
  l2: {
    label: "Unit norm", unit: "u",
    desc: "Divide by the RMS so the channel has unit energy. Scale-invariant — emphasises shape over magnitude.",
    formula: () => eq(frac(`<mi>x</mi>`,
      `<msqrt><mrow>${frac("<mn>1</mn>", "<mi>N</mi>")}<mo>&#x2211;</mo><msup><mi>x</mi><mn>2</mn></msup></mrow></msqrt>`)),
  },
};

/**
 * Normalise one channel.
 * @param gstats  {mean,std} pooled stats, required for "globalz".
 * @param opts    {mmRange:'sym'|'unit', robLow:number} method parameters.
 */
export function normalizeChannel(arr, method, gstats, opts = {}) {
  const n = arr.length;
  if (!method || method === "none" || n === 0) return arr;
  const out = new Float32Array(n);

  if (method === "zscore") {
    const m = mean(arr), s = std(arr, m) || 1;
    for (let i = 0; i < n; i++) out[i] = (arr[i] - m) / s;
  } else if (method === "minmax") {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { const v = arr[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const range = (mx - mn) || 1;
    if (opts.mmRange === "unit") for (let i = 0; i < n; i++) out[i] = (arr[i] - mn) / range;
    else for (let i = 0; i < n; i++) out[i] = (2 * (arr[i] - mn) / range) - 1;
  } else if (method === "robust") {
    const lo = (opts.robLow ?? 25) / 100, hi = 1 - lo;
    const med = quantile(arr, 0.5);
    const denom = (quantile(arr, hi) - quantile(arr, lo)) || 1;
    for (let i = 0; i < n; i++) out[i] = (arr[i] - med) / denom;
  } else if (method === "globalz") {
    const m = gstats.mean, s = gstats.std || 1;
    for (let i = 0; i < n; i++) out[i] = (arr[i] - m) / s;
  } else if (method === "l2") {
    let ss = 0;
    for (let i = 0; i < n; i++) ss += arr[i] * arr[i];
    const norm = Math.sqrt(ss / n) || 1; // RMS so amplitude stays ~unit
    for (let i = 0; i < n; i++) out[i] = arr[i] / norm;
  } else {
    return arr;
  }
  return out;
}

/** Pooled mean/std across an array of channel Float32Arrays (for "globalz"). */
export function globalStats(channels) {
  let total = 0, sum = 0;
  for (const ch of channels) { for (let i = 0; i < ch.length; i++) sum += ch[i]; total += ch.length; }
  const m = total ? sum / total : 0;
  let v = 0;
  for (const ch of channels) { for (let i = 0; i < ch.length; i++) { const d = ch[i] - m; v += d * d; } }
  return { mean: m, std: total ? Math.sqrt(v / total) : 1 };
}
