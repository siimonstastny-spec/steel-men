// Steel Men – continuing a saved multiplayer match after the continue lobby started [A2-net] (docs/notes/a2-net.md).
// main.js startMultiplayer(info) calls continueMultiplayer() when info.continue exists (Lobby onStart, after the save was
// transferred). Every client:
//   1. replays the save to its tick T headless, without live AI (SaveGame.restoreMultiplayer: checkpoints + end hashes)
//   2. exchanges its end hashes with every other human (topic NET_CONTINUE.syncTopic) and compares them
// Then main.js creates the AI on the host (every seat that is AI now) and starts the Lockstep built with
// { startTick: T } after the usual waitForPlayers barrier.
// Errors carry an i18n key (err.key): net.continue.error.* / lobby.error.simVersion. Progress:
//   onProgress({ phase: 'replay'|'sync', ratio 0..1, stalled?: true })  stalled = stuck for NET_CONTINUE.stallOfferMs
//   (main.js offers the host to end the match: net.endMatch(); the others' signal aborts → error key 'net.continue.error.cancelled').
import { NET_CONTINUE } from '../config.js';
import { restoreMultiplayer } from '../game/SaveGame.js';

const keyError = (key, message = key, cause = undefined) => Object.assign(new Error(message), { key, cause });
const defaultNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/** i18n key of a SaveGame restore error */
function restoreErrorKey(err) {
  switch (err?.code) {
    case 'hash': return 'net.continue.error.hash';
    case 'reloadRequired': return 'net.continue.error.reload';
    case 'cancelled': return 'net.continue.error.cancelled';
    case 'incompatible':
      return err.details?.reason === 'simVersion' ? 'lobby.error.simVersion' : err.details?.reason === 'data' ? 'net.continue.error.data' : 'net.continue.error.corrupt';
    default: return 'net.continue.error.generic';
  }
}

/**
 * End-of-replay hash exchange. Listens from construction (players that finish earlier are not lost), sends our hashes
 * once ready(), resolves when every other present human's hashes arrived and match ours. Keeps answering late players
 * for NET_CONTINUE.syncLingerMs after that, then disposes itself.
 *   msg { op: 'h', t: tick, h: [stateHash, partsHash, commandHash], need: 0|1 }  (need = the sender still waits)
 */
export class ContinueSync {
  constructor({ channel, players, localTeam, selfId, hostId, now = null, timers = true, config = null }) {
    this.cfg = { ...NET_CONTINUE, ...(config ?? {}) };
    this.channel = channel;
    this.selfId = selfId;
    this.hostId = hostId;
    this.now = now ?? defaultNow;
    this.timers = timers;
    this.peers = new Set((players ?? []).filter((p) => p?.playerId && p.playerId !== selfId && p.team !== localTeam).map((p) => p.playerId));
    this.got = new Map();      // playerId -> { t, h }
    this.mine = null;          // { t, h }
    this.done = false;
    this.disposed = false;
    this.lastSendAt = -Infinity;
    this.waitStart = 0;
    this.stallReported = false;
    this.lingerUntil = Infinity;
    this.resolve = null;
    this.reject = null;
    this.onProgress = null;
    this.timer = null;
    this.unsub = channel.on(this.cfg.syncTopic, (m) => this.#onMessage(m));
  }

  /** Our end state is known: send it and wait for the others. Resolves / rejects Error { key } */
  ready({ tick, hashes, onProgress = null }) {
    this.mine = { t: tick, h: hashes.map((v) => v >>> 0) };
    this.onProgress = onProgress;
    this.waitStart = this.now();
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      for (const [pid, m] of this.got) if (!this.#same(m)) { this.#fail('net.continue.error.hash', pid); return; }
      if (this.timers) this.timer = setInterval(() => this.pump(), this.cfg.syncResendMs);
      this.pump();
    });
  }

  /** Aborts (rejects with this key) */
  cancel(key = 'net.continue.error.cancelled') { if (!this.done) this.#fail(key); this.dispose(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.unsub?.(); } catch { /* gone */ }
  }

