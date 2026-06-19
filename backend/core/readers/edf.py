"""EDF / EDF+ / BDF reader → channel-major waveform + metadata (via pyedflib)."""

from __future__ import annotations

import os
import tempfile

import numpy as np

from ..util import to_str


def read_edf(raw: bytes):
    """Decode EDF / EDF+ / BDF.

    Channels with a lower sample rate (or an EDF+ annotations channel) are
    handled gracefully: annotation channels are dropped and any channel not at
    the dominant rate is linearly resampled so the frontend gets a uniform
    (n_ch, n_samp) matrix. -> (ch_major, labels, fs, source_fs, attrs).
    """
    import pyedflib  # imported lazily so HDF5-only installs still work

    tmp = tempfile.NamedTemporaryFile(suffix=".edf", delete=False)
    try:
        tmp.write(raw)
        tmp.close()
        reader = pyedflib.EdfReader(tmp.name)
        try:
            all_labels = [l.strip() for l in reader.getSignalLabels()]
            all_fs = [float(reader.getSampleFrequency(i)) for i in range(reader.signals_in_file)]
            all_n = [int(reader.getNSamples()[i]) for i in range(reader.signals_in_file)]

            keep = [
                i for i, lab in enumerate(all_labels)
                if lab.lower() not in ("edf annotations", "edf+ annotations") and all_n[i] > 0
            ]
            if not keep:
                raise ValueError("EDF file contains no signal channels.")

            target_n = max(all_n[i] for i in keep)
            target_fs = max(all_fs[i] for i in keep)

            ch_major = np.empty((len(keep), target_n), dtype=np.float32)
            for row, i in enumerate(keep):
                sig = np.asarray(reader.readSignal(i), dtype=np.float32)
                if sig.shape[0] != target_n:
                    xp = np.linspace(0.0, 1.0, sig.shape[0])
                    xq = np.linspace(0.0, 1.0, target_n)
                    sig = np.interp(xq, xp, sig).astype(np.float32)
                ch_major[row] = sig

            labels = [all_labels[i] or f"ch{i}" for i in keep]
            source_fs = [all_fs[i] for i in keep]

            attrs = {}
            try:
                start = reader.getStartdatetime()
                attrs["start"] = start.isoformat()
            except Exception:  # noqa: BLE001
                pass
            for getter, key in (
                (reader.getPatientCode, "patient"),
                (reader.getRecordingAdditional, "recording"),
                (reader.getEquipment, "equipment"),
            ):
                try:
                    val = getter()
                    if val:
                        attrs[key] = to_str(val).strip()
                except Exception:  # noqa: BLE001
                    pass
            attrs["file_duration_sec"] = float(reader.getFileDuration())
        finally:
            reader.close()
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    return ch_major, labels, target_fs, source_fs, attrs
