// Steel Men – build commands. Placing a building is a command; the simulation validates it again, pays,
// creates the structure and sends the builders. Walls and turrets (placeWall, placeTurret) are registered by
// src/game/Walls.js with the helpers exported here.
//
//   placeStructure   { type, team, race, unitId, x, z, yaw, builders: [eid], queued, ticket? }
//   cancelConstruction { type, team, structure: eid, ticket? }
//   deleteStructure  { type, team, structures: [eid] }   any own building, finished or not (UI asks first)
//   upgradeGate      { type, team, segments: [eid], ticket? }   [H1] rebuilds each own finished
//                    full wall segment into its gate (stats segment.gateUpgrade), see canUpgradeToGate
//   placeStructure `yaw` is any angle (quantizeYaw: 1/CMD_BUILD.yawResolution rad)
//   (helping a building = 'helpBuild' in unitCommands.js)
//
// `ticket` is an optional local number: the UI that submitted a command gets its result back through
// newTicket(callback) (the command itself is executed later, at the start of a tick). It never influences the
// simulation and only own commands (commandBus.isOwn) are matched to tickets. Executors return the result,
// validate() reports a refusal. Result: { structure } | {} | { error: 'invalid' | 'blocked' | 'resources' | 'noPost' | 'gone' }
// or a rule error with detail: { error: 'limit', max } | { error: 'tier', tier } | { error: 'requires', list: [ids] }.
//
// Determinism: the structure is created and registered (eid!) synchronously inside execute(): setup(footprint)
// gives it stats, HP and footprint, world.addStructure gives it the eid and the pathfinding box, the model is
// attached later by Structure.load(). The footprint must be in the cache (Structure.cachedFootprint) on every client:
// call `await preloadFootprints(race)` for every race of the match before the simulation starts.
import { getStats, unitStats, canProduce, loadStats, superweaponLimit } from '../../data/Stats.js';
import { Structure, modelFootprint, cachedFootprint } from '../../units/Structure.js';
import { structureClassFor } from '../../units/structureClasses.js';
import { queueOf, issueOrder } from '../../units/OrderQueue.js';
import { CMD_BUILD, WALL, GATE } from '../../config.js';
import { canPlace, placementBox, terrainFit, flattenTerrain, setConstructionDue, refundConstruction } from '../Construction.js';
import { commandBus, registerCommand, resolve, resolveOwn } from './CommandBus.js';
import { boxInArea } from '../PreBuild.js';

/** Search defaults of findPlacement (an AI helper, not part of the simulation rules) */
const SEARCH = { step: 6, maxRadius: 120, angles: 16 };

// ---------- result tickets (local UI feedback only) ----------

const watchers = new Map();
let nextTicket = 1;

/** Reserves a ticket: put it into the command as `ticket`, `onResult(res)` is called when the command ran or failed */
export function newTicket(team, onResult) {
  const ticket = nextTicket++;
  watchers.set(`${team}:${ticket}`, onResult);
  return ticket;
}

/**
 * Reports the result of a command to the UI that holds its ticket. Only commands submitted on THIS client
 * (commandBus.isOwn) are looked up: a remote player's ticket number may equal a local one.
 */
export function reportResult(cmd, res) {
  if (cmd.ticket == null || !commandBus.isOwn(cmd)) return;
  const key = `${cmd.team}:${cmd.ticket}`;
  const fn = watchers.get(key);
  if (!fn) return;
  watchers.delete(key);
  fn(res);
}

// Executors RETURN their result; this listener hands it to the ticket of the own command. A command refused by
// validate() never reaches the listeners, so validate() calls reportResult itself (also own commands only).
const REPORTING_COMMANDS = new Set(['placeStructure', 'cancelConstruction', 'placeWall', 'placeTurret', 'upgradeGate']);
commandBus.onExecuted((cmd, tick, result) => {
  if (result && REPORTING_COMMANDS.has(cmd.type)) reportResult(cmd, result);
});

/**
 * Adds the detail the UI needs to a rule error code of checkRules: { error: 'limit', max } | { error: 'tier', tier }
 * | { error: 'requires', list: [ids] } | { error: 'invalid' }
 */
export function ruleResult(code, stats, world, team) {
  if (code === 'limit') return { error: 'limit', max: stats?.superweapon ? Math.min(stats.maxPerTeam ?? Infinity, superweaponLimit()) : stats?.maxPerTeam };
  if (code === 'tier') return { error: 'tier', tier: stats?.requiresTier };
  if (code === 'requires') {
    const own = world.structures.filter((s) => s.team === team && !s.destroyed && s.complete);
    return { error: 'requires', list: (stats?.requires ?? []).filter((r) => !own.some((s) => s.unitId === r)) };
  }
  return { error: 'invalid' };
}

