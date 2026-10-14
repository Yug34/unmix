/* The library: every separation this browser has done, kept in IndexedDB.
 *
 * Stems are stored as MP3 rather than PCM. Six float32 stems of a four-minute
 * song are half a gigabyte; the same six as 192 kbps MP3 are ~35 MB, which is
 * the difference between a history of three songs and a history of a hundred.
 * Decoding them back is the browser's native decoder and takes a second.
 *
 * One record per track:
 *   { id, name, source: {kind: 'upload'|'youtube', url?, videoId?},
 *     createdAt, duration, provider, elapsed, bytes, stems: {name: Blob} }
 */

const DB_NAME = 'split-library';
const DB_VERSION = 1;
const STORE = 'tracks';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error || new Error('could not open the library'));
    req.onblocked = () => reject(new Error('the library is open in another tab'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('library transaction failed'));
    t.onabort = () => reject(t.error || new Error('library transaction aborted'));
    const r = fn(store);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
  }));
}

export const library = {
  available: typeof indexedDB !== 'undefined',

  /** Newest first. Blobs come along but are lazy on every major engine, so
   *  listing is cheap. */
  async list() {
    const rows = await tx('readonly', (s) => s.index('createdAt').getAll());
    return (rows || []).reverse();
  },

  get(id) { return tx('readonly', (s) => s.get(id)); },

  put(record) { return tx('readwrite', (s) => s.put(record)); },

  remove(id) { return tx('readwrite', (s) => s.delete(id)); },

  clear() { return tx('readwrite', (s) => s.clear()); },

  /** {usage, quota} in bytes, when the browser will say. */
  async estimate() {
    try { return await navigator.storage.estimate(); } catch { return null; }
  },
};

export function newId() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** Decode a stored record back into {name: {left, right}} at `sampleRate`.
 *
 * Each stem is decoded separately; the lengths can differ by a frame because
 * MP3 pads to 1152 samples, so everything is trimmed to the shortest. The
 * encoder delay is identical across stems, which is what keeps them in sync. */
export async function decodeRecord(record, sampleRate, onProgress) {
  const names = Object.keys(record.stems);
  const ctx = new AudioContext({ sampleRate });
  const decoded = {};
  try {
    for (let i = 0; i < names.length; i++) {
      onProgress?.(names[i], i, names.length);
      const buf = await record.stems[names[i]].arrayBuffer();
      decoded[names[i]] = await ctx.decodeAudioData(buf);
    }
  } finally {
    ctx.close();
  }
  const length = Math.min(...names.map((n) => decoded[n].length));
  const stems = {};
  for (const n of names) {
    const b = decoded[n];
    stems[n] = {
      left: b.getChannelData(0).slice(0, length),
      right: (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice(0, length),
    };
  }
  return stems;
}

export function fmtBytes(n) {
  if (!n) return '0 MB';
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

export function fmtDuration(seconds) {
  if (!isFinite(seconds)) return '';
  const s = Math.floor(seconds % 60);
  return `${Math.floor(seconds / 60)}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const dayMs = 86400000;
  const days = Math.floor((now.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / dayMs);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}
