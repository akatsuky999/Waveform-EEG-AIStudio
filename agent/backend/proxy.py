"""OpenAI-compatible chat/model proxy for the EEG-Master agent.

Self-contained: this module only depends on Starlette + the standard library so
the agent plugin can be iterated independently of the rest of the backend.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request

from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

MAX_AI_RESPONSE_BYTES = 4 * 1024 * 1024
AI_TIMEOUT_SECONDS = 60
MAX_AI_IMAGE_DATA_URL_CHARS = 6 * 1024 * 1024
MAX_AI_IMAGES_PER_MESSAGE = 5
MAX_AI_IMAGE_SET_DATA_URL_CHARS = 17 * 1024 * 1024


def _json_error(message: str, status_code: int = 400, **extra) -> JSONResponse:
    payload = {"error": message}
    payload.update(extra)
    return JSONResponse(payload, status_code=status_code)


def _clean_base_url(value) -> str:
    base_url = str(value or "").strip()
    if not base_url:
        raise ValueError("Base URL is required; configure an OpenAI-compatible provider explicitly.")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Base URL must be a valid http(s) URL.")
    if parsed.username or parsed.password:
        raise ValueError("Base URL must not include credentials.")
    if parsed.query or parsed.fragment:
        raise ValueError("Base URL must not include query strings or fragments.")
    return base_url.rstrip("/")


def _ai_endpoint(base_url: str, suffix: str) -> str:
    if base_url.rstrip("/").endswith("/v1"):
        return base_url.rstrip("/") + suffix
    return base_url.rstrip("/") + "/v1" + suffix


def _safe_json_loads(raw: bytes):
    if not raw:
        return {}
    text = raw.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"message": text[:2000]}


def _upstream_error(data, status: int) -> str:
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("type") or err.get("code")
            if msg:
                return str(msg)
        if isinstance(err, str):
            return err
        for key in ("message", "detail"):
            if data.get(key):
                return str(data[key])
    return f"Upstream returned HTTP {status}."


def _http_json(method: str, url: str, headers: dict[str, str], payload=None):
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=AI_TIMEOUT_SECONDS) as response:  # noqa: S310
            raw = response.read(MAX_AI_RESPONSE_BYTES)
            return response.status, _safe_json_loads(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read(MAX_AI_RESPONSE_BYTES)
        return exc.code, _safe_json_loads(raw)
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise ConnectionError(f"Could not reach upstream: {reason}") from exc


def _sse(data, event: str | None = None) -> bytes:
    prefix = f"event: {event}\n" if event else ""
    return (prefix + "data: " + json.dumps(data, ensure_ascii=False) + "\n\n").encode("utf-8")


def _forward_choice(obj):
    """Build a minimal SSE payload preserving content, tool_calls, finish_reason."""
    if not isinstance(obj, dict) or obj.get("error"):
        return None
    choices = obj.get("choices")
    if not (isinstance(choices, list) and choices):
        if isinstance(obj.get("content"), str) and obj["content"]:
            return {"choices": [{"delta": {"content": obj["content"]}}]}
        return None
    first = choices[0] or {}
    src = first.get("delta") if isinstance(first.get("delta"), dict) else {}
    # Some providers send the whole message rather than streaming deltas.
    if not src.get("content") and not src.get("tool_calls"):
        message = first.get("message")
        if isinstance(message, dict):
            src = message
    out_delta = {}
    if isinstance(src.get("content"), str) and src["content"]:
        out_delta["content"] = src["content"]
    if isinstance(src.get("tool_calls"), list) and src["tool_calls"]:
        out_delta["tool_calls"] = src["tool_calls"]
    finish = first.get("finish_reason")
    if not out_delta and not finish:
        return None
    payload = {"choices": [{"delta": out_delta}]}
    if finish:
        payload["choices"][0]["finish_reason"] = finish
    return payload


def _extract_json_objects(buffer: str):
    found = []
    start = None
    depth = 0
    in_string = False
    escape = False
    consumed = 0

    for i, ch in enumerate(buffer):
        if start is None:
            if ch == "{":
                start = i
                depth = 1
                in_string = False
                escape = False
            continue

        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                raw = buffer[start:i + 1]
                try:
                    found.append(json.loads(raw))
                    consumed = i + 1
                except json.JSONDecodeError:
                    pass
                start = None

    return found, buffer[consumed:]


def _normalised_stream_events(response):
    buffer = ""
    for raw in response:
        text = raw.decode("utf-8", "replace")
        done = "[DONE]" in text
        buffer += text.replace("[DONE]", "")
        objects, buffer = _extract_json_objects(buffer)

        for obj in objects:
            if isinstance(obj, dict) and obj.get("error"):
                yield _sse({"error": _upstream_error(obj, 502)}, "error")
                continue
            payload = _forward_choice(obj)
            if payload:
                yield _sse(payload)

        if done:
            break
        if len(buffer) > 4096 and "{" not in buffer:
            buffer = ""
    yield b"data: [DONE]\n\n"


def _http_chat_stream(url: str, headers: dict[str, str], payload):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=AI_TIMEOUT_SECONDS) as response:  # noqa: S310
            content_type = response.headers.get("content-type", "")
            if "text/event-stream" in content_type:
                yield from _normalised_stream_events(response)
                return

            raw = response.read(MAX_AI_RESPONSE_BYTES)
            data = _safe_json_loads(raw)
            payload = None
            if isinstance(data, dict):
                payload = _forward_choice(data)
            if payload is None:
                objects, _rest = _extract_json_objects(raw.decode("utf-8", "replace"))
                for obj in objects:
                    payload = _forward_choice(obj)
                    if payload:
                        break
            if payload:
                yield _sse(payload)
                yield b"data: [DONE]\n\n"
            else:
                yield _sse({"error": "Upstream response did not include assistant text or tool calls."}, "error")
    except urllib.error.HTTPError as exc:
        raw = exc.read(MAX_AI_RESPONSE_BYTES)
        upstream = _safe_json_loads(raw)
        yield _sse({"error": _upstream_error(upstream, exc.code), "upstreamStatus": exc.code}, "error")
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        yield _sse({"error": f"Could not reach upstream: {reason}"}, "error")


def _clean_message_content(content):
    if isinstance(content, str):
        if not content.strip():
            raise ValueError("Each message needs non-empty text content.")
        return content
    if not isinstance(content, list) or not content:
        raise ValueError("Message content must be text or a non-empty multimodal array.")

    clean = []
    image_count = 0
    image_chars = 0
    for part in content:
        if not isinstance(part, dict):
            raise ValueError("Each multimodal content part must be an object.")
        kind = part.get("type")
        if kind == "text":
            text = part.get("text")
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Text content parts need non-empty text.")
            clean.append({"type": "text", "text": text})
        elif kind == "image_url":
            image_url = part.get("image_url")
            url = image_url.get("url") if isinstance(image_url, dict) else None
            if not isinstance(url, str) or not url.startswith("data:image/"):
                raise ValueError("Only data:image URLs are allowed for image_url content.")
            if len(url) > MAX_AI_IMAGE_DATA_URL_CHARS:
                raise ValueError("Image attachment is too large for the AI proxy.")
            image_count += 1
            image_chars += len(url)
            if image_count > MAX_AI_IMAGES_PER_MESSAGE:
                raise ValueError(f"A message may include at most {MAX_AI_IMAGES_PER_MESSAGE} images.")
            if image_chars > MAX_AI_IMAGE_SET_DATA_URL_CHARS:
                raise ValueError("Image set is too large for the AI proxy; reduce dimensions or image count.")
            clean.append({"type": "image_url", "image_url": {"url": url}})
        else:
            raise ValueError(f"Unsupported content part type: {kind or 'empty'}.")
    return clean


def _clean_tool_calls(tool_calls) -> list[dict]:
    clean = []
    for call in tool_calls:
        if not isinstance(call, dict):
            continue
        fn = call.get("function") if isinstance(call.get("function"), dict) else {}
        name = fn.get("name")
        if not isinstance(name, str) or not name:
            continue
        args = fn.get("arguments")
        if not isinstance(args, str):
            args = json.dumps(args if args is not None else {})
        clean.append({
            "id": str(call.get("id") or ""),
            "type": "function",
            "function": {"name": name, "arguments": args},
        })
    if not clean:
        raise ValueError("assistant tool_calls were empty or invalid.")
    return clean


def _clean_tool_content(content) -> str:
    if isinstance(content, str):
        return content if content.strip() else "(empty tool result)"
    if isinstance(content, list):
        texts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
        joined = "\n".join(t for t in texts if t)
        return joined or "(non-text tool result)"
    return "(empty tool result)"


def _clean_ai_messages(messages) -> list[dict]:
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a non-empty array.")
    clean: list[dict] = []
    allowed_roles = {"system", "user", "assistant", "developer", "tool"}
    for item in messages:
        if not isinstance(item, dict):
            raise ValueError("Each message must be an object.")
        role = str(item.get("role") or "").strip()
        if role not in allowed_roles:
            raise ValueError(f"Unsupported message role: {role or 'empty'}.")
        if role == "tool":
            call_id = item.get("tool_call_id")
            if not isinstance(call_id, str) or not call_id.strip():
                raise ValueError("tool messages require a tool_call_id.")
            clean.append({"role": "tool", "tool_call_id": call_id, "content": _clean_tool_content(item.get("content"))})
            continue
        if role == "assistant" and isinstance(item.get("tool_calls"), list) and item["tool_calls"]:
            content = item.get("content")
            clean.append({
                "role": "assistant",
                "content": content if isinstance(content, str) else "",
                "tool_calls": _clean_tool_calls(item["tool_calls"]),
            })
            continue
        clean.append({"role": role, "content": _clean_message_content(item.get("content"))})
    return clean


def _clean_tools(tools):
    if not isinstance(tools, list) or not tools:
        return None
    clean = []
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            continue
        fn = tool.get("function") if isinstance(tool.get("function"), dict) else {}
        name = fn.get("name")
        if not isinstance(name, str) or not name:
            continue
        entry = {"type": "function", "function": {"name": name, "description": str(fn.get("description") or "")[:1024]}}
        if isinstance(fn.get("parameters"), dict):
            entry["function"]["parameters"] = fn["parameters"]
        clean.append(entry)
    return clean or None


def _messages_with_context(messages: list[dict], context) -> list[dict]:
    if not isinstance(context, dict) or not context:
        return messages
    context_json = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(context_json) > 50000:
        context_json = context_json[:50000] + "...(truncated)"
    context_message = {
        "role": "user",
        "content": "Current EEG viewer context JSON (summary only, no raw waveform):\n"
        f"```json\n{context_json}\n```",
    }
    if messages and messages[0]["role"] == "system":
        return [messages[0], context_message, *messages[1:]]
    return [context_message, *messages]


async def ai_chat(request: Request) -> Response:
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return _json_error("Expected a JSON request body.", 400)

    try:
        base_url = _clean_base_url(data.get("baseUrl"))
        api_key = str(data.get("apiKey") or "").strip()
        model = str(data.get("model") or "").strip()
        messages = _clean_ai_messages(data.get("messages"))
        messages = _messages_with_context(messages, data.get("context"))
    except ValueError as exc:
        return _json_error(str(exc), 400)

    if not api_key:
        return _json_error("API key is required.", 400)
    if not model:
        return _json_error("model is required.", 400)

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "stream": bool(data.get("stream")),
    }
    tools = _clean_tools(data.get("tools"))
    if tools:
        payload["tools"] = tools
        choice = data.get("tool_choice")
        if isinstance(choice, str) and choice in ("auto", "none", "required"):
            payload["tool_choice"] = choice
        elif isinstance(choice, dict):
            payload["tool_choice"] = choice
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    if payload["stream"]:
        headers["Accept"] = "text/event-stream"
        return StreamingResponse(
            _http_chat_stream(_ai_endpoint(base_url, "/chat/completions"), headers, payload),
            media_type="text/event-stream",
        )

    try:
        status, upstream = await asyncio.to_thread(
            _http_json, "POST", _ai_endpoint(base_url, "/chat/completions"), headers, payload
        )
    except ConnectionError as exc:
        return _json_error(str(exc), 502)

    if status >= 400:
        return _json_error(_upstream_error(upstream, status), 502, upstreamStatus=status)

    message = {}
    if isinstance(upstream, dict):
        try:
            message = upstream["choices"][0]["message"] or {}
        except (KeyError, IndexError, TypeError):
            message = {}
    content = message.get("content") if isinstance(message.get("content"), str) else ""
    tool_calls = message.get("tool_calls") if isinstance(message.get("tool_calls"), list) else None
    if not content and not tool_calls:
        return _json_error("Upstream response did not include assistant text or tool calls.", 502, upstreamStatus=status)
    return JSONResponse({"content": content, "toolCalls": tool_calls, "message": message, "raw": upstream})


async def ai_models(request: Request) -> Response:
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return _json_error("Expected a JSON request body.", 400)

    try:
        base_url = _clean_base_url(data.get("baseUrl"))
    except ValueError as exc:
        return _json_error(str(exc), 400)

    api_key = str(data.get("apiKey") or "").strip()
    if not api_key:
        return _json_error("API key is required.", 400)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    try:
        status, upstream = await asyncio.to_thread(
            _http_json, "GET", _ai_endpoint(base_url, "/models"), headers
        )
    except ConnectionError as exc:
        return _json_error(str(exc), 502)

    if status >= 400:
        return _json_error(_upstream_error(upstream, status), 502, upstreamStatus=status)
    return JSONResponse(upstream)
