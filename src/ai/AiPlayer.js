// Steel Men AI – one computer-controlled team (docs/AI.md, docs/notes/ai-core.md).
//
//   const ai = new AiPlayer({ world, commandBus, team, race, difficulty: 'easy'|'normal'|'hard', unlocks, allies })
//   ai.update(simTimeSeconds)   – call after each simulation tick (or less often); it thinks on its own intervals
//
// The AI runs OUTSIDE the simulation: it reads what its team may know (Perception) and acts only through
// commandBus.submit({ ...cmd, team }) – the same commands as the UI. Its randomness comes from its own seeded
// generator `ai.rng` (D1: reproducible AI-vs-AI; never world.rng); in multiplayer only the host runs it and its commands travel like a remote player's.
// Managers (src/ai/managers/*) share a blackboard (`ai.bb`) and send commands through a rate limiter (`ai.issue`)
// that enforces the difficulty's actions per minute.
import { AI } from '../config.js';
import { Rng } from '../core/Rng.js';
import { Perception } from './Perception.js';
import { PRIORITY, weaponDefsOf } from './util.js';
import { loadAiData, difficultyOf, buildOrderOf, armiesOf, defensePlanOf, researchPlanOf, hitsAir } from './AiData.js';
import { StrategyManager } from './managers/Strategy.js';
import { EconomyManager } from './managers/Economy.js';
import { ConstructionManager } from './managers/Construction.js';
import { ProductionManager } from './managers/Production.js';
import { MilitaryManager } from './managers/Military.js';
import { ScoutManager } from './managers/Scout.js';
import { ResearchManager } from './managers/Research.js';
import { MaintenanceManager } from './managers/Maintenance.js';
import { Budget } from './Budget.js';
import { clearIntent } from './allyBoard.js';

/** Queued commands older than this (s) are dropped – the situation has changed */
const COMMAND_STALE_SECONDS = 5;
/** Spreads the per-team AI generator seeds (odd golden-ratio constant, same idea as seed + team * step elsewhere) */
const RNG_TEAM_STEP = 0x9e3779b1;
export { PRIORITY };

