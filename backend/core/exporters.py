"""Image, batch, HDF5, and EDF+ export helpers."""

from __future__ import annotations

import csv
import base64
import io
import json
import math
import os
import re
import tempfile
import zipfile
from pathlib import Path

import h5py
import numpy as np


TRAINING_COLORS = ["#4455ff", "#ff5b52", "#52ad4b", "#b04fbd", "#4baebb", "#df963b"]
MAX_BATCH_WINDOWS = 500
MIN_IMAGE_WIDTH = 320
MAX_IMAGE_WIDTH = 8192
MIN_IMAGE_HEIGHT = 240
MAX_IMAGE_HEIGHT = 8192
MIN_CHANNEL_ROW_HEIGHT = 16
MAX_CHANNEL_ROW_HEIGHT = 96
MIN_LABEL_FONT_SIZE_PX = 6
MAX_LABEL_FONT_SIZE_PX = 32
MAX_AGENT_IMAGES = 5
MAX_AGENT_IMAGE_BYTES = 4 * 1024 * 1024
MAX_AGENT_IMAGE_SET_BYTES = 12 * 1024 * 1024
MAX_AGENT_IMAGE_WIDTH = 2048
MAX_AGENT_IMAGE_HEIGHT = 4096


def decode_export_array(raw: bytes, config: dict) -> np.ndarray:
    n_channels = int(config.get("nChannels") or 0)
    n_samples = int(config.get("nSamples") or 0)
    if n_channels <= 0 or n_samples <= 0:
        raise ValueError("nChannels and nSamples must be positive.")
    values = np.frombuffer(raw, dtype="<f4")
    expected = n_channels * n_samples
    if values.size != expected:
        raise ValueError(f"Signal payload has {values.size} values; expected {expected}.")
    # np.frombuffer(bytes) is read-only. Rendering uses in-place sanitisation
    # for speed, so make one owned, writable C-contiguous copy at the boundary.
    return np.array(values.reshape(n_channels, n_samples), dtype=np.float32, order="C", copy=True)


def export_images(data: np.ndarray, config: dict) -> tuple[bytes, str, str]:
    mode = str(config.get("mode") or "single")
    if mode == "batch":
        return _export_image_batch(data, config), _stem(config) + "-training.zip", "application/zip"
    start, end = _time_range(config, data.shape[1])
    return _render_png(data, config, start, end), _stem(config) + f"-{config.get('style', 'viewer')}.png", "image/png"


