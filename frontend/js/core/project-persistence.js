// Persist a File System Access directory handle. FileList fallbacks cannot be
// restored after refresh, so only native handles are written here.

const DB_NAME = "waveform-projects";
const STORE = "handles";
const KEY = "last-project";

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function saveDirectoryHandle(handle) {
  try { await withStore("readwrite", (store) => store.put(handle, KEY)); }
  catch { /* handle persistence is best-effort */ }
}

export async function loadDirectoryHandle() {
  try { return await withStore("readonly", (store) => store.get(KEY)); }
  catch { return null; }
}

export async function clearDirectoryHandle() {
  try { await withStore("readwrite", (store) => store.delete(KEY)); }
  catch { /* best-effort */ }
}
