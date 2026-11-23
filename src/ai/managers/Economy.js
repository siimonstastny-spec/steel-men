// Steel Mans AI – economy: DrillTrucks on deposits, how many trucks / builders / power plants / supply buildings
// the team wants. It writes wishes to the blackboard (bb.minVehicles, bb.wantStructures); Production and
// Construction carry them out. Harvest orders are given here.
import { AI } from '../../config.js';
import { unitStats } from '../../data/Stats.js';
import { PRIORITY, dist, isIdle, posOf, nearest, affordsAbove } from '../util.js';
import { fullPopulation, resolveStructure, resolveVehicle, vehicleMatches, structureMatches } from '../AiData.js';
import { checkRules } from '../../game/commands/buildCommands.js';
import { plannedPower, powerGap } from '../power.js';

export class EconomyManager {
  constructor(ai) {
    this.ai = ai;
    this.holdSeconds = 0;   // v4: sim seconds spent in the economy hold (status().econHold)
    this.lastThink = null;
  }

  think(now) {
    const dt = this.lastThink === null ? 0 : now - this.lastThink;
    this.lastThink = now;
    this.#assignHarvesters(now);
    this.#wishes(now, dt);
    if (this.ai.bb.econ?.hold) this.holdSeconds += dt;
  }

  /**
   * D3: power plants by the energy plan (src/ai/power.js, difficulty.power):
   *   - target = owned plants + enough for (demand of owned consumers + bb.powerRequest) × coverage
   *     (Construction posts a request before a consumer / tower it could not cover);
   *   - one more while the measured demand (energyFlow drain ÷ workRate, averaged) stays above reactShare × the
   *     measured income with the store below stockShare, or low energy lasted lowReactSeconds (none while one builds);
   *   - priority high while short, urgent after a long low-energy streak;
   *   - energy banks (@storage, `banks`) once `bankAfterPlants` plants stand and the store is near the cap.
   * Counters for status(): lowSeconds (total s in low energy), lowStreak, avgIncome / avgDemand.
   */
  #power(wants, now, dt) {
    const ai = this.ai;
    const cfg = ai.diff.power ?? {};
    const eco = ai.world.economy;
    const team = ai.team;
    const flow = eco.energyFlow(team);
    const rate = eco.workRate(team);
    this.plan ??= {};
    const plan = plannedPower(ai, this.plan);
    // production drain is scaled by the work rate while low, towers always draw their full use
    const tower = Math.min(plan.towerUse, flow.drain);
    const demandNow = tower + (rate > 0 ? (flow.drain - tower) / rate : flow.drain - tower);
    const k = Math.min(1, dt / (cfg.averageSeconds ?? 1));
    this.avgDemand = this.avgDemand === undefined ? demandNow : this.avgDemand + (demandNow - this.avgDemand) * k;
    this.avgIncome = this.avgIncome === undefined ? flow.income : this.avgIncome + (flow.income - this.avgIncome) * k;
    const low = eco.isLowEnergy(team);
    // the streak grows only while something draws (low energy with idle consumers costs nothing)
    this.lowStreak = low ? (this.lowStreak ?? 0) + (flow.drain > 0 ? dt : 0) : 0;
    if (low) this.lowSeconds = (this.lowSeconds ?? 0) + dt;

    if (!plan.plantId || plan.plantIncome <= 0 || eco.infiniteResources) return;
    const request = (ai.bb.powerRequest?.until ?? -Infinity) > now ? ai.bb.powerRequest.use : 0;
    const gap = powerGap(plan, request, cfg.coverage ?? 1, this.avgDemand);
    let count = plan.plants + Math.max(0, Math.ceil(gap / plan.plantIncome));
    const cap = eco.energyShareBase(team); // [W5b] finite also with an unlimited energy cap
    const unlimited = !Number.isFinite(eco.energyCapOf(team));
    const stock = eco.amount(team, 'energy');
    const measuredShort = this.avgDemand > this.avgIncome * (cfg.reactShare ?? 1) && stock < cap * (cfg.stockShare ?? 0);
    const longLow = this.lowStreak >= (cfg.lowReactSeconds ?? Infinity);
    if ((measuredShort || longLow) && plan.plantsBuilding === 0) count = Math.max(count, plan.plants + 1);
    count = Math.min(count, cfg.maxPlants ?? Infinity);
    const priority = longLow ? PRIORITY.urgent : (gap > 0 || low) ? PRIORITY.high : PRIORITY.normal;
    wants.push({ value: '@power', count: Math.max(count, plan.plants), priority });
    this.powerShort = gap > 0 || measuredShort || longLow;

