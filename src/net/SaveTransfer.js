// Steel Men – transfer of a saved game host → clients for the continue lobby [A2-net] (docs/notes/a2-net.md).
// The room limits a message to NET.maxMessageBytes and drops / reorders messages, so the save (gzip JSON as stored,
// SaveStore.packSave) travels as base64 chunks on topic NET_CONTINUE.topic, rate limited, with acknowledgements:
//   host → all   { op: 'c', id, i, n, b, h, d }   chunk i of n (b = byte length, h = hash of the whole base64 text)
//   client → all { op: 'a', id, next, top, miss: [i…], ok?: 1, fail?: 'corrupt' }
//     next = chunks 0..next-1 are here, top = highest chunk here, miss = first missing chunks above next
// The sender sends the chunks some target still needs (missing ones first, then in order), at most
// NET_CONTINUE.chunksPerPump per NET_CONTINUE.pumpMs. No progress for NET_CONTINUE.stallMs, a target gone from the room
// or a client that cannot read the save = error with an i18n key (err.key), never a hang. Not simulation code.
//
//   const payload = await encodeSave(save)                       // { data, bytes, hash }
//   const sender = new SaveSender({ channel, id, payload, targets: [peerId…], onProgress(ratio) })
//   await sender.run()                                           // rejects Error { key: 'net.continue.error.*' }
//   const receiver = new SaveReceiver({ channel, hostId, onProgress(ratio), onComplete(save, id), onError(key) })
//   receiver.result(id) → save | null;  sender / receiver .dispose()
import { NET_CONTINUE } from '../config.js';
import { packSave, unpackSave } from '../core/SaveStore.js';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const BASE64_RATIO = 4 / 3;
const ERROR_PREFIX = 'net.continue.error.'; // i18n keys a host may name in its { op: 'x' } message

const defaultNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const transferError = (key, message = key) => Object.assign(new Error(message), { key });

/** FNV-1a of a string (hex) – integrity check of the joined transfer text */
export function textHash(text) {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME);
  h = Math.imul(h ^ text.length, FNV_PRIME);
  return (h >>> 0).toString(NET_CONTINUE.hashRadix);
}

function bytesToBase64(bytes) {
  let bin = '';
  const block = NET_CONTINUE.base64Block;
  for (let i = 0; i < bytes.length; i += block) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
  return btoa(bin);
}

function base64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Save → { data: base64 text, bytes, hash } (what the sender splits) */
export async function encodeSave(save) {
  const bytes = await packSave(save);
  const data = bytesToBase64(bytes);
  return { data, bytes: bytes.length, hash: textHash(data) };
}

/** Largest chunk count a receiver accepts */
const maxChunks = (cfg) => Math.ceil((cfg.maxSaveBytes * BASE64_RATIO) / cfg.chunkChars) + 1;

