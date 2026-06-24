#!/usr/bin/env python
"""Reproducible eval harness for the out-of-core multiresolution signal store.

Generates synthetic recordings of increasing size, ingests each into the store,
and reports a markdown table demonstrating the data-system claims:

  • streaming ingest with a **bounded heap** (peak Python allocation ≪ file size),
  • **render payload constant** across zoom levels (M4/MinMax LoD),
  • fast `aggregate` / `search` queries, and
  • feature-`search` **vs. a naive raw scan** (the work the index avoids).

    python bench/run_bench.py                  # default size ladder
    python bench/run_bench.py --quick          # one small size
"""

from __future__ import annotations

import argparse
import sys
import time
import tracemalloc
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.core import store  # noqa: E402
from bench.make_big_recording import make_recording, seizure_windows  # noqa: E402

SIZES = [(32, 256, 5), (64, 500, 15), (128, 500, 30)]  # (channels, fs, minutes)


def _naive_scan_topk(handle, metric_idx: int = 2, k: int = 10):
    """Baseline `search` replaces: scan the RAW signal for the top-k 1s windows."""
    meta = handle.meta
    n_ch, n_samp = meta["nChannels"], meta["nSamples"]
    win = meta["features"]["windowSamples"]
    n_win = meta["features"]["nWindows"]
    best = np.full(k, -np.inf)
    ch_block = max(1, 48_000_000 // max(1, n_samp * 4))
    n_full = n_samp // win
    for c0 in range(0, n_ch, ch_block):
        c1 = min(c0 + ch_block, n_ch)
        blk = np.asarray(handle.raw[c0:c1, :], dtype=np.float32)
        if n_full:
            head = blk[:, : n_full * win].reshape(c1 - c0, n_full, win)
            p2p = head.max(axis=2) - head.min(axis=2)  # (cb, n_full)
            top = np.partition(p2p.ravel(), -k)[-k:]
            best = np.partition(np.concatenate([best, top]), -k)[-k:]
    return np.sort(best)[::-1]


def _hdr(tile: bytes) -> dict:
    import json
    hl = int.from_bytes(tile[:4], "little")
    return json.loads(tile[4:4 + hl])


def run(sizes):
    rows = []
    for (ch, fs, minutes) in sizes:
        tmp = Path(f"/tmp/bench_{ch}x{fs}x{int(minutes)}.h5")
        make_recording(tmp, ch, fs, minutes)
        raw_mb = ch * fs * minutes * 60 * 4 / 1e6

        tracemalloc.start()
        t = time.time()
        tok = store.ingest_h5(tmp, tmp.name)
        ingest_s = time.time() - t
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        peak_mb = peak / 1e6
        handle = store.get_handle(tok)
        meta = handle.meta
        dur = meta["durationSec"]

        payloads = []
        for span in (dur, dur / 4, 60, 10):
            a = max(0.0, dur / 2 - span / 2)
            _, tile = store.query(tok, {"op": "render", "startSec": a, "endSec": min(dur, a + span), "maxColumns": 1500})
            payloads.append(len(tile))
        pmin, pmax = min(payloads), max(payloads)

        t = time.time(); store.query(tok, {"op": "aggregate", "startSec": 0, "endSec": 30}); agg_ms = (time.time() - t) * 1000
        t = time.time(); res = store.query(tok, {"op": "search", "metric": "p2p", "limit": 10}); search_ms = (time.time() - t) * 1000
        t = time.time(); _naive_scan_topk(handle); scan_ms = (time.time() - t) * 1000

        # did search land on the injected seizures?
        seiz = [s for s, _ in seizure_windows(dur)]
        hits = sum(1 for w in res[1]["windows"] if any(abs(w["startSec"] - s) < 20 for s in seiz))

        rows.append({
            "size": f"{ch}ch×{fs}Hz×{int(minutes)}m", "rawMB": raw_mb, "ingestS": ingest_s,
            "peakMB": peak_mb, "ratio": peak_mb / raw_mb, "payloadKB": pmax / 1024,
            "payloadVar": pmax / max(1, pmin), "aggMs": agg_ms, "searchMs": search_ms,
            "scanMs": scan_ms, "speedup": scan_ms / max(1e-6, search_ms),
            "hits": f"{hits}/{len(res[1]['windows'])}",
        })
        tmp.unlink(missing_ok=True)

    print("\n## Out-of-core signal store — eval\n")
    print("| recording | raw | ingest | peak heap | heap/raw | render tile | payload Δ | aggregate | search | raw-scan | speedup | seizure hits |")
    print("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|")
    for r in rows:
        print(f"| {r['size']} | {r['rawMB']:.0f} MB | {r['ingestS']:.1f} s | {r['peakMB']:.0f} MB "
              f"| {r['ratio']:.2f}× | {r['payloadKB']:.0f} KB | {r['payloadVar']:.2f}× "
              f"| {r['aggMs']:.1f} ms | {r['searchMs']:.1f} ms | {r['scanMs']:.0f} ms "
              f"| {r['speedup']:.0f}× | {r['hits']} |")
    print("\nlegend: heap/raw ≪ 1 = streaming/out-of-core; payload Δ ≈ 1× = constant render "
          "payload across zoom; speedup = naive raw scan ÷ feature-index search.\n")
    print("cache:", store.stats())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="one small size only")
    args = ap.parse_args()
    store.cleanup_all()
    run(SIZES[:1] if args.quick else SIZES)


if __name__ == "__main__":
    main()
