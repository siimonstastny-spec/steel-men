// Steel Mans – unit collisions, path following and "give up when blocked" for move orders
import * as THREE from 'three';
import { MOVEMENT, PATHFINDING, VEHICLE, MAPS, JUMP_JET } from '../config.js';
import { clampToArea, confineUnits } from './PreBuild.js';
import { collisionReach } from './Pathfinding.js';

const DEG = Math.PI / 180;
const MOVED = new Set();     // scratch of resolveCollisions (cleared at the start and the end of each call)
const IGNORE = [];           // scratch of followPath: [unit, ...ignore], read by findPath / shapesFor at once
const FIND_OPTS = {          // scratch options of followPath's findPath call (findPath only destructures them)
  radius: 0, ignore: IGNORE, crossRift: false, flyRange: 0, flyPenalty: 0, hopRange: 0, hopPenalty: 0, body: null,
};

/**
 * Pushes overlapping units apart (circles of unit.radius on the ground plane).
 * Heavier units move less: each unit takes the share of the overlap given by the other unit's mass.
 * @param {Array} units  mechs and crews currently in the world
 */
export function resolveCollisions(units, world) {
  const moved = MOVED;
  moved.clear();
  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    if (a.inFlight) continue; // [R2] jet flight – nobody collides with it until it lands
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      if (b.inFlight) continue;
      if (Boolean(a.airborne) !== Boolean(b.airborne)) continue; // [N7] aircraft collide only with aircraft
      let dx = b.position.x - a.position.x;
      let dz = b.position.z - a.position.z;
      let dist = Math.hypot(dx, dz);
      const minDist = contactDistance(a, b); // [W7] mech shoulders vs mechs / tall units, legs vs the rest
      if (dist >= minDist) continue;
      if (dist < MOVEMENT.overlapEpsilon) { // exactly on top of each other – pick a random direction
        const angle = world.rng.angle(); // seeded (lockstep determinism)
        dx = Math.cos(angle); dz = Math.sin(angle); dist = 1;
      }
      const overlap = (minDist - dist) * MOVEMENT.collisionStiffness;
      const fixedA = isStatic(a);
      const fixedB = isStatic(b);
      if (fixedA && fixedB) continue;
      // Static obstacles do not move at all; otherwise the lighter unit gives way more
      const shareA = fixedA ? 0 : fixedB ? 1 : collisionMass(b) / (collisionMass(a) + collisionMass(b));
      const nx = dx / dist;
      const nz = dz / dist;
      a.position.x -= nx * overlap * shareA;
      a.position.z -= nz * overlap * shareA;
      b.position.x += nx * overlap * (1 - shareA);
      b.position.z += nz * overlap * (1 - shareA);
      moved.add(a).add(b);
    }
  }
  for (const u of confineUnits(world, units)) moved.add(u); // [N8] pre-build phase: nobody leaves the start square
  for (const u of moved) {
    if (u.airborne) u.snapToGround(); // [N7] keeps its altitude over the new spot
    else if (!u.hopping) u.position.y = world.heightAt(u.position.x, u.position.z); // [R2] a hop keeps its arc height
  }
  moved.clear();
}

// [N7] Straight-line "path" of an aircraft (no pathfinding, flies over everything); one object reused – callers read
// it at once and never keep it
const AIR_PATH = { point: new THREE.Vector3(), remaining: 0, final: true, fly: false, hop: false };
// Result of followPath for ground units: one object reused, read at once by the caller and never kept
const GROUND_PATH = { point: null, remaining: 0, final: true, fly: false, hop: false };

function airPath(unit, goal) {
  AIR_PATH.point.set(goal.x, unit.position.y, goal.z);
  AIR_PATH.remaining = Math.hypot(goal.x - unit.position.x, goal.z - unit.position.z);
  return AIR_PATH;
}

