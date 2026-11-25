// Steel Men – [A7b] marching formations (P2, docs/notes/a7b-formation.md).
// A shaped move / attack-move (unitCommands.js, mode != free, >= FORMATION.minGroupSize units) makes a group:
//   – ONE path (A*) for the leader (the leader's own order, planned by Movement.followPath as usual);
//   – every other member walks to its spot = leader position + its offset turned by the formation direction
//     (the direction of the leader's current path segment, turned smoothly; near the goal the final front);
//   – narrow place (corridor narrower than the formation, or a spot inside / behind an obstacle): the group becomes a
//     column – members (by eid) follow the leader's recorded trail – and unfolds again in the open;
//   – a member farther than FORMATION.regroupDistance from its spot (or without a clear line to it) plans its own path
//     there (regroup) and joins again;
//   – a fight (a member's attack-move engages) holds the group, afterwards it gathers around the leader and marches on;
//   – the march ends when the leader ends its order near its spot: members walk the rest to their own final spots (P1).
// State lives on the orders (order.formation = member, member.group = group): no registry, nothing to dispose; a group
// is updated lazily once per simulation tick by the first member whose path is followed (deterministic unit order).
// Built only inside command executors (beginGroup / joinGroup / endGroup), so a save (command replay) rebuilds it.
import * as THREE from 'three';
import { FORMATION, MAPS } from '../config.js';
import { playerOrder } from '../units/OrderQueue.js';

const EPSILON = 1e-6;          // numeric guard (not a tuning value)
const PHASE_GATHER = 0;        // leader holds, members take their spots (start, after a fight)
const PHASE_MARCH = 1;
const PHASE_COMBAT = 2;        // some member fights: the others hold where they are
const LOOK = new THREE.Vector3(); // scratch: lookahead point of the corridor check
const ROW_TOLERANCE = 1e-3;    // units – spots closer than this along an axis count as one rank / file (rounding, not tuning)
// Column order: front to back by the projection on the formation direction (m.proj), ties by eid (no closure per sort)
const byProjection = (a, b) => b.proj - a.proj || a.eid - b.eid;

let building = null;           // members collected while one command executor runs (beginGroup … endGroup)

/** Called by an executor before it gives the orders of a shaped group march */
export function beginGroup() { building = []; }

/**
 * Called from an order's run closure right after the unit took the order: the unit marches in the group being built.
 * Outside beginGroup … endGroup (a queued order started later) it does nothing – that order keeps the P1 shape only.
 * @param {object} unit
 * @param {{ x: number, z: number }} slot  the unit's final spot (P1 shape)
 * @param {number} spacing  formation spacing of the unit's kind (column gaps)
 */
export function joinGroup(unit, slot, spacing) {
  const order = unit.order;
  if (!building || !order || unit.airborne || !FORMATION.marchOrders.includes(order.type)) return;
  const member = {
    unit, eid: unit.eid, order, group: null, fx: slot.x, fz: slot.z, lat: 0, back: 0, spacing, columnDist: 0,
    target: new THREE.Vector3(slot.x, 0, slot.z), mode: '', regroup: false, active: true, fighting: false,
    holding: false, proj: 0, released: false, gaveUp: false, dist: Infinity, err: 0, // dist: unknown until the first group step (no instant "in place")
  };
  order.formation = member;
  building.push(member);
}

/**
 * Ends the group being built: with at least FORMATION.minGroupSize members it marches, otherwise the members keep P1.
 * @param {{ x: number, z: number }} centre  centre of the final shape (the command point)
 * @param {{ x: number, z: number }} dir     final front direction (unit vector)
 * @param {number|undefined} cap             group speed (slowest member)
 */
