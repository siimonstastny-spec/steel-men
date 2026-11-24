// Steel Men – multiplayer transport inside a claude.ai artifact: the `room` capability (runtime contract 0.2.96,
// room.d.ts). A thin adapter maps the room onto the transport interface of docs/MULTIPLAYER.md:
//   room.join(name) -> NamedRoom { emit, on, presence, peers, onPeers, connected, leave }
//   message { peer, isMe, sameTab, kind, data }  ->  { from: peer, data }
// Facts the adapter relies on (room.d.ts):
//   - emit resolves on hand-off, delivery is NOT promised; data ≤ 4 KiB; our own emits come back (sameTab) and
//     are filtered here; emit + presence share ~40 messages/s
//   - there is no "my id" getter: our peer label is the `peer` of the peers() entry with sameTab
//   - topics are admin-only unless the artifact opens them:
//     capabilities: { room: { topics: { lobby: 'interact', turn: 'interact', hash: 'interact', start: 'interact' } } }
//   - room names: ^[a-z0-9][a-z0-9_.-]{0,47}$ (Lobby builds them from NET.roomPrefix + lower-case code)
//   - the publishing agent can appear as a peer (kind 'agent'); it is hidden here
import { NET } from '../../config.js';

const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
const isPeople = (p) => p && p.kind !== 'agent';
const toPeer = (p) => ({ id: p.peer, presence: p.presence ?? {}, isMe: !!p.sameTab, guest: !!p.guest, updatedAt: p.updatedAt ?? 0 });
const swallow = (promise) => { Promise.resolve(promise).catch((e) => { if (e?.code !== 'upstream_error') console.warn('[net] room call failed', e?.code ?? e, e?.message ?? ''); }); };

/** Our own peer label from a room / named room snapshot, or null when the platform has not answered yet */
function selfFrom(peers) {
  for (const p of peers ?? []) if (p?.sameTab) return p.peer;
  return null;
}

/** Resolves our peer label as soon as `target.peers()` lists us (or null after timeoutMs) */
function waitForSelf(target, timeoutMs) {
  const now = selfFrom(safePeers(target));
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let unsub = () => {};
    const timer = setTimeout(() => { unsub(); resolve(selfFrom(safePeers(target))); }, timeoutMs);
    try {
      unsub = target.onPeers((change) => {
        const id = selfFrom(change?.peers);
        if (id) { clearTimeout(timer); queueMicrotask(() => unsub()); resolve(id); }
      }, () => { clearTimeout(timer); resolve(null); });
    } catch { clearTimeout(timer); resolve(null); }
  });
}

function safePeers(target) {
  try { return target.peers() ?? []; } catch { return []; }
}

class RoomChannel {
  constructor(transport, named) {
    this.transport = transport;
    this.room = named;
    this.name = named.name;
    this.unsubs = new Set();
    this.closed = false;
  }

  get selfId() { return this.transport.selfId; }

  /** Fire-and-forget: the message may be lost (room semantics). Returns nothing useful on purpose. */
  send(topic, data) {
    if (this.closed) return;
    if (!TOPIC_RE.test(topic)) { console.error('[net] bad topic', topic); return; }
    swallow(this.room.emit(topic, data));
  }

  on(topic, fn) {
    const unsub = this.room.on(topic, (msg) => {
      if (this.closed || !msg || msg.sameTab || !isPeople(msg)) return; // own echo / agent
      try { fn({ from: msg.peer, data: msg.data }); } catch (err) { console.error('[net] handler failed', err); }
    }, (e) => console.warn('[net] room listener ended', topic, e?.code));
    this.unsubs.add(unsub);
    return () => { unsub(); this.unsubs.delete(unsub); };
  }

  peers() {
    return safePeers(this.room).filter(isPeople).map(toPeer);
  }

  onPeers(fn) {
    const unsub = this.room.onPeers((change) => {
      if (this.closed) return;
      const own = selfFrom(change.peers);
      if (own && !this.transport.selfId) this.transport.selfId = own;
      const map = (list) => (list ?? []).filter(isPeople).map(toPeer);
      try { fn({ peers: map(change.peers), joined: map(change.joined), left: map(change.left), updated: map(change.updated) }); } catch (err) { console.error('[net] peers handler failed', err); }
    }, (e) => console.warn('[net] room peers listener ended', e?.code));
    this.unsubs.add(unsub);
    return () => { unsub(); this.unsubs.delete(unsub); };
  }

  setPresence(obj) {
    if (this.closed) return Promise.resolve();
    return this.room.presence(obj ?? {}).catch((e) => console.warn('[net] presence refused', e?.code, e?.message ?? ''));
  }

  connected() { try { return !!this.room.connected(); } catch { return false; } }

