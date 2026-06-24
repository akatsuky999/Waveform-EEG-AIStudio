"""Shared paths and limits for the Waveform backend."""

from __future__ import annotations

from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
PIC_DIR = PROJECT_DIR / "pic"          # brand/logo + doc images, served at /pic
SAMPLE_FILE = PROJECT_DIR / "win001.h5"

# Upload guard. Whole-recording EEG is GB-scale; large HDF5 is stream-ingested
# into the out-of-core windowed store (see core/store.py), so allow big uploads.
MAX_UPLOAD_BYTES = 6 * 1024 * 1024 * 1024
