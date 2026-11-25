// Steel Men – cloaking and detection (simulation, deterministic; FogOfWar.canTeamSee asks hiddenFrom).
//
// Cloak = ability { type: STEALTH.abilityType, whileMoving?, duration?, cooldown?, breaksOnAttack? } of a unit
// (vehicle stats, a mech's composed part abilities – Camo torso). A unit is cloaked (unit.cloaked) while it is alive,
// outside, not disabled, crewed (mechs), not attacking and not revealed by its last shot (rules.stealth.revealAfterFire);
// moving keeps it only with whileMoving or the team rule stealth.cloakWhileMoving > 0 (research, e.g. phaseCloak).
// With `duration` the cloak lasts at most that long, then needs `cooldown` seconds; breaksOnAttack also starts the
// cooldown when it fires.
// Detection = ability { type: STEALTH.detectionType, radius } (finished powered buildings, crewed mechs, vehicles) or
// the stat STEALTH.designationStat (target designation): enemies within radius (+ their body radius) are detected for
// the detector's alliance (unit.detectedMask, bit = 1 << allianceLeader). A cloaked enemy is invisible and cannot be
// targeted (World.canSee → FogOfWar.canTeamSee, Combat.canFireAt) by teams that do not detect it; splash still hits.
// Updated every STEALTH.updateTicks ticks (tick modulo) plus at once when a unit fires (noteFired). No allocation.
import { getStats, teamRule } from '../data/Stats.js';
import { STEALTH, AURAS, SIM } from '../config.js';
import { areAllies } from './Alliances.js';
import { teamBit } from './Auras.js';

export class Stealth {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    this.detectors = [];       // units that detect (reused, cleared after each update)
    this.detectRadius = [];    // their radius (parallel array)
    this.moveRule = [];        // team -> rules.stealth.cloakWhileMoving (refreshed every AURAS.ruleRefreshTicks)
    this.ruleTick = -Infinity;
    this.cloakedCount = 0;     // cloaked units after the last update (0 = detection skipped)
  }

  /** Called every tick from World.update */
  update() {
    const tick = this.world.tick;
    if (tick % STEALTH.updateTicks !== 0) return;
    if (tick - this.ruleTick >= AURAS.ruleRefreshTicks || tick < this.ruleTick) this.#refreshRules(tick);
    const dt = STEALTH.updateTicks / SIM.tickRate;
    const w = this.world;
    let count = 0;
    count += this.#cloakList(w.mechs, dt);
    count += this.#cloakList(w.vehicles, dt);
    this.cloakedCount = count;
    if (count > 0) this.#detect();
  }

  /**
   * A unit fires (Combat.releaseAttack): it stays visible for rules.stealth.revealAfterFire seconds; a cloak with
   * breaksOnAttack starts its cooldown.
   */
  noteFired(unit) {
    if (!unit || !this.world) return;
    const reveal = getStats().rules.stealth?.revealAfterFire ?? 0;
    unit.revealedUntil = this.world.tick + Math.ceil(reveal * SIM.tickRate);
    if (unit.cloaked) {
      const a = cloakAbility(unit);
      if (a?.breaksOnAttack && a.cooldown > 0) unit.cloakCooldown = a.cooldown;
      unit.cloakTime = 0;
    }
    unit.cloaked = false;
  }

  /** Is the unit hidden from `team` now? (cloaked, an enemy of team, not detected by team's alliance) */
  hiddenFrom(team, unit) {
    return unit?.cloaked === true && !areAllies(unit.team, team) && ((unit.detectedMask ?? 0) & teamBit(team)) === 0;
  }

  /** Is the unit cloaked (own visuals: shimmer)? */
  isCloaked(unit) { return unit?.cloaked === true; }

  /** Does `team` detect the cloaked unit? (false for a unit that is not cloaked) */
  isDetected(team, unit) { return unit?.cloaked === true && ((unit.detectedMask ?? 0) & teamBit(team)) !== 0; }

  /** Has the unit a cloak at all (UI: show the cloak state)? */
  canCloak(unit) { return Boolean(cloakAbility(unit)); }

  /** Detection radius of a unit (0 = none) – UI range circles, AI */
  detectionRadius(unit) { return detectionOf(unit); }

  dispose() {
    this.detectors.length = 0;
    this.detectRadius.length = 0;
  }

  // ---------- internal ----------

  #refreshRules(tick) {
    this.ruleTick = tick;
    const n = this.world.economy?.races?.length ?? this.world.research?.races?.length ?? 0;
    this.moveRule.length = n;
    for (let team = 0; team < n; team++) this.moveRule[team] = teamRule(team, 'stealth.cloakWhileMoving') ?? 0;
  }

  // Cloak state of one unit list; returns how many are cloaked
  #cloakList(list, dt) {
    let count = 0;
    const tick = this.world.tick;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      const a = cloakAbility(u);
      if (!a) { if (u.cloaked) u.cloaked = false; continue; }
      if (u.cloakCooldown > 0) u.cloakCooldown = Math.max(0, u.cloakCooldown - dt);
      let ok = !u.destroyed && !u.removed && !u.inside && !u.status?.disabled && !(u.isMech && !u.crew)
        && !((u.attackLock ?? 0) > 0) && !((u.revealedUntil ?? -1) > tick) && !(u.cloakCooldown > 0);
      if (ok && (u.speed ?? 0) > STEALTH.moveEpsilon && a.whileMoving !== true && !((this.moveRule[u.team] ?? 0) > 0)) ok = false;
      if (ok && a.duration > 0) {
        u.cloakTime = (u.cloaked ? u.cloakTime ?? 0 : 0) + dt;
        if (u.cloakTime > a.duration) { ok = false; u.cloakCooldown = a.cooldown ?? 0; u.cloakTime = 0; }
      } else if (!ok) u.cloakTime = 0;
      u.cloaked = ok;
      if (!ok) u.detectedMask = 0;
      else count++;
    }
    return count;
  }

  // Detection masks of the cloaked units (detectors collected once per update)
  #detect() {
    const w = this.world;
    const dets = this.detectors;
    const radii = this.detectRadius;
    dets.length = 0;
    radii.length = 0;
    collect(w.structures, dets, radii);
    collect(w.mechs, dets, radii);
    collect(w.vehicles, dets, radii);
    markList(w.mechs, dets, radii);
    markList(w.vehicles, dets, radii);
    dets.length = 0; // no references kept between updates
    radii.length = 0;
  }
}