/**
 * [W7] Centre distance at which two units touch: each one with the circle that reaches the other
 * (Pathfinding.collisionReach – a mech's shoulder circle against mechs and units as tall as its shoulders, its foot
 * circle against lower ones; other units have one circle).
 */
export function contactDistance(a, b) {
  return collisionReach(a, Boolean(b.isMech), b.bodyHeight ?? 0) + collisionReach(b, Boolean(a.isMech), a.bodyHeight ?? 0);
}

/** Powered-down mechs (no crew) behave like obstacles – nobody can shove them away (buildings later too) */
export function isStatic(unit) {
  return unit.isMech && !unit.crew && !unit.destroyed && !unit.inside; // a mech in an assembly bay is not on the map
}

// A unit standing still (fighting, holding a spot) counts as heavier, so walking units give way to it
// instead of shoving it – otherwise attackers crowding a target push it (and each other) around
function collisionMass(unit) {
  const mass = unit.isMech ? (unit.stats?.mass ?? MOVEMENT.defaultMechMass)
    : unit.isVehicle ? VEHICLE.collisionMass : MOVEMENT.crewMass;
  return unit.speed > 0 ? mass : mass * MOVEMENT.standingMassFactor;
}

/** [MAPS] Hover / air units may cross terrain rifts (stats mobility.movementType in MAPS.ascii.riftMovementTypes) */
export function canCrossRift(unit) {
  return MAPS.ascii.riftMovementTypes.includes(unit.stats?.mobility?.movementType);
}

// [unit, ...ignore] in the recycled IGNORE array (valid until the next call; callers use it at once)
function ignoreList(unit, ignore) {
  IGNORE.length = 0;
  IGNORE.push(unit);
  for (let i = 0; i < ignore.length; i++) IGNORE.push(ignore[i]);
  return IGNORE;
}

/**
 * Steers a unit along a planned path to a goal (world.nav, see Pathfinding.js).
 * The plan is stored on the order (order.nav) and refreshed when obstacles change, or – for a moving
 * goal (a unit's position) – at most every PATHFINDING.repathInterval when it moved far enough.
 * @param {object} unit    mech or crew (position, radius, world)
 * @param {object} order   the unit's current order (plan is cached on it)
 * @param {THREE.Vector3} goal  target point; pass a live position (e.g. target.position) for moving goals
 * @param {Array} ignore   owners not counted as obstacles (the attack / board target)
 * @param {number} dt
 * @returns {{ point: THREE.Vector3, remaining: number, final: boolean, fly: boolean, hop: boolean }}
 *   point = where to head now; remaining = path length left to the (reachable) goal;
 *   final = point is the goal itself (brake / arrive there);
 *   fly = [R2] the leg to `point` crosses an obstacle in a jet flight (unit.flightAbility, see Pathfinding.js);
 *   hop = [R2] the leg to `point` hops over a rift (unit.hopAbility)
 *   The returned object is reused – read it at once, never keep it.
 */