  leave() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const u of this.unsubs) { try { u(); } catch { /* gone */ } }
    this.unsubs.clear();
    this.transport.rooms.delete(this.name);
    return Promise.resolve(this.room.leave()).catch(() => {});
  }
}

/** i18n key (lobby.error.room.*) per room error code; unknown codes read as upstream_error / generic */
const ERROR_KEYS = {
  not_permitted: 'lobby.error.room.notPermitted',
  limit_reached: 'lobby.error.room.limit',
  not_granted: 'lobby.error.room.notGranted',
  revoked: 'lobby.error.room.notGranted',
  upstream_error: 'lobby.error.room.upstream',
  no_self_id: 'lobby.error.room.noSelf',
};

/** Error of join(): `code` = the room's error code (or 'no_self_id'), `i18nKey` = user-facing text key */
export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
    this.i18nKey = ERROR_KEYS[code] ?? 'lobby.error.room.generic';
  }
}

export class RoomTransport {
  /**
   * @param {object} room  namespace from `await claude.use('room')`
   * @param {string|null} selfId
   * @param {object} [diag]  diagnosis object (transports/index.js) kept up to date: connected, roomError
   */
  constructor(room, selfId, diag = {}) {
    this.kind = 'room';
    this.room = room;
    this.selfId = selfId; // may be null until a named room lists us (filled in by join)
    this.rooms = new Map();
    this.diag = diag;
    this.disposed = false;
    this.connUnsub = null;
    try {
      this.connUnsub = room.onConnection?.(
        (connected) => { this.diag.connected = !!connected; },
        (e) => { this.diag.connected = false; this.diag.roomError = String(e?.code ?? 'unknown'); }, // not_granted / revoked …
      ) ?? null;
    } catch { this.connUnsub = null; }
  }

  /**
   * Creates the transport, or resolves null when the room capability is unavailable (no `claude`, not granted,
   * no answer within NET.roomUseTimeoutMs). `diag.room` says why: 'none' | 'timeout' | 'error:<code>' | 'ok'.
   * The caller (transports/index.js) decides about a fallback.
   */
  static async probe(diag = {}) {
    diag.selfIdKnown = false;
    const use = globalThis.claude?.use;
    if (typeof use !== 'function') { diag.room = 'none'; return null; }
    let room = null;
    let timedOut = false;
    let timer = null;
    try {
      room = await Promise.race([
        Promise.resolve(use.call(globalThis.claude, 'room')),
        new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(null); }, NET.roomUseTimeoutMs); }),
      ]);
    } catch (e) {
      diag.room = `error:${e?.code ?? 'unknown'}`;
      return null;
    } finally { clearTimeout(timer); }
    if (!room || typeof room.join !== 'function') { diag.room = timedOut ? 'timeout' : 'none'; return null; }
    diag.room = 'ok';
    const selfId = await waitForSelf(room, NET.selfIdTimeoutMs);
    diag.selfIdKnown = !!selfId;
    return new RoomTransport(room, selfId, diag);
  }

  static create() { return RoomTransport.probe(); }

  /** Joins the named game room (opens it when empty); resolves the channel. Rejects with a RoomError.
   *  [LOBBY_LIST] `_opts.password` is accepted and ignored: the platform room has no password (organisation members only) */
  async join(name, _opts) { // eslint-disable-line no-unused-vars
    if (this.rooms.has(name)) return this.rooms.get(name);
    let named;
    try {
      named = await this.room.join(name);
    } catch (e) {
      throw new RoomError(String(e?.code ?? 'unknown'), `room.join failed: ${e?.code ?? e}`);
    }
    if (this.disposed) { try { await named.leave(); } catch { /* gone */ } throw new RoomError('disposed', 'room transport disposed'); }
    if (!this.selfId) this.selfId = await waitForSelf(named, NET.selfIdTimeoutMs);
    this.diag.selfIdKnown = !!this.selfId;
    if (!this.selfId) {
      try { await named.leave(); } catch { /* gone */ }
      throw new RoomError('no_self_id', 'room: own peer id unknown');
    }
    const ch = new RoomChannel(this, named);
    this.rooms.set(name, ch);
    return ch;
  }

  /** Platform's statement "this viewer was invited from outside the organization" (own peer entry): true/false, null = unknown */
  selfGuest() {
    const me = safePeers(this.room).find((p) => p?.sameTab);
    return me ? !!me.guest : null;
  }

  /** Drops the connection listener and leaves rooms still open (the lobby screen calls this when it is closed) */
  dispose() {
    this.disposed = true;
    try { this.connUnsub?.(); } catch { /* gone */ }
    this.connUnsub = null;
    for (const ch of [...this.rooms.values()]) ch.leave();
  }
}
