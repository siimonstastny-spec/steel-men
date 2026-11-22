// Steel Mans – repairs beyond the crew's own field repair (ModularMech.startRepair):
//   ([N5] a new order interrupts a running repair: repairInterruptible + unitCommands.give)
//
//   • Service in an own assembly bay (structure that produces 'mech'). A mech ordered into the bay (order
//     'enterBay') drives up to it; its crew steps out and waits next to the bay; the mech stands on the bay's
//     platform (where the assembly hologram is), not pickable or targetable (mech.bay, `inside`); a part being
//     mounted is shown as a hologram in its slot (RobotProduction). In the bay it can be
//       – repaired automatically (no order; also by the 'repair' task): bay.autoRepairBaseRate × autoRepairFactor
//         of max HP per second, costing bay.costPerHp; releasing the mech interrupts it,
//       – get any part swapped for one from the part stock, or a missing arm mounted, or an arm removed
//         (rules.repair.bay.partSwapTime); a removed part goes back to the stock.
//     One task at a time; it can be interrupted, or the mech released (in front of the bay, its crew boards again)
//     – but not during a part swap: the swap has to finish or be interrupted first.
//     One mech at a time, and only while no assembly is in progress (parts being chosen or an assembly queued –
//     a right click then only sends the mech to the bay); while a mech is serviced, parts for a new assembly cannot
//     be chosen (RobotProduction).
//
//   • Vehicles with a 'repair' ability (HoverTruck) repair an own damaged mech, vehicle or finished building in
//     range: rate = share of max HP per second, more repairers add rules.repair.extraRepairerFactor^k (as builders
//     do), each restored HP costs costPerHp; without resources the repair stops. A mech is inactive while a vehicle
//     repairs it (ModularMech.startRepair({ external: true })) – stopping that repair on the mech ends the order.
import * as THREE from 'three';
import { getStats, teamRule } from '../data/Stats.js';
import { STRUCTURE, ROBOT_PRODUCTION, HOLOGRAM, ALLY_REPAIR, N1B } from '../config.js';
import { distanceToBox } from '../units/Vehicle.js';
import { areAllies } from './Alliances.js'; // [N5FIX] allies repair each other's finished buildings

const UP = new THREE.Vector3(0, 1, 0);
const GATE_LOCAL = new THREE.Vector3();
const GATE = new THREE.Vector3();
const ACTIVE = []; // reused result of activeRepairers
const rules = () => getStats().rules.repair;

/** Own finished assembly bay of the team */
export const isServiceBay = (s, team) => Boolean(s?.isStructure) && s.team === team && s.produces.includes('mech');

/** Does the unit miss any HP (mech: some mounted part)? */
export const needsRepair = (u) => (u.isMech ? u.damaged : u.hp < u.maxHp - N1B.repairFullTolerance);

// ---------- [N5] interrupting a repair by a new order ----------
// The repair itself runs in ModularMech (#repair). A repairing mech is inactive, so it never moves or attacks on its
// own; a new non-queued order (move, attack, attack-move, patrol, guard, collect, enterBay… – unitCommands.give)
// breaks the repair off first. A queued order (Shift) waits behind the repair and runs once it ends.
// [R1] Also the Stop command ends it (unitCommands 'stop'), and a hit that removes HP interrupts the crew's field
// repair (Combat.damageMechPart). Every repair (field, bay, vehicle) restores a broken arm too (MechPart.repairable).

/**
 * [N5] Does a running repair (crew field repair or a vehicle's repair) give way to a new order? Only when the
 * crew is aboard and boarded – without it the mech could not obey anyway, and a vehicle repair goes on.
 */
export const repairInterruptible = (u) => Boolean(u?.isMech && u.repairing && !u.destroyed && !u.bay
  && u.crew && u.boardTimer <= 0);

/** Distance from a unit's edge to a target's edge (buildings: their footprint box) */
function edgeGap(unit, target) {
  if (target.isStructure) return distanceToBox(unit.position, target.obstacle) - unit.radius;
  return Math.hypot(target.position.x - unit.position.x, target.position.z - unit.position.z) - unit.radius - target.radius;
}

/** Scales a cost per HP to an amount of HP: { ore: 0.1 } × 50 -> { ore: 5 } */
const COST = {}; // reused result of costOf (economy.pay reads it synchronously)
const costOf = (perHp, hp) => {
  for (const r in COST) delete COST[r];
  if (perHp) for (const r in perHp) COST[r] = perHp[r] * hp;
  return COST;
};

