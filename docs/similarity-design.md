# Electrode coverage and visual waveform retrieval

## What is implemented

Scalp labels use the existing standard 10–20 / 10–10 schematic, with orientation
markers. This is not digitized patient geometry. Derived CAR/GAR/LAP labels resolve
to their source sites; bipolar channels remain links. Numbered non-scalp groups
use a contact atlas with explicit labels, selection and visibility. Unknown
channels are retained. Neither contact numbers nor arbitrary group names establish
intracranial locations, physical spacing, depth direction or cortical regions.

The default search source is the current processing recipe: native-rate filter,
reference, then difference. The frontend and backend use matching filter transfer
functions and reflected padding. All existing display normalization modes are
positive affine channel transforms and cancel under shape normalization. Gain and
row height are display geometry, not search features. Result previews and jumps
use the search recipe. Changing the view preserves the frozen results and feedback;
opening a candidate restores the search recipe. Starting a new search replaces
the pool. A dedicated waveform-selection action captures the selected trace and
range on mouse release, not only after a second confirmation click.

Elastic mode is an engineering approximation inspired by local-shape DTW, **not a
reproduction of shapeDTW or a clinically validated detector**. Native-rate sliding
correlation retrieves positive candidates in the default nearest-review mode.
Explicit threshold mode uses match threshold minus 0.35, minimum 0.1 for candidate
generation. Up to 800 candidates are reranked using 128-point anti-aliased
voltage/slope descriptors, a six-point warping band and a 0.08 non-diagonal penalty.
The v4 score is max(correlation, 0.8 exp(-sqrt(DTW cost / 128)) + 0.2 correlation)
(absolute correlation only when polarity inversion is enabled). The old v2 blend
could reject highly correlated shapes due to noisy derivative descriptors. A
synthetic regression has correlation 0.882 but old blended score 0.638, below the
0.65 default. The elastic score can now add evidence, but cannot veto that native
correlation match. Weights and thresholds remain heuristic, not calibrated.

The UI defaults to three window lengths (0.8×, 1×, 1.2×), where each fits the range
and the 8-sample / 0.02–10 s limits. The original template is resampled for the
coarse correlation at other lengths; candidate data stays at native rate. Exact
duration remains available. All lengths share the same scan/refinement budgets
and global pool. Interval-overlap suppression avoids showing the same occurrence
at multiple lengths. Coverage is tracked for each channel and window length.
Candidate pruning, discrete durations and compact descriptors can miss valid matches,
especially high-frequency fine structure; strict native-rate correlation remains
available. Feedback currently reorders the frozen pool, not the search space.
Nearest mode returns review candidates even below the score guide, visibly marked;
this is not a declaration that a similar or pathological event was detected.
An empty result reports absence of valid independent windows separately from a
threshold/candidate rejection. Reference-channel self-overlap is always excluded.

Processed preparation is bounded to 32M channel-samples. Small recordings use the
whole recording, matching the ordinary viewer's filtering domain. A narrow
search/reference union uses at least max(3 s, 3/low-cut) context. Wider ranges now
use a fixed, padded native-rate tiling with bounded LRU storage instead of failing
the full-record memory guard. Each tile is processed with all source channels for
montage parity, then padding is trimmed; reference and candidates read the SAME
stitched signal, independent of cache state and query access order. The tiling and
padding sizes are returned for provenance. This is not exactly whole-record FFT
filtering or the viewer's working-rate overview; tile seams need clinical/device
validation. Extremely large channel counts or padding can still exceed the per-
chunk budget and produce an explicit error. Partial scanning, partial refinement
and partial preview materialization are distinct response fields.

## Evidence informing the design

