// Steel Men – combat rules: who can hit whom, engagement range, firing and resolving hits.
// All numbers come from data/stats.json (weapon stats and rules.combat).
import * as THREE from 'three';
import { getStats, applyArmor, teamRule } from '../data/Stats.js';
import { VFX, GENERATOR_BLAST, AUDIO, TARGET_PRIORITY, MELEE_STRUCTURE, AIR, ACCURACY, LOS } from '../config.js';
import { play } from '../audio/Sound.js';
import { applyWeaponEffects } from './StatusEffects.js';
import { areAllies } from './Alliances.js';
import { attacksAllowed } from './PreBuild.js';

const DEG = Math.PI / 180;
const BURST_INTERVAL = 0.08;          // s between shots of one burst (visual spacing)
const COLOR_PHYSICAL = 0xffd27a;
const COLOR_ENERGY = 0x66e0ff;
const EPSILON = 1e-9;                  // numeric guard (not a tuning value)
const NEARLY_VERTICAL = 0.9;           // |dir.y| above this: build the cone basis from another axis (geometry, not tuning)
const ARM_SLOTS = ['leftArm', 'rightArm']; // same as ModularMech.ARM_SLOTS (not imported – circular import)
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
const NO_WEAPONS = Object.freeze([]);  // shared empty list (threatOf: units without weapons)
const FOOTPRINT_BOX = { dirX: 1, dirZ: 0, halfA: 0, halfB: 0 }; // scratch of footprintBox (read at once, never kept)
const SWEEP_NEAR = new THREE.Vector3(); // scratch: nearest wreck point of a sweep
const TRACE_FOUND = [];                 // scratch: candidates of traceUnits
const TRACE_POOL = [];                  // pooled { unit, t, factor } entries of traceUnits

// ---------- queries ----------

/** A unit that can be shot at: alive, in the world, not hidden inside a mech */
export function isTargetable(unit) {
  return !!unit && !!unit.world && !unit.destroyed && !unit.removed && !unit.inside;
}

// ---------- [N7-los] line of sight over tall map obstacles ----------

const _losHit = new THREE.Vector3();

/**
 * Fraction (0..1) along from→to where the segment first enters a tall map obstacle (GameMap.losBlockers) below its top
 * edge, or -1 when the way is clear. A segment that starts inside an obstacle is not blocked by it. Pure geometry.
 */
function losBlockT(world, from, to) {
  const map = world.map;
  if (!LOS.enabled || !map?.losBlockers) return -1;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const dy = to.y - from.y;
  let best = Infinity;
  for (const o of map.losBlockers(world, LOS.minHeight)) {
    const ox = o.x - from.x;
    const oz = o.z - from.z;
    let t0;
    if (o.radius !== undefined) {
      const a = dx * dx + dz * dz;
      if (a < EPSILON) continue;
      const proj = (ox * dx + oz * dz) / a;
      const perp2 = ox * ox + oz * oz - proj * proj * a;
      const r2 = o.radius * o.radius;
      if (perp2 >= r2 || ox * ox + oz * oz < r2) continue;
      t0 = proj - Math.sqrt((r2 - perp2) / a);
    } else {
      let lo = 0;
      let hi = 1;
      let hit = true;
      // x slab, then z slab (inline: no temporary arrays)
      if (Math.abs(dx) < EPSILON) { if (Math.abs(ox) >= o.halfX) hit = false; } else {
        const a = (ox - o.halfX) / dx; const b = (ox + o.halfX) / dx;
        lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
      }
      if (Math.abs(dz) < EPSILON) { if (Math.abs(oz) >= o.halfZ) hit = false; } else {
        const a = (oz - o.halfZ) / dz; const b = (oz + o.halfZ) / dz;
        lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
      }
      if (!hit || lo > hi) continue;
      // starting inside the box (lo stays 0 because the start is within both slabs): not blocked by it
      if (Math.abs(ox) < o.halfX && Math.abs(oz) < o.halfZ) continue;
      t0 = lo;
    }
    if (t0 < 0 || t0 > 1 || t0 >= best) continue;
    if (from.y + dy * t0 <= o.top - LOS.clearance) best = t0; // the ray enters below the top edge
  }
  return best === Infinity ? -1 : best;
}

/** [N7-los] True when no tall map obstacle stands between two points (world coordinates, y = height of the ray) */
export function hasLineOfSight(world, from, to) {
  return losBlockT(world, from, to) < 0;
}

/**
 * [N7-los] Where a shot from→to is stopped by a tall map obstacle: the entry point (written to `out`), or null when the
 * way is clear. Used by releaseAttack; the shot then hits the obstacle and does nothing.
 */
export function losImpact(world, from, to, out = _losHit) {
  const t = losBlockT(world, from, to);
  return t < 0 ? null : out.lerpVectors(from, to, t);
}

const _losFrom = new THREE.Vector3();
const _losTo = new THREE.Vector3();

/** [N7-los] Centre-to-centre line of sight between two units (aircraft fly over: always clear) */
export function clearShot(world, unit, other) {
  if (!LOS.enabled || other.airborne || unit.airborne || !world) return true;
  return hasLineOfSight(world, aimPoint(unit, _losFrom), aimPoint(other, _losTo));
}

/** Different teams that are not allied (src/game/Alliances.js; without alliances = different teams) */
export const areEnemies = (a, b) => !areAllies(a.team, b.team);

/**
 * Distance from a unit's centre to the edge of the target. Units are circles (radius); buildings are measured to
 * their footprint box (a wall segment's box turns with its line), so an attacker standing at a long wall or a wide
 * hall is as close as it looks – the averaged circle radius was far off on the short side of a building.
 */
export function edgeDistance(from, target) {
  const box = footprintBox(target);
  if (box) return boxDistance(from.position, target, box);
  return circleEdgeDistance(from, target);
}

// Centre distance minus the target's radius (the circle every unit and the old building model used)
function circleEdgeDistance(from, target) {
  const d = Math.hypot(target.position.x - from.position.x, target.position.z - from.position.z);
  return Math.max(0, d - (target.radius ?? 0));
}

/**
 * Box of a building in its own axes: { dirX, dirZ, halfA, halfB } (A along dir, B across), or null for other units.
 * Buildings keep an axis-aligned footprint (already swapped for 90° turns); a wall segment (length, halfThick) lies
 * along its yaw – the same direction Walls.segmentShapes uses (cos yaw, −sin yaw).
 */
