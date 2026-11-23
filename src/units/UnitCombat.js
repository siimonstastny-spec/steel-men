// Steel Mans – shared fighting logic of armed units (target picking, behaviour, attack / attack-move / guard /
// patrol movement). Written from ModularMech's private methods so other armed units (CombatVehicle) behave the
// same way; ModularMech still has its own copy (it can switch to these functions later).
//
// A unit using these functions provides:
//   order, world, team, position, rotation, radius, speed, holdTimer, behaviour, lastAttacker, stance,
//   stats { sightRange, mobility }, weapons [{ stats }],
//   combatProfile { yawOffset, chaseLeash }   – model yaw vs. +Z, auto-chase leash (× sightRange)
//   turnsHullToTarget                           – false for units whose turret aims (the hull does not turn)
//   snapToGround()                              – puts the unit on the terrain after a step
import * as THREE from 'three';
import { getStats } from '../data/Stats.js';
import { MOVEMENT, ORDERS, ARRIVE_DISTANCE, BEHAVIOUR, FOG_REACTION, SIM } from '../config.js';
import {
  isTargetable, areEnemies, edgeDistance, angleTo, engagementRange, pickTarget, betterAutoTarget,
} from '../game/Combat.js';
import { blockedOnTheWay, followPath } from '../game/Movement.js';