export function endGroup(centre, dir, cap) {
  const members = building;
  building = null;
  if (!members) return;
  if (members.length < FORMATION.minGroupSize) { for (const m of members) m.order.formation = undefined; return; }
  members.sort((a, b) => a.eid - b.eid);
  const rx = -dir.z, rz = dir.x;
  let maxRadius = 0;
  for (const m of members) {
    const dx = m.fx - centre.x, dz = m.fz - centre.z;
    m.lat = dx * rx + dz * rz;
    m.back = -(dx * dir.x + dz * dir.z);
    if (m.unit.radius > maxRadius) maxRadius = m.unit.radius;
  }
  const group = {
    members, units: members.map((m) => m.unit), team: members[0].unit.team, leader: null,
    column: members.slice(), // follower order in the column (eid until the first narrow place, then front to back)
    cap: Number.isFinite(cap) ? cap : Infinity, leaderCap: 0, maxRadius,
    finalX: dir.x, finalZ: dir.z, dirX: dir.x, dirZ: dir.z, pathX: dir.x, pathZ: dir.z, pathValid: false,
    leaderRemaining: 0, phase: PHASE_GATHER, phaseTimer: 0, gatherLimit: FORMATION.gatherTimeout,
    narrow: false, wideFrom: -1, travelled: 0, columnLength: 0, leftExt: 0, rightExt: 0,
    trail: new Float64Array(FORMATION.trailPoints * 2), trailHead: -1, trailCount: 0,
    tick: -1, checkTimer: 0, done: false,
  };
  for (const m of members) m.group = group;
  electLeader(group, true);
}

/** Runs the group's step once per simulation tick (Movement.followPath calls it for any member) */
export function updateGroupOnce(group, world, dt) {
  if (group.done || group.tick === world.tick) return;
  group.tick = world.tick;
  const members = group.members;
  let active = 0;
  let fighting = false;
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const u = m.unit;
    const alive = !(u.dead || u.destroyed || u.removed || u.inside);
    // [A7b fix] a member that gave up (blocked: order dropped, empty queue, no Stop) takes its order back – nobody of a
    // marching group is left standing without an order; a leader that gave up never leads again
    // (an order ended at the unit's own spot is finished, not given up – see the leader check below)
    // [A7b fix 2] a new player order replaced the march: the member left the group for good (never restored later)
    const po = playerOrder(u);
    if (po && po !== m.order) m.released = true;
    if (alive && !u.order && !u.orderQueue?.length && !m.released && u.active !== false
      && Math.hypot(u.position.x - m.fx, u.position.z - m.fz) > FORMATION.finishDistance) {
      m.order.nav = null; m.order.best = undefined; m.order.stuck = 0; m.order.detour = null;
      u.order = m.order;
      m.gaveUp = true;
      if (m === group.leader) group.leader = null; // a new leader (re-elected below) takes the group on
    }
    m.active = alive && playerOrder(u) === m.order;
    m.fighting = m.active && u.order !== m.order;
    if (m.active) active++;
    if (m.fighting) fighting = true;
  }
  const lead = group.leader;
  if (lead && !lead.active) {
    // The leader ended its order near its spot = the march is over; otherwise (killed, new order) a new leader takes over
    const p = lead.unit.position;
    if (Math.hypot(p.x - lead.fx, p.z - lead.fz) <= FORMATION.finishDistance) { group.done = true; return; }
    group.leader = null;
  }
  if (active < FORMATION.minGroupSize) { group.done = true; return; }
  if (!group.leader && !electLeader(group, false)) { group.done = true; return; }

  updatePhase(group, fighting, dt);
  recordTrail(group);
  turn(group, dt);
  const check = --group.checkTimer <= 0;
  let shapes = null;
  if (check) {
    group.checkTimer = FORMATION.checkTicks;
    shapes = world.nav.shapesFor(group.maxRadius, group.units, false, null, group.team);
    measure(group);
    updateNarrow(group, world.nav, shapes);
  }
  placeMembers(group, world.nav, shapes);
}

// ---------- leader ----------

const crossesRift = (u) => MAPS.ascii.riftMovementTypes.includes(u.stats?.mobility?.movementType);
const restrictive = (u) => !crossesRift(u) && !u.flightAbility && !u.hopAbility;

