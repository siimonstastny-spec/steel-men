// Steel Men – multiplayer transport for the static web (GitHub Pages / itch.io): WebRTC data channels between the
// players, signalling over public Nostr relays (Trystero 0.26.0, vendor/trystero/, docs/notes/p2p-transport.md).
// Same interface as RoomTransport (docs/MULTIPLAYER.md, "Transport"):
//   const t = await P2PTransport.create()  // null = no WebRTC / no crypto.subtle / library failed to load
//   t.kind 'p2p', t.selfId, await t.join(name, { password }?) -> channel (rejects with a P2PError when no relay answers)
//   t.onPasswordError(fn) -> unsubscribe  [LOBBY_LIST]; t.joinFailureKey() after a lobby join found no host
//   channel: selfId, send(topic, data), on(topic, fn({from, data})) -> unsubscribe, peers() -> [{id, presence, isMe}],
//            onPeers(fn({peers, joined, left, updated})) -> unsubscribe, setPresence(obj), connected(), leave()
// Facts the adapter relies on:
//   - Trystero has no presence: our own presence is a Trystero action sent on every setPresence and to every newly
//     connected peer. Data channels are reliable and ordered, so the last presence received is the current one.
//   - Trystero never echoes our own messages; a peer joins (onPeerJoin) only once its data channel is up.
//   - one Trystero action per topic; a message bigger than NET.maxMessageBytes is refused (same limit as the room).
//   - relay sockets are module-wide in Trystero and stay open (reconnecting) for the life of the page; leave()
//     closes our room, its peer connections and listeners.
import { NET, LOBBY } from '../../config.js';
import { P2PSignalWatch } from './P2PSignalWatch.js'; // [LOBBY_LIST]
import { t } from '../../i18n/i18n.js';

const LIB_DIR = new URL('../../../vendor/trystero/', import.meta.url).href; // + NET.p2p.strategy + '.mjs'
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,31}$/; // Trystero action types are ≤ 32 bytes
const PRESENCE_ACTION = '_pres';             // cannot collide with a topic (topics start with a letter)

/** UTF-8 byte length of a string without allocating (surrogate pairs = 4 bytes) */
function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** i18n keys of P2P errors (err.i18nKey); err.message is already translated with t() (cs.js / en.js) */
export const P2P_ERROR = Object.freeze({
  relays: 'net.p2p.error.relays',     // no signalling relay reachable within NET.p2p.relayTimeoutMs
  join: 'net.p2p.error.join',         // Trystero refused the room (bad config / internal error)
  closed: 'net.p2p.error.closed',     // the transport was disposed while joining
  hostNotFound: 'net.p2p.error.hostNotFound', // relays work, but nobody answered in this room (wrong code / host gone)
  nat: 'net.p2p.error.nat',           // a peer was found but the direct connection failed (strict NAT / firewall)
  password: 'net.p2p.error.password', // [LOBBY_LIST] a peer's offer / answer did not decrypt: other room password
});

// [LOBBY_LIST] Trystero reports a password mismatch through onJoinError ("incorrect room password when decrypting
// offer|answer", handshake "incorrect password for overlapping room"); the room topic does not depend on the password.
// A side WITHOUT a password runs no Trystero check, so it only saw "handshake timed out" (QA: NAT message after 30 s).
// Hence our own peer handshake (lockHandshake, runs after Trystero's password check on both sides): it recognises the
// other side's password challenge / response and fails at once with HANDSHAKE_PASSWORD_ERROR. The silent case (the
// host cannot decrypt our offer) is caught by P2PSignalWatch.
const PASSWORD_ERROR_RE = /password/i; // QA 2: a plain handshake timeout (slow network) is NOT a password signal
const HANDSHAKE_MARK = 'sm1';             // our handshake messages carry sm: HANDSHAKE_MARK
const HANDSHAKE_PASSWORD_ERROR = 'the other side uses a room password';

/**
 * Peer handshake of Steel Men (Trystero onPeerHandshake; with a password it runs after Trystero's check). The
 * initiator's hello is shaped like Trystero's password challenge: a passworded responder answers it with its
 * password response, so a side without a password learns at once that the room has one; a passworded initiator's
 * challenge (no mark) tells a responder without password the same. Both builds must run it (old builds: timeout).
 */
