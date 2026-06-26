import { AI_STORAGE_KEY, DEFAULT_AI_BASE_URL } from "./prompt.js";

export const AI_SETTINGS_KEY = `${AI_STORAGE_KEY}.settings.v2`;
export const AI_SECRET_KEY = `${AI_STORAGE_KEY}.secret.v2`;

function readJSON(storage, key, fallback = {}) {
  try { return JSON.parse(storage.getItem(key) || "null") || fallback; }
  catch { return fallback; }
}

function writeJSON(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); }
  catch { /* storage can be unavailable or full */ }
}

function migrateLegacySession() {
  const legacy = readJSON(sessionStorage, AI_STORAGE_KEY, null);
  if (!legacy || typeof legacy !== "object") return {};
  const { apiKey = "", ...publicSettings } = legacy;
  if (apiKey && !readJSON(sessionStorage, AI_SECRET_KEY, {}).apiKey) {
    writeJSON(sessionStorage, AI_SECRET_KEY, { apiKey });
  }
  try { sessionStorage.removeItem(AI_STORAGE_KEY); } catch { /* ignore */ }
  return publicSettings;
}

export function loadAgentSettings() {
  const legacyPublic = migrateLegacySession();
  const savedPublic = readJSON(localStorage, AI_SETTINGS_KEY, {});
  const secret = readJSON(sessionStorage, AI_SECRET_KEY, {});
  return {
    ...legacyPublic,
    ...savedPublic,
    baseUrl: savedPublic.baseUrl ?? legacyPublic.baseUrl ?? DEFAULT_AI_BASE_URL,
    apiKey: secret.apiKey || "",
  };
}

export function saveAgentSettings(settings = {}) {
  const { apiKey = "", ...publicSettings } = settings || {};
  writeJSON(localStorage, AI_SETTINGS_KEY, publicSettings);
  writeJSON(sessionStorage, AI_SECRET_KEY, { apiKey });
}
