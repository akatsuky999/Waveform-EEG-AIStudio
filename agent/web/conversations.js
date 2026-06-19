// conversations.js — multi-conversation store for EEG-Master, persisted to
// localStorage (Cursor/Claude-Code-style history). Each conversation keeps two
// parallel records:
//   • transcript — the model message array (user/assistant/tool), giving the
//     model full context across questions (so it never re-runs the same tools);
//   • log        — display items the UI replays to rebuild the timeline.
// Large image data-URLs are stripped before storage to keep localStorage small.

const KEY = "waveform.eegMaster.conversations.v1";
const MAX_CONVERSATIONS = 40;
const MAX_TRANSCRIPT_MESSAGES = 100;

const uid = () => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function emptyStore() { return { activeId: null, order: [], items: {} }; }

function readStore() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.items) return emptyStore();
    return { activeId: parsed.activeId || null, order: parsed.order || [], items: parsed.items || {} };
  } catch { return emptyStore(); }
}

function writeStore(store) {
  try { localStorage.setItem(KEY, JSON.stringify(store)); }
  catch {
    // Over quota — drop the oldest conversations and retry once.
    while (store.order.length > 5) { const id = store.order.pop(); delete store.items[id]; }
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* give up silently */ }
  }
}

// Replace base64 image payloads with a tiny placeholder so storage stays small.
// Multimodal transcript parts must remain valid chat content after restoration:
// an image_url object with a fake URL would make the next provider request fail.
function stripImages(value) {
  if (Array.isArray(value)) return value.map((item) => {
    const imageUrl = item?.type === "image_url" ? item.image_url?.url : null;
    if (typeof imageUrl === "string" &&
        (imageUrl.startsWith("data:image/") || imageUrl.startsWith("[image omitted"))) {
      return { type: "text", text: "[Image omitted from saved history]" };
    }
    return stripImages(item);
  });
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && v.startsWith("data:image/")) out[k] = "[image omitted from history]";
      else out[k] = stripImages(v);
    }
    return out;
  }
  return value;
}

export function createConversation() {
  return { id: uid(), title: "New conversation", createdAt: Date.now(), updatedAt: Date.now(), transcript: [], log: [] };
}

export function listConversations() {
  const store = readStore();
  return store.order
    .map((id) => store.items[id])
    .filter(Boolean)
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: (c.log || []).length }));
}

export function getActiveId() { return readStore().activeId; }

export function setActiveId(id) {
  const store = readStore();
  store.activeId = id;
  writeStore(store);
}

export function getConversation(id) {
  const c = readStore().items[id];
  // stripImages also migrates the invalid image_url placeholders written by
  // early builds, so old saved chats recover without manual storage cleanup.
  return c ? structuredCloneSafe(stripImages(c)) : null;
}

export function saveConversation(conv, { activate = true } = {}) {
  if (!conv || !conv.id) return;
  const store = readStore();
  const trimmed = {
    id: conv.id,
    title: conv.title || "New conversation",
    createdAt: conv.createdAt || Date.now(),
    updatedAt: Date.now(),
    transcript: stripImages((conv.transcript || []).slice(-MAX_TRANSCRIPT_MESSAGES)),
    log: stripImages(conv.log || []),
  };
  store.items[conv.id] = trimmed;
  store.order = [conv.id, ...store.order.filter((x) => x !== conv.id)];
  while (store.order.length > MAX_CONVERSATIONS) { const id = store.order.pop(); delete store.items[id]; }
  if (activate) store.activeId = conv.id;
  writeStore(store);
}

export function deleteConversation(id) {
  const store = readStore();
  delete store.items[id];
  store.order = store.order.filter((x) => x !== id);
  if (store.activeId === id) store.activeId = store.order[0] || null;
  writeStore(store);
  return store.activeId;
}

export function renameConversation(id, title) {
  const store = readStore();
  if (store.items[id]) { store.items[id].title = title.slice(0, 80) || "Untitled"; store.items[id].updatedAt = Date.now(); }
  writeStore(store);
}

// Derive a short title from the first user message.
export function titleFromText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 42 ? t.slice(0, 42) + "…" : (t || "New conversation");
}

function structuredCloneSafe(obj) {
  try { return structuredClone(obj); }
  catch { return JSON.parse(JSON.stringify(obj)); }
}
