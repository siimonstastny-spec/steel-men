// Steel Men – serverless list of open multiplayer games (docs/roadmap/17-lobby-list.md, docs/notes/lobby-list.md).
// Uses the same public Nostr relays as the P2P transport, but its OWN WebSockets: Trystero opens relay sockets only
// inside joinRoom (a list viewer joins no room) and owns their onmessage; its exports createEvent / subscribe only
// build the signed wire strings, which we send ourselves. Events are ephemeral (kind 20000–29999: relays forward,
// never store), subscribed with `since: now()`. No WebRTC, no simulation state: UI-side only (Date.now is fine here).
//
//   const dir = await LobbyDirectory.create()        // viewer; null = no WebSocket / crypto / library
//   dir.onChange(fn(entries)) -> unsubscribe;  dir.entries() -> [{ key, code, name, host, map, n, max, lock, build,
//                                                                 compatible, full, seenAt }] (sorted, frozen)
//   dir.state()  'connecting' | 'open' | 'offline';  dir.dispose()
//   const ann = await LobbyAnnouncer.create(getInfo) // host of a public game; getInfo() -> { code, name, host, map, n, max, lock }
//   ann.update()  (info changed: re-announce, rate limited);  await ann.close()  ('closed' + stop);  ann.dispose()
//
// Wire (event content, JSON):  {t:'game', code, name, host, map, n, max, lock, build} | {t:'closed', code} | {t:'query'}
// A viewer sends 'query' when a relay opens; hosts answer with jitter and at most every replyMinIntervalMs. The
// password itself or any hash of it is never published (only `lock`).
import { NET, LOBBY, TEAMS, GAME_VERSION, PROFILE } from '../config.js';
import { cleanText } from './textClean.js';

const LIB_URL = new URL(`../../vendor/trystero/${NET.p2p.strategy}.mjs`, import.meta.url).href;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAP_RE = /^[A-Za-z0-9_.-]*$/;

/** Directory topic (Nostr `x` tag) – derived from the Trystero app id, so incompatible builds never meet */
export const directoryTopic = () => `${NET.p2p.appId}:${NET.directory.topicSuffix}`;

/** Directory works only where the P2P transport could (plain WebSocket + WebCrypto for signing) */
export const directoryAvailable = () => typeof globalThis.WebSocket === 'function' && !!globalThis.crypto?.subtle
  && typeof globalThis.TextEncoder === 'function';

let libPromise = null;
function loadLib() {
  libPromise ??= import(LIB_URL).then((lib) => {
    if (typeof lib?.createEvent !== 'function' || typeof lib.subscribe !== 'function') throw new Error('bad library');
    return lib;
  }).catch((e) => { libPromise = null; throw e; });
  return libPromise;
}

/** The P2P transport's relays (pinned list, else Trystero's default list), first NET.directory.relayCount */
function relayUrls(lib) {
  const list = NET.p2p.relayUrls.length ? NET.p2p.relayUrls : (Array.isArray(lib.defaultRelayUrls) ? lib.defaultRelayUrls : []);
  return list.slice(0, NET.directory.relayCount);
}

function randomId(len) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

const nowS = () => Math.floor(Date.now() / 1000);

/** Game code as Lobby makes it (NET.codeLength characters of NET.codeAlphabet) */
export function validDirectoryCode(code) {
  if (typeof code !== 'string' || code.length !== NET.codeLength) return false;
  for (const ch of code) if (!NET.codeAlphabet.includes(ch)) return false;
  return true;
}

const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= TEAMS.length;

/** Validated directory entry from untrusted content, or null */
export function parseGameEntry(c) {
  const d = NET.directory;
  if (!c || typeof c !== 'object' || c.t !== 'game') return null;
  if (!validDirectoryCode(c.code)) return null;
  if (typeof c.name !== 'string' || c.name.length > LOBBY.nameMaxLength) return null;
  if (typeof c.host !== 'string' || c.host.length > PROFILE.nicknameMaxLength) return null;
  if (typeof c.map !== 'string' || c.map.length > d.mapIdMaxLength || !MAP_RE.test(c.map)) return null;
  if (!isCount(c.n) || !isCount(c.max) || c.max < 1 || c.n > c.max) return null;
  if (typeof c.lock !== 'boolean') return null;
  if (typeof c.build !== 'string' || c.build.length > d.buildMaxLength) return null;
  const name = cleanText(c.name, LOBBY.nameMaxLength);
  if (!name) return null;
  return {
    code: c.code, name, host: cleanText(c.host, PROFILE.nicknameMaxLength), map: c.map, n: c.n, max: c.max, lock: c.lock,
    build: cleanText(c.build, d.buildMaxLength), compatible: c.build === GAME_VERSION, full: c.n >= c.max,
  };
}