function footprintBox(target) {
  if (!target.isStructure || !target.footprint) return null;
  const box = FOOTPRINT_BOX; // reused: callers read it at once
  if (typeof target.length === 'number' && typeof target.halfThick === 'number') {
    const yaw = target.rotation.y;
    box.dirX = Math.cos(yaw); box.dirZ = -Math.sin(yaw); box.halfA = target.length / 2; box.halfB = target.halfThick;
    return box;
  }
  box.dirX = 1; box.dirZ = 0; box.halfA = target.footprint.halfX; box.halfB = target.footprint.halfZ;
  return box;
}

// Distance from a point to a box (0 inside)
function boxDistance(p, target, box) {
  const dx = p.x - target.position.x;
  const dz = p.z - target.position.z;
  const a = dx * box.dirX + dz * box.dirZ;
  const b = -dx * box.dirZ + dz * box.dirX;
  return Math.hypot(Math.max(0, Math.abs(a) - box.halfA), Math.max(0, Math.abs(b) - box.halfB));
}

/**
 * Can a melee swing of weapon stats `s` still reach the target? Weapon range × rules.combat.meleeReachFactor, plus
 * MELEE_STRUCTURE.reachBonus against buildings. Against a building the more lenient of box and circle distance counts:
 * an attacker that stopped because it touches the circle (ModularMech's "touching" test) still lands its blow.
 */
export function meleeReaches(attacker, s, target) {
  const reach = s.range * getStats().rules.combat.meleeReachFactor;
  if (!target.isStructure) return edgeDistance(attacker, target) <= reach;
  const d = Math.min(edgeDistance(attacker, target), circleEdgeDistance(attacker, target));
  return d <= reach + MELEE_STRUCTURE.reachBonus;
}

/** Signed angle (rad) between the unit's facing and the direction to a point */
export function angleTo(unit, point) {
  const want = Math.atan2(point.x - unit.position.x, point.z - unit.position.z);
  const diff = want - unit.rotation.y;
  return Math.atan2(Math.sin(diff), Math.cos(diff));
}

/** Weapons may only fire forward: target must be inside the weapon's fire arc */
export function inFireArc(unit, weapon, target) {
  return Math.abs(angleTo(unit, target.position)) <= (weapon.fireArc * DEG) / 2;
}

/**
 * [N7] Can weapon stats `weapon` hit the target's layer? Aircraft (`airborne`) only with "air" in weapon.targets;
 * ground units / buildings with "ground" – enforced only with AIR.enforceGroundTargets (else every weapon hits ground).
 * Missing targets = ["ground"] (defaults.weapon).
 */
export function hitsLayer(weapon, target) {
  const t = weapon.targets;
  if (target.airborne) return Boolean(t?.includes('air'));
  return !AIR.enforceGroundTargets || !t || t.includes('ground');
}

/**
 * [N7] Has the unit any weapon that can hit the target's layer? Units without a weapons list (a guarded point used as
 * viewer) are not restricted. Ground targets never restrict unless AIR.enforceGroundTargets.
 * @param {Array} [weapons]  unit.weapons read once by the caller (loops – the getter builds a new array)
 */
export function canEngage(unit, target, weapons) {
  if (!target.airborne && !AIR.enforceGroundTargets) return true;
  const ws = weapons === undefined ? unit.weapons : weapons;
  if (!ws) return true;
  for (let i = 0; i < ws.length; i++) if (hitsLayer(ws[i].stats ?? ws[i], target)) return true;
  return false;
}

/**
 * [N7] Remembers who shot at a unit (idle units fight back, fog reaction) – but not an aircraft the unit cannot hit,
 * so a tank without anti-air does not chase a jet it can never shoot (UnitCombat / ModularMech fight back blindly).
 */
function noteAttacker(unit, attacker) {
  if (canEngage(unit, attacker)) unit.lastAttacker = attacker;
}

export function inWeaponRange(unit, weapon, target) {
  if (!hitsLayer(weapon, target)) return false; // [N7] ground weapons cannot hit aircraft
  // Melee at a building: as lenient as the swing itself (meleeReaches), so a unit that stopped touching it attacks
  if (weapon.class === 'melee' && target.isStructure) {
    const d = Math.min(edgeDistance(unit, target), circleEdgeDistance(unit, target));
    return d <= weapon.range + MELEE_STRUCTURE.reachBonus && d >= (weapon.minRange ?? 0);
  }
  const d = edgeDistance(unit, target);
  return d <= weapon.range && d >= weapon.minRange;
}

export function canFireAt(unit, weapon, target) {
  return attacksAllowed(unit.world) && isTargetable(target) && areEnemies(unit, target)
    && inWeaponRange(unit, weapon, target) && inFireArc(unit, weapon, target);
}

// ---------- automatic target choice (TARGET_PRIORITY) ----------

/** Damage per second of one weapon (all damage types, whole burst, over attack time + cooldown) */
export function weaponDps(s) {
  if (!s) return 0;
  let dmg = 0;
  const damage = s.damage;
  if (damage) for (const k in damage) dmg += damage[k] || 0;
  const cycle = (s.attackTime ?? 0) + (s.cooldown ?? 0);
  return cycle > 0 ? (dmg * (s.burst ?? 1)) / cycle : 0;
}

/** How dangerous a unit is: summed DPS of its weapons; 0 for a mech without crew (it cannot fight) */
export function threatOf(unit) {
  if (unit.isMech && !unit.crew) return 0;
  let dps = 0;
  const ws = unit.weapons ?? NO_WEAPONS; // (a mech's getter builds the list once per call)
  for (let i = 0; i < ws.length; i++) dps += weaponDps(ws[i].stats);
  return dps;
}

/** Priority class of a target: 0 = can fight back, 1 = unarmed unit, 2 = building / wall without weapons */
export function targetClass(unit) {
  if (threatOf(unit) > 0) return 0;
  return unit.isStructure ? 2 : 1;
}

