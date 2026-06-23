// conversations.js — multi-conversation store for EEG-Master. Each conversation
// keeps two parallel records:
//   • transcript — the model message array (user/assistant/tool), giving the
//     model full context across questions (so it never re-runs the same tools);
//   • log        — display items the UI replays to rebuild the timeline.
//
// Storage is split so every conversation can keep its full images (needed for a
// faithful export) without blowing the tiny localStorage quota:
//   • a lightweight metadata INDEX (id/title/timestamps/count) lives in
//     localStorage for instant, synchronous startup and history listing;
//   • the FULL conversations (transcript + log, images intact) live in
//     IndexedDB, which has a large quota.
// Only `getConversation` is async (it reads the full record from IndexedDB);
// writes update the index synchronously and write through to IndexedDB in the
// background. The transcript's images are still stripped on save (the model
// context stays lean and the compaction logic in agent.js handles live images),
// but the display `log` keeps full images so replays and exports show them.

const INDEX_KEY = "waveform.eegMaster.index.v1";
const LEGACY_KEY = "waveform.eegMaster.conversations.v1"; // old all-in-localStorage store
const DB_NAME = "waveform-eeg-master";
const DB_VERSION = 1;
const STORE = "conversations";
const MAX_CONVERSATIONS = 40;
const MAX_TRANSCRIPT_MESSAGES = 100;

const uid = () => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ---- IndexedDB helpers (tiny, no library) -------------------------------
let _dbPromise = null;
const fallbackBodies = new Map(); // used when IndexedDB is unavailable (tests/private mode)

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function idbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function rememberFallback(record) {
  fallbackBodies.set(record.id, structuredCloneSafe(record));
  while (fallbackBodies.size > MAX_CONVERSATIONS) {
    fallbackBodies.delete(fallbackBodies.keys().next().value);
  }
}

async function idbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- metadata index (localStorage, synchronous) -------------------------
function emptyIndex() { return { activeId: null, order: [], items: {} }; }

function readIndex() {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return emptyIndex();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.items) return emptyIndex();
    return { activeId: parsed.activeId || null, order: parsed.order || [], items: parsed.items || {} };
  } catch { return emptyIndex(); }
}

function writeIndex(index) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch { /* ignore quota */ }
}

function metaOf(conv) {
  return {
    id: conv.id,
    title: conv.title || "New conversation",
    createdAt: conv.createdAt || Date.now(),
    updatedAt: Date.now(),
    messages: (conv.log || []).length,
  };
}

// Strip base64 image payloads from the *transcript* only, so the saved model
// context stays small and the next provider request stays valid (a fake
// image_url would be rejected). The display `log` keeps its full images.
function stripTranscriptImages(transcript) {
  return (transcript || []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part?.type === "image_url"
          ? { type: "text", text: "[image omitted from saved transcript]" }
          : part),
    };
  });
}

// ---- public API ---------------------------------------------------------
export function createConversation() {
  return { id: uid(), title: "New conversation", createdAt: Date.now(), updatedAt: Date.now(), transcript: [], log: [] };
}

export function listConversations() {
  const index = readIndex();
  return index.order
    .map((id) => index.items[id])
    .filter(Boolean)
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: c.messages || 0 }));
}

export function getActiveId() { return readIndex().activeId; }

export function setActiveId(id) {
  const index = readIndex();
  index.activeId = id;
  writeIndex(index);
}

// Async: the full record (transcript + log, with images) lives in IndexedDB.
export async function getConversation(id) {
  if (!id) return null;
  let full = null;
  try { full = await idbGet(id); } catch { full = null; }
  if (!full && fallbackBodies.has(id)) full = fallbackBodies.get(id);
  if (!full) {
    // Index knows about it but the body is missing (e.g. private-mode IDB): give
    // back a usable shell so the UI doesn't break.
    const meta = readIndex().items[id];
    return meta ? { ...createConversation(), id: meta.id, title: meta.title, createdAt: meta.createdAt } : null;
  }
  return structuredCloneSafe(full);
}

export function saveConversation(conv, { activate = true } = {}) {
  if (!conv || !conv.id) return;
  const index = readIndex();
  const meta = metaOf(conv);
  index.items[conv.id] = meta;
  index.order = [conv.id, ...index.order.filter((x) => x !== conv.id)];
  while (index.order.length > MAX_CONVERSATIONS) {
    const dropped = index.order.pop();
    delete index.items[dropped];
    idbDelete(dropped).catch(() => {});
  }
  if (activate) index.activeId = conv.id;
  writeIndex(index);

  // Write through the full body (full images in the log; lean transcript) to
  // IndexedDB. Fire-and-forget: callers stay synchronous.
  const full = {
    id: conv.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    transcript: stripTranscriptImages((conv.transcript || []).slice(-MAX_TRANSCRIPT_MESSAGES)),
    log: conv.log || [],
  };
  rememberFallback(full);
  idbPut(full).catch(() => {});
}

export function deleteConversation(id) {
  const index = readIndex();
  delete index.items[id];
  index.order = index.order.filter((x) => x !== id);
  if (index.activeId === id) index.activeId = index.order[0] || null;
  writeIndex(index);
  fallbackBodies.delete(id);
  idbDelete(id).catch(() => {});
  return index.activeId;
}

export function renameConversation(id, title) {
  const clean = (title || "").slice(0, 80) || "Untitled";
  const index = readIndex();
  if (index.items[id]) {
    index.items[id].title = clean;
    index.items[id].updatedAt = Date.now();
    writeIndex(index);
  }
  // Keep the IndexedDB body's title in sync (best-effort).
  idbGet(id).then((full) => {
    if (full) { full.title = clean; full.updatedAt = Date.now(); idbPut(full).catch(() => {}); }
  }).catch(() => {});
}

// One-time setup: open the DB and migrate any legacy all-in-localStorage store
// into IndexedDB + the metadata index, then drop the legacy key.
export async function initConversations() {
  try { await openDB(); } catch { /* IDB unavailable (private mode): index-only fallback */ }
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw);
    if (legacy && typeof legacy === "object" && legacy.items) {
      const index = { activeId: legacy.activeId || null, order: legacy.order || [], items: {} };
      for (const id of index.order) {
        const c = legacy.items[id];
        if (!c) continue;
        index.items[id] = {
          id, title: c.title || "New conversation",
          createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now(),
          messages: (c.log || []).length,
        };
        await idbPut({
          id, title: c.title || "New conversation",
          createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now(),
          transcript: c.transcript || [], log: c.log || [],
        }).catch(() => {});
      }
      writeIndex(index);
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* migration is best-effort; never block startup */ }
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