/**
 * A few relay WebSockets with reconnect (backoff). onOpen(url) after every (re)connect, onEvent(event) for each
 * EVENT of our subscription, deduplicated by event id over all relays.
 */
class RelayPool {
  constructor(lib, { onOpen, onEvent }) {
    this.lib = lib;
    this.onOpen = onOpen;
    this.onEvent = onEvent;
    this.topic = directoryTopic();
    this.subId = randomId(NET.directory.subIdLength);
    this.relays = relayUrls(lib).map((url) => ({ url, socket: null, timer: null, backoff: NET.directory.reconnectMinMs }));
    this.seen = new Map(); // event id -> received at (dedup across relays)
    this.disposed = false;
    this.pubkey = null;    // ours, learned from the first event we sign
    for (const r of this.relays) this.#connect(r);
  }

  openCount() {
    let n = 0;
    for (const r of this.relays) if (r.socket?.readyState === 1) n++;
    return n;
  }

  /** Signs and sends content (object) to every open relay (or only to `onlyUrl`); resolves when sent */
  async publish(content, onlyUrl = null) {
    if (this.disposed) return;
    let wire;
    try { wire = await this.lib.createEvent(this.topic, JSON.stringify(content)); } catch (e) { console.warn('[lobbydir] sign failed', e?.message ?? e); return; }
    if (this.disposed) return;
    if (!this.pubkey) { try { this.pubkey = JSON.parse(wire)[1].pubkey; } catch { /* keep null */ } }
    for (const r of this.relays) {
      if (r.socket?.readyState !== 1 || (onlyUrl && r.url !== onlyUrl)) continue;
      try { r.socket.send(wire); } catch { /* closing */ }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.relays) {
      clearTimeout(r.timer);
      r.timer = null;
      const s = r.socket;
      r.socket = null;
      if (!s) continue;
      s.onopen = null; s.onmessage = null; s.onclose = null; s.onerror = null;
      try {
        if (s.readyState === 1) s.send(JSON.stringify(['CLOSE', this.subId]));
        s.close();
      } catch { /* already closed */ }
    }
    this.seen.clear();
  }

  #connect(r) {
    if (this.disposed) return;
    r.timer = null;
    let s;
    try { s = new WebSocket(r.url); } catch { this.#retry(r); return; }
    r.socket = s;
    s.onopen = () => {
      if (this.disposed) return;
      r.backoff = NET.directory.reconnectMinMs;
      try { s.send(this.lib.subscribe(this.subId, this.topic)); } catch { return; }
      this.onOpen?.(r.url);
    };
    s.onmessage = (e) => this.#receive(e.data);
    s.onerror = () => { /* onclose follows */ };
    s.onclose = () => {
      if (this.disposed || r.socket !== s) return;
      r.socket = null;
      this.#retry(r);
    };
  }

  #retry(r) {
    if (this.disposed) return;
    const d = NET.directory;
    const wait = r.backoff * (1 + Math.random() * d.reconnectJitter);
    r.backoff = Math.min(r.backoff * 2, d.reconnectMaxMs);
    r.timer = setTimeout(() => this.#connect(r), wait);
  }