const DEG = Math.PI / 180;
const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Orders this module moves the unit for (anything else is the unit's own business) */
export const COMBAT_ORDERS = ['move', 'attack', 'attackMove', 'guard', 'patrol'];

/** Can the unit's side see the other unit (fog of war)? */
export const canSee = (unit, other) => unit.world.canSee(unit, other);

/**
 * Changes the idle behaviour (BEHAVIOUR.mechModes). An automatic fight the old mode started (not one inside
 * attack-move / patrol / guard) is dropped, so the new mode applies at once. Returns false for an unknown mode.
 */
export function setBehaviour(unit, mode) {
  if (!BEHAVIOUR.mechModes.includes(mode)) return false;
  unit.behaviour = mode;
  const o = unit.order;
  if (o?.type === 'attack' && o.auto && !o.resume) unit.order = o.home ? returnHome(o.home) : null;
  return true;
}

/**
 * Drops lost targets; attack-move / patrol / guard engage enemies they meet and resume afterwards
 * (whatever the behaviour – explicit orders win); idle units react by their behaviour (idleReaction).
 */
export function updateTarget(unit) {
  if (orderExpired(unit)) unit.order = null;
  const o = unit.order;
  if (o?.type === 'attack' && isTargetable(o.target)) {
    if (canSee(unit, o.target)) o.lastKnown = (o.lastKnown ?? new THREE.Vector3()).copy(o.target.position);
    // The target vanished into the fog: what happens depends on the behaviour (lostTargetOrder)
    else unit.order = lostTargetOrder(unit, o);
  } else if (o?.type === 'attack' && targetLost(unit, o)) {
    unit.order = o.resume ? resumeOrder(o.resume) : o.home ? returnHome(o.home) : null;
  }
  if (unit.order?.type === 'guard' && !guardValid(unit.order)) unit.order = null;
  retargetAuto(unit);
  const cur = unit.order;
  if (cur && ORDERS.engaging.includes(cur.type)) {
    const enemy = unit.weapons.length ? scan(unit, cur) : null;
    if (enemy) unit.order = { type: 'attack', target: enemy, auto: true, resume: cur, guard: cur.type === 'guard' ? cur : null };
  } else if (unit.weapons.length && (!cur || (cur.type === 'move' && cur.home))) {
    idleReaction(unit, cur);
  }
  unit.lastAttacker = null;
}

/**
 * What a unit without an explicit order does (behaviour):
 *  aggressive – attacks the nearest enemy in sight (rules.combat.autoAcquire), or whoever shot at it;
 *  defensive  – attacks only whoever shot at it, remembering where it stood (home) to go back there;
 *  passive    – nothing.
 */
function idleReaction(unit, cur) {
  const attacker = isTargetable(unit.lastAttacker) && areEnemies(unit, unit.lastAttacker) && canSee(unit, unit.lastAttacker)
    ? unit.lastAttacker : null;
  if (unit.behaviour === 'aggressive') {
    if (!cur && getStats().rules.combat.autoAcquire) {
      const enemy = pickTarget(unit, unit.stats.sightRange);
      if (enemy) unit.order = { type: 'attack', target: enemy, auto: true };
      else if (attacker) unit.order = { type: 'attack', target: attacker }; // fight back, even from beyond sight
    }
  } else if (unit.behaviour === 'defensive' && attacker) {
    unit.order = { type: 'attack', target: attacker, auto: true, home: cur?.home ?? unit.position.clone() };
  }
  fogReaction(unit);
}

const walkToLastKnown = (o) => (o.lastKnown ? { type: 'move', target: o.lastKnown.clone() } : null);

/** Has a time-limited order (lost-target chase) run out? Deterministic: compares simulation ticks. */
export function orderExpired(unit) {
  const o = unit.order;
  return o?.expireTick !== undefined && unit.world.tick >= o.expireTick;
}

/**
 * The order that follows an attack whose target vanished into the fog (the unit's own target, not a shooter – see fogReaction):
 *  attack-move / patrol / guard – carry on (resume);
 *  aggressive – attack-move to the last known position (any enemy met on the way is fought, so the target is attacked
 *               again when seen); gives up after FOG_REACTION.lostChaseTime (unreachable spot, endless chase);
 *  defensive  – stays where it is, or walks back home when it came from one;
 *  passive    – plain walk to the last known position (the attack was the player's explicit order).
 * Used by ModularMech and the shared logic alike.
 */
export function lostTargetOrder(unit, o) {
  if (o.resume) return resumeOrder(o.resume);
  if (unit.behaviour === 'aggressive' && o.lastKnown) {
    return {
      type: 'attackMove', target: o.lastKnown.clone(),
      expireTick: unit.world.tick + Math.round(FOG_REACTION.lostChaseTime * SIM.tickRate),
    };
  }
  if (unit.behaviour === 'defensive') return o.home ? returnHome(o.home) : null;
  return unit.behaviour === 'aggressive' ? null : walkToLastKnown(o);
}
const returnHome = (home) => ({ type: 'move', target: home, home });

/**
 * An automatic attack on an unarmed unit or a building switches to an armed enemy that came into sight
 * (TARGET_PRIORITY, Combat.betterAutoTarget). A player's attack order (not auto) is never changed.
 */
export function retargetAuto(unit) {
  const o = unit.order;
  if (o?.guard) return false; // a guard keeps to enemies near its anchor (scan), no switching by sight range
  const better = betterAutoTarget(unit, o, unit.stats.sightRange);
  if (!better) return false;
  o.target = better;
  o.lastKnown = null;
  o.slot = undefined;
  o.approachBest = undefined;
  o.nav = null;
  return true;
}

/**
 * Reaction of an idle unit hit by an enemy it cannot see while no enemy is in sight (fire from the fog).
 * Call at the end of the idle reaction (after the visible-attacker cases), while unit.lastAttacker is still set.
 *  aggressive – attack-move towards where the shot came from (FOG_REACTION.advanceMax at most, never past the shooter);
 *  defensive  – a short step straight away from the shooter, out of its weapon range if it can (dodgeMin..dodgeMax),
 *               waits there FOG_REACTION.dodgeWait, then walks back to where it stood (a "home" walk – a visible
 *               attacker on the way is fought as usual and the unit still returns to the original spot);
 *  passive    – nothing.
 * The direction comes from the shooter's position at the hit (the way the projectile flew), nothing else is revealed.
 * State: unit.fogDodge = { home, order, readyTick } while a defensive dodge is running. Deterministic (positions, tick).
 * @returns {boolean} true when it gave the unit an order this tick
 */
export function fogReaction(unit) {
  const world = unit.world;
  const o = unit.order;
  let dodge = unit.fogDodge;
  // This runs every tick of a dodge (its move is a "home" walk, the wait is idle); a gap means another order
  // (e.g. the player's move) ran in between – the dodge is over, the unit must not walk back afterwards
  if (dodge && dodge.seenTick < world.tick - 1) { unit.fogDodge = null; dodge = null; }
  if (dodge) dodge.seenTick = world.tick;
  if (dodge && o && o !== dodge.order) {
    // Another order took over (player, visible attacker): a defensive fight still returns to the original spot
    if (o.type === 'attack' && o.auto && o.home) o.home = dodge.home;
    unit.fogDodge = null;
    return false;
  }
  const a = unit.lastAttacker;
  const hidden = isTargetable(a) && areEnemies(unit, a) && !canSee(unit, a);
  if (hidden && unit.behaviour !== 'passive' && !pickTarget(unit, unit.stats.sightRange)) {
    const dx = a.position.x - unit.position.x;
    const dz = a.position.z - unit.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > MOVEMENT.overlapEpsilon) {
      const ux = dx / dist;
      const uz = dz / dist;
      if (unit.behaviour === 'aggressive' && !o) {
        const step = Math.min(dist, FOG_REACTION.advanceMax);
        unit.order = { type: 'attackMove', target: clampToMap(world, unit.position.x + ux * step, unit.position.z + uz * step) };
        return true;
      }
      const walkingHome = o && o.type === 'move' && o.home;
      if (unit.behaviour === 'defensive' && (!o || walkingHome) && !(dodge && o === dodge.order)) {
        const reach = Math.max(0, ...(a.weapons ?? []).map((w) => w.stats?.range ?? 0));
        const back = THREE.MathUtils.clamp(reach - dist + FOG_REACTION.dodgeMargin, FOG_REACTION.dodgeMin, FOG_REACTION.dodgeMax);
        const home = dodge?.home ?? o?.home ?? unit.position.clone();
        const order = { type: 'move', target: clampToMap(world, unit.position.x - ux * back, unit.position.z - uz * back), home, arriveDistance: ARRIVE_DISTANCE };
        unit.order = order;
        unit.fogDodge = { home, order, readyTick: undefined, seenTick: world.tick };
        return true;
      }
    }
  }
  // Dodge done (the move ended): wait out of reach, then walk back home
  if (dodge && !o) {
    dodge.readyTick ??= world.tick + Math.round(FOG_REACTION.dodgeWait * SIM.tickRate);
    if (world.tick >= dodge.readyTick) {
      unit.fogDodge = null;
      unit.order = { ...returnHome(dodge.home), arriveDistance: ARRIVE_DISTANCE }; // back on the exact spot, not 4 units short
      return true;
    }
  }
  return false;
}