// ---------- shared rules ----------

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** Entity ids of units / objects (the UI may pass either) */
export const eidsOf = (list) => (list ?? []).map((u) => (typeof u === 'number' ? u : u.eid)).filter((e) => e != null);

/** Builder vehicles of the team among the ids (alive, with the construct ability) */
export const buildersOf = (world, eids, team) => resolveOwn(world, eids, team).filter((v) => v.canConstruct);

/**
 * Rotation of a building: any angle, wrapped to (-π, π] and rounded to 1 / CMD_BUILD.yawResolution rad. Both the UI
 * and the executors use it, so every client simulates exactly the same number.
 */
export function quantizeYaw(yaw) {
  const turn = Math.PI * 2;
  const wrapped = yaw - Math.round(yaw / turn) * turn;
  return Math.round(wrapped * CMD_BUILD.yawResolution) / CMD_BUILD.yawResolution;
}

/** Orders builders to a new structure: queued = behind their current orders (Shift) */
export function orderBuild(builders, structure, queued) {
  for (const v of builders) { if (queued && v.queueBuild) v.queueBuild(structure); else v.build(structure); }
}

const isOpen = (s) => s && !s.complete && !s.destroyed && !s.removed;

// One queue entry builds a whole list of structures (a wall line), one after another. It stays ONE slot of the
// builder's order queue (ORDER_QUEUE.maxLength), so a long wall neither overflows the queue nor gets pushed out by
// the next Shift order: when a node is done the entry puts the rest of the list back at the head of the queue.
function chainEntry(vehicle, nodes) {
  return { type: 'build', ref: { structure: nodes[0] }, run: () => runChain(vehicle, nodes) };
}

function runChain(vehicle, nodes) {
  const open = nodes.filter(isOpen);
  for (let i = 0; i < open.length; i++) {
    if (!vehicle.build(open[i])) continue; // build() drops the queue – the rest is put back below
    const rest = open.slice(i + 1);
    if (rest.length) queueOf(vehicle).unshift(chainEntry(vehicle, rest));
    return true;
  }
  return false;
}

/**
 * Orders builders to build `structures` in the given order. queued = behind their current orders (Shift), else it
 * replaces them. Builders that cannot build are skipped.
 */
export function orderBuildChain(builders, structures, queued) {
  const nodes = structures.filter(isOpen);
  if (!nodes.length) return;
  for (const v of builders) {
    if (v.canBuild && !v.canBuild(nodes[0])) continue;
    issueOrder(v, chainEntry(v, nodes), Boolean(queued)); // the normal queue rules (idle = start now)
  }
}

/**
 * Rules that do not depend on the spot: the building exists and is buildable by this race, requirements, per-team
 * limit (maxPerTeam), research tier. @returns {'' | 'invalid' | 'requires' | 'limit' | 'tier'} (see ruleResult)
 * `upgrade` = [H1] built by rebuilding another structure (a gate: buildable false keeps it out of the build menu only).
 */
export function checkRules(world, team, race, id, stats, upgrade = false) {
  if (!stats || (stats.buildable === false && !upgrade)) return 'invalid';
  const research = world.research;
  if (research?.races?.[team] && research.races[team] !== race) return 'invalid';
  if (!canProduce(race, 'structures', id, research?.unlocks?.[team])) return 'invalid';
  const own = world.structures.filter((s) => s.team === team && !s.destroyed);
  if (!(stats.requires ?? []).every((req) => own.some((s) => s.unitId === req && s.complete))) return 'requires';
  if (stats.maxPerTeam && own.filter((s) => s.unitId === id).length >= stats.maxPerTeam) return 'limit';
  // [A9-F3] one superweapon per team in total, whatever its id (unfinished ones count)
  if (stats.superweapon && own.filter((s) => s.stats?.superweapon).length >= superweaponLimit()) return 'limit';
  if (stats.requiresTier && research && research.openTier(team) < stats.requiresTier) return 'tier';
  return '';
}

/** Loads the footprints of every building a race can build (+ wall segments); await it before the match starts */
export async function preloadFootprints(race) {
  await loadStats();
  const all = getStats().structures ?? {};
  const ids = new Set();
  for (const [id, s] of Object.entries(all)) {
    if (s.buildable === false) continue;
    ids.add(id);
    if (s.wallSegment) ids.add(s.wallSegment);
    const gate = s.wallSegment ? all[s.wallSegment]?.gateUpgrade : null; // [H1] the gate a segment can be rebuilt into
    if (gate) ids.add(gate);
  }
  await Promise.allSettled([...ids].map((id) => modelFootprint(id, race)));
}

