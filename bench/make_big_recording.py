#!/usr/bin/env python
"""Stream-write a large synthetic EEG recording (chunked HDF5) for scale tests.

Written one time-chunk at a time so the generator never holds the whole recording
in RAM — a multi-GB file is produced with a small footprint. Layout matches what
the store/reader expect: a 2-D ``data`` dataset shaped (n_samples, n_channels)
chunked along time, an ``fs_target`` attribute, and a ``channel_labels`` dataset.

A few "seizure-like" bursts (amplitude + gamma swell) are injected at known times
so the agent / feature index have something to find.

    python bench/make_big_recording.py --channels 256 --fs 1000 --minutes 60 --out /tmp/big.h5
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np


def channel_labels(n: int) -> list[str]:
    base = ["Fp1", "Fp2", "F3", "F4", "C3", "C4", "P3", "P4", "O1", "O2",
            "F7", "F8", "T3", "T4", "T5", "T6", "Fz", "Cz", "Pz", "A1", "A2"]
    out = []
    for i in range(n):
        stem = base[i % len(base)]
        out.append(stem if i < len(base) else f"{stem}-{i // len(base)}")
    return out


def seizure_windows(total_sec: float) -> list[tuple[float, float]]:
    return [(total_sec * frac, 18.0) for frac in (0.18, 0.52, 0.83)]


def make_recording(out_path: Path, n_channels: int, fs: int, minutes: float,
                   chunk_sec: float = 4.0, seed: int = 7) -> None:
    import h5py

    rng = np.random.default_rng(seed)
    n_samples = int(round(minutes * 60 * fs))
    chunk_samp = int(round(chunk_sec * fs))
    n_chunks = (n_samples + chunk_samp - 1) // chunk_samp
    seizures = seizure_windows(n_samples / fs)

    base_freqs = rng.uniform(1.0, 30.0, size=(n_channels, 4)).astype(np.float32)
    base_phase = rng.uniform(0, 2 * np.pi, size=(n_channels, 4)).astype(np.float32)
    base_amp = rng.uniform(8.0, 22.0, size=(n_channels, 4)).astype(np.float32)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(out_path, "w") as f:
        dset = f.create_dataset("data", shape=(n_samples, n_channels), dtype="float32",
                                chunks=(min(chunk_samp, n_samples), n_channels),
                                compression="gzip", compression_opts=1, shuffle=True)
        f.attrs["fs_target"] = float(fs)
        f.attrs["synthetic"] = True
        f.create_dataset("channel_labels", data=np.array(channel_labels(n_channels), dtype="S16"))

        for ci in range(n_chunks):
            s0, s1 = ci * chunk_samp, min((ci + 1) * chunk_samp, n_samples)
            t = (np.arange(s0, s1, dtype=np.float32) / fs)
            m = t.shape[0]
            block = np.zeros((m, n_channels), dtype=np.float32)
            for k in range(base_freqs.shape[1]):
                phase = 2 * np.pi * np.outer(t, base_freqs[:, k]) + base_phase[:, k]
                block += base_amp[:, k] * np.sin(phase).astype(np.float32)
            block += rng.standard_normal((m, n_channels)).astype(np.float32) * 6.0
            for onset, dur in seizures:
                if t[-1] < onset or t[0] > onset + dur:
                    continue
                mask = (t >= onset) & (t <= onset + dur)
                if not mask.any():
                    continue
                env = np.zeros(m, dtype=np.float32)
                env[mask] = (np.sin(np.pi * (t[mask] - onset) / dur) ** 2).astype(np.float32)
                gamma = np.sin(2 * np.pi * 40.0 * t).astype(np.float32)
                block[:, : n_channels // 3] += (env * gamma * 55.0)[:, None]
            dset[s0:s1, :] = block

    size_mb = out_path.stat().st_size / 1e6
    print(f"wrote {out_path}  ({n_channels} ch × {fs} Hz × {minutes} min, "
          f"{n_samples} samples, {size_mb:.0f} MB on disk)")


def _edf_field(s: str, n: int) -> bytes:
    return s[:n].ljust(n).encode("latin-1")


def make_edf(out_path: Path, n_channels: int, fs: int, minutes: float, seed: int = 7) -> None:
    """Stream-write a minimal valid EDF+ (record-by-record, bounded RAM) for testing
    the custom EDF reader / streaming-ingest path end to end."""
    rng = np.random.default_rng(seed)
    n_records = int(round(minutes * 60))            # 1-second data records (ddr=1)
    nsr, ddr = fs, 1
    p_min, p_max, d_min, d_max = -3200.0, 3200.0, -32768, 32767
    labels = channel_labels(n_channels)
    seizures = seizure_windows(n_records * ddr)
    base_f = rng.uniform(1, 30, (n_channels, 4)).astype(np.float32)
    base_a = rng.uniform(8, 22, (n_channels, 4)).astype(np.float32)
    scale = (d_max - d_min) / (p_max - p_min)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        header_bytes = 256 + n_channels * 256
        for v, n in [("0", 8), ("X", 80), ("synthetic", 80), ("01.01.24", 8), ("00.00.00", 8),
                     (str(header_bytes), 8), ("EDF+C", 44), (str(n_records), 8), (str(ddr), 8),
                     (str(n_channels), 4)]:
            f.write(_edf_field(v, n))

        def block(vals, n):
            for v in vals:
                f.write(_edf_field(str(v), n))
        block(labels, 16); block(["AgAgCl"] * n_channels, 80); block(["uV"] * n_channels, 8)
        block([int(p_min)] * n_channels, 8); block([int(p_max)] * n_channels, 8)
        block([d_min] * n_channels, 8); block([d_max] * n_channels, 8)
        block([""] * n_channels, 80); block([nsr] * n_channels, 8); block([""] * n_channels, 32)

        for r in range(n_records):
            t = r + np.arange(nsr, dtype=np.float32) / fs
            phys = np.zeros((n_channels, nsr), dtype=np.float32)
            for k in range(4):
                phys += base_a[:, k:k + 1] * np.sin(2 * np.pi * np.outer(base_f[:, k], t)).astype(np.float32)
            phys += rng.standard_normal((n_channels, nsr)).astype(np.float32) * 6.0
            for onset, dur in seizures:
                if onset <= t[0] <= onset + dur:
                    phys[: n_channels // 3] += (np.sin(2 * np.pi * 40 * t) * 55.0).astype(np.float32)
            digital = np.clip((phys - p_min) * scale + d_min, d_min, d_max).astype("<i2")
            f.write(digital.tobytes())
    print(f"wrote {out_path}  ({n_channels} ch × {fs} Hz × {minutes} min EDF, "
          f"{out_path.stat().st_size / 1e6:.0f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--channels", type=int, default=256)
    ap.add_argument("--fs", type=int, default=1000)
    ap.add_argument("--minutes", type=float, default=60.0)
    ap.add_argument("--chunk-sec", type=float, default=4.0)
    ap.add_argument("--format", choices=["h5", "edf"], default="h5")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    if args.format == "edf":
        make_edf(args.out, args.channels, args.fs, args.minutes)
    else:
        make_recording(args.out, args.channels, args.fs, args.minutes, args.chunk_sec)


if __name__ == "__main__":
    main()