/**
 * Restores `share` of max HP (each mounted part of a mech) and pays costPerHp for the HP restored.
 * [N5FIX] payer = the team that pays (the repairing vehicle's team; default the unit's own team).
 * @returns {boolean} false when the team cannot pay (nothing restored)
 */
function heal(unit, share, perHp, economy, payer = unit.team) {
  let total = 0;
  if (unit.isMech) {
    for (const k in unit.parts) {
      const p = unit.parts[k];
      if (p.repairable) total += gainOf(p, share); // [R1] a broken arm (0 HP) is repaired too
    }
  } else total = gainOf(unit, share);
  if (total <= 0) return true;
  if (economy && !economy.pay(payer, costOf(perHp, total))) return false;
  if (unit.isMech) {
    for (const k in unit.parts) {
      const p = unit.parts[k];
      if (p.repairable) applyHeal(p, gainOf(p, share));
    }
  } else applyHeal(unit, gainOf(unit, share));
  return true;
}

const gainOf = (p, share) => Math.min(p.maxHp * share, p.maxHp - p.hp);
function applyHeal(p, n) {
  if (p.heal) p.heal(n); else p.hp = Math.min(p.maxHp, p.hp + n);
}

// ---------- assembly bay service ----------

/** Point in front of the bay (its +Z side) where a serviced mech comes out */
function gate(bay) {
  const f = bay.fp ?? { halfZ: bay.radius };
  GATE_LOCAL.set(0, 0, f.halfZ + STRUCTURE.spawnGap).applyAxisAngle(UP, bay.rotation.y);
  return GATE.set(bay.position.x + GATE_LOCAL.x, 0, bay.position.z + GATE_LOCAL.z); // shared: callers use it at once
}

/** Mech waiting at the gate of the bay (still ordered into it), or null */
export function waitingMech(bay) {
  const m = bay.serviceWaiting;
  if (m && !m.destroyed && m.order?.type === 'enterBay' && m.order.bay === bay) return m;
  bay.serviceWaiting = null;
  return null;
}

/**
 * Assembly in progress in the bay: the player has started choosing parts or an assembly is queued
 * (Production.update sets bay.assemblyBusy every tick, for every team). No mech drives in for service meanwhile.
 * The service functions below are run by the commands serviceRepair / serviceSwap / serviceCancel / serviceRelease
 * (src/game/commands/productionCommands.js); UI code must not call them directly.
 */
export const bayAssembling = (bay) => Boolean(bay?.assemblyBusy);

/** The bay takes a mech now: nothing in service and no assembly in progress */
const bayFree = (bay) => !bay.service && !bayAssembling(bay);

/**
 * Step of a mech's 'enterBay' order (ModularMech.#move). Returns the point to walk to, or null when the mech
 * stays where it is (it got in, waits at the gate, or the order ended).
 */
export function approachBay(mech, order) {
  const bay = order.bay;
  if (!isServiceBay(bay, mech.team)) { mech.order = null; return null; }
  // Any side of the bay will do (mechs just assembled may stand in front of it): the path ends next to the building
  if (edgeGap(mech, bay) > rules().bay.entryRange) return bay.position;
  if (!bayFree(bay) || (waitingMech(bay) && bay.serviceWaiting !== mech)) {
    order.waiting = true;
    if (!waitingMech(bay)) bay.serviceWaiting = mech;
    return null;
  }
  admit(bay, mech);
  return null;
}

/** The mech drives in: the crew steps out next to the bay, the mech stands on the bay's platform */
function admit(bay, mech) {
  mech.stopRepair();
  mech.order = null;
  const crew = mech.ejectCrew(); // steps out beside the mech, which stands at the gate
  if (bay.serviceWaiting === mech) bay.serviceWaiting = null;
  mech.bay = bay;
  mech.speed = 0;
  // Same spot as the assembly hologram (RobotProduction #hologramOf)
  mech.position.set(bay.position.x, bay.position.y + (bay.bodyHeight ?? 0) + HOLOGRAM.heightOffset, bay.position.z);
  mech.rotation.y = bay.rotation.y;
  bay.service = { mech, crew, task: null };
}