// Point kept inside the map (pathfinding grid) by FOG_REACTION.mapMargin
function clampToMap(world, x, z) {
  const half = world.nav?.half;
  if (!(half > 0)) return new THREE.Vector3(x, 0, z);
  const m = half - FOG_REACTION.mapMargin;
  return new THREE.Vector3(THREE.MathUtils.clamp(x, -m, m), 0, THREE.MathUtils.clamp(z, -m, m));
}

/**
 * Targets of opportunity (weapons that fire on the move at whatever is in range): an aggressive unit always;
 * otherwise only while carrying out an explicit fight or defending itself.
 */
export function firesAtWill(unit) {
  if (unit.behaviour === 'aggressive') return true;
  const o = unit.order;
  if (!o) return false;
  if (ORDERS.engaging.includes(o.type)) return true;
  return o.type === 'attack' && (!o.auto || !!o.resume || !!o.home);
}

// Target dead / hidden, or chased too far (from the guarded spot, from home while defending, from us otherwise)
function targetLost(unit, o) {
  if (!isTargetable(o.target)) return true;
  if (o.guard) return distXZ(guardAnchor(o.guard), o.target.position) > ORDERS.guardChaseRadius;
  if (o.home) return distXZ(o.home, o.target.position) > BEHAVIOUR.defensiveChaseRadius;
  return o.auto && edgeDistance(unit, o.target) > unit.stats.sightRange * unit.combatProfile.chaseLeash;
}

// Enemy to engage during attack-move / patrol (in sight) or guard (near the guarded unit / point)
function scan(unit, o) {
  if (o.type === 'guard') {
    const anchor = guardAnchor(o);
    const near = pickTarget({ position: anchor, team: unit.team }, ORDERS.guardRadius, undefined, unit.world);
    if (near) return near;
    return [unit.lastAttacker, o.unit?.lastAttacker]
      .find((u) => isTargetable(u) && canSee(unit, u) && distXZ(anchor, u.position) <= ORDERS.guardChaseRadius) ?? null;
  }
  const attacker = isTargetable(unit.lastAttacker) && canSee(unit, unit.lastAttacker) ? unit.lastAttacker : null;
  return pickTarget(unit, unit.stats.sightRange) ?? attacker;
}

