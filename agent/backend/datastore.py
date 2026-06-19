"""In-process cache of decoded EEG windows, keyed by a short data token.

The core parse/sample routes stash the decoded channel-major array here so the
agent's Python sandbox can analyse the *same* signal the user is viewing without
shipping megabytes back to the server. The cache is intentionally tiny and
process-local — it is a convenience for a single-user local research tool, not a
persistence layer. Nothing here is written to disk.
"""

from __future__ import annotations

import threading
import uuid
from collections import OrderedDict

import numpy as np

_LOCK = threading.Lock()
_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_MAX_ENTRIES = 3


def new_token() -> str:
    return uuid.uuid4().hex


def put_dataset(token: str, ch_major: np.ndarray, fs: float, labels, groups) -> None:
    """Cache one decoded window (most-recently-used eviction, cap _MAX_ENTRIES)."""
    entry = {
        "array": np.ascontiguousarray(ch_major, dtype=np.float32),
        "fs": float(fs),
        "labels": [str(x) for x in labels],
        "groups": [str(x) for x in groups],
    }
    with _LOCK:
        _CACHE[token] = entry
        _CACHE.move_to_end(token)
        while len(_CACHE) > _MAX_ENTRIES:
            _CACHE.popitem(last=False)


def get_dataset(token: str):
    if not token:
        return None
    with _LOCK:
        entry = _CACHE.get(token)
        if entry is not None:
            _CACHE.move_to_end(token)
        return entry
