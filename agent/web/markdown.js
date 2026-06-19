// markdown.js — small self-contained markdown renderer for AI messages.
// Supports: fenced code, #..###### headings, -/*/+ and ordered lists,
// > blockquotes, --- rules, GFM pipe tables, and inline bold/italic/strike/
// code/links. Input is escaped up front, so detection runs on escaped text
// (note: ">" becomes "&gt;").

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderMarkdown(markdown) {
  let src = String(markdown || "");
  const codeBlocks = [];
  src = src.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const id = `@@CODE${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code class="language-${escapeHtml(lang || "text")}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return id;
  });

  const lines = escapeHtml(src).split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null;
  let quote = null;

  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`); para = []; } };
  const closeList = () => {
    if (!list) return;
    const tag = list.type;
    out.push(`<${tag}>${list.items.map((x) => `<li>${inlineMarkdown(x)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  const closeQuote = () => {
    if (!quote) return;
    out.push(`<blockquote>${inlineMarkdown(quote.join(" "))}</blockquote>`);
    quote = null;
  };
  const flushAll = () => { flushPara(); closeList(); closeQuote(); };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { flushAll(); i++; continue; }

    const codeId = trimmed.match(/^@@CODE(\d+)@@$/);
    if (codeId) { flushAll(); out.push(codeBlocks[+codeId[1]] || ""); i++; continue; }

    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) { flushAll(); out.push("<hr/>"); i++; continue; }

    // GFM table: a row with a pipe followed by a separator row.
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      const parsed = parseTable(lines, i);
      out.push(parsed.html);
      i = parsed.next;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i++; continue;
    }

    const bq = trimmed.match(/^&gt;\s?(.*)$/);
    if (bq) { flushPara(); closeList(); (quote ||= []).push(bq[1]); i++; continue; }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushPara(); closeQuote();
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) { closeList(); list = { type, items: [] }; }
      list.items.push((bullet || ordered)[1]);
      i++; continue;
    }

    closeList(); closeQuote();
    para.push(trimmed);
    i++;
  }
  flushAll();
  return out.join("").replace(/@@CODE(\d+)@@/g, (_m, n) => codeBlocks[+n] || "");
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s+/g, "")));
}

function splitTableRow(line) {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function parseTable(lines, start) {
  const header = splitTableRow(lines[start]);
  const aligns = splitTableRow(lines[start + 1]).map((c) => {
    const t = c.trim();
    const l = t.startsWith(":"), r = t.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "";
  });
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(splitTableRow(lines[i]));
    i++;
  }
  const al = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
  const thead = `<thead><tr>${header.map((c, idx) => `<th${al(idx)}>${inlineMarkdown(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((r) =>
    `<tr>${header.map((_, idx) => `<td${al(idx)}>${inlineMarkdown(r[idx] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return { html: `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`, next: i };
}

function inlineMarkdown(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
