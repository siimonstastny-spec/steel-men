// Steel Men – production of every team, inside the simulation (world.production, ticked by World.update).
// The UI (BuildMenu, RobotProduction, ResearchView, Hud) only reads this state and submits commands
// (src/game/commands/productionCommands.js); the AI and remote players use exactly the same commands.
//
//   • one sequential queue per producer building (key = structure eid), HUD.production.maxQueue items each
//   • queueing pays the cost at once and holds the population (supply) until the unit exists – [W5b] except the
//     deferred resources (ECONOMY.deferredResources, energy): the first item of a queue pays them when it really
//     starts (item.due → item.paid, Economy.payDue) and waits without progress until the team has them
//   • build time = stats buildTime × HUD.production.timeScale, advanced by the simulation dt only
//   • completion: vehicles / crews / mechs are spawned through injected callbacks (model loading lives in
//     main.js), parts go into the team's PartStock, research / salvage analysis complete in world.research
//   • cancel (or a lost producer) refunds rules.production.cancelRefund of the cost and frees the population;
//     a cancelled assembly returns its parts (ROBOT_PRODUCTION.cancelReturnsParts), research becomes free again
//
// Deterministic: no frame time, no Date / Math.random, producers iterate by eid, item ids come from a counter.
// Queue items are plain JSON (no object references):
//   { id, team, producer (eid), kind: 'vehicle'|'crew'|'part'|'mech'|'research'|'analysis',
//     unitId?, slot?, path?, set?, loadout?, parts?, researchId?, lootKey?, lootKind?,
//     cost, supply, total, elapsed, due?, paid? }   ([W5b] due / paid: deferred part of the cost, e.g. { energy: 40 })
import { getStats, canProduce, tierLocked, unitStats, crewStats, partStats, mechStatsFromLoadout, mechAssemblyStats } from '../data/Stats.js';
import * as THREE from 'three';
import { HUD, ROBOT_PRODUCTION, RALLY, BAY_CREW } from '../config.js';
import { issueOrder } from '../units/OrderQueue.js';
import { MECH_SLOTS, PART_SLOTS, partOptions, catalogEntry, catalogSlot, stockKey } from './PartStock.js';
import { startBayRepair, startSwap, cancelTask, releaseMech, canRelease } from './Repair.js';
import { isCrewBay, bayCrewCount, takeCrew, releaseAll, releaseCrew } from './BayCrew.js';
import { productionFactor } from './Auras.js'; // [A9-buildings]

// [R1] item kinds that spawn a unit next to the producer
const SPAWNS_UNIT = ['vehicle', 'crew', 'mech'];
const AURA_EXEMPT_KINDS = ['research', 'analysis']; // [A9-buildings] queue kinds the production aura does not speed up

/** What a building can make (Structure.produces) */
export const PRODUCES = { vehicle: 'vehicle', crew: 'crew', part: 'part', mech: 'mech', research: 'research' };

/**
 * Why a command cannot run now (check(cmd).reason). '' = it can.
 * UI turns these into messages, the AI into decisions.
 */
export const REASON = {
  none: '',
  noProduction: 'noProduction', // world.production missing / malformed command
  producer: 'producer',         // producer is not an own finished building that makes this
  locked: 'locked',             // faction / research does not allow it, or unknown id
  requires: 'requires',         // a required own building is missing (stats.requires)
  full: 'full',                 // the producer's queue is full
  population: 'population',     // not enough free population
  resources: 'resources',       // not enough resources (check(cmd).cost has the price)
  parts: 'parts',               // assembly: parts not in stock / incomplete loadout
  service: 'service',           // assembly bay: a mech is being serviced
  active: 'active',             // research / analysis already queued or done
  item: 'item',                 // cancel: no such item of this team
  noService: 'noService',       // service command: no mech in the bay / task not possible
  rally: 'rally',               // [R4] setRally / setSpawnStance: bad point list / mode
  bayCrew: 'bayCrew',           // [N2] releaseBayCrew: no crew waits in the bay
};

/** [R4] Buildings that spawn units have a rally chain and a spawn stance */
export const canGather = (structure) => SPAWNS_UNIT.some((k) => structure.produces.includes(k));

const ok = (extra = {}) => ({ reason: REASON.none, ...extra });
const no = (reason, extra = {}) => ({ reason, ...extra });

