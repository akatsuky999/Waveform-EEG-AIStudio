// Feedback stays attached to a frozen search pool and never writes annotations.
export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa > 0 && bb > 0 ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}

export function rankMatches(matches, feedback = new Map()) {
  const positive = matches.filter((m) => feedback.get(m.id) === "similar");
  const negative = matches.filter((m) => feedback.get(m.id) === "different");
  return matches.map((match) => {
    const yes = positive.length ? Math.max(...positive.map((p) => Math.max(0, cosine(match.preview, p.preview)))) : 0;
    const no = negative.length ? Math.max(...negative.map((p) => Math.max(0, cosine(match.preview, p.preview)))) : 0;
    const rankScore = (positive.length ? 0.7 * match.score + 0.3 * yes : match.score) - 0.35 * no;
    return { ...match, rankScore, feedback: feedback.get(match.id) || null };
  }).sort((a, b) => {
    const group = (m) => m.feedback === "similar" ? 0 : ["different", "artifact"].includes(m.feedback) ? 2 : 1;
    return group(a) - group(b) || b.rankScore - a.rankScore || a.startSec - b.startSec || a.channel - b.channel;
  });
}

// Pure validation shared with UI regression tests. Empty selects must not become
// channel 0 through Number(""); sample-count limits use the recording's native rate.
export function referenceError(start, end, channel, duration, fs) {
  if (channel === "" || !Number.isInteger(Number(channel)) || Number(channel) < 0) return "Choose a reference channel.";
  if (String(start).trim() === "" || String(end).trim() === "") return "Enter both reference times.";
  const a = Number(start), b = Number(end);
  if (![a, b].every(Number.isFinite) || a < 0 || b > duration || b - a < .02 - 1e-9 || b - a > 10)
    return "Select a 0.02–10 s reference within the recording; include the waveform, not a long unrelated background.";
  if (Number.isFinite(fs) && Math.round(b * fs) - Math.round(a * fs) < 8)
    return `Reference needs at least 8 native samples (${(8000 / fs).toFixed(1)} ms at ${fs} Hz).`;
  return null;
}

export function reviewExport(response, request, feedback, observations, history, now = new Date().toISOString()) {
  // Never export an ephemeral server dataToken or a machine-local source path.
  const { token, ...parameters } = request || {};
  return { schema: "waveform-similarity-review-v1", exportedAt: now,
    purpose: "Human-reviewed similarity candidates; not diagnoses or validated clinical detections.",
    recording: response.recording || { samplingRate: response.samplingRate }, parameters,
    result: response, decisions: response.matches.map(m => ({ id: m.id, channel: m.label,
      startSec: m.startSec, endSec: m.endSec, decision: feedback.get(m.id) || "unreviewed",
      note: observations.get(m.id) || "" })), history };
}

export function previewPath(values, width = 240, height = 54) {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  return values.map((v, i) => `${i ? "L" : "M"}${(i * width / Math.max(1, values.length - 1)).toFixed(2)},${(height / 2 - v / max * (height / 2 - 3)).toFixed(2)}`).join(" ");
}
