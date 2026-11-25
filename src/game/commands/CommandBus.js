// Steel Men – the ONE way into the simulation. Every change a player (human UI, AI, remote player) makes to
// the game is a command: a small plain-JSON object that is submitted here and executed at the start of a
// simulation tick, identically on every client.
//
// Command shape (plain JSON only – it travels over the network, max ~1 KB):
//   { type: 'move', team: 0, ...payload }
//   - units / structures / wrecks / deposits are referenced by their entity id  `eid`  (world.register)
//   - points are { x, z } numbers (never THREE.Vector3)
//   - no functions, no object references, no Infinity / NaN
//
// Executors live next to their topic (src/game/commands/*Commands.js) and register themselves:
//   registerCommand('move', {
//     validate(world, cmd) { return true },   // optional – false = silently dropped (stale target, not own unit…)
//     execute(world, cmd) { ... },            // mutates the simulation; must be deterministic
//   });
//
// UI / AI code:   commandBus.submit({ type: 'move', team: localTeam(), units: [eid...], point: { x, z }, queued })
// Simulation:     commandBus.executeTick(world, tick)  – called by the fixed-step loop before world.update
//
// Offline (single player, AI) the bus is local: a command submitted now runs at the next tick. In multiplayer
// a transport (src/net/, later) replaces `schedule` and delivers everyone's commands for a tick in the same order.

import { NET, NET_LEAVE, SAVE } from '../../config.js';

// [J1] save games: running FNV-1a hash of every executed command (all teams, AI included)
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const LOCAL_FIELDS = ['origin', 'ticket']; // client-local command fields: never recorded, never hashed

/** Copy of a command without its client-local fields; `team` stays out too (the record keeps it separately) */
export function recordable(cmd) {
  const out = {};
  for (const k in cmd) if (k !== 'team' && !LOCAL_FIELDS.includes(k)) out[k] = cmd[k];
  if (cmd.origin === null) out.origin = null; // lockstep-injected command (internalOnly): replayed with origin null
  return out;
}

// [A1-3] Big selections: a command whose `units` list is too big for one network message is sent as consecutive chunks
// { ...cmd, units: part, chunk: [i, n] } (same type, team and payload; Lockstep.#schedule). They reach the bus in one
// turn, one after another in the sender's order, and executeTick joins them back into the ORIGINAL command before it
// runs – one formation, one SINGLE_TAKER pick, one onExecuted call, one record entry, exactly as if it was one.
const CHUNK_KEY = 'chunk';

/**
 * [A1-3] Splits a command into chunks of its `units` list (even slices, order kept) so that every chunk passes `fits`.
 * @param {object} cmd
 * @param {(part: object) => boolean} fits  e.g. JSON size ≤ NET.maxCommandBytes
 * @param {number} [maxChunks]
 * @returns {object[]|null} 2..maxChunks chunks, or null (no units list / already a chunk / still too big)
 */
export function splitCommand(cmd, fits, maxChunks = NET.maxCommandChunks) {
  const units = cmd?.units;
  if (!Array.isArray(units) || units.length < 2 || cmd[CHUNK_KEY] !== undefined) return null;
  const last = Math.min(maxChunks, units.length);
  for (let n = 2; n <= last; n++) {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const part = { ...cmd, units: units.slice(Math.floor((i * units.length) / n), Math.floor(((i + 1) * units.length) / n)), [CHUNK_KEY]: [i, n] };
      if (!fits(part)) break;
      parts.push(part);
    }
    if (parts.length === n) return parts;
  }
  return null;
}

/**
 * [A1-3] due[i] starts a chunk run: the joined original command, or null when the run is broken (garbage / lost part –
 * the same on every client, so dropping it is deterministic). `count` = due entries used.
 */
function joinChunks(due, i, out) {
  out.cmd = null;
  out.count = 1;
  const first = due[i].cmd;
  const c = first[CHUNK_KEY];
  const n = Array.isArray(c) && c[0] === 0 ? c[1] : 0;
  if (!Number.isInteger(n) || n < 2 || n > NET.maxCommandChunks || i + n > due.length) return out;
  const units = [];
  for (let j = 0; j < n; j++) {
    const part = due[i + j].cmd;
    const pc = part[CHUNK_KEY];
    if (part.type !== first.type || part.team !== first.team || !Array.isArray(pc) || pc[0] !== j || pc[1] !== n || !Array.isArray(part.units)) return out;
    for (const id of part.units) units.push(id);
  }
  const joined = { ...first, units };
  delete joined[CHUNK_KEY];
  out.cmd = joined;
  out.count = n;
  return out;
}
const joinOut = { cmd: null, count: 1 };