export class Production {
  /**
   * @param {import('./World.js').World} world
   * @param {object} opts
   *   races[team]    race key per team
   *   unlocks[team]  Stats.createUnlocks() record per team (shared with Research)
   *   catalog        parts.json (PartStock.loadPartCatalog) – needed for parts and assembly
   *   spawn          { vehicle(team, race, id, at, structure), crew(team, race, at, structure),
   *                    mech(team, race, loadout, at, structure) } – create the unit at `at` {x, z, yaw}
   *                  (may return a Promise; the spawn point is taken synchronously by the simulation)
   */
  constructor(world, { races, unlocks = [], catalog = null, spawn = {} }) {
    this.world = world;
    this.races = [...races];
    this.unlocks = unlocks;
    this.catalog = catalog;
    this.spawn = spawn;
    /** producer eid -> items (first = in progress) */
    this.queues = new Map();
    this.nextItemId = 1;
    /** Completion hook (UI refresh, sounds, stats): fn(item). Must not change the simulation. */
    this.onComplete = null;
    /** Further completion listeners (AI, stats…): same rules as onComplete, see addCompleteListener */
    this.completeListeners = [];
    /** [R1] Listeners fn(item, structure) called once when a finished item waits for a free spawn spot (UI message only) */
    this.spawnBlockedListeners = [];
    /** [R4] produced units not in the world yet: { eid, rally: [{x, z}], behaviour, until (tick) } – applied when they appear */
    this.pendingGather = [];
    /** [N2] crewless mechs from a bay that remember their rally chain: { mech, rally } – applied once they are active */
    this.heldRally = [];
    /** [R5] builders finished but not in the world yet: { team, eid } – still count as the team's builder (hasBuilder) */
    this.pendingBuilders = [];
  }

  /** Registers a listener for "no free space around the building" (must not change the simulation) */
  onSpawnBlocked(fn) { this.spawnBlockedListeners.push(fn); }

  /**
   * Adds a completion listener fn(item) next to onComplete (which stays for the UI). It must not change the
   * simulation. @returns {Function} call it to remove the listener
   */
  addCompleteListener(fn) {
    this.completeListeners.push(fn);
    return () => { this.completeListeners = this.completeListeners.filter((f) => f !== fn); };
  }

  // ---------- reading (UI / AI) ----------

  get economy() { return this.world.economy; }
  get research() { return this.world.research; }
  get stock() { return this.world.economy?.parts ?? null; }
  get maxQueue() { return HUD.production.maxQueue; }

  raceOf(team) { return this.races[team]; }
  unlocksOf(team) { return this.unlocks[team] ?? null; }

  /** Items of one producer (structure eid), first = in progress */
  itemsOf(producer) { return this.queues.get(producer) ?? []; }

  isFull(producer) { return this.itemsOf(producer).length >= this.maxQueue; }

  /** Producer eids in a stable order */
  #producerIds() { return [...this.queues.keys()].sort((a, b) => a - b); }

  /** All items of a team, producer by producer (eid order) */
  itemsOfTeam(team) {
    return this.#producerIds().flatMap((eid) => this.itemsOf(eid)).filter((i) => i.team === team);
  }

  /** Items of a team currently in progress (first of each queue) */
  activeOfTeam(team) {
    return this.#producerIds().map((eid) => this.itemsOf(eid)[0]).filter((i) => i && i.team === team);
  }

  itemById(id) {
    for (const items of this.queues.values()) {
      const item = items.find((i) => i.id === id);
      if (item) return item;
    }
    return null;
  }

  /** Progress 0..1 of an item */
  static progressOf(item) { return item.total > 0 ? Math.min(1, item.elapsed / item.total) : 1; }

  /** Own finished buildings of a team that make `what` (PRODUCES.*), by eid */
  producersOf(team, what) {
    return this.world.structures
      .filter((s) => s.team === team && !s.destroyed && !s.removed && s.produces.includes(what))
      .sort((a, b) => a.eid - b.eid);
  }

  /** Every id in `requires` has an own finished building */
  requirementsMet(team, requires = []) {
    return requires.every((id) => this.world.structures.some((s) => s.team === team && s.unitId === id && s.complete && !s.destroyed));
  }

  missingRequirements(team, requires = []) {
    return requires.filter((id) => !this.requirementsMet(team, [id]));
  }

