from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent.backend import skills as registry


def write_skill(root: Path, name: str, title: str = "Test Skill") -> None:
    path = root / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""---
name: {name}
title: {title}
description: A local EEG workflow.
version: 1.0
category: workflow
default_enabled: false
triggers:
  - 发作定位
tags:
  - iEEG
allowed_tools:
  - signal_query
---

# {title}

This skill is not a diagnostic protocol.
""",
        encoding="utf-8",
    )


class AgentSkillRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bundled = self.root / "bundled"
        self.user = self.root / "user"
        self.patch_bundled = mock.patch.object(registry, "BUNDLED_SKILLS_DIR", self.bundled)
        self.patch_user = mock.patch.object(registry, "USER_SKILLS_DIR", self.user)
        self.patch_bundled.start()
        self.patch_user.start()

    def tearDown(self):
        self.patch_user.stop()
        self.patch_bundled.stop()
        self.tmp.cleanup()

    def test_lists_user_and_bundled_manifests_without_body(self):
        write_skill(self.bundled, "bundled-review", "Bundled Review")
        write_skill(self.user, "long-ieeg-seizure-localization", "Long iEEG")

        skills = registry.list_skills()
        names = {skill["name"] for skill in skills}

        self.assertEqual(names, {"bundled-review", "long-ieeg-seizure-localization"})
        user_skill = next(item for item in skills if item["source"] == "user")
        self.assertEqual(user_skill["name"], "long-ieeg-seizure-localization")
        self.assertTrue(user_skill["editable"])
        self.assertTrue(user_skill["deletable"])
        self.assertIn("发作定位", user_skill["triggers"])
        self.assertNotIn("markdown", user_skill)

    def test_user_skill_overrides_bundled_skill_with_same_name(self):
        write_skill(self.bundled, "shared-skill", "Bundled")
        write_skill(self.user, "shared-skill", "User")

        skill = registry.get_skill("shared-skill")

        self.assertEqual(skill["source"], "user")
        self.assertEqual(skill["title"], "User")

    def test_create_update_and_delete_user_skill(self):
        created = registry.create_skill({
            "name": "center-a-prior",
            "title": "Center A Prior",
            "description": "Center-specific iEEG context.",
            "version": "1.0",
            "category": "center",
            "triggers": ["center-a", "中心A"],
            "tags": ["iEEG"],
            "allowedTools": ["signal_query", "run_python"],
            "markdown": "# Center A Prior\n\nUse artifact-first review.",
        })

        self.assertEqual(created["source"], "user")
        self.assertIn("Center A Prior", created["sourceText"])

        updated = registry.update_skill("center-a-prior", {
            "title": "Center A Revised",
            "description": "Updated.",
            "category": "center",
            "markdown": "# Center A Revised\n\nUpdated context.",
        })
        self.assertEqual(updated["title"], "Center A Revised")
        self.assertIn("Updated context", updated["markdown"])

        registry.delete_skill("center-a-prior")
        with self.assertRaises(KeyError):
            registry.get_skill("center-a-prior")

    def test_rejects_unknown_or_unsafe_skill_names(self):
        with self.assertRaises(KeyError):
            registry.get_skill("../AGENTS")
        with self.assertRaises(KeyError):
            registry.get_skill("missing-skill")
        with self.assertRaises(KeyError):
            registry.create_skill({"name": "../bad", "markdown": "# bad"})


class BundledSkillCreatorTests(unittest.TestCase):
    """The shipped skill-creator bundled skill loads as a read-only manifest."""

    def test_skill_creator_ships_as_a_bundled_skill(self):
        names = {skill["name"]: skill for skill in registry.list_skills()}
        self.assertIn("skill-creator", names)
        manifest = names["skill-creator"]
        self.assertEqual(manifest["source"], "bundled")
        self.assertFalse(manifest["editable"])
        self.assertFalse(manifest["deletable"])
        self.assertTrue(manifest["description"].strip())
        self.assertIn("summarize", manifest["description"].lower())
        self.assertIn("总结一个skill", manifest["triggers"])

    def test_skill_creator_body_is_readable(self):
        skill = registry.get_skill("skill-creator")
        self.assertEqual(skill["title"], "Skill Creator")
        self.assertIn("create_agent_skill", skill["markdown"])
        self.assertIn("description", skill["markdown"].lower())


if __name__ == "__main__":
    unittest.main()
