// Steel Mans – economy: resource accounts per team (stats.json → resources, e.g. ore / energy), the energy
// storage cap chosen in the new-game menu, income of finished buildings, population (cap and use) and the
// ore deposits of the map. One instance lives in world.economy (created by main.js when a game starts).
//
//   economy.canAfford(team, cost) / pay(team, cost) / refund(team, cost, factor) / add(team, resource, amount)
//   economy.populationCap(team) / populationUsed(team) / canSupport(team, supply)
//   economy.reserve(team, supply) / release(team, supply) – population held by queued production
//
// [D1] Power (docs/notes/d1-economy-sim.md):
//   • start: energy = rules.economy.startEnergyShare × cap, ore = startResources; both × startMultiplier
//   • consumers (stats.energyUse per second) call drawPower(structure, dt) while they work; towers always
//   • low energy (store < ECONOMY_POWER.lowEnergyShare × cap): consumers work at lowWorkRate, towers are off
//     (towers still draw their full energyUse)
//   • no finished HQ (stats.hq): mined resources and all income × rules.economy.noHqIncomeFactor
//   • startMultiplier 'infinite': nothing is ever taken from the team, energy starts full and is never low
//   Reading (no allocation): isLowEnergy(team), hasHq(team), workRate(team), energyFlow(team) → { income, drain }
//   per second of the last tick, structure.powered (set every tick), startMultiplier.
import { getStats } from '../data/Stats.js';
import { OreDeposit } from './OreDeposit.js';
import { PartStock } from './PartStock.js';
import { ECONOMY, ECONOMY_POWER } from '../config.js';
import { ORE_MULTIPLIER, isInfiniteOre, validOreMultiplier } from './OreMultiplier.js';
import { validStartMultiplier, isInfiniteStart } from './StartMultiplier.js';

const NO_FLOW = Object.freeze({ income: 0, drain: 0 }); // energyFlow of an unknown team

export class Economy {
  #primed = false; // hq state computed at least once (before the first update)
  #capFresh = false; // capBonus is valid (only inside update(): structures do not change there)

  /**
   * @param {import('./World.js').World} world
   * @param {object} opts
   * @param {string[]} opts.races       race key per team (index = team)
   * @param {number} [opts.energyCap]   energy storage cap (ECONOMY.energyCaps)
   * @param {number|string} [opts.oreMultiplier]  [B1] ORE_MULTIPLIER.options: factor of the deposits' starting amount, or 'infinite'
   * @param {boolean} [opts.infiniteDeposits]  legacy: true = same as oreMultiplier 'infinite'
   * @param {number|string} [opts.startMultiplier]  [D1] factor of the starting resources, or 'infinite' (default 1)
   */
  constructor(world, { races, energyCap = ECONOMY.defaultEnergyCap, oreMultiplier, infiniteDeposits = false, startMultiplier = 1 }) {
    this.world = world;
    this.races = [...races];
    this.energyCap = energyCap;
    this.oreMultiplier = infiniteDeposits ? ORE_MULTIPLIER.infinite : validOreMultiplier(oreMultiplier);
    this.infiniteDeposits = isInfiniteOre(this.oreMultiplier);
    this.depositScale = this.infiniteDeposits ? 1 : this.oreMultiplier; // OreDeposit: initial amount × this (1 = unchanged)
    this.startMultiplier = validStartMultiplier(startMultiplier);
    /** [D1] resources never decrease (startMultiplier 'infinite') */
    this.infiniteResources = isInfiniteStart(this.startMultiplier);
    this.resources = getStats().resources ?? ['ore', 'energy'];
    const rules = getStats().rules.economy ?? {};
    const start = rules.startResources ?? {};
    const factor = this.infiniteResources ? 1 : this.startMultiplier;
    const startEnergy = this.infiniteResources ? energyCap : (rules.startEnergyShare ?? 0) * energyCap * factor;
    this.accounts = this.races.map(() => Object.fromEntries(this.resources.map((r) => [r, 0])));
    this.reserved = this.races.map(() => 0);
    // [D1] power state per team (refreshed by update; read without allocation)
    this.low = this.races.map(() => false);
    this.hq = this.races.map(() => false);
    this.flow = this.races.map(() => ({ income: 0, drain: 0 }));
    this.incomeAcc = this.races.map(() => 0);
    this.drainAcc = this.races.map(() => 0);
    this.capBonus = this.races.map(() => 0); // energy storage of finished buildings (#refreshCap, inside update)
    this.races.forEach((_, team) => {
      for (const r of this.resources) this.add(team, r, r === 'energy' ? startEnergy : (start[r] ?? 0) * factor, 'start');
    });
    this.deposits = [];
    this.depositMeshes = [];
    this.parts = new PartStock(this.races.length); // finished robot parts (part factory → assembly bay)
  }

  // ---------- power (D1) ----------

  /** Stored energy is below the low share of the cap (stays low until the recover share – ECONOMY_POWER) */
  isLowEnergy(team) { return this.low[team] ?? false; }

