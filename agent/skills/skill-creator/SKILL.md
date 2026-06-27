---
name: skill-creator
title: Skill Creator
description: Author, save, and improve local EEG-Master skills (Markdown prior/context packs). Use this whenever the user wants to create, write, make, capture, summarize, distill, package, or update a skill — for example "turn this workflow into a skill", "summarize this as a skill", "make a skill for our center's reporting format", "save this as a reusable skill", or "improve the seizure-localization skill". Covers the required SKILL.md shape, how to write a description that triggers reliably, and how to persist the skill with create_agent_skill / update_agent_skill.
version: 1.0
category: meta
default_enabled: false
triggers:
  - create a skill
  - write a skill
  - make a skill
  - 创建skill
  - 写一个skill
  - 把这个流程做成skill
  - 总结一个skill
  - 总结为skill
  - 封装成skill
  - turn this into a skill
  - summarize this as a skill
  - package this as a skill
  - capture this workflow
  - improve the skill
  - update the skill
tags:
  - meta
  - authoring
  - skills
  - workflow
allowed_tools:
  - list_agent_skills
  - read_agent_skill
  - create_agent_skill
  - update_agent_skill
  - get_workspace_configuration
---
# Skill Creator

Use this skill when the user wants to capture, summarize, package, or distill an
EEG/iEEG workflow, a center's conventions, a dataset's quirks, or a reporting
format as a **reusable EEG-Master skill**, or to improve an existing one.

A skill here is a single Markdown **prior/context pack** — not a plugin. It guides
how you analyse and report; it never adds tool permissions and never overrides
safety, annotation, export, or file-switch policy. Keep that boundary explicit in
everything you write.

## What a skill is in this workspace

- **Storage.** One folder, one file: `<skill-name>/SKILL.md`. User skills live
  under the local `runtime/agent-skills/` directory (editable, deletable); bundled
  skills ship with the app (read-only in the UI). There are **no** bundled
  scripts, subagents, or eval harnesses — the whole skill is its Markdown.
- **Loading (progressive disclosure).** Only the `name` + `description` ride in
  context as a manifest at all times. The full body is pulled in on demand via
  `read_agent_skill` when the skill is enabled, named, or its triggers match.
  So the description does the triggering work; the body does the teaching.
- **A prior, not evidence.** Skill text is assumption/context, never signal data.
  When a skill changes how you read a recording, say so and keep the skill prior
  separate from tool-measured findings.

## The loop

1. **Capture intent.** Figure out what the skill should make you do, and *when* it
   should fire. If the current conversation already contains the workflow the user
   wants to keep ("make that a skill"), mine it first — the tools used, the order
   of steps, the corrections the user made, the output format they liked.
2. **Draft** the frontmatter + body (sections below).
3. **Confirm scope** with the user if anything is ambiguous (triggers, output
   format, boundaries). A short check beats a wrong skill.
4. **Save** with `create_agent_skill` (new) or `update_agent_skill` (existing user
   skill) — only after the user has clearly asked you to create/save it, or to
   summarize/package the workflow as a skill.
5. **Verify** by reading it back and confirming it lists.

## SKILL.md shape

The framework composes the YAML frontmatter from the fields you pass to
`create_agent_skill`; you write the Markdown **body** only. Fields:

| field | required | purpose |
| --- | --- | --- |
| `name` | yes | Kebab-case id, also the folder name. `^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$`. |
| `description` | yes | The trigger. What it does **and** when to use it. ≤ ~2000 chars. |
| `body` | yes | The Markdown instructions (no frontmatter — the framework adds it). |
| `title` | no | Human-readable title; defaults to `name`. |
| `category` | no | e.g. `workflow`, `reporting`, `dataset`, `meta`. |
| `version` | no | e.g. `1.0`. |
| `triggers` | no | Short user phrases/contexts that should surface the skill. |
| `tags` | no | Free-form labels for search/grouping. |
| `allowedTools` | no | **Informational only** — a hint of which tools the workflow leans on. It does NOT grant or restrict permissions. |
| `defaultEnabled` | no | Whether it starts enabled. Default off; rely on triggers + description. |

