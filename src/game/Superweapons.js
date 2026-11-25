// Steel Men – [A9-F3] superweapons (docs/notes/a9-f3-superweapons.md, docs/roadmap/05-research-t2.md 2d).
// A finished structure with a stats `superweapon` block charges for `chargeTime` s, drawing `chargeEnergyPerSecond`
// (without the energy the charge stands still: 'stalled'), then it is 'ready'. The command launchSuperweapon
// (commands/superweaponCommands.js) fires it at any point of the map: everybody gets a warning at once, the impact
// comes `warningTime` s later, then the building charges again ('cooldown' between launch and impact).
// One superweapon per team in total (Stats.superweaponLimit, buildCommands.checkRules).
//
// Simulation (deterministic): world.superweapons.update(dt) runs every tick after Economy.update (charge energy, power-off
// of buildings hit by a phase charge overrides Economy's structure.powered); strikes are kept in launch order.
// State of a building: structure.superweapon = { charge (s), ratio 0..1, state } (created by Structure.setup).
//
// Events (visual / UI only – never change the simulation from a listener; payload objects are reused: copy what you keep):
//   on('warning', fn)  at launch      { strike }  (strike: see activeStrikes)
//   on('launch', fn)   flight starts  { kind, race, team, from: Vector3, to: Vector3, flightTime, radius, seed }  (SuperweaponFx.launch)
//   on('impact', fn)   impact         { kind, race, team, at: Vector3, radius, seed }                       (SuperweaponFx.impact)
//   on() returns an unsubscribe function.
import * as THREE from 'three';
import { getStats, superweaponLimit } from '../data/Stats.js';
import { dealDamage } from './Combat.js';
import { statusOf } from './StatusEffects.js';
import { SUPERWEAPON, RESEARCH_A9, SIM } from '../config.js';
import './commands/superweaponCommands.js'; // registers the launch command wherever the system exists

/** Charge states (also the `state` handed to procModel.setCharge, docs/notes/b3-common.md) */
export const SW_STATE = Object.freeze({ charging: 'charging', stalled: 'stalled', ready: 'ready', cooldown: 'cooldown' });

/** Initial charge state of a superweapon building (Structure.setup) */
export function createChargeState() {
  return { charge: 0, ratio: 0, state: SW_STATE.charging };
}

/** Is this structure (stats) a superweapon? */
export const isSuperweaponStructure = (s) => Boolean(s?.stats?.superweapon);

/** Lobby / settings value → boolean (missing or anything but false = on) */
export const superweaponsFromSettings = (settings) => settings?.[RESEARCH_A9.superweaponsSetting] !== false;

// Reused event payloads (no allocation per event; listeners copy what they keep)
const WARNING_EVENT = { strike: null };
const LAUNCH_EVENT = { kind: '', race: '', team: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), flightTime: 0, radius: 0, seed: 0 };
const IMPACT_EVENT = { kind: '', race: '', team: 0, at: new THREE.Vector3(), radius: 0, seed: 0 };