/** Cost of attacking `other` (lower = better): edge distance + class penalty − threat bonus */
export function targetCost(unit, other, dist = edgeDistance(unit, other)) {
  const threat = threatOf(other);
  const penalty = threat > 0 ? TARGET_PRIORITY.armedPenalty
    : other.isStructure ? TARGET_PRIORITY.structurePenalty : TARGET_PRIORITY.unarmedPenalty;
  const bonus = Math.min(threat * TARGET_PRIORITY.dpsWeight, TARGET_PRIORITY.dpsBonusMax);
  return dist + penalty - bonus;
}

/**
 * Best enemy for an AUTOMATIC attack (never for a player's attack order): same candidates as World.nearestEnemy
 * (enemy, visible to the unit's team, edge distance <= range, filter) but ranked by targetCost – armed units before
 * unarmed ones, walls and plain buildings last, a dangerous unit preferred over a slightly nearer harmless one.
 * Deterministic: world.units order, the first of equal costs wins.
 * @param {object} unit   { position, team } (+ world, or pass `world` – e.g. a guarded point)
 */
export function pickTarget(unit, range, filter = () => true, world = unit.world) {
  let best = null;
  let bestCost = Infinity;
  const ws = unit.weapons ?? null; // [R1] read once (getter allocates); null = not restricted, as in canEngage
  for (const other of world.units) {
    if (!areEnemies(unit, other) || !canEngage(unit, other, ws) || !filter(other) || !world.canSee(unit, other)) continue;
    // [N7] canEngage: aircraft only for units with an anti-air weapon
    // (world.canSee reads only viewer.team – a plain { position, team } works as the viewer)
    const d = edgeDistance(unit, other);
    if (d > range) continue;
    if (!clearShot(world, unit, other)) continue; // [N7-los] not behind a tall map obstacle
    const cost = targetCost(unit, other, d);
    if (cost < bestCost) { best = other; bestCost = cost; }
  }
  return best;
}

/**
 * Automatic attack on a poor target (unarmed / building) while a better class is in sight: returns the better
 * target (TARGET_PRIORITY.retargetClassGap classes better), else null. Player orders (not auto) never switch.
 */
export function betterAutoTarget(unit, order, range) {
  if (order?.type !== 'attack' || !order.auto || !isTargetable(order.target)) return null;
  const cls = targetClass(order.target);
  if (cls === 0) return null;
  const best = pickTarget(unit, range);
  return best && best !== order.target && targetClass(best) <= cls - TARGET_PRIORITY.retargetClassGap ? best : null;
}

/**
 * Distance a mech tries to keep from its target.
 * stance 'melee' -> closest melee weapon range; 'ranged' -> longest ranged weapon range.
 * Falls back to the other group when the mech has no weapon of the preferred kind; null = no weapons.
 */
export function engagementRange(mech, stance) {
  const ws = mech.weapons;
  let minMelee = Infinity;
  let maxRanged = -Infinity;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i].stats;
    if (w.class === 'melee') { if (w.range < minMelee) minMelee = w.range; } else if (w.range > maxRanged) maxRanged = w.range;
  }
  const factor = getStats().rules.combat.approachRangeFactor;
  if (stance === 'melee' && minMelee !== Infinity) return minMelee * factor;
  if (maxRanged !== -Infinity) return maxRanged * factor;
  if (minMelee !== Infinity) return minMelee * factor;
  return null;
}

/** Point to aim at (centre of mass) */
export function aimPoint(unit, out = new THREE.Vector3()) {
  return out.copy(unit.position).setY(unit.position.y + (unit.aimHeight ?? 1));
}

// ---------- firing ----------

/**
 * How a melee clip hits (rules.combat.attackClips): 'sweep' / 'sweepWide' = every enemy in an arc in front,
 * 'slam' = circular shock wave (weapon splashRadius) around the ground point under the target,
 * 'single' = the target only (default, also for clips not listed).
 */
export function clipHitType(clipName) {
  const lists = getStats().rules.combat.attackClips ?? {};
  for (const [type, names] of Object.entries(lists)) if (names.includes(clipName)) return type;
  return 'single';
}

/**
 * Releases one attack of a weapon at a target – called at the weapon's hit moment (hitAt).
 * Melee lands instantly (how depends on the clip played); spread weapons fire pellets in a cone;
 * hitscan weapons draw a tracer; others launch homing projectiles.
 * @param {object} weapon  runtime weapon { part, stats }
 * @param {object} [attack] { hit } – melee hit type of the clip that was played (clipHitType)
 */
export function releaseAttack(world, attacker, weapon, target, { hit = 'single' } = {}) {
  if (!attacksAllowed(world)) return; // [N8] no damage during the pre-build phase
  const s = weapon.stats;
  if (!isTargetable(target) || (attacker.destroyed && s.class === 'melee')) return;
  // A swing misses a target that got pushed / walked out of reach since the attack started
  if (s.class === 'melee' && !meleeReaches(attacker, s, target)) return;
  const color = (s.damage.energy ?? 0) > (s.damage.physical ?? 0) ? COLOR_ENERGY : COLOR_PHYSICAL;

  for (let i = 0; i < s.burst; i++) {
    world.schedule(i * BURST_INTERVAL, () => {
      if (!isTargetable(target)) return;
      if (s.class === 'melee') { play(AUDIO.shotEvents.melee, { position: attacker.position }); resolveMelee(world, attacker, s, target, hit); return; }
      const aim = aimPoint(target);
      const from = weapon.part.muzzlePoint(i); // launch socket of the weapon part, not the part origin
      play(shotEvent(s), { position: from });
      // [N7-los] a tall map obstacle in the way: the shot hits it and does nothing (no damage, no splash)
      if (!attacker.airborne && !target.airborne && losImpact(world, from, aim)) { // aircraft fly over obstacles (as clearShot)
        const stop = _losHit.clone(); // allocation only on a blocked shot
        if (s.projectileSpeed > 0) world.effects.projectile(from, () => stop, s.projectileSpeed, color, () => {}, projectileLook(s));
        else world.effects.tracer(from, stop, s.projectileColor || color);
        return;
      }
      if (s.spread > 0) { firePellet(world, attacker, s, from, aim, color); return; }
      // Hit roll when the shot leaves: a miss flies into the ground beside the target (and may splash there)
      noteAttacker(target, attacker); // lets idle units fight back (even when the shot misses)
      const onTarget = rollHit(world, attacker, s, target);
      let miss = onTarget ? null : missPoint(world, attacker, s, target);
      // A missed shot hits whatever stands in its way (a unit or a wreck) before reaching the ground beside the target
      let victim = null;
      let wreck = null;
      let victimFactor = 1;
      if (miss && ACCURACY.enabled && getStats().rules.combat.accuracy.missHitsInPath) {
        const block = interceptMiss(world, attacker, s, target, from, miss);
        if (block) { miss = block.point; victim = block.unit ?? null; wreck = block.wreck ?? null; victimFactor = block.factor ?? 1; }
      }
      const land = (point) => {
        if (wreck) { resolveWreckImpact(world, attacker, s, wreck, point); return; }
        if (victim && areEnemies(attacker, victim)) noteAttacker(victim, attacker);
        resolveShot(world, attacker, s, victim ?? target, point, from, onTarget || !!victim, victimFactor);
      };
      if (s.projectileSpeed > 0) {
        const homing = () => (isTargetable(target) ? aimPoint(target, _v) : aim);
        world.effects.projectile(from, miss ? () => miss : homing, s.projectileSpeed, color, land, projectileLook(s));
      } else {
        world.effects.tracer(from, miss ?? aim, s.projectileColor || color); // data colour (e.g. laser beams) overrides the damage-type colour
        land(miss ?? aim);
      }
    });
  }
}

