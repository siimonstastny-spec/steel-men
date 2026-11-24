// Steel Mans – command executors for every order the player gives to units (see docs/notes/phase0-CMD.md).
// CommandInput (and later the AI / network) only submits plain-JSON commands; everything below runs inside the
// simulation tick, so every client builds identical order queues.
//   { type, team, units: [eid...], queued, ...payload }   points are { x, z }, targets are eids
// Units must belong to cmd.team; dead / unknown ids and dead targets are dropped silently.
import * as THREE from 'three';
import { registerCommand, resolve, resolveOwn } from './CommandBus.js';
import { MECH, CMD_GROUPING, FORMATION } from '../../config.js';
import { issueOrder, clearQueue, queueOf } from '../../units/OrderQueue.js';
import { isTargetable, areEnemies, canEngage } from '../Combat.js';
import { canRepairTarget, isServiceBay, repairInterruptible } from '../Repair.js';
import { isCrewBay, crewBayAt } from '../BayCrew.js';

const DEBUG_XP = 100;             // XP of the debugXp command
const DEBUG_DAMAGE = 25;          // damage of the debugDamage command
const BEHAVIOUR_MODES = ['aggressive', 'defensive', 'passive'];
const STANCES = ['ranged', 'melee'];
const ARM_SLOT_KEYS = ['leftArm', 'rightArm'];
// Crews do not die from damage that large – "delete unit" uses it to remove a crew through its normal death
const DELETE_DAMAGE = { physical: Infinity };
const FORMATION_ORDER = ['vehicle', 'mech', 'crew'];
const SHAPED_ORDER = ['mech', 'vehicle', 'crew']; // front to back in a shaped formation
const FORMATION_SPACING = { mech: MECH.groupSpacing, crew: CMD_GROUPING.crewSpacing, vehicle: CMD_GROUPING.vehicleSpacing };

/** Orders where only the first unit that can take it does (one truck per wreck, one seat per mech…) */
export const SINGLE_TAKER_ORDERS = new Set(['salvage', 'collect', 'board']);

const kindOf = (u) => (u.isMech ? 'mech' : u.isVehicle ? 'vehicle' : 'crew');
const isFighter = (u) => Boolean(u.isMech || u.canAttack);
const validPoint = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.z);
const own = (world, cmd) => resolveOwn(world, cmd.units, cmd.team);
const toVec = (world, x, z) => new THREE.Vector3(x, world.heightAt?.(x, z) ?? 0, z);
const hasUnits = (world, cmd) => own(world, cmd).length > 0;

/** Can the unit take this order? queued = could it be put in the queue (checked for orders that run later);
 * otherwise = will it start now. Used by the executors and by the UI to split a group between orders. */
export function canTake(type, unit, target, queued = false) {
  // [N5] a repairing mech counts as able: the order breaks the repair off (give)
  const alive = (unit.active ?? !unit.dead) || repairInterruptible(unit);
  switch (type) {
    case 'attack':
      return (unit.weapons ? unit.weapons.length > 0 : true)
        && (!target || canEngage(unit, target)) // [N7] aircraft only for units with an anti-air weapon
        && (queued || (alive && isTargetable(target) && areEnemies(unit, target)));
    case 'guard': return unit !== target && (queued || (alive && Boolean(target)));
    case 'repairUnit': return Boolean(unit.repairer) && canRepairTarget(unit, target);
    case 'helpBuild': return Boolean(unit.canBuild?.(target));
    case 'harvest': return Boolean(unit.harvester) && !target.depleted;
    case 'salvage':
      return queued || (!unit.dead && Boolean(unit.salvager) && !unit.cargoFull && Boolean(target.available));
    case 'deliver':
      return Boolean(unit.canDeliverTo?.(target)) && (queued || unit.cargo?.length > 0);
    case 'collect':
      return unit.freeArmSlots?.length > 0
        && (queued || (alive && Boolean(target.part?.isArm) && Boolean(target.available)));
    case 'enterBay': return queued || (alive && isServiceBay(target, unit.team));
    case 'joinBay': // [N2] a crew on foot goes into the bay's crew queue (BayCrew.js); a full bay is checked on arrival
      return typeof unit.joinBay === 'function' && isCrewBay(target, unit.team) && (queued || (!unit.dead && !unit.inside));
    case 'board':
      return Boolean(target.isMech) && target.team === unit.team
        && (queued || (!unit.dead && !unit.inside && Boolean(target.canBoard)));
    default: return true;
  }
}

