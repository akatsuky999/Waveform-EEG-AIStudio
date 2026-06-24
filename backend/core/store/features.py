"""Per-(channel × 1 s window) time-domain feature index + the metric used by search.

Built in bounded blocks over **channels × time-windows**, so a single channel's
full duration is never materialized — the heap stays bounded for arbitrarily long
recordings. Also yields a per-channel summary (max per feature) used as a cheap
pre-filter / branch-and-bound bound during search.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .registry import FEATURE_NAMES, N_FEAT


def window_features(x: np.ndarray) -> np.ndarray:
    """(cb, nwin, w) float32 → (cb, nwin, N_FEAT): rms, lineLength, p2p, zeroCross."""
    rms = np.sqrt(np.mean(np.square(x, dtype=np.float64), axis=2))
    p2p = x.max(axis=2) - x.min(axis=2)
    line = np.abs(np.diff(x, axis=2)).sum(axis=2)
    centered = x - x.mean(axis=2, keepdims=True)
    zc = (np.abs(np.diff(np.sign(centered), axis=2)) > 0).sum(axis=2) / max(1, x.shape[2])
    out = np.empty((x.shape[0], x.shape[1], N_FEAT), dtype=np.float32)
    out[..., 0] = rms; out[..., 1] = line; out[..., 2] = p2p; out[..., 3] = zc
    return out


def build_features(work: Path, raw, n_channels: int, n_samples: int, win_samp: int):
    """Build features.f32 (n_ch, n_win, N_FEAT) + feature_summary.npy, blocked over
    channels × time so neither dimension is read whole at once."""
    n_win = -(-n_samples // win_samp)
    feats = np.memmap(work / "features.f32", dtype="float32", mode="w+",
                      shape=(n_channels, n_win, N_FEAT))
    summary = np.zeros((n_channels, N_FEAT), dtype=np.float32)

    # window-block sized to a byte budget so a channel-block's time read is bounded
    win_block = max(1, 32_000_000 // max(1, win_samp * 4))
    ch_block = max(1, 8)
    for c0 in range(0, n_channels, ch_block):
        c1 = min(c0 + ch_block, n_channels)
        chmax = np.zeros((c1 - c0, N_FEAT), dtype=np.float32)
        for w0 in range(0, n_win, win_block):
            w1 = min(w0 + win_block, n_win)
            s0, s1 = w0 * win_samp, min(w1 * win_samp, n_samples)
            blk = np.asarray(raw[c0:c1, s0:s1], dtype=np.float32)
            n_full = (s1 - s0) // win_samp
            wi = w0
            if n_full:
                head = blk[:, : n_full * win_samp].reshape(c1 - c0, n_full, win_samp)
                fv = window_features(head)
                feats[c0:c1, w0:w0 + n_full, :] = fv
                chmax = np.maximum(chmax, fv.max(axis=1))
                wi = w0 + n_full
            rem = (s1 - s0) - n_full * win_samp
            if rem and wi < n_win:  # trailing partial window (only at the very end)
                tail = blk[:, n_full * win_samp:][:, None, :]
                fv = window_features(tail)
                feats[c0:c1, wi, :] = fv[:, 0, :]
                chmax = np.maximum(chmax, fv[:, 0, :])
        summary[c0:c1] = chmax
    feats.flush()
    np.save(work / "feature_summary.npy", summary)
    return n_win


def metric_grid(grid: np.ndarray, metric: str) -> np.ndarray:
    """(…, N_FEAT) → metric scalar field. `artifact` is high-frequency wiggle
    (line-length & zero-cross) relative to amplitude."""
    rms, line, p2p, zc = grid[..., 0], grid[..., 1], grid[..., 2], grid[..., 3]
    if metric == "rms": return rms
    if metric == "lineLength": return line
    if metric == "p2p": return p2p
    if metric == "zeroCross": return zc
    denom = np.maximum(rms, 1e-6)
    return (line / denom) * 0.5 + zc * 50.0


def metric_summary_bound(summary_row: np.ndarray, metric: str) -> float:
    """Upper bound of `metric` for a channel from its per-feature maxima — used to
    prune channels that cannot contain a top-k window (branch-and-bound)."""
    rms, line, p2p, zc = summary_row
    if metric == "rms": return float(rms)
    if metric == "lineLength": return float(line)
    if metric == "p2p": return float(p2p)
    if metric == "zeroCross": return float(zc)
    # artifact bound: max line/min-plausible-rms + max zc term (a loose over-estimate)
    return float((line / max(rms, 1e-6)) * 0.5 + zc * 50.0)
