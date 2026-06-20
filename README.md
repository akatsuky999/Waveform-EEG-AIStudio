# Waveform

A local tool for reading EEG/iEEG recordings — and an agent that reads them with you.

Open a recording and it renders in the browser: scroll thousands of channels, zoom in
time, re-reference, filter, and mark events. Switch on EEG-Master and the agent works on
the *same* recording — it inspects channels, runs Python on the real samples, renders the
views it needs, and proposes events — rather than guessing from a summary. The viewer is
fully usable on its own; the agent is optional and uses a model you bring.

![Waveform: a multichannel recording with signal controls and the EEG-Master agent](./pic/exp.png)

## What you get

- A WebGL viewer for large multichannel recordings — time navigation, channel scrolling,
  gain and row height.
- Montage (bipolar / CAR / Laplacian), zero-phase band-pass + notch, differencing, channel
  ordering, and several normalizations.
- A project explorer for moving between local recordings; nothing is uploaded to a service.
- Point and interval events, with PNG, ZIP, CSV/JSON, HDF5, and EDF+ export.
- EEG-Master: channel ranking, artifact screening, local Python analysis, and multi-scale
  rendering — with a conservative write policy (it won't add or edit events unless you ask).

## Quick start

Waveform needs [uv](https://docs.astral.sh/uv/) and a desktop browser.

```bash
./run.sh
```

Open <http://127.0.0.1:8000> and load a recording — or the bundled `win001.h5`. The first
run builds the pinned environment from `uv.lock`; there is no frontend build step. On
Windows, run the same service with `uv run --frozen python -m uvicorn backend.app:app`.

**Formats.** HDF5 (`.h5`/`.hdf5`) as a `samples × channels` dataset, and EDF/EDF+/BDF via
pyEDFlib. Decoding and export run in the local Python service; rendering stays in the browser.

**Using EEG-Master.** Open *EEG-Master → Config* and enter a Base URL, API key, and model —
nothing is set by default. The provider must speak the OpenAI Chat Completions API with
streaming and tool calls, and accept image input to read rendered views. See
[agent/README.md](agent/README.md) for the tool loop and provider contract.

## License

Apache-2.0 for the source ([LICENSE](LICENSE)). The bundled example `win001.h5` is covered
separately ([DATA_LICENSE.md](DATA_LICENSE.md)); the vendored Three.js keeps its MIT notice.

## Limitations and safety

- **Not a medical device.** Waveform is a research and engineering tool. Its output —
  including agent conclusions and event candidates — must be reviewed by a qualified person
  and never used as the sole basis for diagnosis or care.
- **Processing changes appearance.** Filtering, montage, normalization, and resampling all
  alter how a signal looks. Keep the source recording and note the settings behind any
  interpretation or export.
- **`run_python` is not a hardened sandbox.** Model-written code runs as a local subprocess
  with your filesystem, network, and process permissions. Keep the service on `127.0.0.1`
  and never expose the agent endpoints to a network or untrusted users.
- **Credentials and data.** Your API key lives in browser `sessionStorage` and is forwarded
  only to the Base URL you set. The proxy sends workspace summaries and rendered images to
  that provider — never raw waveform arrays — but review the provider's retention terms
  before sharing images.
