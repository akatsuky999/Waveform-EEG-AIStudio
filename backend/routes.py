"""Core HTTP routes: file parsing, the bundled sample, and a health check."""

from __future__ import annotations

import asyncio

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .config import MAX_UPLOAD_BYTES, SAMPLE_FILE
from .core import store
from .core.envelope import decode_window, detect_kind, pack_envelope
from .core.exporters import decode_export_array, export_data, export_images, render_image_set
from .core.util import group_of

# The agent's Python sandbox reads the decoded window from this cache. The import
# is soft so the core still works if the agent plugin is removed.
try:
    from agent.backend.datastore import new_token, put_dataset
except Exception:  # noqa: BLE001 - plugin is optional
    new_token = None
    put_dataset = None


def _envelope_with_cache(raw: bytes, file_name: str) -> bytes:
    """Decode a window, cache it for the sandbox, and pack it into the envelope."""
    decoded = decode_window(raw, file_name)
    token = None
    if new_token and put_dataset:
        try:
            token = new_token()
            groups = [group_of(label) for label in decoded.labels]
            put_dataset(token, decoded.ch_major, decoded.fs, decoded.labels, groups)
        except Exception:  # noqa: BLE001 - caching is best-effort
            token = None
    return pack_envelope(decoded, file_name, token)


def _maybe_windowed_response(raw: bytes, file_name: str):
    """Large HDF5 → out-of-core windowed store (metadata only). Else None (legacy)."""
    try:
        if detect_kind(raw, file_name) != "h5":
            return None  # EDF windowing is a follow-up; EDF stays on the legacy path.
        n_values = store.peek_h5_values_from_bytes(raw)
        if not n_values or n_values <= store.WINDOWED_THRESHOLD_VALUES:
            return None
        token = store.ingest_h5_bytes(raw, file_name)
        return JSONResponse({"windowed": True, "dataToken": token, "meta": store.get_meta(token)})
    except Exception:  # noqa: BLE001 - on any failure fall back to the legacy decode
        return None


async def parse(request: Request) -> Response:
    form = await request.form()
    upload = form.get("file")
    if upload is None:
        return JSONResponse({"error": "No file uploaded (expected form field 'file')."}, status_code=400)

    raw = await upload.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "File too large."}, status_code=413)
    file_name = getattr(upload, "filename", "uploaded")

    windowed = _maybe_windowed_response(raw, file_name)
    if windowed is not None:
        return windowed

    try:
        envelope = _envelope_with_cache(raw, file_name)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001 - surface any decode failure
        return JSONResponse({"error": f"Could not read file: {exc}"}, status_code=400)

    return Response(content=envelope, media_type="application/octet-stream")


async def signal_window(request: Request) -> Response:
    """Windowed render tile for a large recording (out-of-core LoD store)."""
    q = request.query_params
    token = q.get("token", "")
    try:
        start_sec = float(q.get("startSec", "0"))
        end_sec = float(q.get("endSec", "0"))
        max_columns = int(q.get("maxColumns", "1500"))
    except (TypeError, ValueError):
        return _json_error("startSec/endSec/maxColumns must be numbers.", 400)
    channels_raw = q.get("channels")
    channels = None
    if channels_raw:
        try:
            channels = [int(x) for x in channels_raw.split(",") if x != ""]
        except ValueError:
            return _json_error("channels must be a comma-separated list of indices.", 400)
    tile = store.window(token, start_sec, end_sec, max_columns, channels)
    if tile is None:
        return _json_error("No windowed dataset for this dataToken. Reload the file, then retry.", 409)
    return Response(content=tile, media_type="application/octet-stream")


