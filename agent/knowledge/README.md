# EEG-Master Knowledge Pack

These notes are compact, source-linked knowledge cards for the EEG-Master agent.
They are intentionally summaries, not copied guideline text. The runtime system
prompt references this pack as background policy, while the agent still relies
on current viewer context, tool results, and expert review.

## Files

- `clinical_eeg_review_framework.md` — a cautious visual-review order for EEG/iEEG.
- `artifacts_and_quality.md` — artifact triage patterns and practical checks.
- `frequency_bands_and_filters.md` — bands, filters, montage caveats, and qEEG limits.
- `agent_operating_principles.md` — how EEG-Master should use tools, screenshots, and uncertainty.
- `signal_workspace.md` — authoritative runtime/developer contract for workspace tools and side effects.
- `source_index.md` — source links and how each source should influence agent behavior.

## Source Pointers

- Standard clinical EEG and EEG-analysis references for visual review, montage,
  filtering, frequency bands, and qEEG caveats.
- EEG artifact review literature covering electrode/contact, line noise, muscle,
  ocular, cardiac, and motion artifact.
- Electrophysiology event-annotation work including HED-SCORE/SCORE ideas for
  reproducible marker language.
- Project-specific viewer behavior in `frontend/js/viewer.js`.

The Signal Workspace guide is runtime-readable through the Agent API; the
remaining cards are distilled background policy. None must be treated as medical
decision support. EEG-Master should always frame outputs as signal observations
requiring qualified clinical interpretation.