- [MNE: working with sensor locations](https://mne.tools/stable/auto_tutorials/intro/40_sensor_locations.html)
  distinguishes built-in standard montages from measured sensor locations.
- [BIDS: iEEG conversion](https://bids-website.readthedocs.io/en/latest/getting_started/tutorials/conversion/ieeg.html)
  describes electrodes.tsv plus a coordinate-system description. Actual anatomical
  visualization should follow those data, not inferred label semantics.
- [UCR Matrix Profile](https://www.cs.ucr.edu/~eamonn/MatrixProfile.html) points to
  MASS for query similarity and UCR Suite for DTW; a full matrix profile is not
  necessary for a single selected reference.
- [UCR Suite](https://www.cs.ucr.edu/~eamonn/UCRsuite.html) establishes efficient
  exact subsequence search under constrained DTW. Our candidate reranker does not
  make its exhaustive-search guarantee.
- [Zhao & Itti: shapeDTW](https://arxiv.org/abs/1606.01601) motivates adding local
  shape information to alignment rather than comparing isolated point values.
- [EEG Foundation Models: Progresses, Benchmarking, and Open Problems (2026)](https://arxiv.org/abs/2601.17883)
  studies transferable representations and downstream evaluation. Such benchmarks
  do not establish equivalence to an EEG reader's visual-similarity judgement.

## Next validation before stronger claims

Collect consented, deidentified reference/candidate pairs reviewed by EEG readers,
including sharp transients, spike/slow-wave complexes, rhythmic patterns and
artifacts. Split by patient/recording, not overlapping windows. Compare strict
correlation, constrained DTW and local-shape reranking on precision@K, reviewed
recall, time-to-first-useful-match and latency. Stratify by filtering, montage,
duration and frequency band. Tune thresholds on held-out validation data; report
inter-reader disagreement. Evaluate multi-duration candidates and learned EEG
embeddings only against this baseline. Neither embeddings nor DTW are evidence
of pathology on their own.

## Clinical workflow requirements and evidence

This is an **assisted retrieval prototype for evaluation**, not a clinically
validated IED detector, seizure detector, reporting system, or certified device.
No source reviewed below establishes safety or accuracy of this implementation.

| Reading / principle | Implemented consequence | Still requires validation or development |
| --- | --- | --- |
| AES introductory EEG atlas, normal EEG: assess background using several montages; distinguish physiological artifacts | Preserve review results across montage/filter changes; open candidates with at least 2 s on each side where available, full channel context; keep original recipe | Clinical context, vigilance, video/EOG/ECG and age are not inferred |
| AES atlas, benign variants: sharp appearance can be normal and misread as epileptiform | Separate Similar / Different from reviewer-suspected Artifact / Uncertain; free-text notes; no automatic pathology labels | Reader adjudication of normal variants and artifact cases |
| IFCN IED criteria validation study: six sensor-space criteria require more than isolated shape similarity | Provide duration, relative peak-to-peak amplitude, processing provenance and context review; cue assessment of background, asymmetry, slow components and field | No automatic six-criterion tally; a scalp field must not be inferred from a single trace or applied unchanged to intracranial contacts |
| ACNS 2021 critical-care terminology describes background, spatial distribution, duration and evolution | Candidate search is not named seizure detection and does not create clinical events or disease confidence | No seizure/IIC burden, electroclinical correlation or neonatal classification is computed |

Primary reading:

- [AES atlas: The Normal EEG (2016)](https://www.ncbi.nlm.nih.gov/books/NBK390343/).
- [AES atlas: Benign Variants in the EEG (2016)](https://www.ncbi.nlm.nih.gov/books/NBK390352/).
- [Kural et al., IFCN criteria clinical validation, Neurology (2020)](https://pubmed.ncbi.nlm.nih.gov/32321764/). The accessible abstract was checked; its diagnostic results belong to that study, not this software.
- [IFCN revised glossary (2017)](https://pmc.ncbi.nlm.nih.gov/articles/PMC6123891/). Terminology reference; not an algorithm specification.
- [ACNS official guideline index](https://www.acns.org/practice/guidelines) and its linked [final 2021 condensed terminology](https://cdn-links.lww.com/permalink/jcnp/a/jcnp_2020_12_21_fong_00313_sdc098.pdf). Scope: critical-care EEG; neonatal terminology is separate.

### Review provenance and privacy

Local JSON export includes the frozen query recipe, algorithm version, sample
rate and counts, reference and candidate timestamps, previews, component scores,
duration scales, coverage, decisions, notes and session history. A SHA-256 digest
identifies the selected sample bytes only; it is **not a whole-recording checksum**.
Ephemeral server access tokens are excluded. Channel labels and notes may still
be sensitive. No file is uploaded to a third party. This is an editable local
export, not an authenticated, tamper-evident clinical audit trail. Reviews remain
in memory until exported and are cleared on a new search/recording or reload.

### Release boundary

Synthetic tests establish engineering invariants and reproduce regressions; they
cannot establish sensitivity, specificity or clinical usefulness. Before clinical
deployment, define the intended population and recording modalities with readers,
assemble authorized deidentified data with normal variants and artifacts, use
patient-disjoint evaluation and blinded multi-reader adjudication, quantify
missed findings and false candidates as well as review time, validate processing
and montage parity across devices/long recordings, and perform the applicable
clinical, usability, quality-system and regulatory review. These are outstanding
requirements, not claimed compliance. No clinical data was sent to web search.
