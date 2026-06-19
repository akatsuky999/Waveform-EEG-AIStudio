// dsp.js — signal-processing helpers: FFT, spectrum/spectrogram, band power,
// frequency-domain filtering and windowed measurement. All pure functions.

export const BANDS = [
  ["delta", "δ", 0.5, 4],
  ["theta", "θ", 4, 8],
  ["alpha", "α", 8, 13],
  ["beta", "β", 13, 30],
  ["gamma", "γ", 30, 80],
];
export const BAND_LABELS = Object.fromEntries(BANDS.map(([id, label]) => [id, label]));

export function analyzeSignal(arr, fs) {
  const spectrum = spectrumFor(arr, fs, 80);
  const bandPower = {};
  for (const [id] of BANDS) bandPower[id] = 0;

  let bestFreq = NaN, bestPower = -Infinity, totalBandPower = 0;
  for (let i = 0; i < spectrum.freqs.length; i++) {
    const f = spectrum.freqs[i], p = spectrum.powers[i];
    if (p > bestPower) { bestPower = p; bestFreq = f; }
    for (const [id, _label, lo, hi] of BANDS) {
      if (f >= lo && f < hi) {
        bandPower[id] += p;
        totalBandPower += p;
        break;
      }
    }
  }

  let dominantBand = "";
  let dominantBandPower = -Infinity;
  for (const [id] of BANDS) {
    bandPower[id] = totalBandPower ? bandPower[id] / totalBandPower : 0;
    if (bandPower[id] > dominantBandPower) {
      dominantBandPower = bandPower[id];
      dominantBand = id;
    }
  }

  return { freq: bestFreq, bands: bandPower, dominantBand, spectrumMax: spectrum.maxPower };
}

export function spectrumFor(arr, fs, maxHz = 80) {
  const n = arr.length;
  if (n < 4 || !fs) return { freqs: new Float32Array(0), powers: new Float32Array(0), maxPower: 0 };

  const size = nextPow2(n);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let m = 0;
  for (let i = 0; i < n; i++) m += arr[i];
  m /= n;

  for (let i = 0; i < n; i++) {
    const taper = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
    re[i] = (arr[i] - m) * taper;
  }
  fft(re, im);

  const nyquist = fs / 2;
  const binHz = fs / size;
  const minBin = Math.max(1, Math.ceil(0.5 / binHz));
  const maxBin = Math.min(Math.floor(Math.min(maxHz, nyquist) / binHz), Math.floor(size / 2));
  if (maxBin < minBin) return { freqs: new Float32Array(0), powers: new Float32Array(0), maxPower: 0 };

  const freqs = new Float32Array(maxBin - minBin + 1);
  const powers = new Float32Array(freqs.length);
  let maxPower = 0;
  for (let k = minBin; k <= maxBin; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    const idx = k - minBin;
    freqs[idx] = k * binHz;
    powers[idx] = p;
    if (p > maxPower) maxPower = p;
  }
  return { freqs, powers, maxPower };
}

export function spectrogramFor(arr, fs) {
  const win = Math.min(256, arr.length);
  if (win < 32) return null;
  const hop = Math.max(16, Math.floor(win / 4));
  const frames = [];
  let maxPower = 0;
  for (let start = 0; start + win <= arr.length; start += hop) {
    const spec = spectrumFor(arr.subarray(start, start + win), fs, 80);
    frames.push({ time: (start + win / 2) / fs, powers: spec.powers });
    maxPower = Math.max(maxPower, spec.maxPower);
  }
  const freqs = frames[0]?.powers.length ? spectrumFor(arr.subarray(0, win), fs, 80).freqs : new Float32Array(0);
  return { freqs, frames, maxPower };
}