export function followPath(unit, order, goal, ignore, dt) {
  // Formation speed limit (order.maxSpeed, set by unitCommands for shaped formations): the unit's own code
  // accelerates by acceleration × dt right after this call, so clamp one step below the limit to end exactly on it
  if (order.maxSpeed !== undefined) {
    const limit = Math.max(0, order.maxSpeed - (unit.stats?.mobility?.acceleration ?? 0) * dt);
    if (unit.speed > limit) unit.speed = limit;
  }
  if (unit.airborne) return airPath(unit, goal); // [N7] aircraft fly straight
  const nav = unit.world.nav;
  // [N8] pre-build phase: a goal outside the unit's start square becomes the nearest point inside it (the copy lives
  // on the order, so a live goal is never changed); outside the phase nothing happens
  const inside = clampToArea(unit.world, unit, goal, order.prebuildGoal ??= new THREE.Vector3());
  if (inside && (inside.x !== goal.x || inside.z !== goal.z)) goal = inside;
  let plan = order.nav;
  const goalMoved = plan ? Math.hypot(goal.x - plan.planned.x, goal.z - plan.planned.z) : Infinity;
  if (plan) plan.timer -= dt;
  const replan = !plan || plan.version !== nav.version
    || (plan.timer <= 0 && goalMoved >= PATHFINDING.repathMoveThreshold);
  if (replan) {
    const opts = FIND_OPTS;
    opts.radius = unit.radius; opts.ignore = ignoreList(unit, ignore); opts.crossRift = canCrossRift(unit);
    // [R2] null / undefined ability = cannot fly / hop
    opts.flyRange = unit.flightAbility?.range ?? 0; opts.flyPenalty = JUMP_JET.flight.pathPenalty;
    opts.hopRange = unit.hopAbility?.range ?? 0; opts.hopPenalty = JUMP_JET.hop.pathPenalty;
    opts.body = unit; // [W7] obstacles inflated by the unit's circle that touches them (mech: shoulders / legs)
    const res = nav.findPath(unit.position, goal, opts);
    opts.body = null; // (do not keep the unit alive)
    IGNORE.length = 0; // (nor the unit and its targets in the recycled ignore list)
    plan = order.nav = {
      waypoints: res.waypoints,
      goalFly: res.goalFly, // [R2] the last leg (to the goal) is a flight / a hop
      goalHop: res.goalHop,
      // Goal reachable as asked -> follow the live goal (moving targets); otherwise the free spot found
      goal: Math.hypot(res.goal.x - goal.x, res.goal.z - goal.z) < PATHFINDING.goalTolerance ? null : res.goal,
      planned: { x: goal.x, z: goal.z },
      version: nav.version,
      timer: PATHFINDING.repathInterval,
    };
    order.best = undefined; // path length may jump after re-planning – restart the progress check
  }

  const end = plan.goal ?? goal;
  const wp = plan.waypoints;
  // Drop reached waypoints, and skip ahead when the next one is already in plain sight
  while (wp.length) {
    const near = Math.hypot(wp[0].x - unit.position.x, wp[0].z - unit.position.z) <= PATHFINDING.waypointReach;
    const next = wp[1] ?? end;
    if (near || nav.segmentClear(unit.position, next, nav.shapesFor(unit.radius, ignoreList(unit, ignore), canCrossRift(unit), unit))) wp.shift();
    else break;
  }
  IGNORE.length = 0;

  const point = wp[0] ?? end;
  const fly = wp.length ? wp[0].fly === true : plan.goalFly === true;
  const hop = wp.length ? wp[0].hop === true : plan.goalHop === true;
  let remaining = Math.hypot(point.x - unit.position.x, point.z - unit.position.z);
  let prev = point;
  for (let i = 1; i <= wp.length; i++) {
    const p = wp[i] ?? end;
    if (p === prev) break;
    remaining += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  GROUND_PATH.point = point;
  GROUND_PATH.remaining = remaining;
  GROUND_PATH.final = wp.length === 0;
  GROUND_PATH.fly = fly;
  GROUND_PATH.hop = hop;
  return GROUND_PATH;
}

/**
 * True when a unit with a move order has stopped getting closer to its target for too long –
 * e.g. the spot is taken by another unit (or later a building). Short patience near the target,
 * longer on the way. Time spent turning on the spot does not count.
 * @param {number} dist  remaining PATH length to the goal (not the straight-line distance –
 *                       a detour around an obstacle must not look like being stuck)
 * Stores its progress on the order object.
 */
export function blockedOnTheWay(order, dist, facingDiff, dt) {
  if (Math.abs(facingDiff) > MOVEMENT.progressFacing * DEG) return false;
  if (order.best === undefined || dist < order.best - MOVEMENT.progressStep) {
    order.best = dist;
    order.stuck = 0;
    return false;
  }
  order.stuck += dt;
  const patience = dist < MOVEMENT.nearTargetDistance ? MOVEMENT.nearGiveUpTime : MOVEMENT.giveUpTime;
  return order.stuck > patience;
}
