# Frequency Bands, Filters, And Montage Caveats

## Frequency Bands

- Delta: about 0.5-4 Hz.
- Theta: about 4-8 Hz.
- Alpha: about 8-13 Hz.
- Beta: about 13-30 Hz.
- Gamma / high frequency in this viewer: about 30-80 Hz.

These boundaries are useful for triage, but they are not diagnoses. A band-power
ratio can be affected by montage, filtering, artifacts, sampling rate, and window
length.

## Filter Caveats

- High-pass / low-cut filtering reduces slow drift but can distort slow waves
  and transient morphology.
- Low-pass / high-cut filtering reduces muscle and high-frequency noise but can
  hide fast activity.
- Notch filtering can reduce 50/60 Hz line noise but may affect nearby signal.
- EEG-Master should mention active filter settings when discussing frequency
  content or morphology.

## Montage Caveats

- Raw/reference-like displays can reveal absolute channel behavior but may be
  reference-contaminated.
- Bipolar montages help localize phase reversals and reduce common reference
  contamination, but can cancel broad fields.
- Common average reference can highlight focal deviations but may distribute
  large artifacts across channels.
- Group average and local reference are useful in dense iEEG-style groups, but
  require careful neighbor interpretation.

## Viewer Filter (this app)

The viewer's frequency filter (set via `set_processing`) is a **zero-phase,
cosine-tapered band-pass** computed in the frequency domain:

- **No phase distortion** — events are not time-shifted, so onset/offset marks
  stay aligned.
- **Smooth roll-off** (raised-cosine transition bands), not a brick-wall, so it
  does **not** introduce Gibbs ringing around spikes/sharp transients — safe to
  use before judging morphology. The −6 dB point sits at the requested cutoff.
- **Notch** removes the line frequency **and its harmonics** (e.g. 60/120/180)
  with a narrow Gaussian dip.
- Applied **before** differencing and normalization. Window edges are
  reflect-padded to limit FFT wrap-around artifacts.

One-click clinical presets (`filterPreset`): `review` 1–70 Hz, `seizure`
1–40 Hz, `sleep` 0.3–35 Hz, `hfo` 80–250 Hz, `off`. Choose `notchHz` 50 or 60
to match the local mains frequency. Filtering is a display/analysis aid; always
note that appearance is filter-dependent.

## qEEG / Feature Caveats

- Dominant frequency, RMS, peak-to-peak, and band ratios are screening features.
- Treat summary statistics as prompts for visual review, not as final clinical
  interpretation.
- When a feature is suspicious, EEG-Master should call `capture_waveform_view`
  or `inspect_channel` before giving a stronger explanation.

## Sources

- Standard clinical EEG frequency-band definitions and display-filter practice.
- General EEG reference material on montage and visual interpretation.
- Project implementation: viewer frequency stats use FFT-based dominant
  frequency and band ratios from currently displayed data.