  /** The team has a finished, not destroyed main building (stats.hq) */
  hasHq(team) {
    if (!this.#primed) this.#refreshHq();
    return this.hq[team] ?? false;
  }

  /** Work rate of the team's consumers: 1, or ECONOMY_POWER.lowWorkRate with low energy */
  workRate(team) { return this.isLowEnergy(team) ? ECONOMY_POWER.lowWorkRate : 1; }

  /** Shared { income, drain } of the team's energy per second during the last tick (read it at once) */
  energyFlow(team) { return this.flow[team] ?? NO_FLOW; }

  /**
   * A working consumer takes its energy for this tick: stats.energyUse × work rate × dt (never below 0 energy).
   * fullUse = always the whole energyUse (towers: they draw fully even when switched off by low energy).
   * @returns {number} work rate to scale its progress by (1 or ECONOMY_POWER.lowWorkRate)
   */
  drawPower(structure, dt, fullUse = false) {
    const team = structure.team;
    const rate = this.workRate(team);
    const use = structure.stats?.energyUse ?? 0;
    if (use > 0 && this.accounts[team]) {
      const want = use * (fullUse ? 1 : rate) * dt;
      this.drainAcc[team] += want;
      this.add(team, 'energy', -want, 'spend'); // add clamps at 0; ignored with infinite resources
    }
    return rate;
  }

  #refreshHq() {
    this.#primed = true;
    this.hq.fill(false);
    for (const b of this.world.structures) {
      if (b.complete && !b.destroyed && b.stats?.hq && b.team in this.hq) this.hq[b.team] = true;
    }
  }

