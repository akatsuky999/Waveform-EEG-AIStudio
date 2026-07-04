"""Conversation-scoped backend attachment cache for EEG-Master.

Companion files (segment-label CSVs, annotation TXT/JSON) that the user attaches
to a chat are parsed once and cached here, keyed by conversation id. This is a
backend *scratch* cache, by design:

- in-memory only, never written to disk;
- capped per file, per conversation, and globally, with LRU eviction;
- cleared on server restart.

The durable copy lives in the browser IndexedDB, scoped to the conversation, and
the frontend can restore this cache after a dev-server reload. The store also
feeds the run_python sandbox: attachments for the active conversation are
injected as an ``attachments`` global so model code can align an external label
file against the loaded signal.

Parsing is dependency-free (stdlib ``csv`` / ``json``). Each attachment keeps a
size-capped decoded text plus a compact structured *preview* (delimiter, header,
column types, candidate time columns, sample rows) so the agent can plan an
import without pulling the whole file into the model context.
"""

from __future__ import annotations

import csv
import io
import json
import re
import threading
import uuid
from collections import OrderedDict

# ---- caps (a scratch space, not a store) ---------------------------------
MAX_FILE_BYTES = 4 * 1024 * 1024          # 4 MB per attachment (decoded text)
MAX_TOTAL_BYTES = 24 * 1024 * 1024        # 24 MB across all conversations
MAX_FILES_PER_CONV = 16
MAX_CONVERSATIONS = 8
MAX_SANDBOX_BYTES = 6 * 1024 * 1024       # cap injected into a single run_python

# ---- parsing/preview shaping ---------------------------------------------
PREVIEW_ROWS = 8
SAMPLE_VALUES = 4
DEFAULT_READ_LINES = 400
MAX_READ_LINES = 2000
MAX_GREP_MATCHES = 200

_TEXT_EXTS = {"txt", "text", "log", "md", "tsv", "csv", "json", "annot", "annotations", "tab", "dat"}
_TABULAR_EXTS = {"csv", "tsv", "tab"}

# Column names that plausibly carry a time / index base for label alignment.
_TIME_NAME = re.compile(
    r"^(onset|offset|start|stop|end|begin|time|times?|sec|second|seconds|"
    r"latency|position|sample|samples|index|idx|dur|duration|t|ts|timestamp|clock)$",
    re.IGNORECASE,
)
_CLOCK = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$")

_LOCK = threading.Lock()
_STORE: "OrderedDict[str, OrderedDict[str, dict]]" = OrderedDict()
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def clean_id(value: str | None = None) -> str:
    value = str(value or "").strip()
    return value if _ID_RE.match(value) else new_id()


# --------------------------------------------------------------------- helpers
def _ext_of(name: str) -> str:
    match = re.search(r"\.([^./\\]+)$", str(name or "").lower())
    return match.group(1) if match else ""


def _kind_of(name: str, text: str) -> str:
    ext = _ext_of(name)
    if ext == "json":
        return "json"
    if ext in _TABULAR_EXTS:
        return "tsv" if ext in {"tsv", "tab"} else "csv"
    if ext in {"annot", "annotations"}:
        return "annot"
    # Sniff: a comma/tab-delimited body with a stable column count reads as a table.
    head = "\n".join(text.splitlines()[:20])
    if head.strip().startswith(("{", "[")):
        try:
            json.loads(text)
            return "json"
        except ValueError:
            pass
    delimiter = _sniff_delimiter(head)
    if delimiter:
        return "tsv" if delimiter == "\t" else "csv"
    return "text"


def _sniff_delimiter(sample: str):
    sample = sample.strip()
    if not sample:
        return None
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        return dialect.delimiter
    except csv.Error:
        pass
    # Fallback: pick the delimiter that yields the most consistent >1 column count.
    lines = [line for line in sample.splitlines() if line.strip()][:10]
    if len(lines) < 2:
        return None
    best = None
    for candidate in (",", "\t", ";", "|"):
        counts = [line.count(candidate) for line in lines]
        if counts[0] >= 1 and len(set(counts)) == 1:
            if best is None or counts[0] > best[1]:
                best = (candidate, counts[0])
    return best[0] if best else None


def _looks_numeric(value: str) -> bool:
    value = value.strip()
    if not value:
        return False
    try:
        float(value)
        return True
    except ValueError:
        return False


def _column_type(values) -> str:
    seen = [v for v in values if str(v).strip() != ""]
    if not seen:
        return "empty"
    if all(_looks_numeric(v) for v in seen):
        return "number"
    if all(_CLOCK.match(str(v).strip()) for v in seen):
        return "clock"
    return "text"


def _detect_time_columns(header, columns) -> list:
    found = []
    for index, name in enumerate(header):
        col = columns[index] if index < len(columns) else {}
        by_name = bool(_TIME_NAME.match(str(name or "").strip()))
        by_type = col.get("type") in {"number", "clock"}
        if by_name and by_type:
            found.append({"name": name, "index": index, "type": col.get("type")})
    return found