/**
 * The unit of a group that takes a single-taker order (SINGLE_TAKER_ORDERS), or null when none can.
 * [N1] 'collect': a mech that misses an arm (empty slot) before one with only a broken arm, then the nearest to the
 * wreck; ties keep the group order. Other orders: the first unit that can take it. Deterministic (simulation state
 * only) – the UI uses it to choose whom it sends the order to, the executor to choose among the sent units.
 */
export function pickTaker(type, units, target, queued = false) {
  if (type !== 'collect') return units.find((u) => canTake(type, u, target, queued)) ?? null;
  const at = target?.object?.position ?? target?.position;
  let best = null;
  let bestTier = Infinity;
  let bestDist = Infinity;
  for (const u of units) {
    if (!canTake(type, u, target, queued)) continue;
    const tier = u.freeArmSlots.some((s) => !u.parts?.[s]) ? 0 : 1;
    const dist = at ? Math.hypot(u.position.x - at.x, u.position.z - at.z) : 0;
    if (tier < bestTier || (tier === bestTier && dist < bestDist)) { best = u; bestTier = tier; bestDist = dist; }
  }
  return best;
}

/**
 * Gives one order through the queue; with `queued` an order that cannot be carried out is refused at once.
 * [N5] A repairing mech (Repair.repairInterruptible): a queued order waits behind the repair (it runs once the
 * repair ends); any other order stops the repair first – a crew repair comes back when the order is refused.
 */
function give(unit, type, ref, run, queued, possible = true) {
  if (queued && !possible) return false;
  const entry = { type, ref, run };
  if (!repairInterruptible(unit)) return issueOrder(unit, entry, Boolean(queued));
  if (queued) {
    // The repairing mech has no order: issueOrder would run the entry now (and the inactive mech refuse it)
    if (queueOf(unit).length) return issueOrder(unit, entry, true);
    queueOf(unit).push(entry);
    return true;
  }
  const external = unit.repairExternal;
  // [NQ3] a refused order must not lose the Shift queue waiting behind the repair (copy only on a player command)
  const saved = queueOf(unit).length ? queueOf(unit).slice() : null;
  unit.stopRepair();
  const ok = issueOrder(unit, entry, false);
  if (!ok && !external) unit.startRepair();
  if (!ok && saved && !queueOf(unit).length) queueOf(unit).push(...saved);
  return ok;
}

/** Spreads a group around the point in a grid; apply(unit, {x, z}) */
function formation(units, spacing, point, apply) {
  if (!units.length) return;
  const cols = Math.ceil(Math.sqrt(units.length));
  const rows = Math.ceil(units.length / cols);
  units.forEach((u, i) => {
    apply(u, {
      x: point.x + (i % cols - (cols - 1) / 2) * spacing,
      z: point.z + (Math.floor(i / cols) - (rows - 1) / 2) * spacing,
    });
  });
}

// ---------- shaped formations (box / column / wedge) ----------

const modeOf = (u) => (FORMATION.modes.includes(u.formation) ? u.formation : FORMATION.defaultMode);

/** Mode of the majority of the units (a tie goes to the earlier mode in FORMATION.modes) */
function groupMode(units) {
  let best = FORMATION.defaultMode;
  let bestCount = 0;
  for (const mode of FORMATION.modes) {
    let n = 0;
    for (const u of units) if (modeOf(u) === mode) n++;
    if (n > bestCount) { best = mode; bestCount = n; }
  }
  return best;
}

/** Slots of a formation of n units, front first, centred on (0, 0): lat = sideways, back = backwards, row = rank */
function slotsFor(mode, n, spacing) {
  const slots = [];
  if (mode === 'column') {
    for (let i = 0; i < n; i++) slots.push({ lat: 0, back: i * spacing, row: i });
  } else if (mode === 'wedge') {
    for (let i = 0; i < n; i++) {
      const k = Math.ceil(i / 2); // rank 0 = the tip, then a pair per rank
      const side = i % 2 ? -1 : 1;
      slots.push({ lat: i ? side * k * spacing * FORMATION.wedgeLateral : 0, back: k * spacing * FORMATION.wedgeBack, row: k });
    }
  } else { // box
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      slots.push({ lat: ((i % cols) - (inRow - 1) / 2) * spacing, back: row * spacing, row });
    }
  }
  const depth = n ? slots[n - 1].back : 0;
  for (const s of slots) s.back -= depth / 2;
  return { slots, depth };
}

