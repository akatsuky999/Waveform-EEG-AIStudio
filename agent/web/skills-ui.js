import {
  createAgentSkill, deleteAgentSkill, listAgentSkills, readAgentSkill,
  skillToDocument, updateAgentSkill,
} from "./skills-client.js";

const $ = (id) => document.getElementById(id);
let editorAllowedTools = [];

function cleanName(name) {
  return String(name || "").trim();
}

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function joinList(value) {
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function splitList(value) {
  return String(value || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function downloadText(text, name, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function setText(el, text) {
  if (el) el.textContent = text || "";
}

function formPayload() {
  return {
    name: $("aiSkillName")?.value.trim() || "",
    title: $("aiSkillTitle")?.value.trim() || "",
    description: $("aiSkillDescription")?.value.trim() || "",
    category: $("aiSkillCategory")?.value.trim() || "workflow",
    version: $("aiSkillVersion")?.value.trim() || "1.0",
    triggers: splitList($("aiSkillTriggers")?.value),
    tags: splitList($("aiSkillTags")?.value),
    allowedTools: editorAllowedTools.slice(),
    markdown: $("aiSkillMarkdown")?.value.trim() || "",
  };
}

function fillForm(skill = {}, { copy = false } = {}) {
  const name = copy ? `${skill.name || "skill"}-copy` : skill.name;
  $("aiSkillName").value = cleanName(name);
  $("aiSkillName").disabled = Boolean(skill.name && !copy);
  $("aiSkillTitle").value = skill.title || "";
  $("aiSkillDescription").value = skill.description || "";
  $("aiSkillCategory").value = skill.category || "workflow";
  $("aiSkillVersion").value = skill.version || "1.0";
  $("aiSkillTriggers").value = joinList(skill.triggers);
  $("aiSkillTags").value = joinList(skill.tags);
  editorAllowedTools = Array.isArray(skill.allowedTools) ? skill.allowedTools.slice() : [];
  $("aiSkillMarkdown").value = skill.markdown || "";
}

function skillFileName(skill) {
  const name = cleanName(skill?.name) || slugify(skill?.title) || "eeg-skill";
  return `${name}.md`;
}

export function createSkillsManager({ onChange, onMessage } = {}) {
  let availableSkills = [];
  let enabledSkillNames = new Set();
  let savedHadSkillSettings = false;
  let editingName = "";
  let pendingDeleteName = "";
  let pendingDeleteTimer = null;

  function manifests() {
    return availableSkills.map((skill) => ({
      name: skill.name,
      title: skill.title,
      description: skill.description,
      version: skill.version,
      category: skill.category,
      source: skill.source,
      editable: Boolean(skill.editable),
      deletable: Boolean(skill.deletable),
      triggers: Array.isArray(skill.triggers) ? skill.triggers.slice(0, 12) : [],
      tags: Array.isArray(skill.tags) ? skill.tags.slice(0, 12) : [],
      enabled: enabledSkillNames.has(skill.name),
    }));
  }

  function enabledNames() {
    return availableSkills.filter((skill) => enabledSkillNames.has(skill.name)).map((skill) => skill.name);
  }

  function render(message = "") {
    const list = $("aiSkillList");
    if (!list) return;
    list.innerHTML = "";
    const query = String($("aiSkillSearch")?.value || "").trim().toLowerCase();
    const shown = availableSkills.filter((skill) => {
      if (!query) return true;
      const haystack = [
        skill.name, skill.title, skill.description, skill.category, skill.source,
        ...(skill.triggers || []), ...(skill.tags || []),
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "ai-skill-empty";
      empty.textContent = message || (availableSkills.length ? "No skills match this filter." : "No EEG skills available. Create a local skill to get started.");
      list.appendChild(empty);
      return;
    }
    for (const skill of shown) {
      const row = document.createElement("div");
      row.className = "ai-skill-row";
      row.dataset.source = skill.source || "user";
      row.classList.toggle("enabled", enabledSkillNames.has(skill.name));

      const toggle = document.createElement("label");
      toggle.className = "ai-skill-toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.skillName = skill.name;
      input.checked = enabledSkillNames.has(skill.name);
      toggle.append(input, document.createElement("span"));

      const main = document.createElement("div");
      main.className = "ai-skill-main";
      const title = document.createElement("div");
      title.className = "ai-skill-title";
      const strong = document.createElement("b");
      strong.textContent = skill.title || skill.name;
      const source = document.createElement("span");
      source.textContent = skill.source || "user";
      title.append(strong, source);
      const desc = document.createElement("p");
      desc.textContent = skill.description || "Local EEG prior context.";
      const tags = document.createElement("div");
      tags.className = "ai-skill-tags";
      for (const chip of [...(skill.triggers || []), ...(skill.tags || [])].slice(0, 8)) {
        const el = document.createElement("span");
        el.textContent = chip;
        tags.appendChild(el);
      }
      const actions = document.createElement("div");
      actions.className = "ai-skill-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.dataset.action = skill.editable ? "edit" : "copy";
      edit.dataset.name = skill.name;
      edit.textContent = skill.editable ? "Edit" : "Copy";
      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.dataset.action = "export";
      exportBtn.dataset.name = skill.name;
      exportBtn.textContent = "Export";
      actions.append(edit, exportBtn);
      if (skill.deletable) {
        const del = document.createElement("button");
        del.type = "button";
        const confirming = pendingDeleteName === skill.name;
        del.dataset.action = confirming ? "confirm-delete" : "delete";
        del.dataset.name = skill.name;
        del.textContent = confirming ? "Confirm" : "Delete";
        del.classList.toggle("danger", confirming);
        actions.appendChild(del);
      }
      main.append(title, desc, tags, actions);
      row.append(toggle, main);
      list.appendChild(row);
    }
  }

  async function load() {
    render("Loading EEG skills...");
    try {
      const payload = await listAgentSkills();
      availableSkills = (Array.isArray(payload.skills) ? payload.skills : [])
        .filter((skill) => cleanName(skill?.name))
        .map((skill) => ({ ...skill, name: cleanName(skill.name) }));
      if (!savedHadSkillSettings) {
        for (const skill of availableSkills) {
          if (skill.defaultEnabled) enabledSkillNames.add(skill.name);
        }
      }
      const known = new Set(availableSkills.map((skill) => skill.name));
      enabledSkillNames = new Set([...enabledSkillNames].filter((name) => known.has(name)));
      render();
      onChange?.();
    } catch (error) {
      availableSkills = [];
      render(error.message || "Could not load EEG skills.");
    }
  }

  function openEditor(skill = {}, options = {}) {
    editingName = options.copy ? "" : cleanName(skill.name);
    setText($("aiSkillDialogTitle"), editingName ? "Edit skill" : "New skill");
    setText($("aiSkillEditorMsg"), "");
    fillForm(skill, options);
    $("aiSkillDialog")?.showModal();
    setTimeout(() => (editingName ? $("aiSkillTitle") : $("aiSkillName"))?.focus(), 20);
  }

  async function editSkill(name, { copy = false } = {}) {
    try {
      const skill = await readAgentSkill(name);
      openEditor(skill, { copy });
    } catch (error) {
      onMessage?.(error.message || "Could not read skill.");
    }
  }

  async function exportSkill(name) {
    try {
      const skill = await readAgentSkill(name);
      downloadText(skillToDocument(skill), skillFileName(skill));
    } catch (error) {
      onMessage?.(error.message || "Could not export skill.");
    }
  }

  async function removeSkill(name) {
    const skill = availableSkills.find((item) => item.name === name);
    if (!skill?.deletable) return;
    try {
      await deleteAgentSkill(name);
      enabledSkillNames.delete(name);
      pendingDeleteName = "";
      clearTimeout(pendingDeleteTimer);
      await load();
      onMessage?.("Skill deleted");
    } catch (error) {
      onMessage?.(error.message || "Could not delete skill.");
    }
  }

  function requestDelete(name) {
    pendingDeleteName = name;
    clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = setTimeout(() => {
      if (pendingDeleteName === name) {
        pendingDeleteName = "";
        render();
      }
    }, 5000);
    render();
  }

  async function saveEditor(event) {
    event?.preventDefault();
    const payload = formPayload();
    if (!payload.name || !payload.markdown) {
      setText($("aiSkillEditorMsg"), "Name and Markdown are required.");
      return;
    }
    try {
      const saved = editingName
        ? await updateAgentSkill(editingName, payload)
        : await createAgentSkill(payload);
      enabledSkillNames.add(saved.name);
      $("aiSkillDialog")?.close();
      await load();
      onMessage?.("Skill saved");
    } catch (error) {
      setText($("aiSkillEditorMsg"), error.message || "Could not save skill.");
    }
  }

  function exportDraft() {
    const payload = formPayload();
    downloadText(skillToDocument(payload), skillFileName(payload));
  }

  function hydrate(savedEnabled = [], hadSaved = false) {
    savedHadSkillSettings = Boolean(hadSaved);
    enabledSkillNames = new Set((Array.isArray(savedEnabled) ? savedEnabled : []).map(cleanName).filter(Boolean));
  }

  function bind() {
    $("aiNewSkillBtn")?.addEventListener("click", () => openEditor({
      category: "workflow",
      version: "1.0",
      markdown: "# New EEG Skill\n\nUse this skill when...\n",
    }));
    $("aiSkillSearch")?.addEventListener("input", () => render());
    $("aiSkillList")?.addEventListener("change", (event) => {
      const input = event.target.closest("input[data-skill-name]");
      if (!input) return;
      const name = cleanName(input.dataset.skillName);
      if (!name) return;
      if (input.checked) enabledSkillNames.add(name);
      else enabledSkillNames.delete(name);
      render();
      onChange?.();
    });
    $("aiSkillList")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action][data-name]");
      if (!button) return;
      const { action, name } = button.dataset;
      if (action === "edit") editSkill(name);
      else if (action === "copy") editSkill(name, { copy: true });
      else if (action === "export") exportSkill(name);
      else if (action === "delete") requestDelete(name);
      else if (action === "confirm-delete") removeSkill(name);
    });
    $("aiSkillForm")?.addEventListener("submit", saveEditor);
    $("aiSkillCancelBtn")?.addEventListener("click", () => $("aiSkillDialog")?.close());
    $("aiSkillExportDraftBtn")?.addEventListener("click", exportDraft);
    $("aiSkillTitle")?.addEventListener("input", () => {
      const name = $("aiSkillName");
      if (name && !name.value.trim() && !$("aiSkillName").disabled) name.value = slugify($("aiSkillTitle").value);
    });
  }

  bind();

  return {
    hydrate,
    load,
    render,
    getAvailable: () => availableSkills.slice(),
    getEnabledNames: enabledNames,
    getManifest: manifests,
  };
}
