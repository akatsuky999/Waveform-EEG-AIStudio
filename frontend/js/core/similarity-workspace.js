import { rankMatches, referenceError, reviewExport } from "./similarity.js";

const copy = value => structuredClone(value);
const POLICY = "Similarity candidates are not diagnoses or calibrated probabilities. Coverage is not clinical sensitivity. Human reviews are not model labels.";
export const similarityRecipeKey = p => JSON.stringify(p ? [p.montage || "raw", p.filterLow || 0, p.filterHigh || 0,
  p.notch || "off", p.diffOrder || 0, p.normalization || "none", p.normOpts?.robLow ?? 25, p.normOpts?.mmRange ?? "sym"] : null);
const coverageSummary = coverage => {
  const { channels = [], ...summary } = coverage || {};
  return { ...summary, channelWindowCount: channels.length };
};

// A recording-scoped evidence store shared by the panel and the agent host.
// No Viewer/DOM access, annotation writes, downloads, or provider calls here.
// Tokens remain private; public IDs identify this session, not patient identity.
export function createSimilarityWorkspace({ getSource, request }) {
  const prefix = `eeg-${crypto.randomUUID()}`;
  let sequence = 0, generation = 0, recordingToken = null, recordingId = null;
  let suspended = false, activeSetId = null, latestReferenceId = null, pending = null;
  let lastError = null;
  const references = new Map(), sets = new Map(), listeners = new Set();
  const id = kind => `${prefix}-${kind}-${++sequence}`;
  const now = () => new Date().toISOString();

  function clear() {
    generation++;
    pending?.controller.abort(); pending = null;
    references.clear(); sets.clear(); activeSetId = latestReferenceId = null;
    recordingToken = recordingId = null;
    lastError = null;
  }
  function source() {
    const current = getSource();
    if (suspended || !current?.token) throw new Error("No active recording. Finish loading the recording first.");
    if (recordingToken !== current.token) {
      clear(); recordingToken = current.token; recordingId = id("recording");
    }
    return current;
  }
  function getState() {
    try { source(); } catch { return { available: false, retention: "current-recording-session" }; }
    return copy({ available: true, recordingId, activeSetId, latestReferenceId,
      retention: "current-recording-session", policy: POLICY, lastError,
      pending: pending ? { id: pending.id, actor: pending.actor, referenceId: pending.referenceId } : null,
      reference: references.get(latestReferenceId)?.evidence || null,
      sets: [...sets.values()].map(set => ({ id: set.id, referenceId: set.referenceId, actor: set.actor,
        createdAt: set.createdAt, count: set.response.matches.length, revision: set.revision,
        reviewedCount: set.feedback.size, coverage: coverageSummary(set.response.coverage),
        label: set.response.reference.label, startSec: set.response.reference.startSec,
        endSec: set.response.reference.endSec })),
    });
  }
  function emit(type) { for (const listener of listeners) listener(type); }
  function getSet(setId = activeSetId) {
    source();
    const set = sets.get(setId);
    if (!set) throw new Error("Candidate set is unavailable in this recording session. Read the workspace state again.");
    return set;
  }
  function capture(args = {}, actor = "human") {
    const current = source();
    if (references.size >= 128) throw new Error("Reference limit reached for this session. Export your reviews before reloading.");
    const signalSource = args.source ?? "processed";
    if (!["raw", "processed"].includes(signalSource)) throw new Error("source must be raw or processed.");
    const channels = signalSource === "processed" ? current.channels : current.rawChannels;
    const usingSelection = args.channel === undefined;
    if (usingSelection && signalSource === "raw" && current.processing.montage !== "raw") {
      throw new Error("The selected channel is derived. Specify an exact original channel, or capture processed signal.");
    }
    const ref = args.channel ?? current.selectedChannel;
    let channel = typeof ref === "number" ? ref : channels.findIndex(c => c.label === ref);
    if (!Number.isInteger(channel) || channel < 0 || channel >= channels.length) throw new Error("Choose an exact, unambiguous reference channel.");
    if (typeof ref === "string" && channels.filter(c => c.label === ref).length !== 1) throw new Error("Channel label is ambiguous; use its index.");
    const startSec = args.startSec ?? current.selection?.[0];
    const endSec = args.endSec ?? current.selection?.[1];
    if ((args.startSec === undefined) !== (args.endSec === undefined)) throw new Error("Provide both reference times, or use the selection.");
    if (typeof startSec !== "number" || typeof endSec !== "number") throw new Error("Select a waveform or provide startSec and endSec.");
    const error = referenceError(startSec, endSec, channel, current.duration, current.fs);
    if (error) throw new Error(error);
    const referenceId = id("reference");
    const processing = signalSource === "processed" ? copy(current.processing) : null;
    const evidence = { id: referenceId, recordingId, createdAt: now(), actor,
      source: signalSource, processing, samplingRate: current.fs,
      channel, label: channels[channel].label, channelMapping: copy(channels[channel]),
      startSec, endSec, status: "recipe-frozen", unit: current.unit || null,
      note: "Frozen channel/time/processing recipe. Native sample fingerprint is supplied only after successful retrieval." };
    references.set(referenceId, { evidence, token: recordingToken });
    latestReferenceId = referenceId;
    emit("capture");
    return copy(evidence);
  }
  async function search(args = {}, { actor = "human", signal } = {}) {
    source();
    if (pending) throw new Error("A similarity search is already running. Wait or stop it before starting another.");
    if (sets.size >= 32) throw new Error("Candidate-set limit reached. Export your reviews before reloading; existing reviews have been preserved.");
    const reference = references.get(args.referenceId);
    if (!reference || reference.token !== recordingToken) throw new Error("Reference is unavailable. Capture it in the current recording first.");
    if (signal?.aborted) throw new DOMException("Search stopped.", "AbortError");
    const e = reference.evidence;
    const body = { token: reference.token, channel: e.channel, referenceLabel: e.label,
      startSec: e.startSec, endSec: e.endSec, source: e.source,
      ...(e.processing ? { processing: copy(e.processing) } : {}),
      method: "elastic", retrieval: "nearest", durationTolerance: .2,
      scope: "channel", minScore: .65, ignorePolarity: false };
    // Never spread model/user arguments into the request: frozen provenance wins.
    for (const key of ["method", "retrieval", "durationTolerance", "scope", "minScore", "ignorePolarity", "searchStartSec", "searchEndSec"]) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    for (const [key, values] of Object.entries({ method: ["elastic", "correlation"], retrieval: ["nearest", "threshold"],
      durationTolerance: [0, .2], scope: ["channel", "all"], ignorePolarity: [true, false] })) {
      if (!values.includes(body[key])) throw new Error(`Invalid ${key}.`);
    }
    if (typeof body.minScore !== "number" || !Number.isFinite(body.minScore) || body.minScore < .1 || body.minScore > 1) throw new Error("minScore must be between 0.1 and 1.");
    for (const key of ["searchStartSec", "searchEndSec"]) {
      if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isFinite(body[key]))) throw new Error(`Invalid ${key}.`);
    }
    const run = { id: id("search"), actor, referenceId: e.id, controller: new AbortController() };
    const version = generation;
    const abort = () => run.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    pending = run; lastError = null; emit("search-start");
    try {
      const response = await request(copy(body), run.controller.signal);
      // A fetch implementation can resolve even after cancellation. Verify the
      // recording generation as well as the abort signal before accepting it.
      source();
      if (run.controller.signal.aborted || version !== generation || reference.token !== recordingToken) {
        throw new DOMException("Search stopped or recording changed.", "AbortError");
      }
      if (!response?.reference || !Array.isArray(response.matches) || !response.coverage
        || !Number.isFinite(response.reference.startSec) || !Number.isFinite(response.reference.endSec)
        || new Set(response.matches.map(m => m.id)).size !== response.matches.length) throw new Error("Invalid similarity response.");
      if (response.source !== e.source || response.reference.channel !== e.channel || response.reference.label !== e.label) {
        throw new Error("Search response does not match the frozen signal reference.");
      }
      if (similarityRecipeKey(response.processing) !== similarityRecipeKey(e.processing)) throw new Error("Search response processing differs from the frozen recipe.");
      if (Math.abs(response.reference.startSec - e.startSec) > 1 / e.samplingRate
        || Math.abs(response.reference.endSec - e.endSec) > 1 / e.samplingRate) throw new Error("Search response time range differs from the frozen reference.");
      const setId = id("set");
      const saved = copy(response);
      saved.evidence = { setId, referenceId: e.id, recordingId, captured: copy(e), searchId: run.id };
      sets.set(setId, { id: setId, referenceId: e.id, actor, createdAt: now(), revision: 0,
        response: saved, request: body, feedback: new Map(), observations: new Map(),
        history: [{ at: now(), action: "search", actor, method: response.method }] });
      // Background agent work must not replace the candidate the doctor is
      // reviewing. New sets remain discoverable through history and tool IDs.
      if (actor === "human" || !activeSetId) activeSetId = setId;
      emit("search-result");
      return read({ setId });
    } catch (error) {
      if (generation === version) lastError = error.name === "AbortError" ? "Search stopped." : error.message;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (pending === run) { pending = null; emit("search-end"); }
    }
  }
  function read({ setId = activeSetId, offset = 0, limit = 10, candidateId } = {}) {
    const set = getSet(setId);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Use offset ≥ 0 and limit 1–20.");
    const matches = rankMatches(set.response.matches, set.feedback);
    const selected = candidateId ? matches.filter(m => m.id === candidateId) : matches.slice(offset, offset + limit);
    if (candidateId && !selected.length) throw new Error("Candidate is unavailable in this set.");
    const { matches: _matches, reference, coverage, ...metadata } = set.response;
    const { preview: _preview, ...referenceMetadata } = reference;
    return copy({ setId: set.id, revision: set.revision, actor: set.actor, ...metadata,
      reference: referenceMetadata, coverage: coverageSummary(coverage),
      total: matches.length, offset, hasMore: !candidateId && offset + limit < matches.length,
      candidates: selected.map(({ preview, ...m }) => ({ ...m, ...(candidateId ? { preview } : {}), evidenceId: `${set.id}/${m.id}`,
        review: { actor: set.feedback.has(m.id) || set.observations.has(m.id) ? "human" : null,
          decision: set.feedback.get(m.id) || "unreviewed", note: set.observations.get(m.id) || "" } })),
      eventsApplied: 0, policy: POLICY });
  }
  // Human review methods are intentionally NOT exposed by the agent facade.
  function review(setId, candidateId, decision) {
    const set = getSet(setId);
    if (!set.response.matches.some(m => m.id === candidateId)) throw new Error("Unknown candidate.");
    if (!["similar", "different", "artifact", "uncertain", "unreviewed"].includes(decision)) throw new Error("Unknown review decision.");
    if (decision === "unreviewed") set.feedback.delete(candidateId); else set.feedback.set(candidateId, decision);
    set.revision++; set.history.push({ at: now(), action: "review", actor: "human", id: candidateId, value: decision });
    emit("review");
  }
  function note(setId, candidateId, value) {
    const set = getSet(setId);
    if (!set.response.matches.some(m => m.id === candidateId)) throw new Error("Unknown candidate.");
    const text = String(value).slice(0, 1000);
    if (set.observations.get(candidateId) === text) return;
    set.observations.set(candidateId, text); set.revision++;
    set.history.push({ at: now(), action: "note", actor: "human", id: candidateId, value: text });
    emit("note");
  }
  return {
    getState, capture, search, read, review, note,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancel(actor) { if (pending && (!actor || pending.actor === actor)) pending.controller.abort(); },
    suspend() { clear(); suspended = true; emit("reset"); },
    bind() { clear(); suspended = false; source(); emit("reset"); },
    select(setId) { getSet(setId); activeSetId = setId; emit("select"); },
    resetReviews(setId) {
      const set = getSet(setId); set.feedback.clear(); set.revision++;
      set.history.push({ at: now(), action: "reset-feedback", actor: "human" }); emit("review");
    },
    panelSnapshot() {
      const state = getState();
      if (!state.activeSetId) return { state, set: null };
      return { state, set: copy(getSet()) };
    },
    exportReview(setId = activeSetId) {
      const set = getSet(setId);
      return reviewExport(set.response, set.request, set.feedback, set.observations, set.history);
    },
  };
}

export function createViewerSimilarityWorkspace(viewer) {
  return createSimilarityWorkspace({
    getSource: () => {
      const header = (viewer.windowed ? viewer.windowMeta : viewer.baseHeader || viewer.header) || {};
      return { token: viewer.windowed ? viewer.windowToken : viewer.header?.dataToken,
        fs: header.fs || viewer.fs, duration: viewer.duration,
        channels: (viewer.channelMeta || []).map(({ label, sourceIndex, montage, group }) => ({ label, sourceIndex, montage, group })),
        rawChannels: (header.channels || []).map((c, sourceIndex) => ({ label: c.label, sourceIndex, group: c.group })),
        processing: viewer._processingSpec(), selectedChannel: viewer.selectedChannel,
        selection: viewer.measureRange ? [...viewer.measureRange].sort((a, b) => a - b) : null,
        unit: viewer.unit };
    },
    request: async (body, signal) => {
      const response = await fetch("/api/signal/similarity", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Search failed.");
      return payload;
    },
  });
}
