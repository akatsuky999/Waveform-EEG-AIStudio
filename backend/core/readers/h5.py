"""HDF5 (.h5) reader → channel-major waveform + metadata."""

from __future__ import annotations

import io

import h5py
import numpy as np

from ..util import jsonable, to_str


def _find_waveform(f: h5py.File):
    if "data" in f and isinstance(f["data"], h5py.Dataset) and f["data"].ndim == 2:
        return f["data"]
    found = []

    def visit(_name, obj):
        if isinstance(obj, h5py.Dataset) and obj.ndim == 2 and np.issubdtype(obj.dtype, np.number):
            found.append(obj)

    f.visititems(visit)
    if not found:
        raise ValueError("No 2-D numeric dataset found in the HDF5 file.")
    return max(found, key=lambda d: d.size)


def _resolve_labels(f: h5py.File, n_channels: int):
    for key in ("channel_labels", "channels", "labels", "ch_names"):
        if key in f and isinstance(f[key], h5py.Dataset):
            labels = [to_str(v) for v in f[key][:].tolist()]
            if len(labels) == n_channels:
                return labels
    return [f"ch{i}" for i in range(n_channels)]


def _resolve_fs(f: h5py.File) -> float:
    for key in ("fs_target", "fs", "sampling_rate", "sfreq"):
        if key in f.attrs:
            try:
                return float(f.attrs[key])
            except (TypeError, ValueError):
                pass
    if "source_fs" in f and isinstance(f["source_fs"], h5py.Dataset):
        vals = np.asarray(f["source_fs"][:], dtype=float)
        if vals.size:
            return float(np.median(vals))
    return 256.0


def read_h5(raw: bytes):
    """-> (ch_major float32 (n_ch, n_samp), labels, fs, source_fs|None, attrs)."""
    with h5py.File(io.BytesIO(raw), "r") as f:
        dset = _find_waveform(f)
        data = np.asarray(dset[:], dtype=np.float32)  # (samples, channels)
        n_channels = data.shape[1]
        labels = _resolve_labels(f, n_channels)
        fs = _resolve_fs(f)
        attrs = {k: jsonable(v) for k, v in f.attrs.items()}
        source_fs = None
        if "source_fs" in f and isinstance(f["source_fs"], h5py.Dataset):
            source_fs = [float(x) for x in np.asarray(f["source_fs"][:], dtype=float).tolist()]
        ch_major = np.ascontiguousarray(data.T)
    return ch_major, labels, fs, source_fs, attrs
