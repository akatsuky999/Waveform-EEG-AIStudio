"""Pack a decoded EEG window into the binary envelope sent to the browser.

Envelope layout:

    [ uint32 LE  : JSON header length in bytes ]
    [ bytes      : UTF-8 JSON header (padded to a 4-byte boundary) ]
    [ float32 LE : waveform, channel-major     ]   nChannels * nSamples values

Channel-major layout (all samples of channel 0, then channel 1, ...) lets the
frontend slice each channel as a contiguous Float32Array view with no copying.

Decoding is split from packing so callers can also cache the decoded array (for
the agent's Python sandbox) without paying for a second decode.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass

import numpy as np

from .readers.edf import read_edf
from .readers.h5 import read_h5
from .util import group_of


@dataclass
class Decoded:
    """A decoded EEG window: channel-major float32 plus metadata."""

    kind: str
    ch_major: np.ndarray  # (n_channels, n_samples) float32
    labels: list[str]
    fs: float
    source_fs: list | None
    attrs: dict


def detect_kind(raw: bytes, file_name: str) -> str:
    if raw[:4] == b"\x89HDF":
        return "h5"
    head = raw[:8]
    if head[:1] == b"\xff" and raw[1:8] == b"BIOSEMI":
        return "edf"  # BDF
    if head[:1] == b"0":  # EDF version field is '0' + spaces
        return "edf"
    ext = file_name.lower().rsplit(".", 1)[-1] if "." in file_name else ""
    if ext in ("h5", "hdf5", "hdf"):
        return "h5"
    if ext in ("edf", "edf+", "bdf"):
        return "edf"
    raise ValueError("Unrecognised file type — expected an HDF5 (.h5) or EDF (.edf) file.")


def decode_window(raw: bytes, file_name: str) -> Decoded:
    """Decode an uploaded file into a channel-major float32 window + metadata."""
    kind = detect_kind(raw, file_name)
    if kind == "edf":
        ch_major, labels, fs, source_fs, attrs = read_edf(raw)
    else:
        ch_major, labels, fs, source_fs, attrs = read_h5(raw)
    ch_major = np.ascontiguousarray(ch_major, dtype=np.float32)
    return Decoded(kind, ch_major, labels, fs, source_fs, attrs)


def pack_envelope(d: Decoded, file_name: str, data_token: str | None = None) -> bytes:
    """Serialise a decoded window into the binary envelope."""
    n_channels, n_samples = d.ch_major.shape

    # Per-channel stats for client-side auto-scaling.
    stds = d.ch_major.std(axis=1)
    mins = d.ch_major.min(axis=1)
    maxs = d.ch_major.max(axis=1)
    means = d.ch_major.mean(axis=1)

    channels = [
        {
            "label": d.labels[i],
            "group": group_of(d.labels[i]),
            "std": float(stds[i]),
            "min": float(mins[i]),
            "max": float(maxs[i]),
            "mean": float(means[i]),
            "sourceFs": (d.source_fs[i] if d.source_fs and i < len(d.source_fs) else d.fs),
        }
        for i in range(n_channels)
    ]

    groups: list[str] = []
    for c in channels:
        if c["group"] not in groups:
            groups.append(c["group"])

    header = {
        "fileName": file_name,
        "kind": d.kind,
        "fs": d.fs,
        "nSamples": int(n_samples),
        "nChannels": int(n_channels),
        "durationSec": float(n_samples) / d.fs if d.fs else None,
        "dtype": "float32",
        "layout": "channelMajor",
        "channels": channels,
        "groups": groups,
        "globalStd": float(np.median(stds)) if stds.size else 1.0,
        "attrs": d.attrs,
    }
    if data_token:
        header["dataToken"] = data_token

    header_bytes = json.dumps(header).encode("utf-8")
    header_bytes += b" " * ((-len(header_bytes)) % 4)  # 4-byte align the payload
    payload = d.ch_major.astype("<f4").tobytes()
    return struct.pack("<I", len(header_bytes)) + header_bytes + payload


def build_envelope(raw: bytes, file_name: str, data_token: str | None = None) -> bytes:
    """Decode + pack in one step (kept for callers that don't need the array)."""
    return pack_envelope(decode_window(raw, file_name), file_name, data_token)
