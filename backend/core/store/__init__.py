"""Queryable, out-of-core, multi-resolution time-series substrate.

Stream-transcodes a recording (HDF5 / EDF, any size) into an on-disk derived store
(`raw.f32` memmap + min/max LoD pyramid + a per-window feature index), then serves
the viewer *and* the agent through one declarative `query(token, spec)` with an
explicit exact/approximate result contract. See the submodules:

    registry   handles, LRU, status, metrics, on-disk constants
    readers    streaming H5 + custom EDF source readers (uniform interface)
    pyramid    min/max LoD tiers + pixel-column aggregation (M4 / MinMax)
    features   per-window time-domain feature index + search metric
    ingest     atomic streaming build (temp → rename)
    query      render / aggregate / search / samples + result contract
"""

from __future__ import annotations

from .ingest import (  # noqa: F401
    ingest_edf, ingest_h5, ingest_h5_bytes, ingest_path, peek_h5_values_from_bytes,
)
from .query import query, read_samples, window  # noqa: F401
from .readers import detect_kind, open_source, peek_values  # noqa: F401
from .registry import (  # noqa: F401
    CHUNK_BINS, D, FEATURE_NAMES, FEATURE_WINDOW_SEC, MAX_OPEN_STORES, N_FEAT,
    SCHEMA_VERSION, SEARCH_BUDGET_DEFAULT, STORE_ROOT, WINDOWED_THRESHOLD_VALUES,
    Handle, cleanup_all, get_handle, get_meta, get_status, new_token, set_status, stats,
)