/** Can the mech leave the bay now? Not while a part is being swapped (it has to finish or be interrupted first) */
export const canRelease = (bay) => Boolean(bay.service) && bay.service.task?.type !== 'swap';

/** [D1] Energy of a working bay for this tick (Economy.drawPower); @returns {number} work rate (1 without an economy) */
const bayPower = (bay, dt) => bay.world?.economy?.drawPower(bay, dt) ?? 1;

/** Bay repair step: share of max HP per second = repair vehicle's rate × autoRepairFactor; costs bay.costPerHp */
function healInBay(bay, mech, dt) {
  const b = rules().bay;
  // [D1] the bay draws energy while it repairs (only when the repair could be paid); low energy slows it
  const eco = bay.world?.economy;
  const rate = eco?.workRate(bay.team) ?? 1;
  const share = b.autoRepairBaseRate * teamRule(mech.team, 'repair.bay.autoRepairFactor') * dt * rate;
  if (!heal(mech, share, b.costPerHp, eco)) return false;
  eco?.drawPower(bay, dt);
  return true;
}

/** Per frame for a mech in a bay (ModularMech.update): runs the current task; a lost bay lets the mech out */
export function updateService(mech, dt) {
  const bay = mech.bay;
  const s = bay.service;
  if (!s || s.mech !== mech) { mech.bay = null; mech.visible = true; return; }
  if (bay.destroyed || bay.removed) { releaseMech(bay, { force: true }); return; }
  const task = s.task;
  if (task?.type === 'repair') {
    if (!healInBay(bay, mech, dt)) { s.task = null; s.stopped = 'noResources'; }
    if (!mech.damaged) s.task = null;
  } else if (!task && mech.damaged) {
    // Automatic service: a damaged mech standing in the bay is repaired without an order (retries when resources return)
    if (healInBay(bay, mech, dt)) s.stopped = null; else s.stopped = 'noResources';
  } else if (task?.type === 'swap' && !task.mounting && (task.elapsed += dt * bayPower(bay, dt)) >= task.total) {
    task.mounting = true; // the new model loads asynchronously; the task cannot be interrupted any more
    // onDone runs inside a later simulation tick (ModularMech.replacePart / World.deferLoad) – same tick on every client
    mech.replacePart(task.slot, task.path, (old) => {
      if (old) bay.world?.economy?.parts?.add(mech.team, old.stats.path);
      if (s.task === task) s.task = null;
    }).catch((err) => { console.error(err); if (s.task === task) s.task = null; });
  }
}

/** Starts the fast repair of the mech in the bay (interrupts a part swap) */
export function startBayRepair(bay) {
  const s = bay.service;
  if (!s || s.task?.mounting || !s.mech.damaged) return false;
  cancelTask(bay);
  s.stopped = null;
  s.task = { type: 'repair' };
  return true;
}

/**
 * Starts swapping the part in a slot for one from the stock (path), mounting a missing arm, or removing an arm
 * (path null). The new part is taken from the stock now and given back when the swap is interrupted.
 */
export function startSwap(bay, slot, path) {
  const s = bay.service;
  if (!s || s.task?.mounting) return false;
  const mech = s.mech;
  const stock = bay.world?.economy?.parts;
  if (!path && (!mech.parts[slot] || ROBOT_PRODUCTION.requiredSlots.includes(slot))) return false; // legs / torso stay
  if (path && (mech.parts[slot]?.alive && mech.parts[slot].stats.path === path || !stock?.take(mech.team, path))) return false;
  cancelTask(bay);
  s.stopped = null;
  s.task = { type: 'swap', slot, path, elapsed: 0, total: teamRule(mech.team, 'repair.bay.partSwapTime') };
  return true;
}

/** Interrupts the current task (a swap returns its part to the stock); a part being mounted cannot be stopped */
export function cancelTask(bay) {
  const s = bay.service;
  const task = s?.task;
  if (!task || task.mounting) return false;
  if (task.type === 'swap' && task.path) bay.world?.economy?.parts?.add(s.mech.team, task.path);
  s.task = null;
  return true;
}

