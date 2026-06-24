"""Atomic, out-of-core ingest: stream any source (HDF5 / EDF) into the derived
store. Build into `<token>.building/` and `os.replace` → `<token>/` only on success.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

import numpy as np

from ..util import group_of
from . import features as _features
from . import pyramid as _pyramid
from .readers import open_source, peek_values
from .registry import (
    CHUNK_BINS, D, FEATURE_NAMES, FEATURE_WINDOW_SEC, SCHEMA_VERSION, STORE_ROOT,
    new_token, open_and_register, record_build, set_status,
)

__all__ = ["ingest_path", "ingest_h5", "ingest_edf", "ingest_h5_bytes",
           "peek_h5_values_from_bytes"]


def ingest_path(src_path: Path, file_name: str, token: str | None = None,
                progress: bool = True) -> str:
    """Atomically stream-transcode a recording (HDF5 or EDF) into the store."""
    token = token or new_token()
    started = time.time()
    set_status(token, "ingesting", 0.0, file_name=file_name)
    build = STORE_ROOT / f"{token}.building"
    final = STORE_ROOT / token
    shutil.rmtree(build, ignore_errors=True)
    build.mkdir(parents=True, exist_ok=True)
    try:
        meta = _build_into(build, src_path, file_name, token, progress)
        shutil.rmtree(final, ignore_errors=True)
        os.replace(build, final)
        open_and_register(token, final, meta)
        record_build((time.time() - started) * 1000.0)
        set_status(token, "ready", 1.0, file_name=file_name)
        return token
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(build, ignore_errors=True)
        shutil.rmtree(final, ignore_errors=True)
        set_status(token, "error", 0.0, error=str(exc), file_name=file_name)
        raise


# Back-compat aliases (kind is auto-detected inside open_source).
ingest_h5 = ingest_path
ingest_edf = ingest_path


def ingest_h5_bytes(raw: bytes, file_name: str) -> str:
    STORE_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = STORE_ROOT / f"upload-{new_token()}{Path(file_name).suffix or '.h5'}"
    try:
        tmp.write_bytes(raw)
        return ingest_path(tmp, file_name)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def peek_h5_values_from_bytes(raw: bytes) -> int | None:
    """n_samples × n_channels for an in-memory HDF5 (legacy /api/parse decision)."""
    import io

    import h5py
    from .readers import _find_2d_dataset
    try:
        with h5py.File(io.BytesIO(raw), "r") as f:
            d = _find_2d_dataset(f)
            return int(d.shape[0]) * int(d.shape[1])
    except Exception:  # noqa: BLE001
        return None


def _build_into(work: Path, src_path: Path, file_name: str, token: str, progress: bool) -> dict:
    src = open_source(src_path)
    try:
        n_channels, n_samples, fs, labels = src.n_channels, src.n_samples, src.fs, src.labels
        kind = "edf" if type(src).__name__ == "EdfSource" else "h5"
        raw = np.memmap(work / "raw.f32", dtype="float32", mode="w+", shape=(n_channels, n_samples))
        g_min = np.full(n_channels, np.inf); g_max = np.full(n_channels, -np.inf)
        g_sum = np.zeros(n_channels); g_sumsq = np.zeros(n_channels)
        for s0, block in src.iter_chunks(D * CHUNK_BINS):
            m = block.shape[1]
            raw[:, s0:s0 + m] = block
            g_min = np.minimum(g_min, block.min(axis=1))
            g_max = np.maximum(g_max, block.max(axis=1))
            g_sum += block.sum(axis=1, dtype=np.float64)
            g_sumsq += np.square(block, dtype=np.float64).sum(axis=1)
            if progress:
                set_status(token, "ingesting", 0.5 * (s0 + m) / n_samples, file_name=file_name)
        raw.flush()
    finally:
        src.close()

    tier1, t1_bins = _pyramid.build_tier1(work, raw, n_channels, n_samples)
    if progress:
        set_status(token, "ingesting", 0.65, file_name=file_name)
    tiers_meta = _pyramid.tier_sizes(n_samples)
    tier_paths = _pyramid.build_coarse_tiers(work, tier1, t1_bins, n_channels, tiers_meta)
    if progress:
        set_status(token, "ingesting", 0.75, file_name=file_name)

    win_samp = max(1, int(round(fs * FEATURE_WINDOW_SEC)))
    n_win = _features.build_features(work, raw, n_channels, n_samples, win_samp)

    mean = g_sum / n_samples
    std = np.sqrt(np.maximum(g_sumsq / n_samples - mean ** 2, 0.0))
    channels = [{
        "label": labels[i], "group": group_of(labels[i]),
        "min": float(g_min[i]), "max": float(g_max[i]),
        "mean": float(mean[i]), "std": float(std[i]),
    } for i in range(n_channels)]
    groups: list[str] = []
    for c in channels:
        if c["group"] not in groups:
            groups.append(c["group"])

    meta = {
        "schemaVersion": SCHEMA_VERSION,
        "fileName": file_name, "kind": kind, "fs": fs,
        "nSamples": int(n_samples), "nChannels": int(n_channels),
        "durationSec": n_samples / fs if fs else None,
        "dtype": "float32", "layout": "channelMajor", "chunkSamples": D * CHUNK_BINS,
        "channels": channels, "groups": groups,
        "globalStd": float(np.median(std)) if std.size else 1.0,
        "tiers": [{"factor": fct, "nBins": nb, "path": p} for (fct, nb), p in zip(tiers_meta, tier_paths)],
        "features": {"windowSec": FEATURE_WINDOW_SEC, "windowSamples": win_samp,
                     "nWindows": int(n_win), "names": list(FEATURE_NAMES), "path": "features.f32"},
        "attrs": {}, "windowed": True, "status": "ready",
    }
    (work / "meta.json").write_text(json.dumps(meta))
    return meta