/** Unit vector (x, z) from the group centre to the point; FORMATION.defaultHeading when too close */
function headingTo(units, point) {
  let cx = 0;
  let cz = 0;
  for (const u of units) { cx += u.position.x; cz += u.position.z; }
  cx /= units.length; cz /= units.length;
  const dx = point.x - cx;
  const dz = point.z - cz;
  const len = Math.hypot(dx, dz);
  return len < FORMATION.minHeadingDistance ? FORMATION.defaultHeading : { x: dx / len, z: dz / len };
}

/** Speed of the slowest unit (the group walks at it), undefined when unknown */
function slowestSpeed(units) {
  let min = Infinity;
  for (const u of units) { const s = u.stats?.mobility?.moveSpeed; if (Number.isFinite(s) && s < min) min = s; }
  return min === Infinity ? undefined : min;
}

/**
 * Sends a group (all of one kind) to the slots of a shaped formation centred on `centre`, heading `dir`.
 * Units are matched to slots front to back, then side to side by their current position (no crossing paths);
 * ties break by eid (deterministic). apply(unit, {x, z}).
 */
function shapedFormation(units, mode, spacing, centre, dir, apply) {
  if (!units.length) return;
  const rx = -dir.z; // sideways axis
  const rz = dir.x;
  let cx = 0;
  let cz = 0;
  for (const u of units) { cx += u.position.x; cz += u.position.z; }
  cx /= units.length; cz /= units.length;
  const front = (u) => (u.position.x - cx) * dir.x + (u.position.z - cz) * dir.z;
  const side = (u) => (u.position.x - cx) * rx + (u.position.z - cz) * rz;
  const sorted = [...units].sort((a, b) => front(b) - front(a) || a.eid - b.eid);
  const { slots } = slotsFor(mode, units.length, spacing);
  let from = 0;
  while (from < slots.length) {
    let to = from;
    while (to < slots.length && slots[to].row === slots[from].row) to++;
    const rank = sorted.slice(from, to).sort((a, b) => side(a) - side(b) || a.eid - b.eid);
    const rankSlots = slots.slice(from, to).sort((a, b) => a.lat - b.lat);
    rank.forEach((u, i) => apply(u, {
      x: centre.x + rx * rankSlots[i].lat - dir.x * rankSlots[i].back,
      z: centre.z + rz * rankSlots[i].lat - dir.z * rankSlots[i].back,
    }));
    from = to;
  }
}

/** Run closure of an order that also stores the group speed limit on the unit's new order (read by Movement.followPath) */
const withCap = (unit, cap, start) => () => {
  const result = start();
  if (cap !== undefined && unit.order) unit.order.maxSpeed = cap;
  return result;
};

registerCommand('setFormation', {
  validate: (world, cmd) => FORMATION.modes.includes(cmd.mode) && hasUnits(world, cmd),
  execute(world, cmd) {
    for (const u of own(world, cmd)) u.formation = cmd.mode;
  },
});

// ---------- move ----------

registerCommand('move', {
  validate: (world, cmd) => validPoint(cmd.point) && hasUnits(world, cmd),
  execute(world, cmd) {
    const groups = { mech: [], crew: [], vehicle: [] };
    for (const u of own(world, cmd)) groups[kindOf(u)].push(u);
    // [N2] a move into the footprint of an own assembly bay sends crews into the bay's crew queue
    const bay = groups.crew.length ? crewBayAt(world, cmd.team, cmd.point) : null;
    if (bay) {
      for (const u of groups.crew) {
        give(u, 'joinBay', { bay }, () => u.joinBay(bay), cmd.queued, canTake('joinBay', u, bay, true));
      }
      groups.crew = [];
    }
    const all = [...groups.mech, ...groups.vehicle, ...groups.crew];
    const mode = all.length > 1 ? groupMode(all) : FORMATION.defaultMode;
    if (mode !== FORMATION.defaultMode) {
      // Shaped: blocks of mechs, vehicles, crews one behind the other (mechs in front), the whole centred on the point
      const dir = headingTo(all, cmd.point);
      const cap = slowestSpeed(all);
      const blocks = SHAPED_ORDER.filter((kind) => groups[kind].length);
      let total = (blocks.length - 1) * FORMATION.kindGap;
      for (const kind of blocks) total += slotsFor(mode, groups[kind].length, FORMATION_SPACING[kind]).depth;
      let cursor = -total / 2; // distance behind the point of the front edge of the next block
      for (const kind of blocks) {
        const depth = slotsFor(mode, groups[kind].length, FORMATION_SPACING[kind]).depth;
        const back = cursor + depth / 2;
        const centre = { x: cmd.point.x - dir.x * back, z: cmd.point.z - dir.z * back };
        shapedFormation(groups[kind], mode, FORMATION_SPACING[kind], centre, dir, (u, p) => {
          const target = toVec(world, p.x, p.z);
          give(u, 'move', { target }, withCap(u, cap, () => u.moveTo(target)), cmd.queued);
        });
        cursor += depth + FORMATION.kindGap;
      }
      return;
    }
    for (const kind of FORMATION_ORDER) {
      // Crews sent together with mechs wait a bit behind them (camera side)
      const centre = kind === 'crew' && groups.mech.length
        ? { x: cmd.point.x, z: cmd.point.z + MECH.groupSpacing } : cmd.point;
      formation(groups[kind], FORMATION_SPACING[kind], centre, (u, p) => {
        const target = toVec(world, p.x, p.z);
        give(u, 'move', { target }, () => u.moveTo(target), cmd.queued);
      });
    }
  },
});

