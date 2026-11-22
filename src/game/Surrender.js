// Steel Mans – [N5FIX] a surrendering team leaves the map: every unit and building of the team vanishes at once,
// inside the simulation tick in which the 'surrender' command runs (Match.surrender), so every client removes the same
// entities. No explosion, no wreck, no loot, no ejected crew: the entities are only flagged the way their own death
// flags them (dead / destroyed + removed) and World.update drops them from its lists (and the pathfinding boxes) later
// in the same tick. Population is counted from the live lists (Economy), so it follows by itself.
//   vanishTeam(world, team) -> the entities that vanished (Match takes them out of the statistics)
//   idleTeam(world, team)   [MP-LEAVE] a disconnected team: every unit drops its orders (like 'stop'); nothing vanishes;
//                           [MP-LEAVE2] production queues cancelled (only for a team already out when it disconnects)
import { clearQueue } from '../units/OrderQueue.js';

const gone = (u) => u.removed || u.dead || u.destroyed;

/** Flags one entity as gone without its normal death effects */
function vanish(u) {
  u.order = null;
  clearQueue(u);
  u.setSelected?.(false);
  if (u.isMech) {
    u.stopRepair?.();
    if (u.bay?.service?.mech === u) u.bay.service = null; // its own bay vanishes too; nothing to release
    u.bay = null;
    u.destroyed = true;
    if (u.teamRing) u.teamRing.visible = false;
  } else if (u.isStructure) {
    u.serviceWaiting = null;
    u.dead = true;
  } else {
    if (u.cargo) u.cargo = []; // carried wrecks leave with the truck (not dropped as loot)
    u.dead = true;
  }
  u.removed = true;
}

/**
 * Removes every live unit and building of the team. Order: mechs, crews, vehicles, structures (World's own list
 * order, ascending within each list) – deterministic on every client.
 * @returns {object[]} the entities that vanished
 */
export function vanishTeam(world, team) {
  // Units already produced but still waiting for their spawn tick (World.spawnDeferred, SIM.spawnDelayTicks): they
  // enter the world as usual (ids stay reserved) and vanish in the same tick, before anything else sees them
  for (const e of world.pendingSpawns ?? []) {
    if (e.eid == null) continue; // deferLoad entries (part swaps…) add no entity
    const apply = e.apply;
    e.apply = (result) => {
      const unit = apply(result);
      if (unit && unit.team === team && !gone(unit)) vanish(unit);
      return unit;
    };
  }
  const out = [];
  for (const list of [world.mechs, world.crews, world.vehicles, world.structures]) {
    for (const u of list) {
      if (u.team !== team || gone(u)) continue;
      vanish(u);
      out.push(u);
    }
  }
  return out;
}

/**
 * [MP-LEAVE] The player of the team left a multiplayer match: its units stand where they are (orders and queues
 * cleared, as the 'stop' command does). They stay on the map, keep their stance and can be destroyed.
 */
export function idleTeam(world, team) {
  for (const list of [world.mechs, world.crews, world.vehicles]) {
    for (const u of list) {
      if (u.team !== team || gone(u)) continue;
      u.order = null;
      clearQueue(u);
    }
  }
  // [MP-LEAVE2] its production queues are cancelled too (Production refunds them as for a lost building)
  for (const s of world.structures) {
    if (s.team === team && !gone(s)) world.production?.cancelProducer(s.eid);
  }
}
