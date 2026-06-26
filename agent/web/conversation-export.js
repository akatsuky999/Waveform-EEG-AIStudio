// conversation-export.js — export an EEG-Master conversation as JSON, a
// self-contained HTML report, or Markdown. The HTML reuses the exact same
// tool-card / markdown renderers as the live drawer so the exported record
// looks like the app: collapsible tool cards (auto-expanded when printing),
// embedded run_python code + output, rendered signal images, and tables.

import { renderMarkdown, escapeHtml } from "./markdown.js";
import { toolTitle } from "./tools.js";
import { renderToolBody, toolIcon, isSkillTool } from "./ui.js";

// Quiet status glyphs mirroring the live drawer (a check for done, an alert for
// error, a chevron for the expand affordance) — no colored status pills.
const EXPORT_CHECK = '<svg class="tool-done-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const EXPORT_ERROR_GLYPH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>';
const EXPORT_CHEV = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

// Self-contained download (no cross-mount import; keeps the agent plugin portable).
function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeJSON(value, indent = 2) {
  try { return JSON.stringify(value, null, indent); }
  catch { return String(value); }
}

function slugify(title) {
  return (String(title || "conversation").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "conversation";
}

function fileBase(conv) {
  return `eeg-master-${slugify(conv?.title)}-${new Date().toISOString().slice(0, 10)}`;
}

function metaLine(conv, meta, sep) {
  return [
    meta.model && `model: ${meta.model}`,
    meta.file && `recording: ${meta.file}`,
    `exported: ${new Date(meta.exportedAt || Date.now()).toLocaleString()}`,
  ].filter(Boolean).join(sep);
}

// ---- JSON: complete machine-readable record -----------------------------
function buildJSON(conv, meta) {
  return safeJSON({
    app: "EEG-Master / Waveform",
    title: conv.title || "EEG-Master conversation",
    model: meta.model || null,
    recording: meta.file || null,
    exportedAt: new Date(meta.exportedAt || Date.now()).toISOString(),
    createdAt: conv.createdAt ? new Date(conv.createdAt).toISOString() : null,
    log: conv.log || [],
    transcript: conv.transcript || [],
  });
}

// ---- HTML: self-contained, app-styled report ----------------------------
function toolStatus(outcome) { return outcome && outcome.ok === false ? "error" : "done"; }

function logItemHTML(item) {
  if (!item || !item.kind) return "";
  if (item.kind === "user") {
    return `<div class="msg user"><div class="who">You</div><div class="md">${renderMarkdown(item.text || "")}</div></div>`;
  }
  if (item.kind === "assistant") {
    if (!item.text || !item.text.trim()) return "";
    return `<div class="msg assistant"><div class="who">EEG-Master</div><div class="md">${renderMarkdown(item.text)}</div></div>`;
  }
  if (item.kind === "note") return `<div class="note">${escapeHtml(item.text || "")}</div>`;
  if (item.kind === "error") {
    return `<div class="msg error"><div class="who">Error</div><div class="md">${renderMarkdown(item.text || "Request failed")}</div></div>`;
  }
  if (item.kind === "tool") {
    const status = toolStatus(item.outcome);
    const skill = isSkillTool(item.name);
    const state = status === "error" ? `${EXPORT_ERROR_GLYPH}<span>Error</span>` : EXPORT_CHECK;
    return `<details class="tool" data-status="${status}" data-kind="${skill ? "skill" : "tool"}"${status === "error" ? " open" : ""}>` +
      `<summary><span class="tool-icon">${toolIcon(item.name)}</span>` +
      `<span class="tool-name">${escapeHtml(toolTitle(item.name, item.args || {}))}</span>` +
      (skill ? `<span class="tool-kind">skill</span>` : "") +
      `<span class="tool-state">${state}</span>` +
      `<span class="tool-chev">${EXPORT_CHEV}</span></summary>` +
      `<div class="ai-tool tool-body">${renderToolBody(item.name, item.outcome || {})}</div>` +
      `</details>`;
  }
  return "";
}

export function buildHTML(conv, meta, logos = {}) {
  const title = escapeHtml(conv.title || "EEG-Master conversation");
  const items = (conv.log || []).map(logItemHTML).join("\n") ||
    `<div class="note">This conversation has no messages yet.</div>`;
  const agentMark = logos.agentLogo
    ? `<img class="brand-agent-logo" src="${logos.agentLogo}" alt="" width="30" height="30">`
    : ROBOT_SVG;
  const brand =
    `<div class="brand">` +
      (logos.waveLogo ? `<img class="brand-logo" src="${logos.waveLogo}" alt="Waveform" width="32" height="32">` : "") +
      `<span class="brand-word">Waveform</span>` +
      `<span class="brand-sep" aria-hidden="true">·</span>` +
      `<span class="brand-agent">${agentMark}<span>EEG-Master</span></span>` +
    `</div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Waveform EEG-Master</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<header class="doc-head">
  <div class="doc-head-row">
    ${brand}
    <button class="print-btn" type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <h1>${title}</h1>
  <div class="doc-meta">${escapeHtml(metaLine(conv, meta, " · "))}</div>
</header>
<main class="doc-body">
${items}
</main>
<footer class="doc-foot">Generated by EEG-Master · Waveform. Signal observations require expert review; not a medical device.</footer>
</body>
</html>`;
}

// ---- Markdown: portable, readable ---------------------------------------
function toolMarkdown(item) {
  const o = item.outcome || {};
  const ok = o.ok !== false;
  const out = [`#### 🔧 ${toolTitle(item.name, item.args || {})} ${ok ? "✓" : "✗"}`, ""];
  if (o.code) out.push("```python", o.code, "```", "");
  const r = o.result;
  if (item.name === "run_python" && r && typeof r === "object") {
    if (r.stdout) out.push("**stdout**", "", "```text", String(r.stdout), "```", "");
    if (r.result != null) out.push("**result**", "", "```json", safeJSON(r.result), "```", "");
    if (Array.isArray(r.eventCandidates) && r.eventCandidates.length) {
      out.push("**event candidates (not applied)**", "", "```json", safeJSON(r.eventCandidates), "```", "");
    }
  } else if (r != null) {
    out.push("```json", safeJSON(r), "```", "");
  }
  (o.attachments || []).forEach((a, i) => {
    if (typeof a?.dataUrl === "string" && a.dataUrl.startsWith("data:")) {
      out.push(`![${a.label || `figure ${i + 1}`}](${a.dataUrl})`, "");
    }
  });
  const err = o.error || (r && typeof r === "object" ? r.error : null);
  if (err) out.push("**error**", "", "```text", String(err), "```", "");
  return out;
}

function buildMarkdown(conv, meta) {
  const lines = [`# ${conv.title || "EEG-Master conversation"}`];
  const m = metaLine(conv, meta, " · ");
  if (m) lines.push("", `*${m}*`);
  lines.push("", "---", "");
  for (const item of conv.log || []) {
    if (item.kind === "user") lines.push("### 🧑 You", "", item.text || "", "");
    else if (item.kind === "assistant") { if (item.text && item.text.trim()) lines.push("### 🤖 EEG-Master", "", item.text, ""); }
    else if (item.kind === "note") lines.push(`> ${item.text || ""}`, "");
    else if (item.kind === "error") lines.push(`> ⚠️ ${item.text || ""}`, "");
    else if (item.kind === "tool") lines.push(...toolMarkdown(item), "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---- entry point --------------------------------------------------------
export async function exportConversation(conv, format, meta = {}) {
  if (!conv) return;
  const base = fileBase(conv);
  if (format === "json") download(buildJSON(conv, meta), `${base}.json`, "application/json");
  else if (format === "markdown") download(buildMarkdown(conv, meta), `${base}.md`, "text/markdown");
  else {
    const [waveLogo, agentLogo] = await Promise.all([loadWaveformLogo(), loadAgentLogo()]);
    download(buildHTML(conv, meta, { waveLogo, agentLogo }), `${base}.html`, "text/html");
  }
}

// Inline both marks as data-URIs so the exported HTML stays self-contained (no
// server dependency once the file is opened from disk).
// Waveform mark: small file, embed as-is.
let _waveLogoPromise = null;
function loadWaveformLogo() {
  if (_waveLogoPromise) return _waveLogoPromise;
  _waveLogoPromise = fetch("/pic/logo/readme-logo.png")
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`logo ${r.status}`))))
    .then((blob) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }))
    .catch(() => null);
  return _waveLogoPromise;
}

