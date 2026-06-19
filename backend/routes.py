"""Core HTTP routes: file parsing, the bundled sample, and a health check."""

from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .config import MAX_UPLOAD_BYTES, SAMPLE_FILE
from .core.envelope import decode_window, pack_envelope
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


async def parse(request: Request) -> Response:
    form = await request.form()
    upload = form.get("file")
    if upload is None:
        return JSONResponse({"error": "No file uploaded (expected form field 'file')."}, status_code=400)

    raw = await upload.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "File too large."}, status_code=413)

    try:
        envelope = _envelope_with_cache(raw, getattr(upload, "filename", "uploaded"))
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001 - surface any decode failure
        return JSONResponse({"error": f"Could not read file: {exc}"}, status_code=400)

    return Response(content=envelope, media_type="application/octet-stream")


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