async def signal_ingest(request: Request) -> Response:
    """Stream a large recording to disk (bounded RAM) and ingest out-of-core.

    The request body is the raw HDF5 file (the browser streams it); we never read
    the whole upload into memory. Ingest runs in a worker thread; the client polls
    /api/signal/status and then loads /api/signal/meta.
    """
    name = request.query_params.get("name") or "upload.h5"
    token = store.new_token()
    store.STORE_ROOT.mkdir(parents=True, exist_ok=True)
    store.set_status(token, "uploading", 0.0, file_name=name)
    src = store.STORE_ROOT / f"{token}.src.h5"
    size = 0
    try:
        with open(src, "wb") as handle:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise ValueError("File too large.")
                handle.write(chunk)
    except Exception as exc:  # noqa: BLE001
        try:
            src.unlink()
        except OSError:
            pass
        store.set_status(token, "error", error=str(exc), file_name=name)
        return _json_error(str(exc), 413 if "too large" in str(exc).lower() else 400)

    async def _build() -> None:
        try:
            await asyncio.to_thread(store.ingest_path, src, name, token)
        except Exception:  # noqa: BLE001 - status already records the error
            pass
        finally:
            try:
                src.unlink()
            except OSError:
                pass

    asyncio.create_task(_build())
    return JSONResponse({"token": token, "state": "ingesting"})


async def signal_status(request: Request) -> Response:
    status = store.get_status(request.query_params.get("token", ""))
    if status is None:
        return _json_error("Unknown token.", 404)
    return JSONResponse(status)


async def signal_meta(request: Request) -> Response:
    meta = store.get_meta(request.query_params.get("token", ""))
    if meta is None:
        return _json_error("No ready dataset for this token.", 409)
    return JSONResponse({"windowed": True, "dataToken": request.query_params.get("token"), "meta": meta})


async def signal_query(request: Request) -> Response:
    """Unified declarative query over the store (viewer + agent share this)."""
    try:
        spec = await request.json()
    except Exception:  # noqa: BLE001
        return _json_error("Expected a JSON request body.", 400)
    if not isinstance(spec, dict):
        return _json_error("Query must be a JSON object.", 400)
    kind, data = store.query(str(spec.get("token") or ""), spec)
    if kind == "tile":
        return Response(content=data, media_type="application/octet-stream")
    if isinstance(data, dict) and isinstance(data.get("status"), int):
        return _json_error(data.get("error", "Query failed."), data["status"])
    return JSONResponse(data)


async def signal_stats(_request: Request) -> Response:
    return JSONResponse(store.stats())


async def sample(_request: Request) -> Response:
    if not SAMPLE_FILE.exists():
        return JSONResponse({"error": "No sample file bundled."}, status_code=404)
    try:
        envelope = _envelope_with_cache(SAMPLE_FILE.read_bytes(), SAMPLE_FILE.name)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"Could not read sample: {exc}"}, status_code=500)
    return Response(content=envelope, media_type="application/octet-stream")


async def health(_request: Request) -> Response:
    return JSONResponse({"status": "ok", "hasSample": SAMPLE_FILE.exists()})


async def export_images_route(request: Request) -> Response:
    try:
        data, config = await _export_request(request)
        content, file_name, media_type = export_images(data, config)
        return Response(content, media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{file_name}"'})
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"Could not export image: {exc}"}, status_code=500)


async def export_data_route(request: Request) -> Response:
    try:
        data, config = await _export_request(request)
        content, file_name, media_type = export_data(data, config)
        return Response(content, media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{file_name}"'})
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"Could not export data: {exc}"}, status_code=500)


async def render_images_route(request: Request) -> Response:
    try:
        data, config = await _export_request(request)
        return JSONResponse(render_image_set(data, config))
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"Could not render image set: {exc}"}, status_code=500)


async def _export_request(request: Request):
    form = await request.form()
    upload = form.get("data")
    config_raw = form.get("config")
    if upload is None or config_raw is None:
        raise ValueError("Expected multipart fields 'data' and 'config'.")
    raw = await upload.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError("Export payload is too large.")
    try:
        import json
        config = json.loads(str(config_raw))
    except (TypeError, ValueError) as exc:
        raise ValueError("Export config must be valid JSON.") from exc
    if not isinstance(config, dict):
        raise ValueError("Export config must be a JSON object.")
    return decode_export_array(raw, config), config
