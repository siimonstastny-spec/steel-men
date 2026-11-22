// Steel Mans – combat rules: who can hit whom, engagement range, firing and resolving hits.
// All numbers come from data/stats.json (weapon stats and rules.combat).
import * as THREE from 'three';
import { getStats, applyArmor, teamRule } from '../data/Stats.js';
import { VFX, AUDIO, TARGET_PRIORITY, MELEE_STRUCTURE, AIR } from '../config.js';
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

// ---------- queries ----------

/** A unit that can be shot at: alive, in the world, not hidden inside a mech */
export function isTargetable(unit) {
  return !!unit && !!unit.world && !unit.destroyed && !unit.removed && !unit.inside;
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
  if (typeof target.length === 'number' && typeof target.halfThick === 'number') {
    const yaw = target.rotation.y;
    return { dirX: Math.cos(yaw), dirZ: -Math.sin(yaw), halfA: target.length / 2, halfB: target.halfThick };
  }
  return { dirX: 1, dirZ: 0, halfA: target.footprint.halfX, halfB: target.footprint.halfZ };
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
  for (const v of Object.values(s.damage ?? {})) dmg += v || 0;
  const cycle = (s.attackTime ?? 0) + (s.cooldown ?? 0);
  return cycle > 0 ? (dmg * (s.burst ?? 1)) / cycle : 0;
}

/** How dangerous a unit is: summed DPS of its weapons; 0 for a mech without crew (it cannot fight) */
export function threatOf(unit) {
  if (unit.isMech && !unit.crew) return 0;
  let dps = 0;
  for (const w of unit.weapons ?? []) dps += weaponDps(w.stats);
  return dps;
}

/** Priority class of a target: 0 = can fight back, 1 = unarmed unit, 2 = building / wall without weapons */
export function targetClass(unit) {
  if (threatOf(unit) > 0) return 0;
  return unit.isStructure ? 2 : 1;
}

const CLASS_PENALTY = () => [TARGET_PRIORITY.armedPenalty, TARGET_PRIORITY.unarmedPenalty, TARGET_PRIORITY.structurePenalty];

