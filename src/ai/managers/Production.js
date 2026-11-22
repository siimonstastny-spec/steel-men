// Steel Mans AI – production: vehicles (trucks, builders, combat vehicles), crews for every robot, robot parts and
// their assembly. Robots are planned as loadouts ("plans") scored from the part stats of what the team may make
// now (data/ai/armies.json: role weights, cost limits, score weights) – no part or faction names in the code.
// Everything is queued through the production commands after world.production.check() says they can run; the
// resources Construction keeps for its next building (bb.reserved) are not spent on normal-priority items.
import { AI, ARMS } from '../../config.js';
import { partStats, weaponDps, unitStats, applyArmor, crewStats } from '../../data/Stats.js';
import { MECH_SLOTS, PART_SLOTS, ARM_SLOTS, stockKey, armModel, catalogSlot } from '../../game/PartStock.js';
import { PRODUCES, REASON } from '../../game/Production.js';
import { PRIORITY, weightedPick, affordsAbove, weaponDefsOf } from '../util.js';
import { vehicleMatches, resolveVehicles, hitsAir } from '../AiData.js';

/** Items a producer may hold before the AI queues more there (keeps queues short and flexible) */
const MAX_AI_QUEUE = 2;
/** Commands just issued count as queued for this long (s) – they run at the next tick */
const INFLIGHT_SECONDS = 2;
/** Candidates kept per slot when scoring loadouts */
const TOP_ARMS = 6;
const TOP_TORSOS = 6;
const groundWeapons = (st) => (st.weapons ?? []).filter((w) => (w.targets ?? ['ground']).includes('ground'));
const airDps = (st) => (st.weapons ?? []).filter(hitsAir).reduce((s, w) => s + weaponDps(w), 0);
/** R3: vehicle roles whose finished units count as in flight (besides bb.minVehicles) */
const EXTRA_VEHICLE_ROLES = ['@combatVehicle', '@aircraft'];
/** R3: robot role of anti-air plans (not in armies.json – Military sets its stance / behaviour from its weapons) */
const ANTI_AIR_ROLE = 'antiAir';

export class ProductionManager {
  constructor(ai) {
    this.ai = ai;
    this.plans = [];        // robot loadouts being produced: { role, loadout, slots: { path: slot } }
    this.inflight = [];     // { what, until } – commands issued, not executed yet
    this.spawning = [];     // [E1] { supply, until } – finished units with population not in the world yet
    this.statCache = new Map();
    this.cacheTime = -Infinity;
  }

  get prod() { return this.ai.world.production; }
  get team() { return this.ai.team; }

  think(now) {
    this.inflight = this.inflight.filter((f) => f.until > now);
    if (this.spawning.length) this.spawning = this.spawning.filter((s) => s.until > now);
    if (now - this.cacheTime > AI.partStatsCacheSeconds) { this.statCache.clear(); this.cacheTime = now; }
    // v2: Production.addCompleteListener tells exactly when an item finished; older game builds: queue diffing
    if (!this.unlisten && this.prod.addCompleteListener) {
      this.unlisten = this.prod.addCompleteListener((item) => this.#onComplete(item));
      this.listenProd = this.prod;
    }
    if (!this.unlisten) this.#trackFinished(now);
    this.#airPlan(now);
    this.#vehicles(now);
    this.#releasePopulation(now);
    // v4: economy hold (Economy #econ: too few trucks) – no crews, parts or robots until the trucks are ordered
    if (this.ai.bb.econ?.hold) { this.econHeld = (this.econHeld ?? 0) + 1; return; }
    this.#crews(now);
    this.#mechs(now);
  }

  // ---------- helpers ----------

  #items(kind) { return this.prod.itemsOfTeam(this.team).filter((i) => i.kind === kind); }

  #inflightCount(what) { return this.inflight.filter((f) => f.what === what).length; }

  /**
   * A finished vehicle / crew leaves the queue a moment before it appears in the world (deferred spawn) and in
   * Perception: it counts as in flight meanwhile, so it is not ordered twice.
   */
  #trackFinished(now) {
    const current = new Map();
    for (const i of this.prod.itemsOfTeam(this.team)) {
      if (i.kind === 'crew') current.set(i.id, ['crew']);
      else if (i.kind === 'vehicle') current.set(i.id, Object.keys(this.ai.bb.minVehicles).concat(EXTRA_VEHICLE_ROLES).filter((v) => vehicleMatches(v, i.unitId)));
    }
    for (const [id, whats] of this.seen ?? []) {
      if (current.has(id)) continue;
      for (const what of whats) this.inflight.push({ what, until: now + AI.perceptionInterval * 2 + INFLIGHT_SECONDS });
    }
    this.seen = current;
  }