/** Creates a structure object ready for world.addStructure (stats + footprint set), the model loads afterwards */
export function createStructure(StructureClass, id, race, opts, fp) {
  const structure = new StructureClass(id, race, opts);
  structure.setup(fp);
  return structure;
}

/**
 * Turns a structure made by createStructure to any yaw and gives it the matching pathfinding box (bounding box of
 * the turned footprint, see Construction.placementBox). Call before world.addStructure. Not for wall segments.
 */
export function turnStructure(structure, fp, yaw) {
  structure.rotation.y = yaw;
  const box = placementBox(fp, 0, 0, yaw);
  structure.footprint = { halfX: box.halfX, halfZ: box.halfZ };
  structure.radius = (box.halfX + box.halfZ) / 2;
}

/** Adds the structure to the world (eid + pathfinding box now) and attaches its model when loaded */
export function addAndLoad(world, structure, x, z) {
  world.addStructure(structure, x, z);
  // [I1] the next tick waits for the model (DefenseStructure muzzles / turning read it): same tick on every machine
  // [A1-3] holdOnFailure: in a lockstep match a building without its model on one client would desync – hold instead
  // (retryLoad: a transient failure is retried first, like World.#defer; only then the match is held)
  world.trackLoad(world.retryLoad(() => structure.load()), { holdOnFailure: true }).catch((err) => console.error('Structure load failed', structure.unitId, err));
  return structure;
}

// ---------- placeStructure ----------

function checkPlace(world, cmd) {
  if (!num(cmd.x) || !num(cmd.z) || !num(cmd.yaw ?? 0) || typeof cmd.unitId !== 'string') return { error: 'invalid' };
  const stats = unitStats('structures', cmd.unitId, cmd.race);
  if (stats?.placement === 'wall' || stats?.placement === 'post') return { error: 'invalid' }; // own commands
  const rules = checkRules(world, cmd.team, cmd.race, cmd.unitId, stats);
  if (rules) return ruleResult(rules, stats, world, cmd.team);
  const fp = cachedFootprint(cmd.unitId, cmd.race);
  if (!fp) return { error: 'blocked' }; // footprints not preloaded
  const builders = buildersOf(world, cmd.builders, cmd.team);
  const yaw = quantizeYaw(cmd.yaw ?? 0);
  const box = placementBox(fp, cmd.x, cmd.z, yaw);
  if (!canPlace(world, box, builders)) return { error: 'blocked' };
  if (!boxInArea(world, cmd.team, box)) return { error: 'blocked' }; // [N8] pre-build square
  const fit = terrainFit(world, box); // [R6] too steep under the footprint = blocked (the ground is levelled otherwise)
  if (!fit.ok) return { error: 'blocked' };
  if (!world.economy.canAffordUpfront(cmd.team, stats.cost)) return { error: 'resources', cost: stats.cost };
  return { stats, fp, builders, yaw, box, level: fit.level };
}

registerCommand('placeStructure', {
  validate(world, cmd) {
    const res = checkPlace(world, cmd);
    if (!res.error) return true;
    reportResult(cmd, res);
    return false;
  },
  execute(world, cmd) {
    const res = checkPlace(world, cmd);
    if (res.error) return res;
    const { stats, fp, builders, yaw, box, level } = res;
    if (!world.economy.payUpfront(cmd.team, stats.cost)) return { error: 'resources', cost: stats.cost };
    const StructureClass = structureClassFor(stats, Structure); // armed buildings, wall posts (structureClasses.js)
    const structure = createStructure(StructureClass, cmd.unitId, cmd.race, { team: cmd.team, yaw }, fp);
    setConstructionDue(world.economy, structure, stats.cost); // [W5b] energy is charged when the building really starts
    turnStructure(structure, fp, yaw); // any angle: the Structure constructor only knows quarter turns
    flattenTerrain(world, box, level); // [R6] level the ground first: addStructure takes the height from it
    addAndLoad(world, structure, cmd.x, cmd.z);
    orderBuild(builders, structure, Boolean(cmd.queued));
    return { structure }; // local result: handed to the ticket of the own command (onExecuted above)
  },
});

// ---------- cancelConstruction ----------

