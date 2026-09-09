"""Bounded, native-rate shape search over arrays or memory-mapped recordings.

Scores are sliding Pearson correlations, not amplitudes or probabilities.
Channel/time blocks are visited round-robin; partial coverage is explicit.
No source data, events, or feedback are mutated by this module.
"""
from __future__ import annotations

import heapq
import hashlib
import math
import time
from threading import Event

import numpy as np
from scipy.signal import correlate, find_peaks, resample_poly
from .morphology import descriptor, elastic_similarity
from .similarity_source import prepare

BLOCK_STARTS = 131_072
MAX_WINDOW_SAMPLES = 65_536
MAX_SCAN_VALUES = 32_000_000
MAX_SECONDS = 15.0
POOL_SIZE = 100
PREVIEW_SIZE = 128


def number(value, name):
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise ValueError(f"{name} must be a finite number.") from None
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number.")
    return result


def channel_index(value, count):
    n = number(value, "channel")
    if not n.is_integer() or not 0 <= n < count:
        raise ValueError("Channel index is out of range.")
    return int(n)


def shape_preview(values):
    values = np.asarray(values, dtype=np.float64)
    values = values - values.mean()
    scale = np.max(np.abs(values))
    if scale == 0:
        return [0.0] * PREVIEW_SIZE
    values = values / scale
    divisor = math.gcd(values.size, PREVIEW_SIZE)
    scaled = resample_poly(values, PREVIEW_SIZE // divisor, values.size // divisor, padtype="line")[:PREVIEW_SIZE]
    norm = np.sqrt(np.mean(scaled * scaled))
    if norm <= 1e-12:
        return [0.0] * PREVIEW_SIZE
    return np.round(scaled / norm, 5).tolist()


def correlations(values, template):
    """Correlation at EVERY valid sample offset, with finite/flat-window guards."""
    values = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(values)
    x = np.where(finite, values, 0.0)
    # Remove a block-level offset before cumulative variance to avoid cancellation.
    x -= np.mean(x)
    scale = np.max(np.abs(x))
    if scale > 0:
        x /= scale  # Keep variance guards independent of physical signal units.
    n = template.size
    sums = np.concatenate(([0.0], np.cumsum(x)))
    squares = np.concatenate(([0.0], np.cumsum(x * x)))
    sums = sums[n:] - sums[:-n]
    energy = np.maximum(0.0, squares[n:] - squares[:-n] - sums * sums / n)
    bad = np.concatenate(([0], np.cumsum(~finite)))
    valid = (bad[n:] == bad[:-n]) & (energy > 1e-12)
    denominator = np.sqrt(energy * np.dot(template, template))
    scores = np.full(energy.shape, -np.inf)
    dots = correlate(x, template, mode="valid", method="fft")
    np.divide(dots, denominator, out=scores, where=valid)
    scores[valid] = np.clip(scores[valid], -1.0, 1.0)
    return scores


def search(array, fs, labels, spec, cancel: Event | None = None, groups=None):
    started = time.monotonic()
    recording_shape = array.shape
    source = spec.get("source", "raw")
    if source not in ("raw", "processed"):
        raise ValueError("source must be raw or processed.")
    offset, processing, domain = 0, None, None
    if source == "processed":
        fs = number(fs, "sampling rate")
        if fs <= 0 or array.ndim != 2:
            raise ValueError("Invalid signal dataset.")
        groups = groups if groups is not None else [""] * len(labels)
        array, labels, spec, offset, processing, domain = prepare(array, fs, labels, groups, spec, cancel)
    result = _search(array, fs, labels, spec, cancel)
    result.update(source=source, processing=processing, processingDomain=domain)
    result["recording"] = {"samplingRate": float(fs), "channelCount": recording_shape[0], "sampleCount": recording_shape[1]}
    if offset:
        for item in [result["reference"], *result["matches"]]:
            for key in ("startSample", "endSample"): item[key] += offset
            for key in ("startSec", "endSec"): item[key] += offset / fs
            if "id" in item: item["id"] = f'{item["channel"]}:{item["startSample"]}:{item["endSample"]-item["startSample"]}'
        for key in ("searchStartSec", "searchEndSec"): result["coverage"][key] += offset / fs
        for item in result["coverage"]["channels"]:
            for key in ("startSec", "endSec"): item[key] += offset / fs
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    return result


def _search(array, fs, labels, spec, cancel: Event | None = None):
    started = time.monotonic()
    fs = number(fs, "sampling rate")
    if fs <= 0 or array.ndim != 2:
        raise ValueError("Invalid signal dataset.")
    count, samples = array.shape
    channel = channel_index(spec.get("channel"), count)
    if spec.get("referenceLabel") is not None and spec["referenceLabel"] != labels[channel]:
        raise ValueError("Reference channel no longer matches this montage. Wait for the view to update and capture the reference again.")
    start = number(spec.get("startSec"), "startSec")
    end = number(spec.get("endSec"), "endSec")
    if not 0 <= start < end <= samples / fs:
        raise ValueError("Reference must be within the recording.")
    a, b = int(round(start * fs)), int(round(end * fs))
    n = b - a
    if not 0.02 <= n / fs <= 10 or not 8 <= n <= MAX_WINDOW_SAMPLES:
        raise ValueError("Choose a reference of 0.02–10 seconds with at least 8 samples at the native sampling rate.")
    original = np.asarray(array[channel, a:b], dtype=np.float64)
    if not np.isfinite(original).all():
        raise ValueError("Reference contains missing or non-finite samples.")
    template = original - original.mean()
    scale = np.max(np.abs(template))
    if scale == 0:
        raise ValueError("Reference is flat. Select a waveform with variation.")
    template /= scale
    scope = spec.get("scope", "channel")
    if scope not in ("channel", "all"):
        raise ValueError("scope must be channel or all.")
    channels = list(range(count)) if scope == "all" else [channel]
    scan_start = number(spec.get("searchStartSec", 0), "searchStartSec")
    scan_end = number(spec.get("searchEndSec", samples / fs), "searchEndSec")
    if not 0 <= scan_start < scan_end <= samples / fs:
        raise ValueError("Search range must be within the recording.")
    lo, hi = int(round(scan_start * fs)), int(round(scan_end * fs))
    positions = hi - lo - n + 1
    if positions < 1:
        raise ValueError("Search range is shorter than the reference.")
    threshold = number(spec.get("minScore", 0.65), "minScore")
    if not 0.1 <= threshold <= 1:
        raise ValueError("minScore must be between 0.1 and 1.")
    polarity = spec.get("ignorePolarity", False)
    if not isinstance(polarity, bool):
        raise ValueError("ignorePolarity must be a boolean.")
    method = spec.get("method", "correlation")
    if method not in ("correlation", "elastic"):
        raise ValueError("method must be correlation or elastic.")
    elastic = method == "elastic"
    tolerance = number(spec.get("durationTolerance", 0), "durationTolerance")
    if tolerance not in (0, .2):
        raise ValueError("durationTolerance must be 0 or 0.2.")
    lengths = sorted({n, *([max(8, round(n * .8)), round(n * 1.2)] if tolerance else [])})
    lengths = [length for length in lengths if length <= min(MAX_WINDOW_SAMPLES, hi-lo) and .02 <= length/fs <= 10]
    templates = {}
    for length in lengths:
        if length == n:
            templates[length] = template
        else:
            divisor = math.gcd(n, length)
            stretched = resample_poly(template, length // divisor, n // divisor, padtype="line")[:length]
            templates[length] = stretched - stretched.mean()
    ref_n = n
    # Visit all channels of one length together to reuse bounded DSP domains.
    jobs = [(c, length) for length in lengths for c in channels]
    possible = {length: hi-lo-length+1 for length in lengths}
    retrieval = spec.get("retrieval", "threshold")
    if retrieval not in ("nearest", "threshold"):
        raise ValueError("retrieval must be nearest or threshold.")
    # A review queue must not silently equate an uncalibrated cutoff with absence.
    # Keep positively correlated candidates for nearest-neighbour review; report
    # threshold membership separately. The threshold API remains backwards compatible.
    candidate_threshold = 0.0 if retrieval == "nearest" else max(.1, threshold - .35) if elastic else threshold

    pool = []
    pool_cap = POOL_SIZE * 8
    scanned = {job: 0 for job in jobs}
    work = 0
    reason = None
    eligible_positions = 0
    block_starts = min(BLOCK_STARTS, getattr(array, "max_scan_width", BLOCK_STARTS))
    for offset in range(0, max(possible.values()), block_starts):
        for c, n in jobs:
            width = min(block_starts, possible[n] - offset)
            if width <= 0:
                continue
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Search cancelled.")
            if work + width + n - 1 > MAX_SCAN_VALUES:
                reason = "sample budget"
                break
            if time.monotonic() - started > MAX_SECONDS:
                reason = "time budget"
                break
            s = lo + offset
            block = array[c, s:s + width + n - 1]
            corr = correlations(block, templates[n])
            scores = np.where(np.isfinite(corr), np.abs(corr) if polarity else corr, -np.inf)
            # Exclude all overlapping windows on the reference channel.
            if c == channel:
                left = max(0, a - n + 1 - s)
                right = min(width, b - s)
                if right > left:
                    scores[left:right] = -np.inf
            eligible_positions += int(np.isfinite(scores).sum())
            peaks, _ = find_peaks(np.r_[-np.inf, scores, -np.inf], height=candidate_threshold,
                                  distance=max(1, n // 2))
            peaks -= 1
            if peaks.size > POOL_SIZE:
                peaks = peaks[np.argpartition(scores[peaks], -POOL_SIZE)[-POOL_SIZE:]]
            for p in peaks:
                entry = (float(scores[p]), c, s + int(p), float(corr[p]), n)
                if len(pool) < pool_cap:
                    heapq.heappush(pool, entry)
                elif entry > pool[0]:
                    heapq.heapreplace(pool, entry)
            scanned[c, n] += width
            work += width + n - 1
        if reason:
            break

    refinement_complete = True
    refined = []
    ref_shape = descriptor(original) if elastic else None
    for coarse, c, s, corr, n in sorted(pool, reverse=True):
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Search cancelled.")
        if elastic and time.monotonic() - started > MAX_SECONDS + 5:
            refinement_complete = False
            break
        shape = None
        if elastic:
            values = array[c, s:s + n]
            if polarity and corr < 0: values = -values
            shape = elastic_similarity(ref_shape, descriptor(values))
            # Noisy slopes used to demote high-correlation matches below the
            # threshold. Elastic alignment is additional evidence, not a veto
            # on a native-rate match. This remains an uncalibrated ranking score.
            score = max(coarse, .8 * shape + .2 * coarse)
        else:
            score = coarse
        if retrieval == "nearest" or score >= threshold:
            refined.append((score, c, s, corr, shape, n))

    # Greedy temporal suppression is channel-local; simultaneous different
    # channels remain useful evidence. Reference-channel overlap is excluded above.
    accepted = []
    occupied = {}
    previews_complete = True
    for score, c, s, corr, shape, n in sorted(refined, reverse=True):
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Search cancelled.")
        if time.monotonic()-started > MAX_SECONDS+10:
            previews_complete = False
            break
        if any(s < prev_end and s+n > prev_start for prev_start, prev_end in occupied.get(c, [])):
            continue
        occupied.setdefault(c, []).append((s, s+n))
        candidate = np.asarray(array[c, s:s+n], dtype=np.float64)
        preview = shape_preview(candidate)
        if polarity and corr < 0:
            preview = [-v for v in preview]
        accepted.append({
            "id": f"{c}:{s}:{n}", "channel": c, "label": labels[c],
            "startSec": s / fs, "endSec": (s + n) / fs,
            "startSample": s, "endSample": s + n,
            "score": round(score, 6), "correlation": round(corr, 6),
            "shapeScore": round(shape, 6) if shape is not None else None,
            "aboveThreshold": score >= threshold,
            "durationScale": round(n / ref_n, 4),
            "amplitudeRatio": round(float(np.ptp(candidate)) / float(np.ptp(original)), 4),
            "inverted": corr < 0, "preview": preview,
        })
        if len(accepted) == POOL_SIZE:
            break
    return {
        "version": 4, "method": "ncc-local-shape-dtw-v4" if elastic else "multiduration-normalized-correlation-v1" if tolerance else "native-rate-normalized-correlation-v1", "source": "raw",
        "retrieval": retrieval, "samplingRate": fs,
        "diagnostics": {"eligiblePositions": eligible_positions,
                        "returnedAboveThreshold": sum(m["aboveThreshold"] for m in accepted),
                        "bestReturnedScore": accepted[0]["score"] if accepted else None,
                        "emptyReason": None if accepted else "no-independent-valid-windows" if not eligible_positions else "below-threshold-or-no-positive-candidates"},
        "ranking": {"approximate": elastic or bool(tolerance), "durationScales": [round(length/ref_n,4) for length in lengths], "candidateThreshold": candidate_threshold,
                    "candidateLimit": pool_cap, "candidates": len(pool), "refinementComplete": refinement_complete, "previewsComplete": previews_complete,
                    "note": ("Native-rate correlation candidates → 128-point voltage/slope DTW, ±5% local alignment. Score=max(correlation, 80% elastic + 20% correlation); candidate-limited, not exhaustive DTW." if elastic else "Native-rate normalized correlation; bounded candidate pool.")
                            + (" Searches three window lengths (0.8×, 1×, 1.2× where valid), not a continuous duration sweep." if tolerance else " Fixed duration.")},
        "reference": {"channel": channel, "label": labels[channel], "startSec": a / fs,
                      "endSec": b / fs, "startSample": a, "endSample": b,
                      "fingerprint": {"algorithm": "sha256-float64le-selected-samples", "value": hashlib.sha256(original.astype("<f8").tobytes()).hexdigest(), "scope": "reference samples only, not a recording checksum"},
                      "preview": shape_preview(original)},
        "matches": accepted, "ignorePolarity": polarity, "minScore": threshold,
        "coverage": {
            "complete": reason is None, "reason": reason,
            "fraction": sum(scanned.values()) / sum(possible[length] for c, length in jobs),
            "searchStartSec": lo / fs, "searchEndSec": hi / fs,
            "channels": [{"channel": c, "windowSamples": length, "durationScale": round(length/ref_n,4), "startSec": lo / fs,
                          "endSec": (lo + scanned[c,length] + length - 1) / fs if scanned[c,length] else lo / fs,
                          "positions": scanned[c,length]} for c, length in jobs],
        },
        "poolLimit": POOL_SIZE, "elapsedMs": round((time.monotonic() - started) * 1000),
    }
