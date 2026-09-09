import { $, escapeHtml } from "../core/util.js";
import { previewPath, rankMatches, referenceError } from "../core/similarity.js";
import { createViewerSimilarityWorkspace, similarityRecipeKey } from "../core/similarity-workspace.js";

const icon = (path) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}"/></svg>`;
const checkIcon = icon("m4 10 4 4 8-8");
const crossIcon = icon("m6 6 8 8M14 6l-8 8");
const arrowIcon = icon("M4 10h12m-5-5 5 5-5 5");
const emptyReference = `<div class="similar-reference-head"><span>REFERENCE</span><span class="similar-raw">SHAPE</span></div>
  <div class="similar-empty-reference">${icon("M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4M6 10h8")}
  <span>A shape to follow</span><small>Select a 0.02–10 s waveform · ≥8 samples</small></div>`;

export function initSimilarity(ctx) {
  const viewer = ctx.viewer;
  const workspace = ctx.similarityWorkspace ||= createViewerSimilarityWorkspace(viewer);
  let response = null, feedback = new Map(), revision = 0;
  let sourceToken = null;
  let processingKey = "", restoring = false;
  let selectingReference = false;
  let activeSetId = null, draftReference = null, observations = new Map();
  const processing = () => viewer._processingSpec();
  const source = () => $("similarSource").value;
  const sourceKey = () => JSON.stringify([source(), source() === "processed" ? processing() : null,
    source() === "processed" ? viewer.channelMeta.map(c => c.label) : null]);
  const recipe = (p) => p ? `${p.filterLow || 0}–${p.filterHigh || "∞"} Hz · notch ${p.notch} · ${p.montage} · Δ${p.diffOrder} · ${p.normalization}` : "Original signal · no processing";
  const nativeFs = () => (viewer.windowed ? viewer.windowMeta : viewer.baseHeader || viewer.header)?.fs || viewer.fs;
  function viewNotice() {
    const changed = !!response && (response.source !== source()
      || similarityRecipeKey(processing()) !== similarityRecipeKey(response.processing || {}));
    $("similarViewNotice").classList.toggle("hidden", !changed);
    $("similarViewNotice").textContent = changed ? "View settings differ from this search. Candidates and reviews are preserved; Open restores the saved recipe." : "";
  }
  function invalidate(message) {
    revision++; workspace.cancel("human"); busy(!!workspace.getState().pending);
    syncLabels(); viewNotice(); status(message);
  }
  function syncProcessing() {
    if (restoring || !viewer.header) return;
    if (sourceKey() === processingKey) { viewNotice(); return; }
    processingKey = sourceKey();
    const selected = $("similarChannel").value;
    const header = viewer.windowed ? viewer.windowMeta : viewer.baseHeader || viewer.header;
    const channels = source() === "processed" ? viewer.channelMeta : header?.channels || [];
    $("similarChannel").innerHTML = channels.map((c, i) => `<option value="${i}">${escapeHtml(c.label)}</option>`).join("");
    if (selected !== "" && Number(selected) < channels.length) $("similarChannel").value = selected;
    // Changing a review montage must not erase the frozen candidate pool.
    invalidate(response ? "View updated · previous search and reviews retained" : draftReference ? "View updated · captured reference stays frozen. Capture again to use the new settings." : "Signal settings updated · ready to search");
    $("similarProcessing").textContent = recipe(source() === "processed" ? processing() : null);
  }
  const token = () => viewer.windowToken && viewer.windowed ? viewer.windowToken : viewer.header?.dataToken;
  const status = (text, error = false) => {
    $("similarStatus").textContent = text;
    $("similarStatus").classList.toggle("is-error", error);
  };
  function busy(value) {
    $("similarSearch").disabled = value || !viewer.header;
    $("similarStop").classList.toggle("hidden", !value);
    $("similarSearchLabel").textContent = value ? "Comparing shapes…" : "Find similar waveforms";
    $("similarityPanel").setAttribute("aria-busy", String(value));
  }
  function syncLabels() {
    const a = Number($("similarStart").value), b = Number($("similarEnd").value);
    $("similarWindowLabel").textContent = Number.isFinite(a) && Number.isFinite(b) ? `${a.toFixed(3)}–${b.toFixed(3)} s` : "Set range";
    $("similarScopeLabel").textContent = $("similarScope").value === "all" ? "All channels" : "Same channel";
  }
  function clearResults() {
    revision++;
    workspace.cancel("human");
    response = null; feedback = new Map();
    activeSetId = null; observations = new Map();
    viewNotice();
    $("similarResults").replaceChildren();
    $("similarReference").innerHTML = emptyReference;
    $("similarReference").classList.remove("has-waveform");
    $("similarReview").classList.add("hidden");
    $("similarModuleMeta").textContent = "Shape search";
    $("similarFeedbackSummary").textContent = "";
    $("similarResetFeedback").classList.add("hidden");
    syncLabels();
    busy(false);
  }
  function reset() {
    selectingReference = false;
    draftReference = null; workspace.suspend();
    clearResults(); sourceToken = null; processingKey = "";
    $("similarTemplateEditor").open = true;
    status("Load a recording to search its waveforms.");
  }
  function refreshSource() {
    draftReference = null; workspace.bind();
    clearResults(); sourceToken = token();
    processingKey = ""; syncProcessing();
    $("similarStart").value = "0";
    $("similarEnd").value = String(Math.min(1, viewer.duration));
    syncLabels();
    $("similarTemplateEditor").open = true;
    status(source() === "processed" ? "Ready · current processing" : "Ready · original signal");
  }
  function capture() {
    if (!viewer.header) return;
    syncProcessing();
    if (source() === "raw" && viewer.montageMode !== "raw") {
      status("The view uses a derived montage. Choose an original channel below, or switch to Original channels before capturing.", true);
      return;
    }
    const range = viewer.measureRange || [viewer.tStart, viewer.tEnd];
    const [a, b] = [...range].sort((x, y) => x - y);
    const error = referenceError(a, b, String(viewer.selectedChannel ?? 0), viewer.duration, nativeFs());
    if (error) {
      status(error, true);
      return;
    }
    clearResults();
    selectingReference = false;
    $("similarChannel").value = String(viewer.selectedChannel ?? 0);
    $("similarStart").value = String(a);
    $("similarEnd").value = String(b);
    draftReference = workspace.capture({ source: source(), channel: viewer.selectedChannel ?? 0, startSec: a, endSec: b });
    syncLabels();
    $("similarReference").innerHTML = `<div class="similar-reference-head"><span>REFERENCE CAPTURED</span><span class="similar-raw">READY</span></div><div class="similar-reference-title"><b>${escapeHtml($("similarChannel").selectedOptions[0]?.textContent || "Channel")}</b><span>${((b-a)*1000).toFixed(0)} ms</span></div><p class="similar-processing">${a.toFixed(3)}–${b.toFixed(3)} s · ${escapeHtml(recipe(source() === "processed" ? processing() : null))}</p>`;
    $("similarTemplateEditor").open = true;
    status(`Reference captured · ${$("similarChannel").selectedOptions[0]?.textContent || "channel"} · ${((b-a)*1000).toFixed(0)} ms · ready to search`);
  }
  function plot(values, overlay = null) {
    return `<svg viewBox="0 0 240 54" class="similar-wave" role="img" aria-label="Normalized waveform preview${overlay ? "; muted reference overlaid" : ""}">
      <path class="similar-grid" d="M60 0V54M120 0V54M180 0V54" />
      <path class="similar-axis" d="M0 27H240" />
      ${overlay ? `<path class="similar-overlay" d="${previewPath(overlay)}" />` : ""}
      <path class="similar-trace" d="${previewPath(values)}" /></svg>`;
  }
  function render() {
    if (!response) return;
    const ref = response.reference;
    $("similarReference").classList.add("has-waveform");
    $("similarReference").innerHTML = `<div class="similar-reference-head"><span>REFERENCE</span><span class="similar-raw">${response.source === "processed" ? "PROCESSED" : "RAW"}</span></div>
      <div class="similar-reference-title"><b>${escapeHtml(ref.label)}</b><span>${(ref.endSec - ref.startSec).toFixed(3)} s</span></div>
      ${plot(ref.preview)}<div class="similar-reference-axis"><span>${ref.startSec.toFixed(3)} s</span><span>${ref.endSec.toFixed(3)} s</span></div><p class="similar-processing">${escapeHtml(recipe(response.processing))}</p>`;
    $("similarReview").classList.remove("hidden");
    $("similarMatchCount").textContent = String(response.matches.length).padStart(2, "0");
    $("similarModuleMeta").textContent = `${response.matches.length} candidates`;
    const yes = [...feedback.values()].filter((v) => v === "similar").length;
    const no = [...feedback.values()].filter(v => v === "different").length;
    const artifact = [...feedback.values()].filter(v => v === "artifact").length;
    const unsure = [...feedback.values()].filter(v => v === "uncertain").length;
    $("similarFeedbackSummary").textContent = feedback.size
      ? `${yes} similar · ${no} different · ${artifact} artifact · ${unsure} uncertain`
      : response.matches.length ? `${response.diagnostics?.returnedAboveThreshold ?? response.matches.length} above score guide · all require review.` : response.diagnostics?.emptyReason === "no-independent-valid-windows" ? "No independent valid windows. Expand the range beyond the reference or include other channels." : "No candidates passed this search. Use Closest candidates, shorten the reference, or widen the range; this does not exclude abnormal activity.";
    $("similarResetFeedback").classList.toggle("hidden", !feedback.size);
    $("similarResults").innerHTML = rankMatches(response.matches, feedback).map((m, i) =>
      `<article class="similar-match" data-id="${m.id}" data-feedback="${m.feedback || "unreviewed"}">
        <div class="similar-match-head"><span class="similar-rank">${String(i + 1).padStart(2, "0")}</span><b>${escapeHtml(m.label)}</b><span class="similar-score" title="${m.shapeScore == null ? "Normalized correlation" : "Maximum of native correlation and elastic blend; uncalibrated"}"><small>${m.shapeScore == null ? "r" : "shape"}</small> ${m.score.toFixed(3)}</span></div>
        ${m.aboveThreshold === false ? '<div class="similar-below">Below score guide · exploratory candidate</div>' : ""}
        ${plot(m.preview, ref.preview)}
        ${m.shapeScore == null ? "" : `<div class="similar-match-meta"><span>r ${m.correlation.toFixed(3)}</span><span>elastic ${m.shapeScore.toFixed(3)}</span></div>`}
        <div class="similar-match-meta"><span>${m.startSec.toFixed(3)}–${m.endSec.toFixed(3)} s</span>${m.inverted ? '<span class="similar-inverted">Inverted</span>' : ""}</div>
        ${m.amplitudeRatio == null ? "" : `<div class="similar-match-meta"><span>${((m.endSec-m.startSec)*1000).toFixed(0)} ms window${m.durationScale && m.durationScale !== 1 ? ` · ${m.durationScale.toFixed(2)}× duration` : ""}</span><span title="Peak-to-peak amplitude relative to reference, before display normalization; not a disease criterion">· ${m.amplitudeRatio.toFixed(2)}× reference p–p</span></div>`}
        <div class="similar-match-actions"><div class="similar-votes" role="group" aria-label="Review ${escapeHtml(m.label)} at ${m.startSec.toFixed(3)} seconds">
          <button type="button" data-action="similar" aria-pressed="${m.feedback === "similar"}" title="Similar shape; click again to undo">${checkIcon}Similar</button>
          <button type="button" data-action="different" aria-pressed="${m.feedback === "different"}" title="Different shape; click again to undo">${crossIcon}Different</button>
          <button type="button" data-action="artifact" aria-pressed="${m.feedback === "artifact"}" title="Reviewer suspects artifact; not an automated classification">Artifact</button>
          <button type="button" data-action="uncertain" aria-pressed="${m.feedback === "uncertain"}" title="Needs further review; does not train the ranking">Uncertain</button>
        </div><button type="button" data-action="open" aria-label="Open matched waveform" title="Open with this search's processing settings">${arrowIcon}</button></div>
        <details class="similar-note"><summary>Review note${observations.has(m.id) ? " · saved in session" : ""}</summary><label>Shape / background / field / artifact<textarea data-note="${m.id}" maxlength="1000" rows="3" placeholder="Observations, uncertainty, or reason for your review…">${escapeHtml(observations.get(m.id) || "")}</textarea></label></details>
      </article>`).join("");
  }
  async function search() {
    if (selectingReference) {
      status("Finish dragging the reference on the waveform first.", true); return;
    }
    syncProcessing();
    if (!sourceToken || sourceToken !== token()) { status("Reload the recording before searching.", true); return; }
    syncLabels();
    const a = Number($("similarStart").value), b = Number($("similarEnd").value);
    const invalid = referenceError($("similarStart").value, $("similarEnd").value, $("similarChannel").value, viewer.duration, nativeFs());
    if (invalid) { status(invalid, true); return; }
    const id = revision;
    try {
      const reference = draftReference || workspace.capture({ source: source(), channel: Number($("similarChannel").value), startSec: a, endSec: b });
      const body = { referenceId: reference.id, method: $("similarMethod").value,
        scope: $("similarScope").value, minScore: Number($("similarThreshold").value), retrieval: $("similarRetrieval").value,
        durationTolerance: Number($("similarDuration").value),
        ignorePolarity: $("similarPolarity").checked };
      if ($("similarRange").value === "current") {
        body.searchStartSec = viewer.tStart; body.searchEndSec = viewer.tEnd;
      }
      await workspace.search(body);
      draftReference = null;
    } catch (error) {
      if (id === revision) status(error.name === "AbortError" ? "Search stopped." : error.message, error.name !== "AbortError");
    }
  }
  function resultStatus(payload) {
      const coverage = payload.coverage, count = payload.matches.length;
      status(`${count} candidates · ${(payload.elapsedMs / 1000).toFixed(1)} s · `
        + (coverage.complete ? "Full range scanned" : `Partial scan · ${(100 * coverage.fraction).toFixed(1)}% coverage (${coverage.reason}). Narrow the range or channels to finish.`)
        + (count === payload.poolLimit ? ` · ${payload.poolLimit}-match limit` : "")
        + (payload.ranking?.approximate ? " · approximate candidate refinement" : "")
        + (payload.ranking?.refinementComplete === false ? " · refinement time limit reached" : "")
        + (payload.ranking?.previewsComplete === false ? " · preview time limit reached; result list incomplete" : "")
        + (payload.processingDomain?.strategy === "chunked-padded-native-dsp" ? " · chunked native DSP (boundary approximation)" : payload.processingDomain && !payload.processingDomain.wholeRecording ? " · padded local context (viewport edge differences possible)" : "")
        + (!count ? " · No confirmed absence can be inferred." : ""));
  }
  workspace.subscribe(type => {
    const snapshot = workspace.panelSnapshot();
    busy(!!snapshot.state.pending);
    const historySelect = $("similarHistory");
    if (historySelect) {
      historySelect.innerHTML = (snapshot.state.sets || []).map((s, i) => `<option value="${escapeHtml(s.id)}">${String(i + 1).padStart(2, "0")} · ${escapeHtml(s.label)} · ${s.startSec.toFixed(2)} s · ${s.actor === "agent" ? "Agent" : "You"} · ${s.reviewedCount}/${s.count} reviewed</option>`).join("") || '<option value="" disabled>No searches yet</option>';
      historySelect.value = snapshot.state.activeSetId || "";
      historySelect.disabled = !snapshot.state.sets?.length;
    }
    if (type === "search-start") status(`${snapshot.state.pending?.actor === "agent" ? "Agent · " : ""}Comparing the frozen reference · current view stays unchanged…`);
    if (type === "search-end" && snapshot.state.lastError
      && !(snapshot.state.lastError === "Search stopped." && /settings|View updated/.test($("similarStatus").textContent))) {
      status(snapshot.state.lastError, snapshot.state.lastError !== "Search stopped.");
    }
    if (snapshot.set && ["search-result", "select", "review", "note"].includes(type)) {
      const set = snapshot.set;
      response = set.response; activeSetId = set.id;
      feedback = set.feedback; observations = set.observations;
      if (type !== "note") render();
      viewNotice();
      if (["search-result", "select"].includes(type)) {
        $("similarTemplateEditor").open = false; $("similarOptions").open = false;
        const newest = snapshot.state.sets.at(-1);
        if (type === "search-result" && newest.id !== activeSetId) status("Agent results added to Session evidence · your current review stays open.");
        else resultStatus(response);
      }
    }
  });
  $("similarHistory")?.addEventListener("change", () => workspace.select($("similarHistory").value));
  $("similarSearch").addEventListener("click", search);
  $("similarStop").addEventListener("click", () => { workspace.cancel(); status("Stopping search…"); });
  $("similarCapture").addEventListener("click", capture);
  $("similarSelect").addEventListener("click", () => {
    selectingReference = true;
    $("measureToggle").checked = true; $("markerToggle").checked = false;
    viewer.setMeasureMode(true);
    status("Drag across the reference waveform · it will be captured when you release.");
  });
  viewer.onMeasureComplete = () => {
    if (selectingReference) capture();
  };
  $("similarSource").addEventListener("change", () => { draftReference = null; syncProcessing(); });
  for (const name of ["similarChannel", "similarStart", "similarEnd", "similarScope", "similarRange", "similarThreshold", "similarPolarity", "similarMethod", "similarRetrieval", "similarDuration"]) {
    $(name).addEventListener("change", () => {
      if (["similarChannel", "similarStart", "similarEnd"].includes(name)) draftReference = null;
      invalidate("Search settings changed · run a new search to apply; previous reviews retained.");
    });
  }
  $("similarResetFeedback").addEventListener("click", () => activeSetId && workspace.resetReviews(activeSetId));
  function openWaveform(match) {
    if (!response || sourceToken !== token()) return;
    const p = response.processing;
    restoring = true;
    try {
      ctx.setMontage(p?.montage || "raw");
      ctx.setFilter({ low: p?.filterLow || 0, high: p?.filterHigh || 0, notch: p?.notch || "off" });
      ctx.setDiff(p?.diffOrder || 0);
      if (p?.normOpts) viewer.setNormOpts(p.normOpts);
      ctx.setNorm(p?.normalization || "none");
    } finally { restoring = false; processingKey = ""; syncProcessing(); }
    viewer.clearChannelFocus();
    $("channelSearch").value = "";
    $("channelSort").value = "file";
    viewer.selectChannel(match.channel, true);
    viewer.measureRange = [match.startSec, match.endSec];
    const pad = Math.max(2, (match.endSec - match.startSec) * .5);
    viewer.setTimeWindow(Math.max(0, match.startSec - pad), Math.min(viewer.duration, match.endSec + pad));
    ctx.renderAnalysis?.(viewer.getSelectedAnalysis());
    viewNotice();
    status("Review in context · saved processing restored · inspect simultaneous channels and artifacts.");
  }
  $("similarOpenReference").addEventListener("click", () => response && openWaveform(response.reference));
  $("similarExportReview").addEventListener("click", () => {
    if (!response) return;
    const report = workspace.exportReview(activeSetId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:"application/json"}));
    const a = document.createElement("a"); a.href = url; a.download = "waveform-similarity-review.json";
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    status("Review exported locally · contains channel labels and notes; handle as sensitive data.");
  });
  $("similarResults").addEventListener("input", event => {
    if (!event.target.matches("textarea[data-note]")) return;
    workspace.note(activeSetId, event.target.dataset.note, event.target.value);
  });
  $("similarResults").addEventListener("change", event => {
    if (event.target.matches("textarea[data-note]")) workspace.note(activeSetId, event.target.dataset.note, event.target.value);
  });
  $("similarResults").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const card = button?.closest("[data-id]");
    if (!card || !response || sourceToken !== token()) return;
    const match = response.matches.find((m) => m.id === card.dataset.id);
    if (!match) return;
    if (button.dataset.action === "open") {
      openWaveform(match);
    } else {
      const value = button.dataset.action;
      workspace.review(activeSetId, match.id, feedback.get(match.id) === value ? "unreviewed" : value);
      $("similarResults").querySelector(`[data-id="${match.id}"] [data-action="${value}"]`)?.focus({ preventScroll: true });
    }
  });
  ctx.resetSimilarity = reset;
  ctx.refreshSimilaritySource = refreshSource;
  ctx.syncSimilarityProcessing = syncProcessing;
  reset();
}