  pump(now = this.now()) {
    if (this.disposed || !this.mine) return;
    if (this.done) {
      if (now >= this.lingerUntil) this.dispose();
      return;
    }
    let present = null;
    try { present = new Set(this.channel.peers().map((p) => p.id)); } catch { /* keep waiting */ }
    if (present && this.hostId && this.hostId !== this.selfId && !present.has(this.hostId)) { this.#fail('net.continue.error.hostLeft'); return; }
    const waiting = [...this.peers].filter((pid) => !this.got.has(pid) && (!present || present.has(pid))); // a player who left does not block
    const total = Math.max(1, this.peers.size);
    try { this.onProgress?.({ phase: 'sync', ratio: (total - waiting.length) / total }); } catch (err) { console.error(err); }
    if (!waiting.length) {
      this.done = true;
      this.lingerUntil = now + this.cfg.syncLingerMs;
      this.#send(0, now);
      this.resolve?.({ ok: true });
      return;
    }
    if (now - this.lastSendAt >= this.cfg.syncResendMs) this.#send(1, now);
    if (!this.stallReported && now - this.waitStart >= this.cfg.stallOfferMs) {
      this.stallReported = true;
      try { this.onProgress?.({ phase: 'sync', ratio: (total - waiting.length) / total, stalled: true }); } catch (err) { console.error(err); }
    }
  }

  #send(need, now) {
    if (!this.mine || this.disposed) return;
    this.channel.send(this.cfg.syncTopic, { op: 'h', t: this.mine.t, h: this.mine.h, need });
    this.lastSendAt = now;
  }

  #same(m) { return m.t === this.mine.t && m.h.length === this.mine.h.length && m.h.every((v, i) => v === this.mine.h[i]); }

  #onMessage({ from, data }) {
    if (this.disposed || !this.peers.has(from) || !data || data.op !== 'h') return;
    if (!Number.isInteger(data.t) || !Array.isArray(data.h) || data.h.length > this.cfg.maxHashWords || !data.h.every((v) => Number.isInteger(v))) return;
    const m = { t: data.t, h: data.h.map((v) => v >>> 0) };
    if (!this.got.has(from)) this.got.set(from, m);
    if (!this.mine) return; // still replaying: compared in ready()
    if (!this.#same(m)) { if (!this.done) this.#fail('net.continue.error.hash', from); return; }
    if (data.need && this.done) this.#send(0, this.now()); // a late player still waits for us
    else if (!this.done) this.pump();
  }

  #fail(key, pid = null) {
    if (this.done) return;
    this.done = true;
    if (key === 'net.continue.error.hash') console.error('[continue] end state differs from player', pid, this.got.get(pid), 'mine', this.mine);
    this.dispose();
    this.reject?.(keyError(key));
  }
}

/**
 * Replays the saved match of a continue lobby and checks that every client reached the same state.
 * @param {object} o
 * @param {object} o.info   Lobby onStart info with info.continue = { save, tick }
 * @param {(ev: {phase: string, ratio: number, stalled?: boolean}) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]  abort = the host ended the match (Lockstep onEnded) / the player left
 * @returns {Promise<{ tick: number, stateHash: number, isHost: boolean }>}  rejects Error { key }
 */
export async function continueMultiplayer({ info, onProgress = null, signal = null }) {
  const cont = info?.continue;
  if (!cont?.save) throw keyError('net.continue.error.transfer');
  const report = (ev) => { try { onProgress?.(ev); } catch (err) { console.error(err); } };
  const sync = new ContinueSync({ channel: info.channel, players: info.players, localTeam: info.localTeam, selfId: info.selfId, hostId: info.hostId });
  const onAbort = () => sync.cancel('net.continue.error.cancelled');
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    let ratio = 0;
    let res;
    try {
      res = await restoreMultiplayer(cont.save, {
        info, signal, paused: false, stallMs: NET_CONTINUE.stallOfferMs,
        onProgress: (r) => { ratio = r; report({ phase: 'replay', ratio: r }); },
        onStall: () => report({ phase: 'replay', ratio, stalled: true }),
      });
    } catch (err) {
      if (!err?.cancelled) console.error('[continue] replay failed', err);
      throw keyError(restoreErrorKey(err), err?.message, err);
    }
    if (res.tick !== cont.tick) throw keyError('net.continue.error.hash', `replayed to tick ${res.tick}, the save is at ${cont.tick}`);
    if (signal?.aborted) throw keyError('net.continue.error.cancelled');
    report({ phase: 'sync', ratio: 0 });
    await sync.ready({ tick: res.tick, hashes: [res.stateHash, res.partsHash, res.commandHash], onProgress: report });
    report({ phase: 'sync', ratio: 1 });
    return { tick: res.tick, stateHash: res.stateHash, isHost: info.selfId === info.hostId };
  } catch (err) {
    sync.cancel(err?.key ?? 'net.continue.error.generic');
    throw err?.key ? err : keyError('net.continue.error.generic', err?.message, err);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}
