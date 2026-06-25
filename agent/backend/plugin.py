"""EEG-Master plugin wiring.

The agent is a self-contained plugin: it owns its proxy routes and serves its own
web bundle. The host app calls `agent_routes()` and splices the result into its
route table *before* the catch-all static mount.
"""

from __future__ import annotations

from pathlib import Path

from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .proxy import ai_chat, ai_models
from .sandbox import ai_execute
from .skills import get_skill, list_skills

AGENT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = AGENT_DIR / "web"
SIGNAL_WORKSPACE_GUIDE = AGENT_DIR / "knowledge" / "signal_workspace.md"


class NoCacheStatic(StaticFiles):
    """Serve the agent bundle with revalidation so edits to agent/web/* show up
    without a hard reload (ETag/Last-Modified still give fast 304s)."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


async def signal_workspace_guide(_request):
    if not SIGNAL_WORKSPACE_GUIDE.exists():
        return PlainTextResponse("Signal Workspace guide is unavailable.", status_code=404)
    return PlainTextResponse(SIGNAL_WORKSPACE_GUIDE.read_text(encoding="utf-8"), media_type="text/markdown")


async def agent_skills(_request):
    return JSONResponse({"skills": list_skills()})


async def agent_skill(request):
    try:
        return JSONResponse({"skill": get_skill(request.path_params.get("name", ""))})
    except KeyError:
        return JSONResponse({"error": "Skill not found."}, status_code=404)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


def agent_routes() -> list:
    """Routes contributed by the EEG-Master plugin.

    - POST /api/ai/chat     streaming/non-streaming chat proxy (native tool calls)
    - POST /api/ai/models   model listing proxy
    - POST /api/ai/execute  Python sandbox over the cached EEG window
    - GET  /api/ai/knowledge/signal-workspace  runtime workspace manual
    - GET  /api/ai/skills   curated EEG skill manifests
    - GET  /api/ai/skills/{name}   one curated EEG skill body
    - /agent/*              the agent's web bundle (JS/CSS), imported by the shell
    """
    return [
        Route("/api/ai/chat", ai_chat, methods=["POST"]),
        Route("/api/ai/models", ai_models, methods=["POST"]),
        Route("/api/ai/execute", ai_execute, methods=["POST"]),
        Route("/api/ai/knowledge/signal-workspace", signal_workspace_guide, methods=["GET"]),
        Route("/api/ai/skills", agent_skills, methods=["GET"]),
        Route("/api/ai/skills/{name}", agent_skill, methods=["GET"]),
        Mount("/agent", app=NoCacheStatic(directory=str(WEB_DIR)), name="agent-web"),
    ]
