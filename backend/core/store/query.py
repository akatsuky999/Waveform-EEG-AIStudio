"""Declarative query layer shared by the viewer and the agent.

`query(token, spec)` → ('tile', bytes) for `render`/`samples`, ('json', dict) for
`aggregate`/`search`. Every result carries a contract `{exact, grain, …}` where
**grain** states what "exact" is exact *to* (raw samples, an LoD tier, or the 1 s
feature grid) — so approximate (AQP) results are never mistaken for ground truth.
"""

from __future__ import annotations

import heapq
import json
import struct

import numpy as np

from . import features as _features
from . import pyramid as _pyramid
from .registry import (
    D, EXACT_AGG_MAX_SAMPLES, FEATURE_NAMES, RAW_LINE_MAX_SAMPLES,
    SAMPLES_MAX_PER_CH, SEARCH_BUDGET_DEFAULT, get_handle,
)


def query(token: str, spec: dict):
    op = str(spec.get("op") or "render")
    handle = get_handle(token)
    if handle is None:
        return ("json", {"error": "No windowed dataset for this dataToken.", "status": 409})
    if op == "render":
        return ("tile", _q_render(handle, spec))
    if op == "samples":
        return ("tile", _q_samples(handle, spec))
    if op == "aggregate":
        return ("json", _q_aggregate(handle, spec))
    if op == "search":
        return ("json", _q_search(handle, spec))
    return ("json", {"error": f"Unknown query op: {op}", "status": 400})


def window(token: str, start_sec: float, end_sec: float,
           max_columns: int = 1500, channels: list[int] | None = None) -> bytes | None:
    handle = get_handle(token)
    if handle is None:
        return None
    return _q_render(handle, {"startSec": start_sec, "endSec": end_sec,
                              "maxColumns": max_columns, "channels": channels})


def read_samples(token: str, start_sec: float, end_sec: float,
                 channels: list[int] | None = None,
                 max_per_channel: int = SAMPLES_MAX_PER_CH):
    handle = get_handle(token)
    if handle is None:
        return None
    meta = handle.meta
    fs = float(meta["fs"]) or 256.0
    n_samples = int(meta["nSamples"])
    s0 = max(0, min(n_samples - 1, int(round(start_sec * fs))))
    s1 = max(s0 + 1, min(n_samples, int(round(end_sec * fs))))
    truncated = (s1 - s0) > max_per_channel
    if truncated:
        s1 = s0 + max_per_channel
    ch = _resolve_channels(meta, channels)
    arr = np.ascontiguousarray(handle.raw[np.asarray(ch, dtype=np.int64), s0:s1], dtype=np.float32)
    info = {"channels": ch, "labels": [meta["channels"][c]["label"] for c in ch],
            "startSample": s0, "startSec": s0 / fs, "endSec": s1 / fs, "fs": fs,
            "nSamples": int(s1 - s0), "truncated": truncated, "exact": True}
    return arr, info


# ---- helpers ----
def _resolve_channels(meta: dict, channels) -> list[int]:
    n = int(meta["nChannels"])
    if not channels:
        return list(range(n))
    out = [int(c) for c in channels if 0 <= int(c) < n]
    return out or list(range(n))


def _span_samples(meta: dict, start_sec, end_sec):
    fs = float(meta["fs"]) or 256.0
    n = int(meta["nSamples"])
    s0 = max(0, min(n - 1, int(round((start_sec or 0) * fs))))
    s1 = max(s0 + 1, min(n, int(round((end_sec if end_sec is not None else n / fs) * fs))))
    return s0, s1, fs


def _grid_grain(meta: dict) -> str:
    return f"featureGrid:{meta['features']['windowSec']:g}s"


