from __future__ import annotations

import unittest

from agent.backend.skills import get_skill, list_skills


class AgentSkillRegistryTests(unittest.TestCase):
    def test_lists_curated_skill_manifest_without_body(self):
        skills = list_skills()
        names = {skill["name"] for skill in skills}
        self.assertIn("long-ieeg-seizure-localization", names)
        skill = next(item for item in skills if item["name"] == "long-ieeg-seizure-localization")
        self.assertEqual(skill["category"], "workflow")
        self.assertIn("发作定位", skill["triggers"])
        self.assertNotIn("markdown", skill)

    def test_reads_skill_markdown_body(self):
        skill = get_skill("long-ieeg-seizure-localization")
        self.assertEqual(skill["name"], "long-ieeg-seizure-localization")
        self.assertIn("Long iEEG Seizure Candidate Localization", skill["markdown"])
        self.assertIn("not a diagnostic protocol", skill["markdown"])

    def test_rejects_unknown_or_unsafe_skill_names(self):
        with self.assertRaises(KeyError):
            get_skill("../AGENTS")
        with self.assertRaises(KeyError):
            get_skill("missing-skill")


if __name__ == "__main__":
    unittest.main()