export class Superweapons {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    // Strikes between launch and impact, launch order:
    // { id, kind, race, team, source (eid), x, z, radius, launchTick, flightTick, impactTick, seed, flying }
    this.strikes = [];
    this.nextStrikeId = 1;
    this.listeners = { warning: new Set(), launch: new Set(), impact: new Set() };
  }

  // ---------- events ----------

  /** Subscribes to 'warning' | 'launch' | 'impact'; returns the unsubscribe function */
  on(type, fn) {
    const set = this.listeners[type];
    if (!set) throw new Error(`Superweapons: unknown event '${type}'`);
    set.add(fn);
    return () => set.delete(fn);
  }

  #emit(type, payload) {
    for (const fn of this.listeners[type]) {
      try { fn(payload); } catch (err) { console.error(`[Superweapons] ${type} listener failed`, err); }
    }
  }

  // ---------- queries (UI F4a, AI F4b) ----------

  /** Match option: superweapons exist (Research.superweaponsEnabled is the one place reading world.settings) */
  get enabled() {
    const r = this.world.research;
    return r?.superweaponsEnabled ? r.superweaponsEnabled() : this.world.settings?.[RESEARCH_A9.superweaponsSetting] !== false;
  }

  /** The team's superweapon building (finished or not, alive), or null */
  buildingOf(team) {
    for (const s of this.world.structures) {
      if (s.team === team && !s.dead && !s.removed && s.stats?.superweapon) return s;
    }
    return null;
  }

  /** Number of the team's superweapon buildings (finished or not) – limit check */
  countOf(team) {
    let n = 0;
    for (const s of this.world.structures) if (s.team === team && !s.dead && !s.removed && s.stats?.superweapon) n++;
    return n;
  }

  /** May the team place another superweapon? (Stats.superweaponLimit, buildings under construction count) */
  canBuildMore(team) { return this.countOf(team) < superweaponLimit(); }

  /** { state, ratio, charge, chargeTime } of a superweapon building, or null */
  stateOf(structure) {
    const sw = structure?.superweapon;
    if (!sw) return null;
    return { state: sw.state, ratio: sw.ratio, charge: sw.charge, chargeTime: structure.stats.superweapon.chargeTime };
  }

  /** The team's finished superweapon is ready to launch */
  isReady(team) {
    const s = this.buildingOf(team);
    return Boolean(s && this.canLaunch(s));
  }

  /** Can this building be launched now (finished, alive, ready, option on)? */
  canLaunch(structure) {
    return Boolean(this.enabled && structure && !structure.dead && !structure.removed && structure.complete
      && !structure.status?.poweredOff && structure.superweapon?.state === SW_STATE.ready); // [A9] phase-charged = no launch
  }

  /** New match: no strike survives and ids start over (deterministic per match) */
  reset() {
    this.strikes.length = 0;
    this.nextStrikeId = 1;
  }

  /**
   * Strikes on the way (warning running), launch order. Read-only objects:
   * { id, kind, race, team, source, x, z, radius, launchTick, impactTick, seed } – seconds left: timeLeft(strike).
   */
  activeStrikes() { return this.strikes; }

  /** Seconds until a strike hits */
  timeLeft(strike) { return Math.max(0, (strike.impactTick - this.world.tick) / this.#tickRate()); }

  /**
   * First active strike whose impact circle (+ margin) contains the point, or null (AI: units run out of it).
   * No allocation.
   */
  threatAt(x, z, margin = 0) {
    for (const s of this.strikes) {
      const r = s.radius + margin;
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz <= r * r) return s;
    }
    return null;
  }

  // ---------- launch (only from the launchSuperweapon command) ----------

  /**
   * Fires a ready superweapon at (x, z). Called by the command executor only (deterministic).
   * @returns {object|null} the strike
   */
  launch(structure, x, z) {
    if (!this.canLaunch(structure)) return null;
    const def = structure.stats.superweapon;
    const tick = this.world.tick;
    const rate = this.#tickRate();
    const warnTicks = Math.max(1, Math.round(def.warningTime * rate));
    const flightTicks = Math.min(warnTicks, Math.max(0, Math.round((def.flightTime ?? def.warningTime) * rate)));
    const strike = {
      id: this.nextStrikeId++,
      kind: structure.unitId,
      race: structure.race,
      team: structure.team,
      source: structure.eid,
      x, z,
      radius: def.radius ?? 0,
      launchTick: tick,
      flightTick: tick + warnTicks - flightTicks,
      impactTick: tick + warnTicks,
      seed: structure.eid * SUPERWEAPON.seedEidFactor + tick,
      flying: false,
    };
    this.strikes.push(strike);
    const sw = structure.superweapon;
    sw.charge = 0;
    sw.ratio = 0;
    sw.state = SW_STATE.cooldown;
    structure.onSuperweaponLaunch?.();
    WARNING_EVENT.strike = strike;
    this.#emit('warning', WARNING_EVENT);
    WARNING_EVENT.strike = null;
    if (strike.flightTick <= tick) this.#startFlight(strike);
    return strike;
  }

  // ---------- per tick ----------

  update(dt) {
    const world = this.world;
    const eco = world.economy;
    for (const s of world.structures) {
      // Phase charge: a hit building stays without power (overrides Economy's structure.powered of this tick)
      const st = s.status;
      if (st && st.powerOffTimer > 0) {
        st.tickPowerOff(dt);
        if (!s.dead) s.powered = false;
      }
      const sw = s.superweapon;
      if (!sw || s.dead || s.removed || !s.complete) continue;
      if (sw.state === SW_STATE.cooldown) {
        if (!this.#hasStrikeFrom(s.eid)) sw.state = SW_STATE.charging; // impact done: charge again
        else continue;
      }
      if (sw.state === SW_STATE.ready) continue;
      const def = s.stats.superweapon;
      const need = (def.chargeEnergyPerSecond ?? 0) * dt;
      if (need > 0 && eco?.accounts?.[s.team]) {
        if (eco.amount(s.team, 'energy') < need) { sw.state = SW_STATE.stalled; continue; }
        eco.add(s.team, 'energy', -need, 'spend');
        if (eco.drainAcc) eco.drainAcc[s.team] += need; // shown in the energy flow of the next tick
      }
      sw.charge = Math.min(def.chargeTime, sw.charge + dt);
      sw.ratio = def.chargeTime > 0 ? sw.charge / def.chargeTime : 1;
      sw.state = sw.charge >= def.chargeTime ? SW_STATE.ready : SW_STATE.charging;
    }
    if (!this.strikes.length) return;
    const tick = world.tick;
    for (const strike of this.strikes) {
      if (!strike.flying && tick >= strike.flightTick) this.#startFlight(strike);
    }
    // Impacts in launch order; a strike is removed before its effects run (a listener sees the final list)
    while (this.strikes.length && this.#firstDue(tick) >= 0) {
      const strike = this.strikes.splice(this.#firstDue(tick), 1)[0];
      this.#impact(strike);
    }
  }

  /** Drops strikes and listeners (match thrown away); the buildings keep their own state */
  dispose() {
    this.strikes.length = 0;
    for (const set of Object.values(this.listeners)) set.clear();
  }

  #firstDue(tick) {
    for (let i = 0; i < this.strikes.length; i++) if (tick >= this.strikes[i].impactTick) return i;
    return -1;
  }

  #hasStrikeFrom(eid) {
    for (const s of this.strikes) if (s.source === eid) return true;
    return false;
  }

  #tickRate() { return SIM.tickRate; }

  #startFlight(strike) {
    strike.flying = true;
    const src = this.world.entityById(strike.source);
    const e = LAUNCH_EVENT;
    e.kind = strike.kind; e.race = strike.race; e.team = strike.team;
    if (src) e.from.set(src.position.x, src.position.y + (src.bodyHeight ?? 0) * SUPERWEAPON.launchHeightFactor, src.position.z);
    else e.from.set(strike.x, this.world.heightAt(strike.x, strike.z), strike.z);
    e.to.set(strike.x, this.world.heightAt(strike.x, strike.z), strike.z);
    e.flightTime = (strike.impactTick - this.world.tick) / this.#tickRate();
    e.radius = strike.radius;
    e.seed = strike.seed;
    this.#emit('launch', e);
  }

  // ---------- impact ----------

  #impact(strike) {
    const world = this.world;
    const def = getStats().structures?.[strike.kind]?.superweapon;
    const e = IMPACT_EVENT;
    e.kind = strike.kind; e.race = strike.race; e.team = strike.team;
    e.at.set(strike.x, world.heightAt(strike.x, strike.z), strike.z);
    e.radius = strike.radius;
    e.seed = strike.seed;
    this.#emit('impact', e);
    if (!def) return;
    // Damage credited to the building (XP / attacker); it may be gone already – the team stays the launcher's
    const attacker = world.entityById(strike.source) ?? { team: strike.team };
    const r = strike.radius;
    // Mechs: the crew dies (neutron) – the mech stays crewless; damage / stun otherwise
    for (const m of world.mechs) {
      if (m.destroyed || m.removed || unitDistance(m, strike) > r) continue;
      if (def.killsCrews) { if (m.crew && !m.bay) killCrew(attacker, m.ejectCrew()); continue; }
      hitUnit(world, attacker, m, def);
    }
    for (const v of world.vehicles) {
      if (v.destroyed || v.removed || unitDistance(v, strike) > r) continue;
      if (def.killsCrews) {
        if (v.airborne) v.destroy(); // a pilot killed in the air: the aircraft crashes
        else v.loseCrew?.();
        continue;
      }
      hitUnit(world, attacker, v, def);
    }
    for (const c of world.crews) {
      if (c.dead || c.removed || c.inside || unitDistance(c, strike) > r) continue;
      if (def.killsCrews) killCrew(attacker, c);
      else hitUnit(world, attacker, c, def);
    }
    for (const s of world.structures) {
      if (s.dead || s.removed || structureDistance(s, strike) > r) continue;
      hitStructure(attacker, s, def);
    }
  }
}