/** Cloak ability of a unit (first one), or null – no allocation */
export function cloakAbility(unit) {
  const list = unit?.stats?.abilities;
  if (!list) return null;
  for (let i = 0; i < list.length; i++) if (list[i].type === STEALTH.abilityType) return list[i];
  return null;
}

/** Detection radius of a unit right now (largest detection ability or designation range; 0 = none) */
function detectionOf(u) {
  if (!u || u.destroyed || u.removed || u.inside || !u.stats) return 0;
  if (u.isStructure && (!u.complete || u.powered === false)) return 0;
  if (u.isMech && !u.crew) return 0;
  let r = u.stats[STEALTH.designationStat] ?? 0;
  const list = u.stats.abilities;
  if (list) for (let i = 0; i < list.length; i++) if (list[i].type === STEALTH.detectionType && list[i].radius > r) r = list[i].radius;
  return r;
}

function collect(list, dets, radii) {
  for (let i = 0; i < list.length; i++) {
    const r = detectionOf(list[i]);
    if (r > 0) { dets.push(list[i]); radii.push(r); }
  }
}

function markList(list, dets, radii) {
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (!u.cloaked) continue;
    let mask = 0;
    const body = u.radius ?? 0;
    for (let k = 0; k < dets.length; k++) {
      const d = dets[k];
      if (areAllies(d.team, u.team)) continue;
      const reach = radii[k] + body;
      const dx = u.position.x - d.position.x;
      const dz = u.position.z - d.position.z;
      if (dx * dx + dz * dz <= reach * reach) mask |= teamBit(d.team);
    }
    u.detectedMask = mask;
  }
}