// ---------- point orders of fighters: attackMove, patrol, guard (point) ----------

function registerPointOrder(type, method) {
  registerCommand(type, {
    validate: (world, cmd) => validPoint(cmd.point) && hasUnits(world, cmd),
    execute(world, cmd) {
      const fighters = own(world, cmd).filter(isFighter);
      const place = (u, p, cap) => {
        const target = toVec(world, p.x, p.z);
        give(u, type, { target }, withCap(u, cap, () => u[method](target)), cmd.queued);
      };
      const mode = fighters.length > 1 ? groupMode(fighters) : FORMATION.defaultMode;
      if (mode === FORMATION.defaultMode) { formation(fighters, MECH.groupSpacing, cmd.point, place); return; }
      const cap = slowestSpeed(fighters);
      shapedFormation(fighters, mode, MECH.groupSpacing, cmd.point, headingTo(fighters, cmd.point), (u, p) => place(u, p, cap));
    },
  });
}
registerPointOrder('attackMove', 'attackMoveTo');
registerPointOrder('patrol', 'patrol');

// guard: a friendly unit (cmd.target) or a point (cmd.point)
registerCommand('guard', {
  validate(world, cmd) {
    if (!hasUnits(world, cmd)) return false;
    if (cmd.target != null) {
      const t = resolve(world, cmd.target);
      return Boolean(t) && t.team === cmd.team && isTargetable(t);
    }
    return validPoint(cmd.point);
  },
  execute(world, cmd) {
    const units = own(world, cmd).filter(isFighter);
    if (cmd.target != null) {
      const t = resolve(world, cmd.target);
      for (const u of units) give(u, 'guard', { unit: t }, () => u.guard(t), cmd.queued, canTake('guard', u, t, true));
      return;
    }
    const place = (u, p, cap) => {
      const target = toVec(world, p.x, p.z);
      give(u, 'guard', { point: target }, withCap(u, cap, () => u.guard(target)), cmd.queued);
    };
    const mode = units.length > 1 ? groupMode(units) : FORMATION.defaultMode;
    if (mode === FORMATION.defaultMode) { formation(units, MECH.groupSpacing, cmd.point, place); return; }
    const cap = slowestSpeed(units);
    shapedFormation(units, mode, MECH.groupSpacing, cmd.point, headingTo(units, cmd.point), (u, p) => place(u, p, cap));
  },
});

// ---------- orders with an entity target ----------
// payload field -> order entry (type, ref key, how the unit runs it). `queued` as for every order.
const ENTITY_ORDERS = {
  attack: { field: 'target', orderType: 'attack', ref: 'target', run: (u, t) => u.attackUnit(t), live: isTargetable },
  repairUnit: { field: 'target', orderType: 'repair', ref: 'target', run: (u, t) => u.repairUnit(t) },
  helpBuild: { field: 'structure', orderType: 'build', ref: 'structure', run: (u, t) => u.build(t) },
  harvest: { field: 'deposit', orderType: 'harvest', ref: 'deposit', run: (u, t) => u.harvest(t) },
  salvage: { field: 'wreck', orderType: 'salvage', ref: 'wreck', run: (u, t) => u.collectSalvage(t) },
  deliver: { field: 'structure', orderType: 'deliver', ref: 'structure', run: (u, t) => u.deliverSalvage(t) },
  collect: { field: 'wreck', orderType: 'collect', ref: 'wreck', run: (u, t) => u.collect(t) },
  enterBay: { field: 'bay', orderType: 'enterBay', ref: 'bay', run: (u, t) => u.enterBay(t) },
  joinBay: { field: 'bay', orderType: 'joinBay', ref: 'bay', run: (u, t) => u.joinBay?.(t) ?? false }, // [N2]
  board: { field: 'mech', orderType: 'board', ref: 'mech', run: (u, t) => u.board(t) },
};

