"""Server-side DSP for windowed (out-of-core) processed rendering.

Faithfully ports the frontend pipeline so a processed render computed here matches
the client view:

    decimate (working rate) -> montage -> zero-phase band-pass + harmonic notch
    -> differencing -> normalization

References (kept in lock-step): ``frontend/js/viewer/dsp.js`` (filterGain /
applyFrequencyFilter), ``frontend/js/viewer/montage.js`` (buildMontage), and
``frontend/js/core/parse.js`` (normalizeChannel / nthDifference).

The band-pass/notch is an FFT-domain zero-phase filter identical to the client's
``filterGain`` (so the deep-zoom exact line and the wide processed overview agree).
Interactive processed rendering uses fast boxcar decimation at a conservative
working rate; build-once review tiers can use scipy polyphase resampling when
sharp anti-aliasing is worth the amortized cost.
"""

from __future__ import annotations

import numpy as np
from scipy.fft import irfft, rfft, rfftfreq
from scipy.signal import resample_poly

__all__ = [
    "apply_filter", "apply_montage", "apply_diff", "apply_norm",
    "decimate_block", "decimate_clean", "filter_gain",
]


# ---- band-pass + notch (port of dsp.js filterGain / applyFrequencyFilter) ----
def _cos_ramp(x: np.ndarray) -> np.ndarray:
    return 0.5 - 0.5 * np.cos(np.pi * np.clip(x, 0.0, 1.0))


def filter_gain(freqs: np.ndarray, fs: float, low: float, high: float, notch: int) -> np.ndarray:
    """Zero-phase magnitude response at each frequency (Hz). Matches dsp.js."""
    g = np.ones_like(freqs, dtype=np.float64)
    if low and low > 0:
        tw = min(low, max(0.5, low * 0.5))
        g *= _cos_ramp((freqs - (low - tw)) / (2 * tw))
    if high and high > 0:
        tw = max(1.0, high * 0.15)
        g *= 1.0 - _cos_ramp((freqs - (high - tw)) / (2 * tw))
    if notch in (50, 60):
        nyq = fs / 2.0
        fwhm = 2.0
        sigma = fwhm / 2.355
        h = 1
        while h * notch <= nyq + fwhm:
            d = freqs - h * notch
            g *= 1.0 - np.exp(-(d * d) / (2 * sigma * sigma))
            h += 1
    return g


def _next_pow2(n: int) -> int:
    p = 1
    while p < n:
        p <<= 1
    return p


def apply_filter(block: np.ndarray, fs: float, low: float, high: float, notch: int) -> np.ndarray:
    """Reflect-padded, zero-phase FFT-domain band-pass + notch over (n_ch, n)."""
    notch = notch if notch in (50, 60) else 0
    if not (low or high or notch):
        return block
    n = block.shape[1]
    if n < 2:
        return block
    pad = min(n, max(1, int(round(fs))))
    left = block[:, pad - 1::-1]                 # reflect block[:, :pad]
    right = block[:, n - 1:n - 1 - pad:-1]       # reflect block[:, n-pad:]
    padded = np.concatenate([left, block, right], axis=1)
    lp = padded.shape[1]                          # 2*pad + n
    size = _next_pow2(lp)
    # float32 / scipy.fft (complex64) keeps the FFT memory bounded (~half of
    # numpy's float64/complex128) — matters when many channels are filtered at once.
    work = np.zeros((block.shape[0], size), dtype=np.float32)
    work[:, :lp] = padded
    spec = rfft(work, axis=1)
    freqs = rfftfreq(size, d=1.0 / fs)
    spec *= filter_gain(freqs, fs, low, high, notch).astype(np.float32)[None, :]
    out = irfft(spec, n=size, axis=1)[:, pad:pad + n]
    return np.ascontiguousarray(out, dtype=np.float32)


# ---- montage (port of montage.js buildMontage) ----
def _group_indices(meta: list[dict]) -> dict[str, list[int]]:
    groups: dict[str, list[int]] = {}
    for i, m in enumerate(meta):
        groups.setdefault(m.get("group", ""), []).append(i)
    return groups


