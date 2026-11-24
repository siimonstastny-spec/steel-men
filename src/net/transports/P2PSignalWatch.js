// Steel Men – [LOBBY_LIST] detects a room password mismatch that Trystero reports only on the OTHER side.
// Trystero signalling: on an announcement the peer with the lower selfId sends the (password-encrypted) offer, the
// other one only a counter-announce. When the joiner has the lower id, the HOST fails to decrypt the joiner's offer
// (its onJoinError) and never answers; the joiner hears nothing and timed out with "game not found" (3rd QA: ~2/3).
// This watcher reads the frames of Trystero's own relay sockets (read-only listeners, nothing is sent) on the room's
// our self topic. A peer that writes to us (counter-announce) while NO peer ever sends us an offer or an answer
// within NET.p2p.passwordSuspectMs can only have another password (a NAT problem shows up after SDP was exchanged,
// as Trystero's connection error). Any offer / answer ends the watch. onSuspect(peerId) fires once.
//
//   const w = new P2PSignalWatch(lib, roomId, { isConnected, onSuspect });  w.dispose()
//   isConnected() true = stop (channel closed); Lobby.join stops it via channel.stopPasswordWatch() once the host state came
// Topic names follow vendor/trystero/core: root = sha1("Trystero@" + appId + "@" + roomId), self = sha1(root plain +
// "@" + selfId), sha1 = bytes in base 36 joined. Stops itself after NET.p2p.lobbyJoinTimeoutMs.
import { NET } from '../../config.js';

const TRYSTERO_LIB_NAME = 'Trystero'; // core/utils.mjs libName (part of the topic path)
const TOPIC_SEPARATOR = '@';          // core/utils.mjs topicPath
const PEER_ID_RE = /peerId\\?"\s*:\s*\\?"([A-Za-z0-9]{1,64})/; // peerId inside the (JSON-escaped) event content

async function trysteroSha1(str) {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(str)));
  return Array.from(bytes, (b) => b.toString(36)).join('');
}

export class P2PSignalWatch {
  constructor(lib, roomId, { isConnected, onSuspect }) {
    this.lib = lib;
    this.isConnected = isConnected;
    this.onSuspect = onSuspect;
    this.disposed = false;
    this.fired = false;
    this.topics = null;              // [root, self] once hashed
    this.peers = new Map();          // peerId -> first message on our self topic (ms); any SDP ends the watch
    this.sockets = [];               // sockets we listen on (removed in dispose)
    this.seenSockets = new WeakSet();
    this.startedAt = Date.now();
    this.onFrame = (e) => this.#frame(e?.data);
    const root = [TRYSTERO_LIB_NAME, NET.p2p.appId, roomId].join(TOPIC_SEPARATOR);
    Promise.all([trysteroSha1(root), trysteroSha1(root + TOPIC_SEPARATOR + lib.selfId)])
      .then((topics) => { if (!this.disposed) this.topics = topics; })
      .catch(() => this.dispose());
    this.timer = setInterval(() => this.#tick(), NET.p2p.relayPollMs);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sockets) { try { s.removeEventListener('message', this.onFrame); } catch { /* gone */ } }
    this.sockets.length = 0;
    this.peers.clear();
    this.isConnected = null;
    this.onSuspect = null;
  }

  #tick() {
    if (this.disposed) return;
    const now = Date.now();
    if (this.fired || this.isConnected?.() || now - this.startedAt > NET.p2p.lobbyJoinTimeoutMs) { this.dispose(); return; }
    // Trystero replaces a socket when it reconnects: attach to every current one
    let sockets = {};
    try { sockets = this.lib.getRelaySockets(); } catch { /* not initialised */ }
    for (const key in sockets) {
      const s = sockets[key];
      if (!s || this.seenSockets.has(s)) continue;
      this.seenSockets.add(s);
      this.sockets.push(s);
      s.addEventListener('message', this.onFrame);
    }
    // QA 2: only when NOBODY exchanged SDP (any exchange ends the watch in #frame); slow ICE or a silent third
    // peer (closed tab, another joiner with a wrong password) must not fail a player with the right password
    for (const [peerId, firstAt] of this.peers) {
      if (now - firstAt >= NET.p2p.passwordSuspectMs) {
        this.fired = true;
        const fn = this.onSuspect;
        this.dispose();
        try { fn?.(peerId); } catch (err) { console.error('[net] password watch failed', err); }
        return;
      }
    }
  }

  // Only our SELF topic counts (counter-announce, offer, answer addressed to us); root announcements do not.
  #frame(raw) {
    if (this.disposed || !this.topics || typeof raw !== 'string' || raw.length > NET.p2p.signalWatchMaxFrameChars) return;
    const self = this.topics[1];
    if (!raw.includes(self)) return; // cheap filter before parsing
    const sdp = raw.includes('offer') || raw.includes('answer');
    // duplicate (the same event from several relays) of a peer already tracked, without SDP: nothing new, no parse
    if (!sdp) {
      const m = PEER_ID_RE.exec(raw);
      if (m && this.peers.has(m[1])) return;
    }
    let content;
    try {
      const msg = JSON.parse(raw);
      const ev = Array.isArray(msg) && msg[0] === 'EVENT' ? msg[2] : null;
      const tag = Array.isArray(ev?.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === 'x') : null;
      if (!tag || tag[1] !== self || typeof ev.content !== 'string') return;
      content = JSON.parse(ev.content);
    } catch { return; }
    const peerId = content?.peerId;
    if (typeof peerId !== 'string' || !peerId || peerId === this.lib.selfId) return;
    if (typeof content.offer === 'string' || typeof content.answer === 'string') { this.dispose(); return; } // SDP flows: not a password problem
    if (!this.peers.has(peerId) && this.peers.size < NET.p2p.signalWatchMaxPeers) this.peers.set(peerId, Date.now());
  }
}
