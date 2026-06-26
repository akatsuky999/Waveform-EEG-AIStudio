function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

export async function listAgentSkills(signal) {
  return requestJSON("/api/ai/skills", { signal });
}

export async function readAgentSkill(name, signal) {
  const payload = await requestJSON(`/api/ai/skills/${encodeURIComponent(name)}`, { signal });
  return payload.skill;
}

export async function createAgentSkill(skill) {
  const payload = await requestJSON("/api/ai/skills", {
    method: "POST",
    body: JSON.stringify(normalizeSkillPayload(skill)),
  });
  return payload.skill;
}

export async function updateAgentSkill(name, skill) {
  const payload = await requestJSON(`/api/ai/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(normalizeSkillPayload({ ...skill, name })),
  });
  return payload.skill;
}

export async function deleteAgentSkill(name) {
  return requestJSON(`/api/ai/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function normalizeSkillPayload(skill = {}) {
  return {
    name: String(skill.name || "").trim(),
    title: String(skill.title || "").trim(),
    description: String(skill.description || "").trim(),
    version: String(skill.version || "1.0").trim(),
    category: String(skill.category || "workflow").trim(),
    defaultEnabled: Boolean(skill.defaultEnabled),
    triggers: splitList(skill.triggers),
    tags: splitList(skill.tags),
    allowedTools: splitList(skill.allowedTools),
    markdown: String(skill.markdown || "").trim(),
  };
}

export function skillToDocument(skill = {}) {
  if (skill.sourceText) return skill.sourceText;
  const payload = normalizeSkillPayload(skill);
  const list = (items) => items.length ? `\n${items.map((item) => `  - ${item}`).join("\n")}` : " []";
  return [
    "---",
    `name: ${payload.name}`,
    `title: ${payload.title || payload.name}`,
    `description: ${payload.description}`,
    `version: ${payload.version || "1.0"}`,
    `category: ${payload.category || "workflow"}`,
    `default_enabled: ${payload.defaultEnabled ? "true" : "false"}`,
    `triggers:${list(payload.triggers)}`,
    `tags:${list(payload.tags)}`,
    `allowed_tools:${list(payload.allowedTools)}`,
    "---",
    "",
    payload.markdown || `# ${payload.title || payload.name}`,
    "",
  ].join("\n");
}
