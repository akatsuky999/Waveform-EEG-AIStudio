"""Sandbox worker — runs model-written Python against one EEG window.

Launched as a separate process by ``sandbox.py`` (never imported into the
server). It loads the decoded window, exposes a small analysis namespace
(numpy / scipy / the signal as ``data``), executes the user code, and writes a
JSON result + an optional figure into the work directory. Resource limits are a
best-effort backstop; the real guardrail is the parent's wall-clock timeout.

Work directory contract (all paths relative to argv[1]):
    _data.npy   float32 array, shape (n_channels, n_samples)
    _meta.json  {fs, labels, groups, limits:{cpuSeconds, addressBytes}}
    _code.py    the user code to exec
    -> _out.json  {ok, error, result, eventCandidates}
    -> _fig.png   optional, only if the code produced a matplotlib figure
"""

from __future__ import annotations

import json
import math
import os
import sys
import traceback

WORKDIR = sys.argv[1] if len(sys.argv) > 1 else "."
MAX_ARRAY_VALUES = 4096
MAX_LIST = 2000
MAX_DICT_KEYS = 300


def _sanitize(value, depth=0):
    if depth > 6:
        return str(value)[:200]
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    try:
        import numpy as np
    except Exception:  # noqa: BLE001
        np = None
    if np is not None:
        if isinstance(value, np.integer):
            return int(value)
        if isinstance(value, np.floating):
            f = float(value)
            return f if math.isfinite(f) else None
        if isinstance(value, np.bool_):
            return bool(value)
        if isinstance(value, np.ndarray):
            flat = value.ravel()
            vals = [_sanitize(x, depth + 1) for x in flat[:MAX_ARRAY_VALUES].tolist()]
            return {
                "_ndarray": True,
                "shape": list(value.shape),
                "dtype": str(value.dtype),
                "values": vals,
                "truncated": bool(flat.size > MAX_ARRAY_VALUES),
            }
    if isinstance(value, dict):
        return {str(k): _sanitize(v, depth + 1) for k, v in list(value.items())[:MAX_DICT_KEYS]}
    if isinstance(value, (list, tuple)):
        return [_sanitize(v, depth + 1) for v in list(value)[:MAX_LIST]]
    try:
        f = float(value)
        return f if math.isfinite(f) else None
    except Exception:  # noqa: BLE001
        return str(value)[:500]


def _apply_limits(limits):
    try:
        import resource
    except Exception:  # noqa: BLE001 - not POSIX
        return
    cpu = int(limits.get("cpuSeconds") or 0)
    if cpu > 0:
        try:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
        except (ValueError, OSError):
            pass
    addr = int(limits.get("addressBytes") or 0)
    if addr > 0:
        for name in ("RLIMIT_AS", "RLIMIT_DATA"):
            limit = getattr(resource, name, None)
            if limit is None:
                continue
            try:
                resource.setrlimit(limit, (addr, addr))
            except (ValueError, OSError):
                pass


