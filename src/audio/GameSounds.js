// Steel Men – [A6] match announcements of the local player (Sound.js events), one instance per match.
//   unitReady / researchComplete   Production.addCompleteListener (item of the local team)
//   buildingComplete               a local building turned complete since the last poll
//   baseUnderAttack                a local unit / building lost HP since the last poll (long real-time cooldown)
// Presentation only: reads the world, never writes it, no world.rng – the simulation and its hash cannot change.
// The world is polled every SOUND_HOOKS.pollIntervalSec of real time from update(dt) (main.js render loop); when more
// than SOUND_HOOKS.silentTickGap ticks passed between two polls (hidden tab pump, fast-forward) the changes are only
// taken as the new baseline, so a catch-up never fires a burst of stale announcements.
import { SOUND_HOOKS } from '../config.js';
import { play } from './Sound.js';
import { localTeam } from '../core/LocalPlayer.js';

const MS_PER_SEC = 1000;

const gone = (u) => u.removed || u.destroyed || u.dead;

/** Current HP of a unit or building; a mech sums its parts (no allocation) */
function hpOf(u) {
  if (!u.parts) return u.hp ?? 0;
  let sum = 0;
  for (const key in u.parts) sum += u.parts[key]?.hp ?? 0;
  return sum;
}

export class GameSounds {
  /**
   * @param {object} opts
   * @param {object} opts.world        World (reads units, tick)
   * @param {object} [opts.production] Production (addCompleteListener); default world.production
   * @param {() => number} [opts.now]  real-time clock in ms (default performance.now; UI only)
   */
  constructor({ world, production = world?.production ?? null, now = () => performance.now() }) {
    this.world = world;
    this.now = now;
    this.hp = new Map();          // local unit / building -> HP at the last poll
    this.building = new Set();    // local buildings not complete at the last poll
    this.timer = 0;
    this.lastTick = world?.tick ?? 0;
    this.lastAttackMs = -Infinity;
    this.primed = false;          // the first poll only records the baseline
    this.unlisten = production?.addCompleteListener?.((item) => this.#onComplete(item)) ?? null;
  }

  #onComplete(item) {
    if (item?.team !== localTeam()) return;
    const name = SOUND_HOOKS.productionEvents[item.kind];
    if (name) play(name);
  }

  /** Call every rendered frame with the real frame time (s) */
  update(dt) {
    if (!this.world) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = SOUND_HOOKS.pollIntervalSec;
    this.#poll();
  }

  #poll() {
    const world = this.world;
    const tick = world.tick ?? 0;
    const announce = this.primed && tick - this.lastTick <= SOUND_HOOKS.silentTickGap;
    this.lastTick = tick;
    this.primed = true;
    const team = localTeam();
    let attacked = null;
    let finished = null;
    for (const u of world.units) {
      if (u.team !== team || gone(u)) continue;
      const hp = hpOf(u);
      const before = this.hp.get(u);
      if (before !== undefined && before - hp >= SOUND_HOOKS.attackMinHpLoss && (!u.isStructure || u.complete)) attacked ??= u;
      this.hp.set(u, hp);
      if (!u.isStructure) continue;
      if (!u.complete) this.building.add(u);
      else if (this.building.delete(u)) finished ??= u;
    }
    // forget what left the world (or changed hands) – Map / Set deletion while iterating is safe
    for (const u of this.hp.keys()) if (gone(u) || u.team !== team) this.hp.delete(u);
    for (const u of this.building) if (gone(u) || u.team !== team) this.building.delete(u);
    if (!announce) return;
    if (finished) play('buildingComplete'); // announcements: heard wherever the camera is (no falloff)
    if (attacked) {
      const now = this.now();
      if (now - this.lastAttackMs >= SOUND_HOOKS.attackCooldownSec * MS_PER_SEC) {
        this.lastAttackMs = now;
        play('baseUnderAttack');
      }
    }
  }

  dispose() {
    this.unlisten?.();
    this.unlisten = null;
    this.hp.clear();
    this.building.clear();
    this.world = null;
  }
}
