from __future__ import annotations

import io
import base64
import json
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

import h5py
import numpy as np

from backend.core.exporters import (
    MAX_AGENT_IMAGE_BYTES,
    MAX_AGENT_IMAGES,
    MAX_BATCH_WINDOWS,
    decode_export_array,
    export_data,
    export_images,
    render_image_set,
)
from backend.core.readers.edf import read_edf
from backend.core.readers.h5 import read_h5


class ExportRoundTripTests(unittest.TestCase):
    def setUp(self):
        fs = 128.0
        time = np.arange(256, dtype=np.float32) / fs
        self.data = np.vstack([
            20 * np.sin(2 * np.pi * 8 * time),
            12 * np.sin(2 * np.pi * 3 * time + 0.25),
        ]).astype(np.float32)
        self.config = {
            "fileName": "roundtrip.edf",
            "fs": fs,
            "labels": ["Fp1", "Fp2"],
            "colors": ["#4455ff", "#ff5b52"],
            "timeRange": [0, 2],
            "events": [
                {"id": "p", "type": "point", "label": "spike", "onsetSec": 0.25, "offsetSec": None, "source": "test"},
                {"id": "i", "type": "interval", "label": "rhythm", "onsetSec": 0.5, "offsetSec": 1.5, "source": "test"},
            ],
            "provenance": {"montage": "raw", "filter": {"low": 1, "high": 40}},
        }

    def test_viewer_and_training_png_dimensions(self):
        for style, width, height in (("viewer", 900, 600), ("training", 1600, 1200)):
            payload, name, media_type = export_images(self.data, {
                **self.config, "style": style, "mode": "single", "width": width, "height": height,
                "background": "#ffffff", "showLabels": style == "viewer", "showEvents": style == "viewer",
                "palette": "cycle", "lineWidth": 0.65,
            })
            self.assertEqual(payload[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", payload[16:24]), (width, height))
            self.assertTrue(name.endswith(".png"))
            self.assertEqual(media_type, "image/png")

    def test_auto_height_scales_with_channel_count_while_width_stays_fixed(self):
        short = np.tile(self.data[:1, :64], (33, 1))
        tall = np.tile(self.data[:1, :64], (100, 1))
        common = {
            **self.config,
            "style": "training",
            "mode": "single",
            "width": 1800,
            "autoHeight": True,
            "rowHeight": 30,
            "timeRange": [0, 0.5],
            "showLabels": False,
            "showEvents": False,
        }
        payload_33, _, _ = export_images(short, common)
        payload_100, _, _ = export_images(tall, common)
        self.assertEqual(struct.unpack(">II", payload_33[16:24]), (1800, 33 * 30 + 28))
        self.assertEqual(struct.unpack(">II", payload_100[16:24]), (1800, 100 * 30 + 28))

    def test_training_channel_labels_are_actually_drawn(self):
        from matplotlib.image import imread

        channels = np.tile(self.data[:1], (12, 1))
        labels = [f"LongChannelLabel-{index:02d}" for index in range(12)]
        common = {
            **self.config,
            "labels": labels,
            "style": "training",
            "mode": "single",
            "width": 900,
            "autoHeight": True,
            "rowHeight": 40,
            "background": "#ffffff",
            "palette": "black",
            "showEvents": False,
        }
        labeled, _, _ = export_images(channels, {**common, "showLabels": True})
        plain, _, _ = export_images(channels, {**common, "showLabels": False})
        labeled_pixels = imread(io.BytesIO(labeled), format="png")[:, :120, :3]
        plain_pixels = imread(io.BytesIO(plain), format="png")[:, :120, :3]
        labeled_ink = int(np.count_nonzero(np.min(labeled_pixels, axis=2) < 0.9))
        plain_ink = int(np.count_nonzero(np.min(plain_pixels, axis=2) < 0.9))
        # The label gutter ends at x=120 for these long names, so the labeled
        # crop contains text but no waveform. Before the fix it was empty
        # because training mode hid the entire axis, including y tick labels.
        self.assertGreater(labeled_ink, plain_ink)

        taller, _, _ = export_images(channels, {
            **common, "showLabels": True, "autoHeight": False, "height": 900,
            "labelFontSizePx": 12,
        })
        fixed, _, _ = export_images(channels, {
            **common, "showLabels": True, "labelFontSizePx": 12,
        })
        taller_pixels = imread(io.BytesIO(taller), format="png")[:, :160, :3]
        fixed_pixels = imread(io.BytesIO(fixed), format="png")[:, :160, :3]
        taller_ink = int(np.count_nonzero(np.min(taller_pixels, axis=2) < 0.9))
        fixed_ink = int(np.count_nonzero(np.min(fixed_pixels, axis=2) < 0.9))
        self.assertLess(abs(taller_ink - fixed_ink), fixed_ink * 0.15)

        larger, _, _ = export_images(channels, {
            **common, "showLabels": True, "labelFontSizePx": 20,
        })
        larger_pixels = imread(io.BytesIO(larger), format="png")[:, :220, :3]
        fixed_wide = imread(io.BytesIO(fixed), format="png")[:, :220, :3]
        larger_ink = int(np.count_nonzero(np.min(larger_pixels, axis=2) < 0.9))
        fixed_wide_ink = int(np.count_nonzero(np.min(fixed_wide, axis=2) < 0.9))
        self.assertGreater(larger_ink, fixed_wide_ink * 1.25)

    def test_uploaded_float32_payload_is_writable_for_renderer(self):
        decoded = decode_export_array(self.data.astype("<f4").tobytes(), {
            "nChannels": self.data.shape[0], "nSamples": self.data.shape[1],
        })
        self.assertTrue(decoded.flags.writeable)
        payload, _, _ = export_images(decoded, {
            **self.config, "style": "viewer", "mode": "single", "width": 400, "height": 300,
            "background": "#ffffff", "showLabels": True, "showEvents": True,
        })
        self.assertEqual(payload[:8], b"\x89PNG\r\n\x1a\n")

    def test_batch_zip_contains_images_and_both_manifests(self):
        payload, name, media_type = export_images(self.data, {
            **self.config, "style": "training", "mode": "batch", "width": 400, "height": 300,
            "windowSec": 1, "stepSec": 1, "includePartial": True, "palette": "black",
        })
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            names = archive.namelist()
            self.assertIn("manifest.csv", names)
            self.assertIn("manifest.json", names)
            self.assertEqual(len([item for item in names if item.endswith(".png")]), 2)
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(len(manifest["windows"]), 2)
        self.assertTrue(name.endswith(".zip"))
        self.assertEqual(media_type, "application/zip")

    def test_batch_export_rejects_unbounded_window_counts(self):
        with self.assertRaisesRegex(ValueError, str(MAX_BATCH_WINDOWS)):
            export_images(self.data, {
                **self.config, "style": "training", "mode": "batch",
                "windowSec": 0.001, "stepSec": 0.001,
            })

    def test_batch_export_rejects_non_finite_steps(self):
        with self.assertRaisesRegex(ValueError, "stepSec"):
            export_images(self.data, {
                **self.config, "style": "training", "mode": "batch",
                "windowSec": 1, "stepSec": float("nan"),
            })

    def test_agent_image_set_preserves_view_order_channel_subsets_and_dimensions(self):
        payload = render_image_set(self.data, {
            **self.config,
            "style": "viewer",
            "width": 640,
            "height": 320,
            "autoHeight": False,
            "showLabels": True,
            "showEvents": False,
            "views": [
                {"role": "overview", "startSec": 0, "endSec": 2, "channelIndices": [0, 1]},
                {"role": "detail", "startSec": 0.5, "endSec": 1.25, "channelIndices": [1]},
            ],
        })
        self.assertEqual(payload["imageCount"], 2)
        self.assertEqual([item["role"] for item in payload["images"]], ["overview", "detail"])
        self.assertEqual(payload["images"][1]["channels"], ["Fp2"])
        self.assertEqual((payload["images"][1]["width"], payload["images"][1]["height"]), (640, 320))
        png = base64.b64decode(payload["images"][1]["dataUrl"].split(",", 1)[1])
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", png[16:24]), (640, 320))

    def test_agent_image_set_enforces_count_and_payload_limits(self):
        with self.assertRaisesRegex(ValueError, str(MAX_AGENT_IMAGES)):
            render_image_set(self.data, {
                **self.config,
                "views": [
                    {"startSec": 0, "endSec": 1, "channelIndices": [0]}
                    for _ in range(MAX_AGENT_IMAGES + 1)
                ],
            })

        from unittest.mock import patch
        with patch("backend.core.exporters._render_png", return_value=b"x" * (MAX_AGENT_IMAGE_BYTES + 1)):
            with self.assertRaisesRegex(ValueError, "reduce dimensions or channel count"):
                render_image_set(self.data, {
                    **self.config,
                    "views": [{"startSec": 0, "endSec": 1, "channelIndices": [0]}],
                })

    def test_h5_round_trip_preserves_signal_labels_rate_events_and_provenance(self):
        payload, _, _ = export_data(self.data, {**self.config, "format": "h5"})
        decoded, labels, fs, _, _ = read_h5(payload)
        np.testing.assert_allclose(decoded, self.data, rtol=1e-6, atol=1e-6)
        self.assertEqual(labels, self.config["labels"])
        self.assertEqual(fs, self.config["fs"])
        with h5py.File(io.BytesIO(payload), "r") as handle:
            self.assertEqual(len(handle["events"]), 2)
            self.assertEqual(json.loads(handle.attrs["provenance_json"])["montage"], "raw")

    def test_bundled_example_is_deidentified_and_has_no_source_identifier(self):
        sample_path = Path(__file__).resolve().parent.parent / "win001.h5"
        with h5py.File(sample_path, "r") as handle:
            self.assertTrue(bool(handle.attrs["deidentified"]))
            self.assertNotIn("license", handle.attrs)
            self.assertNotIn("edf_stem", handle.attrs)
            self.assertEqual(handle["data"].shape, (2560, 52))
            self.assertEqual(len(handle.attrs["waveform_sha256"]), 64)

    def test_edf_plus_round_trip_preserves_waveform_and_annotations(self):
        import pyedflib

        payload, _, _ = export_data(self.data, {**self.config, "format": "edf"})
        decoded, labels, fs, _, _ = read_edf(payload)
        np.testing.assert_allclose(decoded, self.data, rtol=0, atol=0.02)
        self.assertEqual(labels, self.config["labels"])
        self.assertEqual(fs, self.config["fs"])
        with tempfile.NamedTemporaryFile(suffix=".edf") as temp:
            temp.write(payload)
            temp.flush()
            reader = pyedflib.EdfReader(temp.name)
            try:
                onsets, durations, descriptions = reader.readAnnotations()
            finally:
                reader.close()
        self.assertEqual(list(descriptions), ["spike", "rhythm"])
        np.testing.assert_allclose(onsets, [0.25, 0.5], atol=0.01)
        np.testing.assert_allclose(durations, [0.0, 1.0], atol=0.01)


if __name__ == "__main__":
    unittest.main()
