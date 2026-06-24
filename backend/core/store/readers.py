"""Streaming source readers for ingest — uniform interface over HDF5 and EDF.

Each reader exposes ``n_channels / n_samples / fs / labels`` and
``iter_chunks(chunk_samples) -> (s0, block(n_channels, m) float32 channel-major)``
so ``ingest.build_into`` is format-agnostic and never holds a whole recording.

The EDF reader is a custom 64-bit parser (pyedflib overflows on files >4 GB):
it clamps the record count to the real file size (truncated files), keeps signals
at the modal sample rate (drops annotation/off-rate channels), and scales
digital int16 → physical float32. Small EDF still uses the pyedflib full-read on
the legacy `/api/parse` path.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from ..util import group_of  # noqa: F401  (re-exported convenience for ingest)


def detect_kind(path: Path) -> str:
    with open(path, "rb") as f:
        head = f.read(8)
    if head[:4] == b"\x89HDF":
        return "h5"
    if head[:1] == b"\xff" or head[:1] == b"0":  # BDF (0xff BIOSEMI) or EDF ('0' version)
        return "edf"
    ext = path.suffix.lower().lstrip(".")
    if ext in ("h5", "hdf5", "hdf"):
        return "h5"
    if ext in ("edf", "edf+", "bdf"):
        return "edf"
    raise ValueError("Unrecognised file type — expected HDF5 or EDF/BDF.")


def open_source(path: Path):
    return H5Source(path) if detect_kind(path) == "h5" else EdfSource(path)


def peek_values(path: Path) -> int | None:
    try:
        src = open_source(path)
        try:
            return src.n_channels * src.n_samples
        finally:
            src.close()
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------- HDF5
def _find_2d_dataset(f):
    import h5py

    if "data" in f and isinstance(f["data"], h5py.Dataset) and f["data"].ndim == 2:
        return f["data"]
    found = []
    f.visititems(lambda _n, o: found.append(o)
                 if isinstance(o, h5py.Dataset) and o.ndim == 2 and np.issubdtype(o.dtype, np.number)
                 else None)
    if not found:
        raise ValueError("No 2-D numeric dataset found in the HDF5 file.")
    return max(found, key=lambda d: d.size)


class H5Source:
    def __init__(self, path: Path):
        import h5py

        self._f = h5py.File(path, "r")
        self._d = _find_2d_dataset(self._f)
        self.n_samples, self.n_channels = int(self._d.shape[0]), int(self._d.shape[1])
        self.fs = self._resolve_fs()
        self.labels = self._resolve_labels()

    def _resolve_fs(self) -> float:
        for key in ("fs_target", "fs", "sampling_rate", "sfreq"):
            if key in self._f.attrs:
                try:
                    return float(self._f.attrs[key])
                except (TypeError, ValueError):
                    pass
        return 256.0

    def _resolve_labels(self) -> list[str]:
        import h5py

        for key in ("channel_labels", "channels", "labels", "ch_names"):
            if key in self._f and isinstance(self._f[key], h5py.Dataset):
                raw = self._f[key][:].tolist()
                labels = [v.decode() if isinstance(v, bytes) else str(v) for v in raw]
                if len(labels) == self.n_channels:
                    return labels
        return [f"ch{i}" for i in range(self.n_channels)]

    def iter_chunks(self, chunk_samples: int):
        for s0 in range(0, self.n_samples, chunk_samples):
            s1 = min(s0 + chunk_samples, self.n_samples)
            yield s0, np.asarray(self._d[s0:s1, :], dtype=np.float32).T

    def close(self):
        try:
            self._f.close()
        except Exception:  # noqa: BLE001
            pass


# -------------------------------------------------------------------- EDF
_ANNOT_LABELS = ("edf annotations", "edf+ annotations", "bdf annotations")


class EdfSource:
    """Custom streaming EDF/EDF+ reader (any size; truncation- and mixed-fs-safe)."""

    def __init__(self, path: Path):
        self.path = path
        with open(path, "rb") as f:
            h = f.read(256)
            header_bytes = int(h[184:192])
            header_ndr = int(h[236:244])
            self.ddr = float(h[244:252])
            ns = int(h[252:256])
            sig = f.read(ns * 256)

        def col(off_units: int, width: int):
            base = off_units * ns
            return [sig[base + i * width: base + i * width + width] for i in range(ns)]

        labels_all = [b.decode("latin-1").strip() for b in col(0, 16)]
        nsr_all = [int(b) for b in col(216, 8)]
        phys_min = np.array([float(b) for b in col(104, 8)])
        phys_max = np.array([float(b) for b in col(112, 8)])
        dig_min = np.array([float(b) for b in col(120, 8)])
        dig_max = np.array([float(b) for b in col(128, 8)])

        record_size = sum(nsr_all) * 2  # bytes (int16)
        actual_ndr = (os.path.getsize(path) - header_bytes) // record_size
        ndr = actual_ndr if header_ndr <= 0 else min(header_ndr, actual_ndr)

        # A valid signal is non-annotation, positive rate, has a non-degenerate
        # *digital* range, and a sane full-scale amplitude. Note EDF allows an
        # **inverted** physical range (physMax < physMin = negative polarity), so we
        # must NOT require physMax > physMin — only reject degenerate/garbage headers
        # (e.g. digMax==digMin, or a corrupt phys range that scales to absurd values).
        def _valid(i: int) -> bool:
            if nsr_all[i] <= 0 or labels_all[i].lower() in _ANNOT_LABELS:
                return False
            if dig_max[i] == dig_min[i]:
                return False
            full_scale = abs((phys_max[i] - phys_min[i]) / (dig_max[i] - dig_min[i])) \
                * max(abs(dig_min[i]), abs(dig_max[i]))
            return 0 < full_scale < 1e7  # physiological signals are well under this

        candidates = [nsr_all[i] for i in range(ns) if _valid(i)]
        modal = max(set(candidates), key=candidates.count) if candidates else max(nsr_all)
        keep = [i for i in range(ns) if _valid(i) and nsr_all[i] == modal]

        # byte column offset of each signal within a record (over ALL signals)
        offsets = np.concatenate([[0], np.cumsum(nsr_all)])  # in samples

        self._header_bytes = header_bytes
        self._record_size = record_size
        self._ndr = int(ndr)
        self._modal = int(modal)
        self._keep = keep
        self._col_start = [int(offsets[i]) for i in keep]   # sample offset in a record row
        self.labels = [labels_all[i] for i in keep]
        # per-kept-channel digital→physical affine: value = digital*scale + offset
        denom = np.where((dig_max - dig_min) == 0, 1.0, (dig_max - dig_min))
        scale = (phys_max - phys_min) / denom
        offset = phys_min - dig_min * scale
        self._scale = scale[keep].astype(np.float32)
        self._offset = offset[keep].astype(np.float32)
        self._digmin = dig_min[keep].astype(np.float32)
        self._digmax = dig_max[keep].astype(np.float32)

        self.n_channels = len(keep)
        self.fs = self._modal / self.ddr if self.ddr else float(self._modal)
        self.n_samples = self._ndr * self._modal
        if self.n_channels == 0 or self.n_samples == 0:
            raise ValueError("EDF file has no usable signal channels.")

    def iter_chunks(self, chunk_samples: int):
        recs_per_chunk = max(1, chunk_samples // self._modal)
        row_len = self._record_size // 2  # int16 per record
        with open(self.path, "rb") as f:
            for r0 in range(0, self._ndr, recs_per_chunk):
                r1 = min(r0 + recs_per_chunk, self._ndr)
                f.seek(self._header_bytes + r0 * self._record_size)
                buf = f.read((r1 - r0) * self._record_size)
                recs = np.frombuffer(buf, dtype="<i2").reshape(r1 - r0, row_len)
                block = np.empty((self.n_channels, (r1 - r0) * self._modal), dtype=np.float32)
                for ci, cs in enumerate(self._col_start):
                    digital = recs[:, cs: cs + self._modal].astype(np.float32)  # (recs, modal)
                    np.clip(digital, self._digmin[ci], self._digmax[ci], out=digital)
                    block[ci] = (digital * self._scale[ci] + self._offset[ci]).reshape(-1)
                yield r0 * self._modal, block

    def close(self):
        pass