export class AiPlayer {
  /**
   * @param {object} opts
   * @param {import('../game/World.js').World} opts.world
   * @param {object} opts.commandBus   the shared bus (src/game/commands/CommandBus.js)
   * @param {number} opts.team
   * @param {string} opts.race         stats.json race key of the team
   * @param {string} [opts.difficulty] 'easy' | 'normal' | 'hard'
   * @param {object} [opts.unlocks]    the team's unlock record (game.unlocks[team]); world.production's is used if missing
   * @param {number[]} [opts.allies]   extra teams never attacked (match allies from src/game/Alliances.js are never attacked anyway)
   */
  constructor({ world, commandBus, team, race, difficulty = 'normal', unlocks = null, allies = [] }) {
    Object.assign(this, { world, commandBus, team, race, unlocks, allies: [...allies] });
    this.difficultyId = difficulty;
    // D1: own seeded generator (never world.rng – AI choices must not move the simulation stream). The AI is created
    // right after world.startSimulation(seed), so the world generator still holds the match seed at this point.
    this.rng = new Rng((world.rng.state ^ Math.imul(team + 1, RNG_TEAM_STEP)) >>> 0);
    this.diff = null;      // difficulty settings once the data is loaded
    this.data = null;
    this.enabled = true;
    this.now = 0;          // sim time of the last update
    this.lastTime = null;
    this.queue = [];       // rate limiter: { cmd, priority, key, time }
    this.tokens = AI.apmBurst;
    this.stats = { commands: 0, dropped: 0, wavesSent: 0, wavesRecalled: 0, firstAttackAt: null, startedAt: null };
    this.log = [];         // recent decisions (console debugging): { time, text }
    /** Blackboard shared by the managers */
    this.bb = {
      state: 'build',            // Strategy: 'build' | 'attack' | 'defend'
      openingDone: false,        // Construction finished the build order
      minVehicles: {},           // role -> wanted count (Economy, build order)
      wantStructures: [],        // [{ value, count, priority }] reactive builds (Economy)
      reserved: {},              // resources Production must not spend: buildReserve + researchReserve
      buildReserve: {},          // what Construction keeps for its next building
      researchReserve: {},       // what Research saves for its next research (research.json reserveAfter)
      starved: {},               // resource -> sim time it was last missing
      rally: null,               // army gathering point
      wave: null,                // Military's attack wave (read by Strategy)
      scoutEid: null,            // unit used by Scout (Military leaves it alone)
      // v2
      maintaining: new Set(),    // robot eids Maintenance handles (bay, arm pick-up, truck repair) – Military leaves them
      serviceBays: new Set(),    // bay eids a robot drives to (Production queues no assembly there)
      truckJobs: new Set(),      // HoverTruck eids repairing (Research does not send them salvaging)
      homeDefense: false,        // Strategy: home squad fights a threat while the wave goes on
      harvestersWanted: 0,       // Economy: DrillTrucks wanted now (status)
      // v3
      allyHelp: null,            // Strategy: {x, z} of an attacked ally base the home units go to (state 'build' only)
      // v4
      econ: null,                // Economy #econ: { hold, lack, structures, block, trucks, min } (economy trap guard)
      econReserve: {},           // Construction: cost of an economy build – also high-priority spending keeps it
      // v5
      recon: null,               // Strategy → Scout: { since, done, doneAt, eid } look at the enemy before a wave
      // D3
      powerRequest: null,        // Construction → Economy: { use, until } energy/s of a consumer waiting for plants
      // E1
      airPopReserve: 0,          // Production → Economy: population kept free for the next aircraft (supply headroom)
      unreachableMechs: new Map(), // Military → Production: empty robots no crew could reach (eid -> until)
    };
    clearIntent(team);           // v3: a stale allyBoard entry of an earlier match
    this.budget = null;          // v3: Budget (research.json budget) once the data is loaded
    this.perception = new Perception(this);
    this.managers = [];
    this.ready = loadAiData().then((data) => this.#init(data)).catch((err) => {
      console.error('[AI] data failed to load – AI disabled', err);
      this.enabled = false;
    });
  }

  #init(data) {
    this.data = data;
    this.diff = difficultyOf(data, this.difficultyId);
    this.buildOrder = buildOrderOf(data, this.race, this.diff.buildOrder);
    this.armies = armiesOf(data, this.race);
    this.defensePlan = defensePlanOf(data, this.diff.defense);
    this.researchPlan = researchPlanOf(data, this.diff.research ?? 'none');
    this.budget = new Budget(this);
    this.strategy = new StrategyManager(this);
    this.economy = new EconomyManager(this);
    this.construction = new ConstructionManager(this);
    this.production = new ProductionManager(this);
    this.military = new MilitaryManager(this);
    this.scout = new ScoutManager(this);
    this.researcher = new ResearchManager(this);
    this.maintenance = new MaintenanceManager(this);
    const iv = AI.intervals;
    this.managers = [
      { m: this.strategy, interval: iv.strategy },
      { m: this.economy, interval: iv.economy },
      { m: this.construction, interval: iv.construction },
      { m: this.production, interval: iv.production },
      { m: this.maintenance, interval: iv.maintenance }, // before Military: it reads bb.maintaining
      { m: this.military, interval: iv.military },
      { m: this.scout, interval: iv.scout },
      { m: this.researcher, interval: iv.research },
    ].map((e, i) => ({ ...e, timer: i * 0.1 })); // spread over time
    return this;
  }

  /** Unlock record of the team (research / salvage), for role resolution */
  get teamUnlocks() { return this.unlocks ?? this.world.production?.unlocksOf(this.team) ?? null; }

  get isReady() { return Boolean(this.diff) && this.enabled; }

  /** Out of the match (eliminated / surrendered) or stopped */
  get finished() {
    return !this.enabled || Boolean(this.world.match?.result) || Boolean(this.world.match?.eliminated?.has(this.team));
  }

  stop() {
    this.enabled = false;
    this.queue = [];
    for (const { m } of this.managers) m.dispose?.();
    clearIntent(this.team);
  }

  /**
   * Thinks and acts. Call after each simulation tick with the simulation time in seconds (world.tick / tickRate).
   * Cheap when nothing is due.
   */
  update(simTime) {
    if (!this.isReady || this.finished || !this.world.economy || !this.world.production) return;
    if (this.lastTime === null) { this.lastTime = simTime; this.stats.startedAt = simTime; }
    const dt = Math.min(AI.maxUpdateStep, Math.max(0, simTime - this.lastTime));
    this.lastTime = simTime;
    this.now = simTime;
    this.perception.update(simTime, dt);
    if (!this.perception.own.anchor) return; // nothing left to play with
    const scale = this.diff.thinkScale ?? 1;
    for (const e of this.managers) {
      e.timer -= dt;
      if (e.timer > 0) continue;
      e.timer = e.interval * scale;
      try { e.m.think(simTime); } catch (err) { console.error(`[AI ${this.team}] ${e.m.constructor.name} failed`, err); }
    }
    this.#flush(dt);
  }

  // ---------- commands (rate limited) ----------

  /**
   * Queues a command for this team. `key` replaces a still-queued command with the same key (e.g. a unit's newest
   * order); higher priority is sent first. The command gets `team` here.
   */
  issue(cmd, { priority = PRIORITY.normal, key = null, onDrop = null } = {}) {
    const entry = { cmd: { ...cmd, team: this.team }, priority, key, time: this.now, onDrop };
    if (key !== null) {
      const i = this.queue.findIndex((q) => q.key === key);
      if (i >= 0) { this.queue[i] = entry; return; }
    }
    this.queue.push(entry);
  }

  /** Is a command with this key still waiting in the rate limiter? */
  isQueued(key) { return this.queue.some((q) => q.key === key); }

  #flush(dt) {
    const apm = this.diff.apm ?? 60;
    this.tokens = Math.min(AI.apmBurst, this.tokens + (apm / 60) * dt);
    if (!this.queue.length) return;
    this.queue = this.queue.filter((q) => {
      const fresh = this.now - q.time <= COMMAND_STALE_SECONDS;
      if (!fresh) { this.stats.dropped++; q.onDrop?.(); }
      return fresh;
    });
    this.queue.sort((a, b) => b.priority - a.priority || a.time - b.time);
    while (this.tokens >= 1 && this.queue.length) {
      const { cmd } = this.queue.shift();
      this.tokens -= 1;
      this.stats.commands++;
      this.commandBus.submit(cmd);
    }
  }

  // ---------- debugging ----------

  note(text) {
    this.log.push({ time: Math.round(this.now), text });
    if (this.log.length > 60) this.log.shift();
  }

  /** One line of state for the console (aiReport) */
  status() {
    const own = this.perception.own;
    const eco = this.world.economy;
    return {
      team: this.team,
      race: this.race,
      difficulty: this.diff?.id ?? this.difficultyId,
      time: Math.round(this.now),
      state: this.bb.state,
      buildStep: `${this.construction?.step ?? 0}/${this.buildOrder?.length ?? 0}`,
      structures: own.complete.length,
      building: own.building.length,
      builders: own.builders.length,
      harvesters: own.harvesters.length,
      mechsCrewed: own.crewedMechs.length,
      mechsEmpty: own.uncrewedMechs.length,
      freeCrews: own.freeCrews.length,
      army: Math.round(own.armyStrength),
      enemyKnown: Math.round(this.perception.knownEnemyStrength()),
      ore: Math.round(eco?.amount(this.team, 'ore') ?? 0),
      energy: Math.round(eco?.amount(this.team, 'energy') ?? 0),
      pop: `${eco?.populationUsed(this.team) ?? 0}/${eco?.populationCap(this.team) ?? 0}`,
      waves: this.stats.wavesSent,
      recalled: this.stats.wavesRecalled,
      firstAttack: this.stats.firstAttackAt === null ? '-' : Math.round(this.stats.firstAttackAt),
      // v2
      harvWanted: this.bb.harvestersWanted ?? 0,
      research: this.researcher?.summary() ?? '-',      // completed research count
      researchRun: this.researcher?.running() ?? '-',   // research / analysis items queued or running now
      researchWhy: this.researcher?.why() ?? '-',       // what the research manager waits for (Research.js #block)
      analyses: this.stats.analyses ?? 0,
      salvage: this.stats.salvaged ?? 0,
      bay: this.maintenance ? `${this.maintenance.stats.bayVisits}/${this.maintenance.stats.swaps}` : '-',
      fieldRep: this.maintenance?.stats.fieldRepairs ?? 0,
      harass: this.stats.harassRuns ?? 0,
      counters: this.production?.lastCounter ? 'on' : '-',
      spotTests: this.construction?.searchStats.tests ?? 0,
      // v3
      bayCrews: own.bayCrews.length,                     // own crews waiting in bay queues now
      bayJoins: this.military?.stats.bayJoins ?? 0,      // joinBay commands sent
      rallySets: this.military?.stats.rallySets ?? 0,    // setRally commands sent (bays follow bb.rally)
      allies: this.perception.own.allyStructures.length ? `${this.military?.stats.allyHelps ?? 0}${this.bb.allyHelp ? '*' : ''}` : '-',
      nodeSquad: this.military?.nodeCount ?? 0,
      budget: this.budget?.summary() ?? '-',             // research share of spending / wanted share (%)
      budgetHeld: this.production?.budgetHeld ?? 0,      // normal-priority production held back for research
      target: this.#targetText(),
      // v4 (docs/notes/ai-v4.md): economy trap
      econBlock: this.bb.econ?.block ?? '-',             // what keeps the economy back ('-' = nothing)
      econHold: Math.round(this.economy?.holdSeconds ?? 0), // s spent in the hold (no robots / crews / bay repairs)
      buildWait: this.#buildWaitText(),                  // what the next building waits for, e.g. "vehicleFactory: money ore 120/250 (14 s)"
      refused: this.construction?.refusedCount ?? 0,     // placements the game refused (log: "build X refused: …")
      econRes: this.#costText(this.bb.econReserve),      // economy reserve also high-priority spending respects
      // v5: attack decisions
      enemyEst: Math.round(this.strategy?.lastEstimate ?? 0), // estimated enemy army (grows while unseen + known defences)
      intelAge: Number.isFinite(this.perception.intelAge()) ? Math.round(this.perception.intelAge()) : '-', // s since an enemy army unit was seen
      recon: this.bb.recon ? (this.bb.recon.done ? `done ${Math.round(this.now - this.bb.recon.doneAt)} s` : 'on way') : '-',
      // D3 (docs/notes/d3-ai-economy.md): energy
      plants: this.economy?.plan?.plants ?? 0,                // own power plants (finished + building + placed)
      lowEnergy: Math.round(this.economy?.lowSeconds ?? 0),   // s spent in low energy in total
      lowNow: eco?.isLowEnergy?.(this.team) ? Math.round(this.economy?.lowStreak ?? 0) : '-', // s of the current low streak
      power: this.economy?.powerText() ?? '-',                // measured energy income/demand per s (averaged)
      powerPlan: this.economy?.plan ? `${this.economy.plan.income.toFixed(1)}/${this.economy.plan.demand.toFixed(1)}` : '-', // planned income/demand
      powerWaits: this.construction?.powerWaits ?? 0,         // builds / defences held back for a power plant
      hq: eco?.hasHq ? (eco.hasHq(this.team) ? 'yes' : 'NO') : '-',
      // R3 (docs/notes/r3-air-ai.md): air force and anti-air
      hangar: this.construction?.ownedCount('@aircraft') ?? 0,                  // own hangars (also building / placed)
      air: `${own.combatVehicles.filter((v) => v.airborne).length}/${this.perception.enemyAir()}`, // own aircraft / enemy aircraft seen
      antiAir: `${this.construction?.ownedCount('@antiAir') ?? 0}/${own.mechs.filter((m) => weaponDefsOf(m).some(hitsAir)).length}`, // AA towers / AA robots
      armsMade: this.maintenance?.stats.armsOrdered ?? 0,                     // arms ordered for swaps (repair.makeArms)
      // v20 fixes (r3-air-ai.md "Opravy po ověření v20")
      defense: this.construction?.defenseText() ?? '-',                       // defence items started/all + what it waits for
      board: `${this.military?.stats.boardSent ?? 0}/${this.military?.stats.boardStuck ?? 0}`, // board orders sent / given up (crew got no closer)
      airPopHeld: this.production?.airPopHeld ?? 0,                           // thinks an aircraft did not fit the population
      // E1 (docs/notes/e1-ai-air.md): population plan for aircraft
      airRes: `${this.production?.airPop ?? 0}/${this.production?.airWant ?? 0}`, // population kept for aircraft / aircraft wanted
      popHeld: `${this.production?.popHeld ?? 0}/${this.production?.crewHeld ?? 0}/${this.production?.released ?? 0}`, // crews+vehicles held for the reserve / robot assemblies held (no crew) / queued items cancelled
      commands: this.stats.commands,
      dropped: this.stats.dropped,
    };
  }

  /** v4: "vehicleFactory: money ore 120/250 (14 s)" or '-' */
  #buildWaitText() {
    const w = this.construction?.waiting;
    if (!w) return '-';
    return `${w.econ ? '*' : ''}${w.id}: ${w.why} (${Math.round(this.now - w.since)} s)`;
  }

  /** v4: "ore 250 energy 60" or '-' */
  #costText(cost) {
    const parts = Object.entries(cost ?? {}).filter(([, v]) => v > 0).map(([r, v]) => `${r} ${Math.round(v)}`);
    return parts.length ? parts.join(' ') : '-';
  }

  /** v3: wave target for status(): "t2" (enemy team of a building), "node", "explore" or '-' */
  #targetText() {
    const t = this.bb.wave && !this.bb.wave.ended ? this.bb.wave.target : null;
    if (!t) return '-';
    if (t.kind === 'structure') return `t${t.team}`;
    return t.kind === 'superNode' ? 'node' : t.kind;
  }
}