// Sound event of a ranged shot (AUDIO.shotEvents): energy weapons, projectile weapons, the rest
function shotEvent(s) {
  if ((s.damage.energy ?? 0) > (s.damage.physical ?? 0)) return AUDIO.shotEvents.energy;
  return s.projectileSpeed > 0 ? AUDIO.shotEvents.projectile : AUDIO.shotEvents.hitscan;
}

// Size and shape of a weapon's projectile (weapon data; shape falls back to the dominant damage type)
function projectileLook(s) {
  const energy = (s.damage.energy ?? 0) > (s.damage.physical ?? 0);
  return {
    size: s.projectileSize ?? 0,
    shape: s.projectileShape || VFX.projectile.defaultShape[energy ? 'energy' : 'physical'],
    color: s.projectileColor || null,
  };
}

/**
 * One shot at a target (hit already rolled): damage and effects on a hit; splash around the impact point
 * (target surface on a hit, the ground beside it on a miss); piercing into units behind. XP for the crew.
 * @param {THREE.Vector3} from  where the shot came from (direction of the pierce)
 */
function resolveShot(world, attacker, s, target, point, from, hit, factor = 1) {
  const score = { dealt: 0, kills: 0 };
  const landed = hit && isTargetable(target);
  if (landed) applyHit(world, attacker, s, target, factor, attacker.position, 1, score);
  // The blast happens on the target's surface facing the shooter, not in its centre (a big mech would swallow it);
  // a near miss on the ground can still catch the target itself
  if (s.splashRadius > 0) {
    explode(world, attacker, s, landed ? surfacePoint(target, point, from) : point, landed ? [target] : [], score);
  }
  if (landed && s.pierce) pierce(world, attacker, s, from, point, target, score);
  awardXp(attacker, score.dealt, score.kills);
}

// All rolls use the world's seeded generator (src/core/Rng.js) – never Math.random (lockstep determinism)
const rollHit = (world, attacker, s, unit) => world.rng.next() < hitChance(s, attacker, unit);

/**
 * Chance (minHitChance … 1) that one shot / blow of weapon stats `s` hits `unit` (rules.combat.accuracy, ACCURACY.enabled):
 *  - melee: accuracy × meleeAccuracyFactor − evasion (no range or movement part);
 *  - ranged: accuracy × rangeFactor − evasion − movingPenalty, where rangeFactor falls linearly from 1 (up to
 *    optimalRangeFactor × range) to longRangeFactor (at the weapon's range) – a weapon may override both with
 *    accuracyOptimalRange / accuracyLongFactor – and the moving penalty is movingPenalty × min(1, target speed ×
 *    flight time / movingRefSize); hitscan weapons and homing missiles (s.homing) have no moving penalty.
 * Target size does not matter. Pure function of positions and data (no rng): the report below and the AI may call it.
 */
export function hitChance(s, attacker, unit) {
  const rules = getStats().rules.combat;
  const evasion = unit.evasion ?? 0;
  if (!ACCURACY.enabled) return THREE.MathUtils.clamp(s.accuracy - evasion, rules.minHitChance, 1);
  const a = rules.accuracy;
  if (s.class === 'melee') return THREE.MathUtils.clamp(s.accuracy * a.meleeAccuracyFactor - evasion, rules.minHitChance, 1);
  const dist = edgeDistance(attacker, unit);
  const optimal = (s.accuracyOptimalRange ?? a.optimalRangeFactor) * s.range;
  const t = s.range > optimal ? THREE.MathUtils.clamp((dist - optimal) / (s.range - optimal), 0, 1) : 0;
  let chance = s.accuracy * THREE.MathUtils.lerp(1, s.accuracyLongFactor ?? a.longRangeFactor, t) - evasion;
  if (s.projectileSpeed > 0 && !(s.homing && a.homingIgnoresMoving)) {
    chance -= a.movingPenalty * Math.min(1, ((unit.speed ?? 0) * (dist / s.projectileSpeed)) / a.movingRefSize);
  }
  return THREE.MathUtils.clamp(chance, rules.minHitChance, 1);
}

/**
 * First unit or wreck a missed shot meets on its way from the muzzle to the miss point (the target itself is
 * excluded – it was missed). Units the shot cannot hurt (own units without friendly fire, wrong layer) are passed.
 * @returns {{ point, unit?, wreck?, factor? }|null}  factor = friendly-fire damage factor of the unit
 */
const MISS_DIR = new THREE.Vector3();  // scratch: direction of a missed shot (interceptMiss)
const MISS_EXCLUDE = [null, null];     // scratch: [attacker, target] of a missed shot
const WRECK_RAY = new THREE.Ray();     // scratch: ray of traceWreck
const WRECK_POINT = new THREE.Vector3();
function interceptMiss(world, attacker, s, target, from, miss) {
  const length = from.distanceTo(miss);
  if (length < EPSILON) return null;
  const dir = MISS_DIR.copy(miss).sub(from).divideScalar(length);
  MISS_EXCLUDE[0] = attacker; MISS_EXCLUDE[1] = target;
  const [unit] = traceUnits(world, attacker, s, from, dir, length, MISS_EXCLUDE, 1);
  MISS_EXCLUDE[0] = MISS_EXCLUDE[1] = null; // do not keep the units alive until the next miss
  const wreck = traceWreck(world, from, dir, unit ? unit.t : length);
  if (wreck) return { point: wreck.point, wreck: wreck.wreck };
  return unit ? { point: unit.point, unit: unit.unit, factor: unit.factor } : null;
}

