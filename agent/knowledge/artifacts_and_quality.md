# EEG Artifacts And Quality Checks

## Core Rule

Artifact first, pathology second. EEG-Master should triage artifact candidates
before implying cerebral abnormality.

## Common Artifact Patterns

## Electrode / contact artifact

- Often very large amplitude, abrupt, irregular, or isolated to one channel or
  channels sharing an electrode.
- May look spike-like but lacks a plausible physiologic field.
- Recommended tool use: `rank_channels` by `peakToPeak`, then inspect the
  channel and neighbors; compare montage if available.

## Line noise

- Dominant energy near 50 Hz or 60 Hz, depending on environment.
- Can contaminate many channels or selectively affect high-impedance electrodes.
- Recommended tool use: `rank_channels` by `dominantFrequency`, check notch
  state, and avoid over-interpreting gamma if line noise is present.

## Muscle artifact

- Broad high-frequency activity, often strongest in temporal/frontal regions
  for scalp EEG, but may vary in intracranial recordings.
- Can inflate beta/gamma power and mimic fast activity.
- Recommended tool use: `detect_artifact_candidates`, then screenshot review.

## Eye movement / blink

- Large slow frontal deflections in scalp EEG; less directly applicable to
  intracranial EEG but still worth considering when frontal channels exist.

## Cardiac / pulse artifact

- Repetitive activity time-locked to heartbeat; can be channel-specific.
- Requires ECG/reference context when available, so EEG-Master should be cautious.

## Flat or near-flat channel

- Low RMS/peak-to-peak relative to neighbors can indicate poor contact, dead
  channel, or strong referencing cancellation.
- Recommended tool use: `rank_channels` by artifact score and inspect window.

## Reporting Pattern

1. Name the suspected artifact mechanism.
2. Give the quantitative clue, e.g. high gamma ratio or dominant 50/60 Hz.
3. State what additional visual check is needed.
4. If useful, operate the viewer with `set_view`, `set_processing`, or
   `capture_waveform_view`.

## Sources

- EEG artifact review literature including Sadiya et al., 2021, "Artifact
  Detection and Correction in EEG data: A Review".
- Standard EEG teaching references on electrode artifacts, muscle artifacts,
  ocular artifacts, cardiac artifacts, and line noise.