/**
 * Picks the leader among the active members: walkers that cannot cross rifts nor fly first (its path must suit
 * everybody), wide enough (FORMATION.leaderRadiusShare), not fighting, never one that gave up; then the front rank
 * (smallest `back`), its middle (smallest |lat|), then the lowest eid. Resets the trail. Returns false when nobody can lead.
 */
function electLeader(group, first) {
  let best = null;
  let bestKey = Infinity;
  const minRadius = group.maxRadius * FORMATION.leaderRadiusShare;
  for (const m of group.members) { // eid order: a tie keeps the lower eid
    if (!m.active) continue;
    const u = m.unit;
    const key = (m.gaveUp ? 8 : 0) + (restrictive(u) ? 0 : 4) + (u.radius >= minRadius ? 0 : 2) + (m.fighting ? 1 : 0);
    // [A7b fix] the front rank leads (nobody has to pass the leader when the group folds into a column), its middle first
    const better = !best || key < bestKey || (key === bestKey && (m.back < best.back - ROW_TOLERANCE
      || (Math.abs(m.back - best.back) <= ROW_TOLERANCE && Math.abs(m.lat) < Math.abs(best.lat) - ROW_TOLERANCE)));
    if (better) { best = m; bestKey = key; }
  }
  if (!best) return false;
  group.leader = best;
  for (let i = 0; i < group.members.length; i++) group.members[i].dist = Infinity; // spots move with the new leader
  const p = best.unit.position;
  group.trailHead = 0;
  group.trailCount = 1;
  group.trail[0] = p.x;
  group.trail[1] = p.z;
  group.travelled = 0;
  group.narrow = false;
  group.wideFrom = -1;
  group.pathValid = false;
  group.leaderRemaining = Math.hypot(best.fx - p.x, best.fz - p.z);
  group.checkTimer = 0;
  // First heading: towards the leader's spot (the path is not planned yet); close to it the final front
  const dx = best.fx - p.x, dz = best.fz - p.z;
  const len = Math.hypot(dx, dz);
  if (len > FORMATION.minHeadingDistance) { group.pathX = dx / len; group.pathZ = dz / len; }
  if (first) { group.dirX = group.pathX; group.dirZ = group.pathZ; }
  // [A7b fix] a new leader keeps the phase (no new gathering in front of a narrow place): members catch up while marching
  measure(group);
  return true;
}

/** Called by Movement.followPath after the leader's own path step: remembers its path direction and length left */
export function noteLeaderPath(group, unit, point, remaining) {
  group.leaderRemaining = remaining;
  const dx = point.x - unit.position.x, dz = point.z - unit.position.z;
  const len = Math.hypot(dx, dz);
  if (len > EPSILON) { group.pathX = dx / len; group.pathZ = dz / len; group.pathValid = true; }
}

// ---------- group step ----------

function updatePhase(group, fighting, dt) {
  if (fighting) { group.phase = PHASE_COMBAT; group.phaseTimer = 0; return; }
  if (group.phase === PHASE_COMBAT) {
    group.phaseTimer += dt;
    if (group.phaseTimer >= FORMATION.reformDelay) { group.phase = PHASE_GATHER; group.phaseTimer = 0; group.gatherLimit = FORMATION.reformTimeout; }
    return;
  }
  if (group.phase === PHASE_GATHER) {
    group.phaseTimer += dt;
    let inPlace = true;
    for (let i = 0; i < group.members.length; i++) {
      const m = group.members[i];
      if (m.active && !m.fighting && m !== group.leader && m.dist > FORMATION.slotTolerance) { inPlace = false; break; }
    }
    if (inPlace || group.phaseTimer >= group.gatherLimit) group.phase = PHASE_MARCH;
  }
}

/** The leader's positions every FORMATION.trailStep units (ring buffer, newest at trailHead) */
function recordTrail(group) {
  const p = group.leader.unit.position;
  const t = group.trail;
  const h = group.trailHead * 2;
  const step = Math.hypot(p.x - t[h], p.z - t[h + 1]);
  if (step < FORMATION.trailStep) return;
  group.trailHead = (group.trailHead + 1) % FORMATION.trailPoints;
  t[group.trailHead * 2] = p.x;
  t[group.trailHead * 2 + 1] = p.z;
  if (group.trailCount < FORMATION.trailPoints) group.trailCount++;
  group.travelled += step;
}