/** Cost of attacking `other` (lower = better): edge distance + class penalty − threat bonus */
export function targetCost(unit, other, dist = edgeDistance(unit, other)) {
  const threat = threatOf(other);
  const cls = threat > 0 ? 0 : other.isStructure ? 2 : 1;
  const bonus = Math.min(threat * TARGET_PRIORITY.dpsWeight, TARGET_PRIORITY.dpsBonusMax);
  return dist + CLASS_PENALTY()[cls] - bonus;
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
  const ws = mech.weapons.map((w) => w.stats);
  const melee = ws.filter((w) => w.class === 'melee').map((w) => w.range);
  const ranged = ws.filter((w) => w.class !== 'melee').map((w) => w.range);
  const factor = getStats().rules.combat.approachRangeFactor;
  if (stance === 'melee' && melee.length) return Math.min(...melee) * factor;
  if (ranged.length) return Math.max(...ranged) * factor;
  if (melee.length) return Math.min(...melee) * factor;
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
      if (s.spread > 0) { firePellet(world, attacker, s, from, aim, color); return; }
      // Hit roll when the shot leaves: a miss flies into the ground beside the target (and may splash there)
      noteAttacker(target, attacker); // lets idle units fight back (even when the shot misses)
      const onTarget = rollHit(world, s, target);
      const miss = onTarget ? null : missPoint(world, target);
      if (s.projectileSpeed > 0) {
        const homing = () => (isTargetable(target) ? aimPoint(target, _v) : aim);
        world.effects.projectile(from, miss ? () => miss : homing, s.projectileSpeed, color,
          (point) => resolveShot(world, attacker, s, target, point, from, onTarget), projectileLook(s));
      } else {
        world.effects.tracer(from, miss ?? aim, color);
        resolveShot(world, attacker, s, target, miss ?? aim, from, onTarget);
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
  return { size: s.projectileSize ?? 0, shape: s.projectileShape || VFX.projectile.defaultShape[energy ? 'energy' : 'physical'] };
}

/**
 * One shot at a target (hit already rolled): damage and effects on a hit; splash around the impact point
 * (target surface on a hit, the ground beside it on a miss); piercing into units behind. XP for the crew.
 * @param {THREE.Vector3} from  where the shot came from (direction of the pierce)
 */
function resolveShot(world, attacker, s, target, point, from, hit) {
  const score = { dealt: 0, kills: 0 };
  const landed = hit && isTargetable(target);
  if (landed) applyHit(world, attacker, s, target, 1, attacker.position, 1, score);
  // The blast happens on the target's surface facing the shooter, not in its centre (a big mech would swallow it);
  // a near miss on the ground can still catch the target itself
  if (s.splashRadius > 0) {
    explode(world, attacker, s, landed ? surfacePoint(target, point, from) : point, landed ? [target] : [], score);
  }
  if (landed && s.pierce) pierce(world, attacker, s, from, point, target, score);
  awardXp(attacker, score.dealt, score.kills);
}

// All rolls use the world's seeded generator (src/core/Rng.js) – never Math.random (lockstep determinism)
const rollHit = (world, s, unit) => world.rng.next() < THREE.MathUtils.clamp(
  s.accuracy - (unit.evasion ?? 0), getStats().rules.combat.minHitChance, 1);

// Where a missed shot lands: the ground just beside the target (rules.combat.missScatter beyond its edge)
function missPoint(world, target) {
  const a = world.rng.angle();
  const d = (target.radius ?? 0) + world.rng.next() * getStats().rules.combat.missScatter;
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
  const rules = getStats().rules.combat;
  noteAttacker(unit, attacker); // lets idle units fight back (even when the shot misses)
  const chance = THREE.MathUtils.clamp(s.accuracy - (unit.evasion ?? 0), rules.minHitChance, 1);
  if (world.rng.next() >= chance) return false;
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
    const chance = THREE.MathUtils.clamp(s.accuracy - (unit.evasion ?? 0), getStats().rules.combat.minHitChance, 1);
    if (areEnemies(attacker, unit)) noteAttacker(unit, attacker);
    if (world.rng.next() < chance) applyHit(world, attacker, s, unit, factor * ff, attacker.position, effectFactor, score);
  }
  // Wrecks in the arc get hit for sure (pure geometry: nearest point of the wreck within radius and arc)
  const near = new THREE.Vector3();
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
  world.effects.tracer(point, hits.at(-1)?.point ?? point.clone().addScaledVector(dir, p.length), color);
}

/**
 * Units a ray passes through (bodies = vertical cylinders), nearest first, up to `max`.
 * Units the shot cannot hurt (own units without friendly fire) are passed through.
 * @returns {{ unit, point: THREE.Vector3, factor: number }[]}  factor = friendly-fire damage factor
 */
function traceUnits(world, attacker, s, from, dir, length, exclude, max) {
  const found = [];
  for (const unit of world.units) {
    if (exclude.includes(unit) || !hitsLayer(s, unit)) continue; // [NQ3] pellets / pierce only hit their layers
    const factor = sideFactor(world, attacker, unit, s);
    if (factor <= 0) continue;
    const t = rayHitsBody(unit, from, dir, length);
    if (t !== null) found.push({ unit, t, factor });
  }
  found.sort((a, b) => a.t - b.t);
  return found.slice(0, max).map((f) => ({ ...f, point: from.clone().addScaledVector(dir, f.t) }));
}

/** Nearest wreck a ray enters within `length` (wreck shape = its bounding box), or null */
function traceWreck(world, from, dir, length) {
  const ray = new THREE.Ray(from, dir);
  const p = new THREE.Vector3();
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

const scaleDamage = (damage, k) => Object.fromEntries(Object.entries(damage).map(([t, v]) => [t, v * k]));

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
