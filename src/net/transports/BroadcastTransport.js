// Steel Mans – local multiplayer transport: two (or more) tabs of one browser talk over a BroadcastChannel.
// Same interface as RoomTransport (docs/MULTIPLAYER.md, "Transport"), so lobby and lockstep can be tested on
// localhost without an artifact. Topic messages can be dropped / delayed / reordered on purpose
// (NET.debugDropRate, debugLatencyMs, debugJitterMs; URL ?netDrop=0.2&netLatency=150&netJitter=50 overrides),
// presence is reliable (heartbeat), like the room's presence.
import { NET } from '../../config.js';

/** Debug network conditions: config, overridden by URL parameters (handy for a 2-tab test without editing code) */
function debugConditions() {
  const out = { drop: NET.debugDropRate, latency: NET.debugLatencyMs, jitter: NET.debugJitterMs };
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    const num = (k) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
    out.drop = num('netDrop') ?? out.drop;
    out.latency = num('netLatency') ?? out.latency;
    out.jitter = num('netJitter') ?? out.jitter;
  } catch { /* no location: config values */ }
  return out;
}

function randomId() {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}

const freezePeer = (p) => Object.freeze({ ...p, presence: Object.freeze({ ...p.presence }) });

class BroadcastChannelRoom {
  constructor(transport, name) {
    this.transport = transport;
    this.name = name;
    this.selfId = transport.selfId;
    this.bc = new BroadcastChannel(NET.broadcastPrefix + name);
    this.handlers = new Map();        // topic -> Set(fn)
    this.peerHandlers = new Set();
    this.presence = {};
    this.remote = new Map();          // peerId -> { presence, updatedAt, lastSeen }
    this.closed = false;
    this.conditions = debugConditions();
    this.bc.onmessage = (e) => this.#receive(e.data);
    this.heartbeat = setInterval(() => this.#tick(), NET.broadcastHeartbeatMs);
    this.#post({ k: 'hello', presence: this.presence });
  }

  // ---- channel interface ----
  send(topic, data) {
    if (this.closed) return;
    const c = this.conditions;
    if (c.drop > 0 && Math.random() < c.drop) return; // simulated loss
    const delay = c.latency + (c.jitter > 0 ? Math.random() * c.jitter : 0);
    const msg = { k: 'msg', topic, data };
    if (delay > 0) setTimeout(() => this.#post(msg), delay);
    else this.#post(msg);
  }

  on(topic, fn) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    const set = this.handlers.get(topic);
    const wrapped = (m) => fn(m);
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  peers() {
    const list = [freezePeer({ id: this.selfId, presence: this.presence, isMe: true, updatedAt: Date.now() })];
    for (const [id, p] of this.remote) list.push(freezePeer({ id, presence: p.presence, isMe: false, updatedAt: p.updatedAt }));
    return list;
  }

  onPeers(fn) {
    this.peerHandlers.add(fn);
    // like the room: the first delivery presents the room so far as joined (on a microtask)
    queueMicrotask(() => { if (!this.closed && this.peerHandlers.has(fn)) fn({ peers: this.peers(), joined: this.peers(), left: [], updated: [] }); });
    return () => this.peerHandlers.delete(fn);
  }

  setPresence(obj) {
    if (this.closed) return Promise.resolve();
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null) delete this.presence[k];
      else this.presence[k] = v;
    }
    this.#post({ k: 'presence', presence: this.presence });
    this.#emitPeers([], [], [this.#selfPeer()]);
    return Promise.resolve();
  }

  leave() {
    if (this.closed) return Promise.resolve();
    this.#post({ k: 'bye' });
    this.closed = true;
    clearInterval(this.heartbeat);
    this.bc.close();
    this.handlers.clear();
    this.peerHandlers.clear();
    this.transport.rooms.delete(this.name);
    return Promise.resolve();
  }

  // ---- internals ----
  #selfPeer() { return this.peers()[0]; }

  #post(msg) {
    if (this.closed) return;
    try { this.bc.postMessage({ ...msg, from: this.selfId }); } catch (err) { console.warn('[net] broadcast send failed', err); }
  }

  #receive(msg) {
    if (this.closed || !msg || typeof msg.from !== 'string' || msg.from === this.selfId) return;
    const from = msg.from;
    const now = Date.now();
    if (msg.k === 'msg') {
      this.#touch(from, null, now);
      const set = this.handlers.get(msg.topic);
      if (set) for (const fn of [...set]) { try { fn({ from, data: msg.data }); } catch (err) { console.error('[net] handler failed', err); } }
      return;
    }
    if (msg.k === 'bye') {
      const p = this.remote.get(from);
      if (p) { this.remote.delete(from); this.#emitPeers([], [freezePeer({ id: from, presence: p.presence, isMe: false, updatedAt: p.updatedAt })], []); }
      return;
    }
    if (msg.k === 'hello' || msg.k === 'presence') {
      const known = this.remote.has(from);
      this.#touch(from, msg.presence ?? {}, now);
      // a newcomer gets our presence at once (the room hands presence to newcomers)
      if (msg.k === 'hello' || !known) this.#post({ k: 'presence', presence: this.presence });
    }
  }

  #touch(id, presence, now) {
    let p = this.remote.get(id);
    const joined = !p;
    if (!p) { p = { presence: {}, updatedAt: now, lastSeen: now }; this.remote.set(id, p); }
    p.lastSeen = now;
    let updated = false;
    if (presence && JSON.stringify(presence) !== JSON.stringify(p.presence)) {
      p.presence = presence;
      p.updatedAt = now;
      updated = true;
    }
    const peer = freezePeer({ id, presence: p.presence, isMe: false, updatedAt: p.updatedAt });
    if (joined) this.#emitPeers([peer], [], []);
    else if (updated) this.#emitPeers([], [], [peer]);
  }

  #tick() {
    if (this.closed) return;
    this.#post({ k: 'presence', presence: this.presence });
    const now = Date.now();
    const left = [];
    for (const [id, p] of this.remote) {
      if (now - p.lastSeen > NET.broadcastPeerTimeoutMs) {
        this.remote.delete(id);
        left.push(freezePeer({ id, presence: p.presence, isMe: false, updatedAt: p.updatedAt }));
      }
    }
    if (left.length) this.#emitPeers([], left, []);
  }

  #emitPeers(joined, left, updated) {
    const change = { peers: this.peers(), joined, left, updated };
    for (const fn of [...this.peerHandlers]) { try { fn(change); } catch (err) { console.error('[net] peers handler failed', err); } }
  }
}

export class BroadcastTransport {
  /** false when this browser has no BroadcastChannel */
  static available() { return typeof globalThis.BroadcastChannel === 'function'; }

  constructor() {
    this.kind = 'broadcast';
    this.selfId = randomId();
    this.rooms = new Map();
  }

  /** Joins the named game room; joining a name already joined returns the same channel */
  async join(name) {
    if (this.rooms.has(name)) return this.rooms.get(name);
    const ch = new BroadcastChannelRoom(this, name);
    this.rooms.set(name, ch);
    return ch;
  }
}
