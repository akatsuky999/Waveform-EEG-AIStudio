// normalization.js — the normalization dropdown, MathML formula card, and
// contextual parameters (min–max range, robust percentile band).

import { NORM_METHODS } from "../core/parse.js";
import { $ } from "../core/util.js";

export function initNormalization(ctx) {
  const viewer = ctx.viewer;
  let currentNorm = "none";

  function renderFormula(method) {
    const m = NORM_METHODS[method] || NORM_METHODS.none;
    $("formulaCard").innerHTML = m.formula(viewer.normOpts);
  }

  function renderParams(method) {
    const wrap = $("normParams");
    const spec = (NORM_METHODS[method] || {}).params;
    wrap.innerHTML = "";
    if (!spec) { wrap.style.display = "none"; return; }
    wrap.style.display = "";

    if (spec.type === "mmRange") {
      wrap.innerHTML =
        `<div class="prow"><span class="plabel">Output range</span>` +
        `<div class="seg-mini" id="mmSeg">` +
        `<button data-r="sym" class="${viewer.normOpts.mmRange === "sym" ? "active" : ""}">[−1, 1]</button>` +
        `<button data-r="unit" class="${viewer.normOpts.mmRange === "unit" ? "active" : ""}">[0, 1]</button>` +
        `</div></div>`;
      wrap.querySelectorAll("#mmSeg button").forEach((b) => b.addEventListener("click", () => {
        viewer.setNormOpts({ mmRange: b.dataset.r });
        wrap.querySelectorAll("#mmSeg button").forEach((x) => x.classList.toggle("active", x === b));
        renderFormula(method);
      }));
    } else if (spec.type === "robust") {
      const lo = viewer.normOpts.robLow;
      wrap.innerHTML =
        `<div class="prow"><span class="plabel">Percentile band</span>` +
        `<span class="pval" id="robVal">Q${lo}–Q${100 - lo}</span></div>` +
        `<input type="range" id="robRange" min="5" max="45" step="5" value="${lo}" />`;
      wrap.querySelector("#robRange").addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10);
        $("robVal").textContent = `Q${v}–Q${100 - v}`;
        viewer.setNormOpts({ robLow: v });
        renderFormula(method);
      });
    }
  }

  function openNormMenu(open) {
    $("normMenu").classList.toggle("open", open);
    $("normTrigger").setAttribute("aria-expanded", String(open));
    $("normTrigger").classList.toggle("open", open);
  }

  function setNorm(method) {
    currentNorm = method;
    viewer.setNorm(method);
    syncNorm(method);
  }

  function syncNorm(method) {
    currentNorm = method;
    $("normCurrent").textContent = (NORM_METHODS[method] || NORM_METHODS.none).label;
    document.querySelectorAll("#normMenu .dd-item").forEach((b) => b.classList.toggle("active", b.dataset.m === method));
    renderFormula(method);
    renderParams(method);
    $("normHint").textContent = (NORM_METHODS[method] || NORM_METHODS.none).desc;
  }

  $("normTrigger").addEventListener("click", (e) => {
    e.stopPropagation();
    openNormMenu(!$("normMenu").classList.contains("open"));
  });
  document.querySelectorAll("#normMenu .dd-item").forEach((b) => {
    b.addEventListener("click", () => { setNorm(b.dataset.m); openNormMenu(false); });
    b.addEventListener("mouseenter", () => {
      renderFormula(b.dataset.m);
      $("normHint").textContent = (NORM_METHODS[b.dataset.m] || NORM_METHODS.none).desc;
    });
  });
  $("normMenu").addEventListener("mouseleave", () => {
    renderFormula(currentNorm);
    $("normHint").textContent = (NORM_METHODS[currentNorm] || NORM_METHODS.none).desc;
  });
  document.addEventListener("click", (e) => {
    if (!$("normDropdown").contains(e.target)) openNormMenu(false);
  });

  ctx.setNorm = setNorm;
  ctx.syncNormFromViewer = () => syncNorm(viewer.normMethod || "none");
  return { setNorm, syncNorm };
}