  #receive(raw) {
    if (this.disposed || typeof raw !== 'string' || raw.length > NET.directory.maxFrameChars) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT' || msg[1] !== this.subId) return;
    const ev = msg[2];
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || !HEX64_RE.test(ev.id)) return;
    if (typeof ev.pubkey !== 'string' || !HEX64_RE.test(ev.pubkey) || ev.pubkey === this.pubkey) return;
    if (!Array.isArray(ev.tags) || !ev.tags.some((tag) => Array.isArray(tag) && tag[0] === 'x' && tag[1] === this.topic)) return;
    if (!Number.isInteger(ev.created_at) || Math.abs(nowS() - ev.created_at) > NET.directory.maxClockSkewS) return;
    if (typeof ev.content !== 'string' || ev.content.length > NET.directory.maxContentChars) return;
    if (this.seen.has(ev.id)) return;
    const now = Date.now();
    this.seen.set(ev.id, now);
    if (this.seen.size > NET.directory.seenMax) {
      for (const [id, at] of this.seen) { if (now - at > NET.directory.entryTtlMs || this.seen.size > NET.directory.seenMax) this.seen.delete(id); else break; }
    }
    let content;
    try { content = JSON.parse(ev.content); } catch { return; }
    if (!content || typeof content !== 'object' || Array.isArray(content)) return;
    this.onEvent?.({ pubkey: ev.pubkey, createdAt: ev.created_at, content });
  }
}

/** Viewer: live list of public games */
export class LobbyDirectory {
  static async create() {
    if (!directoryAvailable()) return null;
    try { return new LobbyDirectory(await loadLib()); } catch (e) { console.warn('[lobbydir] library failed', e?.message ?? e); return null; }
  }

  constructor(lib) {
    this.map = new Map();           // pubkey -> entry (one entry per sender)
    this.tombs = new Map();         // pubkey -> { code, createdAt, at } after a 'closed' (NET.directory.tombstoneMs)
    this.listeners = new Set();
    this.list = Object.freeze([]);
    this.sig = '[]';                // what the list shows (see #rebuild)
    this.lastState = 'connecting';
    this.disposed = false;
    this.startedAt = Date.now();
    this.pool = new RelayPool(lib, {
      onOpen: (url) => { this.pool.publish({ t: 'query' }, url); this.#emit(); }, // ask the hosts on this relay
      onEvent: (ev) => this.#onEvent(ev),
    });
    this.sweepTimer = setInterval(() => this.#sweep(), NET.directory.sweepMs);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  entries() { return this.list; }

  /** 'connecting' (no relay open yet), 'open', 'offline' (none open after NET.directory.offlineAfterMs) */
  state() {
    if (this.disposed) return 'offline';
    if (this.pool.openCount() > 0) return 'open';
    return Date.now() - this.startedAt > NET.directory.offlineAfterMs ? 'offline' : 'connecting';
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.pool.dispose();
    this.map.clear();
    this.tombs.clear();
    this.listeners.clear();
  }

  #onEvent({ pubkey, createdAt, content }) {
    if (this.disposed) return;
    const old = this.map.get(pubkey);
    if (old && createdAt < old.createdAt) return; // an older copy (relays deliver out of order)
    if (content.t === 'closed') {
      if (typeof content.code !== 'string' || !validDirectoryCode(content.code)) return;
      // tombstone: a delayed 'game' of this sender + code, not newer than the 'closed', must not bring the game back
      if (!this.tombs.has(pubkey) && this.tombs.size >= NET.directory.maxEntries) this.tombs.delete(this.tombs.keys().next().value);
      const prev = this.tombs.get(pubkey);
      const tombAt = prev && prev.code === content.code ? Math.max(prev.createdAt, createdAt) : createdAt; // an older copy must not shorten it
      this.tombs.set(pubkey, { code: content.code, createdAt: tombAt, at: Date.now() });
      if (old && content.code === old.code) { this.map.delete(pubkey); this.#rebuild(); }
      return;
    }
    const entry = parseGameEntry(content);
    if (!entry) return;
    const tomb = this.tombs.get(pubkey);
    if (tomb && tomb.code === entry.code && createdAt <= tomb.createdAt) return;
    if (!old && this.map.size >= NET.directory.maxEntries) this.#evictOldest();
    this.map.set(pubkey, { ...entry, key: pubkey.slice(0, NET.directory.keyChars), createdAt, seenAt: Date.now() });
    this.#rebuild();
  }

  /** Full directory: the entry refreshed longest ago makes room for a new one */
  #evictOldest() {
    let oldKey = null;
    let oldAt = Infinity;
    for (const [k, e] of this.map) if (e.seenAt < oldAt) { oldAt = e.seenAt; oldKey = k; }
    if (oldKey !== null) this.map.delete(oldKey);
  }

  #sweep() {
    const now = Date.now();
    let changed = false;
    for (const [k, e] of this.map) if (now - e.seenAt > NET.directory.entryTtlMs) { this.map.delete(k); changed = true; }
    for (const [k, tomb] of this.tombs) if (now - tomb.at > NET.directory.tombstoneMs) this.tombs.delete(k);
    if (changed) this.#rebuild();
    else if (this.state() !== this.lastState) this.#emit(); // connecting → open / offline; nothing else changed
  }

  #rebuild() {
    const rank = (e) => (e.compatible && !e.full ? 0 : 1);
    const list = [...this.map.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
    // only what the list shows: a mere refresh (seenAt / createdAt) must not redraw the list (a click would be lost)
    const sig = JSON.stringify(list.map((e) => [e.key, e.code, e.name, e.host, e.map, e.n, e.max, e.lock, e.build]));
    if (sig === this.sig) return;
    this.sig = sig;
    this.list = Object.freeze(list.map((e) => Object.freeze({ ...e })));
    this.#emit();
  }

  #emit() {
    this.lastState = this.state();
    for (const fn of [...this.listeners]) { try { fn(this.list); } catch (err) { console.error('[lobbydir] listener failed', err); } }
  }
}