# ---- render / samples (binary tiles) ----
def _q_render(handle, spec) -> bytes:
    meta = handle.meta
    s0, s1, fs = _span_samples(meta, spec.get("startSec"), spec.get("endSec"))
    span = s1 - s0
    max_columns = max(16, min(int(spec.get("maxColumns") or 1500), 4000))
    ch = _resolve_channels(meta, spec.get("channels"))
    ch_arr = np.asarray(ch, dtype=np.int64)
    spc = span / max_columns

    if spc <= 1.0 and span <= RAW_LINE_MAX_SAMPLES:
        block = np.ascontiguousarray(handle.raw[ch_arr, s0:s1], dtype=np.float32)
        header = {"op": "render", "mode": "raw", "channels": ch, "nChannels": len(ch),
                  "nSamples": int(span), "startSample": int(s0), "fs": fs,
                  "startSec": s0 / fs, "endSec": s1 / fs,
                  "exact": True, "grain": "raw", "resolution": 1, "tierFactor": 1,
                  "coverageSec": [s0 / fs, s1 / fs]}
        return _pack_tile(header, block.reshape(-1))

    if spc <= D:
        block = np.asarray(handle.raw[ch_arr, s0:s1], dtype=np.float32)
        mn, mx, n_cols = _pyramid.agg_columns(block, block, max_columns)
        tier_factor = 1
    else:
        ti = _pyramid.pick_tier(meta, spc)
        tier = handle.tiers[ti]; tier_factor = meta["tiers"][ti]["factor"]
        b0 = s0 // tier_factor
        b1 = min(tier.shape[1], -(-s1 // tier_factor))
        sub = np.asarray(tier[ch_arr, b0:b1, :], dtype=np.float32)
        mn, mx, n_cols = _pyramid.agg_columns(sub[:, :, 0], sub[:, :, 1], max_columns)

    out = np.empty((len(ch), n_cols, 2), dtype=np.float32)
    out[:, :, 0] = mn; out[:, :, 1] = mx
    header = {"op": "render", "mode": "agg", "channels": ch, "nChannels": len(ch),
              "nCols": int(n_cols), "startSample": int(s0), "endSample": int(s1), "fs": fs,
              "startSec": s0 / fs, "endSec": s1 / fs, "tierFactor": int(tier_factor),
              "exact": False, "grain": f"lod:{int(tier_factor)}x",
              "resolution": int(round(span / n_cols)), "coverageSec": [s0 / fs, s1 / fs]}
    return _pack_tile(header, out.reshape(-1))


def _q_samples(handle, spec) -> bytes:
    meta = handle.meta
    s0, s1, fs = _span_samples(meta, spec.get("startSec"), spec.get("endSec"))
    cap = min(int(spec.get("maxPerChannel") or SAMPLES_MAX_PER_CH), SAMPLES_MAX_PER_CH)
    truncated = (s1 - s0) > cap
    if truncated:
        s1 = s0 + cap
    ch = _resolve_channels(meta, spec.get("channels"))
    block = np.ascontiguousarray(handle.raw[np.asarray(ch, dtype=np.int64), s0:s1], dtype=np.float32)
    header = {"op": "samples", "mode": "raw", "channels": ch, "nChannels": len(ch),
              "nSamples": int(s1 - s0), "startSample": int(s0), "fs": fs,
              "startSec": s0 / fs, "endSec": s1 / fs, "exact": True, "grain": "raw",
              "truncated": truncated, "coverageSec": [s0 / fs, s1 / fs]}
    return _pack_tile(header, block.reshape(-1))


# ---- aggregate (json) ----
def _q_aggregate(handle, spec) -> dict:
    meta = handle.meta
    s0, s1, fs = _span_samples(meta, spec.get("startSec"), spec.get("endSec"))
    ch = _resolve_channels(meta, spec.get("channels"))[:64]
    span = s1 - s0
    rows = []
    if span <= EXACT_AGG_MAX_SAMPLES:
        ca = np.asarray(ch, dtype=np.int64)
        smin = np.full(len(ch), np.inf); smax = np.full(len(ch), -np.inf)
        ssum = np.zeros(len(ch)); ssq = np.zeros(len(ch))
        step = max(1, D * 4096)
        for a in range(s0, s1, step):
            b = min(a + step, s1)
            blk = np.asarray(handle.raw[ca, a:b], dtype=np.float64)
            smin = np.minimum(smin, blk.min(axis=1)); smax = np.maximum(smax, blk.max(axis=1))
            ssum += blk.sum(axis=1); ssq += np.square(blk).sum(axis=1)
        mean = ssum / span; rms = np.sqrt(np.maximum(ssq / span, 0.0))
        for i, c in enumerate(ch):
            rows.append({"index": c, "label": meta["channels"][c]["label"],
                         "mean": float(mean[i]), "rms": float(rms[i]),
                         "min": float(smin[i]), "max": float(smax[i]),
                         "peakToPeak": float(smax[i] - smin[i])})
        contract = {"exact": True, "grain": "raw", "coverageSec": [s0 / fs, s1 / fs]}
    else:
        fmeta = meta["features"]; wsamp = fmeta["windowSamples"]
        w0 = s0 // wsamp; w1 = max(w0 + 1, -(-s1 // wsamp))
        feats = handle.features
        for c in ch:
            sub = np.asarray(feats[c, w0:w1, :], dtype=np.float64)
            rms = float(np.sqrt(np.mean(np.square(sub[:, 0])))) if sub.size else 0.0
            p2p = float(sub[:, 2].max()) if sub.size else 0.0
            rows.append({"index": c, "label": meta["channels"][c]["label"], "mean": None,
                         "rms": rms, "min": None, "max": None, "peakToPeak": p2p})
        contract = {"exact": False, "grain": _grid_grain(meta), "coverageSec": [s0 / fs, s1 / fs]}
    return {"op": "aggregate", "channels": rows, "meta": contract}


# ---- search (json): pre-filter → budget-bounded top-k + progressive metadata ----
def _q_search(handle, spec) -> dict:
    meta = handle.meta; fmeta = meta["features"]
    fs = float(meta["fs"]) or 256.0
    wsamp = fmeta["windowSamples"]; n_win = fmeta["nWindows"]
    names = list(FEATURE_NAMES) + ["artifact"]
    metric = str(spec.get("metric") or "rms")
    if metric not in names:
        metric = "rms"
    limit = max(1, min(int(spec.get("limit") or 8), 64))
    budget = max(limit, min(int(spec.get("budget") or SEARCH_BUDGET_DEFAULT), 5_000_000))
    start_sec = spec.get("startSec") or 0
    end_sec = spec.get("endSec")
    w0 = max(0, int(start_sec * fs) // wsamp)
    w1 = min(n_win, -(-int((end_sec if end_sec is not None else meta["nSamples"] / fs) * fs) // wsamp))
    if w1 <= w0:
        w0, w1 = 0, n_win
    ch = _resolve_channels(meta, spec.get("channels"))
    pred = spec.get("predicate") or {}
    gt = float(pred["gt"]) if "gt" in pred else None
    lt = float(pred["lt"]) if "lt" in pred else None

    # pre-filter: scan channels in descending summary-bound order; prune the tail
    # once no remaining channel can beat the running k-th best (branch-and-bound).
    summary = handle.feature_summary
    if summary is not None:
        bounds = {c: _features.metric_summary_bound(summary[c], metric) for c in ch}
        order = sorted(ch, key=lambda c: bounds[c], reverse=True)
    else:
        bounds = None
        order = list(ch)

    feats = handle.features
    heap: list[tuple] = []           # min-heap of (score, channel, window)
    scanned_windows = 0; scanned_channels = 0; pruned_channels = 0; partial = False
    per = w1 - w0
    for idx, c in enumerate(order):
        if bounds is not None and len(heap) == limit and bounds[c] <= heap[0][0]:
            pruned_channels = len(order) - idx       # tail is all ≤ this bound (sorted)
            break
        if scanned_windows + per > budget:
            partial = True
            break
        row = _features.metric_grid(np.asarray(feats[c, w0:w1, :], dtype=np.float32), metric)
        scanned_windows += per; scanned_channels += 1
        cand = row
        if gt is not None or lt is not None:
            mask = np.ones_like(row, dtype=bool)
            if gt is not None: mask &= row > gt
            if lt is not None: mask &= row < lt
            cand = np.where(mask, row, -np.inf)
        k = min(limit, cand.size)
        top_idx = np.argpartition(cand, -k)[-k:]
        for wi in top_idx:
            score = float(cand[wi])
            if not np.isfinite(score):
                continue
            item = (score, c, w0 + int(wi))
            if len(heap) < limit:
                heapq.heappush(heap, item)
            elif score > heap[0][0]:
                heapq.heapreplace(heap, item)

    windows = []
    for score, c, w in sorted(heap, key=lambda x: x[0], reverse=True):
        windows.append({
            "channel": c, "label": meta["channels"][c]["label"],
            "startSec": round(w * wsamp / fs, 3),
            "endSec": round(min((w + 1) * wsamp, meta["nSamples"]) / fs, 3),
            "metric": metric, "score": round(score, 4),
            "features": {n: round(float(feats[c, w, j]), 4) for j, n in enumerate(FEATURE_NAMES)},
        })
    return {"op": "search", "metric": metric, "windows": windows,
            "meta": {"exact": True, "grain": _grid_grain(meta), "windowSec": fmeta["windowSec"],
                     "scannedWindows": int(scanned_windows), "scannedChannels": scanned_channels,
                     "prunedChannels": pruned_channels, "budget": budget, "partial": partial,
                     "coverageSec": [w0 * wsamp / fs, w1 * wsamp / fs]}}


def _pack_tile(header: dict, payload: np.ndarray) -> bytes:
    header_bytes = json.dumps(header).encode("utf-8")
    header_bytes += b" " * ((-len(header_bytes)) % 4)
    body = np.ascontiguousarray(payload, dtype="<f4").tobytes()
    return struct.pack("<I", len(header_bytes)) + header_bytes + body