// Raised-cosine ramp 0→1 over x∈[0,1] (smooth, no Gibbs ringing at the edges).
function cosRamp(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/**
 * Zero-phase frequency-domain gain at frequency `f` (Hz) for the filter `opts`.
 * High-pass (low cut) and low-pass (high cut) use cosine-tapered transition
 * bands so sharp transients (spikes) don't ring; the notch is a Gaussian dip
 * applied at the line frequency AND its harmonics up to Nyquist. The −6 dB
 * point sits at the requested cutoff. Shared by the filter and the UI response
 * curve so what you see is exactly what is applied.
 */
export function filterGain(f, fs, opts) {
  const low = Math.max(0, parseFloat(opts.low) || 0);
  const high = Math.max(0, parseFloat(opts.high) || 0);
  const base = opts.notch === "50" || opts.notch === "60" ? parseFloat(opts.notch) : 0;
  let g = 1;
  if (low > 0) {
    const tw = Math.min(low, Math.max(0.5, low * 0.5)); // half transition width (Hz)
    g *= cosRamp((f - (low - tw)) / (2 * tw));
  }
  if (high > 0) {
    const tw = Math.max(1, high * 0.15);
    g *= 1 - cosRamp((f - (high - tw)) / (2 * tw));
  }
  if (base > 0) {
    const nyq = fs / 2;
    const fwhm = 2;                       // notch width at half-depth (Hz)
    const sigma = fwhm / 2.355;
    for (let h = 1; h * base <= nyq + fwhm; h++) {
      const d = f - h * base;
      g *= 1 - Math.exp(-(d * d) / (2 * sigma * sigma));
    }
  }
  return g;
}

export function applyFrequencyFilter(arr, fs, opts) {
  const low = Math.max(0, parseFloat(opts.low) || 0);
  const high = Math.max(0, parseFloat(opts.high) || 0);
  const notch = opts.notch === "50" || opts.notch === "60";
  if (!low && !high && !notch) return arr;

  const n = arr.length;
  // Reflect-pad both ends so the FFT's circular assumption doesn't wrap the
  // window's end into its start (edge artifacts).
  const pad = Math.min(n, Math.max(1, Math.round(fs)));
  const size = nextPow2(2 * pad + n);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < pad; i++) re[i] = arr[pad - 1 - i];           // left reflect
  for (let i = 0; i < n; i++) re[pad + i] = arr[i];
  for (let i = 0; i < pad; i++) re[pad + n + i] = arr[n - 1 - i];   // right reflect
  fft(re, im);

  const binHz = fs / size;
  for (let k = 0; k <= size / 2; k++) {
    const g = filterGain(k * binHz, fs, opts);
    if (g !== 1) {
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < size / 2) { re[size - k] *= g; im[size - k] *= g; }
    }
  }
  ifft(re, im);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = re[pad + i];
  return out;
}

export function measureRange(arr, fs, t1, t2) {
  const start = Math.max(0, Math.min(arr.length - 1, Math.floor(Math.min(t1, t2) * fs)));
  const end = Math.max(start + 1, Math.min(arr.length, Math.ceil(Math.max(t1, t2) * fs)));
  const seg = arr.subarray(start, end);
  let sum = 0, ss = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < seg.length; i++) {
    const v = seg[i];
    sum += v; ss += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const meanVal = seg.length ? sum / seg.length : 0;
  return {
    start: start / fs,
    end: end / fs,
    duration: (end - start) / fs,
    mean: meanVal,
    rms: seg.length ? Math.sqrt(ss / seg.length) : 0,
    p2p: mx - mn,
    min: mn,
    max: mx,
    freq: analyzeSignal(seg, fs).freq,
  };
}

// ---- radix-2 FFT (internal) ---------------------------------------------
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlenR = Math.cos(ang), wlenI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = re[i + j], uI = im[i + j];
        const vR = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
        const vI = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
        re[i + j] = uR + vR;
        im[i + j] = uI + vI;
        re[i + j + len / 2] = uR - vR;
        im[i + j + len / 2] = uI - vI;
        const nextWr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR;
        wr = nextWr;
      }
    }
  }
}

function ifft(re, im) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}
