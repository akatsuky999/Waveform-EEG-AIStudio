"""Small shared helpers for decoding EEG files into a common shape."""

from __future__ import annotations

import json
import re

import numpy as np


def group_of(label: str) -> str:
    """Derive an electrode group from a channel label by stripping the trailing
    electrode number (``Ch10`` -> ``Ch``; ``PoC2'16`` -> ``PoC2'``). Also strips
    a common ``EEG ``/``POL `` prefix and a ``-REF`` style reference suffix."""
    s = label.strip()
    s = re.sub(r"^(EEG|POL|ECG|EMG|EOG)\s+", "", s, flags=re.I)
    s = re.sub(r"[-_](REF|LE|A1|A2|AVG)$", "", s, flags=re.I)
    s = re.sub(r"\d+$", "", s.strip())
    return s.strip() or label.strip()


def to_str(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def jsonable(value):
    """Make values JSON-serialisable (numpy / bytes / datetime)."""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, np.ndarray):
        return [jsonable(v) for v in value.tolist()]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    try:
        json.dumps(value)
        return value
    except TypeError:
        return str(value)