registerCommand('cancelConstruction', {
  validate(world, cmd) {
    const s = resolve(world, cmd.structure);
    const ok = Boolean(s?.isStructure) && s.team === cmd.team && !s.complete && !s.destroyed;
    if (!ok) reportResult(cmd, { error: 'gone' });
    return ok;
  },
  /** Returns rules.construction.cancelRefund of the cost and removes the unfinished building */
  execute(world, cmd) {
    const s = resolve(world, cmd.structure);
    refundConstruction(world.economy, s, getStats().rules.construction?.cancelRefund ?? 0);
    s.destroy({ explode: false });
    return {};
  },
});

// ---------- deleteStructure ----------

/** Own live buildings among the ids of a deleteStructure command */
function structuresToDelete(world, cmd) {
  const eids = Array.isArray(cmd.structures) ? cmd.structures.slice(0, CMD_BUILD.maxDeleteBatch) : [];
  return resolveOwn(world, eids, cmd.team).filter((s) => s.isStructure);
}

// Every building can be deleted, without exception (the confirm dialog stays in the UI). An unfinished one is
// cancelled (refund as in cancelConstruction), a finished one is destroyed. Production queues of a lost building are
// refunded by Production, wall turrets die with their post (WallPost.destroy).
registerCommand('deleteStructure', {
  validate: (world, cmd) => structuresToDelete(world, cmd).length > 0,
  execute(world, cmd) {
    const refund = getStats().rules.construction?.cancelRefund ?? 0;
    for (const s of structuresToDelete(world, cmd)) {
      if (s.complete) { s.destroy(); continue; }
      refundConstruction(world.economy, s, refund);
      s.destroy({ explode: false });
    }
  },
});

// ---------- upgradeGate ([H1]) ----------

/** Gate structure id a structure can be rebuilt into (stats.gateUpgrade of a wall segment, never of a gate), or null */
export function gateUpgradeOf(s) {
  const id = s?.stats?.gateUpgrade;
  return typeof id === 'string' && !s.stats.gate ? id : null;
}

/**
 * [H1] Can `s` be rebuilt into a gate by `team`? An own, finished, live wall segment whose stats name a gate, in full
 * length: not cut at the map edge / a tall obstacle (`trim`) and at least WALL.postSpacing × GATE.minLengthFactor long.
 * The same test runs in the UI (button shown) and in the command.
 */
export function canUpgradeToGate(s, team) {
  return Boolean(s?.isStructure) && s.team === team && s.complete === true && !s.dead && !s.destroyed && !s.removed
    && gateUpgradeOf(s) !== null && s.trim !== true && num(s.length) && s.length >= WALL.postSpacing * GATE.minLengthFactor;
}

/** Segments of an upgradeGate command that can be rebuilt, in ascending eid order (independent of the selection order) */
function gateSegments(world, cmd) {
  const eids = Array.isArray(cmd.segments) ? cmd.segments.slice(0, GATE.maxBatch) : [];
  const out = resolveOwn(world, eids, cmd.team).filter((s) => canUpgradeToGate(s, cmd.team));
  out.sort((a, b) => a.eid - b.eid);
  return out.filter((s, i) => i === 0 || out[i - 1] !== s); // an eid listed twice is rebuilt (and paid) once
}

/** Rules, footprint and price of the gate of one segment: { error } or { id, stats, fp } */
function checkGate(world, team, seg) {
  const id = gateUpgradeOf(seg);
  const stats = unitStats('structures', id, seg.race);
  const rules = checkRules(world, team, seg.race, id, stats, true);
  if (rules) return ruleResult(rules, stats, world, team);
  const fp = cachedFootprint(id, seg.race);
  if (!fp) return { error: 'blocked' }; // footprint not preloaded (preloadFootprints adds segment.gateUpgrade)
  if (!world.economy.canAfford(team, stats.cost)) return { error: 'resources', cost: stats.cost };
  return { id, stats, fp };
}