def render_image_set(data: np.ndarray, config: dict) -> dict:
    """Render a bounded set of model-readable PNGs in one request."""
    views = config.get("views")
    if not isinstance(views, list) or not views:
        raise ValueError("views must be a non-empty array.")
    if len(views) > MAX_AGENT_IMAGES:
        raise ValueError(f"Agent image sets are limited to {MAX_AGENT_IMAGES} images.")
    fs = _fs(config)
    duration = data.shape[1] / fs
    all_labels = _labels(config, data.shape[0])
    all_colors = _colors(config, data.shape[0])
    images = []
    total_bytes = 0
    for position, raw_view in enumerate(views):
        if not isinstance(raw_view, dict):
            raise ValueError("Each image view must be an object.")
        try:
            start = float(raw_view.get("startSec"))
            end = float(raw_view.get("endSec"))
        except (TypeError, ValueError) as exc:
            raise ValueError("Each image view needs numeric startSec/endSec.") from exc
        if not math.isfinite(start) or not math.isfinite(end):
            raise ValueError("Image view times must be finite.")
        start = max(0.0, min(duration, start))
        end = max(0.0, min(duration, end))
        if end <= start:
            raise ValueError("Each image view must have endSec > startSec.")
        raw_indices = raw_view.get("channelIndices")
        if raw_indices is None:
            indices = list(range(data.shape[0]))
        elif isinstance(raw_indices, list):
            indices = []
            for value in raw_indices:
                try:
                    index = int(value)
                except (TypeError, ValueError):
                    continue
                if 0 <= index < data.shape[0] and index not in indices:
                    indices.append(index)
        else:
            raise ValueError("channelIndices must be an array.")
        if not indices:
            raise ValueError("Each image view needs at least one valid channel.")
        view_config = {
            **config,
            "labels": [all_labels[index] for index in indices],
            "colors": [all_colors[index] for index in indices],
        }
        width, height, _ = _image_dimensions(
            view_config, len(indices), str(config.get("style") or "viewer"),
            bool(config.get("showEvents", str(config.get("style") or "viewer") == "viewer")),
        )
        if width > MAX_AGENT_IMAGE_WIDTH or height > MAX_AGENT_IMAGE_HEIGHT:
            raise ValueError(
                f"Agent images are limited to {MAX_AGENT_IMAGE_WIDTH}x{MAX_AGENT_IMAGE_HEIGHT}px; "
                "reduce dimensions, row height, or channel count."
            )
        png = _render_png(np.ascontiguousarray(data[indices]), view_config, start, end)
        if len(png) > MAX_AGENT_IMAGE_BYTES:
            raise ValueError(
                f"Rendered image {position + 1} exceeds the {MAX_AGENT_IMAGE_BYTES // (1024 * 1024)} MiB agent limit; "
                "reduce dimensions or channel count."
            )
        total_bytes += len(png)
        if total_bytes > MAX_AGENT_IMAGE_SET_BYTES:
            raise ValueError("Rendered image set is too large; reduce dimensions, channels, or image count.")
        images.append({
            "index": position,
            "role": str(raw_view.get("role") or "detail"),
            "batchIndex": raw_view.get("batchIndex"),
            "startSec": round(start, 6),
            "endSec": round(end, 6),
            "channels": [all_labels[index] for index in indices],
            "width": width,
            "height": height,
            "mimeType": "image/png",
            "dataUrl": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        })
    return {"version": 1, "imageCount": len(images), "totalBytes": total_bytes, "images": images}


