import { DAMAGE_SMOKE } from '../config.js';

/**
 * Hooks Effects.damageSmoke up to every hurt unit / building. Every few ticks it scans the world lists and starts a
 * smoke handle for targets below DAMAGE_SMOKE.registerBelow (capped); handles of dead / removed / repaired targets are
 * disposed. Fog of war: smoke is emitted only while world.isVisible(target). Visual only – reads state, never writes it.
 */
export class DamageSmokeWiring {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    this.active = new Map(); // target -> { handle, fraction: () => hp / maxHp }
    this.tickCounter = 0;
  }

  /** Call once per simulation tick */
  update() {
    if (++this.tickCounter < DAMAGE_SMOKE.scanEveryTicks) return;
    this.tickCounter = 0;
    const { active, world } = this;
    for (const [target, entry] of active) {
      if (target.removed || target.dead || target.destroyed || fractionOf(target) > DAMAGE_SMOKE.releaseAbove) {
        entry.handle.dispose();
        active.delete(target);
      }
    }
    this.#scan(world.mechs, 'unit');
    this.#scan(world.crews, 'unit');
    this.#scan(world.vehicles, 'unit');
    this.#scan(world.structures, 'building');
  }

  #scan(list, kind) {
    const { active, world } = this;
    for (let i = 0; i < list.length; i++) {
      if (active.size >= DAMAGE_SMOKE.maxActive) return;
      const u = list[i];
      if (active.has(u) || u.removed || u.dead || u.destroyed || u.mech) continue; // u.mech: crew inside a mech
      if (fractionOf(u) >= DAMAGE_SMOKE.registerBelow) continue;
      const fraction = () => fractionOf(u);
      const handle = world.effects.damageSmoke(u, fraction, { kind, isShown: () => world.isVisible(u) });
      active.set(u, { handle, fraction });
    }
  }

  /** Ends every handle (new match) */
  clear() {
    for (const entry of this.active.values()) entry.handle.dispose();
    this.active.clear();
    this.tickCounter = 0;
  }

  dispose() { this.clear(); }
}

/** hp / maxHp of any unit; mechs: sum of their parts against stats.hp (no allocation) */
function fractionOf(u) {
  if (u.isMech) {
    let hp = 0;
    let max = u.stats?.hp ?? 0;
    const parts = u.parts;
    if (!parts) return 1;
    for (const k in parts) {
      const p = parts[k];
      hp += Math.max(0, p.hp ?? 0);
      if (!u.stats?.hp) max += p.maxHp ?? 0;
    }
    return max > 0 ? hp / max : 1;
  }
  return u.maxHp > 0 ? u.hp / u.maxHp : 1;
}
