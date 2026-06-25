---
name: long-ieeg-seizure-localization
title: Long iEEG Seizure Candidate Localization
description: Prior workflow for preliminary seizure-candidate localization in long, high-channel-count iEEG recordings. Uses artifact-first screening, channel baselines, layered indexed search, bounded Python refinement, and standardized candidate reporting.
version: 1.0
category: workflow
default_enabled: false
triggers:
  - long ieeg
  - seizure localization
  - seizure candidate
  - seizure onset
  - 发作定位
  - 发作候选
  - 长程 iEEG
tags:
  - iEEG
  - long-recording
  - seizure-candidate
  - artifact-first
allowed_tools:
  - get_signal_workspace_state
  - get_workspace_configuration
  - signal_query
  - run_python
  - render_signal_images
  - control_signal_view
---

# Long iEEG Seizure Candidate Localization

Use this skill for preliminary seizure-candidate localization in a single long,
high-channel-count EEG/iEEG recording, especially recordings with intracranial
contacts plus scalp or auxiliary channels.

This skill is not a diagnostic protocol. It only produces candidate time
segments for expert review. Do not write events unless the user explicitly asks
for annotation in the current turn.

## Scope And Boundaries

- Typical recording: duration > 1 hour, channels > 100.
- Goal: quickly localize candidate seizure segments.
- Non-goals: final annotation, deep clinical interpretation, diagnosis, or
  replacing expert review.
- Preferred evidence: indexed search for candidates, bounded Python for exact
  computation, and short-window signal images for morphology.

## Mandatory Pre-Search Checks

Before ranking candidate windows, prevent non-neural channels and fixed artifacts
from dominating RMS, lineLength, or zeroCross.

1. Identify channel classes:
   - A: neural signal channels, such as SEEG depth contacts or cortical contacts.
   - B: non-neural channels, such as DC, Patient Event, EKG, ECG, EMG, REF, GND.
   - C: suspicious/noisy channels that should be downweighted.
2. Exclude B channels from feature search. Channel labels containing `DC`,
   `Patient Event`, `EKG`, `ECG`, `EMG`, `REF`, or `GND` should be excluded.
3. Use `signal_query(op="aggregate")` for broad statistics. Channels with very
   high RMS but low p2p, such as RMS > 10000 uV and p2p < 5000 uV, are likely
   DC drift or saturation and should be excluded or heavily downweighted.
4. Build per-channel baseline statistics from an early resting segment, usually
   the first 10% of the recording. For each neural channel estimate RMS,
   lineLength, and zeroCross mean/std. Prefer z-style deviations from each
   channel baseline over absolute feature ranking.
5. Detect fixed artifact patterns. Downweight or exclude:
   - fixed zeroCross near 0.3906, consistent with 100/256 Hz interference;
   - high lineLength bursts lasting only 1-2 seconds;
   - clipping or saturation near ADC range;
   - zeroCross variance near zero with persistent high score.

## Layered Search Strategy

Do not search all channels once and trust global top ranks. Search by anatomical
or label groups, with explicit channel batches of roughly 10-20 channels when
possible.

### Layer 1: Energy Burst Search

- Use `signal_query(op="search", metric="lineLength")`.
- Search anatomical groups separately, for example FAC, OF, BI, TH, MFAC.
- Record top windows per group.
- Candidate criteria:
  - lineLength exceeds channel baseline by at least 3 standard deviations;
  - at least two anatomical groups trigger in the same time neighborhood;
  - activity persists at least 5 seconds.
- Treat isolated single-channel bursts as artifact until proven otherwise.
- For persistence, aggregate consecutive 1-second windows: if at least five
  windows trigger within +/-60 seconds, treat it as sustained abnormal activity.

### Layer 2: High-Frequency Activity Search

- Use `signal_query(op="search", metric="zeroCross")`.
- Exclude known fixed-frequency channels before interpreting zeroCross.
- Look for zeroCross increases above channel baseline, typically +2 sigma or
  higher.
- Align zeroCross results with lineLength results. A time segment where both
  lineLength and zeroCross rise is more suspicious than either alone.
- Remember the physiological rationale: low-voltage fast activity may not have
  high p2p, but lineLength and zeroCross can rise together.

### Layer 3: Spatial Propagation Check

For each candidate segment, use aggregate checks over `T-10` to `T+duration+10`
seconds and the involved channels.

Compute:

```text
spatial_spread_ratio = triggered_channel_count / total_neural_channel_count
```

Interpretation:

- >30%: possible global/movement artifact, handle cautiously.
- 5-30%: more consistent with focal discharge, raise priority.
- <5%: often isolated single-channel activity, downweight.

Also inspect whether anatomically adjacent contacts show a plausible gradient or
propagation pattern. Plausible local spread raises priority.

## Boundary Refinement

After coarse localization, refine boundaries with bounded `run_python` on an
expanded candidate window. Use 1-second lineLength windows with about 0.25-second
steps, and compare against the channel's baseline. Candidate onset is the first
time lineLength exceeds baseline mean + 3 std.

For large/windowed recordings, always pass `startSec` and `endSec` to
`run_python`; never attempt a full-recording raw scan.

## Candidate Merge And Confidence

Merge nearby triggers on the time axis:

- Merge windows separated by <30 seconds.
- If merged duration <10 seconds, downgrade to low confidence and keep it in
  notes or an appendix rather than the main table.

Confidence:

- High: at least two anatomical groups, lineLength >5 sigma, duration >=20
  seconds, and zeroCross rises at the same time.
- Medium: single anatomical group, duration 10-20 seconds, or lineLength 3-5
  sigma.
- Low / uncertain: isolated single channel, duration <10 seconds, fixed
  zeroCross, or DC/non-neural channel involvement.

## Standard Output

Return a table with these columns:

```text
priority | candidate_id | trigger_channels | start_sec | end_sec | duration_sec | trigger_metrics | confidence | notes
```

State clearly that results are candidate localizations awaiting human review.
Report excluded/downweighted channel groups and the uncertainty introduced by
label quality, artifact filtering, and baseline selection.

## Known Failure Modes

- DC channels can dominate RMS rankings; exclude them before search.
- Automatic channel pruning can miss relevant low-baseline channels; use explicit
  group/channel batches when possible.
- Extreme one-second bursts can be artifacts; require persistence.
- Fixed zeroCross values can look like high-frequency activity; inspect variance
  and repeatability.
- Energy decay near event end can shorten detected segments; allow merge gaps.
- Low-voltage fast onset may be missed by p2p and partially missed by
  lineLength; use zeroCross as a complementary search.
- Absolute feature ranking favors high-baseline contacts; use per-channel
  baseline-normalized deviations.
