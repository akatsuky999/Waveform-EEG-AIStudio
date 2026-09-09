"""Read-only, bounded preparation using the viewer's existing DSP implementation."""
from __future__ import annotations

import math
from collections import OrderedDict
import numpy as np

from .store.dsp import apply_filter, apply_montage, apply_diff

MAX_PROCESS_VALUES = 32_000_000


class ProcessedSignal:
    """Native-rate, read-only DSP slices for long recordings.

    A fixed tiling defines ONE processed signal, shared by every reference and
    candidate. Padded tiles are trimmed before concatenation. This is bounded
    local-context filtering, not exact whole-record FFT filtering.
    """
    ndim = 2

    def __init__(self, array, fs, meta, recipe, reference_samples, cancel):
        self.array, self.fs, self.meta, self.recipe, self.cancel = array, fs, meta, recipe, cancel
        self.padding = math.ceil(max(3.0, 3.0/recipe["filterLow"] if recipe["filterLow"] else 3.0)*fs)
        budget = min(MAX_PROCESS_VALUES, 8_000_000)
        # Includes quantization on both ends, query overlap, difference and pad.
        reserve = math.ceil(reference_samples*1.2)+recipe["diffOrder"]+2*self.padding
        self.max_scan_width = min(65_536, (budget//array.shape[0]-reserve)//3)
        if self.max_scan_width < 1:
            raise ValueError("Filter padding and channels exceed the bounded processing budget. Use a higher low cut, fewer source channels, or an unprocessed search.")
        _, derived = apply_montage(np.zeros((len(meta), 2), dtype=np.float32), meta, recipe["montage"])
        if not derived:
            raise ValueError("This montage produces no channels.")
        self.labels = [m["label"] for m in derived]
        self.shape = (len(derived), max(0, array.shape[1]-recipe["diffOrder"]))
        self.cache = OrderedDict()
        self.cache_size = max(2, min(16, budget//max(1,len(derived)*self.max_scan_width)))

    def __getitem__(self, index):
        channel, section = index
        start, stop, step = section.indices(self.shape[1])
        if step != 1:
            raise ValueError("Processed search requires contiguous native samples.")
        if self.cancel is not None and self.cancel.is_set():
            raise InterruptedError("Search cancelled.")
        stride = self.max_scan_width
        pieces = []
        for tile in range(start//stride, math.ceil(stop/stride)):
            block = self._tile(tile)
            origin = tile*stride
            pieces.append(block[channel, max(start-origin,0):min(stop-origin,stride)])
        return pieces[0] if len(pieces)==1 else np.concatenate(pieces) if pieces else np.empty(0,dtype=np.float32)

    def _tile(self, tile):
        if self.cancel is not None and self.cancel.is_set():
            raise InterruptedError("Search cancelled.")
        stride = self.max_scan_width
        origin = tile*stride
        left = max(0, origin-self.padding)
        right = min(self.array.shape[1], origin+stride+self.padding+self.recipe["diffOrder"])
        if tile not in self.cache:
            p = self.recipe
            block = np.asarray(self.array[:, left:right], dtype=np.float32)
            if not np.isfinite(block).all():
                raise ValueError("Processed search context contains missing samples. Narrow the range or search unprocessed signals.")
            block = apply_filter(block, self.fs, p["filterLow"], p["filterHigh"], int(p["notch"]) if p["notch"] != "off" else 0)
            block, _ = apply_montage(block, self.meta, p["montage"])
            block = apply_diff(block, p["diffOrder"])
            if self.cancel is not None and self.cancel.is_set():
                raise InterruptedError("Search cancelled.")
            # Copy trims away padded backing memory, making cache size a true bound.
            self.cache[tile] = block[:, origin-left:origin-left+stride].copy()
            if len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)
        self.cache.move_to_end(tile)
        return self.cache[tile]


def processing_spec(value):
    if not isinstance(value, dict):
        raise ValueError("processing must describe the current signal settings.")
    out = {}
    for key in ("filterLow", "filterHigh"):
        v = float(value.get(key, 0))
        if not math.isfinite(v) or v < 0:
            raise ValueError(f"Invalid {key}.")
        out[key] = v
    if out["filterHigh"] and out["filterLow"] >= out["filterHigh"]:
        raise ValueError("Low cut must be below high cut.")
    notch = str(value.get("notch", "off"))
    if notch not in ("0", "off", "50", "60"):
        raise ValueError("Invalid notch.")
    out["notch"] = "off" if notch in ("0", "off") else notch
    montage = value.get("montage", "raw")
    if montage not in ("raw", "bipolar", "car", "group-car", "local"):
        raise ValueError("Invalid montage.")
    out["montage"] = montage
    diff = float(value.get("diffOrder", 0))
    if not math.isfinite(diff) or not diff.is_integer() or not 0 <= diff <= 4:
        raise ValueError("Invalid difference order.")
    out["diffOrder"] = int(diff)
    norm = value.get("normalization", "none")
    if norm not in ("none", "zscore", "globalz", "minmax", "robust", "l2"):
        raise ValueError("Invalid normalization.")
    out["normalization"] = norm
    opts = value.get("normOpts", {})
    if not isinstance(opts, dict):
        raise ValueError("Invalid normalization options.")
    rob = float(opts.get("robLow", 25))
    if not math.isfinite(rob) or not 5 <= rob <= 45 or opts.get("mmRange", "sym") not in ("sym", "unit"):
        raise ValueError("Invalid normalization options.")
    out["normOpts"] = {"robLow": rob, "mmRange": opts.get("mmRange", "sym")}
    return out


def prepare(array, fs, labels, groups, spec, cancel):
    p = processing_spec(spec.get("processing", {}))
    if p["filterLow"] >= fs / 2:
        raise ValueError("Low cut must be below the native Nyquist frequency.")
    count, samples = array.shape
    # For ordinary recordings, use the same complete domain as the viewer.
    # Large recordings use ONE padded domain for reference AND all candidates;
    # never independently filter short query/candidate clips.
    left, right = 0, samples
    if count * samples > MAX_PROCESS_VALUES:
        low = p["filterLow"]
        padding = max(3.0, 3.0 / low if low > 0 else 3.0)
        values = [float(spec.get(k, default)) for k, default in
                  (("startSec", 0), ("endSec", 0), ("searchStartSec", 0), ("searchEndSec", samples / fs))]
        if not all(math.isfinite(v) and 0 <= v <= samples / fs for v in values):
            raise ValueError("Search and reference must be within the recording.")
        left = max(0, math.floor((min(values) - padding) * fs))
        right = min(samples, math.ceil((max(values) + padding) * fs))
        if count * (right - left) > MAX_PROCESS_VALUES:
            meta = [{"label": label, "group": groups[i]} for i, label in enumerate(labels)]
            signal = ProcessedSignal(array, fs, meta, p, max(8, round((values[1]-values[0])*fs)), cancel)
            shifted = dict(spec)
            shifted["searchEndSec"] = min(float(spec.get("searchEndSec", samples/fs)), signal.shape[1]/fs)
            return signal, signal.labels, shifted, 0, p, {
                "startSec": 0, "endSec": samples/fs, "wholeRecording": False,
                "strategy": "chunked-padded-native-dsp", "paddingSec": signal.padding/fs,
                "tileSamples": signal.max_scan_width,
                "note": "Long recording: one fixed, padded native-rate DSP tiling shared by reference and candidates. Not exact whole-recording FFT or viewport-edge equivalence; inspect tile boundaries in validation. Scan coverage reports visited positions, not the whole recording by default.",
            }
    if cancel is not None and cancel.is_set():
        raise InterruptedError("Search cancelled.")
    block = np.asarray(array[:, left:right], dtype=np.float32)
    if not np.isfinite(block).all():
        raise ValueError("Processed search context contains missing samples. Choose a finite range or search raw signals.")
    block = apply_filter(block, fs, p["filterLow"], p["filterHigh"], int(p["notch"]) if p["notch"] != "off" else 0)
    meta = [{"label": label, "group": groups[i]} for i, label in enumerate(labels)]
    block, meta = apply_montage(block, meta, p["montage"])
    if not len(meta):
        raise ValueError("This montage produces no channels.")
    block = apply_diff(block, p["diffOrder"])
    # All viewer normalization modes are per-channel positive affine transforms.
    # Z-normalized shape matching removes them exactly (including global Z).
    # Skipping this stage avoids statistics-domain differences on large files.
    shifted = dict(spec)
    for key, default in (("startSec", None), ("endSec", None), ("searchStartSec", 0), ("searchEndSec", samples / fs)):
        value = spec.get(key, default)
        if value is None:
            raise ValueError(f"{key} is required.")
        shifted[key] = float(value) - left / fs
    shifted["searchEndSec"] = min(shifted["searchEndSec"], block.shape[1] / fs)
    return block, [m["label"] for m in meta], shifted, left, p, {
        "startSec": left / fs, "endSec": right / fs,
        "wholeRecording": left == 0 and right == samples,
        "note": "Native-rate viewer filter → montage → difference; positive affine display scaling removed by shape normalization."
                + ("" if left == 0 and right == samples else " Padded local context: edge behavior may differ from another viewport or a decimated overview."),
    }