  /**
   * Vehicles / crew a building can make for its team: [{ kind: 'vehicle'|'crew', unitId, stats }] (data order).
   * Requirements, cost and queue space are NOT checked here – use check() with a queueUnit command.
   */
  unitOptions(structure) {
    const out = [];
    const team = structure.team;
    const race = this.raceOf(team);
    const produces = structure.produces;
    const crewAt = [].concat(getStats().crew?.producedAt ?? []);
    if (produces.includes(PRODUCES.crew) && crewAt.includes(structure.unitId)) {
      out.push({ kind: 'crew', unitId: null, stats: crewStats(race, team) });
    }
    if (produces.includes(PRODUCES.vehicle)) {
      const all = getStats().vehicles ?? {};
      for (const id of Object.keys(all)) {
        if (!this.#vehicleAllowed(structure, id)) continue;
        out.push({ kind: 'vehicle', unitId: id, stats: unitStats('vehicles', id, race, team) });
      }
    }
    // [R5] the main building makes a builder (same cost / time as in the factory) only while the team has none
    const fallback = this.#fallbackBuilder(structure);
    if (fallback && !out.some((o) => o.unitId === fallback) && !this.hasBuilder(team, null)) {
      out.push({ kind: 'vehicle', unitId: fallback, stats: unitStats('vehicles', fallback, race, team) });
    }
    return out;
  }

  /** [R5] Builder vehicle id a finished building may make when the team has no builder (stats.builderFallback), or null */
  #fallbackBuilder(structure) {
    const id = structure.stats?.builderFallback;
    if (!id || !structure.complete || structure.destroyed || structure.removed) return null;
    const raw = getStats().vehicles?.[id];
    if (!raw || raw.buildable === false || !this.#isBuilderId(id)) return null;
    return canProduce(this.raceOf(structure.team), 'vehicles', id, this.unlocksOf(structure.team)) ? id : null;
  }

  #isBuilderId(unitId) {
    return Boolean(getStats().vehicles?.[unitId]?.abilities?.some((a) => a.type === 'construct'));
  }

  /**
   * [R5] Does the team have a builder: a living vehicle with the construct ability, one queued in any producer, or one
   * finished and still entering the world. `except` (a queue item) and queued items that start after it are ignored
   * (start check of an item: it must not cancel itself or the item of another building that is older).
   */
  hasBuilder(team, except = null) {
    for (const v of this.world.vehicles ?? []) {
      if (v.team === team && !v.dead && !v.removed && !v.destroyed && v.canConstruct) return true;
    }
    for (const items of this.queues.values()) {
      for (const i of items) {
        if (i.team !== team || i.kind !== 'vehicle' || !this.#isBuilderId(i.unitId)) continue;
        if (except && (i === except || (i.elapsed <= 0 && i.id > except.id))) continue;
        return true;
      }
    }
    const pending = this.world.pendingSpawns ?? [];
    for (const b of this.pendingBuilders) {
      if (b.team === team && pending.some((e) => e.eid === b.eid)) return true;
    }
    return false;
  }

  /**
   * [A15] Vehicles this building will make once the team's research tier opens (UI "requires tier N"):
   * [{ unitId, tier }] in data order – only those the tier alone blocks (Stats.tierLocked). Read-only, UI use.
   */
  tierLockedUnits(structure) {
    const out = [];
    if (!structure.produces?.includes(PRODUCES.vehicle)) return out;
    const race = this.raceOf(structure.team);
    const unlocks = this.unlocksOf(structure.team);
    const all = getStats().vehicles ?? {};
    for (const id of Object.keys(all)) {
      const raw = all[id];
      if (raw.buildable === false || ![].concat(raw.producedAt ?? []).includes(structure.unitId)) continue;
      const tier = tierLocked(race, 'vehicles', id, unlocks);
      if (tier) out.push({ unitId: id, tier });
    }
    return out;
  }

  #vehicleAllowed(structure, id) {
    const raw = getStats().vehicles?.[id];
    return Boolean(raw) && raw.buildable !== false && [].concat(raw.producedAt ?? []).includes(structure.unitId)
      && canProduce(this.raceOf(structure.team), 'vehicles', id, this.unlocksOf(structure.team));
  }

  /** Parts of a slot the team may make: catalog entries [{ path, set, race }] (PartStock.partOptions) */
  partOptions(team, slot) {
    return partOptions(this.catalog, slot, this.raceOf(team), this.unlocksOf(team));
  }

  /** Stocked parts of a part slot (legs, torso, 'arm'): catalog entries with count > 0 (arms: the left model = stock key) */
  stockedParts(team, slot) {
    return (this.catalog?.[catalogSlot(slot)] ?? []).filter((p) => (this.stock?.count(team, p.path) ?? 0) > 0);
  }

  /** Research ids a facility can run for its team (any status – check() tells which can be queued) */
  researchOptions(structure) {
    const r = this.research;
    if (!r) return [];
    return r.available(structure.team).filter((id) => {
      const def = r.defs[id];
      return !def.researchedAt || [].concat(def.researchedAt).includes(structure.unitId);
    });
  }

