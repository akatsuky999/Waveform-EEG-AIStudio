# EEG-Master agent plugin

A self-contained AI agent for the Waveform viewer. 

```
agent/
├── backend/
│   ├── proxy.py          OpenAI-compatible chat/model proxy — native tool calling + multimodal, streaming
│   ├── sandbox.py        POST /api/ai/execute → runs model-written Python in a separate subprocess
│   ├── sandbox_worker.py the subprocess entrypoint (numpy/scipy over the EEG window)
│   ├── datastore.py      tiny in-process LRU cache of decoded windows (keyed by dataToken)
│   └── plugin.py         agent_routes() → /api/ai/chat, /api/ai/models, /api/ai/execute, /agent static mount
├── web/                  served at /agent/* and imported by the host shell
│   ├── agent.js          controller: initAgent(host) + the real multi-step tool loop (+ Stop)
│   ├── prompt.js         compact system policy + model presets
│   ├── tool-definitions.js schemas + read/write/concurrency/destructive metadata
│   ├── intent-policy.js  per-turn annotation/file/export authorization
│   ├── tools.js          execution against the formal SignalWorkspaceHost
│   ├── stream.js         SSE streaming + native tool_call accumulation (+ legacy <eeg-tools> fallback)
│   ├── ui.js             drawer UI: conversation, status, run timeline + tool cards
│   ├── skills-ui.js      local EEG skill manager UI + editor wiring
│   ├── skills-client.js  browser API client for local skill CRUD
│   ├── settings-store.js local/session split for non-sensitive settings and API key
│   ├── markdown.js       tiny markdown renderer
│   ├── agent.css         drawer + tool-card timeline styles
│   └── agent-settings.css sidebar Agent settings + skill editor styles
├── knowledge/            distilled EEG review notes cited by the system prompt
└── skills/               optional bundled EEG skills (`skill-name/SKILL.md`)
```

## How it works (the agent loop)

`agent.js` runs a real loop, capped at `MAX_TURNS`:

1. Stream a model reply with `tools: EEG_TOOLS` (native OpenAI function calling).
2. If the reply contains `tool_calls`, execute each via `runToolCall(host, call)`,
   append the assistant `tool_calls` message + one `role:"tool"` result per call
   (up to five ordered images ride along as one multimodal user message), then
   **loop again**. Consecutive read-only/concurrency-safe tools run in parallel;
   writes remain serial.
3. Stop when the model returns no tool calls (or on the step cap / **Stop** button).

The controller derives a conservative action policy from every user turn.
Annotation, source switching, and downloads are blocked unless that turn
explicitly authorizes the side effect; negative wording wins. Legacy tool names
and the `<eeg-tools>` protocol remain dispatch-compatible but are not exposed in
the current schema.

## Tools

The public surface is `read_signal_workspace_guide`,
`get_signal_workspace_state`, `list_agent_skills`, `read_agent_skill`,
`list_signal_sources`, `open_signal_source`, `inspect_channel`, `rank_channels`,
`detect_artifact_candidates`, `inspect_time_window`, `run_python`,
`control_signal_view`, `configure_signal_processing`, `manage_signal_events`,
`render_signal_images`, and `export_signal_artifact`.

To add a tool: register its schema and side-effect metadata in
`tool-definitions.js`, implement it against `SignalWorkspaceHost`, and add an
explicit policy for any new persistent/external side effect. The full contract
is `knowledge/signal_workspace.md` and is readable by the running Agent.

## EEG skills

Skills are local Markdown prior/context packs for EEG workflows, centers,
datasets, or reporting conventions. They are not plugins and they do not add
tool permissions. The left sidebar Agent panel lists available skills, lets the
user enable defaults, and supports create/edit/delete/export for user skills.

Two sources are supported:

- `runtime/agent-skills/<skill-name>/SKILL.md` — user skills, local to the
  machine and ignored by git.
- `agent/skills/<skill-name>/SKILL.md` — optional bundled skills that ship with
  the project. Bundled skills can be read, exported, copied into a user skill,
  and enabled/disabled, but not edited or deleted in the UI.

The model receives only a compact skill manifest in context; it reads the full
`SKILL.md` body through `read_agent_skill` when a skill is enabled, explicitly
requested, or matched by task triggers. Skill guidance never overrides safety,
annotation, export, or file-switch authorization policy.

## The Python sandbox (`run_python`)

`run_python` posts `{ code, dataToken }` to `POST /api/ai/execute`. The decoded
window is cached server-side at parse time (`datastore.py`, keyed by the
`dataToken` embedded in the envelope header), so the sandbox analyses the **same
recording** the user is viewing without shipping samples back.

Inside the worker the code has `data` (float32 `[n_channels, n_samples]`, the raw
decoded recording), `fs`, `labels`, `groups`, local `t`, absolute `startSec`,
`endSec`, `durationSec`, `t_abs`, `find_channel(ref)`, plus `numpy`/`scipy`, plus
current metadata in `workspace`. It can `print(...)`, fill `result`, append to
`event_candidates` (legacy `markers` is an alias; neither is applied to the
viewer), and draw a matplotlib figure (returned as a PNG).

**Isolation (best-effort, honest).** The code runs in a **separate subprocess**
with a clean environment (no inherited environment-variable secrets), a
throwaway working directory, a wall-clock timeout, an output cap, and
best-effort POSIX CPU/address-space limits. These controls bound common mistakes;
they do not create a hardened sandbox. Model-written Python retains the same OS
account permissions as EEGViewer and can read or write accessible paths, access
the network, and create child processes. Use this only in a trusted, local,
single-user session bound to `127.0.0.1`; never expose `/api/ai/execute` to a LAN,
public network, or untrusted users. The worker needs `scipy` and `matplotlib`;
the repository's uv environment installs both.

## Provider compatibility

No provider is configured by default. The user must explicitly enter the Base
URL, API key, and model in the left sidebar Agent panel. The local proxy targets an
OpenAI-compatible `/v1/chat/completions` endpoint and requires SSE streaming plus
native multi-turn function tools (`tools`, `tool_choice`, assistant
`tool_calls`, and `role: "tool"` messages). Multimodal models must accept data-URL
`image_url` content to inspect rendered waveforms and Python figures. A
`GET /v1/models` endpoint enables model discovery but a model can also be entered
manually. Text-only or tool-call-emulating endpoints are not fully compatible.

## How it plugs in

- **Backend**: `backend/app.py` splices `agent_routes()` into its route table
  before the catch-all static mount. The core `routes.py` *soft*-imports
  `agent.backend.datastore` to cache windows (it degrades gracefully if the agent
  is removed); the agent never imports `backend.*`.
- **Frontend**: `frontend/js/main.js` creates a formal `SignalWorkspaceHost`
  facade and calls `initAgent(host)`. Agent code does not access Viewer/DOM
  internals directly.

## Privacy

The application proxy sends summary context and optional generated signal images
or sandbox figures to the user-configured provider — never raw waveform arrays or
full CSV by design. Non-sensitive Agent settings are held in `localStorage`;
the API key is held in `sessionStorage` only. The application does not
intentionally upload sandbox files, but model-written Python is ordinary local
code and can use the network unless the operating system blocks it.