def _write_out(payload):
    path = os.path.join(WORKDIR, "_out.json")
    try:
        text = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError):
        text = json.dumps({"ok": False, "error": "Result was not JSON-serialisable."})
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def main():
    os.environ.setdefault("MPLBACKEND", "Agg")
    import numpy as np

    with open(os.path.join(WORKDIR, "_meta.json"), encoding="utf-8") as handle:
        meta = json.load(handle)
    with open(os.path.join(WORKDIR, "_code.py"), encoding="utf-8") as handle:
        code = handle.read()

    data = np.load(os.path.join(WORKDIR, "_data.npy"))  # (n_channels, n_samples)
    fs = float(meta.get("fs") or 256.0)
    labels = list(meta.get("labels") or [])
    groups = list(meta.get("groups") or [])
    n_channels, n_samples = (data.shape if data.ndim == 2 else (1, data.shape[0]))
    # For a large recording `data` is only the requested window; these absolute
    # bounds let model-written code map local samples back to recording time.
    window_start_sec = float(meta.get("window_start_sec") or 0.0)
    raw_window_end_sec = meta.get("window_end_sec")
    try:
        window_end_sec = float(raw_window_end_sec)
    except (TypeError, ValueError):
        window_end_sec = window_start_sec + (n_samples / fs if fs else float(n_samples))
    window_duration_sec = max(0.0, window_end_sec - window_start_sec)

    def find_channel(ref):
        if isinstance(ref, (int, np.integer)) and 0 <= int(ref) < n_channels:
            return int(ref)
        text = str(ref).strip().lower()
        for i, label in enumerate(labels):
            if label.lower() == text:
                return i
        for i, label in enumerate(labels):
            if text and text in label.lower():
                return i
        raise ValueError(f"Channel not found: {ref!r}")

    event_candidates: list = []
    result: dict = {}
    workspace = meta.get("workspace") if isinstance(meta.get("workspace"), dict) else {}
    # Be forgiving about how the model reaches for metadata: the structured state
    # nests the sampling rate under workspace['file'], but models routinely guess
    # flat keys like workspace['samplingRateHz']. Lift file.* to the top level and
    # add convenient aliases so reasonable guesses resolve instead of KeyError.
    if isinstance(workspace, dict):
        file_meta = workspace.get("file") if isinstance(workspace.get("file"), dict) else {}
        for key, val in file_meta.items():
            workspace.setdefault(key, val)
        workspace.setdefault("samplingRateHz", fs)
        workspace.setdefault("fs", fs)
        workspace.setdefault("labels", labels)
        workspace.setdefault("groups", groups)
        workspace.setdefault("nChannels", n_channels)
        workspace.setdefault("nSamples", n_samples)
        workspace.setdefault("startSec", window_start_sec)
        workspace.setdefault("endSec", window_end_sec)
        workspace.setdefault("durationSec", window_duration_sec)
        workspace.setdefault("windowStartSec", window_start_sec)
        workspace.setdefault("windowEndSec", window_end_sec)
        workspace.setdefault("executionWindow", {
            "startSec": window_start_sec,
            "endSec": window_end_sec,
            "durationSec": window_duration_sec,
        })
        if "channels" not in workspace and isinstance(workspace.get("visibleChannels"), list):
            workspace["channels"] = workspace["visibleChannels"]

    namespace = {
        "__name__": "__sandbox__",
        "np": np,
        "numpy": np,
        "data": data,
        "fs": fs,
        "labels": labels,
        "groups": groups,
        "n_channels": n_channels,
        "n_samples": n_samples,
        "t": np.arange(n_samples) / fs if fs else np.arange(n_samples),
        "startSec": window_start_sec,
        "endSec": window_end_sec,
        "durationSec": window_duration_sec,
        "window_start_sec": window_start_sec,
        "window_end_sec": window_end_sec,
        "window_duration_sec": window_duration_sec,
        "t_abs": (window_start_sec + np.arange(n_samples) / fs) if fs else np.arange(n_samples),
        "find_channel": find_channel,
        "workspace": workspace,
        "event_candidates": event_candidates,
        "markers": event_candidates,
        "result": result,
    }
    # Models write code blind (they cannot introspect the namespace first), so
    # they reach for the variable names they learned from MNE / common EEG code
    # (n_ch, n_samp, sfreq, ch_names, …). Expose those as aliases of the canonical
    # globals so reasonable guesses resolve instead of NameError on line 1.
    for _alias, _value in {
        "n_ch": n_channels, "nch": n_channels, "n_chan": n_channels, "nchan": n_channels,
        "n_channel": n_channels, "num_channels": n_channels,
        "n_samp": n_samples, "nsamp": n_samples, "n_sample": n_samples,
        "num_samples": n_samples, "n_times": n_samples, "n_samps": n_samples,
        "sfreq": fs, "sr": fs, "srate": fs, "sample_rate": fs, "sampling_rate": fs, "Fs": fs,
        "ch_names": labels, "channel_labels": labels, "ch_labels": labels,
        "signals": data, "eeg": data,
        "start_sec": window_start_sec, "end_sec": window_end_sec,
        "duration_sec": window_duration_sec,
    }.items():
        namespace.setdefault(_alias, _value)
    try:
        import scipy  # noqa: F401
        from scipy import signal as _signal

        namespace["scipy"] = scipy
        namespace["signal"] = _signal
    except Exception:  # noqa: BLE001 - scipy optional at runtime
        pass

    _apply_limits(meta.get("limits") or {})

    try:
        compiled = compile(code, "<eeg-sandbox>", "exec")
        exec(compiled, namespace)  # noqa: S102 - intentionally runs in a separate local subprocess
    except BaseException:  # noqa: BLE001 - report any failure, incl. limit kills
        sys.stdout.flush()
        _write_out({"ok": False, "error": traceback.format_exc(limit=8)})
        return

    # The code may have reassigned result/candidate variables in its own scope.
    out_result = namespace.get("result", result)
    out_candidates = namespace.get("event_candidates", event_candidates)
    legacy_candidates = namespace.get("markers", event_candidates)
    if out_candidates is event_candidates and legacy_candidates is not event_candidates:
        out_candidates = legacy_candidates

    saved_figure = False
    try:
        import matplotlib

        if "matplotlib.pyplot" in sys.modules:
            plt = sys.modules["matplotlib.pyplot"]
            if plt.get_fignums():
                plt.savefig(os.path.join(WORKDIR, "_fig.png"), dpi=110, bbox_inches="tight")
                saved_figure = True
        _ = matplotlib  # silence unused in the no-figure path
    except Exception:  # noqa: BLE001 - figures are optional
        pass

    sys.stdout.flush()
    _write_out({
        "ok": True,
        "error": None,
        "result": _sanitize(out_result),
        "eventCandidates": _sanitize(out_candidates) if isinstance(out_candidates, list) else [],
        "figure": saved_figure,
    })


if __name__ == "__main__":
    try:
        main()
    except BaseException:  # noqa: BLE001
        _write_out({"ok": False, "error": traceback.format_exc(limit=8)})
