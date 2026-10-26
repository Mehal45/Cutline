// Things worth keeping between sessions (waveforms, library thumbnails), so opening a project doesn't have to
// read big recordings again. Stored in the app's own IndexedDB; any failure just means "not cached".
let opening = null;

function open() {
  opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("cutline-cache", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return opening;
}

export async function cacheGet(key) {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const q = db.transaction("kv").objectStore("kv").get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => resolve(undefined);
    });
  } catch { return undefined; }
}

export async function cacheSet(key, value) {
  try {
    const db = await open();
    db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
  } catch { /* not cached, that's fine */ }
}

/** A key for a media file that changes when the file does (its path or name, and its size). */
export const mediaKey = (media) => `${media.path || media.name}|${media.file?.size ?? media.size ?? ""}`;