const guardAnchor = (o) => (o.unit ? o.unit.position : o.point);

// Guarded crew got into a mech -> guard the mech; guarded unit gone -> order ends
function guardValid(o) {
  if (o.point) return true;
  if (o.unit.inside) o.unit = o.unit.mech;
  return !!o.unit && !o.unit.destroyed && !o.unit.removed;
}

/** An interrupted order continues: plan the path again from where the fight left us */
export function resumeOrder(order) {
  order.nav = null;
  order.best = undefined;
  order.stuck = 0;
  return order;
}

/** Turns the unit towards a point at its turnSpeed; returns the remaining angle (rad) */
export function turnTowards(unit, point, dt) {
  const diff = angleTo(unit, point) + unit.combatProfile.yawOffset;
  const maxTurn = unit.stats.mobility.turnSpeed * DEG * dt;
  unit.rotation.y += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
  return diff;
}

/**
 * Moves the unit by its current order (move, attack, attackMove, guard, patrol). Returns true while it moves.
 * Attack walks into engagement range and never gives up; attack-move / patrol step aside when blocked.
 */
export function moveByOrder(unit, dt) {
  const o = unit.order;
  if (!o) return false;
  if (unit.holdTimer > 0) { // firing a weapon that stops the unit – stand, keep facing the target
    if (o.type === 'attack' && unit.turnsHullToTarget) turnTowards(unit, o.target.position, dt);
    return false;
  }

  let target;
  let ignore = [];
  if (o.type === 'attack') {
    const range = engagementRange(unit, unit.stance);
    if (range === null) { unit.order = null; return false; }
    // In range – or already touching the target (collision radii keep us from getting closer); measured to the
    // target's real edge, so at a building it is its footprint box, not the averaged circle (Combat.edgeDistance)
    // [E2] aircraft never collide with the ground, so "touching" does not stop them: a bomber (radius > bomb range)
    // must fly on until the target is really in weapon range
    const touching = !unit.airborne && edgeDistance(unit, o.target) <= unit.radius + MOVEMENT.contactSlack;
    if (edgeDistance(unit, o.target) <= range || touching) {
      o.approachBest = undefined;
      if (unit.turnsHullToTarget) turnTowards(unit, o.target.position, dt);
      return false;
    }
    if (approachStuck(o, edgeDistance(unit, o.target), dt)) pickApproachSlot(unit, o);
    target = approachPoint(unit, o);
    ignore = [o.target]; // the target itself is never an obstacle on the way to it
  } else if (o.type === 'guard') {
    const anchor = guardAnchor(o);
    const hold = o.unit ? unit.radius + o.unit.radius + ORDERS.guardFollowTolerance : ORDERS.guardHoldDistance;
    if (distXZ(unit.position, anchor) <= hold) { o.nav = null; return false; }
    target = anchor;
    if (o.unit) ignore = [o.unit];
  } else if (o.detour) {
    target = o.detour;
  } else if (o.type === 'patrol') {
    target = o.points[o.index];
  } else {
    target = o.target; // move, attackMove
  }

  const path = followPath(unit, o, target, ignore, dt);
  const dist = path.remaining;
  if (o.detour) {
    if (dist <= ORDERS.detourReach || (o.detourTimer -= dt) <= 0) { o.detour = null; resumeOrder(o); return false; }
  } else {
    const arrive = o.arriveDistance ?? (o.home ? BEHAVIOUR.homeArriveDistance : ARRIVE_DISTANCE);
    if (dist <= arrive && (o.type === 'move' || o.type === 'attackMove')) { unit.order = null; return false; }
    if (o.type === 'patrol' && dist <= ORDERS.patrolArriveDistance) { nextPatrolPoint(o); return false; }
  }
  const dx = path.point.x - unit.position.x;
  const dz = path.point.z - unit.position.z;
  const legDist = Math.hypot(dx, dz);
  if (legDist < MOVEMENT.overlapEpsilon) return false;

  const m = unit.stats.mobility;
  const diff = turnTowards(unit, path.point, dt);
  if (!o.detour && blockedOnTheWay(o, dist, diff, dt)) {
    if (ORDERS.giveUpWhenBlocked.includes(o.type)) { unit.order = null; return false; }
    if (ORDERS.detourWhenBlocked.includes(o.type)) {
      if (dist < MOVEMENT.nearTargetDistance) {
        if (o.type === 'patrol') nextPatrolPoint(o);
        else unit.order = null; // attack-move: the area is reached
      } else {
        startDetour(unit, o, path.point);
      }
      return false;
    }
  }

  // Accelerate to moveSpeed, brake in time to stop at the goal, slow down while facing away (no strafing)
  const brakeSpeed = ORDERS.brakeAtGoal.includes(o.type) ? Math.sqrt(2 * m.deceleration * dist) : Infinity;
  const wantSpeed = Math.min(m.moveSpeed, brakeSpeed) * Math.max(0, Math.cos(diff));
  unit.speed = unit.speed < wantSpeed
    ? Math.min(wantSpeed, unit.speed + m.acceleration * dt)
    : Math.max(wantSpeed, unit.speed - m.deceleration * dt);

  const step = Math.min(path.final ? legDist : dist, unit.speed * dt);
  unit.position.x += (dx / legDist) * step;
  unit.position.z += (dz / legDist) * step;
  unit.snapToGround();
  return true;
}