// EEG-Master rounded mark: downscale through a canvas first so every export
// only carries a tiny thumbnail of the 512px source.
let _agentLogoPromise = null;
function loadAgentLogo() {
  if (_agentLogoPromise) return _agentLogoPromise;
  _agentLogoPromise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 96; canvas.height = 96;
        canvas.getContext("2d").drawImage(img, 0, 0, 96, 96);
        resolve(canvas.toDataURL("image/png"));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = "/pic/agent_logo/eeg-master-ai-scope-rounded-512.png";
  });
  return _agentLogoPromise;
}

// Fallback EEG-Master mark (used only if the rounded PNG can't be embedded).
const ROBOT_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2.4" x2="12" y2="5"/><circle cx="12" cy="2" r=".7" fill="currentColor" stroke="none"/><rect x="4.5" y="5" width="15" height="12.5" rx="3.6"/><path d="M3 10.5v3.5M21 10.5v3.5"/><circle cx="9.4" cy="11" r="1.1"/><circle cx="14.6" cy="11" r="1.1"/><path d="M9.6 14.6h4.8"/></svg>`;

// ---- inlined stylesheet (mirrors the app's warm palette + tool cards) ----
const EXPORT_CSS = `
:root{
  --bg:#faf9f4; --rail:#f4f1e9; --panel:#ece8dd; --paper:#fff;
  --ink:#1d1b16; --ink-soft:#6b6760; --muted:#a8a499; --line:#e3dfd2;
  --accent:#c75f3e; --accent-ink:#b1502f;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;}
.doc-head{max-width:860px;margin:0 auto;padding:32px 24px 18px;border-bottom:1px solid var(--line);}
.doc-head-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.brand{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0;}
.brand-logo{width:32px;height:32px;object-fit:contain;flex:0 0 auto;}
.brand-word{font-family:"Fraunces",Georgia,"Times New Roman",serif;font-size:20px;font-weight:500;letter-spacing:-.015em;color:var(--ink);}
.brand-sep{color:var(--muted);}
.brand-agent{display:inline-flex;align-items:center;gap:8px;color:var(--accent-ink);font-weight:600;font-size:17px;letter-spacing:.005em;}
.brand-agent svg{color:var(--accent);flex:0 0 auto;}
.brand-agent-logo{width:30px;height:30px;border-radius:8px;object-fit:contain;flex:0 0 auto;}
.doc-head h1{font-size:22px;margin:14px 0 6px;color:var(--ink);font-weight:650;}
.doc-meta{font-size:12px;color:var(--ink-soft);font-family:var(--mono);}
.print-btn{font-family:var(--sans);font-size:12.5px;color:var(--ink-soft);background:var(--paper);
  border:1px solid var(--line);border-radius:100px;padding:7px 15px;cursor:pointer;}
.print-btn:hover{color:var(--accent-ink);border-color:var(--muted);}
.doc-body{max-width:860px;margin:0 auto;padding:22px 24px 8px;display:flex;flex-direction:column;gap:14px;}
.doc-foot{max-width:860px;margin:0 auto;padding:18px 24px 40px;color:var(--muted);font-size:11.5px;border-top:1px solid var(--line);}

.msg{overflow-wrap:anywhere;}
.msg .who{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:5px;font-weight:600;}
.msg.user{align-self:flex-end;max-width:82%;background:var(--accent);color:#fff;border-radius:14px 14px 4px 14px;padding:11px 14px;}
.msg.user .who{color:rgba(255,255,255,.8);}
.msg.assistant{align-self:flex-start;max-width:100%;}
.msg.error{align-self:flex-start;max-width:100%;background:#fff7f3;border:1px solid #edd1c6;border-radius:12px;padding:11px 14px;color:var(--accent-ink);}
.note{align-self:center;font-size:12px;color:var(--ink-soft);background:var(--rail);border:1px solid var(--line);border-radius:100px;padding:5px 14px;}

.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md p{margin:0 0 10px}
.md h1,.md h2,.md h3,.md h4{margin:16px 0 8px;line-height:1.3;font-weight:650;}
.md h1{font-size:18px}.md h2{font-size:16px}.md h3{font-size:14.5px}
.md h4{font-size:13px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em;}
.md ul,.md ol{margin:8px 0 10px;padding-left:20px}
.md li{margin:4px 0}.md li::marker{color:var(--muted)}
.md blockquote{margin:10px 0;padding:2px 14px;border-left:3px solid var(--line);color:var(--ink-soft);}
.md hr{border:0;border-top:1px solid var(--line);margin:16px 0}
.md code{font-family:var(--mono);font-size:12px;background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:1px 5px;}
.md pre{margin:10px 0;padding:12px;background:#24211d;border-radius:10px;overflow:auto;}
.md pre code{background:transparent;border:0;color:#f8f2e7;padding:0;font-size:12px;}
.md a{color:var(--accent-ink);}
.msg.user .md code{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.25);color:#fff;}
.msg.user .md a{color:#fff;}
.md-table-wrap{margin:10px 0;overflow-x:auto;border:1px solid var(--line);border-radius:10px;}
.md-table{width:100%;border-collapse:collapse;font-size:12.5px;}
.md-table th,.md-table td{padding:7px 11px;border-bottom:1px solid var(--line);text-align:left;}
.md-table th{background:var(--rail);font-weight:600;}
.md-table tr:last-child td{border-bottom:0;}
.md-table tbody tr:nth-child(even) td{background:rgba(0,0,0,.018);}

/* quiet tool rows: muted icons, a check on completion, a faint thread linking
   consecutive steps, and a clay tint for skill rows — matching the live drawer */
.tool{position:relative;border-radius:9px;}
.tool + .tool::before{content:"";position:absolute;left:17px;top:-15px;height:15px;width:1.5px;background:linear-gradient(var(--line),rgba(0,0,0,0));border-radius:2px;}
.tool[data-kind="skill"] + .tool::before,.tool + .tool[data-kind="skill"]::before{background:linear-gradient(rgba(199,95,62,.4),rgba(0,0,0,0));}
.tool>summary{list-style:none;display:flex;align-items:center;gap:9px;padding:5px 7px;border-radius:9px;cursor:pointer;color:var(--ink-soft);font-weight:500;}
.tool>summary::-webkit-details-marker{display:none;}
.tool>summary:hover{background:rgba(0,0,0,.035);color:var(--ink);}
.tool[open]>summary{color:var(--ink);}
.tool-icon{flex:0 0 auto;width:19px;height:19px;display:inline-flex;align-items:center;justify-content:center;color:var(--muted);}
.tool[data-status="error"] .tool-icon{color:var(--accent);}
.tool[data-kind="skill"] .tool-icon{color:var(--accent);}
.tool-name{flex:1 1 auto;min-width:0;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:inherit;}
.tool[data-kind="skill"] .tool-name{color:var(--accent-ink);}
.tool-kind{flex:0 0 auto;font-family:var(--mono);font-size:8.5px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);opacity:.6;}
.tool-state{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:9.5px;font-weight:500;color:var(--muted);}
.tool[data-status="error"] .tool-state{color:var(--accent-ink);}
.tool-done-check{color:#6f9d72;}
.tool[data-kind="skill"] .tool-done-check{color:var(--accent);}
.tool-chev{flex:0 0 auto;color:var(--muted);opacity:.5;transition:transform .15s ease;}
.tool[open] .tool-chev{transform:rotate(180deg);}
.tool-body{position:relative;padding:2px 10px 12px 35px;}
.tool[open] .tool-body::before{content:"";position:absolute;left:16.5px;top:0;bottom:9px;width:1.5px;background:var(--line);border-radius:2px;}
.ai-tool-label{margin:11px 0 5px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;}
.ai-code,.ai-out,.ai-err{margin:0;padding:9px;border-radius:8px;font-family:var(--mono);font-size:11.5px;line-height:1.55;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;}
.ai-code{background:#24211d;color:#f8f2e7;}
.ai-code code{background:transparent;border:0;padding:0;color:inherit;}
.ai-out{background:var(--panel);color:var(--ink);border:1px solid var(--line);}
.ai-err{background:#fff7f3;color:var(--accent-ink);border:1px solid #edd1c6;}
.ai-figure{display:block;max-width:100%;margin-top:9px;border-radius:8px;border:1px solid var(--line);}
.ai-note-line{margin-top:7px;font-size:11px;color:var(--accent-ink);}

@media print{
  body{background:#fff;}
  .print-btn,.tool-chev{display:none;}
  .tool{break-inside:avoid;}
  .tool>summary{cursor:default;}
  details>:not(summary){display:block!important;}
  .ai-code,.ai-out,.ai-err{max-height:none;white-space:pre-wrap;}
  .ai-figure{max-height:none;}
}
`;
