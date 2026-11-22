// Steel Mans – the ONE way into the simulation. Every change a player (human UI, AI, remote player) makes to
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

const registry = new Map();

/** Registers the executor of a command type (call once at module load) */
export function registerCommand(type, def) {
  if (registry.has(type)) throw new Error(`command '${type}' registered twice`);
  if (typeof def?.execute !== 'function') throw new Error(`command '${type}' has no execute()`);
  registry.set(type, def);
}

export const isRegistered = (type) => registry.has(type);

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
  }

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
    this.schedule({ ...cmd, origin: this.clientId });
  }

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
    if (!this.pending.length) return;
    const due = this.pending.filter((p) => p.tick <= tick);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.tick > tick);
    due.sort((a, b) => a.cmd.team - b.cmd.team || a.seq - b.seq);
    for (const { cmd } of due) {
      const def = registry.get(cmd.type);
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

  /** New match: drops everything */
  reset() {
    this.pending = [];
    this.seq = 0;
    this.currentTick = 0;
    this.log = [];
  }
}

export const commandBus = new Bus();
