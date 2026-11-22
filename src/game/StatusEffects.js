// Steel Mans – on-hit weapon effects (weapon.effects in stats.json): stun, knockback, burn.
// Each unit hit by an effect gets a UnitStatus (unit.status); World.update ticks all of them.
// Balance numbers are in stats.json → rules.effects, visuals in config.js → VFX.
import { getStats } from '../data/Stats.js';
import { MOVEMENT, VFX } from '../config.js';

/**
 * Applies a weapon's effects to a unit it hit.
 * @param {object} world
 * @param {object} attacker  unit that fired (gets XP for burn damage)
 * @param {object} weapon    weapon stats (effects[], id)
 * @param {object} unit      unit that was hit
 * @param {{x:number,z:number}} from  where the hit came from (knockback pushes away from it)
 * @param {number} [factor]  strength multiplier (splash hits use rules.effects.splashEffectFactor)
 */
export function applyWeaponEffects(world, attacker, weapon, unit, from, factor = 1) {
  if (!weapon.effects?.length || unit.destroyed || unit.inside) return;
  const status = (unit.status ??= new UnitStatus(unit, world));
  for (const e of weapon.effects) {
    if (e.type === 'stun') status.stun(e.duration * factor);
    else if (e.type === 'knockback') status.knockback(e.force * factor, from);
    else if (e.type === 'burn') status.burn(attacker, weapon.id, e, factor);
    else console.warn(`[StatusEffects] Unknown effect type "${e.type}" on ${weapon.id}`);
  }
}

/** Ticks the statuses of all units (call once per frame, before collisions) */
export function updateStatusEffects(world, units, dt) {
  for (const unit of units) unit.status?.update(dt);
}

export class UnitStatus {
  constructor(unit, world) {
    this.unit = unit;
    this.world = world;
    this.stunTimer = 0;
    this.vx = 0;          // knockback velocity (units/s)
    this.vz = 0;
    this.burns = new Map(); // `${attacker.uuid}/${weaponId}` -> { attacker, dps, timeLeft, tick }
    this.stunFx = null;
    this.burnFx = null;
  }

  /** Cannot move, turn or attack */
  get stunned() { return this.stunTimer > 0; }
  /** Being thrown back – own movement is suspended until the push dies out */
  get knockedBack() { return this.vx !== 0 || this.vz !== 0; }
  get burning() { return this.burns.size > 0; }
  /** Unit may not act this frame (no movement, no new attacks) */
  get disabled() { return this.stunned; }

  // ---------- applying ----------

