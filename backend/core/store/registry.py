"""Store registry: on-disk layout constants, open-store handles, LRU, status,
metrics. Everything else in the package builds on this foundation.
"""

from __future__ import annotations

import shutil
import tempfile
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Derived stores live under a process-local working dir (swept on startup).
STORE_ROOT = Path(tempfile.gettempdir()) / "waveform-signal-store"

# Recordings above this many samples×channels use the windowed store; smaller ones
# keep the legacy full-array path (agent/export unchanged).
WINDOWED_THRESHOLD_VALUES = 12_000_000

D = 8                           # downsample factor between LoD tiers
CHUNK_BINS = 4096               # tier-1 bins per streaming read (D*CHUNK_BINS samples)
MIN_TIER_BINS = 2048            # stop adding tiers once this small
MAX_OPEN_STORES = 4             # LRU cap on open recordings
RAW_LINE_MAX_SAMPLES = 200_000  # cap for a render raw-line payload (per span)
SAMPLES_MAX_PER_CH = 2_000_000  # cap for a `samples` window (per channel)
EXACT_AGG_MAX_SAMPLES = 10_000_000  # spans wider than this aggregate approximately
FEATURE_WINDOW_SEC = 1.0
FEATURE_NAMES = ("rms", "lineLength", "p2p", "zeroCross")
N_FEAT = len(FEATURE_NAMES)
SEARCH_BUDGET_DEFAULT = 200_000  # max (channel×window) cells a search scans
SCHEMA_VERSION = 3

_LOCK = threading.RLock()
_REGISTRY: "OrderedDict[str, Handle]" = OrderedDict()
_STATUS: dict[str, dict] = {}
_METRICS = {"hits": 0, "misses": 0, "evictions": 0, "builds": 0, "buildMsTotal": 0.0}


@dataclass
class Handle:
    token: str
    dir: Path
    meta: dict
    raw: np.memmap
    tiers: list = field(default_factory=list)            # one memmap per tier (factor D^k)
    features: np.memmap | None = None                    # (n_ch, n_win, N_FEAT)
    feature_summary: np.ndarray | None = None            # (n_ch, N_FEAT) per-channel max


def new_token() -> str:
    return uuid.uuid4().hex


# ------------------------------------------------------------------ status
def set_status(token: str, state: str, progress: float = 0.0, error: str | None = None,
               file_name: str | None = None) -> None:
    with _LOCK:
        cur = _STATUS.get(token, {})
        _STATUS[token] = {
            "token": token, "state": state, "progress": round(float(progress), 4),
            "error": error, "fileName": file_name or cur.get("fileName"),
        }


def get_status(token: str) -> dict | None:
    with _LOCK:
        return dict(_STATUS[token]) if token in _STATUS else None


def record_build(ms: float) -> None:
    with _LOCK:
        _METRICS["builds"] += 1
        _METRICS["buildMsTotal"] += ms


def stats() -> dict:
    with _LOCK:
        return {
            **_METRICS,
            "buildMsAvg": round(_METRICS["buildMsTotal"] / _METRICS["builds"], 1) if _METRICS["builds"] else 0,
            "openStores": [
                {"token": h.token, "nChannels": h.meta["nChannels"], "nSamples": h.meta["nSamples"]}
                for h in _REGISTRY.values()
            ],
            "maxOpenStores": MAX_OPEN_STORES,
        }


# ------------------------------------------------------------------ registry
def open_and_register(token: str, work: Path, meta: dict) -> None:
    n_ch, n_samp = meta["nChannels"], meta["nSamples"]
    raw = np.memmap(work / "raw.f32", dtype="float32", mode="r", shape=(n_ch, n_samp))
    tiers = [np.memmap(work / t["path"], dtype="float32", mode="r", shape=(n_ch, t["nBins"], 2))
             for t in meta["tiers"]]
    fmeta = meta["features"]
    features = np.memmap(work / fmeta["path"], dtype="float32", mode="r",
                         shape=(n_ch, fmeta["nWindows"], N_FEAT))
    summary_path = work / "feature_summary.npy"
    summary = np.load(summary_path) if summary_path.exists() else None
    register(Handle(token, work, meta, raw, tiers, features, summary))


def register(handle: Handle) -> None:
    with _LOCK:
        _REGISTRY[handle.token] = handle
        _REGISTRY.move_to_end(handle.token)
        while len(_REGISTRY) > MAX_OPEN_STORES:
            _, evicted = _REGISTRY.popitem(last=False)
            _METRICS["evictions"] += 1
            drop(evicted)


def drop(handle: Handle) -> None:
    handle.tiers = []
    handle.raw = None  # type: ignore[assignment]
    handle.features = None
    _STATUS.pop(handle.token, None)
    shutil.rmtree(handle.dir, ignore_errors=True)


def get_handle(token: str) -> Handle | None:
    with _LOCK:
        handle = _REGISTRY.get(token)
        _METRICS["hits" if handle else "misses"] += 1
        if handle is not None:
            _REGISTRY.move_to_end(token)
        return handle


def get_meta(token: str) -> dict | None:
    handle = get_handle(token)
    return handle.meta if handle else None


def cleanup_all() -> None:
    """Remove every derived store + stray build/upload files (startup recovery)."""
    with _LOCK:
        for handle in list(_REGISTRY.values()):
            drop(handle)
        _REGISTRY.clear()
        _STATUS.clear()
    shutil.rmtree(STORE_ROOT, ignore_errors=True)