def _parse_tabular(text: str, delimiter: str) -> dict:
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = []
    for row in reader:
        rows.append(row)
        if len(rows) > 5000:  # preview only scans the head; import re-reads exactly
            break
    if not rows:
        return {"header": [], "columns": [], "rowCount": 0, "sampleRows": [], "timeColumns": []}

    first = rows[0]
    header_is_labels = any(not _looks_numeric(cell) for cell in first) and len(rows) > 1
    header = [str(cell).strip() for cell in first] if header_is_labels else [f"col{i}" for i in range(len(first))]
    body = rows[1:] if header_is_labels else rows

    width = len(header)
    columns = []
    for index in range(width):
        values = [row[index] for row in body[:200] if index < len(row)]
        columns.append({
            "name": header[index],
            "type": _column_type(values),
            "sampleValues": [str(v).strip() for v in values[:SAMPLE_VALUES]],
        })
    return {
        "header": header,
        "columns": columns,
        "rowCount": len(body),
        "sampleRows": [row[:width] for row in body[:PREVIEW_ROWS]],
        "timeColumns": _detect_time_columns(header, columns),
        "hasHeaderRow": header_is_labels,
    }


def _parse_json(text: str) -> dict:
    try:
        value = json.loads(text)
    except ValueError as exc:
        return {"valid": False, "error": f"Invalid JSON: {exc}"}
    if isinstance(value, list):
        keys = sorted({k for item in value[:50] if isinstance(item, dict) for k in item}) if value else []
        return {"valid": True, "shape": "array", "length": len(value), "recordKeys": keys[:24]}
    if isinstance(value, dict):
        return {"valid": True, "shape": "object", "keys": list(value.keys())[:32]}
    return {"valid": True, "shape": type(value).__name__}


def _build_preview(kind: str, text: str) -> dict:
    if kind in {"csv", "tsv"}:
        delimiter = "\t" if kind == "tsv" else (_sniff_delimiter("\n".join(text.splitlines()[:20])) or ",")
        preview = _parse_tabular(text, delimiter)
        preview["delimiter"] = "\\t" if delimiter == "\t" else delimiter
        return preview
    if kind == "json":
        return _parse_json(text)
    if kind == "annot":
        # Annotation sidecars are usually whitespace/comma tables; try tabular,
        # fall back to a text head with time-token detection.
        delimiter = _sniff_delimiter("\n".join(text.splitlines()[:20]))
        if delimiter:
            preview = _parse_tabular(text, delimiter)
            preview["delimiter"] = "\\t" if delimiter == "\t" else delimiter
            preview["form"] = "tabular"
            return preview
    lines = text.splitlines()
    return {"form": "text", "headLines": lines[:PREVIEW_ROWS], "lineCount": len(lines)}


def _summary(entry: dict) -> dict:
    return {
        "id": entry["id"],
        "name": entry["name"],
        "kind": entry["kind"],
        "ext": entry["ext"],
        "sizeBytes": entry["sizeBytes"],
        "lineCount": entry["lineCount"],
        "truncated": entry["truncated"],
        "preview": entry["preview"],
        "source": entry.get("source", "attach"),
    }


# --------------------------------------------------------------------- eviction
def _total_bytes() -> int:
    return sum(e["sizeBytes"] for bucket in _STORE.values() for e in bucket.values())


def _evict_locked() -> None:
    while len(_STORE) > MAX_CONVERSATIONS:
        _STORE.popitem(last=False)
    while _total_bytes() > MAX_TOTAL_BYTES and _STORE:
        oldest_conv = next(iter(_STORE))
        bucket = _STORE[oldest_conv]
        if bucket:
            bucket.popitem(last=False)
        if not bucket:
            _STORE.pop(oldest_conv, None)


# --------------------------------------------------------------------- public API
def put_attachment(conversation_id: str, name: str, text: str, source: str = "attach",
                   attachment_id: str | None = None) -> dict:
    """Parse and cache one companion file. Returns its summary (never the body).

    Raises ValueError on empty input or an over-cap file.
    """
    conversation_id = str(conversation_id or "").strip()
    if not conversation_id:
        raise ValueError("conversationId is required.")
    name = (str(name or "").strip() or "attachment.txt")[:200]
    text = text if isinstance(text, str) else str(text or "")
    if not text.strip():
        raise ValueError("Attachment is empty.")

    encoded = text.encode("utf-8")
    truncated = False
    if len(encoded) > MAX_FILE_BYTES:
        text = encoded[:MAX_FILE_BYTES].decode("utf-8", "ignore")
        truncated = True

    kind = _kind_of(name, text)
    entry = {
        "id": clean_id(attachment_id),
        "name": name,
        "ext": _ext_of(name),
        "kind": kind,
        "text": text,
        "sizeBytes": len(text.encode("utf-8")),
        "lineCount": text.count("\n") + (0 if text.endswith("\n") else 1),
        "truncated": truncated,
        "preview": _build_preview(kind, text),
        "source": source,
    }
    with _LOCK:
        bucket = _STORE.get(conversation_id)
        if bucket is None:
            bucket = _STORE[conversation_id] = OrderedDict()
        _STORE.move_to_end(conversation_id)
        bucket[entry["id"]] = entry
        while len(bucket) > MAX_FILES_PER_CONV:
            bucket.popitem(last=False)
        _evict_locked()
    return _summary(entry)