    // Energy banks: buffer for production bursts once the plants keep the store full ([W5b] useless without a cap)
    const banks = unlimited ? 0 : cfg.banks ?? 0;
    if (banks > 0 && plan.plants >= (cfg.bankAfterPlants ?? Infinity) && stock >= cap * (cfg.bankWhenFull ?? 1)
      && resolveStructure('@storage', ai.race, ai.teamUnlocks)) {
      const have = ai.construction?.ownedCount('@storage') ?? 0;
      if (have < banks) wants.push({ value: '@storage', count: have + 1, priority: PRIORITY.normal });
    }
  }

  /** status(): "income/demand" per second (measured, averaged) */
  powerText() {
    if (this.avgIncome === undefined) return '-';
    return `${this.avgIncome.toFixed(1)}/${this.avgDemand.toFixed(1)}`;
  }

  /** Deposits the team may mine now, nearest first: { deposit, free, superNode } */
  #deposits() {
    const ai = this.ai;
    const p = ai.perception;
    const anchor = p.own.anchor;
    const enemyBuildings = p.knownStructures();
    const enemyArmy = p.known().filter((m) => !m.isStructure && m.armed);
    const mine = p.own.harvesters;
    const out = [];
    const allies = p.own.allyStructures;
    for (const d of ai.world.economy.deposits ?? []) {
      if (d.depleted || d.eid == null) continue;
      if (enemyBuildings.some((m) => dist(m, d) < AI.baseRadius)) continue; // someone else's base deposit
      if (!d.superNode && allies.length) { // v3: an ally's base deposit (closer to an allied building than to our base)
        const ally = nearest(allies, d);
        const da = dist(posOf(ally), d);
        if (da < AI.baseRadius && da < dist(anchor, d)) continue;
      }
      if (d.superNode) {
        if (!ai.diff.useSuperNode) continue;
        if (enemyArmy.some((m) => dist(m, d) < AI.superNodeSafeRadius)) continue;
      }
      const assigned = mine.filter((v) => this.#target(v) === d).length;
      let free = Math.max(0, (Number.isFinite(d.maxHarvesters) ? d.maxHarvesters : Infinity) - assigned);
      if (d.superNode) free = Math.min(free, Math.max(0, ai.diff.superNodeHarvesters - assigned));
      out.push({ deposit: d, free, assigned, superNode: d.superNode, d: dist(anchor, d) });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** Deposit a truck mines or drives to (current or queued harvest order) */
  #target(v) {
    if (v.order?.type === 'harvest') return v.order.deposit;
    return v.orderQueue?.find((e) => e.type === 'harvest')?.ref?.deposit ?? null;
  }

  #assignHarvesters() {
    const ai = this.ai;
    const deposits = this.#deposits();
    for (const v of ai.perception.own.harvesters) {
      const current = this.#target(v);
      if (current && !current.depleted) continue;
      if (!isIdle(v) && !current) continue; // driving somewhere on another order
      const slot = deposits.find((e) => e.free > 0);
      if (!slot) return;
      slot.free--;
      ai.issue({ type: 'harvest', units: [v.eid], deposit: slot.deposit.eid, queued: false },
        { priority: PRIORITY.high, key: `harvest:${v.eid}` });
    }
  }

  #wishes(now, dt) {
    const ai = this.ai;
    const bb = ai.bb;
    const diff = ai.diff;
    const p = ai.perception;
    const eco = ai.world.economy;
    const team = ai.team;
    const unlocks = ai.teamUnlocks;
    const wants = [];

    // Trucks: as many as the reachable deposit slots allow, up to the difficulty's numbers
    // v2: the base number of trucks is wanted from the start (not only after the build order) – a lost truck is
    // replaced as soon as a vehicle factory stands; super node trucks come once the opening is done
    const slots = this.#deposits().reduce((s, e) => s + e.free + e.assigned, 0);
    const base = diff.harvesters + (diff.useSuperNode && bb.openingDone ? diff.superNodeHarvesters : 0);
    const wantHarvesters = Math.min(slots, base);
    if (resolveVehicle('@harvester', ai.race, unlocks)) {
      bb.minVehicles['@harvester'] = Math.max(bb.minVehicles['@harvester'] ?? 0, wantHarvesters);
    }
    // Builders + HoverTrucks for repairs / salvage (difficulty.repair.trucks)
    if (bb.openingDone) bb.minVehicles['@builder'] = Math.max(bb.minVehicles['@builder'] ?? 0, diff.builders + (diff.repair?.trucks ?? 0));
    bb.harvestersWanted = bb.minVehicles['@harvester'] ?? 0;
    this.#econ(wants, wantHarvesters);

    this.#power(wants, now, dt);

    // Population: one supply building at a time while the headroom is small
    // [E1] the population Production keeps for aircraft (bb.airPopReserve) is not headroom
    if (!fullPopulation(ai.race) && resolveStructure('@supply', ai.race, unlocks)) {
      const max = eco.populationMaxOf(team); // [W5b] rules populationMax and the menu's population limit
      const cap = eco.populationCap(team);
      const supply = p.own.structures.filter((s) => (s.stats.supplyProvided ?? 0) > 0 && !s.stats.hq);
      const pending = supply.some((s) => !s.complete);
      const headroom = cap - eco.populationUsed(team) - (bb.airPopReserve ?? 0);
      if (cap < max && headroom < diff.supplyHeadroom && !pending) {
        wants.push({ value: '@supply', count: supply.length + 1, priority: PRIORITY.high });
      }
    }

    // Research facility (research.json plan): after the build order, from buildAt, with spare ore
    // v4: with `beforeOpening` already from buildAt once the economy hold is over (the long hard opening kept it back)
    const rp = ai.researchPlan;
    const opened = bb.openingDone || (rp?.beforeOpening && !bb.econ?.lack);
    if (rp?.enabled && opened && now >= (rp.buildAt ?? 0) && resolveStructure(rp.facility ?? '@research', ai.race, unlocks)) {
      const facilities = p.own.structures.filter((s) => (s.stats.produces ?? []).includes('research'));
      const have = facilities.length;
      this.researchMinOre ??= { ore: rp.minOre ?? 0 };
      const spare = affordsAbove(eco, team, this.researchMinOre);
      // Another facility only while every one is finished and researching (before: the 2nd was built while the
      // 1st stood idle, ore it took was missing for the research itself)
      const busy = facilities.every((s) => s.complete && (ai.world.production?.itemsOf(s.eid).length ?? 0) > 0);
      if (have < (rp.facilities ?? 1) && (have === 0 || (spare && busy))) {
        // v4: the first facility may outrank the build order's power / parts steps (research.json firstPriority)
        const priority = have === 0 ? (PRIORITY[rp.firstPriority] ?? PRIORITY.normal) : PRIORITY.normal;
        wants.push({ value: rp.facility ?? '@research', count: have + 1, priority });
      }
    }
    this.#air(wants, now);
    bb.wantStructures = wants;
  }

  /**
   * R3 (difficulty.air): the aircraft hangar (@aircraft) once the opening is done, from hangarAt, when the game's
   * rules allow it (research tier – the requirement buildings Construction adds itself); anti-air towers
   * (@antiAir) while enemy aircraft are known (Perception.enemyAir). Not in the economy hold. Towers / the hangar
   * are energy consumers: Construction's power gate builds plants first.
   */
  #air(wants, now) {
    const ai = this.ai;
    const cfg = ai.diff.air;
    if (!cfg || !ai.bb.openingDone || ai.bb.econ?.hold) return;
    const unlocks = ai.teamUnlocks;
    const owned = (value) => ai.construction?.ownedCount(value) ?? 0;
    if (cfg.hangarAt !== null && cfg.hangarAt !== undefined && now >= cfg.hangarAt && (cfg.aircraft ?? 0) > 0) {
      const id = resolveStructure('@aircraft', ai.race, unlocks);
      if (id && owned('@aircraft') === 0) {
        const rule = checkRules(ai.world, ai.team, ai.race, id, unitStats('structures', id, ai.race, ai.team));
        // [E1] air.hangarPriority (default normal): high outranks the normal wishes, so Construction reserves its ore
        // (bb.reserved – parts wait, Research only spends above it) instead of losing it to research and parts
        const priority = PRIORITY[cfg.hangarPriority] ?? PRIORITY.normal;
        if (rule === '' || rule === 'requires') wants.push({ value: '@aircraft', count: 1, priority });
      }
    }
    const enemyAir = ai.perception.enemyAir(now);
    const towers = Math.min(cfg.antiAir?.towers ?? 0, enemyAir);
    if (towers > 0 && resolveStructure('@antiAir', ai.race, unlocks)) {
      const have = owned('@antiAir');
      if (have < towers) wants.push({ value: '@antiAir', count: have + 1, priority: PRIORITY.high });
    }
  }

  /**
   * v4: guard against the economy trap (docs/notes/ai-v4.md). With fewer trucks (+ queued) than
   * difficulty.econ.minHarvesters:
   *   - bb.econ.hold: Production assembles no robots, orders no parts / crews / extra vehicles, Maintenance starts no
   *     bay repairs (not while defending) – before, they ate the income of one truck and the factory never fitted;
   *   - the missing link is wanted urgently and marked as an economy build (bb.econ.structures): no vehicle factory →
   *     the factory; population full → a supply building. Construction then reserves its cost also against
   *     high-priority spending (bb.econReserve).
   * A full population is an economy build at any time (nothing else can be produced) – urgent, reserved.
   * bb.econ.block = what keeps the economy back (status().econBlock), null when nothing.
   */
  #econ(wants, wantHarvesters) {
    const ai = this.ai;
    const bb = ai.bb;
    const cfg = ai.diff.econ ?? {};
    const p = ai.perception;
    const eco = ai.world.economy;
    const team = ai.team;
    const unlocks = ai.teamUnlocks;
    const truckId = resolveVehicle('@harvester', ai.race, unlocks);
    const min = truckId ? Math.min(cfg.minHarvesters ?? 0, wantHarvesters) : 0;
    const queued = (ai.world.production?.itemsOfTeam(team) ?? [])
      .filter((i) => i.kind === 'vehicle' && vehicleMatches('@harvester', i.unitId)).length;
    const trucks = p.own.harvesters.length + queued;
    const lack = trucks < min;
    const structures = [];
    let block = null;

    // Population: full (no room for a truck) – a supply building first
    const cap = eco.populationCap(team);
    const used = eco.populationUsed(team);
    const max = eco.populationMaxOf(team); // [W5b] rules populationMax and the menu's population limit
    const truckSupply = truckId ? (unitStats('vehicles', truckId, ai.race, team)?.supply ?? 1) : 1;
    const popFull = !fullPopulation(ai.race) && cap < max && used + truckSupply > cap;
    if (popFull && resolveStructure('@supply', ai.race, unlocks)) {
      const supply = p.own.structures.filter((s) => (s.stats.supplyProvided ?? 0) > 0 && !s.stats.hq);
      if (!supply.some((s) => !s.complete)) wants.push({ value: '@supply', count: supply.length + 1, priority: PRIORITY.urgent });
      structures.push('@supply');
      block = `population ${used}/${cap}`;
    }
    if (lack) {
      const factories = p.own.structures.filter((s) => structureMatches('@vehicles', s.unitId)); // R3: not the hangar
      if (!factories.length && resolveStructure('@vehicles', ai.race, unlocks)) {
        wants.push({ value: '@vehicles', count: 1, priority: PRIORITY.urgent });
        structures.push('@vehicles');
        block ??= 'no vehicle factory';
      } else if (!factories.some((s) => s.complete)) block ??= 'vehicle factory building';
      block ??= `trucks ${trucks}/${min}`;
    }
    // D3: the HQ (matter converter) is lost – without it every income is cut to noHqIncomeFactor. Once the ore for it
    // is there it is wanted urgently, reserved as an economy build, and the hold stops new consumers so the energy
    // for it can gather (a lost HQ under attack: no hold while defending, as for the trucks).
    const hqLost = this.#hqLost(wants, structures);
    // the HQ comes first in the indicator (also while it is rebuilt, or while its ore is missing)
    if (!eco.hasHq(team)) {
      const hqText = p.own.hq ? 'no HQ (rebuilding)' : hqLost ? 'no HQ' : 'no HQ (ore missing)';
      block = block ? `${hqText}, ${block}` : hqText;
    }
    const wait = ai.construction?.waiting;
    if (block && wait?.econ) block += ` (${wait.id}: ${wait.why})`;
    const hold = (lack || hqLost) && cfg.hold !== false && bb.state !== 'defend';
    bb.econ = { hold, lack, structures, block, trucks, min, hqLost };
  }

  /** D3: wants the HQ back when none is owned (not even under construction) and its ore is there. @returns {boolean} */
  #hqLost(wants, structures) {
    const ai = this.ai;
    if (ai.perception.own.hq || (ai.construction?.ownedCount('@hq') ?? 0) > 0) return false;
    const id = resolveStructure('@hq', ai.race, ai.teamUnlocks);
    if (!id) return false;
    const cost = unitStats('structures', id, ai.race, ai.team)?.cost ?? {};
    // "has the ore for it": ore only – the energy (200) gathers during the hold
    this.hqOre ??= { ore: cost.ore ?? 0 };
    if (!affordsAbove(ai.world.economy, ai.team, this.hqOre)) return false;
    wants.push({ value: '@hq', count: 1, priority: PRIORITY.urgent });
    structures.push('@hq');
    return true;
  }
}
