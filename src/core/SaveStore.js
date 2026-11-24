// Steel Men – saved games storage [J1]: IndexedDB list + .smsave files (docs/notes/j1-save-core.md).
// A save is a plain object built by src/game/SaveGame.js ({ format, formatVersion, meta, settings, liveTeams,
// commands, pending, checkpoints, end }). IndexedDB keeps { id, meta, data } with data = gzip(JSON of the save);
// a .smsave file is the same gzip JSON. Without IndexedDB only files work (list / put / get throw code 'storage').
//   await list() → [{ id, meta }]      await put(save, { slot? }) → id      await get(id) → save | null
//   await remove(id)                    exportFile(save)                     await importFile(file) → save
//   isCompatible(meta) → { ok, reason?: 'simVersion' | 'data' | 'corrupt' }  (after list/get/importFile/ensureFingerprint)
import { SAVE, SIM_VERSION, MAP } from '../config.js';
import { mapFile } from '../game/Map.js';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const GZIP_MAGIC = [0x1f, 0x8b];
const HEX = 16;
const HASH_DIGITS = 8;

const storeError = (message, code) => Object.assign(new Error(message), { code });

// ---------- fingerprint of the simulation data ----------

function fnvHex(text) {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME);
  h = Math.imul(h ^ text.length, FNV_PRIME);
  return (h >>> 0).toString(HEX).padStart(HASH_DIGITS, '0');
}

// Canonical text of a JSON file (whitespace / formatting do not count); a missing file counts as its status
async function canonical(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return `!${res.status}`;
    return JSON.stringify(await res.json());
  } catch (err) {
    console.warn('[SaveStore] fingerprint', url, err);
    return '!unreadable';
  }
}

let dataHashPromise = null;
const dataHash = { value: null };
const mapHashes = new Map(); // map id -> hex (filled by ensureFingerprint)
const mapPromises = new Map();

function ensureDataHash() {
  dataHashPromise ??= Promise.all(SAVE.fingerprintFiles.map(canonical))
    .then((texts) => { dataHash.value = fnvHex(texts.join('\n')); return dataHash.value; });
  return dataHashPromise;
}

function ensureMapHash(mapId) {
  if (mapId == null) return Promise.resolve(null);
  if (!mapPromises.has(mapId)) {
    mapPromises.set(mapId, canonical(`${MAP.path}${mapFile(mapId)}.json`).then((text) => {
      const hex = fnvHex(text);
      mapHashes.set(mapId, hex);
      return hex;
    }));
  }
  return mapPromises.get(mapId);
}

/**
 * Loads (once) what isCompatible needs: the data hash and the hashes of these maps.
 * @param {string[]} [mapIds]
 */
export async function ensureFingerprint(mapIds = []) {
  await Promise.all([ensureDataHash(), ...mapIds.map(ensureMapHash)]);
}

/** Fingerprint of the current data for a match on `mapId`: '<data hash>-<map hash>' */
export async function currentFingerprint(mapId) {
  const [data, map] = await Promise.all([ensureDataHash(), ensureMapHash(mapId)]);
  return `${data}-${map}`;
}

/** Fingerprint already computed for `mapId` (null when ensureFingerprint has not run for it yet) */
function cachedFingerprint(mapId) {
  const map = mapHashes.get(mapId);
  return dataHash.value && map ? `${dataHash.value}-${map}` : null;
}

/** Does the meta have the shape SaveGame writes? */
function metaLooksValid(meta) {
  return Boolean(meta) && typeof meta === 'object' && typeof meta.map === 'string' && Number.isFinite(meta.durationTicks)
    && meta.simVersion != null && typeof meta.fingerprint === 'string';
}

/**
 * Can this save be loaded by this build? Only SIM_VERSION and the data fingerprint count (never GAME_VERSION).
 * Call after list() / get() / importFile() / ensureFingerprint([meta.map]) – before that the data is 'data' (unknown).
 * @returns {{ ok: boolean, reason?: 'simVersion' | 'data' | 'corrupt' }}
 */
export function isCompatible(meta) {
  if (!metaLooksValid(meta)) return { ok: false, reason: 'corrupt' };
  if (meta.simVersion !== SIM_VERSION) return { ok: false, reason: 'simVersion' };
  const now = cachedFingerprint(meta.map);
  if (!now || now !== meta.fingerprint) return { ok: false, reason: 'data' };
  return { ok: true };
}

/** Does the object look like a complete save (meta + record)? */
function saveLooksValid(save) {
  return Boolean(save) && save.format === SAVE.format && Number.isInteger(save.formatVersion) && metaLooksValid(save.meta)
    && save.settings && typeof save.settings === 'object' && Array.isArray(save.commands) && Array.isArray(save.checkpoints)
    && save.end && Number.isFinite(save.end.tick);
}

// ---------- compression ----------

async function streamBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** JSON text → bytes (gzip when the browser has CompressionStream, else plain UTF-8) */
async function pack(save) {
  const bytes = new TextEncoder().encode(JSON.stringify(save));
  if (typeof CompressionStream !== 'function') return bytes;
  return streamBytes(bytes, new CompressionStream('gzip'));
}

/** bytes (gzip or plain JSON) → object; throws code 'corrupt' */
async function unpack(buffer) {
  try {
    let bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
      if (typeof DecompressionStream !== 'function') throw new Error('gzip not supported by this browser');
      bytes = await streamBytes(bytes, new DecompressionStream('gzip'));
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw Object.assign(storeError(`save data unreadable: ${err?.message ?? err}`, 'corrupt'), { cause: err });
  }
}

// ---------- IndexedDB ----------