/** Turns the formation direction towards the leader's path segment (the final front near the goal) */
function turn(group, dt) {
  const final = group.leaderRemaining <= FORMATION.finalAlignDistance;
  const wantX = final ? group.finalX : group.pathX;
  const wantZ = final ? group.finalZ : group.pathZ;
  const cur = Math.atan2(group.dirZ, group.dirX);
  let diff = Math.atan2(wantZ, wantX) - cur;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const max = FORMATION.turnRate * dt;
  const a = cur + Math.max(-max, Math.min(max, diff));
  group.dirX = Math.cos(a);
  group.dirZ = Math.sin(a);
}

/** Width of the shape on both sides of the leader, column gaps (group.column order) and length (active members only) */
function measure(group) {
  const lead = group.leader;
  let left = 0, right = 0, d = 0, prev = lead.spacing;
  for (let i = 0; i < group.column.length; i++) {
    const m = group.column[i];
    if (!m.active || m === lead) continue;
    const lat = m.lat - lead.lat;
    if (lat > right) right = lat;
    if (-lat > left) left = -lat;
    d += ((prev + m.spacing) / 2) * FORMATION.columnSpacingFactor;
    m.columnDist = d;
    prev = m.spacing;
  }
  group.leftExt = left;
  group.rightExt = right;
  group.columnLength = d;
}

/** Corridor narrower than the shape at the leader / ahead of it, or a spot in or behind an obstacle -> column */
function updateNarrow(group, nav, shapes) {
  const p = group.leader.unit.position;
  let narrow = tooNarrow(group, nav, shapes, p);
  // [A7b fix] several points ahead (FORMATION.lookaheadSamples up to FORMATION.lookahead): fold early, before the gap
  for (let k = 1; !narrow && k <= FORMATION.lookaheadSamples; k++) {
    const ahead = (FORMATION.lookahead * k) / FORMATION.lookaheadSamples;
    LOOK.set(p.x + group.pathX * ahead, 0, p.z + group.pathZ * ahead);
    if (!nav.pointClear(LOOK, shapes) || !nav.segmentClear(p, LOOK, shapes)) break; // the path turns before this point
    narrow = tooNarrow(group, nav, shapes, LOOK);
  }
  if (!narrow) {
    for (let i = 0; i < group.members.length; i++) {
      const m = group.members[i];
      if (!m.active || m.fighting || m === group.leader) continue;
      slotOf(group, m, LOOK);
      if (!nav.pointClear(LOOK, shapes) || !nav.segmentClear(p, LOOK, shapes)) { narrow = true; break; }
    }
  }
  if (narrow) {
    if (!group.narrow) orderColumn(group); // [A7b fix] folding: front to back as they stand, nobody passes the leader
    group.narrow = true;
    group.wideFrom = -1;
    return;
  }
  if (!group.narrow) return;
  if (group.wideFrom < 0) group.wideFrom = group.travelled;
  if (group.travelled - group.wideFrom >= group.columnLength + FORMATION.unfoldMargin) group.narrow = false;
}

/** Column order when the group folds: by how far ahead each member stands along the formation direction (ties eid) */
function orderColumn(group) {
  const p = group.leader.unit.position;
  for (let i = 0; i < group.column.length; i++) {
    const m = group.column[i];
    m.proj = (m.unit.position.x - p.x) * group.dirX + (m.unit.position.z - p.z) * group.dirZ;
  }
  group.column.sort(byProjection);
  measure(group);
}

function tooNarrow(group, nav, shapes, p) {
  const sx = -group.dirZ, sz = group.dirX;
  if (group.rightExt > 0 && nav.rayClearance(p, sx, sz, group.rightExt, shapes) < group.rightExt) return true;
  return group.leftExt > 0 && nav.rayClearance(p, -sx, -sz, group.leftExt, shapes) < group.leftExt;
}

