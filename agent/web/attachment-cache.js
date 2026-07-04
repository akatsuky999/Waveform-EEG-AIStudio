// Persistent companion-file cache for EEG-Master.
//
// The backend attachment store is intentionally an in-memory scratch cache. This
// module keeps the durable copy in the browser, scoped to a conversation, so a
// backend reload can rebuild the scratch cache without asking the user to upload
// the same small label/metadata file again.

const DB_NAME = "waveform-eeg-master-attachments";
const DB_VERSION = 1;
const STORE = "attachments";

export const ATTACHMENT_FILE_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_FILES_PER_CONVERSATION = 16;
const MAX_BYTES_PER_CONVERSATION = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

let _dbPromise = null;
const fallback = new Map();

function keyOf(conversationId, id) {
  return `${conversationId || ""}::${id || ""}`;
}

function cloneSafe(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("conversationId", "conversationId", { unique: false });
        store.createIndex("lastUsedAt", "lastUsedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Attachment cache upgrade is blocked by another tab."));
  });
  return _dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    try {
      const value = fn(store, tx, done, fail);
      if (value !== undefined) done(value);
    } catch (error) {
      fail(error);
    }
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
    tx.oncomplete = () => {
      if (!settled) done(undefined);
    };
  });
}

function rememberFallback(record) {
  fallback.set(record.key, cloneSafe(record));
}

function forgetFallback(conversationId, id) {
  fallback.delete(keyOf(conversationId, id));
}

function summaryOf(record) {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    ext: record.ext,
    sizeBytes: record.sizeBytes,
    lineCount: record.lineCount,
    truncated: !!record.truncated,
    preview: record.preview || null,
    source: record.source || "attach",
    sent: !!record.sent,
    persisted: true,
    lastUsedAt: record.lastUsedAt || record.createdAt || Date.now(),
  };
}

function allFallbackRecords() {
  return [...fallback.values()].map(cloneSafe);
}

async function allRecords() {
  try {
    return await withStore("readonly", (store, _tx, done, fail) => {
      const request = store.getAll();
      request.onsuccess = () => done(request.result || []);
      request.onerror = () => fail(request.error);
    });
  } catch {
    return allFallbackRecords();
  }
}

async function putRecord(record) {
  rememberFallback(record);
  try {
    await withStore("readwrite", (store) => { store.put(record); });
  } catch {
    // Fallback memory is enough for private-mode sessions.
  }
}

async function deleteKey(key) {
  fallback.delete(key);
  try {
    await withStore("readwrite", (store) => { store.delete(key); });
  } catch {
    // Best effort.
  }
}

async function pruneWithRecords(records, liveConversationIds = null) {
  const live = liveConversationIds ? new Set(liveConversationIds) : null;
  const toDelete = new Set();

  for (const record of records) {
    if (live && !live.has(record.conversationId)) toDelete.add(record.key);
  }

  const kept = records.filter((record) => !toDelete.has(record.key));
  const byConversation = new Map();
  for (const record of kept) {
    const list = byConversation.get(record.conversationId) || [];
    list.push(record);
    byConversation.set(record.conversationId, list);
  }

  for (const list of byConversation.values()) {
    list.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    let bytes = list.reduce((sum, record) => sum + (record.sizeBytes || 0), 0);
    while (list.length > MAX_FILES_PER_CONVERSATION || bytes > MAX_BYTES_PER_CONVERSATION) {
      const removed = list.shift();
      if (!removed) break;
      toDelete.add(removed.key);
      bytes -= removed.sizeBytes || 0;
    }
  }

  const remaining = kept.filter((record) => !toDelete.has(record.key))
    .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  let total = remaining.reduce((sum, record) => sum + (record.sizeBytes || 0), 0);
  while (total > MAX_TOTAL_BYTES && remaining.length) {
    const removed = remaining.shift();
    toDelete.add(removed.key);
    total -= removed.sizeBytes || 0;
  }

  await Promise.all([...toDelete].map(deleteKey));
  return toDelete.size;
}

export async function savePersistentAttachment(conversationId, summary, text, { sent = false } = {}) {
  const id = String(summary?.id || "").trim();
  const convId = String(conversationId || "").trim();
  if (!convId || !id) throw new Error("conversationId and attachment id are required.");
  const body = typeof text === "string" ? text : String(text || "");
  const sizeBytes = body.length ? new Blob([body]).size : (summary?.sizeBytes || 0);
  if (sizeBytes > ATTACHMENT_FILE_LIMIT_BYTES) {
    throw new Error("File is larger than the 4 MB persistent attachment limit.");
  }
  const now = Date.now();
  const record = {
    key: keyOf(convId, id),
    conversationId: convId,
    id,
    name: summary.name || "attachment.txt",
    kind: summary.kind || null,
    ext: summary.ext || "",
    sizeBytes,
    lineCount: summary.lineCount || null,
    truncated: !!summary.truncated,
    preview: summary.preview || null,
    source: summary.source || "attach",
    text: body,
    sent: !!sent,
    createdAt: now,
    lastUsedAt: now,
  };
  await putRecord(record);
  await prunePersistentAttachments();
  return summaryOf(record);
}

export async function listPersistentAttachments(conversationId) {
  const convId = String(conversationId || "").trim();
  if (!convId) return [];
  const records = await allRecords();
  return records
    .filter((record) => record.conversationId === convId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(summaryOf);
}

export async function getPersistentAttachment(conversationId, id) {
  const key = keyOf(String(conversationId || "").trim(), String(id || "").trim());
  let record = null;
  try {
    record = await withStore("readonly", (store, _tx, done, fail) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result || null);
      request.onerror = () => fail(request.error);
    });
  } catch {
    record = fallback.get(key) || null;
  }
  if (!record) return null;
  const updated = { ...record, lastUsedAt: Date.now() };
  await putRecord(updated);
  return cloneSafe(updated);
}

export async function markPersistentAttachmentsSent(conversationId, ids) {
  const wanted = new Set(Array.from(ids || []).map((id) => String(id || "").trim()).filter(Boolean));
  if (!wanted.size) return;
  const records = await allRecords();
  await Promise.all(records
    .filter((record) => record.conversationId === conversationId && wanted.has(record.id))
    .map((record) => putRecord({ ...record, sent: true, lastUsedAt: Date.now() })));
}

export async function removePersistentAttachment(conversationId, id) {
  forgetFallback(conversationId, id);
  await deleteKey(keyOf(conversationId, id));
}

export async function removePersistentConversation(conversationId) {
  const convId = String(conversationId || "").trim();
  if (!convId) return;
  const records = await allRecords();
  await Promise.all(records
    .filter((record) => record.conversationId === convId)
    .map((record) => deleteKey(record.key)));
}

export async function prunePersistentAttachments(liveConversationIds = null) {
  const records = await allRecords();
  return pruneWithRecords(records, liveConversationIds);
}