const registry = new Map();

/** Registers the executor of a command type (call once at module load) */
export function registerCommand(type, def) {
  if (registry.has(type)) throw new Error(`command '${type}' registered twice`);
  if (typeof def?.execute !== 'function') throw new Error(`command '${type}' has no execute()`);
  registry.set(type, def);
}

export const isRegistered = (type) => registry.has(type);

/** [MP-SEC] Commands only the lockstep may inject (origin === null); anything with another origin is dropped at execution */
const internalOnly = new Set([NET_LEAVE.commandType]);

/** Resolves an entity id to the live object, or null when it is gone (destroyed / removed / unknown) */
export function resolve(world, eid) {
  const obj = world.entityById?.(eid) ?? null;
  if (!obj || obj.removed) return null;
  return obj;
}

/** Resolves a list of ids, keeps only live objects of the given team */
export function resolveOwn(world, eids, team) {
  return (eids ?? []).map((id) => resolve(world, id)).filter((u) => u && u.team === team && !u.destroyed);
}

class Bus {
  constructor() {
    this.pending = [];      // { tick, seq, cmd } waiting for their tick
    this.seq = 0;           // submission order – tie-breaker inside one tick and team
    this.currentTick = 0;   // last tick executed
    this.log = [];          // executed commands (replays, desync debugging); trimmed to logLimit
    this.logLimit = 2000;
    this.listeners = new Set();
    /**
     * Who submits from this client. Stamped into every submitted command as `origin`, so local UI feedback
     * (select the ejected crew, show a build error) reacts only to its own commands – never to a remote player's
     * command that happens to look the same. Multiplayer sets it to the room peer id.
     */
    this.clientId = 'local';
    /**
     * Where a submitted command goes. Default (offline): run at the next tick. A network transport replaces
     * this with its own function (send to peers, schedule for tick + input delay).
     * @type {(cmd: object) => void}
     */
    this.schedule = (cmd) => this.enqueue(this.currentTick + 1, cmd);
    // --- [J1] save games (src/game/SaveGame.js) ---
    // Full record of the match: [tick, team, cmd] of every executed command whose team is not in `liveTeams`
    // (computer players are re-run live on restore, their commands are only hashed), checkpoints
    // [tick, stateHash, partsHash, commandHash] every SAVE.hashEveryTicks. Cleared by reset().
    this.recorded = [];
    this.checkpoints = [];
    this.commandHash = FNV_OFFSET;
    /** Teams whose commands are produced live (AI seats). Survives reset(): SaveGame sets it per match. */
    this.liveTeams = [];
    /** false = commands are only hashed, never kept (multiplayer, ?test=1: no save possible). Survives reset(). */
    this.recording = true;
    /** Extra checkpoint hash (SaveGame installs the subsystem hash); null = 0. Survives reset(). */
    this.checkpointHash = null;
    /** Restore in progress: { entries, index } – recorded commands injected at their tick. Survives reset(). */
    this.replay = null;
  }

  /** [J1] Restore: inject these recorded [tick, team, cmd] entries at their ticks; submit() only lets live teams through */
  beginReplay(entries) { this.replay = { entries, index: 0 }; }

  /** [J1] Restore finished / aborted: back to normal submitting */
  endReplay() { this.replay = null; }

  /** [J1] Recorded entries not injected yet (0 = the replay reached the end of the record) */
  get replayLeft() { return this.replay ? this.replay.entries.length - this.replay.index : 0; }

  /** UI / AI entry point */
  submit(cmd) {
    if (!cmd || typeof cmd.type !== 'string' || typeof cmd.team !== 'number') {
      console.warn('CommandBus: malformed command', cmd);
      return;
    }
    if (!registry.has(cmd.type)) {
      console.warn(`CommandBus: unknown command '${cmd.type}'`);
      return;
    }
    // [J1] while a saved game is replayed only live (AI) teams submit; the rest comes from the record
    if (this.replay && !this.liveTeams.includes(cmd.team)) return;
    this.schedule({ ...cmd, origin: this.clientId });
  }