/** Task progress 0..1 (repair: share of HP of the whole mech) */
export function taskProgress(s) {
  const task = s?.task;
  if (!task) return 0;
  if (task.type === 'swap') return Math.min(1, task.elapsed / Math.max(task.total, Number.EPSILON));
  const parts = Object.values(s.mech.parts).filter((p) => p && (p.alive || p.repairable)); // [R1] broken arms repairable
  const max = parts.reduce((n, p) => n + p.maxHp, 0);
  return max > 0 ? parts.reduce((n, p) => n + p.hp, 0) / max : 1;
}

/**
 * Lets the mech out in front of the bay; its crew (still waiting nearby, without another order) boards again.
 * Refused during a part swap (canRelease) unless forced (the bay is gone: an unfinished swap is cancelled).
 */
export function releaseMech(bay, { force = false } = {}) {
  const s = bay.service;
  if (!s || (!force && !canRelease(bay))) return null;
  const exit = bay.findSpawnPoint?.({ radius: s.mech.radius, ignore: [s.mech] }) ?? (force ? gate(bay) : null);
  if (!exit) return null; // [R1] no free spot in front of / around the bay – the mech stays inside
  cancelTask(bay);
  const { mech, crew } = s;
  bay.service = null;
  const p = exit;
  mech.bay = null;
  mech.visible = true;
  mech.position.set(p.x, mech.world?.heightAt(p.x, p.z) ?? mech.position.y, p.z);
  mech.rotation.y = bay.rotation.y;
  if (crew && !crew.dead && !crew.inside && !crew.order) crew.board(mech);
  return mech;
}

// ---------- repair by vehicles ----------

/**
 * [N5FIX] May the vehicle's team repair a unit of the target's team? Own units always; an ally's FINISHED building
 * when ALLY_REPAIR.structures, an ally's mech / vehicle when ALLY_REPAIR.units. Unfinished buildings of an ally are
 * never touched (finishing them is construction: Vehicle.canBuild stays own-only).
 */
export function repairAllowed(vehicle, target) {
  if (target.team === vehicle.team) return true;
  if (!areAllies(vehicle.team, target.team)) return false;
  return target.isStructure ? ALLY_REPAIR.structures && Boolean(target.complete) : ALLY_REPAIR.units;
}

/** Can the vehicle repair this target at all (own / allowed ally, damaged, mech / vehicle / finished building, not itself)? */
export function canRepairTarget(vehicle, target) {
  return Boolean(target) && target !== vehicle && !target.destroyed && !target.removed
    && !target.inside && (target.isMech || target.isVehicle || (target.isStructure && target.complete)) && needsRepair(target)
    && repairAllowed(vehicle, target);
}

/** Vehicles repairing the target right now (in range), in arrival order; drops those that stopped */
export function activeRepairers(target) {
  ACTIVE.length = 0;
  const set = target.repairers;
  if (!set) return ACTIVE;
  for (const v of set) {
    if (v.dead || v.order?.type !== 'repair' || v.order.target !== target || !v.order.working) set.delete(v);
    else ACTIVE.push(v);
  }
  return ACTIVE; // shared array: read it before calling again
}

function endRepair(o, vehicle) { o.working = false; vehicle.order = null; return null; }

/**
 * Step of a vehicle's 'repair' order (Vehicle.#act). Returns the point to drive to, or null while it repairs
 * (vehicle.activity 'repairing') or when the order ended (target repaired / gone, out of resources, the repair
 * stopped on the mech).
 */
export function vehicleRepairStep(vehicle, dt) {
  const o = vehicle.order;
  const target = o.target;
  const ability = vehicle.repairer;
  if (!ability || !canRepairTarget(vehicle, target)) return endRepair(o, vehicle);
  if (edgeGap(vehicle, target) > ability.range) { o.working = false; return target.position; }
  if (target.isMech) {
    // The mech powers down for the repair; once it was started, stopping it on the mech ends the order
    const running = target.repairing && target.repairExternal;
    if (!running && (o.started || !target.startRepair({ external: true }))) return endRepair(o, vehicle);
    o.started = true;
  }
  o.working = true;
  target.repairers ??= new Set();
  target.repairers.add(vehicle);
  const index = activeRepairers(target).indexOf(vehicle);
  const share = ability.rate * rules().extraRepairerFactor ** Math.max(0, index) * dt;
  if (!heal(target, share, ability.costPerHp, vehicle.world?.economy, vehicle.team)) return endRepair(o, vehicle); // [N5FIX] repairer pays
  vehicle.activity = 'repairing';
  return null;
}