def apply_montage(block: np.ndarray, meta: list[dict], mode: str):
    """Re-reference into a clinical montage. Returns (out_block, out_meta).

    out_meta is the derived per-channel list (label/group/montage/sourceIndex),
    matching frontend/js/viewer/montage.js. bipolar/local change the channel set.
    """
    if mode == "bipolar":
        rows, out_meta = [], []
        for i in range(len(meta) - 1):
            a, b = meta[i], meta[i + 1]
            if a.get("group") != b.get("group"):
                continue
            rows.append(block[i] - block[i + 1])
            out_meta.append({"label": f"{a['label']}-{b['label']}", "group": a.get("group", ""),
                             "montage": "bipolar", "sourceIndex": i})
        out = np.ascontiguousarray(np.stack(rows), dtype=np.float32) if rows else block[:0]
        return out, out_meta

    if mode in ("car", "group-car"):
        groups = _group_indices(meta) if mode == "group-car" else {"": list(range(len(meta)))}
        out = np.array(block, dtype=np.float32, copy=True)
        tag = "GAR" if mode == "group-car" else "CAR"
        for idx in groups.values():
            if not idx:
                continue
            out[idx] = block[idx] - block[idx].mean(axis=0, keepdims=True)
        out_meta = [{"label": f"{m['label']}-{tag}", "group": m.get("group", ""),
                     "montage": mode, "sourceIndex": i} for i, m in enumerate(meta)]
        return out, out_meta

    if mode == "local":
        rows, out_meta = [], []
        for i in range(len(meta)):
            nb = []
            if i > 0 and meta[i - 1].get("group") == meta[i].get("group"):
                nb.append(i - 1)
            if i + 1 < len(meta) and meta[i + 1].get("group") == meta[i].get("group"):
                nb.append(i + 1)
            if not nb:
                continue
            rows.append(block[i] - block[nb].mean(axis=0))
            out_meta.append({"label": f"{meta[i]['label']}-LAP", "group": meta[i].get("group", ""),
                             "montage": "local", "sourceIndex": i})
        out = np.ascontiguousarray(np.stack(rows), dtype=np.float32) if rows else block[:0]
        return out, out_meta

    # raw / unknown: unchanged
    return block, [{"label": m["label"], "group": m.get("group", ""), "montage": "raw",
                    "sourceIndex": i} for i, m in enumerate(meta)]


# ---- differencing (port of parse.js nthDifference) ----
def apply_diff(block: np.ndarray, order: int) -> np.ndarray:
    if not order or order <= 0:
        return block
    return np.ascontiguousarray(np.diff(block, n=int(order), axis=1), dtype=np.float32)


# ---- normalization (port of parse.js normalizeChannel) ----
def apply_norm(block: np.ndarray, method: str, opts: dict | None = None,
               global_means: np.ndarray | None = None, global_std: float = 1.0) -> np.ndarray:
    if not method or method == "none" or block.size == 0:
        return block
    opts = opts or {}
    x = np.asarray(block, dtype=np.float64)
    if method == "zscore":
        m = x.mean(axis=1, keepdims=True)
        s = x.std(axis=1, keepdims=True)
        s[s == 0] = 1.0
        out = (x - m) / s
    elif method == "minmax":
        mn = x.min(axis=1, keepdims=True)
        rng = x.max(axis=1, keepdims=True) - mn
        rng[rng == 0] = 1.0
        out = (x - mn) / rng if opts.get("mmRange") == "unit" else 2 * (x - mn) / rng - 1
    elif method == "robust":
        lo = (opts.get("robLow", 25)) / 100.0
        med = np.median(x, axis=1, keepdims=True)
        denom = (np.quantile(x, 1 - lo, axis=1, keepdims=True)
                 - np.quantile(x, lo, axis=1, keepdims=True))
        denom[denom == 0] = 1.0
        out = (x - med) / denom
    elif method == "globalz":
        m = (global_means.reshape(-1, 1) if global_means is not None and global_means.shape[0] == x.shape[0]
             else x.mean(axis=1, keepdims=True))
        out = (x - m) / (global_std or 1.0)
    elif method == "l2":
        rms = np.sqrt(np.mean(x * x, axis=1, keepdims=True))
        rms[rms == 0] = 1.0
        out = x / rms
    else:
        return block
    return np.ascontiguousarray(out, dtype=np.float32)


# ---- decimation ----
def decimate_block(block: np.ndarray, down: int) -> np.ndarray:
    """Fast per-render boxcar (mean) decimation by an integer factor along time.

    ~40× faster than polyphase resampling on wide high-rate windows, which is what
    makes interactive processed rendering possible. The caller picks the working
    rate with enough headroom over the passband (≈3×) that the boxcar's sinc droop
    at the band edge stays under ~1.5 dB; the subsequent band-pass removes the rest.
    For the build-once review tier (where quality matters and cost is amortized) use
    ``decimate_clean`` instead.
    """
    down = int(down)
    if down <= 1 or block.shape[1] <= down:
        return block
    m = (block.shape[1] // down) * down
    if m == 0:
        return block
    out = block[:, :m].reshape(block.shape[0], m // down, down).mean(axis=2)
    return np.ascontiguousarray(out, dtype=np.float32)


def decimate_clean(block: np.ndarray, down: int) -> np.ndarray:
    """Sharp polyphase anti-aliased downsample — for the build-once review tier."""
    down = int(down)
    if down <= 1 or block.shape[1] <= down:
        return block
    out = resample_poly(np.asarray(block, dtype=np.float64), up=1, down=down, axis=1)
    return np.ascontiguousarray(out, dtype=np.float32)