def _render_png(data: np.ndarray, config: dict, start_sec: float, end_sec: float) -> bytes:
    mpl_cache = Path(tempfile.gettempdir()) / "eegviewer-matplotlib"
    mpl_cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(mpl_cache))
    os.environ.setdefault("XDG_CACHE_HOME", str(mpl_cache))
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure

    fs = _fs(config)
    start_i = max(0, min(data.shape[1] - 1, int(math.floor(start_sec * fs))))
    end_i = max(start_i + 1, min(data.shape[1], int(math.ceil(end_sec * fs))))
    segment = data[:, start_i:end_i]
    n_channels = segment.shape[0]
    style = str(config.get("style") or "viewer")
    show_labels = bool(config.get("showLabels", style == "viewer"))
    show_events = bool(config.get("showEvents", style == "viewer"))
    width, height, _ = _image_dimensions(config, n_channels, style, show_events)
    label_font_px = _bounded_int(
        config.get("labelFontSizePx"), 12, MIN_LABEL_FONT_SIZE_PX, MAX_LABEL_FONT_SIZE_PX
    )
    labels = _labels(config, n_channels)
    background = str(config.get("background") or "#ffffff")
    transparent = background.lower() == "transparent"
    face = "none" if transparent else background
    dpi = 100
    figure = Figure(figsize=(width / dpi, height / dpi), dpi=dpi, facecolor=face)
    FigureCanvasAgg(figure)
    top_px, bottom_px = _vertical_chrome(style, show_events)
    left_px = _label_gutter(labels, width, label_font_px) if show_labels else 12
    right_px = 16
    left = left_px / width
    bottom = bottom_px / height
    plot_width = max(1, width - left_px - right_px) / width
    plot_height = max(1, height - top_px - bottom_px) / height
    axes = figure.add_axes([left, bottom, plot_width, plot_height], facecolor=face)
    axes.patch.set_alpha(0 if transparent else 1)

    colors = _colors(config, n_channels)
    sample_count = segment.shape[1]
    stride = max(1, int(math.ceil(sample_count / max(width * 2, 1))))
    times = start_sec + np.arange(0, sample_count, stride, dtype=float) / fs
    stds = np.nanstd(segment, axis=1)
    scale_ref = float(np.nanmedian(stds[stds > 0])) if np.any(stds > 0) else 1.0
    amplitude_scale = 0.32 / max(scale_ref, 1e-12)
    line_width = float(config.get("lineWidth") or (0.65 if style == "training" else 0.8))
    baselines = np.arange(n_channels - 1, -1, -1, dtype=float)
    for row in range(n_channels):
        signal = np.nan_to_num(segment[row, ::stride], copy=False)
        axes.plot(times[: signal.size], baselines[row] + signal * amplitude_scale,
                  color=colors[row], linewidth=line_width, solid_joinstyle="round", solid_capstyle="round")

    axes.set_xlim(start_sec, max(start_sec + 1 / fs, end_sec))
    axes.set_ylim(-0.5, max(0.5, n_channels - 0.5))
    # Matplotlib consumes typographic points. Convert the requested output
    # pixels at the renderer's fixed DPI so label glyphs stay the same raster
    # size when image dimensions or channel count change.
    label_font_size = label_font_px * 72.0 / dpi
    if style == "training":
        for spine in axes.spines.values():
            spine.set_visible(False)
        axes.set_xticks([])
        axes.tick_params(axis="x", which="both", bottom=False, labelbottom=False)
        if show_labels:
            axes.set_yticks(baselines, labels=labels, fontsize=label_font_size)
            axes.tick_params(axis="y", colors="#272520", length=0, pad=4)
        else:
            axes.set_yticks([])
    else:
        axes.spines[["top", "right"]].set_visible(False)
        axes.spines[["left", "bottom"]].set_color("#d9d5cb")
        axes.tick_params(axis="both", colors="#6b6862", labelsize=7, length=2)
        axes.grid(bool(config.get("showGrid", True)), axis="x", color="#ece9df", linewidth=0.55)
        axes.set_xlabel("time (s)", fontsize=7, color="#6b6862")
        if show_labels:
            axes.set_yticks(baselines, labels=labels, fontsize=label_font_size)
        else:
            axes.set_yticks([])

    window_events = _events_for_window(config.get("events") or [], start_sec, end_sec, relative=False)
    if style == "training" and show_events:
        for event in window_events:
            axes.axvline(event["onsetSec"], color="#c75f3e", linewidth=0.55, alpha=0.75)
            if event["type"] == "interval":
                axes.axvline(event["offsetSec"], color="#c75f3e", linewidth=0.55, alpha=0.75)
            axes.text(event["onsetSec"], n_channels - 0.55, event["label"], color="#8f422d", fontsize=6,
                      ha="left", va="top", clip_on=True)
    if style == "viewer" and show_events:
        track = figure.add_axes([left, (height - 88) / height, plot_width, 70 / height], facecolor=face)
        track.patch.set_alpha(0 if transparent else 1)
        _draw_event_track(track, window_events, start_sec, end_sec)

    output = io.BytesIO()
    figure.savefig(output, format="png", dpi=dpi, facecolor=figure.get_facecolor(), transparent=transparent)
    return output.getvalue()


def _image_dimensions(config: dict, n_channels: int, style: str, show_events: bool) -> tuple[int, int, int]:
    width = _bounded_int(config.get("width"), 1600, MIN_IMAGE_WIDTH, MAX_IMAGE_WIDTH)
    requested_height = _bounded_int(config.get("height"), 1200, MIN_IMAGE_HEIGHT, MAX_IMAGE_HEIGHT)
    row_height = _bounded_int(config.get("rowHeight"), 32, MIN_CHANNEL_ROW_HEIGHT, MAX_CHANNEL_ROW_HEIGHT)
    if bool(config.get("autoHeight", False)):
        top_px, bottom_px = _vertical_chrome(style, show_events)
        requested_height = n_channels * row_height + top_px + bottom_px
    height = max(MIN_IMAGE_HEIGHT, min(MAX_IMAGE_HEIGHT, requested_height))
    return width, height, row_height