## Writing the description (most important)

The description is the only part always in context, so it is what decides whether
the skill triggers. Make it do two jobs: **what** the skill does and **when** to
use it — including concrete phrasings a user would actually type. Models tend to
*under*-trigger skills, so lean slightly pushy.

- Weak: `Helps with seizure localization.`
- Strong: `Preliminary seizure-candidate localization in long, high-channel iEEG.
  Use whenever the user asks to find/localize candidate seizure onsets, screen a
  long recording for ictal activity, or rank channels/time-windows in an iEEG file
  — even if they don't say "seizure" explicitly.`

Put all "when to use" cues in the description, not buried in the body.

## Writing the body

- **Imperative voice**, and **explain the why.** These models reason well; a rule
  with a reason ("exclude DC/EKG channels first, because they dominate RMS and bury
  real onsets") generalizes far better than a bare `ALWAYS`. If you catch yourself
  stacking all-caps MUSTs, reframe as reasoning instead.
- **State scope and non-goals** up front (what the skill is for, and what it is
  explicitly *not* for).
- **Pin down the output format** when the user cares about one. Give the exact
  table columns or report headings.
- **Use examples** — a short input→output pair teaches more than a paragraph.
- **Restate the safety boundary**: candidate findings need human review; never
  write events / switch files / export unless the user asked this turn; morphology
  is montage/filter dependent.
- **Keep it focused.** If it grows past a few hundred lines, it is probably two
  skills, or it is overfit to one example.

Suggested skeleton:

```markdown
# <Title>

<One-paragraph: what this is for and the one-line boundary.>

## Scope and boundaries
## <Workflow steps, each with the reasoning>
## Output format
## Known failure modes
```

## Saving the skill

Persisting a skill writes a file, so it is a gated side effect — the same class as
annotating or exporting. Only call the write tools when the user explicitly asked
you to create/save/update a skill, or to summarize/package something as a skill,
**in the current turn**. If they only want to see a draft, put the SKILL.md in
your reply and stop.

- `create_agent_skill({ name, title, description, body, category?, version?,
  triggers?, tags?, allowedTools?, defaultEnabled? })` — new skill.
- `update_agent_skill({ name, body, ... })` — rewrite an existing **user** skill
  in place (bundled skills can't be edited; copy them into a user skill first).

If the gate blocks you, it means the request wasn't explicit — draft in chat and
ask the user to confirm rather than retrying.

## Verify

After saving, call `read_agent_skill(name)` to confirm the body and frontmatter
round-tripped, and `list_agent_skills` to confirm it appears with the right
source/triggers. Report the saved name and how to enable it.

## Worked example

User: "We always review with a bipolar montage and 1–40 Hz, and we want the report
as a fixed table. Save that as a skill."

A good `create_agent_skill` call sets `name: center-bipolar-review`, a description
that triggers on "review this recording / our standard review / set up the montage
for review", and a body that: (1) sets montage=bipolar + filterPreset≈seizure via
`configure_signal_processing`, explaining bipolar aids focality and 1–40 Hz
suppresses muscle/line noise; (2) frames channels/time with `control_signal_view`;
(3) renders evidence; (4) emits the fixed report table; (5) repeats the
"montage/filter-dependent, needs expert review, no events unless asked" boundary.

## Anti-patterns

- A description that lists only *what* and never *when* → it won't trigger.
- Claiming a skill grants tools or relaxes safety → it never does; don't imply it.
- Hard-coding one recording's numbers as universal thresholds → prefer
  per-channel/per-recording baselines and explain the reasoning.
- Bundling unrelated workflows in one skill → split them.
- Saving without an explicit request → draft instead.