for (const [type, spec] of Object.entries(ENTITY_ORDERS)) {
  registerCommand(type, {
    validate(world, cmd) {
      const target = resolve(world, cmd[spec.field]);
      return Boolean(target) && (spec.live?.(target) ?? true) && hasUnits(world, cmd);
    },
    execute(world, cmd) {
      const target = resolve(world, cmd[spec.field]);
      let units = own(world, cmd);
      if (SINGLE_TAKER_ORDERS.has(type)) { // the best taker first (pickTaker), the rest in group order as a fallback
        const first = pickTaker(type, units, target, true);
        if (first) units = [first, ...units.filter((u) => u !== first)];
      }
      for (const u of units) {
        const ok = give(u, spec.orderType, { [spec.ref]: target }, () => spec.run(u, target), cmd.queued,
          canTake(type, u, target, true));
        if (ok && SINGLE_TAKER_ORDERS.has(type)) break;
      }
    },
  });
}

// ---------- stop, delete, eject ----------

registerCommand('stop', {
  validate: hasUnits,
  execute(world, cmd) {
    for (const u of own(world, cmd)) {
      if (repairInterruptible(u)) u.stopRepair(); // [R1] Stop ends a repair too (crew aboard)
      u.order = null;
      clearQueue(u);
    }
  },
});

// The confirm dialog stays in the UI; this runs after the player said yes
registerCommand('deleteUnit', {
  validate: hasUnits,
  execute(world, cmd) {
    for (const u of own(world, cmd)) {
      if (u.isMech || u.isVehicle) u.destroy();
      else u.takeDamage(DELETE_DAMAGE);
    }
  },
});

// Crews leave their mechs. The executor RETURNS { crews: [eid] } (local result, never sent anywhere): the UI of the
// player who gave the command picks it up in commandBus.onExecuted (CommandInput) and selects the crews.
registerCommand('eject', {
  validate: hasUnits,
  execute(world, cmd) {
    const crews = own(world, cmd).filter((m) => m.isMech && m.crew).map((m) => m.ejectCrew()).filter(Boolean);
    return { crews: crews.map((c) => c.eid) };
  },
});

// ---------- behaviour, repair, stance, arms ----------

registerCommand('behaviour', {
  validate: (world, cmd) => BEHAVIOUR_MODES.includes(cmd.mode) && hasUnits(world, cmd),
  execute(world, cmd) {
    for (const u of own(world, cmd)) u.setBehaviour?.(cmd.mode); // crews refuse 'aggressive'
  },
});

// Field repair: { start: true } starts it on every unit that can be repaired, { start: false } stops it
registerCommand('repair', {
  validate: (world, cmd) => typeof cmd.start === 'boolean' && hasUnits(world, cmd),
  execute(world, cmd) {
    for (const m of own(world, cmd)) {
      if (!m.isMech) continue;
      if (cmd.start) { if (m.canRepair) m.startRepair?.(); } else m.stopRepair?.();
    }
  },
});

registerCommand('stance', {
  validate: (world, cmd) => STANCES.includes(cmd.stance) && hasUnits(world, cmd),
  execute(world, cmd) {
    for (const m of own(world, cmd)) if (m.isMech) m.setStance(cmd.stance);
  },
});

registerCommand('dropArm', {
  validate: (world, cmd) => ARM_SLOT_KEYS.includes(cmd.slot) && hasUnits(world, cmd),
  execute(world, cmd) {
    const mech = own(world, cmd).find((u) => u.isMech);
    mech?.dropArm(cmd.slot);
  },
});

// ---------- debug ----------

// Cheats: refused in multiplayer (world.multiplayer is set by main.js)
registerCommand('debugXp', {
  validate: (world, cmd) => !world.multiplayer && hasUnits(world, cmd),
  execute(world, cmd) {
    for (const u of own(world, cmd)) (u.isMech ? u.crew : u)?.addXp?.(DEBUG_XP); // armed vehicles have own XP
  },
});

// Alt + click: { target: eid, slot: part key of a mech | null, energy: bool }
registerCommand('debugDamage', {
  validate: (world, cmd) => !world.multiplayer && Boolean(resolve(world, cmd.target)),
  execute(world, cmd) {
    const unit = resolve(world, cmd.target);
    const damage = cmd.energy ? { energy: DEBUG_DAMAGE } : { physical: DEBUG_DAMAGE };
    (cmd.slot ? unit.parts?.[cmd.slot] : unit)?.takeDamage?.(damage);
  },
});
