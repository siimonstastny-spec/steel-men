// [N11] Text chat over the transport channel, OUTSIDE the lockstep (topic CHAT.topic). Never touches the simulation.
//   const chat = new Chat({ channel, players, localTeam, isAlly });   // players = Lobby onStart `players` [{team, playerId, name}]
//   chat.send(text, 'all' | 'team')  -> { ok, reason? }   // reason: 'empty' | 'rate' | 'spectator'
//   const off = chat.onMessage((m) => ...)                // m = { team, name, text, scope: 'all'|'team', mine, at }
//   chat.dispose()
// Security: sender and team come from the transport (`from` -> roster), never from the message content.
// Text is sanitised here (type, length, control chars); the UI must still escape it (esc()) when building HTML.
import { CHAT } from '../config.js';
import { CONTROL_RE } from './textClean.js'; // control, bidi and zero-width characters (shared, ASCII-escaped)


export function cleanChatText(s) {
  return String(s ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT.maxLength);
}

function cleanName(n) {
  return String(n ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT.maxNameLength);
}

export class Chat {
  /**
   * @param {object} o
   * @param {object} o.channel  transport channel (send/on)
   * @param {{team:number, playerId:string, name?:string}[]} o.players  human seats
   * @param {number|null} o.localTeam  null = spectator (receives 'all' only, never sends)
   * @param {(a:number,b:number)=>boolean} [o.isAlly]  alliance test for team messages (default: same team only)
   * @param {()=>number} [o.now]  clock (UI only, not the simulation)
   */
  constructor({ channel, players, localTeam, isAlly = (a, b) => a === b, now = Date.now }) {
    this.channel = channel;
    this.localTeam = Number.isInteger(localTeam) ? localTeam : null;
    this.isAlly = isAlly;
    this.now = now;
    this.byPeer = new Map();       // peer id (transport) -> { team, name }
    for (const p of players ?? []) {
      if (!Number.isInteger(p?.team) || !p.playerId) continue;
      this.byPeer.set(String(p.playerId), { team: p.team, name: cleanName(p.name) });
    }
    this.handlers = new Set();
    this.lastSent = -Infinity;
    this.recv = new Map();         // peer id -> recent receive times (anti-flood)
    this.disposed = false;
    this.unsub = channel?.on?.(CHAT.topic, (m) => this.#receive(m)) ?? null;
  }

  get canSend() { return !this.disposed && this.localTeam !== null; }

  send(text, scope = 'all') {
    if (this.localTeam === null) return { ok: false, reason: 'spectator' };
    const clean = cleanChatText(text);
    if (!clean) return { ok: false, reason: 'empty' };
    const now = this.now();
    if (now - this.lastSent < CHAT.minIntervalMs) return { ok: false, reason: 'rate' };
    this.lastSent = now;
    const sc = scope === 'team' ? 'team' : 'all';
    this.channel.send(CHAT.topic, { t: clean, s: sc === 'team' ? 't' : 'a' });
    this.#emit({ team: this.localTeam, name: this.#myName(), text: clean, scope: sc, mine: true, at: now });
    return { ok: true };
  }

  onMessage(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }

  #myName() {
    for (const v of this.byPeer.values()) if (v.team === this.localTeam) return v.name;
    return '';
  }

  #receive(m) {
    if (this.disposed) return;
    const info = this.byPeer.get(String(m?.from)); // identity = transport peer id, not the payload
    if (!info) return;                             // stranger / spectator
    const d = m.data;
    if (!d || typeof d !== 'object' || typeof d.t !== 'string') return;
    const now = this.now();
    let q = this.recv.get(m.from);
    if (!q) this.recv.set(m.from, (q = []));
    while (q.length && now - q[0] > CHAT.burstWindowMs) q.shift();
    if (q.length >= CHAT.burstCount) return;       // flooding: drop
    q.push(now);
    const text = cleanChatText(d.t);
    if (!text) return;
    const scope = d.s === 't' ? 'team' : 'all';
    if (scope === 'team' && (this.localTeam === null || !this.isAlly(info.team, this.localTeam))) return;
    this.#emit({ team: info.team, name: info.name, text, scope, mine: false, at: now });
  }

  #emit(msg) {
    for (const fn of this.handlers) {
      try { fn(msg); } catch (e) { console.error('[chat] handler failed', e); }
    }
  }

  dispose() {
    this.disposed = true;
    this.unsub?.();
    this.unsub = null;
    this.handlers.clear();
    this.recv.clear();
  }
}