/** Host of a public game: announces it until close() */
export class LobbyAnnouncer {
  /** @param {() => {code, name, host, map, n, max, lock}} getInfo */
  static async create(getInfo) {
    if (!directoryAvailable()) return null;
    try { return new LobbyAnnouncer(await loadLib(), getInfo); } catch (e) { console.warn('[lobbydir] library failed', e?.message ?? e); return null; }
  }

  constructor(lib, getInfo) {
    this.getInfo = getInfo;
    this.disposed = false;
    this.closing = false;
    this.lastSentAt = -Infinity;
    this.replyTimer = null;
    this.pool = new RelayPool(lib, {
      onOpen: () => this.#scheduleSend(0),
      onEvent: (ev) => { if (ev.content.t === 'query') this.#scheduleSend(Math.random() * NET.directory.replyJitterMs); },
    });
    this.announceTimer = setInterval(() => this.#send(), NET.directory.announceMs);
  }

  /** The game changed (players, name, map): re-announce soon (rate limited) */
  update() { this.#scheduleSend(0); }

  /** Tells the viewers the game is gone ('closed'), then stops */
  async close() {
    if (this.disposed || this.closing) return;
    this.closing = true;
    this.#stopTimers();
    const code = this.#info()?.code;
    if (code) await this.pool.publish({ t: 'closed', code });
    this.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.#stopTimers();
    this.pool.dispose();
    this.getInfo = null;
  }

  #stopTimers() {
    clearInterval(this.announceTimer);
    this.announceTimer = null;
    clearTimeout(this.replyTimer);
    this.replyTimer = null;
  }

  #info() {
    try { return this.getInfo?.() ?? null; } catch { return null; }
  }

  /** One send after `delay`, never closer than replyMinIntervalMs to the previous one; later calls coalesce */
  #scheduleSend(delay) {
    if (this.disposed || this.closing || this.replyTimer) return;
    const wait = Math.max(delay, this.lastSentAt + NET.directory.replyMinIntervalMs - Date.now());
    this.replyTimer = setTimeout(() => { this.replyTimer = null; this.#send(); }, Math.max(0, wait));
  }

  #send() {
    if (this.disposed || this.closing) return;
    const i = this.#info();
    if (!i) return;
    const d = NET.directory;
    const content = {
      t: 'game',
      code: String(i.code ?? ''),
      name: cleanText(i.name, LOBBY.nameMaxLength),
      host: cleanText(i.host, PROFILE.nicknameMaxLength),
      map: MAP_RE.test(String(i.map ?? '')) ? String(i.map ?? '').slice(0, d.mapIdMaxLength) : '',
      n: i.n, max: i.max, lock: !!i.lock, build: GAME_VERSION,
    };
    if (!parseGameEntry(content)) return; // we would refuse it ourselves: do not spam relays with it
    this.lastSentAt = Date.now();
    this.pool.publish(content);
  }
}
