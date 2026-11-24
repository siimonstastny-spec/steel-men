// Steel Men – [N2] crews waiting inside an assembly bay (structure that produces 'mech'), docs/notes/n2-baycrew.md.
//
//   • A crew ordered into an own finished bay (order 'joinBay': right click on the bay, or a move whose point lies
//     in its footprint – unitCommands.js) walks up to it and goes in once its edge is BAY_CREW.entryRange from the
//     footprint. Inside it is hidden like a crew in a mech (crew.bay set, crew.inside true): not pickable, not
//     targetable, no collisions. A full bay (BAY_CREW.capacity) leaves the crew standing outside.
//   • The queue is FIFO (bay.crewQueue, Crew objects): a mech assembled in the bay takes the first crew the tick it
//     appears in the world (Production.#tickGather) and is active at once (BAY_CREW.boardInstantly).
//   • Command 'releaseBayCrew' (Production.#planBayCrew) lets all queued crews out around the bay (free spawn spots).
//     A destroyed / lost bay lets them out too (Production.update → releaseLostBays).
//   • Bay service (Repair.js): [W7] the serviced mech's crew goes into the queue with it when there is room (it counts
//     towards the capacity like any queued crew and can be let out); when the service ends the mech takes exactly that
//     crew back (takeThisCrew) and is active at once (BAY_CREW.boardInstantly). Without room the crew stands outside
//     as before (bay.service.crew). The queue never feeds a serviced mech by itself, and a mech is only assembled
//     while no mech is serviced. See docs/notes/n2-baycrew.md and w7-crew-collision.md.
//
// Deterministic: called only from command executors and simulation ticks, iteration in queue / eid order.
import { BAY_CREW } from '../config.js';

/** Own finished assembly bay of the team (same test as Repair.isServiceBay, kept here to avoid an import cycle) */
export const isCrewBay = (s, team) => Boolean(s?.isStructure) && s.team === team && !s.destroyed && !s.removed
  && s.produces.includes('mech');

/** Crews waiting in the bay (FIFO, first = next to board); drops dead ones */
export function bayCrews(bay) {
  const q = bay?.crewQueue;
  if (!q) return [];
  for (let i = q.length - 1; i >= 0; i--) if (q[i].dead || q[i].bay !== bay) q.splice(i, 1);
  return q;
}

export const bayCrewCount = (bay) => bayCrews(bay).length;
export const bayCrewFull = (bay) => bayCrewCount(bay) >= BAY_CREW.capacity;

/** Gap between the crew's edge and the bay footprint */
export function crewBayGap(crew, bay) {
  const box = bay.obstacle;
  const dx = Math.max(Math.abs(crew.position.x - box.x) - box.halfX, 0);
  const dz = Math.max(Math.abs(crew.position.z - box.z) - box.halfZ, 0);
  return Math.hypot(dx, dz) - crew.radius;
}

/** Is the point { x, z } inside the bay footprint? (a move there means "go into the bay") */
export function inBayFootprint(bay, p) {
  const box = bay.obstacle;
  return Math.abs(p.x - box.x) <= box.halfX && Math.abs(p.z - box.z) <= box.halfZ;
}

/** Own bay whose footprint contains the point, or null (lowest eid wins – footprints never overlap anyway) */
export function crewBayAt(world, team, p) {
  let best = null;
  for (const s of world.structures ?? []) {
    if (isCrewBay(s, team) && inBayFootprint(s, p) && (!best || s.eid < best.eid)) best = s;
  }
  return best;
}

/** The crew goes into the bay queue. @returns {boolean} false when it cannot (full bay, not an own bay…) */
export function admitCrew(bay, crew) {
  if (!isCrewBay(bay, crew.team) || crew.dead || crew.inside || bayCrewFull(bay)) return false;
  (bay.crewQueue ??= []).push(crew);
  crew.stepIntoBay(bay);
  return true;
}

/**
 * Takes the first queued crew out of the bay (it stays hidden, the caller boards it into a mech at once).
 * @returns {import('../units/Crew.js').Crew|null}
 */
export function takeCrew(bay) {
  const crew = bayCrews(bay).shift() ?? null;
  if (crew) crew.bay = null;
  return crew;
}

/**
 * [W7] Takes this crew (wherever it is in the queue) out of the bay; it stays hidden, the caller boards it into a
 * mech at once (the serviced mech's own crew when the service ends – Repair.releaseMech).
 * @returns {boolean} false when the crew is not waiting in this bay
 */
export function takeThisCrew(bay, crew) {
  const q = bayCrews(bay);
  const i = q.indexOf(crew);
  if (i < 0) return false;
  q.splice(i, 1);
  crew.bay = null;
  return true;
}

/**
 * A crew leaves the bay to a free spot around it (Structure.nextSpawnPoint – reserved like a produced unit).
 * Without a free spot it stays inside unless `force` (the bay is gone: it steps out at the front spot anyway).
 * @returns {boolean} let out
 */
export function releaseCrew(bay, crew, { force = false } = {}) {
  const q = bay.crewQueue ?? [];
  if (!q.includes(crew)) return false;
  const free = bay.findSpawnPoint?.({ radius: crew.radius }) ?? null;
  if (!free && !force) return false;
  const p = free ? bay.nextSpawnPoint({ radius: crew.radius }) : bay.spawnPoint?.({ radius: crew.radius }) ?? bay.position;
  q.splice(q.indexOf(crew), 1);
  crew.leaveBay({ x: p.x, y: 0, z: p.z }, p.yaw ?? bay.rotation.y);
  return true;
}

/** Lets every queued crew out (command 'releaseBayCrew'). @returns {object[]} crews that came out */
export function releaseAll(bay, opts) {
  const out = [];
  for (const crew of [...bayCrews(bay)]) {
    if (!releaseCrew(bay, crew, opts)) break; // no free spot left: the rest waits inside
    out.push(crew);
  }
  return out;
}

/**
 * Step of a crew's 'joinBay' order (Crew.#move). Returns the point to walk to, or null when the crew stops
 * (it went in, the bay is full or gone – the order ends).
 */
export function approachCrewBay(crew, order) {
  const bay = order.bay;
  if (!isCrewBay(bay, crew.team)) { crew.order = null; return null; }
  if (crewBayGap(crew, bay) > BAY_CREW.entryRange) return bay.position;
  if (!admitCrew(bay, crew)) crew.order = null; // full: the crew waits next to the bay
  return null;
}