export class SaveSender {
  /**
   * @param {object} o
   * @param {object} o.channel   lobby room channel (send, on, peers)
   * @param {string} o.id        transfer id (unique per start attempt)
   * @param {{data: string, bytes: number, hash: string}} o.payload  encodeSave() result
   * @param {string[]} o.targets peer ids that must confirm the whole save
   * @param {(ratio: number) => void} [o.onProgress]
   * @param {boolean} [o.timers] false = the owner calls pump(now) (selftest)
   */
  constructor({ channel, id, payload, targets, onProgress = null, timers = true, now = null, config = null }) {
    this.cfg = { ...NET_CONTINUE, ...(config ?? {}) };
    this.channel = channel;
    this.id = String(id);
    this.data = payload.data;
    this.bytes = payload.bytes;
    this.hash = payload.hash;
    this.n = Math.max(1, Math.ceil(this.data.length / this.cfg.chunkChars));
    this.now = now ?? defaultNow;
    this.onProgress = onProgress;
    const t0 = this.now();
    this.targets = new Map([...new Set(targets ?? [])].map((pid) => [pid, { next: 0, top: -1, miss: null, ok: false, at: t0 }]));
    this.cursor = 0;
    this.passAt = t0;
    this.finished = false;
    this.resolve = null;
    this.reject = null;
    this.timer = null;
    this.timers = timers;
    this.unsub = channel.on(this.cfg.topic, (m) => this.#onMessage(m));
  }

  /** Resolves when every target confirmed the whole save; rejects Error { key } */
  run() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (this.timers) this.timer = setInterval(() => this.pump(), this.cfg.pumpMs);
      this.pump();
    });
  }

  /** Aborts (e.g. the lobby closes): run() rejects with this key */
  cancel(key = 'net.continue.error.cancelled') { this.#finish(transferError(key)); }

  dispose() { this.cancel(); }

  get ratio() {
    if (!this.targets.size) return 1;
    let sum = 0;
    for (const t of this.targets.values()) sum += t.ok ? 1 : Math.min(t.next, this.n) / (this.n + 1);
    return sum / this.targets.size;
  }

  pump(now = this.now()) {
    if (this.finished || !this.resolve) return;
    let present;
    try { present = new Set(this.channel.peers().map((p) => p.id)); } catch { present = null; }
    for (const [pid, t] of this.targets) {
      if (t.ok) continue;
      if (present && !present.has(pid)) { this.#finish(transferError('net.continue.error.peerLeft')); return; }
      if (now - t.at > this.cfg.stallMs) { this.#finish(transferError('net.continue.error.timeout')); return; }
    }
    if ([...this.targets.values()].every((t) => t.ok)) { this.#finish(null); return; }
    let minNext = this.n;
    for (const t of this.targets.values()) if (!t.ok) minNext = Math.min(minNext, t.next);
    let sent = 0;
    let wrapped = false;
    if (this.cursor < minNext) this.cursor = minNext;
    while (sent < this.cfg.chunksPerPump) {
      if (this.cursor >= this.n) {
        if (wrapped || now - this.passAt < this.cfg.ackMs * this.cfg.passGapAcks) break; // let the acknowledgements arrive first
        wrapped = true;
        this.cursor = minNext;
        this.passAt = now;
        continue;
      }
      const i = this.cursor++;
      if (!this.#needed(i)) continue;
      this.#sendChunk(i);
      sent++;
    }
    try { this.onProgress?.(this.ratio); } catch (err) { console.error(err); }
  }

  #needed(i) {
    for (const t of this.targets.values()) {
      if (t.ok || i < t.next) continue;
      if (i > t.top || !t.miss) return true;
      if (t.miss.has(i)) return true;
      if (t.missFull && i > t.missMax) return true; // beyond the listed missing ones: unknown
    }
    return false;
  }

  #sendChunk(i) {
    const c = this.cfg.chunkChars;
    this.channel.send(this.cfg.topic, { op: 'c', id: this.id, i, n: this.n, b: this.bytes, h: this.hash, d: this.data.slice(i * c, (i + 1) * c) });
  }

  #onMessage({ from, data }) {
    if (this.finished || !data || data.op !== 'a' || data.id !== this.id) return;
    const t = this.targets.get(from);
    if (!t || t.ok) return;
    if (data.fail) { this.#finish(transferError('net.continue.error.corrupt')); return; }
    const next = Number.isInteger(data.next) ? Math.min(Math.max(data.next, 0), this.n) : t.next;
    const top = Number.isInteger(data.top) ? Math.min(data.top, this.n - 1) : t.top;
    if (next > t.next || top > t.top || data.ok) t.at = this.now(); // progress
    t.next = Math.max(t.next, next);
    t.top = Math.max(t.top, top);
    const miss = Array.isArray(data.miss) ? data.miss.filter((i) => Number.isInteger(i) && i >= 0 && i < this.n).slice(0, this.cfg.maxMissingReported) : [];
    t.miss = new Set(miss);
    t.missFull = miss.length >= this.cfg.maxMissingReported;
    t.missMax = miss.length ? Math.max(...miss) : -1;
    if (data.ok && t.next >= this.n) t.ok = true;
  }

  #finish(err) {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.unsub?.(); } catch { /* gone */ }
    if (err) this.reject?.(err);
    else { try { this.onProgress?.(1); } catch (e) { console.error(e); } this.resolve?.({ ok: true }); }
  }
}

export class SaveReceiver {
  /**
   * @param {object} o
   * @param {object} o.channel
   * @param {() => string|null} o.hostId  the host (only its chunks count)
   * @param {(ratio: number) => void} [o.onProgress]
   * @param {(save: object, id: string) => void} [o.onComplete]
   * @param {(key: string) => void} [o.onError]
   */
  constructor({ channel, hostId, onProgress = null, onComplete = null, onError = null, timers = true, now = null, config = null }) {
    this.cfg = { ...NET_CONTINUE, ...(config ?? {}) };
    this.channel = channel;
    this.hostId = hostId;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.now = now ?? defaultNow;
    this.cur = null;      // { id, n, b, h, parts[], got, next, top, at }
    this.done = null;     // { id, save } once complete
    this.failedId = null; // id of the last transfer that failed (timeout / given up / corrupt): its late chunks are ignored
    this.lastAckAt = -Infinity;
    this.dirty = false;
    this.decoding = false;
    this.disposed = false;
    this.unsub = channel.on(this.cfg.topic, (m) => this.#onMessage(m));
    this.timer = timers ? setInterval(() => this.pump(), this.cfg.ackMs) : null;
  }

  /** The complete save of transfer `id`, or null */
  result(id) { return this.done && this.done.id === id ? this.done.save : null; }

  /** Is a transfer running (started, not complete)? */
  get active() { return !!this.cur; }

  pump(now = this.now()) {
    if (this.disposed || !this.cur || this.decoding) return;
    if (now - this.cur.at > this.cfg.stallMs) { this.#fail('net.continue.error.timeout', false); return; }
    if (this.dirty || now - this.lastAckAt >= this.cfg.ackMs) this.#ack(now);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.unsub?.(); } catch { /* gone */ }
    this.cur = null;
  }

  #onMessage({ from, data }) {
    if (this.disposed || !data || from !== this.hostId?.()) return;
    if (data.op === 'x') { // the host gave this transfer up (a player left, timeout…): drop the partial save
      if (this.cur && this.cur.id === data.id) {
        const key = typeof data.key === 'string' && data.key.startsWith(ERROR_PREFIX) && data.key.length <= this.cfg.maxKeyLength ? data.key : `${ERROR_PREFIX}generic`;
        this.#fail(key, false);
      }
      return;
    }
    if (data.op !== 'c') return;
    const { id, i, n, b, h, d } = data;
    if (typeof id !== 'string' || !id || id.length > this.cfg.maxIdLength) return;
    if (id === this.failedId) return; // late chunk of a transfer that failed / was given up: no new transfer from it
    if (this.done?.id === id) { // complete already: the host missed our ok
      if (this.now() - this.lastAckAt >= this.cfg.ackMs) this.#sendOk(id);
      return;
    }
    if (!Number.isInteger(n) || n < 1 || n > maxChunks(this.cfg) || !Number.isInteger(i) || i < 0 || i >= n) return;
    if (!Number.isInteger(b) || b < 1 || b > this.cfg.maxSaveBytes || typeof h !== 'string' || typeof d !== 'string' || d.length > this.cfg.chunkChars) return;
    if (!this.cur || this.cur.id !== id) {
      if (this.decoding) return;
      this.cur = { id, n, b, h, parts: new Array(n).fill(null), got: 0, next: 0, top: -1, at: this.now() };
    }
    const c = this.cur;
    if (c.n !== n || c.b !== b || c.h !== h || c.parts[i] !== null) return;
    c.parts[i] = d;
    c.got++;
    c.at = this.now();
    c.top = Math.max(c.top, i);
    while (c.next < n && c.parts[c.next] !== null) c.next++;
    this.dirty = true;
    try { this.onProgress?.(c.got / n); } catch (err) { console.error(err); }
    if (c.got === n) this.#complete(c);
  }

  async #complete(c) {
    this.decoding = true;
    let save = null;
    try {
      const text = c.parts.join('');
      if (textHash(text) !== c.h) throw new Error('hash');
      const bytes = base64ToBytes(text);
      if (bytes.length !== c.b) throw new Error('size');
      save = await unpackSave(bytes);
    } catch (err) {
      console.warn('[save transfer] received save unreadable', err);
    }
    this.decoding = false;
    if (this.disposed || this.cur !== c) return;
    if (!save) { this.#fail('net.continue.error.corrupt', true); return; }
    this.cur = null;
    this.done = { id: c.id, save };
    this.#sendOk(c.id);
    try { this.onComplete?.(save, c.id); } catch (err) { console.error(err); }
  }

  #ack(now) {
    const c = this.cur;
    const miss = [];
    for (let i = c.next; i < c.top && miss.length < this.cfg.maxMissingReported; i++) if (c.parts[i] === null) miss.push(i);
    this.channel.send(this.cfg.topic, { op: 'a', id: c.id, next: c.next, top: c.top, miss });
    this.lastAckAt = now;
    this.dirty = false;
  }

  #sendOk(id) {
    // next / top beyond any chunk count: the sender clamps them to its n
    this.channel.send(this.cfg.topic, { op: 'a', id, next: Number.MAX_SAFE_INTEGER, top: Number.MAX_SAFE_INTEGER, miss: [], ok: 1 });
    this.lastAckAt = this.now();
  }

  #fail(key, tellHost) {
    const c = this.cur;
    this.cur = null;
    if (c) this.failedId = c.id;
    if (tellHost && c) this.channel.send(this.cfg.topic, { op: 'a', id: c.id, next: 0, top: -1, miss: [], fail: 'corrupt' });
    try { this.onError?.(key); } catch (err) { console.error(err); }
  }
}