def list_attachments(conversation_id: str) -> list:
    with _LOCK:
        bucket = _STORE.get(str(conversation_id or ""))
        return [_summary(entry) for entry in bucket.values()] if bucket else []


def get_attachment(conversation_id: str, attachment_id: str):
    with _LOCK:
        bucket = _STORE.get(str(conversation_id or ""))
        if not bucket:
            return None
        entry = bucket.get(str(attachment_id or ""))
        if entry is not None:
            _STORE.move_to_end(conversation_id)
        return entry


def drop_attachment(conversation_id: str, attachment_id: str) -> bool:
    with _LOCK:
        bucket = _STORE.get(str(conversation_id or ""))
        if not bucket:
            return False
        removed = bucket.pop(str(attachment_id or ""), None) is not None
        if not bucket:
            _STORE.pop(conversation_id, None)
        return removed


def drop_conversation(conversation_id: str) -> bool:
    with _LOCK:
        return _STORE.pop(str(conversation_id or ""), None) is not None


def read_attachment(conversation_id: str, attachment_id: str, offset: int = 1, limit=None) -> dict:
    """Return a cat -n style slice: 1-indexed lines, like the Read tool."""
    entry = get_attachment(conversation_id, attachment_id)
    if entry is None:
        raise KeyError("attachment")
    lines = entry["text"].splitlines()
    total = len(lines)
    try:
        start = max(1, int(offset or 1))
    except (TypeError, ValueError):
        start = 1
    try:
        count = int(limit) if limit is not None else DEFAULT_READ_LINES
    except (TypeError, ValueError):
        count = DEFAULT_READ_LINES
    count = max(1, min(count, MAX_READ_LINES))
    window = lines[start - 1:start - 1 + count]
    numbered = "\n".join(f"{start + i}\t{line}" for i, line in enumerate(window))
    return {
        "id": entry["id"],
        "name": entry["name"],
        "kind": entry["kind"],
        "startLine": start,
        "endLine": start - 1 + len(window),
        "totalLines": total,
        "truncated": entry["truncated"] or (start - 1 + len(window) < total),
        "content": numbered,
    }


def grep_attachment(conversation_id: str, attachment_id: str, pattern: str,
                    mode: str = "content", ignore_case: bool = True, max_matches=None) -> dict:
    """ripgrep-lite over one attachment: modes content / lines / count."""
    entry = get_attachment(conversation_id, attachment_id)
    if entry is None:
        raise KeyError("attachment")
    pattern = str(pattern or "")
    if not pattern:
        raise ValueError("pattern is required.")
    try:
        regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as exc:
        raise ValueError(f"Invalid pattern: {exc}") from exc
    try:
        cap = int(max_matches) if max_matches is not None else MAX_GREP_MATCHES
    except (TypeError, ValueError):
        cap = MAX_GREP_MATCHES
    cap = max(1, min(cap, MAX_GREP_MATCHES))

    matches = []
    count = 0
    for index, line in enumerate(entry["text"].splitlines(), start=1):
        if regex.search(line):
            count += 1
            if len(matches) < cap:
                matches.append({"line": index, "text": line[:400]})
    result = {"id": entry["id"], "name": entry["name"], "pattern": pattern, "count": count}
    if mode == "count":
        return result
    if mode == "lines":
        result["lines"] = [m["line"] for m in matches]
    else:
        result["matches"] = matches
    result["truncated"] = count > len(matches)
    return result


def attachments_for_sandbox(conversation_id: str, budget_bytes: int = MAX_SANDBOX_BYTES) -> list:
    """Compact payload injected into run_python as the ``attachments`` global.

    Ships decoded text + the structured preview so model code can, e.g., parse a
    label CSV with numpy/csv and align it to ``data``/``fs``. Honors a byte
    budget so a huge attachment never blows up the worker payload.
    """
    with _LOCK:
        bucket = _STORE.get(str(conversation_id or ""))
        entries = list(bucket.values()) if bucket else []
    payload = []
    used = 0
    for entry in entries:
        text = entry["text"]
        remaining = budget_bytes - used
        if remaining <= 0:
            break
        clipped = text
        truncated = entry["truncated"]
        if len(text.encode("utf-8")) > remaining:
            clipped = text.encode("utf-8")[:remaining].decode("utf-8", "ignore")
            truncated = True
        used += len(clipped.encode("utf-8"))
        payload.append({
            "id": entry["id"],
            "name": entry["name"],
            "kind": entry["kind"],
            "text": clipped,
            "preview": entry["preview"],
            "truncated": truncated,
        })
    return payload
