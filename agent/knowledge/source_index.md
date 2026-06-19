# EEG-Master Source Index

This file records the public references used to seed the local EEG-Master
knowledge cards. The agent should use these as orientation, not as authority for
diagnosis.

## Clinical EEG and Viewer Concepts

- Electroencephalography overview: https://en.wikipedia.org/wiki/Electroencephalography
  - Useful for: frequency-band names, montage concepts, common display-filter
    caveats, visual inspection as the clinical interpretation standard, and
    qEEG caution.
- EEG analysis overview: https://en.wikipedia.org/wiki/EEG_analysis
  - Useful for: separating rhythmic activity, transient morphology, spectral
    features, and quantitative analysis limitations.

## Artifact Handling

- Sadiya, Alhanai, and Ghassemi, "Artifact Detection and Correction in EEG data:
  A Review" (2021): https://arxiv.org/abs/2106.13081
  - Useful for: treating artifact handling as a first-class workflow, and
    distinguishing artifact detection/rejection/correction from interpretation.
- Kaya, "A Brief Summary of EEG Artifact Handling" (2020):
  https://arxiv.org/abs/2001.00693
  - Useful for: broad artifact taxonomy and practical artifact-first framing.
- Aquilue-Llorens and Soria-Frisch, "EEG Artifact Detection and Correction with
  Deep Autoencoders" (2025): https://arxiv.org/abs/2502.08686
  - Useful for: modern automated artifact-detection context. Do not imply these
    models are validated inside this viewer unless explicitly implemented.

## Annotation and Research Workflow

- Hermes et al., "Hierarchical Event Descriptor library schema for EEG data
  annotation" (2023): https://arxiv.org/abs/2310.15173
  - Useful for: structured event/marker language, reproducibility, and BIDS-like
    downstream workflows.

## Agent Policy Implications

- Always say whether an answer is based on quantitative inspection, Python, or
  generated signal images.
- Use `render_signal_images` when morphology matters, following an overview to
  focused-detail workflow.
- Do not write events without an explicit annotation request in the current turn.
- Use conservative phrases such as "signal-analysis observation" and
  "requires expert review in clinical context."
- Do not treat band ratios, dominant frequency, or automated artifact scores as
  diagnostic endpoints.
