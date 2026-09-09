"""Bounded local-shape DTW reranker, not an exhaustive DTW search or diagnosis.

Inspired by shapeDTW (Zhao & Itti, 2018): local descriptors constrain alignment.
Here descriptors combine normalized voltage and local slope; a Sakoe–Chiba
band and non-diagonal penalty limit pathological warping. The compact 128-point
representation is a deliberate reranking approximation, never the scan data.
"""
import math
import numpy as np
from scipy.signal import resample_poly


def descriptor(values, size=128):
    x = np.asarray(values, dtype=np.float64)
    x = x - x.mean()
    scale = np.max(np.abs(x))
    if scale <= 0 or not math.isfinite(scale):
        return np.zeros((size, 2))
    x /= scale
    divisor = math.gcd(x.size, size)
    x = resample_poly(x, size // divisor, x.size // divisor, padtype="line")[:size]
    x -= x.mean()
    x /= max(np.sqrt(np.mean(x*x)), 1e-12)
    slope = np.gradient(x)
    slope /= max(np.sqrt(np.mean(slope*slope)), 1e-12)
    return np.column_stack((x, .5 * slope))


def elastic_similarity(reference, candidate, radius=6):
    """Returns an uncalibrated [0,1] shape score; ~5% maximum local time shift."""
    n = len(reference)
    previous = np.full(n + 1, np.inf); previous[0] = 0.0
    for i in range(n):
        current = np.full(n + 1, np.inf)
        for j in range(max(0, i-radius), min(n, i+radius+1)):
            delta = reference[i] - candidate[j]
            cost = float(delta @ delta)
            current[j+1] = cost + min(previous[j], previous[j+1] + .08, current[j] + .08)
        previous = current
    return math.exp(-math.sqrt(max(0.0, previous[n]) / n))