def _vertical_chrome(style: str, show_events: bool) -> tuple[int, int]:
    if style == "viewer":
        return (106 if show_events else 14), 42
    return 14, 14


def _label_gutter(labels: list[str], width: int, label_font_px: int) -> int:
    # Reserve enough room for montage names without letting pathological labels
    # consume the waveform. The renderer still clips labels at the figure edge.
    longest = max((len(label) for label in labels), default=4)
    estimated = 18 + longest * label_font_px * 0.58
    return int(max(58, min(220, width * 0.3, estimated)))


def _draw_event_track(axes, events: list[dict], start_sec: float, end_sec: float) -> None:
    axes.set_xlim(start_sec, end_sec)
    axes.set_ylim(0, 3)
    axes.set_axis_off()
    occupied: list[list[tuple[float, float]]] = [[], [], []]
    span = max(end_sec - start_sec, 1e-9)
    for event in events:
        onset = max(start_sec, event["onsetSec"])
        offset = min(end_sec, event.get("offsetSec") or onset)
        label_width = min(span * 0.22, max(span * 0.025, len(event["label"]) * span * 0.006))
        center = (onset + offset) / 2 if event["type"] == "interval" else onset + label_width / 2
        interval = (center - label_width / 2, center + label_width / 2)
        lane = next((idx for idx, ranges in enumerate(occupied)
                     if all(interval[1] < low or interval[0] > high for low, high in ranges)), None)
        y = 2.5 - (lane if lane is not None else 1)
        if event["type"] == "interval":
            axes.plot([onset, onset, offset, offset], [y - .28, y + .25, y + .25, y - .28],
                      color="#c75f3e", linewidth=.75)
        else:
            axes.plot([onset, onset], [y - .32, y + .32], color="#c75f3e", linewidth=.75)
            axes.plot([onset, onset + span * .009], [y + .32, y + .18], color="#c75f3e", linewidth=.75)
        if lane is not None:
            occupied[lane].append(interval)
            axes.text(center, y, event["label"], fontsize=6.2, color="#1a1915", ha="center", va="center", clip_on=True)


def _export_image_batch(data: np.ndarray, config: dict) -> bytes:
    start, end = _time_range(config, data.shape[1])
    window = _positive_finite(config.get("windowSec"), 10.0, "windowSec")
    step = _positive_finite(config.get("stepSec"), window, "stepSec")
    include_partial = bool(config.get("includePartial", True))
    windows = []
    cursor = start
    while cursor < end - 1e-9:
        stop = min(end, cursor + window)
        if stop - cursor < window - 1e-9 and not include_partial:
            break
        if len(windows) >= MAX_BATCH_WINDOWS:
            raise ValueError(f"Batch export is limited to {MAX_BATCH_WINDOWS} image windows; increase the step size.")
        windows.append((cursor, stop))
        cursor += step
    if not windows:
        raise ValueError("Batch settings produced no image windows.")

    manifest_rows = []
    labels = _labels(config, data.shape[0])
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for index, (window_start, window_end) in enumerate(windows):
            name = f"images/window_{index:05d}_{window_start:.3f}_{window_end:.3f}.png"
            archive.writestr(name, _render_png(data, config, window_start, window_end))
            events = _events_for_window(config.get("events") or [], window_start, window_end, relative=False)
            manifest_rows.append({
                "index": index,
                "file": name,
                "startSec": round(window_start, 6),
                "endSec": round(window_end, 6),
                "durationSec": round(window_end - window_start, 6),
                "channels": labels,
                "processing": config.get("provenance") or {},
                "events": events,
            })
        archive.writestr("manifest.json", json.dumps({"version": 1, "windows": manifest_rows}, ensure_ascii=False, indent=2))
        csv_output = io.StringIO()
        writer = csv.writer(csv_output)
        writer.writerow(["index", "file", "start_sec", "end_sec", "duration_sec", "channels", "events"])
        for row in manifest_rows:
            writer.writerow([row["index"], row["file"], row["startSec"], row["endSec"], row["durationSec"],
                             "|".join(row["channels"]), json.dumps(row["events"], ensure_ascii=False, separators=(",", ":"))])
        archive.writestr("manifest.csv", csv_output.getvalue())
    return output.getvalue()


