"""Min/max level-of-detail (LoD) pyramid: tier sizing, coarse-tier reduction, and
pixel-column aggregation (the M4 / MinMax visualization-driven aggregation model).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .registry import D, MIN_TIER_BINS


def tier_sizes(n_samples: int) -> list[tuple[int, int]]:
    """[(factor, n_bins), ...] for tier 1.. (raw is tier 0, factor 1)."""
    tiers, factor = [], D
    while True:
        n_bins = -(-n_samples // factor)
        tiers.append((factor, n_bins))
        if n_bins <= MIN_TIER_BINS:
            break
        factor *= D
    return tiers


def build_tier1(work: Path, raw, n_channels: int, n_samples: int):
    """Build tier-1 (D-sample min/max bins) from the raw memmap in channel×bin
    blocks — bin-aligned and independent of the source's chunk sizes. Returns
    (tier1_memmap, n_bins)."""
    n_bins = -(-n_samples // D)
    tier1 = np.memmap(work / "tier1.f32", dtype="float32", mode="w+",
                      shape=(n_channels, n_bins, 2))
    bin_block = max(1, 8_000_000 // (D * 4))
    ch_block = 8
    for c0 in range(0, n_channels, ch_block):
        c1 = min(c0 + ch_block, n_channels)
        for b0 in range(0, n_bins, bin_block):
            b1 = min(b0 + bin_block, n_bins)
            s0, s1 = b0 * D, min(b1 * D, n_samples)
            blk = np.asarray(raw[c0:c1, s0:s1], dtype=np.float32)
            n_full = (s1 - s0) // D
            if n_full:
                head = blk[:, : n_full * D].reshape(c1 - c0, n_full, D)
                tier1[c0:c1, b0:b0 + n_full, 0] = head.min(axis=2)
                tier1[c0:c1, b0:b0 + n_full, 1] = head.max(axis=2)
            if (s1 - s0) - n_full * D and (b0 + n_full) < n_bins:
                tail = blk[:, n_full * D:]
                tier1[c0:c1, b0 + n_full, 0] = tail.min(axis=1)
                tier1[c0:c1, b0 + n_full, 1] = tail.max(axis=1)
    tier1.flush()
    return tier1, n_bins


def build_coarse_tiers(work: Path, tier1, tier1_bins: int, n_channels: int,
                       tiers_meta: list[tuple[int, int]]) -> list[str]:
    """Reduce tier1 into coarser tiers (min of mins / max of maxs), channel-blocked
    so the transient heap stays bounded. Returns the tier file paths."""
    tier_paths = ["tier1.f32"]
    prev, prev_bins = tier1, tier1_bins
    for _factor, n_bins in tiers_meta[1:]:
        cur = np.memmap(work / f"tier{len(tier_paths) + 1}.f32", dtype="float32", mode="w+",
                        shape=(n_channels, n_bins, 2))
        pad = n_bins * D - prev_bins
        ch_block = max(1, 64_000_000 // max(1, prev_bins * 8))
        for c0 in range(0, n_channels, ch_block):
            c1 = min(c0 + ch_block, n_channels)
            pmin = np.asarray(prev[c0:c1, :, 0], dtype=np.float32)
            pmax = np.asarray(prev[c0:c1, :, 1], dtype=np.float32)
            if pad:
                pmin = np.pad(pmin, ((0, 0), (0, pad)), constant_values=np.inf)
                pmax = np.pad(pmax, ((0, 0), (0, pad)), constant_values=-np.inf)
            cur[c0:c1, :, 0] = pmin.reshape(c1 - c0, n_bins, D).min(axis=2)
            cur[c0:c1, :, 1] = pmax.reshape(c1 - c0, n_bins, D).max(axis=2)
        cur.flush()
        tier_paths.append(f"tier{len(tier_paths) + 1}.f32")
        prev, prev_bins = cur, n_bins
    return tier_paths


def agg_columns(src_min: np.ndarray, src_max: np.ndarray, n_cols: int):
    """Reduce (n_ch, n) min/max arrays to exactly n_cols columns (or n if smaller).

    Buckets via ``reduceat`` over evenly spaced edges — every output column is
    backed by real samples, so no padding and no inf/NaN leak into the geometry.
    """
    n = src_min.shape[1]
    if n <= n_cols:
        return np.ascontiguousarray(src_min), np.ascontiguousarray(src_max), n
    edges = np.floor(np.linspace(0, n, n_cols + 1)[:-1]).astype(np.intp)
    np.maximum.accumulate(edges, out=edges)
    mn = np.minimum.reduceat(src_min, edges, axis=1)
    mx = np.maximum.reduceat(src_max, edges, axis=1)
    return np.ascontiguousarray(mn), np.ascontiguousarray(mx), n_cols


def pick_tier(meta: dict, samples_per_col: float) -> int:
    """Index of the finest tier whose factor ≤ samples/column."""
    chosen = 0
    for i, t in enumerate(meta["tiers"]):
        if t["factor"] <= samples_per_col:
            chosen = i
        else:
            break
    return chosen
