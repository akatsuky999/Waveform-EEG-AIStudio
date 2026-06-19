"""
Waveform — backend application
==============================

A small, dependency-light Starlette service that:

  1. Serves the static Three.js frontend.
  2. Decodes an uploaded EEG window — HDF5 (.h5) or EDF/EDF+/BDF (.edf) — and
     streams the waveform back to the browser in a compact binary envelope
     (see ``core.envelope``).

The EEG-Master AI assistant lives in the self-contained ``agent`` plugin and is
wired in here via ``agent.backend.plugin.agent_routes()``. Decoding logic stays
in Python; n-th differencing, normalization and rendering happen client-side.
"""

from __future__ import annotations

from starlette.applications import Starlette
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from agent.backend.plugin import agent_routes

from .config import FRONTEND_DIR
from .routes import export_data_route, export_images_route, health, parse, render_images_route, sample


class NoCacheStatic(StaticFiles):
    """Serve static assets with revalidation so edits show up without a hard reload.

    Without an explicit Cache-Control, browsers apply heuristic caching and may
    serve stale ES modules / CSS. ``no-cache`` forces a conditional request; the
    existing ETag / Last-Modified still yield a fast 304 when nothing changed.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


routes = [
    Route("/api/parse", parse, methods=["POST"]),
    Route("/api/sample", sample, methods=["GET"]),
    Route("/api/health", health, methods=["GET"]),
    Route("/api/export/images", export_images_route, methods=["POST"]),
    Route("/api/render/images", render_images_route, methods=["POST"]),
    Route("/api/export/data", export_data_route, methods=["POST"]),
    # EEG-Master plugin (/api/ai/* + /agent static bundle) — before the catch-all.
    *agent_routes(),
    # Catch-all static frontend mount must stay last.
    Mount("/", app=NoCacheStatic(directory=str(FRONTEND_DIR), html=True), name="static"),
]

app = Starlette(routes=routes)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
