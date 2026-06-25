"""Curated EEG skill registry for EEG-Master.

Skills are local Markdown prior/context packs, not third-party plugins. They can
guide tool use and reporting style, but they never add tool permissions or
override safety/side-effect policy.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

AGENT_DIR = Path(__file__).resolve().parent.parent
SKILLS_DIR = AGENT_DIR / "skills"
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")


def _coerce_scalar(value: str) -> Any:
    text = value.strip().strip("'\"")
    low = text.lower()
    if low in {"true", "false"}:
        return low == "true"
    return text


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---"):
        return {}, text.strip()
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text.strip()
    end = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end = index
            break
    if end is None:
        return {}, text.strip()

    data: dict[str, Any] = {}
    current_key = None
    for raw in lines[1:end]:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        stripped = raw.strip()
        if stripped.startswith("- ") and current_key:
            data.setdefault(current_key, []).append(_coerce_scalar(stripped[2:]))
            continue
        if ":" not in raw:
            continue
        key, value = raw.split(":", 1)
        key = key.strip()
        value = value.strip()
        current_key = key
        if not value:
            data[key] = []
        elif value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            data[key] = [_coerce_scalar(item) for item in inner.split(",") if item.strip()] if inner else []
        else:
            data[key] = _coerce_scalar(value)
    body = "\n".join(lines[end + 1:]).strip()
    return data, body


def _string_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _skill_path(name: str) -> Path:
    if not _NAME_RE.match(name or ""):
        raise KeyError(name)
    path = SKILLS_DIR / name / "SKILL.md"
    try:
        path.relative_to(SKILLS_DIR)
    except ValueError as exc:
        raise KeyError(name) from exc
    return path


def _load_skill(name: str) -> dict[str, Any]:
    path = _skill_path(name)
    if not path.exists():
        raise KeyError(name)
    raw = path.read_text(encoding="utf-8")
    frontmatter, body = _parse_frontmatter(raw)
    resolved_name = str(frontmatter.get("name") or path.parent.name)
    if resolved_name != path.parent.name or not _NAME_RE.match(resolved_name):
        raise ValueError(f"Invalid skill name in {path}")
    return {
        "name": resolved_name,
        "title": str(frontmatter.get("title") or resolved_name),
        "description": str(frontmatter.get("description") or "").strip(),
        "version": str(frontmatter.get("version") or "").strip(),
        "category": str(frontmatter.get("category") or "workflow").strip(),
        "defaultEnabled": bool(frontmatter.get("default_enabled", False)),
        "triggers": _string_list(frontmatter.get("triggers")),
        "tags": _string_list(frontmatter.get("tags")),
        "allowedTools": _string_list(frontmatter.get("allowed_tools")),
        "body": body,
    }


def _manifest(skill: dict[str, Any]) -> dict[str, Any]:
    return {key: skill[key] for key in (
        "name", "title", "description", "version", "category",
        "defaultEnabled", "triggers", "tags", "allowedTools",
    )}


def list_skills() -> list[dict[str, Any]]:
    if not SKILLS_DIR.exists():
        return []
    skills = []
    for entry in sorted(SKILLS_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        try:
            skills.append(_manifest(_load_skill(entry.name)))
        except (KeyError, OSError, ValueError):
            continue
    return skills


def get_skill(name: str) -> dict[str, Any]:
    skill = _load_skill(str(name or ""))
    return {**_manifest(skill), "markdown": skill["body"]}