/** World spot of a member in the shape around the live leader (into out) */
function slotOf(group, m, out) {
  const lead = group.leader;
  const p = lead.unit.position;
  const lat = m.lat - lead.lat;
  const back = m.back - lead.back;
  out.set(p.x - group.dirZ * lat - group.dirX * back, 0, p.z + group.dirX * lat - group.dirZ * back);
}

/** Point of the leader's trail `dist` units behind it (into out); beyond the oldest point straight back */
function trailPoint(group, dist, out) {
  const p = group.leader.unit.position;
  const t = group.trail;
  const n = FORMATION.trailPoints;
  let px = p.x, pz = p.z, left = dist;
  for (let k = 0; k < group.trailCount; k++) {
    const i = ((group.trailHead - k + n) % n) * 2;
    const qx = t[i], qz = t[i + 1];
    const seg = Math.hypot(qx - px, qz - pz);
    if (seg >= left && seg > EPSILON) {
      const f = left / seg;
      out.set(px + (qx - px) * f, 0, pz + (qz - pz) * f);
      return;
    }
    left -= seg;
    px = qx; pz = qz;
  }
  out.set(px - group.dirX * left, 0, pz - group.dirZ * left);
}

/** Targets of the members, their regroup state and the leader's speed */
function placeMembers(group, nav, shapes) {
  const lead = group.leader;
  const combat = group.phase === PHASE_COMBAT;
  let maxLag = 0;
  for (let i = 0; i < group.members.length; i++) {
    const m = group.members[i];
    if (!m.active || m === lead) { m.holding = false; continue; }
    const pos = m.unit.position;
    if (combat && !m.fighting) {
      if (!m.holding) m.target.set(pos.x, 0, pos.z); // stand where the fight found it
      m.holding = true;
      m.regroup = false;
      m.dist = 0; m.err = 0;
      continue;
    }
    m.holding = false;
    if (group.narrow) trailPoint(group, m.columnDist, m.target);
    else slotOf(group, m, m.target);
    const dx = m.target.x - pos.x, dz = m.target.z - pos.z;
    m.dist = Math.hypot(dx, dz);
    const ahead = dx * group.dirX + dz * group.dirZ; // > 0: the spot is ahead = the member lags
    m.err = ahead >= 0 ? m.dist : ahead;
    if (shapes && !m.fighting) {
      const clear = nav.segmentClear(pos, m.target, shapes);
      if (!m.regroup) m.regroup = m.dist > FORMATION.regroupDistance || (m.dist > FORMATION.slotTolerance && !clear);
      else if (clear && m.dist < FORMATION.regroupDistance * FORMATION.regroupExitShare) m.regroup = false;
    }
    if (!m.fighting) {
      const lag = m.regroup ? m.dist : Math.max(0, ahead);
      if (lag > maxLag) maxLag = lag;
    }
  }
  if (group.phase !== PHASE_MARCH) { group.leaderCap = 0; return; }
  // [A7b fix] in a column the leader keeps the group speed: slowing it at the gap would only stall the whole line
  if (group.narrow && !FORMATION.narrowLagSlowdown) { group.leaderCap = group.cap; return; }
  const span = FORMATION.lagStop - FORMATION.lagTolerance;
  const over = Math.max(0, Math.min(1, (maxLag - FORMATION.lagTolerance) / span));
  group.leaderCap = group.cap * (1 - over * (1 - FORMATION.minLeaderFactor));
}

/** Speed limit of a member walking to its spot: the leader's speed plus catch-up, 0 when ahead or holding */
export function memberSpeedCap(member) {
  if (member.holding) return 0;
  const lead = member.group.leader;
  const own = member.unit.stats?.mobility?.moveSpeed ?? Infinity;
  return Math.max(0, Math.min(own, (lead?.unit.speed ?? 0) + member.err * FORMATION.catchupGain));
}

/** Is the group holding its leader (gathering, fighting)? (Movement keeps the leader's give-up check from running) */
export const leaderHeld = (group) => group.phase !== PHASE_MARCH;