function lockHandshake(hasPassword) {
  const check = (data) => {
    if (data && typeof data === 'object' && data.sm === HANDSHAKE_MARK) return;
    if (!hasPassword && data && typeof data === 'object' && typeof data.__trystero_pw === 'string') throw new Error(HANDSHAKE_PASSWORD_ERROR);
    throw new Error('unexpected peer handshake');
  };
  return async (peerId, send, receive, isInitiator) => {
    if (isInitiator) {
      await send({ __trystero_pw: 'challenge', c: HANDSHAKE_MARK, sm: HANDSHAKE_MARK });
      check((await receive())?.data);
    } else {
      check((await receive())?.data);
      await send({ sm: HANDSHAKE_MARK });
    }
  };
}

export class P2PError extends Error {
  constructor(key, detail) {
    super(t(key));
    this.name = 'P2PError';
    this.i18nKey = key;
    this.detail = detail ?? '';
  }
}

const freezePeer = (p) => Object.freeze({ ...p, presence: Object.freeze({ ...p.presence }) });
const swallow = (promise, what) => { Promise.resolve(promise).catch((e) => console.warn(`[net] p2p ${what} failed`, e?.message ?? e)); };

/** ICE servers: configured STUN + optional TURN (NET.p2p.turnServers entries {urls, username, credential}) */
function iceServers() {
  const cfg = NET.p2p;
  const list = cfg.stunUrls.map((urls) => ({ urls }));
  for (const s of cfg.turnServers) if (s && s.urls) list.push({ ...s });
  return list;
}

function trysteroConfig(password) {
  const cfg = NET.p2p;
  const relayConfig = { redundancy: cfg.relayRedundancy, warnOnRelayFailure: cfg.warnOnRelayFailure };
  if (cfg.relayUrls.length) relayConfig.urls = [...cfg.relayUrls];
  const config = { appId: cfg.appId, relayConfig };
  if (password) config.password = password; // [LOBBY_LIST] encrypts the SDP + challenge handshake; no peer connects without it
  const ice = iceServers();
  if (ice.length) config.rtcConfig = { iceServers: ice }; // empty = Trystero's default public STUN list
  return config;
}

/** Resolves true as soon as one signalling relay socket is open, false after timeoutMs (or when `isCancelled`) */
function waitForRelay(lib, timeoutMs, isCancelled) {
  const anyOpen = () => {
    try {
      const sockets = lib.getRelaySockets();
      for (const key in sockets) if (sockets[key]?.readyState === 1) return true;
    } catch { /* not initialised yet */ }
    return false;
  };
  if (anyOpen()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (isCancelled()) { clearInterval(timer); resolve(false); return; }
      if (anyOpen()) { clearInterval(timer); resolve(true); return; }
      if (Date.now() - started >= timeoutMs) { clearInterval(timer); resolve(false); }
    }, NET.p2p.relayPollMs);
  });
}

class P2PChannel {
  constructor(transport, name, room, lib) {
    this.transport = transport;
    this.name = name;
    this.room = room;
    this.lib = lib;
    this.handlers = new Map();   // topic -> Set(fn)
    this.actions = new Map();    // topic -> Trystero action
    this.peerHandlers = new Set();
    this.presence = {};
    this.selfUpdatedAt = Date.now();
    this.remote = new Map();     // peerId -> { presence, updatedAt }
    this.closed = false;
    this.outbox = [];            // {topic, data, at}: sends made while no peer was connected

    this.presenceAction = room.makeAction(PRESENCE_ACTION);
    this.presenceAction.onMessage = (payload, meta) => this.#receivePresence(meta?.peerId, payload);
    for (const topic of NET.p2p.topics) this.#action(topic); // receivers exist before the first message arrives
    room.onPeerLeave = (id) => this.#peerLeft(id);
    room.onPeerJoin = (id) => this.#peerJoined(id); // the setter replays peers already connected
  }

  get selfId() { return this.transport.selfId; }

  // ---- channel interface ----

