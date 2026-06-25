# Signal Workspace Operating Guide

This document is the shared runtime and developer contract for EEG-Master's
Signal Workspace. It is authoritative for tool semantics; the system prompt
contains only the compact decision policy.

## State model

One loaded recording owns a decoded raw signal, a displayed processing chain,
a time/channel viewport, analysis focus, and an in-memory event list. Project
switches preserve the processing chain where compatible but reset file-specific
focus and events. Browser folder handles remain user-authorized resources.

Signal sources are:

- `raw`: decoded source channels before montage or filtering.
- `physical`: montage and frequency filters, retaining physical-unit meaning.
- `processed`: the visible pipeline, including differencing and normalization.

## Tool families and side effects

- Orientation: `get_signal_workspace_state`, `read_signal_workspace_guide`,
  `list_signal_sources` are read-only.
- Evidence: channel/window inspection, ranking, artifact screening, and
  `run_python` are read-only and may run concurrently.
- Visible control: `control_signal_view` and
  `configure_signal_processing` mutate the visible workspace but not files.
- Events: `manage_signal_events` changes the current event model and requires
  explicit annotation intent in the current user message.
- Sources: `open_signal_source` requires explicit open/switch/compare intent.
  If current events exist, it also requires `discardCurrentEvents=true` after
  the user confirms they may be cleared.
- Artifacts: `export_signal_artifact` triggers a browser download and requires
  explicit export/download/save intent. Images produced only for Agent vision
  are not downloaded.

Negative instructions always win. “Do not annotate”, “only analyze”, “do not
switch files”, and “do not save” keep the corresponding capability blocked.

## Evidence workflow

1. Read workspace state and clarify the requested outcome.
2. Use quantitative inspection or Python to triage channels and time ranges.
3. Generate a full overview when global context matters.
4. Generate focused time/channel details to verify morphology.
5. Apply only explicitly requested persistent actions.
6. Verify state after actions and report evidence, uncertainty, and changes.

The injected context is not waveform evidence. Quantitative claims should cite
inspection/Python results; morphology claims should cite generated images.

For `windowed=true` large recordings, treat the file as an indexed long
recording rather than a degraded workspace. The first-class workflow is:

1. `signal_query op="search"` to rank candidate channel/time windows from the
   feature index without scanning the whole recording.
2. `run_python(startSec,endSec)` on the selected bounded window for exact
   raw-sample computation. Large recordings require these bounds.
3. `render_signal_images` on short focused ranges for morphology evidence.

Wide `signal_query op="aggregate"` results may be approximate; always check
`result.meta.exact`. Full-recording overview images and full-array exports are
not available for large recordings, but exact short-window images are available.

## Multi-scale image production

`render_signal_images` uses the backend renderer rather than the viewport
screenshot. It accepts `full`, `current`, `range`, `batch`, and `multiscale`.

- A request may attach at most five images: one overview plus four details.
- `multiscale` keeps explicit detail ranges in the supplied order. Put the most
  important detail last; the visible workspace remains at that range/focus.
- `batch` builds windows from start/end/window/step. Up to four requested
  indices are returned; without indices, four evenly spaced windows are used.
- `channelScope=selected` expands explicit channels by `neighborRadius` for
  local context. The overview retains broad channel context while details use
  the focused set.
- Width is capped at 2048 px, height at 4096 px, each PNG at 4 MiB, and the set
  at 12 MiB. On a limit error, reduce channels, dimensions, or image count.

## Events and Python

Events are canonical point or interval objects. Do not infer permission to
write them merely because a candidate time was discovered. `run_python` exposes
raw `data`, `fs`, `labels`, `groups`, `t`, `find_channel`, and the current
`workspace` metadata. Python may fill `event_candidates` (legacy `markers` is an
alias), but candidates are returned only; `manage_signal_events` is the sole
Agent event-writing path.

## Extending the interface

Add a public tool through the central registry with schema, access mode,
concurrency safety, and destructive status. Implement behavior against the
`SignalWorkspaceHost`, not Viewer DOM internals. Tool results must be bounded,
JSON-serializable, and honest about completed side effects. New persistent or
external side effects require an explicit per-turn authorization policy and
tests for positive, negative, and ambiguous requests.
