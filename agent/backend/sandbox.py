"""Python sandbox for the EEG-Master agent.

Exposes ``POST /api/ai/execute``: run model-written Python (numpy / scipy) against
the decoded EEG window the user is viewing, and return stdout + a JSON result +
read-only event candidates + an optional figure.

The code runs in a **separate subprocess** (``sandbox_worker.py``) with a clean
environment, a throwaway working directory, a wall-clock timeout, an output cap,
and best-effort CPU/address-space rlimits. This is honest, best-effort isolation
for a **local single-user** research tool that runs model-generated code — the
same dual-use posture as Claude Code's own shell tool. It is not a hardened
multi-tenant jail. Executed code retains the operating-system permissions of the
EEGViewer process and can access files, network resources, and child processes.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .datastore import get_dataset

WORKER = str(Path(__file__).resolve().parent / "sandbox_worker.py")

TIMEOUT_SECONDS = 45  # headroom for multi-channel filtering/welch on full recordings
CPU_SECONDS = TIMEOUT_SECONDS + 2
ADDRESS_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB best-effort cap
MAX_CODE_CHARS = 20000
MAX_OUTPUT_CHARS = 20000
MAX_FIGURE_BYTES = 2 * 1024 * 1024


def _json_error(message: str, status_code: int = 400, **extra) -> JSONResponse:
    payload = {"error": message}
    payload.update(extra)
    return JSONResponse(payload, status_code=status_code)


def _truncate(text: str) -> str:
    text = text or ""
    if len(text) > MAX_OUTPUT_CHARS:
        return text[:MAX_OUTPUT_CHARS] + f"\n…(truncated, {len(text)} chars total)"
    return text


def _clean_env(workdir: str) -> dict:
    """A minimal env: no inherited secrets, headless matplotlib, capped threads."""
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": workdir,
        "TMPDIR": workdir,
        "MPLBACKEND": "Agg",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "OMP_NUM_THREADS": "2",
        "OPENBLAS_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
        "NUMEXPR_NUM_THREADS": "2",
    }


def _run_worker(code: str, dataset: dict, workspace: dict | None = None) -> dict:
    """Blocking: set up a work dir, run the worker, collect its result."""
    with tempfile.TemporaryDirectory(prefix="eeg-sandbox-") as workdir:
        np.save(os.path.join(workdir, "_data.npy"), np.ascontiguousarray(dataset["array"], dtype=np.float32))
        meta = {
            "fs": dataset["fs"],
            "labels": dataset["labels"],
            "groups": dataset["groups"],
            "workspace": workspace if isinstance(workspace, dict) else {},
            "limits": {"cpuSeconds": CPU_SECONDS, "addressBytes": ADDRESS_BYTES},
        }
        with open(os.path.join(workdir, "_meta.json"), "w", encoding="utf-8") as handle:
            json.dump(meta, handle)
        with open(os.path.join(workdir, "_code.py"), "w", encoding="utf-8") as handle:
            handle.write(code)

        timed_out = False
        try:
            proc = subprocess.run(
                [sys.executable, WORKER, workdir],
                cwd=workdir,
                env=_clean_env(workdir),
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
            stdout, stderr, returncode = proc.stdout, proc.stderr, proc.returncode
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            returncode = -1

        out = {"ok": False, "error": None, "result": None, "eventCandidates": []}
        out_path = os.path.join(workdir, "_out.json")
        if os.path.exists(out_path):
            try:
                with open(out_path, encoding="utf-8") as handle:
                    out = json.load(handle)
            except Exception:  # noqa: BLE001
                out = {"ok": False, "error": "Worker produced an unreadable result."}

        figure_data_url = None
        fig_path = os.path.join(workdir, "_fig.png")
        if out.get("figure") and os.path.exists(fig_path):
            try:
                raw = Path(fig_path).read_bytes()
                if len(raw) <= MAX_FIGURE_BYTES:
                    figure_data_url = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
            except Exception:  # noqa: BLE001
                figure_data_url = None

        if timed_out:
            error = f"Execution timed out after {TIMEOUT_SECONDS}s and was killed."
        elif out.get("ok"):
            error = None
        else:
            error = out.get("error") or (stderr.strip() if stderr else None) or (
                f"Worker exited with code {returncode}." if returncode not in (0, None) else "Execution failed."
            )

        return {
            "ok": bool(out.get("ok")) and not timed_out,
            "timedOut": timed_out,
            "stdout": _truncate(stdout),
            "stderr": _truncate(stderr),
            "result": out.get("result"),
            "eventCandidates": out.get("eventCandidates") or out.get("markers") or [],
            "figurePngDataUrl": figure_data_url,
            "error": error,
        }


async def ai_execute(request: Request) -> Response:
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return _json_error("Expected a JSON request body.", 400)

    code = str(data.get("code") or "")
    if not code.strip():
        return _json_error("code is required.", 400)
    if len(code) > MAX_CODE_CHARS:
        return _json_error("code is too long for the sandbox.", 400)

    token = str(data.get("dataToken") or "").strip()
    dataset = get_dataset(token)
    if dataset is None:
        return _json_error(
            "No cached dataset for this dataToken. Reload the EEG file, then retry.",
            409,
        )

    workspace = data.get("workspace") if isinstance(data.get("workspace"), dict) else {}
    result = await asyncio.to_thread(_run_worker, code, dataset, workspace)
    return JSONResponse(result)