// ---------- effects of one impact ----------

/** Edge distance (XZ) from the strike centre to a unit's circle */
function unitDistance(u, strike) {
  return Math.max(0, Math.hypot(u.position.x - strike.x, u.position.z - strike.z) - (u.radius ?? 0));
}

/** Distance (XZ) from the strike centre to a building's footprint box (world axes) */
function structureDistance(s, strike) {
  const f = s.footprint;
  if (!f) return unitDistance(s, strike);
  const dx = Math.max(0, Math.abs(strike.x - s.position.x) - f.halfX);
  const dz = Math.max(0, Math.abs(strike.z - s.position.z) - f.halfZ);
  return Math.hypot(dx, dz);
}

function hasDamage(dmg) {
  if (!dmg) return false;
  for (const t in dmg) if (dmg[t] > 0) return true;
  return false;
}

function hitUnit(world, attacker, unit, def) {
  if (hasDamage(def.damage)) dealDamage(attacker, unit, def.damage, null);
  if (def.stunUnits > 0 && !unit.destroyed && !unit.removed && !unit.inside) {
    statusOf(unit, world).stun(def.stunUnits, def.stunUnits); // a superweapon stun is longer than rules.effects.stunMaxDuration
  }
}

function hitStructure(attacker, s, def) {
  const world = s.world;
  if (def.destroysWalls && isWallPart(s.stats)) { s.destroy(); return; }
  if (hasDamage(def.damage)) {
    const k = def.structureDamageFactor ?? 1;
    const dmg = k === 1 ? def.damage : scaled(def.damage, k);
    dealDamage(attacker, s, dmg, null);
  }
  if (def.structureHpFraction > 0 && !s.dead) {
    // Loses this share of its max HP whatever its armour: raw damage = wanted HP × (scale + armour) / scale
    const scale = getStats().rules.armorScale ?? 1;
    const armor = Math.max(0, s.stats?.armor?.physical ?? 0);
    dealDamage(attacker, s, { physical: (s.maxHp * def.structureHpFraction * (scale + armor)) / scale }, null);
  }
  if (def.unpowerStructures > 0 && !s.dead && world) {
    statusOf(s, world).powerOff(def.unpowerStructures);
    s.powered = false;
  }
}

/** Wall posts, wall segments and gates (data flags: placement 'wall', gateUpgrade, gate) */
const isWallPart = (stats) => Boolean(stats && (stats.placement === 'wall' || stats.gateUpgrade || stats.gate));

function scaled(dmg, k) {
  const out = {};
  for (const t in dmg) out[t] = dmg[t] * k;
  return out;
}

/** Kills a crew squad on foot whatever its armour (neutron bomb) */
function killCrew(attacker, crew) {
  if (!crew || crew.dead || crew.inside) return;
  dealDamage(attacker, crew, { physical: SUPERWEAPON.lethalDamage }, null);
}