  /** Completion listener: a finished crew / vehicle counts as in flight until Perception lists it */
  #onComplete(item) {
    if (item.team !== this.team || !this.ai.enabled) return;
    const until = this.ai.now + AI.perceptionInterval * 2 + INFLIGHT_SECONDS;
    // [E1] the unit's id was reserved just now (World.spawnDeferred, synchronously before the listeners): its
    // population counts until that id enters the world (#freePopulation), at most AI.spawnPopulationSeconds
    if ((item.supply ?? 0) > 0 && (item.kind === 'crew' || item.kind === 'vehicle')) {
      this.spawning.push({ supply: item.supply, eid: this.ai.world.nextEid - 1, until: this.ai.now + AI.spawnPopulationSeconds });
    }
    if (item.kind === 'crew') this.inflight.push({ what: 'crew', until });
    else if (item.kind === 'vehicle') {
      for (const what of Object.keys(this.ai.bb.minVehicles).concat(EXTRA_VEHICLE_ROLES)) {
        if (vehicleMatches(what, item.unitId)) this.inflight.push({ what, until });
      }
    }
  }

  /**
   * R3: energy gate of aircraft / anti-air robots – the store runs low (isLowEnergy), or the plan is short (Economy
   * powerShort) AND the store is below difficulty.power.stockShare of its cap. [E1] Before, a short plan alone held
   * them: hard (seed 11) had a hangar and no aircraft for 7 min – planned use 69 × coverage > income while the plants
   * waited for ore, the store itself was fine.
   */
  energyShort() {
    const eco = this.ai.world.economy;
    if (!eco) return false;
    if (eco.isLowEnergy?.(this.team)) return true;
    if (!this.ai.economy?.powerShort) return false;
    const share = this.ai.diff.power?.stockShare ?? 0;
    return eco.amount(this.team, 'energy') < eco.energyCapOf(this.team) * share;
  }

  /** Removes the completion listener (AiPlayer.stop) */
  dispose() { this.unlisten?.(); this.unlisten = null; }

  /** Finished own producers of `what`, least busy first (only those with room in the AI's short queue) */
  #producers(what, limit = Infinity) {
    return this.prod.producersOf(this.team, what).slice(0, limit)
      .filter((s) => s.complete && this.prod.itemsOf(s.eid).length < MAX_AI_QUEUE)
      .sort((a, b) => this.prod.itemsOf(a.eid).length - this.prod.itemsOf(b.eid).length);
  }

  /**
   * Enough resources once the reservation of Construction is respected. High priority ignores bb.reserved, but v4:
   * not the economy reserve (bb.econReserve – vehicle factory / supply in an economy trap), except trucks themselves
   * and anything while defending.
   */
  #canSpend(cost = {}, priority, what = null) {
    const eco = this.ai.world.economy;
    const bb = this.ai.bb;
    const econExempt = what === '@harvester' || bb.state === 'defend';
    const reserved = priority >= PRIORITY.high ? (econExempt ? {} : (bb.econReserve ?? {})) : (bb.reserved ?? {});
    // [E1] parts (normal priority, not the aircraft itself) leave the ore of an aircraft that waits for money
    const air = priority < PRIORITY.high && what !== '@aircraft' && bb.state !== 'defend' ? this.airCost : null;
    const ok = affordsAbove(eco, this.team, cost, reserved, air);
    if (!ok && priority >= PRIORITY.high && !econExempt && Object.keys(bb.econReserve ?? {}).length) this.econReserved = (this.econReserved ?? 0) + 1;
    return ok;
  }

  #starve(cost) {
    const eco = this.ai.world.economy;
    const missing = Object.keys(eco.missing(this.team, cost ?? {}));
    for (const r of missing) this.ai.bb.starved[r] = this.ai.now;
    if (missing.length) this.ai.budget?.wait('army', missing); // v3: the army bucket waits for money
  }

  /**
   * Checks and issues a production command; `what` marks it as in flight. `popReserve` [E1]: the unit must leave the
   * population kept for aircraft (#airPlan) free. this.lastFail = why it was not issued ('' when it was).
   * @returns {boolean} issued
   */
  #try(cmd, priority, what, { popReserve = false } = {}) {
    const res = this.prod.check({ ...cmd, team: this.team });
    this.lastFail = '';
    if (!res.ok) {
      this.lastFail = res.reason;
      if (res.reason === REASON.resources) this.#starve(res.cost);
      return false;
    }
    // [E1] every unit with population also waits for the units still spawning (#freePopulation)
    if (!this.#fitsPopulation(res.supply ?? 0, popReserve)) {
      this.popHeld = (this.popHeld ?? 0) + 1;
      this.lastFail = REASON.population;
      return false;
    }
    if (!this.#canSpend(res.cost, priority, what)) { this.#starve(res.cost); this.lastFail = REASON.resources; return false; }
    // v3: budget buckets (Budget.js) – normal priority gives way while research waits below its phase share
    if (priority < PRIORITY.high && this.ai.budget && !this.ai.budget.allows('army', res.cost)) {
      this.budgetHeld = (this.budgetHeld ?? 0) + 1;
      this.lastFail = 'budget';
      return false;
    }
    this.ai.issue(cmd, { priority });
    this.inflight.push({ what, until: this.ai.now + INFLIGHT_SECONDS });
    // [E1] the command waits in the rate limiter: its population counts until the game reserves it
    if ((res.supply ?? 0) > 0) this.spawning.push({ supply: res.supply, until: this.ai.now + INFLIGHT_SECONDS });
    if (what !== '@harvester' && what !== '@builder') this.ai.budget?.record('army', res.cost);
    return true;
  }

  // ---------- vehicles ----------

  #vehicles(now) {
    const ai = this.ai;
    const own = ai.perception.own;
    const wants = { ...ai.bb.minVehicles };
    if (ai.bb.openingDone && ai.diff.combatVehicleShare > 0) {
      wants['@combatVehicle'] = Math.floor(own.crewedMechs.length * ai.diff.combatVehicleShare);
    }
    // R3 (difficulty.air): aircraft – the number #airPlan wants
    const waited = this.airWaitsForPopulation;
    this.airWaitsForPopulation = false;
    this.airCost = null;
    if (this.airWant > 0) wants['@aircraft'] = this.airWant;
    const queued = this.#items('vehicle');
    // v4: trucks first (one vehicle per think); in the economy hold only trucks (a builder only when none is left)
    const hold = ai.bb.econ?.hold;
    // [v20] aircraft before combat vehicles: a free population slot goes to the aircraft first
    const rank = (v) => (v === '@harvester' ? 0 : v === '@combatVehicle' ? 3 : v === '@aircraft' ? 2 : 1);
    const entries = Object.entries(wants).sort(([a], [b]) => rank(a) - rank(b));
    const factories = this.#producers(PRODUCES.vehicle);
    if (!factories.length) return;
    for (const [value, want] of entries) {
      if (!want) continue;
      if (hold && value !== '@harvester' && !(value === '@builder' && !own.builders.length)) continue;
      if (value === '@aircraft' && this.energyShort()) continue; // R3: energy gate
      if (value === '@combatVehicle' && this.airWaitsForPopulation) continue; // [v20] the aircraft gets the population
      const have = this.#haveVehicles(value, queued);
      if (have >= want) continue;
      // R3: the first producer that can make this role (a hangar makes no trucks, a vehicle factory no aircraft)
      let factory = null;
      let id = null;
      for (const f of factories) {
        id = this.#vehicleFor(value, f);
        if (id) { factory = f; break; }
      }
      if (!id) continue;
      const priority = value === '@combatVehicle' || value === '@aircraft' ? PRIORITY.normal : PRIORITY.high;
      const cmd = { type: 'queueUnit', producer: factory.eid, kind: 'vehicle', unitId: id };
      // [E1] combat vehicles leave the aircraft reserve free; trucks / builders (economy) do not wait for it
      const issued = this.#try(cmd, priority, value, { popReserve: value === '@combatVehicle' });
      if (issued || value !== '@aircraft') return; // one per think: the factory list changed
      if (this.lastFail === REASON.population) {
        // the population is full (the reserve came too late or the army took no losses): crews and combat vehicles
        // wait (#airPlan reserve), #releasePopulation cancels queued ones after air.releaseAfter s
        this.airWaitsForPopulation = true;
        this.airPopHeld = (this.airPopHeld ?? 0) + 1;
        if (!waited) this.airPopSince = now;
      } else if (this.lastFail === REASON.resources) {
        this.airCost = this.prod.check({ ...cmd, team: this.team }).cost ?? null; // #canSpend: parts leave it
      }
      return;
    }
  }

  /** Own vehicles answering a role + queued ones + those in flight */
  #haveVehicles(value, queued = this.#items('vehicle')) {
    let n = this.#inflightCount(value);
    for (const v of this.ai.perception.own.vehicles) if (vehicleMatches(value, v.unitId)) n++;
    for (const i of queued) if (vehicleMatches(value, i.unitId)) n++;
    return n;
  }

  // ---------- population plan for aircraft (E1) ----------

  /**
   * [E1] Aircraft wanted (difficulty.air: one per aircraftPerMechs own robots, at least one, at most `aircraft`) and
   * the population kept free for them: from air.reserveFrom s (or once a hangar is owned) the next
   * min(missing, reserveAircraft) aircraft get their supply reserved – crews, combat vehicles and robot assembly
   * (#assemble: a robot needs a crew) do not use it. The reserve rolls: a finished aircraft frees its slot for the
   * next one. Economy counts bb.airPopReserve in the supply headroom, so supply buildings come ahead of it.
   * Before (v20) only the moment an aircraft did not fit held robots – they take no population, so nothing ever
   * freed a place (hard 104/100, airPopHeld growing forever).
   */
  #airPlan(now) {
    const ai = this.ai;
    const air = ai.diff.air;
    this.airWant = 0;
    this.airPop = 0;
    ai.bb.airPopReserve = 0;
    if (!ai.bb.openingDone || !((air?.aircraft ?? 0) > 0) || !((air.aircraftPerMechs ?? 0) > 0)) return;
    this.airWant = Math.min(air.aircraft, Math.max(1, Math.floor(ai.perception.own.mechs.length / air.aircraftPerMechs)));
    const from = air.reserveFrom ?? air.hangarAt;
    const hangar = (ai.construction?.ownedCount('@aircraft') ?? 0) > 0;
    if (!hangar && (from === null || from === undefined || now < from)) return;
    const supply = this.#airSupply();
    if (!(supply > 0)) return;
    const missing = Math.max(0, this.airWant - this.#haveVehicles('@aircraft'));
    this.airPop = Math.min(missing, air.reserveAircraft ?? 1) * supply;
    ai.bb.airPopReserve = this.airPop;
  }

  /** Supply of the biggest aircraft the team may make (the reserve fits whichever #vehicleFor picks); 0 = none */
  #airSupply() {
    const key = 'air|supply';
    if (!this.statCache.has(key)) {
      const ai = this.ai;
      let max = 0;
      for (const id of resolveVehicles('@aircraft', ai.race, ai.teamUnlocks)) {
        max = Math.max(max, unitStats('vehicles', id, ai.race, this.team)?.supply ?? 0);
      }
      this.statCache.set(key, max);
    }
    return this.statCache.get(key);
  }

  /** Population of one crew squad (crewStats clones – cached with the part stats) */
  #crewSupply() {
    const key = 'crew|supply';
    if (!this.statCache.has(key)) this.statCache.set(key, crewStats(this.ai.race, this.team)?.supply ?? 0);
    return this.statCache.get(key);
  }

  /** Empty robots outside bays a crew can reach (Military bb.unreachableMechs are left out) */
  #mechsWaitingForCrew() {
    const bad = this.ai.bb.unreachableMechs;
    let n = 0;
    for (const m of this.ai.perception.own.uncrewedMechs) if (!m.inside && !bad?.has(m.eid)) n++;
    return n;
  }

  /** Does a unit of `supply` fit next to the population kept for aircraft? (reserve false: only the real free room) */
  #fitsPopulation(supply, reserve = true) {
    if (!(supply > 0)) return true;
    return this.#freePopulation(reserve) >= supply;
  }

  /**
   * Free population above the aircraft reserve (Infinity for a team without a population limit). [E1] Units just
   * finished count too: the game releases an item's population when it completes, but the unit enters the world
   * ticks later (World.spawnDeferred) – a check in between passed and the team went over its cap (105/100).
   */
  #freePopulation(reserve = true) {
    const eco = this.ai.world.economy;
    if (!eco?.populationCap) return Infinity;
    let spawning = 0;
    const world = this.ai.world;
    for (const s of this.spawning) {
      if (s.until > this.ai.now && !(s.eid != null && world.entityById(s.eid))) spawning += s.supply;
    }
    return eco.populationCap(this.team) - eco.populationUsed(this.team) - spawning - (reserve ? (this.airPop ?? 0) : 0);
  }

  /**
   * [E1] An aircraft has not fitted the population for air.releaseAfter s: queued items that hold population and
   * are no economy (combat vehicles, then crews no robot waits for) are cancelled, one per AI.air.releaseCooldown s,
   * so the place goes to the aircraft (the game refunds rules.production.cancelRefund). Nothing else frees
   * population without losses – the game has no disband command.
   */
  #releasePopulation(now) {
    const after = this.ai.diff.air?.releaseAfter;
    if (!this.airWaitsForPopulation || after === null || after === undefined || this.ai.bb.state === 'defend') return;
    if (now - (this.airPopSince ?? now) < after || now - (this.releasedAt ?? -Infinity) < AI.air.releaseCooldown) return;
    const items = this.prod.itemsOfTeam(this.team).filter((i) => (i.supply ?? 0) > 0);
    const own = this.ai.perception.own;
    const crewNeed = this.#mechsWaitingForCrew() + this.#items('mech').length
      - own.freeCrews.length - own.bayCrews.length;
    const crews = items.filter((i) => i.kind === 'crew');
    const pick = (list) => list.sort((a, b) => (a.elapsed ?? 0) - (b.elapsed ?? 0))[0] ?? null;
    const item = pick(items.filter((i) => i.kind === 'vehicle' && vehicleMatches('@combatVehicle', i.unitId)
      && !vehicleMatches('@aircraft', i.unitId)))
      ?? (crews.length > Math.max(0, crewNeed) ? pick(crews) : null);
    if (!item) return;
    this.releasedAt = now;
    this.released = (this.released ?? 0) + 1;
    this.ai.issue({ type: 'cancelProduction', itemId: item.id }, { priority: PRIORITY.high, key: `cancel:${item.id}` });
    this.ai.note(`cancel ${item.kind} ${item.unitId ?? ''} – population for an aircraft`);
  }

  /** Vehicle id for a role: cheapest truck / builder, the best value combat vehicle the factory can make */
  #vehicleFor(value, factory) {
    const ai = this.ai;
    const usable = resolveVehicles(value, ai.race, ai.teamUnlocks).filter((id) => {
      const r = this.prod.check({ type: 'queueUnit', team: this.team, producer: factory.eid, kind: 'vehicle', unitId: id }).reason;
      return r !== REASON.locked && r !== REASON.producer && r !== REASON.requires;
    });
    const scored = usable.map((id) => {
      const s = unitStats('vehicles', id, ai.race, this.team);
      const cost = (s.cost?.ore ?? 0) + (s.cost?.energy ?? 0);
      const dps = groundWeapons(s).reduce((sum, w) => sum + weaponDps(w), 0);
      const combat = value === '@combatVehicle' || value === '@aircraft';
      const score = combat ? Math.sqrt(s.hp * dps) / Math.max(1, cost) : -cost;
      return { id, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.id ?? null;
  }

  // ---------- crews ----------

  #crews() {
    const ai = this.ai;
    const own = ai.perception.own;
    const needed = this.#mechsWaitingForCrew() + this.#items('mech').length
      + Math.min(1, this.plans.length) + (ai.diff.crewReserve ?? 0);
    // v3: crews waiting in a bay queue are inside (not free) but will crew the next robots there
    const have = own.freeCrews.length + own.bayCrews.length + this.#items('crew').length + this.#inflightCount('crew');
    if (have >= needed) return;
    const producer = this.#producers(PRODUCES.crew)[0];
    if (!producer) return;
    // [E1] crews leave the aircraft reserve free (not while defending: robots at home need their crews first)
    this.#try({ type: 'queueUnit', producer: producer.eid, kind: 'crew' }, PRIORITY.high, 'crew',
      { popReserve: ai.bb.state !== 'defend' });
  }

  /**
   * [E1] Robots that may be assembled now and still get a crew: spare crews (free, in bay queues, queued, in flight,
   * minus the robots already waiting for one) + crews that fit the population above the aircraft reserve.
   * Robots take no population themselves, so assembling more than that only adds empty robots.
   */
  #crewSlots() {
    if (this.ai.bb.state === 'defend') return Infinity;
    const own = this.ai.perception.own;
    const spare = own.freeCrews.length + own.bayCrews.length + this.#items('crew').length + this.#inflightCount('crew')
      - this.#mechsWaitingForCrew() - this.#items('mech').length;
    const supply = this.#crewSupply();
    const fit = supply > 0 ? Math.floor(Math.max(0, this.#freePopulation()) / supply) : Infinity;
    return Math.max(0, spare) + fit;
  }

  // ---------- robots ----------

  #mechs(now) {
    const bays = this.prod.producersOf(this.team, PRODUCES.mech);
    if (!bays.length) return;
    while (this.plans.length < bays.length + 1) {
      const plan = this.#planFromStock() ?? (this.#antiAirWanted() ? this.#makeAntiAirPlan() : null) ?? this.#makePlan(now);
      if (!plan) break;
      this.plans.push(plan);
    }
    this.#assemble(bays);
    this.#parts();
  }

  /** Stock counts as a Map path -> count (copy) */
  #stockCopy() {
    const stock = this.prod.stock;
    const m = new Map();
    for (const p of stock?.paths(this.team) ?? []) m.set(p, stock.count(this.team, p));
    return m;
  }

  /** Stock keys a plan needs (both arms of one type = the same key twice) */
  static #pathsOf(plan) { return MECH_SLOTS.map((s) => stockKey(plan.loadout[s])).filter(Boolean); }

  #assemble(bays) {
    const stock = this.#stockCopy();
    const serviceBays = this.ai.bb.serviceBays ?? new Set(); // Maintenance sends a robot there (v2)
    // v5: difficulty.production.mechInterval = s at least between two robots (easy: a slower army, not a stuck one)
    const gap = this.ai.diff.production?.mechInterval ?? 0;
    if (gap > 0 && this.ai.now - (this.lastAssembleAt ?? -Infinity) < gap) return;
    let crews = this.#crewSlots(); // [E1] no robot without a crew for it (replaces the v20 hold on aircraft)
    for (const bay of bays) {
      if (this.prod.itemsOf(bay.eid).length || bay.service || bay.assemblyDraft || serviceBays.has(bay.eid)) continue;
      if (this.#inflightCount(`mech:${bay.eid}`)) continue;
      const index = this.plans.findIndex((plan) => {
        const need = ProductionManager.#pathsOf(plan);
        return need.every((p) => (stock.get(p) ?? 0) >= need.filter((o) => o === p).length);
      });
      if (index < 0) return;
      if (crews < 1) { this.crewHeld = (this.crewHeld ?? 0) + 1; return; }
      const plan = this.plans[index];
      if (this.#try({ type: 'queueMech', producer: bay.eid, loadout: { ...plan.loadout } }, PRIORITY.high, `mech:${bay.eid}`)) {
        for (const p of ProductionManager.#pathsOf(plan)) stock.set(p, (stock.get(p) ?? 0) - 1);
        this.plans.splice(index, 1);
        crews--;
        this.ai.note(`assemble ${plan.role} robot`);
        this.#spawnStance(bay, plan);
        this.lastAssembleAt = this.ai.now;
        if (gap > 0) return; // v5: one robot per interval
      }
    }
  }

  /**
   * v3: the bay's spawn stance (setSpawnStance, R4) = the behaviour armies.json wants for the robot's role, so the
   * robot starts with it and Military needs no 'behaviour' command (it only sends one when the robot differs).
   * The stance is copied when the robot is finished, so sending it right after queueMech is in time.
   */
  #spawnStance(bay, plan) {
    if (this.ai.diff.bays?.stance === false) return;
    const mode = this.ai.armies.behaviour?.[plan.role] ?? null; // 'stock' robots: role unknown → Military sets it
    if (!mode || bay.spawnBehaviour === mode) return;
    this.ai.issue({ type: 'setSpawnStance', structure: bay.eid, mode }, { priority: PRIORITY.high, key: `stance:${bay.eid}` });
  }

  #parts() {
    const ai = this.ai;
    const need = new Map(); // stock key -> { count, slot } (slot = part slot of the factory: arms are 'arm')
    for (const plan of this.plans) {
      for (const slot of MECH_SLOTS) {
        const path = stockKey(plan.loadout[slot]);
        if (!path) continue;
        const e = need.get(path) ?? { count: 0, slot: ARM_SLOTS.includes(slot) ? ARMS.slot : slot };
        e.count++;
        need.set(path, e);
      }
    }
    const queued = this.#items('part');
    const stock = this.prod.stock;
    for (const [path, { count, slot }] of need) {
      const have = (stock?.count(this.team, path) ?? 0) + queued.filter((i) => i.path === path).length + this.#inflightCount(path);
      if (have >= count) continue;
      const factory = this.#producers(PRODUCES.part, ai.diff.partFactoriesUsed ?? Infinity)[0];
      if (!factory) return;
      if (!this.#try({ type: 'queuePart', producer: factory.eid, slot, path }, PRIORITY.normal, path)) return;
    }
  }

  // ---------- loadouts ----------

  #stat(path, slot) {
    const key = `${slot}|${path}`;
    if (!this.statCache.has(key)) this.statCache.set(key, partStats(path, slot, this.ai.race, this.team));
    return this.statCache.get(key);
  }

  /** Parts in stock that no plan needs: an extra robot from them (legs + torso, arms if any) */
  #planFromStock() {
    const spare = this.#stockCopy();
    for (const plan of this.plans) for (const p of ProductionManager.#pathsOf(plan)) spare.set(p, (spare.get(p) ?? 0) - 1);
    // Best spare part of a slot (arms: from the shared stock, each pick uses one piece); returns the stock key
    const pick = (slot, score) => {
      const best = (this.prod.catalog?.[catalogSlot(slot)] ?? [])
        .filter((e) => (spare.get(e.path) ?? 0) > 0)
        .map((e) => ({ path: e.path, s: score(this.#stat(e.path, catalogSlot(slot))) }))
        .sort((a, b) => b.s - a.s)[0]?.path ?? null;
      if (best) spare.set(best, spare.get(best) - 1);
      return best;
    };
    const legs = pick('legs', (st) => st.hp);
    const torso = pick('torso', (st) => st.hp);
    if (!legs || !torso) return null;
    const armScore = (st) => groundWeapons(st).reduce((s, w) => s + weaponDps(w), 0);
    const first = pick(ARMS.slot, armScore);
    const second = pick(ARMS.slot, armScore);
    if (!first && !second) return null; // an unarmed robot is not worth a crew
    const [leftKey, rightKey] = [first, second];
    return { role: 'stock', loadout: {
      legs, torso,
      leftArm: leftKey ? armModel(leftKey, 'leftArm') : null,
      rightArm: rightKey ? armModel(rightKey, 'rightArm') : null,
    } };
  }

  /**
   * Reaction to the seen enemy army (armies.json counters, difficulty.counter 0..1):
   *   roles(weights) – phase role weights × boost^counter of every rule whose enemy role share is above its limit
   *   armor(weapon)  – factor 0..1 of a weapon's damage left after the seen enemy armour, ^(armorWeight × counter)
   */
  #counter() {
    const ai = this.ai;
    const k = ai.diff.counter ?? 0;
    const cfg = ai.armies.counters;
    const seen = ai.perception.enemyComposition();
    const none = { roles: (w) => w, armor: () => 1, active: false };
    if (!(k > 0) || !cfg || !seen || seen.count < (cfg.minSeen ?? 1)) return none;
    const roles = (weights) => {
      const out = { ...weights };
      for (const rule of cfg.rules ?? []) {
        if ((seen.shares[rule.enemyRole] ?? 0) <= (rule.above ?? 0)) continue;
        for (const [role, boost] of Object.entries(rule.boost ?? {})) {
          if (out[role] === undefined) continue; // the phase does not want that role at all
          out[role] *= boost ** k;
        }
      }
      return out;
    };
    const exp = (cfg.armorWeight ?? 1) * k;
    const armor = (w) => {
      const raw = Object.values(w.damage ?? {}).reduce((s, v) => s + (v ?? 0), 0);
      if (raw <= 0 || exp <= 0) return 1;
      return (applyArmor(w.damage, seen.armor).total / raw) ** exp;
    };
    if (!this.counterNoted || ai.now - this.counterNoted > AI.compositionSeconds) {
      this.counterNoted = ai.now;
      const shares = Object.entries(seen.shares).map(([r, s]) => `${r} ${Math.round(s * 100)}%`).join(', ');
      ai.note(`counters on: enemy ${shares}`);
    }
    this.lastCounter = seen;
    return { roles, armor, active: true };
  }

  // ---------- anti-air robots (R3) ----------

  /** Does a loadout carry a weapon that hits aircraft? */
  #loadoutHitsAir(loadout) {
    return MECH_SLOTS.some((slot) => loadout?.[slot] && airDps(this.#stat(loadout[slot], slot)) > 0);
  }

  /**
   * More robots with an anti-air weapon wanted? difficulty.air.antiAir: mechsPerAircraft × enemy aircraft seen
   * (Perception.enemyAir), at most maxMechs; counted: own robots (also uncrewed), robots in assembly, plans.
   * Not while the energy is short.
   */
  #antiAirWanted() {
    const ai = this.ai;
    const cfg = ai.diff.air?.antiAir;
    const enemy = ai.perception.enemyAir();
    if (!cfg || !(cfg.mechsPerAircraft > 0) || enemy <= 0 || this.energyShort()) return false;
    const want = Math.min(cfg.maxMechs ?? Infinity, Math.ceil(enemy * cfg.mechsPerAircraft));
    let have = 0;
    for (const m of ai.perception.own.mechs) if (weaponDefsOf(m).some(hitsAir)) have++;
    for (const i of this.#items('mech')) if (this.#loadoutHitsAir(i.loadout)) have++;
    for (const plan of this.plans) if (this.#loadoutHitsAir(plan.loadout)) have++;
    return have < want;
  }

  /** Loadout with the best anti-air damage the team may make now (arms / torso with "air" targets), or null */
  #makeAntiAirPlan() {
    const w = this.ai.armies.score;
    const cost = (st) => Math.max(1, (st.cost?.ore ?? 0) + w.energyWeight * (st.cost?.energy ?? 0));
    const opts = Object.fromEntries(PART_SLOTS.map((slot) => [slot, this.prod.partOptions(this.team, slot)]));
    let arm = null;
    for (const a of opts[ARMS.slot]) {
      const st = this.#stat(a.path, ARMS.canonicalSlot);
      const value = (2 * airDps(st) + dpsOf(st)) / cost(st);
      if (airDps(st) > 0 && (!arm || value > arm.value)) arm = { path: a.path, value, air: airDps(st) };
    }
    let torso = null;
    for (const t of opts.torso) {
      const st = this.#stat(t.path, 'torso');
      const value = (st.hp + 10 * (2 * airDps(st) + dpsOf(st))) / cost(st);
      if (!torso || value > torso.value) torso = { path: t.path, value, air: airDps(st), ground: dpsOf(st) };
    }
    let legs = null;
    for (const l of opts.legs) {
      const st = this.#stat(l.path, 'legs');
      const value = st.hp / cost(st);
      if (!legs || value > legs.value) legs = { path: l.path, value };
    }
    if (!torso || !legs || ((arm?.air ?? 0) + torso.air) <= 0) return null;
    // no anti-air arm: the best ground arm keeps the robot useful against ground units (an armless one is no robot)
    if (!arm) {
      for (const a of opts[ARMS.slot]) {
        const st = this.#stat(a.path, ARMS.canonicalSlot);
        const value = dpsOf(st) / cost(st);
        if (value > 0 && (!arm || value > arm.value)) arm = { path: a.path, value, air: 0 };
      }
    }
    this.ai.note('anti-air robot planned');
    return { role: ANTI_AIR_ROLE, loadout: {
      legs: legs.path, torso: torso.path,
      leftArm: arm ? armModel(arm.path, 'leftArm') : null,
      rightArm: arm ? armModel(arm.path, 'rightArm') : null,
    } };
  }

  /** Scores loadouts the team may make now and picks one for a role of the current phase */
  #makePlan(now) {
    const ai = this.ai;
    const armies = ai.armies;
    const phase = armies.phases.find((p) => p.until === null || p.until === undefined || now < p.until) ?? armies.phases.at(-1);
    const w = armies.score;
    const counter = this.#counter();
    let role = weightedPick(counter.roles(phase.roles)) ?? armies.fallbackRole;
    const opts = Object.fromEntries(PART_SLOTS.map((slot) => [slot, this.prod.partOptions(this.team, slot)]));
    // Universal arms: one type goes on both sides (the model of each side is derived from the stock key)
    const arms = [];
    for (const arm of opts[ARMS.slot]) {
      const st = this.#stat(arm.path, ARMS.canonicalSlot);
      const weapons = groundWeapons(st);
      if (!weapons.length) continue;
      const rs = this.#stat(armModel(arm.path, 'rightArm'), 'rightArm');
      arms.push({
        left: armModel(arm.path, 'leftArm'), right: armModel(arm.path, 'rightArm'), classes: weapons.map((x) => x.class),
        // v2: damage after the seen enemy armour counts (counter.armor = 1 without counters)
        dps: weapons.reduce((s, x) => s + weaponDps(x) * counter.armor(x), 0) * 2, range: Math.max(...weapons.map((x) => x.range ?? 0)),
        parts: [st, rs],
      });
    }
    const fits = (a, r) => a.classes.some((c) => (armies.roleClasses[r] ?? []).includes(c));
    let fitting = arms.filter((a) => fits(a, role));
    if (!fitting.length) { role = armies.fallbackRole; fitting = arms.filter((a) => fits(a, role)); }
    if (!fitting.length) fitting = arms;
    const partCost = (st) => (st.cost?.ore ?? 0) + w.energyWeight * (st.cost?.energy ?? 0);
    fitting = fitting.sort((a, b) => b.dps / Math.max(1, partCost(a.parts[0]) * 2) - a.dps / Math.max(1, partCost(b.parts[0]) * 2)).slice(0, TOP_ARMS);
    const torsos = opts.torso.map((e) => ({ path: e.path, st: this.#stat(e.path, 'torso') }))
      .sort((a, b) => (b.st.hp + 10 * dpsOf(b.st)) / Math.max(1, partCost(b.st)) - (a.st.hp + 10 * dpsOf(a.st)) / Math.max(1, partCost(a.st)))
      .slice(0, TOP_TORSOS);
    const legs = opts.legs.map((e) => ({ path: e.path, st: this.#stat(e.path, 'legs') }));
    const combos = [];
    const armless = fitting.length ? fitting : [null];
    for (const a of armless) {
      for (const t of torsos) {
        for (const l of legs) {
          const parts = [l.st, t.st, ...(a ? a.parts : [])];
          const ore = parts.reduce((s, p) => s + (p.cost?.ore ?? 0), 0);
          const energy = parts.reduce((s, p) => s + (p.cost?.energy ?? 0), 0);
          const hp = parts.reduce((s, p) => s + (p.hp ?? 0), 0);
          const armor = parts.reduce((s, p) => s + (p.armor?.physical ?? 0) * (p.hp ?? 0), 0) / Math.max(1, hp);
          const dps = (a?.dps ?? 0) + dpsOf(t.st) + dpsOf(l.st);
          if (dps <= 0) continue;
          const range = Math.max(a?.range ?? 0, ...groundWeapons(t.st).map((x) => x.range ?? 0));
          const carried = (t.st.mass ?? 0) + (a ? a.parts.reduce((s, p) => s + (p.mass ?? 0), 0) : 0);
          let value = Math.sqrt(hp * (1 + w.armor * armor / 100) * dps * (1 + w.rangeBonus * range))
            / Math.max(1, ore + w.energyWeight * energy) ** w.costExponent;
          if (carried > (l.st.loadCapacity ?? Infinity)) value *= w.overloadPenalty;
          combos.push({ value, ore, energy, loadout: { legs: l.path, torso: t.path, leftArm: a?.left ?? null, rightArm: a?.right ?? null } });
        }
      }
    }
    if (!combos.length) return null;
    let pool = combos.filter((c) => c.ore <= phase.maxMechOre && c.energy <= phase.maxMechEnergy);
    if (!pool.length) pool = [combos.sort((a, b) => a.ore + a.energy - b.ore - b.energy)[0]];
    pool.sort((a, b) => b.value - a.value);
    // Quality 1 = always the best; lower = a random one of the best (1 - quality) share
    const top = Math.max(1, Math.round(pool.length * (1 - (ai.diff.loadoutQuality ?? 1))));
    const chosen = pool[Math.floor(Math.random() * top)];
    return { role, loadout: chosen.loadout };
  }
}

function dpsOf(st) { return groundWeapons(st).reduce((s, w) => s + weaponDps(w), 0); }
