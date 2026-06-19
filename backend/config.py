"""Shared paths and limits for the Waveform backend."""

from __future__ import annotations

from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
SAMPLE_FILE = PROJECT_DIR / "win001.h5"

# Upload guard. EEG windows are small; whole-recording EDFs can be larger.
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