  /** Energy storage of every team's finished buildings, one pass (valid while #capFresh) */
  #refreshCap() {
    this.capBonus.fill(0);
    for (const b of this.world.structures) {
      if (b.complete && !b.destroyed && b.team in this.capBonus) this.capBonus[b.team] += b.stats?.storage?.energy ?? 0;
    }
    this.#capFresh = true;
  }

  #refreshLow() {
    for (let team = 0; team < this.low.length; team++) {
      if (this.infiniteResources) { this.low[team] = false; continue; }
      const cap = this.capOf('energy', team);
      const share = this.low[team] ? ECONOMY_POWER.recoverShare : ECONOMY_POWER.lowEnergyShare;
      this.low[team] = this.amount(team, 'energy') < cap * share;
    }
  }

  /**
   * Storage cap of a resource for a team (Infinity = no cap). Energy: the cap chosen in the new-game menu plus
   * stats.storage of the team's finished buildings (EnergyBank).
   */
  capOf(resource, team = null) {
    if (resource !== 'energy') return Infinity;
    let cap = this.energyCap;
    if (team === null) return cap;
    // Inside update() the bonus is computed once (#refreshCap); elsewhere structures may change at any moment
    if (this.#capFresh) return cap + (this.capBonus[team] ?? 0);
    for (const b of this.world.structures) {
      if (b.team === team && b.complete && !b.destroyed) cap += b.stats.storage?.[resource] ?? 0;
    }
    return cap;
  }

  /** Energy cap of a team (HUD) */
  energyCapOf(team) { return this.capOf('energy', team); }

  amount(team, resource) { return this.accounts[team]?.[resource] ?? 0; }

  /**
   * Adds (or with a negative amount removes) a resource; energy is clamped to the cap. Returns the change applied.
   * `kind` tells the statistics where it came from: 'mined' (trucks, the default for outside callers), 'income',
   * 'spend', 'refund', 'start'. onFlow(team, resource, change, kind) is the statistics hook (MatchStats).
   */
  add(team, resource, amount, kind = 'mined') {
    const acc = this.accounts[team];
    if (!acc) return 0;
    if (amount < 0 && this.infiniteResources) return 0; // [D1] nothing is ever taken
    // [D1] without a finished HQ the matter converter is missing: mined resources and income are mostly lost
    if (amount > 0 && (kind === 'mined' || kind === 'income') && !this.hasHq(team)) {
      amount *= getStats().rules.economy?.noHqIncomeFactor ?? 1;
    }
    if (resource === 'energy' && kind === 'income' && amount > 0) this.incomeAcc[team] += amount;
    const before = acc[resource] ?? 0;
    // A removal never reaches the cap: skip the cap lookup (same result as clamping)
    acc[resource] = amount <= 0 ? Math.max(0, before + amount)
      : Math.min(Math.max(before, this.capOf(resource, team)), before + amount);
    const change = acc[resource] - before;
    if (change !== 0) this.onFlow?.(team, resource, change, kind);
    return change;
  }

  canAfford(team, cost = {}) {
    if (this.infiniteResources && this.accounts[team]) return true;
    return Object.entries(cost).every(([r, v]) => this.amount(team, r) >= (v ?? 0));
  }

  /** Takes the whole cost, or nothing when the team cannot afford it. @returns {boolean} */
  pay(team, cost = {}) {
    if (!this.canAfford(team, cost)) return false;
    for (const [r, v] of Object.entries(cost)) this.add(team, r, -(v ?? 0), 'spend');
    return true;
  }

  /** Gives back factor × cost (cancelled construction / production) */
  refund(team, cost = {}, factor = 1) {
    if (this.infiniteResources) return; // [D1] nothing was paid
    for (const [r, v] of Object.entries(cost)) this.add(team, r, Math.floor((v ?? 0) * factor), 'refund');
  }

  /** Resources missing for a cost: { ore: 40 } (empty when affordable) */
  missing(team, cost = {}) {
    return Object.fromEntries(Object.entries(cost)
      .map(([r, v]) => [r, Math.ceil((v ?? 0) - this.amount(team, r))])
      .filter(([, v]) => v > 0));
  }

  // ---------- population ----------

  /**
   * Population cap: rules.economy.populationMax for a race with population.fullFromStart (data),
   * otherwise the sum of supplyProvided of the team's finished buildings, capped at populationMax.
   */
  populationCap(team) {
    const s = getStats();
    const max = s.rules.economy?.populationMax ?? Infinity;
    if (s.races?.[this.races[team]]?.population?.fullFromStart) return max;
    const provided = this.world.structures
      .filter((b) => b.team === team && b.complete && !b.destroyed)
      .reduce((sum, b) => sum + (b.stats.supplyProvided ?? 0), 0);
    return Math.min(max, provided);
  }

  /**
   * Population in use: crews, vehicles and mechs (stats supply) + what queued production holds + finished units
   * waiting for their spawn tick (World.pendingSupply, held from completion until the unit enters the world)
   */
  populationUsed(team) {
    const w = this.world;
    const supplyOf = (u) => u.supply ?? u.stats?.supply ?? 0;
    const units = [
      ...w.crews.filter((c) => !c.dead),
      ...w.vehicles.filter((v) => !v.destroyed),
      ...w.mechs.filter((m) => !m.destroyed),
    ].filter((u) => u.team === team);
    return units.reduce((sum, u) => sum + supplyOf(u), 0) + (this.reserved[team] ?? 0) + (w.pendingSupply?.(team) ?? 0);
  }

  canSupport(team, supply = 0) {
    return supply <= 0 || this.populationUsed(team) + supply <= this.populationCap(team);
  }

  reserve(team, supply = 0) { this.reserved[team] = (this.reserved[team] ?? 0) + supply; }
  release(team, supply = 0) { this.reserved[team] = Math.max(0, (this.reserved[team] ?? 0) - supply); }

  // ---------- deposits ----------

  /** Creates the ore deposits of a map (GameMap.oreDeposits) and registers them for pathfinding */
  setupDeposits(map) {
    for (const d of this.deposits) d.dispose();
    this.deposits = map.oreDeposits.map((def) => new OreDeposit(def, this.world, this));
    for (const d of this.deposits) this.world.register?.(d); // commands target deposits by eid
    if (map.superNode && map.group) {
      const node = this.deposits.find((d) => d.superNode);
      // The super node's own crystals are the deposit's visual: clicking them targets it
      map.group.getObjectByName('superNode')?.traverse((o) => { if (o.isMesh) o.userData.deposit = node; });
    }
    // Meshes a right click can hit to send DrillTrucks to a deposit (CommandInput)
    this.depositMeshes = [];
    const roots = [...this.deposits.map((d) => d.group), map.group?.getObjectByName('superNode')].filter(Boolean);
    for (const root of roots) root.traverse((o) => { if (o.isMesh && o.userData.deposit) this.depositMeshes.push(o); });
    return this.deposits;
  }

  /** Deposit whose crystals were clicked (walks up the parents) */
  depositOf(object) {
    for (let o = object; o; o = o.parent) if (o.userData.deposit) return o.userData.deposit;
    return null;
  }

  // ---------- per frame ----------

  /**
   * Income of finished buildings (stats.income per second, e.g. solar panels → energy), then the power state:
   * HQ, low energy, structure.powered, energy flow of the tick. Runs after the structures (towers, bay service
   * drew their power) and before Production (which reads the state set here).
   */
  update(dt) {
    this.#refreshHq();
    this.#refreshCap();
    for (const b of this.world.structures) {
      const income = b.stats?.income;
      if (!b.complete || b.destroyed || !income) continue;
      for (const r in income) this.add(b.team, r, income[r] * dt, 'income');
    }
    this.#refreshLow();
    for (const b of this.world.structures) {
      b.powered = !((b.stats?.energyUse ?? 0) > 0 && this.isLowEnergy(b.team));
    }
    for (let team = 0; team < this.flow.length; team++) {
      const f = this.flow[team];
      f.income = dt > 0 ? this.incomeAcc[team] / dt : 0;
      f.drain = dt > 0 ? this.drainAcc[team] / dt : 0;
      this.incomeAcc[team] = 0;
      this.drainAcc[team] = 0;
    }
    this.#capFresh = false;
    for (const d of this.deposits) d.update(dt);
  }
}