  /** [MP-SEC] Is this command type registered? (Lockstep rejects unknown types from remote players) */
  isKnown(type) { return registry.has(type); }

  /** Was this command submitted on this client? (for local UI feedback only – never in simulation code) */
  isOwn(cmd) { return cmd?.origin === this.clientId; }

  /** Puts a command into the queue of a given tick (used by `schedule` and by network transports) */
  enqueue(tick, cmd) {
    this.pending.push({ tick, seq: this.seq++, cmd });
  }

  /**
   * Runs every command due at `tick`, in a deterministic order: team, then the order they were enqueued.
   * Network transports must enqueue remote commands in the same order on every client.
   */
  executeTick(world, tick) {
    this.currentTick = tick;
    // [J1] checkpoint of the state after the previous tick (same point in the loop for play, harness and restore)
    const done = tick - 1;
    if (done > 0 && done % SAVE.hashEveryTicks === 0 && this.#lastCheckpoint() < done) {
      this.checkpoints.push([done, world.stateHash(), this.checkpointHash ? this.checkpointHash(world) : 0, this.commandHash >>> 0]);
    }
    // [J1] restore: the recorded commands of this tick join the queue in their recorded order (sorted below by team,
    // and inside a team by this enqueue order = the original order; live AI teams never appear in the record)
    const rp = this.replay;
    if (rp) {
      const list = rp.entries;
      while (rp.index < list.length && list[rp.index][0] <= tick) {
        const entry = list[rp.index++];
        const rec = entry[2];
        this.enqueue(tick, { ...rec, team: entry[1], origin: rec.origin === null ? null : 'replay' });
      }
    }
    if (!this.pending.length) return;
    const due = this.pending.filter((p) => p.tick <= tick);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.tick > tick);
    due.sort((a, b) => a.cmd.team - b.cmd.team || a.seq - b.seq);
    for (let i = 0; i < due.length; i++) {
      let cmd = due[i].cmd;
      if (cmd[CHUNK_KEY] !== undefined) { // [A1-3] chunks of one big command: run once, as the original command
        const joined = joinChunks(due, i, joinOut);
        i += joined.count - 1;
        cmd = joined.cmd;
        joined.cmd = null;
        if (!cmd) { console.warn('CommandBus: broken command chunk dropped', due[i].cmd); continue; }
      }
      this.#record(tick, cmd); // [J1] every due command, before validation (validate is deterministic too)
      const def = registry.get(cmd.type);
      if (!def) continue; // [MP-SEC] unknown type (remote garbage): silently skipped
      if (internalOnly.has(cmd.type) && cmd.origin !== null) continue; // [MP-SEC] only the lockstep may inject it
      try {
        if (def.validate && !def.validate(world, cmd)) continue;
        const result = def.execute(world, cmd); // optional local result (e.g. ejected crews) – never sent anywhere
        this.log.push({ tick, cmd });
        if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
        for (const fn of this.listeners) fn(cmd, tick, result);
      } catch (err) {
        console.error(`CommandBus: '${cmd.type}' failed`, err, cmd);
      }
    }
  }

  /**
   * Called after each executed command as fn(cmd, tick, result) – result = what execute() returned (local only).
   * UI feedback filters with isOwn(cmd). Returns an unsubscribe function.
   */
  onExecuted(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // [J1] hash every due command; keep the non-live ones in the record
  #record(tick, cmd) {
    const rec = recordable(cmd);
    const text = JSON.stringify(rec);
    let h = Math.imul(this.commandHash ^ tick, FNV_PRIME);
    h = Math.imul(h ^ cmd.team, FNV_PRIME);
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), FNV_PRIME);
    this.commandHash = h >>> 0;
    // own deep copy: an executor may keep / change the arrays of the live command
    if (this.recording && !this.liveTeams.includes(cmd.team)) this.recorded.push([tick, cmd.team, JSON.parse(text)]);
  }

  #lastCheckpoint() { return this.checkpoints.length ? this.checkpoints[this.checkpoints.length - 1][0] : -1; }

  /** New match: drops everything (liveTeams, checkpointHash and replay are set per match by SaveGame and stay) */
  reset() {
    this.pending = [];
    this.seq = 0;
    this.currentTick = 0;
    this.log = [];
    this.recorded = [];
    this.checkpoints = [];
    this.commandHash = FNV_OFFSET;
  }
}

export const commandBus = new Bus();