  /** Fire-and-forget to every connected peer (reliable data channel, but a peer may vanish meanwhile) */
  send(topic, data) {
    if (this.closed) return;
    if (!TOPIC_RE.test(topic)) { console.error('[net] bad topic', topic); return; }
    if (data === undefined) data = null;
    let bytes;
    try { bytes = utf8Length(JSON.stringify(data)); } catch (e) { console.error('[net] p2p message not serialisable', topic, e); return; }
    if (bytes > NET.maxMessageBytes) { console.error('[net] p2p message too big', topic, bytes); return; }
    // nobody connected yet: hold a lobby message (the joiner's `hello`) until a peer joins; other topics are pointless without peers
    if (this.remote.size === 0) { if (topic === 'lobby') this.#queue(topic, data); return; }
    swallow(this.#action(topic).send(data), `send ${topic}`);
  }

  /** Keeps a message sent before the first data channel opened (e.g. a joiner's first `hello`); flushed in #peerJoined */
  #queue(topic, data) {
    const now = Date.now();
    const q = this.outbox;
    while (q.length && now - q[0].at > NET.p2p.outboxTtlMs) q.shift();
    if (q.length >= NET.p2p.outboxMax) q.shift();
    q.push({ topic, data, at: now });
  }

  #flushOutbox(target) {
    if (!this.outbox.length) return;
    const now = Date.now();
    const q = this.outbox.splice(0);
    for (const m of q) {
      if (now - m.at > NET.p2p.outboxTtlMs) continue;
      swallow(this.#action(m.topic).send(m.data, { target }), `flush ${m.topic}`);
    }
  }

  on(topic, fn) {
    if (!TOPIC_RE.test(topic)) { console.error('[net] bad topic', topic); return () => {}; }
    this.#action(topic); // make sure the receiver exists before the first message
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    const set = this.handlers.get(topic);
    const wrapped = (m) => fn(m);
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  peers() {
    const list = [freezePeer({ id: this.selfId, presence: this.presence, isMe: true, updatedAt: this.selfUpdatedAt })];
    for (const [id, p] of this.remote) list.push(freezePeer({ id, presence: p.presence, isMe: false, updatedAt: p.updatedAt }));
    return list;
  }

  onPeers(fn) {
    this.peerHandlers.add(fn);
    // like the room: the first delivery presents the room so far as joined (on a microtask)
    queueMicrotask(() => {
      if (!this.closed && this.peerHandlers.has(fn)) {
        const all = this.peers();
        try { fn({ peers: all, joined: all, left: [], updated: [] }); } catch (err) { console.error('[net] peers handler failed', err); }
      }
    });
    return () => this.peerHandlers.delete(fn);
  }

  /** Merges keys into our presence (null deletes a key) and tells every peer */
  setPresence(obj) {
    if (this.closed) return Promise.resolve();
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null) delete this.presence[k];
      else this.presence[k] = v;
    }
    this.selfUpdatedAt = Date.now();
    this.#sendPresence();
    this.#emitPeers([], [], [this.peers()[0]]);
    return Promise.resolve();
  }

  /** true while a signalling relay is reachable or at least one peer is connected */
  connected() {
    if (this.closed) return false;
    if (this.remote.size > 0) return true;
    try {
      const sockets = this.lib.getRelaySockets();
      for (const key in sockets) if (sockets[key]?.readyState === 1) return true;
    } catch { /* gone */ }
    return false;
  }

  /** [LOBBY_LIST] The host's lobby state arrived: no password mismatch to watch for any more (Lobby.join) */
  stopPasswordWatch() {
    this.signalWatch?.dispose();
    this.signalWatch = null;
  }