def export_data(data: np.ndarray, config: dict) -> tuple[bytes, str, str]:
    start, end = _time_range(config, data.shape[1])
    fs = _fs(config)
    start_i = max(0, min(data.shape[1] - 1, int(math.floor(start * fs))))
    end_i = max(start_i + 1, min(data.shape[1], int(math.ceil(end * fs))))
    sliced = np.ascontiguousarray(data[:, start_i:end_i], dtype=np.float32)
    events = _events_for_window(config.get("events") or [], start, end, relative=True)
    fmt = str(config.get("format") or "h5").lower()
    if fmt == "edf":
        return _write_edf(sliced, config, events), _stem(config) + ".edf", "application/octet-stream"
    if fmt != "h5":
        raise ValueError("format must be 'h5' or 'edf'.")
    return _write_h5(sliced, config, events, start, end), _stem(config) + ".h5", "application/x-hdf5"


def _write_h5(data: np.ndarray, config: dict, events: list[dict], start: float, end: float) -> bytes:
    output = io.BytesIO()
    string_dtype = h5py.string_dtype(encoding="utf-8")
    with h5py.File(output, "w") as handle:
        handle.create_dataset("data", data=data.T, compression="gzip", compression_opts=4, shuffle=True)
        handle.create_dataset("channel_labels", data=np.asarray(_labels(config, data.shape[0]), dtype=object), dtype=string_dtype)
        handle.attrs["fs_target"] = _fs(config)
        handle.attrs["sampling_rate"] = _fs(config)
        handle.attrs["export_time_start_sec"] = start
        handle.attrs["export_time_end_sec"] = end
        handle.attrs["provenance_json"] = json.dumps(config.get("provenance") or {}, ensure_ascii=False)
        handle.attrs["source_attrs_json"] = json.dumps(config.get("sourceAttrs") or {}, ensure_ascii=False, default=str)
        event_dtype = np.dtype([
            ("id", string_dtype), ("type", string_dtype), ("label", string_dtype),
            ("onsetSec", "<f8"), ("offsetSec", "<f8"), ("source", string_dtype),
        ])
        rows = np.empty(len(events), dtype=event_dtype)
        for index, event in enumerate(events):
            rows[index] = (event["id"], event["type"], event["label"], event["onsetSec"],
                           np.nan if event.get("offsetSec") is None else event["offsetSec"], event["source"])
        handle.create_dataset("events", data=rows)
    return output.getvalue()


def _write_edf(data: np.ndarray, config: dict, events: list[dict]) -> bytes:
    import pyedflib

    labels = _labels(config, data.shape[0])
    fs = _fs(config)
    temp = tempfile.NamedTemporaryFile(suffix=".edf", delete=False)
    temp.close()
    try:
        writer = pyedflib.EdfWriter(temp.name, data.shape[0], file_type=pyedflib.FILETYPE_EDFPLUS)
        try:
            headers = []
            for index, label in enumerate(labels):
                signal = np.asarray(data[index], dtype=float)
                physical_min = float(np.nanmin(signal)) if signal.size else -1.0
                physical_max = float(np.nanmax(signal)) if signal.size else 1.0
                if not math.isfinite(physical_min) or not math.isfinite(physical_max):
                    physical_min, physical_max = -1.0, 1.0
                elif physical_min == physical_max:
                    physical_min, physical_max = physical_min - 1.0, physical_max + 1.0
                margin = max((physical_max - physical_min) * 0.01, 1e-6)
                physical_min = _edf_bound(physical_min - margin)
                physical_max = _edf_bound(physical_max + margin)
                headers.append({
                    "label": label[:16], "dimension": "uV", "sample_frequency": fs,
                    "physical_min": physical_min, "physical_max": physical_max,
                    "digital_min": -32768, "digital_max": 32767,
                    "transducer": "", "prefilter": "",
                })
            writer.setSignalHeaders(headers)
            writer.writeSamples([np.asarray(channel, dtype=np.float64) for channel in data])
            for event in events:
                duration = max(0.0, (event.get("offsetSec") or event["onsetSec"]) - event["onsetSec"])
                writer.writeAnnotation(float(event["onsetSec"]), duration, event["label"])
        finally:
            writer.close()
        return Path(temp.name).read_bytes()
    finally:
        try:
            os.unlink(temp.name)
        except OSError:
            pass