// A shot that ended on a wreck: damage to it (× 1) and the blast around the impact point
function resolveWreckImpact(world, attacker, s, wreck, point) {
  const score = { dealt: 0, kills: 0 };
  damageWreck(world, wreck, s, 1);
  if (s.splashRadius > 0) explode(world, attacker, s, point, [], score);
  awardXp(attacker, score.dealt, score.kills);
}

/**
 * Console test: hit statistics of a weapon (stats object, e.g. one of mech.weapons[i].stats) against a target at
 * several shares of its range – uses the formula (hitChance) and 'shots' real rolls of world.rng.
 * Changes the rng state: only for tests (steelMen.world is not advanced otherwise). Target speed is read from `target`.
 * @returns {{ rangeShare, distance, chance, hitRate }[]}
 */
export function accuracyReport(world, attacker, s, target, shots = ACCURACY.testShots) {
  const out = [];
  const home = { x: attacker.position.x, z: attacker.position.z };
  const saved = { x: target.position.x, z: target.position.z };
  for (const share of ACCURACY.testRangeSteps) {
    const dist = Math.max(s.minRange ?? 0, s.range * share) + (target.radius ?? 0);
    target.position.x = home.x;
    target.position.z = home.z + dist;
    const chance = hitChance(s, attacker, target);
    let hits = 0;
    for (let i = 0; i < shots; i++) if (world.rng.next() < chance) hits++;
    out.push({ rangeShare: share, distance: dist, chance, hitRate: hits / shots });
  }
  target.position.x = saved.x;
  target.position.z = saved.z;
  return out;
}

// Where a missed shot lands: the ground just beside the target (rules.combat.missScatter beyond its edge, plus
// accuracy.missScatterRangeFactor × the distance, so far shots land farther off)
function missPoint(world, attacker, s, target) {
  const a = world.rng.angle();
  const rules = getStats().rules.combat;
  const far = ACCURACY.enabled ? rules.accuracy.missScatterRangeFactor * edgeDistance(attacker, target) : 0;
  const d = (target.radius ?? 0) + world.rng.next() * (rules.missScatter + far);
  const p = groundPoint(world, { x: target.position.x + Math.sin(a) * d, z: target.position.z + Math.cos(a) * d });
  if (target.airborne) p.y = target.position.y + (target.aimHeight ?? 0); // [N7] a miss at an aircraft bursts in the air
  return p;
}

// Melee hit by clip type: the target always takes the full blow
function resolveMelee(world, attacker, s, target, hit) {
  const score = { dealt: 0, kills: 0 };
  hitTarget(world, attacker, s, target, 1, attacker.position, score);
  if (hit === 'sweep' || hit === 'sweepWide') sweep(world, attacker, s, target, hit === 'sweepWide', score);
  // Only a blow into the ground spreads as a shock wave; other swings of a splash weapon hit the target only
  if (hit === 'slam' && s.splashRadius > 0) {
    const ground = surfacePoint(target, groundPoint(world, target.position), attacker.position); // where the hammer meets the ground
    explode(world, attacker, s, ground, [target], score);
  }
  awardXp(attacker, score.dealt, score.kills);
}

/** Hit roll (accuracy − evasion) and damage × factor on one unit; returns true when it hit */
function hitTarget(world, attacker, s, unit, factor, source, score) {
  noteAttacker(unit, attacker); // lets idle units fight back (even when the shot misses)
  if (world.rng.next() >= hitChance(s, attacker, unit)) return false;
  applyHit(world, attacker, s, unit, factor, source, 1, score);
  return true;
}

// Damage × factor, weapon effects × effectFactor, score for XP (enemies only)
function applyHit(world, attacker, s, unit, factor, source, effectFactor, score) {
  const r = damageUnit(unit, scaleDamage(s.damage, factor), source, getStats().rules.combat);
  if (areEnemies(attacker, unit)) { score.dealt += r.dealt; score.kills += r.killed ? 1 : 0; }
  if (isTargetable(unit)) applyWeaponEffects(world, attacker, s, unit, source, effectFactor);
}

/**
 * Splash around an impact point, measured in 3D to the nearest point of each unit's body (a cylinder),
 * so a blast on a mech's chest barely touches the small units at its feet while a blast on the ground
 * hits them fully. Damage falls from splashDamageFactor at the centre to × splashEdgeFactor at the edge.
 * A blast close to the ground (groundBurstHeight) spreads wider (groundBurstRadiusFactor).
 */
function explode(world, attacker, s, point, exclude, score) {
  const rules = getStats().rules.combat;
  const ground = world.heightAt(point.x, point.z);
  const groundBurst = point.y - ground <= rules.groundBurstHeight;
  const radius = s.splashRadius * (groundBurst ? rules.groundBurstRadiusFactor : 1);
  world.effects.burst(impactVfx(s), groundBurst ? groundPoint(world, point) : point.clone(), {
    size: Math.max(VFX.minImpactSize, radius / VFX.splashReferenceRadius),
  });
  const effectFactor = getStats().rules.effects.splashEffectFactor;
  for (const unit of world.units) {
    if (exclude.includes(unit) || !hitsLayer(s, unit)) continue; // [NQ3] big ground bursts reached flight height
    const ff = sideFactor(world, attacker, unit, s);
    if (ff <= 0) continue;
    const d = distanceToBody(unit, point);
    if (d > radius) continue;
    const falloff = THREE.MathUtils.lerp(1, rules.splashEdgeFactor, d / radius);
    applyHit(world, attacker, s, unit, rules.splashDamageFactor * falloff * ff, point, effectFactor, score);
  }
  // Wrecks lying around (no team, no friendly fire rules): same 3D distance to their real shape
  for (const wreck of world.damageableWrecks) {
    const d = wreck.bounds().distanceToPoint(point);
    if (d > radius) continue;
    damageWreck(world, wreck, s, rules.splashDamageFactor * THREE.MathUtils.lerp(1, rules.splashEdgeFactor, d / radius));
  }
}