  leave() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.stopPasswordWatch(); // [LOBBY_LIST]
    try {
      this.room.onPeerJoin = null;
      this.room.onPeerLeave = null;
      this.presenceAction.onMessage = null;
      for (const action of this.actions.values()) action.onMessage = null;
    } catch { /* room already torn down */ }
    this.outbox.length = 0;
    this.handlers.clear();
    this.actions.clear();
    this.peerHandlers.clear();
    this.remote.clear();
    this.transport.rooms.delete(this.name);
    return Promise.resolve(this.room.leave()).catch((e) => console.warn('[net] p2p leave failed', e?.message ?? e));
  }

  // ---- internals ----

  #action(topic) {
    let action = this.actions.get(topic);
    if (!action) {
      action = this.room.makeAction(topic);
      action.onMessage = (payload, meta) => this.#receive(topic, meta?.peerId, payload);
      this.actions.set(topic, action);
    }
    return action;
  }

  #receive(topic, from, data) {
    if (this.closed || typeof from !== 'string' || from === this.selfId) return;
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const fn of [...set]) { try { fn({ from, data }); } catch (err) { console.error('[net] handler failed', err); } }
  }

  /** Wire format {p: presence, ask?: 1}; `ask` = "send me yours" (repairs a presence that arrived too early) */
  #sendPresence(target, ask = false) {
    if (this.closed || (!target && this.remote.size === 0)) return;
    const msg = ask ? { p: this.presence, ask: 1 } : { p: this.presence };
    swallow(this.presenceAction.send(msg, target ? { target } : undefined), 'presence');
  }

  #peerJoined(id) {
    if (this.closed || typeof id !== 'string' || id === this.selfId) return;
    this.#sendPresence(id, true); // a newcomer gets our presence at once (the room hands presence to newcomers)
    this.#flushOutbox(id);
    if (this.remote.has(id)) return;
    const p = { presence: {}, updatedAt: Date.now() };
    this.remote.set(id, p);
    this.#emitPeers([freezePeer({ id, presence: p.presence, isMe: false, updatedAt: p.updatedAt })], [], []);
  }

  #peerLeft(id) {
    if (this.closed) return;
    const p = this.remote.get(id);
    if (!p) return;
    this.remote.delete(id);
    this.#emitPeers([], [freezePeer({ id, presence: p.presence, isMe: false, updatedAt: p.updatedAt })], []);
  }

  #receivePresence(id, msg) {
    if (this.closed || typeof id !== 'string' || id === this.selfId) return;
    if (msg?.ask) this.#sendPresence(id);
    const presence = msg?.p;
    const clean = presence && typeof presence === 'object' && !Array.isArray(presence) ? presence : {};
    let p = this.remote.get(id);
    const joined = !p;
    if (joined) { p = { presence: {}, updatedAt: 0 }; this.remote.set(id, p); }
    if (!joined && JSON.stringify(clean) === JSON.stringify(p.presence)) return;
    p.presence = clean;
    p.updatedAt = Date.now();
    const peer = freezePeer({ id, presence: p.presence, isMe: false, updatedAt: p.updatedAt });
    if (joined) this.#emitPeers([peer], [], []);
    else this.#emitPeers([], [], [peer]);
  }

  #emitPeers(joined, left, updated) {
    const change = { peers: this.peers(), joined, left, updated };
    for (const fn of [...this.peerHandlers]) { try { fn(change); } catch (err) { console.error('[net] peers handler failed', err); } }
  }
}

export class P2PTransport {
  /** false when this browser cannot do WebRTC + WebSocket + WebCrypto (crypto.subtle needs https or localhost) */
  static available() {
    return typeof globalThis.RTCPeerConnection === 'function' && typeof globalThis.WebSocket === 'function'
      && !!globalThis.crypto?.subtle && typeof globalThis.TextEncoder === 'function';
  }

  /** Loads Trystero on demand (the artifact never pays for it); resolves null when P2P is impossible here */
  static async create() {
    P2PTransport.lastError = '';
    if (!P2PTransport.available()) { P2PTransport.lastError = 'unsupported (WebRTC / WebSocket / crypto.subtle)'; return null; }
    let lib;
    try { lib = await import(`${LIB_DIR}${NET.p2p.strategy}.mjs`); } catch (e) { console.warn('[net] p2p library failed to load', e?.message ?? e); P2PTransport.lastError = `import: ${e?.message ?? e}`; return null; }
    if (typeof lib?.joinRoom !== 'function' || typeof lib.selfId !== 'string') { P2PTransport.lastError = 'bad library'; return null; }
    return new P2PTransport(lib);
  }

  /** Why the last create() returned null (diagnostics), '' when it did not */
  static lastError = '';

  constructor(lib) {
    this.kind = 'p2p';
    this.lib = lib;
    this.selfId = lib.selfId;              // Trystero's id of this page (one per tab)
    this.rooms = new Map();                // name -> P2PChannel
    this.pending = new Map();              // name -> Promise<P2PChannel> (join in progress)
    this.joinTimeoutMs = NET.p2p.lobbyJoinTimeoutMs; // hint for the lobby: peer discovery is slower than the room
    this.disposed = false;
    this.peerErrors = 0;                   // peers that were found but could not connect (see joinFailureKey)
    this.passwordErrors = 0;               // [LOBBY_LIST] peers whose offer / answer used another password
    this.passwordListeners = new Set();    // [LOBBY_LIST] onPasswordError subscribers
  }