function nextPatrolPoint(o) {
  o.index = (o.index + 1) % o.points.length;
  resumeOrder(o);
}

// Attack approach: no progress towards the target for ORDERS.attackRepositionTime
function approachStuck(o, edge, dt) {
  if (o.approachBest === undefined || edge < o.approachBest - MOVEMENT.progressStep) {
    o.approachBest = edge;
    o.approachStuck = 0;
    return false;
  }
  o.approachStuck += dt;
  return o.approachStuck > ORDERS.attackRepositionTime;
}

// Where to go during an attack: straight at the target, or the chosen free spot around it
function approachPoint(unit, o) {
  if (o.slot === undefined) return o.target.position;
  const r = o.target.radius + unit.radius + ORDERS.approachGap;
  const t = o.target.position;
  o.slotPoint ??= new THREE.Vector3();
  return o.slotPoint.set(t.x + Math.sin(o.slot) * r, 0, t.z + Math.cos(o.slot) * r);
}

// Picks a free spot next to the target (nearest to our side first, never the one that just failed)
function pickApproachSlot(unit, o) {
  const t = o.target.position;
  const step = (Math.PI * 2) / ORDERS.approachSlots;
  const current = o.slot ?? Math.atan2(unit.position.x - t.x, unit.position.z - t.z);
  const r = o.target.radius + unit.radius + ORDERS.approachGap;
  // [N7-5] aircraft never take a ground spot (and the other way round)
  const others = unit.world.units.filter((u) => u !== unit && u !== o.target && Boolean(u.airborne) === Boolean(unit.airborne));
  const shapes = unit.world.nav.shapesFor(unit.radius, [unit, o.target], false, unit); // [W7] leg circle
  let chosen = current + step;
  for (let k = 1; k < ORDERS.approachSlots; k++) {
    const a = current + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
    const p = { x: t.x + Math.sin(a) * r, z: t.z + Math.cos(a) * r };
    if (others.some((u) => distXZ(p, u.position) < unit.radius + u.radius)) continue;
    if (shapes.some((s) => (s.radius !== undefined
      ? distXZ(p, s) < s.radius
      : Math.abs(p.x - s.x) < s.halfX && Math.abs(p.z - s.z) < s.halfZ))) continue;
    chosen = a;
    break;
  }
  o.slot = chosen;
  o.approachBest = undefined;
  o.nav = null;
}

// Attack-move / patrol blocked far from the goal: step aside (alternating sides) and try again
function startDetour(unit, o, towards) {
  o.detourSide = -(o.detourSide ?? -1);
  const dx = towards.x - unit.position.x;
  const dz = towards.z - unit.position.z;
  const len = Math.hypot(dx, dz) || 1;
  const d = ORDERS.detourDistance * o.detourSide;
  o.detour = new THREE.Vector3(unit.position.x - (dz / len) * d, 0, unit.position.z + (dx / len) * d);
  o.detourTimer = ORDERS.detourTimeout;
  resumeOrder(o);
}