/**
 * Death blast of a building (stats.structures[id].explosion, e.g. powerGenerator): hurts everything within
 * `radius` of `origin` – own and other buildings (different damage), units of every team (friendly fire setting
 * is ignored on purpose). Damage falls linearly from full at the centre to × `falloff` at the edge, measured to the
 * nearest point of each body. Generators in range are blown up too when `chainsToGenerators` (their own blast
 * is scheduled by Structure.destroy, so chains never recurse). Deterministic: world.units order, no attacker (no XP).
 */
export function structureBlast(world, source, origin, ex) {
  world.effects.burst(GENERATOR_BLAST.layers, groundPoint(world, origin), {
    size: ex.radius * GENERATOR_BLAST.visualSizePerRadius, heightUnit: GENERATOR_BLAST.heightUnit,
  });
  const type = ex.damageType ?? 'energy';
  const chained = ex.chainsToGenerators ? [] : null;
  for (const unit of world.units) {
    if (unit === source) continue;
    const d = distanceToBody(unit, origin);
    if (d > ex.radius) continue;
    const base = !unit.isStructure ? ex.damageUnits : unit.team === source.team ? ex.damageOwnBuildings : ex.damageOtherBuildings;
    const amount = base * THREE.MathUtils.lerp(1, ex.falloff, d / ex.radius);
    if (amount > 0) dealDamage(null, unit, { [type]: amount }, origin);
    if (chained && unit.isStructure && unit.complete && unit.stats?.explosion?.chainsToGenerators) chained.push(unit);
  }
  if (chained) for (const unit of chained) if (!unit.dead) unit.destroy();
}

/**
 * Damage to a wreck on the ground (arm / legs / torso): weapon damage × factor × rules.wrecks.damageFactor,
 * reduced by the part's armour. At 0 HP the wreck explodes and disappears (World.destroyWreck).
 */
function damageWreck(world, wreck, s, factor) {
  if (!wreck.part.alive) return;
  wreck.part.takeDamage(scaleDamage(s.damage, factor * getStats().rules.wrecks.damageFactor));
  if (!wreck.part.alive) world.destroyWreck(wreck);
}

/** Side swing: every other unit in the arc in front of the attacker within the sweep radius (own hit roll) */
function sweep(world, attacker, s, target, wide, score) {
  const sw = getStats().rules.combat.sweep;
  const arc = (wide ? s.sweepWideArc ?? sw.wideArc : s.sweepArc ?? sw.arc) * DEG;
  const radius = s.sweepRadius ?? s.range * sw.radiusFactor;
  const factor = s.sweepDamageFactor ?? sw.damageFactor;
  const effectFactor = getStats().rules.effects.splashEffectFactor;
  for (const unit of world.units) {
    if (unit === target || !hitsLayer(s, unit)) continue; // [NQ3] a swing does not reach an aircraft above
    const ff = sideFactor(world, attacker, unit, s);
    if (ff <= 0 || edgeDistance(attacker, unit) > radius || Math.abs(angleTo(attacker, unit.position)) > arc / 2) continue;
    if (areEnemies(attacker, unit)) noteAttacker(unit, attacker);
    if (world.rng.next() < hitChance(s, attacker, unit)) applyHit(world, attacker, s, unit, factor * ff, attacker.position, effectFactor, score);
  }
  // Wrecks in the arc get hit for sure (pure geometry: nearest point of the wreck within radius and arc)
  const near = SWEEP_NEAR;
  for (const wreck of world.damageableWrecks) {
    wreck.bounds().clampPoint(attacker.position, near);
    const d = Math.hypot(near.x - attacker.position.x, near.z - attacker.position.z);
    if (d > radius || Math.abs(angleTo(attacker, near)) > arc / 2) continue;
    damageWreck(world, wreck, s, factor);
  }
}

/**
 * Spread weapon (weapon.spread = full cone angle in degrees): one pellet flies from the muzzle in a random
 * direction inside the cone and hits the first unit in its way that it can hurt – a miss may hit another
 * unit behind or beside the target. No hit roll: the cone decides.
 */
function firePellet(world, attacker, s, from, aim, color) {
  const rules = getStats().rules.combat;
  const dir = deviate(world.rng, aim.clone().sub(from).normalize(), (s.spread * DEG) / 2);
  const length = s.range * rules.pelletRangeFactor;
  let [hit] = traceUnits(world, attacker, s, from, dir, length, [attacker], 1);
  // A wreck lying in the way catches the pellet if it is nearer than the first unit
  const wreckHit = traceWreck(world, from, dir, hit ? hit.t : length);
  if (wreckHit) hit = null;
  let end;
  if (hit) end = hit.point;
  else if (wreckHit) end = wreckHit.point;
  else {
    end = from.clone().addScaledVector(dir, length);
    const t = groundHit(world, from, dir, length);
    if (t !== null) end = from.clone().addScaledVector(dir, t);
  }
  world.effects.tracer(from, end, color);
  if (wreckHit) { damageWreck(world, wreckHit.wreck, s, 1); return; }
  if (!hit) return;
  const score = { dealt: 0, kills: 0 };
  if (areEnemies(attacker, hit.unit)) noteAttacker(hit.unit, attacker);
  applyHit(world, attacker, s, hit.unit, hit.factor, from, 1, score);
  awardXp(attacker, score.dealt, score.kills);
}

/** Piercing shot: continues behind the target along the line of fire into up to pierce.count more units */
function pierce(world, attacker, s, from, point, target, score) {
  const p = s.pierce;
  const dir = point.clone().sub(from).normalize();
  const hits = traceUnits(world, attacker, s, point, dir, p.length, [attacker, target], p.count);
  for (const h of hits) applyHit(world, attacker, s, h.unit, p.damageFactor * h.factor, point, 1, score);
  const color = (s.damage.energy ?? 0) > (s.damage.physical ?? 0) ? COLOR_ENERGY : COLOR_PHYSICAL;
  world.effects.tracer(point, hits.at(-1)?.point ?? point.clone().addScaledVector(dir, p.length), s.projectileColor || color);
}