  /** [LOBBY_LIST] fn() on every password mismatch with some peer of a room being joined; returns unsubscribe */
  onPasswordError(fn) {
    this.passwordListeners.add(fn);
    return () => this.passwordListeners.delete(fn);
  }

  #joinError(e) {
    const text = String(e?.error ?? e ?? '');
    if (PASSWORD_ERROR_RE.test(text)) {
      this.passwordErrors++;
      for (const fn of [...this.passwordListeners]) { try { fn(); } catch (err) { console.error('[net] password listener failed', err); } }
    } else this.peerErrors++;
    console.warn('[net] p2p peer could not connect', e?.peerId ?? '', text);
  }

  /**
   * i18n key explaining why a lobby join found no host (Lobby.join asks after its timeout): no relay open → relays,
   * a peer failed to connect → nat, else the host simply is not there
   */
  joinFailureKey() {
    const sockets = (() => { try { return this.lib.getRelaySockets(); } catch { return {}; } })();
    let open = false;
    for (const key in sockets) if (sockets[key]?.readyState === 1) open = true;
    if (!open) return P2P_ERROR.relays;
    if (this.passwordErrors > 0) return P2P_ERROR.password; // [LOBBY_LIST]
    return this.peerErrors > 0 ? P2P_ERROR.nat : P2P_ERROR.hostNotFound;
  }
  /**
   * Joins the named game room; rejects with a P2PError (err.i18nKey) when no relay answers in time.
   * [LOBBY_LIST] opts.password ('' / missing = none, cut to LOBBY.passwordMaxLength): Trystero room password; peers
   * with another password never connect (onPasswordError fires instead). A name already joined returns that channel.
   * opts.watchPassword (Lobby.join): also detect a mismatch Trystero reports only to the other side (P2PSignalWatch).
   */
  join(name, opts = {}) {
    if (this.rooms.has(name)) return Promise.resolve(this.rooms.get(name));
    if (this.pending.has(name)) return this.pending.get(name);
    const password = typeof opts?.password === 'string' ? opts.password.slice(0, LOBBY.passwordMaxLength) : '';
    const promise = this.#join(name, password, !!opts?.watchPassword).finally(() => this.pending.delete(name));
    this.pending.set(name, promise);
    return promise;
  }

  /** Leaves every room (relay sockets stay with Trystero for the life of the page) */
  dispose() {
    this.disposed = true;
    this.peerErrors = 0;
    this.passwordErrors = 0;
    this.passwordListeners.clear();
    const all = [...this.rooms.values()].map((ch) => ch.leave());
    return Promise.all(all).then(() => {});
  }

  async #join(name, password, watchPassword) {
    if (this.disposed) throw new P2PError(P2P_ERROR.closed);
    this.peerErrors = 0; // a stale connection error of an earlier attempt must not explain this one
    this.passwordErrors = 0;
    let room;
    try {
      room = this.lib.joinRoom(trysteroConfig(password), name, {
        handshakeTimeoutMs: NET.p2p.handshakeTimeoutMs,
        onPeerHandshake: lockHandshake(!!password), // [LOBBY_LIST] fast password mismatch on both sides
        onJoinError: (e) => this.#joinError(e),
      });
    } catch (e) {
      throw new P2PError(P2P_ERROR.join, e?.message ?? String(e));
    }
    // the channel registers its actions at once: a peer may connect while we still wait for the relay check
    const ch = new P2PChannel(this, name, room, this.lib);
    if (watchPassword) { // [LOBBY_LIST] disposed by itself (SDP exchanged / timeout), ch.stopPasswordWatch() or ch.leave()
      ch.signalWatch = new P2PSignalWatch(this.lib, name, {
        isConnected: () => ch.closed,
        onSuspect: (peerId) => this.#joinError({ peerId, error: 'peer never answered our offer: other room password' }),
      });
    }
    const ok = await waitForRelay(this.lib, NET.p2p.relayTimeoutMs, () => this.disposed || ch.closed);
    if (!ok || this.disposed || ch.closed) {
      await ch.leave();
      throw new P2PError(ok ? P2P_ERROR.closed : P2P_ERROR.relays);
    }
    this.rooms.set(name, ch);
    return ch;
  }
}
