"""EEG skill registry for EEG-Master.

Skills are Markdown prior/context packs, not third-party plugins. They can guide
tool use and reporting style, but they never add tool permissions or override
safety/side-effect policy.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any

AGENT_DIR = Path(__file__).resolve().parent.parent
BUNDLED_SKILLS_DIR = AGENT_DIR / "skills"
USER_SKILLS_DIR = Path(os.environ.get(
    "EEG_MASTER_USER_SKILLS_DIR",
    str(AGENT_DIR.parent / "runtime" / "agent-skills"),
))

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")
MAX_SKILL_MARKDOWN_CHARS = 120_000
MAX_FIELD_CHARS = 2_000


class SkillError(ValueError):
    """Raised when user-provided skill content is invalid."""


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


def _string_list(value, limit: int = 24) -> list[str]:
    if isinstance(value, list):
        values = value
    elif isinstance(value, str) and value.strip():
        values = [value]
    else:
        return []
    out = []
    for item in values:
        text = re.sub(r"\s+", " ", str(item)).strip()
        if text and text not in out:
            out.append(text[:120])
        if len(out) >= limit:
            break
    return out


def _validate_name(name: str) -> str:
    clean = str(name or "").strip()
    if not _NAME_RE.match(clean):
        raise KeyError(clean)
    return clean


def _skill_path(root: Path, name: str) -> Path:
    clean = _validate_name(name)
    path = root / clean / "SKILL.md"
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise KeyError(clean) from exc
    return path


def _load_skill_from(root: Path, name: str, source: str) -> dict[str, Any]:
    path = _skill_path(root, name)
    if not path.exists():
        raise KeyError(name)
    raw = path.read_text(encoding="utf-8")
    frontmatter, body = _parse_frontmatter(raw)
    resolved_name = str(frontmatter.get("name") or path.parent.name).strip()
    if resolved_name != path.parent.name or not _NAME_RE.match(resolved_name):
        raise SkillError(f"Invalid skill name in {path}")
    return {
        "name": resolved_name,
        "title": str(frontmatter.get("title") or resolved_name).strip()[:180],
        "description": str(frontmatter.get("description") or "").strip()[:MAX_FIELD_CHARS],
        "version": str(frontmatter.get("version") or "").strip()[:80],
        "category": str(frontmatter.get("category") or "workflow").strip()[:80],
        "defaultEnabled": bool(frontmatter.get("default_enabled", False)),
        "triggers": _string_list(frontmatter.get("triggers")),
        "tags": _string_list(frontmatter.get("tags")),
        "allowedTools": _string_list(frontmatter.get("allowed_tools")),
        "body": body,
        "sourceText": raw,
        "source": source,
        "editable": source == "user",
        "deletable": source == "user",
    }


def _manifest(skill: dict[str, Any]) -> dict[str, Any]:
    return {key: skill[key] for key in (
        "name", "title", "description", "version", "category",
        "defaultEnabled", "triggers", "tags", "allowedTools",
        "source", "editable", "deletable",
    )}


def _load_any_skill(name: str) -> dict[str, Any]:
    clean = _validate_name(name)
    for root, source in ((USER_SKILLS_DIR, "user"), (BUNDLED_SKILLS_DIR, "bundled")):
        try:
            return _load_skill_from(root, clean, source)
        except KeyError:
            continue
    raise KeyError(clean)


def _iter_root(root: Path, source: str) -> list[dict[str, Any]]:
    if not root.exists():
        return []
    skills = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        try:
            skills.append(_manifest(_load_skill_from(root, entry.name, source)))
        except (KeyError, OSError, SkillError):
            continue
    return skills


def list_skills() -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for skill in _iter_root(BUNDLED_SKILLS_DIR, "bundled"):
        merged[skill["name"]] = skill
    for skill in _iter_root(USER_SKILLS_DIR, "user"):
        merged[skill["name"]] = skill
    return sorted(merged.values(), key=lambda item: (item["source"] != "user", item["title"].lower()))


def get_skill(name: str) -> dict[str, Any]:
    skill = _load_any_skill(str(name or ""))
    return {**_manifest(skill), "markdown": skill["body"], "sourceText": skill["sourceText"]}


def _clean_field(value, fallback: str = "", limit: int = 180) -> str:
    text = re.sub(r"\s+", " ", str(value or fallback)).strip()
    if len(text) > limit:
        raise SkillError(f"Field is too long; max {limit} characters.")
    return text


def _yaml_list(items: list[str]) -> str:
    if not items:
        return "[]"
    return "\n" + "\n".join(f"  - {item}" for item in items)


def _compose_skill_text(name: str, payload: dict[str, Any]) -> str:
    body = str(payload.get("markdown") or payload.get("body") or "").strip()
    if not body:
        raise SkillError("Skill Markdown body is required.")
    if len(body) > MAX_SKILL_MARKDOWN_CHARS:
        raise SkillError(f"Skill Markdown is too long; max {MAX_SKILL_MARKDOWN_CHARS} characters.")

    title = _clean_field(payload.get("title"), name, 180)
    description = _clean_field(payload.get("description"), "", MAX_FIELD_CHARS)
    version = _clean_field(payload.get("version"), "1.0", 80)
    category = _clean_field(payload.get("category"), "workflow", 80)
    default_enabled = bool(payload.get("defaultEnabled", payload.get("default_enabled", False)))
    triggers = _string_list(payload.get("triggers"))
    tags = _string_list(payload.get("tags"))
    allowed_tools = _string_list(payload.get("allowedTools", payload.get("allowed_tools")))

    frontmatter = [
        "---",
        f"name: {name}",
        f"title: {title}",
        f"description: {description}",
        f"version: {version}",
        f"category: {category}",
        f"default_enabled: {'true' if default_enabled else 'false'}",
        f"triggers:{_yaml_list(triggers)}",
        f"tags:{_yaml_list(tags)}",
        f"allowed_tools:{_yaml_list(allowed_tools)}",
        "---",
        "",
    ]
    return "\n".join(frontmatter) + body.rstrip() + "\n"


def create_skill(payload: dict[str, Any]) -> dict[str, Any]:
    name = _validate_name(str(payload.get("name") or ""))
    path = _skill_path(USER_SKILLS_DIR, name)
    if path.exists():
        raise FileExistsError(name)
    text = _compose_skill_text(name, payload)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("SKILL.md.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return get_skill(name)


def update_skill(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    clean = _validate_name(name)
    path = _skill_path(USER_SKILLS_DIR, clean)
    if not path.exists():
        raise KeyError(clean)
    text = _compose_skill_text(clean, {**payload, "name": clean})
    tmp = path.with_name("SKILL.md.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return get_skill(clean)


def delete_skill(name: str) -> None:
    clean = _validate_name(name)
    path = _skill_path(USER_SKILLS_DIR, clean)
    if not path.exists():
        raise KeyError(clean)
    shutil.rmtree(path.parent)