/**
 * Units a ray passes through (bodies = vertical cylinders), nearest first, up to `max`.
 * Units the shot cannot hurt (own units without friendly fire) are passed through.
 * @returns {{ unit, point: THREE.Vector3, factor: number }[]}  factor = friendly-fire damage factor
 */
function traceUnits(world, attacker, s, from, dir, length, exclude, max) {
  const found = TRACE_FOUND; // scratch, entries pooled; only the (small) result escapes
  found.length = 0;
  for (const unit of world.units) {
    if (exclude.includes(unit) || !hitsLayer(s, unit)) continue; // [NQ3] pellets / pierce only hit their layers
    const factor = sideFactor(world, attacker, unit, s);
    if (factor <= 0) continue;
    const t = rayHitsBody(unit, from, dir, length);
    if (t === null) continue;
    const e = TRACE_POOL[found.length] ??= { unit: null, t: 0, factor: 0 };
    e.unit = unit; e.t = t; e.factor = factor;
    found.push(e);
  }
  found.sort(byT);
  const n = Math.min(max, found.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = found[i];
    out[i] = { unit: f.unit, t: f.t, factor: f.factor, point: from.clone().addScaledVector(dir, f.t) };
    f.unit = null; // do not keep units alive in the pool
  }
  for (let i = n; i < found.length; i++) found[i].unit = null;
  return out;
}
const byT = (a, b) => a.t - b.t;

/** Nearest wreck a ray enters within `length` (wreck shape = its bounding box), or null */
function traceWreck(world, from, dir, length) {
  const ray = WRECK_RAY.set(from, dir);
  const p = WRECK_POINT;
  let best = null;
  for (const wreck of world.damageableWrecks) {
    if (!ray.intersectBox(wreck.bounds(), p)) continue;
    const t = p.distanceTo(from);
    if (t <= length && (!best || t < best.t)) best = { wreck, t, point: p.clone() };
  }
  return best;
}

/**
 * Damage factor of a shot against a unit: 1 for enemies; own units (never the attacker itself) only with
 * friendly fire on (world.settings.friendlyFire): artilleryOnly limits it to class 'artillery' weapons,
 * reduced scales it by rules.friendlyFire.reducedFactor.
 */
export function sideFactor(world, attacker, unit, s) {
  if (unit === attacker) return 0;
  if (areEnemies(attacker, unit)) return 1;
  const ff = world.settings?.friendlyFire;
  if (!ff?.enabled) return 0;
  if (ff.artilleryOnly && s.class !== 'artillery') return 0;
  return ff.reduced ? getStats().rules.friendlyFire.reducedFactor : 1;
}

// Impact point moved from the target's centre (aim point) to the edge of its body on the shooter's side
function surfacePoint(target, point, from) {
  const dx = from.x - point.x;
  const dz = from.z - point.z;
  const len = Math.hypot(dx, dz);
  if (len < EPSILON) return point.clone();
  const r = Math.min(target.radius ?? 0, len);
  return new THREE.Vector3(point.x + (dx / len) * r, point.y, point.z + (dz / len) * r);
}

// Height of a unit's body for 3D hit tests (set by ModularMech / Crew on load)
const bodyHeight = (unit) => unit.bodyHeight ?? (unit.aimHeight ?? 1) * 2;

/** 3D distance from a point to a unit's body (vertical cylinder of radius × bodyHeight); 0 inside */
function distanceToBody(unit, p) {
  const base = unit.position.y;
  const top = base + bodyHeight(unit);
  const dxz = Math.max(0, Math.hypot(p.x - unit.position.x, p.z - unit.position.z) - (unit.radius ?? 0));
  const dy = p.y < base ? base - p.y : p.y > top ? p.y - top : 0;
  return Math.hypot(dxz, dy);
}

/** Distance along a ray (unit direction) at which it enters a unit's body, or null */
function rayHitsBody(unit, o, d, length) {
  const r = unit.radius ?? 0;
  const fx = o.x - unit.position.x;
  const fz = o.z - unit.position.z;
  const a = d.x * d.x + d.z * d.z;
  const c = fx * fx + fz * fz - r * r;
  let t0;
  let t1;
  if (a < EPSILON) { // vertical ray
    if (c > 0) return null;
    t0 = 0; t1 = length;
  } else {
    const b = 2 * (fx * d.x + fz * d.z);
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    t0 = Math.max(0, (-b - sq) / (2 * a));
    t1 = Math.min(length, (-b + sq) / (2 * a));
    if (t0 > t1) return null;
  }
  // Inside the circle for t0..t1 – does the height overlap the body there?
  const base = unit.position.y;
  const top = base + bodyHeight(unit);
  const y0 = o.y + d.y * t0;
  if (y0 >= base && y0 <= top) return t0;
  if (Math.abs(d.y) < EPSILON) return null;
  const t = t0 + ((y0 > top ? top : base) - y0) / d.y;
  return t >= t0 && t <= t1 ? t : null;
}

// Distance along a ray at which it reaches the terrain (checked in steps), or null within `length`
function groundHit(world, o, d, length) {
  if (d.y >= 0) return null;
  const step = getStats().rules.combat.pelletGroundStep;
  for (let t = step; t <= length; t += step) {
    const x = o.x + d.x * t;
    const z = o.z + d.z * t;
    if (o.y + d.y * t <= world.heightAt(x, z)) return t;
  }
  return null;
}

/** Random direction inside a cone of half-angle `half` (rad) around `dir` (uniform over the cone's disc) */
function deviate(rng, dir, half) {
  const side = Math.abs(dir.y) < NEARLY_VERTICAL ? UP : RIGHT; // any axis not parallel to dir
  const u = new THREE.Vector3().crossVectors(dir, side).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u);
  const r = Math.tan(half) * Math.sqrt(rng.next());
  const a = rng.angle();
  return dir.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r).normalize();
}

function scaleDamage(damage, k) {
  const out = {};
  for (const t in damage) out[t] = damage[t] * k;
  return out;
}

/**
 * Damage outside a weapon shot (burning, later abilities): hits a random part / the squad, gives XP.
 * @returns {{ dealt: number, killed: boolean }}
 */