let dbPromise = null;

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(storeError('IndexedDB not available', 'storage'));
  dbPromise ??= new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(SAVE.dbName, SAVE.dbVersion); } catch (err) { reject(storeError(err?.message ?? 'IndexedDB blocked', 'storage')); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVE.dbStore)) db.createObjectStore(SAVE.dbStore, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(storeError(req.error?.message ?? 'IndexedDB open failed', 'storage'));
    req.onblocked = () => reject(storeError('IndexedDB blocked', 'storage'));
  }).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SAVE.dbStore, mode);
    const req = fn(tx.objectStore(SAVE.dbStore));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(storeError(tx.error?.message ?? 'IndexedDB error', 'storage'));
    tx.onabort = () => reject(storeError(tx.error?.message ?? 'IndexedDB aborted', 'storage'));
  });
}

/** Is IndexedDB usable here (claude.ai iframe, private window…)? */
export async function isAvailable() {
  try { await openDb(); return true; } catch { return false; }
}

let idCounter = 0;
const ID_RADIX = 36;
const newId = () => `s${Date.now().toString(ID_RADIX)}${(idCounter++).toString(ID_RADIX)}`;

/**
 * Saved games, autosave first, then newest first. Also loads the fingerprints isCompatible needs.
 * @returns {Promise<{id: string, meta: object}[]>}
 */
export async function list() {
  const items = [];
  // cursor: only id + meta are kept (the gzip data of every save is not collected)
  await withStore('readonly', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const { id, meta } = cursor.value;
      if (id !== SAVE.restoreSlot) items.push({ id, meta: meta ?? null });
      cursor.continue();
    };
    return null;
  });
  await ensureFingerprint([...new Set(items.map((i) => i.meta?.map).filter((m) => typeof m === 'string'))]);
  const time = (m) => { const v = new Date(m?.date ?? 0).getTime(); return Number.isNaN(v) ? 0 : v; };
  items.sort((a, b) => (b.id === SAVE.autoSlot) - (a.id === SAVE.autoSlot) || time(b.meta) - time(a.meta));
  return items;
}

/**
 * Stores a save. `slot: 'auto'` overwrites the single autosave; without a slot a new id is created every time.
 * @returns {Promise<string>} id
 */
export async function put(save, { slot = null } = {}) {
  if (!saveLooksValid(save)) throw storeError('not a save', 'corrupt');
  const id = slot === SAVE.autoSlot ? SAVE.autoSlot : slot === SAVE.restoreSlot ? SAVE.restoreSlot : newId();
  const meta = { ...save.meta, slot: id === SAVE.autoSlot ? SAVE.autoSlot : null, auto: id === SAVE.autoSlot };
  const data = await pack({ ...save, meta });
  await withStore('readwrite', (s) => s.put({ id, meta, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }));
  return id;
}

/** @returns {Promise<object|null>} the save (with meta.id), null when there is none; throws code 'corrupt' */
export async function get(id) {
  const row = await withStore('readonly', (s) => s.get(id));
  if (!row) return null;
  const save = await unpack(row.data);
  if (!saveLooksValid(save)) throw storeError('save data incomplete', 'corrupt');
  save.meta = { ...save.meta, ...row.meta, id };
  await ensureFingerprint([save.meta.map]);
  return save;
}

export async function remove(id) {
  await withStore('readwrite', (s) => s.delete(id));
}

// ---------- files ----------

const safeName = (name) => String(name ?? 'save').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, SAVE.fileNameMax) || 'save';

/** Downloads the save as <name>.smsave (works without IndexedDB) */
export async function exportFile(save) {
  if (!saveLooksValid(save)) throw storeError('not a save', 'corrupt');
  const { id, slot, auto, ...meta } = save.meta; // store-local fields stay out of the file
  const bytes = await pack({ ...save, meta });
  const url = URL.createObjectURL(new Blob([bytes], { type: SAVE.fileMime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(save.meta.name)}${SAVE.fileExtension}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), SAVE.revokeUrlMs);
}

/** Reads a .smsave file (File / Blob) → save; throws code 'corrupt' when it is not one */
export async function importFile(file) {
  const save = await unpack(await file.arrayBuffer());
  if (!saveLooksValid(save)) throw storeError('not a save file', 'corrupt');
  const { id, slot, auto, ...meta } = save.meta;
  save.meta = meta;
  await ensureFingerprint([meta.map]);
  return save;
}

// ---------- restore after a page reload (a match cannot be torn down in place) ----------

/** Keeps `save` for the next page load (hidden record + sessionStorage flag); main.js then reloads */
export async function scheduleRestore(save) {
  await put(save, { slot: SAVE.restoreSlot });
  sessionStorage.setItem(SAVE.restoreFlagKey, '1');
}

/** After a reload: the save kept by scheduleRestore (removed from storage), or null */
export async function takeScheduledRestore() {
  let flagged = false;
  try { flagged = sessionStorage.getItem(SAVE.restoreFlagKey) === '1'; sessionStorage.removeItem(SAVE.restoreFlagKey); } catch { /* no storage */ }
  if (!flagged) return null;
  try {
    const save = await get(SAVE.restoreSlot);
    await remove(SAVE.restoreSlot);
    if (save) { const { id, slot, auto, ...meta } = save.meta; save.meta = meta; }
    return save;
  } catch (err) {
    console.error('[SaveStore] scheduled restore', err);
    return null;
  }
}

/** The whole store as one object (main.js: new SaveLoadView({ store: saveStore, … })) */
export const saveStore = {
  list, put, get, remove, exportFile, importFile, isCompatible, isAvailable, ensureFingerprint, currentFingerprint,
  scheduleRestore, takeScheduledRestore,
};