  stun(duration) {
    const rules = getStats().rules.effects;
    // Overlapping stuns do not add up: the longer one wins (capped, so EMP chains cannot lock a unit forever)
    this.stunTimer = Math.min(rules.stunMaxDuration, Math.max(this.stunTimer, duration));
    if (!this.stunFx) this.stunFx = this.world.effects.attach(VFX.stunIndicator, this.unit, this.#fxScale());
  }

  /**
   * Pushes the unit away from `from`. Initial speed = force × knockbackSpeedPerForce × referenceMass / mass,
   * reduced by the stability ability (knockbackResist 1 = immune).
   */
  knockback(force, from) {
    const rules = getStats().rules.effects;
    const unit = this.unit;
    const resist = Math.min(1, (unit.stats?.abilities ?? [])
      .filter((a) => a.type === 'stability')
      .reduce((acc, a) => acc + (a.knockbackResist ?? 0), 0));
    if (resist >= 1) return;
    // Mechs and vehicles use the mass from their stats; crew squads a fixed one
    const mass = unit.isMech ? (unit.stats?.mass ?? rules.knockbackReferenceMass)
      : unit.isVehicle ? (unit.stats?.mass ?? rules.knockbackReferenceMass) : rules.knockbackCrewMass;
    let speed = force * rules.knockbackSpeedPerForce * (rules.knockbackReferenceMass / mass) * (1 - resist);
    let dx = unit.position.x - from.x;
    let dz = unit.position.z - from.z;
    let len = Math.hypot(dx, dz);
    if (len < MOVEMENT.overlapEpsilon) { // hit dead centre – push along the unit's back
      dx = -Math.sin(unit.rotation.y); dz = -Math.cos(unit.rotation.y); len = 1;
    }
    // Several pushes add up, but never beyond the max speed
    this.vx += (dx / len) * speed;
    this.vz += (dz / len) * speed;
    const total = Math.hypot(this.vx, this.vz);
    if (total > rules.knockbackMaxSpeed) {
      speed = rules.knockbackMaxSpeed / total;
      this.vx *= speed; this.vz *= speed;
    }
  }

  /** Same weapon of the same attacker refreshes its burn; different sources stack */
  burn(attacker, weaponId, effect, factor) {
    const key = `${attacker.uuid}/${weaponId}`;
    const dps = Object.fromEntries(Object.entries(effect.damagePerSecond ?? {}).map(([t, v]) => [t, v * factor]));
    const old = this.burns.get(key);
    this.burns.set(key, { attacker, dps, timeLeft: effect.duration, tick: old?.tick ?? 0 });
    if (!this.burnFx) this.burnFx = this.world.effects.attach(VFX.burnIndicator, this.unit, this.#fxScale());
  }

  // ---------- per frame ----------

  update(dt) {
    const unit = this.unit;
    if (unit.destroyed || unit.removed || unit.inside) { this.clear(); return; }
    if (this.stunTimer > 0 && (this.stunTimer -= dt) <= 0) {
      this.stunTimer = 0;
      this.stunFx?.dispose();
      this.stunFx = null;
    }
    if (this.knockedBack) this.#slide(dt);
    if (this.burning) this.#tickBurns(dt);
  }

  /** Removes all statuses and their visuals (unit died, boarded a mech…) */
  clear() {
    this.stunTimer = 0;
    this.vx = this.vz = 0;
    this.burns.clear();
    this.stunFx?.dispose();
    this.burnFx?.dispose();
    this.stunFx = this.burnFx = null;
  }

  // Moves the unit along the knockback velocity, slowing down by knockbackFriction.
  // Static obstacles (crewless mechs, later buildings – world.nav) stop the slide; other units are
  // pushed apart by the normal collision step afterwards. The unit re-plans its path when it lands.
  #slide(dt) {
    const rules = getStats().rules.effects;
    const unit = this.unit;
    if (unit.inFlight) { this.vx = this.vz = 0; return; } // [R2] a jet flight keeps its course – no knockback
    const world = this.world;
    const speed = Math.hypot(this.vx, this.vz);
    const step = speed * dt;
    const to = { x: unit.position.x + this.vx * dt, z: unit.position.z + this.vz * dt };
    const shapes = world.nav.shapesFor(unit.radius, [unit]);
    const limit = world.nav.half - unit.radius;
    const inside = Math.abs(to.x) <= limit && Math.abs(to.z) <= limit;
    // [NQ3] aircraft fly over obstacles (only the map edge stops them) and keep their altitude
    if (step > 0 && inside && (unit.airborne || world.nav.segmentClear(unit.position, to, shapes))) {
      unit.position.x = to.x;
      unit.position.z = to.z;
      if (unit.airborne) unit.snapToGround();
      else unit.position.y = world.heightAt(to.x, to.z);
      const slower = Math.max(0, speed - rules.knockbackFriction * dt);
      const k = speed > 0 ? slower / speed : 0;
      this.vx *= k; this.vz *= k;
    } else {
      this.vx = this.vz = 0; // hit an obstacle or the map edge
    }
    if (!this.knockedBack && unit.order) {
      unit.order.nav = null;      // position jumped – plan the path again from here
      unit.order.best = undefined; // and restart the "stuck" check
    }
    if (unit.speed !== undefined) unit.speed = 0;
  }

  #tickBurns(dt) {
    const interval = getStats().rules.effects.burnTickInterval;
    for (const [key, b] of this.burns) {
      b.timeLeft -= dt;
      b.tick += dt;
      while (b.tick >= interval) {
        b.tick -= interval;
        const damage = Object.fromEntries(Object.entries(b.dps).map(([t, v]) => [t, v * interval]));
        this.world.dealDamage(b.attacker, this.unit, damage, null);
        if (this.unit.destroyed || this.unit.removed) { this.clear(); return; }
      }
      if (b.timeLeft <= 0) this.burns.delete(key);
    }
    if (!this.burning) { this.burnFx?.dispose(); this.burnFx = null; }
  }

  #fxScale() { return this.unit.isMech ? 1 : VFX.crewIndicatorScale; }
}
