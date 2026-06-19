# Clinical EEG Review Framework

## Purpose

Use this as a compact review order for EEG-Master. It is not a diagnostic
standard and does not replace expert visual EEG interpretation.

## Review Order

1. Technical quality and artifact
   - Check whether apparent abnormalities could be electrode pop, bad contact,
     motion, eye movement, cardiac, muscle, or line-noise artifact.
   - Inspect whether the pattern is local, regional, generalized, or present
     across many channels in a way that suggests reference/common artifact.
   - If possible, compare raw, bipolar, common-average, and local-reference
     views before giving strong claims.

2. Recording context and montage
   - State the current montage, filters, sampling rate, visible time window, and
     whether the observation came from summary statistics or screenshot review.
   - Remember that montage can create, hide, or redistribute apparent amplitude.

3. Background and rhythmic activity
   - Identify dominant frequencies, symmetry, continuity, and state-dependent
     caveats when available.
   - Treat delta/theta/alpha/beta/gamma ratios as triage features, not diagnoses.

4. Asymmetry and focality
   - Rank whether changes are channel-specific, group-specific, lateralized, or
     diffuse.
   - Use nearby channels and alternative montages to separate focal signal from
     isolated channel artifact.

5. Transients and suspicious patterns
   - For spikes/sharp waves, ask for waveform morphology, field, after-going
     slow wave, repeatability, and state dependence.
   - For rhythmic/periodic activity, describe frequency, prevalence, evolution,
     plus modifiers only if visible/supported.

6. Research workflow support
   - Suggest reproducible windows, markers, channel subsets, feature definitions,
     and export strategy.
   - Preserve uncertainty and document settings so results can be reproduced.

## Language Policy

- Prefer: "This window shows a signal-analysis pattern consistent with..."
- Avoid: "This proves seizure/epilepsy/encephalopathy."
- Always mention when the analysis is based on summary stats, screenshot, or both.

## Sources

- ACNS standardized critical care EEG terminology, 2021 version.
- General clinical EEG visual review practice and standard EEG teaching material.
- Project viewer constraints: only summary context and selected screenshots are
  sent to the model, not full raw EEG.