// The segment is replaced at once by an unfinished gate with the same place, length, turn, height and post gap; the gate
// is paid in full (like wall pieces) and builds itself in stats.buildTime (stats.selfBuild, Construction.structureBuildRate):
// no builder is sent, needed or counted.
// Result: { structures: [gates], error? } – error = the first refusal of a segment that was skipped (e.g. resources).
registerCommand('upgradeGate', {
  validate(world, cmd) {
    const segs = gateSegments(world, cmd);
    const res = segs.length ? checkGate(world, cmd.team, segs[0]) : { error: 'gone' };
    if (!res.error) return true;
    reportResult(cmd, res);
    return false;
  },
  execute(world, cmd) {
    const team = cmd.team;
    const gates = [];
    let refusal = null;
    for (const seg of gateSegments(world, cmd)) {
      const res = checkGate(world, team, seg);
      if (res.error) { refusal ??= res; continue; }
      if (!world.economy.pay(team, res.stats.cost)) { refusal ??= { error: 'resources', cost: res.stats.cost }; continue; }
      const GateClass = structureClassFor(res.stats, Structure); // WallGate (Walls.js registers it for stats.gate)
      const gate = createStructure(GateClass, res.id, seg.race,
        { team, yaw: seg.rotation.y, length: seg.length, trim: false }, res.fp);
      gate.postHalf = seg.postHalf ?? 0;
      const x = seg.position.x;
      const y = seg.position.y;
      const z = seg.position.z;
      seg.upgraded = true; // MatchStats: not a lost building, no kill for its last attacker
      seg.destroy({ explode: false });
      addAndLoad(world, gate, x, z);
      gate.position.y = y;
      gates.push(gate);
    }
    return gates.length ? (refusal ? { structures: gates, ...refusal } : { structures: gates }) : (refusal ?? { error: 'gone' });
  },
});

// ---------- setAutoAssist ([R6], reminder 19) ----------

// { type: 'setAutoAssist', team, on: boolean } – the player's "idle HoverTrucks repair and finish buildings nearby"
// setting. A command (not a lobby field) because the setting is per player, lives in each player's own profile and may
// change during the match: it travels with the normal command stream, so every client switches it on the same tick.
// The simulation state is world.autoAssist[team]; a team that never sent the command has it off (AI teams unless
// they send it themselves). Vehicle.update reads it.
registerCommand('setAutoAssist', {
  validate: (world, cmd) => typeof cmd.on === 'boolean' && Number.isInteger(cmd.team)
    && cmd.team >= 0 && cmd.team < (world.economy?.races?.length ?? 0),
  execute(world, cmd) {
    world.autoAssist ??= {};
    world.autoAssist[cmd.team] = cmd.on;
  },
});

// Helping an unfinished building is the 'helpBuild' command of unitCommands.js (the only executor; there is no
// 'helpConstruct' any more).

// ---------- helpers for UI / AI callers ----------

/**
 * Submits placeStructure. `builders` may be vehicles or eids. Without footprint in the cache the call first loads it
 * (async), so await it. @returns {Promise<object>} the result ({ structure } | { error }) once the command ran
 */
export async function submitPlaceStructure({ team, race, unitId, x, z, yaw = 0, builders = [], queued = false }) {
  await modelFootprint(unitId, race);
  return new Promise((resolveResult) => {
    const ticket = newTicket(team, resolveResult);
    commandBus.submit({ type: 'placeStructure', team, race, unitId, x, z, yaw, builders: eidsOf(builders), queued, ticket });
  });
}

/**
 * AI helper: finds the free spot of a building nearest to `near` (rings around it, fixed angle order – deterministic).
 * Same test as the command's validation, so a returned spot is accepted unless the world changes in between.
 * `gap` (units, default 0) keeps that much free space around the building (the test box is enlarged by it).
 * @returns {Promise<{x:number, z:number, yaw:number} | null>}
 */
export async function findPlacement(world, { team, race, unitId, near, yaw = 0, builders = [], maxRadius = SEARCH.maxRadius, step = SEARCH.step, gap = 0 }) {
  const fp = await modelFootprint(unitId, race);
  const stats = unitStats('structures', unitId, race);
  if (checkRules(world, team, race, unitId, stats) || !world.economy.canAffordUpfront(team, stats.cost)) return null;
  const own = buildersOf(world, eidsOf(builders), team);
  const snapped = quantizeYaw(yaw);
  const pad = Math.max(0, Number(gap) || 0);
  const free = (x, z) => {
    const box = placementBox(fp, x, z, snapped);
    if (!boxInArea(world, team, box)) return false; // [N8] pre-build square
    if (!terrainFit(world, box).ok) return false; // [R6] steep ground – the same test as the command
    return canPlace(world, pad ? { ...box, halfX: box.halfX + pad, halfZ: box.halfZ + pad } : box, own);
  };
  if (free(near.x, near.z)) return { x: near.x, z: near.z, yaw: snapped };
  for (let r = step; r <= maxRadius; r += step) {
    for (let k = 0; k < SEARCH.angles; k++) {
      const a = (k / SEARCH.angles) * Math.PI * 2;
      const x = near.x + Math.cos(a) * r;
      const z = near.z + Math.sin(a) * r;
      if (free(x, z)) return { x, z, yaw: snapped };
    }
  }
  return null;
}