def _events_for_window(events: list, start: float, end: float, *, relative: bool) -> list[dict]:
    selected = []
    for index, raw in enumerate(events):
        if not isinstance(raw, dict):
            continue
        onset = _number(raw.get("onsetSec", raw.get("timeSec")), 0.0)
        offset_value = raw.get("offsetSec")
        offset = _number(offset_value, onset) if offset_value is not None else None
        event_type = "interval" if offset is not None and offset > onset else "point"
        event_end = offset if event_type == "interval" else onset
        if event_end < start or onset > end:
            continue
        clipped_onset = max(start, onset)
        clipped_offset = min(end, offset) if event_type == "interval" else None
        shift = start if relative else 0.0
        selected.append({
            "id": str(raw.get("id") or f"event-{index + 1}"),
            "type": event_type,
            "label": str(raw.get("label") or "Event")[:120],
            "onsetSec": round(clipped_onset - shift, 9),
            "offsetSec": round(clipped_offset - shift, 9) if clipped_offset is not None else None,
            "source": str(raw.get("source") or "manual")[:40],
        })
    return selected


def _time_range(config: dict, n_samples: int) -> tuple[float, float]:
    duration = n_samples / _fs(config)
    value = config.get("timeRange") or [0, duration]
    start = max(0.0, min(duration, _number(value[0] if len(value) else 0, 0)))
    end = max(start + 1 / _fs(config), min(duration, _number(value[1] if len(value) > 1 else duration, duration)))
    return start, end


def _colors(config: dict, count: int) -> list[str]:
    palette = str(config.get("palette") or "current")
    current = [str(color) for color in config.get("colors") or []]
    if palette == "black":
        return ["#111111"] * count
    if palette == "mono":
        return [str(config.get("monoColor") or "#111111")] * count
    if palette == "cycle":
        return [TRAINING_COLORS[index % len(TRAINING_COLORS)] for index in range(count)]
    return [(current[index] if index < len(current) else TRAINING_COLORS[index % len(TRAINING_COLORS)]) for index in range(count)]


def _labels(config: dict, count: int) -> list[str]:
    labels = [str(label) for label in config.get("labels") or []]
    return [(labels[index] if index < len(labels) else f"ch{index}") for index in range(count)]


def _fs(config: dict) -> float:
    fs = float(config.get("fs") or 0)
    if not math.isfinite(fs) or fs <= 0:
        raise ValueError("A positive sampling rate is required.")
    return fs


def _stem(config: dict) -> str:
    raw = Path(str(config.get("fileName") or "recording")).stem
    return re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-.") or "recording"


def _number(value, fallback: float) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except (TypeError, ValueError):
        return fallback


def _positive_finite(value, fallback: float, name: str) -> float:
    if value is None or value == "":
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a positive finite number.") from exc
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{name} must be a positive finite number.")
    return max(0.001, number)


def _bounded_int(value, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(fallback)
    if not math.isfinite(number):
        number = float(fallback)
    return max(minimum, min(maximum, int(round(number))))


def _edf_bound(value: float) -> float:
    """Fit EDF's eight-character physical min/max fields without truncation."""
    for precision in range(6, 0, -1):
        candidate = float(f"{value:.{precision}g}")
        if len(str(candidate)) <= 8:
            return candidate
    return float(round(value))