  /** Assembly in progress in a bay (draft or queued mech): no mech drives in for service (Repair.bayAssembling) */
  isAssembling(bay) {
    return Boolean(bay.assemblyDraft) || this.itemsOf(bay.eid).some((i) => i.kind === 'mech');
  }

  // ---------- commands ----------

  /**
   * Can this production command run now? @returns {{ ok, reason, cost?, supply? }} (REASON.*)
   * Used by the command validators, the UI (messages) and the AI.
   */
  check(cmd) {
    const plan = this.#plan(cmd);
    return { ok: !plan.reason, reason: plan.reason, cost: plan.cost, supply: plan.supply };
  }

  /** Runs a production command (called by the command executors). @returns {boolean} done */
  apply(cmd) {
    const plan = this.#plan(cmd);
    if (plan.reason) return false;
    plan.run();
    return true;
  }

  #plan(cmd) {
    if (!cmd || typeof cmd.team !== 'number' || !this.races[cmd.team]) return no(REASON.noProduction);
    switch (cmd.type) {
      case 'queueUnit': return this.#planUnit(cmd);
      case 'queuePart': return this.#planPart(cmd);
      case 'queueMech': return this.#planMech(cmd);
      case 'queueResearch': return this.#planResearch(cmd);
      case 'queueAnalysis': return this.#planAnalysis(cmd);
      case 'cancelProduction': return this.#planCancel(cmd);
      case 'setRally': return this.#planRally(cmd);
      case 'setSpawnStance': return this.#planSpawnStance(cmd);
      case 'releaseBayCrew': return this.#planBayCrew(cmd);
      case 'setAssemblyDraft': return this.#planDraft(cmd);
      case 'serviceRepair': case 'serviceSwap': case 'serviceCancel': case 'serviceRelease': return this.#planService(cmd);
      default: return no(REASON.noProduction);
    }
  }

  /** Own finished building that makes `what`, or null */
  #producer(cmd, what, key = 'producer') {
    const s = this.world.entityById?.(cmd[key]) ?? null;
    if (!s || !s.isStructure || s.removed || s.destroyed || s.team !== cmd.team) return null;
    return s.produces.includes(what) ? s : null;
  }

  /** Common checks of a paid item: queue space, population, resources */
  #affordable(team, producer, cost = {}, supply = 0) {
    if (this.isFull(producer.eid)) return REASON.full;
    const eco = this.economy;
    if (!eco) return REASON.none;
    if (!eco.canSupport(team, supply)) return REASON.population;
    if (!eco.canAffordUpfront(team, cost)) return REASON.resources; // [W5b] deferred energy is paid at the start
    return REASON.none;
  }

  #planUnit(cmd) {
    const crew = cmd.kind === 'crew';
    let s = this.#producer(cmd, crew ? PRODUCES.crew : PRODUCES.vehicle);
    if (!s && !crew) { // [R5] main building: only the builder fallback (unitOptions decides if it is offered now)
      const h = this.world.entityById?.(cmd.producer) ?? null;
      if (h?.isStructure && !h.removed && !h.destroyed && h.team === cmd.team && this.#fallbackBuilder(h)) s = h;
    }
    if (!s) return no(REASON.producer);
    const option = this.unitOptions(s).find((o) => o.kind === cmd.kind && (crew || o.unitId === cmd.unitId));
    if (!option) return no(REASON.locked);
    const { stats } = option;
    const cost = stats.cost ?? {};
    const supply = stats.supply ?? 0;
    if (!this.requirementsMet(cmd.team, stats.requires)) return no(REASON.requires, { cost, supply });
    const reason = this.#affordable(cmd.team, s, cost, supply);
    if (reason) return no(reason, { cost, supply });
    return ok({
      cost, supply,
      run: () => this.#enqueue(s, { kind: cmd.kind, unitId: crew ? null : cmd.unitId, cost, supply, buildTime: stats.buildTime }),
    });
  }

  #planPart(cmd) {
    const s = this.#producer(cmd, PRODUCES.part);
    if (!s) return no(REASON.producer);
    if (!PART_SLOTS.includes(cmd.slot)) return no(REASON.locked); // legs | torso | arm (arms are universal)
    const key = stockKey(cmd.path);
    const entry = typeof key === 'string' ? this.partOptions(cmd.team, cmd.slot).find((p) => p.path === key) : null;
    if (!entry) return no(REASON.locked);
    const stats = partStats(entry.path, catalogSlot(cmd.slot), this.raceOf(cmd.team));
    const cost = stats.cost ?? {};
    const reason = this.#affordable(cmd.team, s, cost, 0);
    if (reason) return no(reason, { cost, supply: 0 });
    return ok({
      cost, supply: 0,
      run: () => this.#enqueue(s, { kind: 'part', slot: cmd.slot, path: entry.path, set: entry.set, cost, supply: 0, buildTime: stats.buildTime }),
    });
  }

  /** Sanitised loadout { slot: path|null } or null when invalid (unknown slot path, missing required part) */
  #loadout(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const loadout = {};
    for (const slot of MECH_SLOTS) {
      const path = raw[slot] ?? null;
      if (path !== null && (typeof path !== 'string' || !catalogEntry(this.catalog, slot, path))) return null;
      loadout[slot] = path;
    }
    return ROBOT_PRODUCTION.requiredSlots.every((slot) => loadout[slot]) ? loadout : null;
  }

  #planMech(cmd) {
    const s = this.#producer(cmd, PRODUCES.mech);
    if (!s) return no(REASON.producer);
    if (s.service) return no(REASON.service);
    const loadout = this.#loadout(cmd.loadout);
    if (!loadout) return no(REASON.parts);
    // Empty arms take nothing; both arms of one type draw on the same stock entry (1 in stock = one arm only)
    const used = MECH_SLOTS.map((slot) => stockKey(loadout[slot])).filter(Boolean);
    const stock = this.stock;
    if (!stock || !used.every((p) => stock.count(cmd.team, p) >= used.filter((o) => o === p).length)) return no(REASON.parts);
    const race = this.raceOf(cmd.team);
    const { supply = 0 } = mechStatsFromLoadout(loadout, race);
    const { cost, buildTime } = mechAssemblyStats(race);
    const reason = this.#affordable(cmd.team, s, cost, supply);
    if (reason) return no(reason, { cost, supply });
    return ok({
      cost, supply,
      run: () => {
        for (const p of used) stock.take(cmd.team, p);
        s.assemblyDraft = false; // the queued assembly keeps the bay busy now
        this.#enqueue(s, { kind: 'mech', loadout, parts: used, cost, supply, buildTime });
      },
    });
  }

  #planResearch(cmd) {
    const r = this.research;
    const s = this.#producer(cmd, PRODUCES.research);
    if (!s || !r) return no(REASON.producer);
    const id = cmd.researchId;
    if (typeof id !== 'string' || !this.researchOptions(s).includes(id)) return no(REASON.locked);
    const cost = r.defs[id].cost ?? {};
    const status = r.status(cmd.team, id);
    if (!status.ok) return no(status.reason === 'done' || status.reason === 'active' ? REASON.active : REASON.locked, { cost, supply: 0 });
    const reason = this.#affordable(cmd.team, s, cost, 0);
    if (reason) return no(reason, { cost, supply: 0 });
    return ok({
      cost, supply: 0,
      run: () => {
        r.markActive(cmd.team, id, s);
        this.#enqueue(s, { kind: 'research', researchId: id, cost, supply: 0, buildTime: r.timeOf(cmd.team, id) });
      },
    });
  }

  #planAnalysis(cmd) {
    const r = this.research;
    const s = this.#producer(cmd, PRODUCES.research);
    if (!s || !r) return no(REASON.producer);
    const loot = r.analyses(cmd.team).find((l) => l.key === cmd.lootKey);
    if (!loot) return no(REASON.locked);
    if (r.isActive(cmd.team, loot.key)) return no(REASON.active);
    const { cost, buildTime } = r.analysisStats(cmd.team, loot);
    const reason = this.#affordable(cmd.team, s, cost, 0);
    if (reason) return no(reason, { cost, supply: 0 });
    return ok({
      cost, supply: 0,
      run: () => {
        r.markActive(cmd.team, loot.key, s);
        this.#enqueue(s, { kind: 'analysis', lootKey: loot.key, set: loot.set, lootKind: loot.kind, cost, supply: 0, buildTime });
      },
    });
  }

  #planCancel(cmd) {
    const item = this.itemById(cmd.itemId);
    if (!item || item.team !== cmd.team) return no(REASON.item);
    return ok({ run: () => this.cancel(item.id) });
  }

  /** [R4] Own finished building that spawns units (any of vehicle / crew / mech), or null */
  #gatherer(cmd) {
    const s = this.world.entityById?.(cmd.structure) ?? null;
    if (!s || !s.isStructure || s.removed || s.destroyed || s.team !== cmd.team) return null;
    return canGather(s) ? s : null;
  }

  /** [R4] { type: 'setRally', team, structure, points: [{x, z}], append? } – empty points clear the chain */
  #planRally(cmd) {
    const s = this.#gatherer(cmd);
    if (!s) return no(REASON.producer);
    if (!Array.isArray(cmd.points) || cmd.points.length > RALLY.maxPoints
      || !cmd.points.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.z))) return no(REASON.rally);
    const points = cmd.points.map((p) => ({ x: p.x, z: p.z }));
    return ok({
      run: () => { s.rally = (cmd.append ? [...s.rally, ...points] : points).slice(0, RALLY.maxPoints); },
    });
  }

  /** [R4] { type: 'setSpawnStance', team, structure, mode } – mode in RALLY.spawnModes, null = unit default */
  #planSpawnStance(cmd) {
    const s = this.#gatherer(cmd);
    if (!s) return no(REASON.producer);
    const mode = cmd.mode ?? null;
    if (mode !== null && !RALLY.spawnModes.includes(mode)) return no(REASON.rally);
    return ok({ run: () => { s.spawnBehaviour = mode; } });
  }

  /** [N2] { type: 'releaseBayCrew', team, bay } – every crew waiting in the bay walks out (free spots around it) */
  #planBayCrew(cmd) {
    const s = this.#producer(cmd, PRODUCES.mech, 'bay');
    if (!s) return no(REASON.producer);
    if (!bayCrewCount(s)) return no(REASON.bayCrew);
    return ok({ run: () => { releaseAll(s); } });
  }

  /**
   * [R4] Gives a produced unit its stance and walks it through the rally chain (first point replaces, the others
   * queue). Runs inside the tick at the moment the unit has entered the world (deterministic, same on every client).
   * [N2] A mech from a bay first takes the bay's first waiting crew; a mech still without an active crew keeps the
   * chain (heldRally) and walks it once it becomes active (crew from the queue, or a later 'board').
   */
  #applyGather(unit, { rally, behaviour, bay }) {
    if (unit.isMech && bay) this.#crewFromBay(unit, bay);
    if (behaviour) unit.setBehaviour?.(behaviour); // a crew refuses 'aggressive', plain vehicles have no behaviour
    if (!rally.length) return;
    if (unit.isMech && !unit.active) { this.heldRally.push({ mech: unit, rally }); return; }
    this.#walkRally(unit, rally);
  }

  #walkRally(unit, rally) {
    rally.forEach((p, i) => {
      const target = new THREE.Vector3(p.x, this.world.heightAt?.(p.x, p.z) ?? 0, p.z);
      issueOrder(unit, { type: 'move', ref: { target }, run: () => unit.moveTo?.(target) ?? false }, i > 0);
    });
  }

  /** [N2] The new mech takes the first crew waiting in its bay (FIFO); with BAY_CREW.boardInstantly it is active at once */
  #crewFromBay(mech, bay) {
    if (!mech.canBoard || !isCrewBay(bay, mech.team) || !bayCrewCount(bay)) return;
    const crew = takeCrew(bay);
    if (!crew || !mech.boardCrew(crew)) return;
    if (BAY_CREW.boardInstantly) mech.boardTimer = 0;
  }

  #tickGather() {
    if (!this.pendingGather.length) return;
    const tick = this.world.tick ?? 0;
    this.pendingGather = this.pendingGather.filter((entry) => {
      const unit = this.world.entityById?.(entry.eid) ?? null;
      if (unit) { if (!unit.dead && !unit.destroyed) this.#applyGather(unit, entry); return false; }
      return entry.until >= tick; // not placed yet (model loading): keep waiting for a while
    });
  }

  /** [N2] Crewless mechs remembering a rally chain: the first tick they are active, they set off (in push order) */
  #tickHeld() {
    if (!this.heldRally.length) return;
    this.heldRally = this.heldRally.filter(({ mech, rally }) => {
      if (mech.destroyed || mech.removed) return false;
      if (!mech.active || mech.inside) return true;
      this.#walkRally(mech, rally);
      return false;
    });
  }

  /** [N2] Crews waiting in a bay that was destroyed / removed walk out (world.crews order: same on every client) */
  #releaseLostBays() {
    for (const crew of this.world.crews ?? []) {
      const bay = crew.bay;
      if (bay && (bay.destroyed || bay.removed || !bay.produces.includes(PRODUCES.mech))) {
        if (!releaseCrew(bay, crew, { force: true })) crew.leaveBay(bay.position.clone(), bay.rotation.y);
      }
    }
  }

  #planDraft(cmd) {
    const s = this.#producer(cmd, PRODUCES.mech, 'bay');
    if (!s) return no(REASON.producer);
    const on = Boolean(cmd.on);
    if (on && s.service) return no(REASON.service);
    return ok({ run: () => { s.assemblyDraft = on; } });
  }

  #planService(cmd) {
    const s = this.#producer(cmd, PRODUCES.mech, 'bay');
    if (!s) return no(REASON.producer);
    const service = s.service;
    if (!service) return no(REASON.noService);
    const task = service.task;
    switch (cmd.type) {
      case 'serviceRepair':
        if (task?.mounting || !service.mech.damaged) return no(REASON.noService);
        return ok({ run: () => startBayRepair(s) });
      case 'serviceSwap': {
        if (task?.mounting || !MECH_SLOTS.includes(cmd.slot)) return no(REASON.noService);
        const path = cmd.path ?? null;
        if (path !== null && (typeof path !== 'string' || !catalogEntry(this.catalog, cmd.slot, path))) return no(REASON.noService);
        return ok({ run: () => startSwap(s, cmd.slot, path) }); // startSwap checks stock / required slots itself
      }
      case 'serviceCancel':
        if (!task || task.mounting) return no(REASON.noService);
        return ok({ run: () => cancelTask(s) });
      default: // serviceRelease
        if (!canRelease(s)) return no(REASON.noService);
        return ok({ run: () => releaseMech(s) });
    }
  }

  // ---------- queue ----------

  #enqueue(structure, { buildTime = 0, ...data }) {
    const eid = structure.eid;
    if (!this.queues.has(eid)) this.queues.set(eid, []);
    const team = structure.team;
    const eco = this.economy;
    const due = eco?.dueOf(data.cost ?? {}) ?? null; // [W5b] paid when the item really starts (update)
    if (eco) {
      eco.payUpfront(team, data.cost ?? {});
      eco.reserve(team, data.supply ?? 0);
    }
    const item = {
      id: this.nextItemId++, team, producer: eid, ...data,
      total: Math.max(0, (buildTime ?? 0) * HUD.production.timeScale), elapsed: 0,
    };
    if (due) { item.due = due; item.paid = {}; }
    this.queues.get(eid).push(item);
    return item;
  }

  /** Removes an item before it is done: refund, population, parts back, research free again */
  cancel(id) {
    for (const [eid, items] of this.queues) {
      const index = items.findIndex((i) => i.id === id);
      if (index < 0) continue;
      const [item] = items.splice(index, 1);
      if (!items.length) this.queues.delete(eid);
      this.#refund(item);
      return true;
    }
    return false;
  }

  #refund(item) {
    const eco = this.economy;
    if (eco) {
      eco.release(item.team, item.supply ?? 0);
      // [W5b] the deferred part comes back only when it was paid (item.paid)
      eco.refundPaid(item.team, item.cost ?? {}, item.paid ?? null, getStats().rules.production?.cancelRefund ?? 1);
    }
    if (item.kind === 'mech' && ROBOT_PRODUCTION.cancelReturnsParts) for (const p of item.parts ?? []) this.stock?.add(item.team, p);
    if (item.kind === 'research') this.research?.clearActive(item.team, item.researchId);
    if (item.kind === 'analysis') this.research?.clearActive(item.team, item.lootKey);
  }

  /** Cancels the whole queue of a producer (its building was destroyed / removed) */
  cancelProducer(eid) {
    for (const item of [...this.itemsOf(eid)]) this.cancel(item.id);
    this.queues.delete(eid);
  }

  // ---------- per tick ----------

  update(dt) {
    this.#tickGather(); // [R4] produced units that entered the world since the last tick
    this.#tickHeld(); // [N2] crewless mechs whose crew got in: off to the rally chain
    this.#releaseLostBays(); // [N2] crews in a lost bay come out
    if (this.pendingBuilders.length) { // [R5] builders that entered the world (or failed to load) no longer count as pending
      this.pendingBuilders = this.pendingBuilders.filter((b) => this.world.pendingSpawns?.some((e) => e.eid === b.eid));
    }
    // Assembly bays of every team: busy while a draft or a queued mech holds them (Repair.bayAssembling)
    for (const s of this.world.structures) {
      if (s.isStructure && !s.destroyed && s.produces.includes(PRODUCES.mech)) s.assemblyBusy = this.isAssembling(s);
    }
    for (const eid of this.#producerIds()) {
      const structure = this.world.entityById?.(eid) ?? null;
      if (!structure || structure.destroyed || structure.removed) { this.cancelProducer(eid); continue; }
      const items = this.itemsOf(eid);
      const item = items[0];
      if (!item) { this.queues.delete(eid); continue; }
      // [R5] a fallback builder of the main building that has not started: a builder came from elsewhere meanwhile –
      // the item is cancelled (refund by the usual rules); factory builders are never affected
      if (item.kind === 'vehicle' && item.elapsed <= 0 && structure.stats?.builderFallback === item.unitId
        && !this.#vehicleAllowed(structure, item.unitId) && this.hasBuilder(item.team, item)) {
        this.cancel(item.id);
        continue;
      }
      // One place in the bay: an assembly does not start while a mech is serviced there
      if (item.kind === 'mech' && item.elapsed <= 0 && structure.service) continue;
      // [W5b] the real start: the deferred part of the cost (energy); without it the item waits, drawing nothing
      if (item.due && this.economy?.hasDue(item.due) && !this.economy.payDue(item.team, item.due, item.paid)) continue;
      // [D1] a working producer draws its energy; low energy slows it (Economy.drawPower → work rate)
      // [A9-buildings] × construction enhancer production aura (Auras.js) – not for research / analysis
      if (item.elapsed < item.total) {
        item.elapsed += dt * (this.economy?.drawPower(structure, dt) ?? 1) * (AURA_EXEMPT_KINDS.includes(item.kind) ? 1 : productionFactor(structure));
      }
      else item.elapsed += dt;
      if (item.elapsed < item.total) continue;
      // [R1] a produced unit needs a free spot around its building: hold the finished item until one frees up
      if (SPAWNS_UNIT.includes(item.kind) && !structure.findSpawnPoint()) {
        item.elapsed = item.total;
        if (!item.spawnBlocked) {
          item.spawnBlocked = true;
          for (const fn of this.spawnBlockedListeners) { try { fn(item, structure); } catch (err) { console.error(err); } }
        }
        continue;
      }
      item.spawnBlocked = false;
      items.shift();
      if (!items.length) this.queues.delete(eid);
      this.#complete(item, structure);
    }
  }

  #complete(item, structure) {
    const team = item.team;
    const race = this.raceOf(team);
    const eco = this.economy;
    const spawn = (fn, ...args) => {
      // The queue's reservation ends now; a spawned unit's population moves to its pending spawn (World.holdSupply)
      // and counts until the unit enters the world – no gap where canSupport lets another item over the cap
      eco?.release(team, item.supply);
      if (typeof fn !== 'function') return;
      const at = structure.nextSpawnPoint(); // taken now, in tick order (deterministic spot)
      try {
        const result = fn(team, race, ...args, at, structure);
        if (result?.eid != null) this.world.holdSupply?.(result.eid, team, item.supply ?? 0);
        if (result?.eid != null && item.kind === 'vehicle' && this.#isBuilderId(item.unitId)) this.pendingBuilders.push({ team, eid: result.eid });
        // [R4] the reserved entity id: stance and rally chain are applied once the unit exists (#tickGather)
        // [N2] a mech always waits there too: it takes a crew from the bay queue when it appears
        const mech = item.kind === 'mech';
        if (result?.eid != null && (structure.rally?.length || structure.spawnBehaviour || mech)) {
          this.pendingGather.push({
            eid: result.eid, rally: structure.rally.map((p) => ({ ...p })), behaviour: structure.spawnBehaviour,
            until: (this.world.tick ?? 0) + RALLY.applyTimeoutTicks, bay: mech ? structure : null,
          });
        }
        Promise.resolve(result).catch((err) => console.error(err));
      } catch (err) { console.error(err); }
    };
    switch (item.kind) {
      case 'vehicle': spawn(this.spawn.vehicle, item.unitId); break;
      case 'crew': spawn(this.spawn.crew); break;
      case 'mech': spawn(this.spawn.mech, { ...item.loadout }); break;
      case 'part': this.stock?.add(team, item.path); break;
      case 'research': this.research?.complete(team, item.researchId); break;
      case 'analysis': {
        const loot = this.research?.teams[team]?.loot.get(item.lootKey);
        if (loot) this.research.completeAnalysis(team, loot); else this.research?.clearActive(team, item.lootKey);
        break;
      }
      default: break;
    }
    try { this.onComplete?.(item); } catch (err) { console.error(err); }
    for (const fn of this.completeListeners) {
      try { fn(item); } catch (err) { console.error(err); }
    }
  }
}