export function dealDamage(attacker, unit, damage, source) {
  if (!isTargetable(unit)) return { dealt: 0, killed: false };
  const r = damageUnit(unit, damage, source, getStats().rules.combat);
  if (attacker && areEnemies(attacker, unit)) awardXp(attacker, r.dealt, r.killed ? 1 : 0);
  return r;
}

function awardXp(attacker, dealt, kills) {
  const xp = getStats().experience;
  // A mech's crew gets the XP; units without a crew slot (armed vehicles) keep it themselves
  const learner = attacker?.crew !== undefined ? attacker.crew : attacker;
  learner?.addXp?.(dealt * xp.xpPerDamage + kills * xp.xpPerKill);
}

// Energy / stun weapons get the blue EMP blast, the rest a fireball
function impactVfx(s) {
  const stuns = s.effects?.some((e) => e.type === 'stun');
  return stuns || (s.damage.energy ?? 0) > (s.damage.physical ?? 0) ? VFX.energyImpact : VFX.splashImpact;
}

const groundPoint = (world, p) => new THREE.Vector3(p.x, world.heightAt(p.x, p.z), p.z);

/** Applies damage to a mech (random hit location) or a crew squad */
function damageUnit(unit, damage, source, rules) {
  const wasAlive = !unit.destroyed;
  if (!unit.isMech) {
    const dealt = unit.takeDamage(damage, source);
    return { dealt, killed: wasAlive && unit.destroyed };
  }
  const part = pickHitPart(unit, rules.hitLocationWeights);
  if (!part) return { dealt: 0, killed: false };
  const dealt = damageMechPart(unit, part, damage, source, rules);
  return { dealt, killed: wasAlive && unit.destroyed };
}

/**
 * Damage to one part of a mech by the part-damage rules (data/README.md, "Part damage"):
 *  - an arm hit damages only that arm; at 0 HP the arm stays mounted but broken (no weapons). [R1] Every further
 *    hit on a broken arm tears it off with chance rules.combat.brokenArmDetachChance (team rule – research may
 *    lower it) and its damage is redirected into the torso (as a torso hit);
 *  - [R1] a hit that removes HP interrupts the crew's field repair (ModularMech.stopRepair);
 *  - a torso / legs hit never takes that part below damageSyncThreshold × max HP while some arm is above
 *    it: the rest spills into those arms (also down to the threshold at most);
 *  - whatever is left after that is spread over all mounted parts (torso, legs, remaining arms) so that
 *    they all lose the same share of their max HP – they go down together.
 * Armour of the hit part reduces the damage once; spilled damage is plain HP.
 * @returns {number} HP removed in total (for XP)
 */
export function damageMechPart(mech, part, damage, source, rules = getStats().rules.combat) {
  const dealt = hitMechPart(mech, part, damage, source, rules);
  // [R1] a hit that lands interrupts the crew's field repair (a vehicle repair goes on – the vehicle owns it)
  if (dealt > 0 && mech.repairing && !mech.repairExternal && !mech.destroyed) mech.stopRepair();
  return dealt;
}

function hitMechPart(mech, part, damage, source, rules) {
  if (!part.alive) {
    if (!part.isArm || part.mech !== mech || mech.destroyed) return 0;
    // [R1] Broken arm still hanging on the mech: the hit may tear it off (seeded – simulation state) and its damage
    // goes on into the torso (torso armour) – a broken arm is no shield
    if (mech.world && mech.world.rng.next() < teamRule(mech.team, 'combat.brokenArmDetachChance')) mech.detachArm(part.slot);
    const torso = mech.parts.torso;
    return torso?.alive ? hitMechPart(mech, torso, damage, source, rules) : 0;
  }
  const amount = applyArmor(damage, part.stats.armor).total;
  const loss = new Map(); // part -> HP to remove
  if (part.isArm) {
    loss.set(part, Math.min(amount, part.hp));
  } else {
    const t = rules.damageSyncThreshold;
    let rest = drainEvenly([part], amount, t, loss);
    const healthyArms = ARM_SLOTS.map((s) => mech.parts[s]).filter((a) => a?.alive && a.hp > a.maxHp * t);
    rest = drainEvenly(healthyArms, rest, t, loss);
    // The other body part (legs for a torso hit…) comes down to the threshold too, so all parts meet there
    const otherBody = ['torso', 'legs'].map((k) => mech.parts[k]).filter((p) => p?.alive && p !== part);
    rest = drainEvenly(otherBody, rest, t, loss);
    drainEvenly(Object.values(mech.parts).filter((p) => p.alive), rest, 0, loss);
  }
  // Arms first: a torso / legs breaking destroys the mech, which drops the arms as wrecks with their HP
  const order = [...loss.keys()].sort((a, b) => (b.isArm ? 1 : 0) - (a.isArm ? 1 : 0));
  let dealt = 0;
  for (const p of order) if (p.mech === mech) dealt += p.loseHp(loss.get(p), source);
  return dealt;
}

/**
 * Takes `amount` HP from the parts so that each loses the same share of its max HP, none going below
 * floor × max HP (counting HP already booked in `loss`). Books the result in `loss`; returns what is left.
 */
function drainEvenly(parts, amount, floor, loss) {
  let rest = amount;
  let open = parts.filter((p) => p.hp - (loss.get(p) ?? 0) > p.maxHp * floor + EPSILON);
  while (rest > EPSILON && open.length) {
    const totalMax = open.reduce((s, p) => s + p.maxHp, 0);
    // Share of max HP every open part loses this round – limited by the part closest to its floor
    const room = (p) => p.hp - (loss.get(p) ?? 0) - p.maxHp * floor;
    const share = Math.min(rest / totalMax, ...open.map((p) => room(p) / p.maxHp));
    for (const p of open) {
      const take = share * p.maxHp;
      loss.set(p, (loss.get(p) ?? 0) + take);
      rest -= take;
    }
    open = open.filter((p) => room(p) > EPSILON);
  }
  return Math.max(0, rest);
}

function pickHitPart(mech, weights) {
  const options = Object.entries(mech.parts).filter(([slot]) => weights[slot] > 0);
  const total = options.reduce((acc, [slot]) => acc + weights[slot], 0);
  let roll = mech.world.rng.next() * total;
  for (const [slot, part] of options) {
    roll -= weights[slot];
    if (roll <= 0) return part;
  }
  return options.at(-1)?.[1] ?? null;
}
