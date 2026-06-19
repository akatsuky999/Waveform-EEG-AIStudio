#!/usr/bin/env bash
# Launch the EEG Viewer (Starlette backend + static Three.js frontend).
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
RELOAD="${RELOAD:-1}"

if ! command -v uv >/dev/null 2>&1; then
  echo "EEGViewer requires uv. Install it from https://docs.astral.sh/uv/ and retry." >&2
  exit 1
fi

ARGS=(--host "$HOST" --port "$PORT")
if [[ "$RELOAD" != "0" ]]; then
  ARGS+=(--reload)
fi

echo "EEG Viewer  ->  http://${HOST}:${PORT}"
exec uv run --frozen python -m uvicorn backend.app:app "${ARGS[@]}" "$@"
