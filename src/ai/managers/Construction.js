// Steel Mans AI – construction: the opening build order, reactive builds (power, supply), builders for unfinished
// buildings and the base defence plan (towers, walls with turrets, a killbox on the hard difficulty).
// Spots are searched in rings around the HQ with the same placement test as the UI (Construction.canPlace), with a
// free gap around every building; the cone in front of the HQ stays free for the army and the defences.
// Buildings are ordered with placeStructure / placeWall / placeTurret commands; their result comes back through a
// ticket (buildCommands.newTicket), a refused spot is avoided for a while.
import { AI, WALL, CMD_WALL, PATHFINDING } from '../../config.js';
import { getStats, unitStats } from '../../data/Stats.js';
import { cachedFootprint, modelFootprint } from '../../units/Structure.js';
import { canPlace, placementBox, terrainFit } from '../../game/Construction.js';
import { boxInArea } from '../../game/PreBuild.js';
import { newTicket, quantizeYaw, checkRules } from '../../game/commands/buildCommands.js';
import { planWallLine, wallCommandOf, checkWallCommand } from '../../game/Walls.js';
import { PRIORITY, dist, posOf, rotate, add, isIdle, nearest, quarterYaw, yawOf, sumCost, affordsAbove } from '../util.js';
import { resolveStructure, structureMatches, buildableStructures, STRUCTURE_ROLES } from '../AiData.js';
import { plannedPower, powerGap } from '../power.js';

let segmentIds = null;
/** Wall posts, wall segments and turrets on posts (built as chains; they take no parallel build slot) */
function isWallPiece(s) {
  segmentIds ??= new Set(Object.values(getStats().structures ?? {}).map((x) => x.wallSegment).filter(Boolean));
  const p = s?.stats?.placement;
  return p === 'wall' || p === 'post' || segmentIds.has(s?.unitId);
}
const BACK_ROLES = ['power', 'supply', 'storage'];

export class ConstructionManager {
  constructor(ai) {
    this.ai = ai;
    this.step = 0;             // index of the next build order step
    this.stepAt = 0;           // the next step may start at this sim time (difficulty.buildStepDelay)
    this.pending = [];         // placements waiting for their result: { unitId, x, z, time, kind }
    this.failed = [];          // refused spots: { x, z, until }
    this.skips = new Map();    // structure id -> number of times no spot was found
    this.noBuilderSince = new Map(); // unfinished structure eid -> sim time since nobody works on it
    this.busyBuilders = new Map();   // builder eid -> sim time until it counts as busy (order not applied yet)
    this.defense = { index: 0, jobs: [], done: false };
    this.noSpot = new Map();   // structure id -> { count, retryAt, gaveUp } (no free spot found)
    this.builderWantedAt = -Infinity; // last sim time a task waited for a builder (Maintenance leaves trucks alone)
    this.searchStats = { searches: 0, tests: 0 }; // spot searches / canPlace tests (performance check in status())
  }

  /** Did construction need a builder recently? (other managers borrow HoverTrucks only when it did not) */
  needsBuilder(now) { return now - this.builderWantedAt < AI.maintenance.builderFreeSeconds; }

  /** A building id we found no room for: wait before trying again (reactive builds stop wanting it after a while) */
  #spotBlocked(id, now) {
    const e = this.noSpot.get(id);
    return Boolean(e) && now < e.retryAt;
  }

  #spotFailed(id, now) {
    const cfg = AI.noSpot;
    const e = this.noSpot.get(id) ?? { count: 0, retryAt: 0, gaveUp: false };
    e.count++;
    if (e.count >= cfg.giveUpAfter) {
      e.retryAt = now + cfg.giveUpSeconds;
      if (!e.gaveUp) this.ai.note(`no room for ${id} – paused ${cfg.giveUpSeconds} s`);
      e.gaveUp = true;
      e.count = 0; // after the pause it starts again with the widest search
    } else {
      e.retryAt = now + Math.min(cfg.retryMax, cfg.retryBase * 2 ** (e.count - 1));
      if (e.count === 1 && !e.gaveUp) this.ai.note(`no spot for ${id} – searching farther`);
    }
    this.noSpot.set(id, e);
  }

  /** Search limits of a building after earlier failures: farther out, the front cone allowed from the 2nd failure */
  #searchOf(id) {
    const cfg = AI.noSpot;
    const e = this.noSpot.get(id);
    const fails = e ? (e.gaveUp ? cfg.giveUpAfter : e.count) : 0;
    return {
      maxRadius: Math.min(cfg.maxRadiusLimit, AI.placement.maxRadius + fails * cfg.radiusGrowth),
      keepFront: fails < 2,
    };
  }

  get world() { return this.ai.world; }
  get own() { return this.ai.perception.own; }

  think(now) {
    this.#expire(now);
    this.#helpOrphans(now);
    this.#advanceBuildOrder(now);
    this.#reserve({}); // set again below while the next building waits for resources (+ placements not paid yet)
    const prevWait = this.waiting;
    this.waiting = null;
    const tasks = this.#nextTasks(now);
    const task = tasks[0] ?? null;
    if (task && prevWait) this.waiting = prevWait; // #start sets it again (keeps `since` while the reason stays)
    if (!task) { this.#defense(now); return; }
    if (!this.defense.done) this.defenseWhy = `after ${task.value}`; // [v20] status(): other builds come first
    const short = this.#start(task, now);
    // v4: the first build waits for energy only (ore is there) – a power plant first, or the wait never ends
    if (short?.length === 1 && short[0] === 'energy') {
      const power = tasks.find((t) => t !== task && structureMatches('@power', resolveStructure(t.value, this.ai.race, this.ai.teamUnlocks) ?? ''));
      if (power) this.#start(power, now, { keepReserve: true });
    }
  }

  /** v4: is this building an economy build Economy marked (bb.econ.structures: vehicle factory / supply in a trap)? */
  #isEcon(id) {
    return (this.ai.bb.econ?.structures ?? []).some((v) => structureMatches(v, id));
  }

  /** v4: cost of placements sent but not paid yet (no result) – optionally only economy builds */
  #pendingCost(econOnly = false) {
    return sumCost(...this.pending.filter((p) => p.kind === 'structure' && !p.result && p.cost && (!econOnly || this.#isEcon(p.unitId)))
      .map((p) => p.cost));
  }

  // ---------- bookkeeping ----------

  #expire(now) {
    for (const p of this.pending) if (now - p.time >= AI.buildResultTimeout && !p.result) p.onResult?.({ error: 'timeout' });
    this.pending = this.pending.filter((p) => now - p.time < AI.buildResultTimeout);
    this.failed = this.failed.filter((f) => f.until > now);
    for (const [eid, until] of this.busyBuilders) if (until <= now) this.busyBuilders.delete(eid);
  }

  /** Own structures answering a role / id + placements still waiting for their result */
  ownedCount(value) {
    const n = this.own.structures.filter((s) => structureMatches(value, s.unitId)).length;
    return n + this.#unseenPending().filter((p) => structureMatches(value, p.unitId)).length;
  }

  /** Placements not in Perception's lists yet (waiting for their result, or placed since the last refresh) */
  #unseenPending() {
    return this.pending.filter((p) => p.kind === 'structure' && !(p.structure && this.own.structures.includes(p.structure)));
  }

  /** Buildings under construction that take a parallel slot (wall pieces do not) */
  get activeBuilds() {
    return this.own.building.filter((s) => !isWallPiece(s)).length + this.#unseenPending().length;
  }

  /**
   * Idle builders (not just ordered), nearest to a point first. For a race whose buildings go on alone
   * (continuesWithoutBuilder) a builder that already started its building counts as free: a new order replaces
   * the old one and the started building keeps growing.
   */
  idleBuilders(near) {
    const alone = Boolean(getStats().races?.[this.ai.race]?.construction?.continuesWithoutBuilder);
    const started = (b) => alone && b.order?.type === 'build' && (b.order.structure?.progress ?? 0) > 0 && !(b.orderQueue?.length);
    const list = this.own.builders.filter((b) => (isIdle(b) || started(b)) && !this.busyBuilders.has(b.eid));
    return near ? list.sort((a, b) => dist(posOf(a), near) - dist(posOf(b), near)) : list;
  }

  #reserveBuilder(b, now) { this.busyBuilders.set(b.eid, now + 3); }

  /**
   * Resources kept for the next building (bb.buildReserve). bb.reserved = that + what Research saves for its next
   * item (bb.researchReserve) – Production spends no normal-priority money below it.
   */
  #reserve(cost, econ = false) {
    const bb = this.ai.bb;
    bb.buildReserve = sumCost(this.#pendingCost(), cost); // v4: a placement keeps its money until it is paid
    bb.reserved = sumCost(bb.buildReserve, bb.researchReserve);
    // v4: an economy build (Economy: bb.econ.structures) is kept even from high-priority spending (Production
    // #canSpend) – robots, crews and bay repairs ate the income of one truck, the vehicle factory never fitted
    bb.econReserve = sumCost(this.#pendingCost(true), econ ? cost : {});
  }

  // ---------- builders for unfinished buildings ----------

  #targeted(s) {
    return this.own.builders.some((b) => b.order?.structure === s || b.orderQueue?.some((e) => e.ref?.structure === s));
  }

  #helpOrphans(now) {
    const chainBusy = this.own.builders.some((b) => b.order?.type === 'build' && isWallPiece(b.order.structure ?? {}));
    const alone = Boolean(getStats().races?.[this.ai.race]?.construction?.continuesWithoutBuilder);
    for (const s of this.own.building) {
      const goesOn = alone && s.progress > 0; // started buildings of this race finish without a builder
      if (goesOn || s.builders?.size > 0 || this.#targeted(s) || (isWallPiece(s) && chainBusy)) { this.noBuilderSince.delete(s.eid); continue; }
      const since = this.noBuilderSince.get(s.eid) ?? now;
      this.noBuilderSince.set(s.eid, since);
      if (now - since < AI.orphanSeconds) continue;
      const b = this.idleBuilders(posOf(s))[0];
      if (!b) return;
      this.#reserveBuilder(b, now);
      this.noBuilderSince.set(s.eid, now);
      this.ai.issue({ type: 'helpBuild', units: [b.eid], structure: s.eid, queued: false }, { priority: PRIORITY.high, key: `build:${b.eid}` });
    }
  }

  // ---------- build order ----------

  #advanceBuildOrder(now) {
    const ai = this.ai;
    const order = ai.buildOrder;
    while (this.step < order.length) {
      const s = order[this.step];
      if (s.unit) {
        ai.bb.minVehicles[s.unit] = Math.max(ai.bb.minVehicles[s.unit] ?? 0, s.count ?? 1);
        this.step++;
        continue;
      }
      const id = resolveStructure(s.build, ai.race, ai.teamUnlocks);
      if (!id || (this.skips.get(id) ?? 0) >= 3) { this.step++; continue; } // nothing fits this race / no room
      if (this.ownedCount(s.build) >= (s.count ?? 1)) {
        this.step++;
        this.stepAt = now + (ai.diff.buildStepDelay ?? 0);
        continue;
      }
      break;
    }
    if (this.step >= order.length && !ai.bb.openingDone) {
      ai.bb.openingDone = true;
      ai.note('opening build order done');
    }
  }

  /** Candidate builds now, best first (empty while every parallel slot is taken) */
  #nextTasks(now) {
    const ai = this.ai;
    if (this.activeBuilds >= ai.diff.parallelBuilds) return [];
    const tasks = [];
    const step = ai.buildOrder[this.step];
    const blocked = (value) => {
      const id = resolveStructure(value, ai.race, ai.teamUnlocks);
      return Boolean(id) && this.#spotBlocked(id, now);
    };
    if (step?.build && now >= this.stepAt && !blocked(step.build)) tasks.push({ value: step.build, priority: PRIORITY.high, order: true });
    // [E1] economy hold after the opening (too few trucks): only economy builds – before, defences, plants and supply
    // ate the ore of the one truck left and the hold never ended (wave E2: normal "trucks 1/3" for 20 min)
    const hold = ai.bb.openingDone && ai.bb.econ?.hold;
    for (const w of ai.bb.wantStructures ?? []) {
      if (hold && !(ai.bb.econ.structures ?? []).includes(w.value)) continue;
      if (this.ownedCount(w.value) < w.count && !blocked(w.value)) tasks.push({ value: w.value, priority: w.priority ?? PRIORITY.normal });
    }
    tasks.sort((a, b) => b.priority - a.priority || Number(Boolean(b.order)) - Number(Boolean(a.order)));
    return tasks;
  }

  /**
   * Starts a build. @returns {string[] | undefined} resources it waits for (v4), otherwise nothing.
   * keepReserve (v4): a power plant squeezed in while the first build waits for energy – it may use the ore of that
   * build's reservation and leaves the reservation as it is.
   */
  #start(task, now, { keepReserve = false } = {}) {
    const ai = this.ai;
    const { race, team } = ai;
    let id = resolveStructure(task.value, race, ai.teamUnlocks);
    if (!id) return;
    const econ = this.#isEcon(id); // v4: a requirement swapped in below is part of the economy build too
    let stats = unitStats('structures', id, race, team);
    const rule = checkRules(this.world, team, race, id, stats);
    if (rule === 'requires') {
      // Build the missing requirement first (e.g. a part factory before the assembly bay)
      const missing = (stats.requires ?? []).find((r) => this.ownedCount(r) === 0);
      if (!missing) return; // the requirement is being built – wait
      id = resolveStructure(missing, race, ai.teamUnlocks);
      if (!id) return;
      stats = unitStats('structures', id, race, team);
      if (checkRules(this.world, team, race, id, stats)) return;
    } else if (rule) {
      if (task.order) this.step++;
      return;
    }
    // D3: a consumer the energy plan does not cover – a power plant goes first (Economy also raises its target)
    if (!keepReserve && (stats.energyUse ?? 0) > 0 && !this.powerCovers(stats.energyUse, now)) {
      const plant = this.#plantInstead(now);
      if (plant) { id = plant; stats = unitStats('structures', id, race, team); }
    }
    const eco = this.world.economy;
    const need = sumCost(stats.cost, this.#pendingCost()); // v4: money of unpaid placements is taken
    if (!eco.canAfford(team, need)) {
      if (keepReserve) return;
      this.#reserve(stats.cost, econ);
      this.#wait(id, econ, `money ${missingText(eco, team, stats.cost)}`, now);
      return Object.keys(eco.missing(team, need));
    }
    if (!keepReserve) this.#reserve({});
    const anchor = this.own.anchor;
    const builder = this.idleBuilders(anchor)[0];
    if (!builder) {
      this.builderWantedAt = now;
      if (econ && !keepReserve) this.#reserve(stats.cost, true); // v4: keep the money of an economy build until a builder is free
      if (!keepReserve) this.#wait(id, econ, 'no builder', now);
      return;
    }
    if (this.#spotBlocked(id, now)) { if (!keepReserve) this.#wait(id, econ, 'no spot', now); return; } // a requirement swapped in above may be waiting for room
    if (!keepReserve) this.waiting = null;
    const back = BACK_ROLES.some((r) => STRUCTURE_ROLES[r](stats, id));
    const spot = this.findSpot(id, { near: anchor, builders: [builder], prefer: back ? 'back' : 'sides', gap: this.#passageGap(), ...this.#searchOf(id) });
    if (!spot) {
      this.skips.set(id, (this.skips.get(id) ?? 0) + 1);
      this.#spotFailed(id, now);
      if (!keepReserve) this.#wait(id, econ, 'no spot', now);
      return;
    }
    this.noSpot.delete(id);
    this.skips.delete(id);
    this.place(id, spot, builder, now, 'structure');
  }

  /**
   * D3: does the energy plan (src/ai/power.js) cover a new consumer drawing `use` per second within
   * difficulty.power.gateSlack? When not, bb.powerRequest asks Economy for the plants it needs.
   */
  powerCovers(use, now) {
    const ai = this.ai;
    const cfg = ai.diff.power ?? {};
    if (cfg.gate === false || ai.world.economy.infiniteResources) return true;
    this.powerPlan ??= {};
    const plan = plannedPower(ai, this.powerPlan);
    if (!plan.plantId || plan.plantIncome <= 0) return true; // nothing to build for it
    const gap = powerGap(plan, use, cfg.coverage ?? 1, ai.economy?.avgDemand ?? 0);
    if (gap <= (cfg.gateSlack ?? 0)) return true;
    if ((cfg.maxPlants ?? Infinity) <= plan.plants) return true; // no more plants planned: build anyway
    ai.bb.powerRequest ??= { use: 0, until: -Infinity };
    ai.bb.powerRequest.use = use;
    ai.bb.powerRequest.until = now + (cfg.requestSeconds ?? 0);
    this.powerWaits = (this.powerWaits ?? 0) + 1;
    return false;
  }

  /** D3: power plant id to build instead of an uncovered consumer, or null (none for the race / no room for it now) */
  #plantInstead(now) {
    const ai = this.ai;
    const id = resolveStructure('@power', ai.race, ai.teamUnlocks);
    if (!id || this.#spotBlocked(id, now)) return null;
    if (checkRules(this.world, ai.team, ai.race, id, unitStats('structures', id, ai.race, ai.team))) return null;
    return id;
  }

  /**
   * [E1] Free space kept around a new base building so a crew squad can always walk between two buildings: the nav
   * grid blocks a cell whose centre lies in an obstacle inflated by unit radius + PATHFINDING.clearance, so a
   * corridor stays open only when it is one cell wider than both inflations (wave E2: a hard crew spawned at a
   * CryoFarm was walled in by buildings 7 u apart). Crew radius = the biggest own squad (formation-based), else
   * AI.placement.passRadius. Defence pieces keep AI.placement.gap (walls are meant to close).
   */
  #passageGap() {
    let radius = 0;
    for (const c of this.own.crews) radius = Math.max(radius, c.radius ?? 0);
    if (!(radius > 0)) radius = AI.placement.passRadius;
    return Math.max(AI.placement.gap, PATHFINDING.cellSize + 2 * (radius + PATHFINDING.clearance));
  }

  /** v4: what the next building waits for (status().econBlock / buildWait): { id, econ, why, since } */
  #wait(id, econ, why, now) {
    const same = this.waiting?.id === id && this.waiting.why.split(' ')[0] === why.split(' ')[0];
    this.waiting = { id, econ, why, since: same ? this.waiting.since : now };
  }

  /** Orders a building at a spot; the builder goes there */
  place(id, spot, builder, now, kind = 'structure') {
    const ai = this.ai;
    const cost = unitStats('structures', id, ai.race, ai.team)?.cost ?? {};
    const job = { unitId: id, x: spot.x, z: spot.z, time: now, kind, cost };
    const ticket = newTicket(ai.team, (res) => this.#onResult(job, res));
    this.pending.push(job);
    this.#reserveBuilder(builder, now);
    ai.issue({
      type: 'placeStructure', race: ai.race, unitId: id, x: spot.x, z: spot.z, yaw: spot.yaw,
      builders: [builder.eid], queued: false, ticket,
    }, { priority: PRIORITY.urgent, onDrop: () => { this.#forget(job); job.onResult?.({ error: 'dropped' }); } });
    ai.note(`build ${id}`);
    return job;
  }

  #forget(job) { this.pending = this.pending.filter((p) => p !== job); }

  #onResult(job, res) {
    job.result = res;
    if (res?.structure) {
      // Kept a moment longer: Perception lists the new building at its next refresh
      job.structure = res.structure;
      job.time = this.ai.now - AI.buildResultTimeout + AI.perceptionInterval * 4;
    } else this.#forget(job);
    if (res?.error === 'blocked') this.failed.push({ x: job.x, z: job.z, until: this.ai.now + AI.failedSpotSeconds });
    if (res?.error) this.#refused(job, res.error);
    job.onResult?.(res);
  }

  /**
   * v4: the game refused a placement. Counted (status().refused) and logged once per building + reason within
   * AI.econ.refusalNoteSeconds – before v4 a refused vehicle factory only showed as "build vehicleFactory" again.
   */
  #refused(job, error) {
    this.refusedCount = (this.refusedCount ?? 0) + 1;
    const key = `${job.unitId}:${error}`;
    this.lastRefusal = { id: job.unitId, error, time: this.ai.now };
    this.refusalNotes ??= new Map();
    if (this.ai.now - (this.refusalNotes.get(key) ?? -Infinity) < AI.econ.refusalNoteSeconds) return;
    this.refusalNotes.set(key, this.ai.now);
    this.ai.note(`build ${job.unitId} refused: ${error}`);
  }

  // ---------- spots ----------

  /** Yaw of buildings: facing the front, rounded to a quarter turn */
  get baseYaw() { return quantizeYaw(quarterYaw(yawOf(this.ai.perception.frontDir()))); }

  #nearFailed(x, z) { return this.failed.some((f) => Math.hypot(f.x - x, f.z - z) < AI.placement.step); }

  /**
   * Free spot for a building: rings around `near`, angles closest to the preferred direction first.
   * prefer: 'back' | 'sides' | 'any'; keepFront = keep the cone in front of the HQ free.
   * @returns {{x, z, yaw} | null}
   */
  findSpot(id, opts) {
    // Hundreds of canPlace tests: one frozen obstacle list for the whole search (the AI thinks between ticks)
    const nav = this.world.nav;
    return nav?.withObstacleSnapshot ? nav.withObstacleSnapshot(() => this.#search(id, opts)) : this.#search(id, opts);
  }

  #search(id, { near, builders = [], prefer = 'any', keepFront = true, minRadius = AI.placement.minRadius, maxRadius = AI.placement.maxRadius, gap = AI.placement.gap }) {
    const cfg = AI.placement;
    this.searchStats.searches++;
    const fp = cachedFootprint(id, this.ai.race);
    if (!fp) { modelFootprint(id, this.ai.race).catch(() => {}); return null; } // loads for the next try
    const yaw = this.baseYaw;
    const front = this.ai.perception.frontDir();
    const anchor = this.own.anchor ?? near;
    const prefDirs = prefer === 'back' ? [rotate(front, Math.PI)]
      : prefer === 'sides' ? [rotate(front, Math.PI / 2), rotate(front, -Math.PI / 2)] : null;
    const angles = [];
    for (let k = 0; k < cfg.angles; k++) {
      const a = (k / cfg.angles) * Math.PI * 2;
      const d = { x: Math.cos(a), z: Math.sin(a) };
      const score = prefDirs ? Math.max(...prefDirs.map((p) => p.x * d.x + p.z * d.z)) : Math.random();
      angles.push({ d, score });
    }
    angles.sort((a, b) => b.score - a.score);
    for (let r = minRadius; r <= maxRadius; r += cfg.step) {
      for (const { d } of angles) {
        const x = near.x + d.x * r;
        const z = near.z + d.z * r;
        if (this.#nearFailed(x, z)) continue;
        if (keepFront) {
          const off = { x: x - anchor.x, z: z - anchor.z };
          const len = Math.hypot(off.x, off.z);
          if (len > cfg.frontClearFrom && (off.x * front.x + off.z * front.z) / len > cfg.frontConeDot) continue;
        }
        const box = placementBox(fp, x, z, yaw);
        const padded = { ...box, halfX: box.halfX + gap, halfZ: box.halfZ + gap };
        this.searchStats.tests++;
        // v4: the same tests as the placeStructure command (buildCommands.checkPlace) – without the slope (R6) and
        // pre-build square (N8) checks the game refused the spot as 'blocked' again and again (vehicle factory never built)
        if (canPlace(this.world, padded, builders) && boxInArea(this.world, this.ai.team, box) && terrainFit(this.world, box).ok) return { x, z, yaw };
      }
    }
    return null;
  }

  // ---------- defence plan ----------

  #defense(now) {
    const ai = this.ai;
    const plan = ai.defensePlan;
    const d = this.defense;
    if (d.done || !plan?.items?.length) return;
    if (!ai.bb.openingDone || now < (plan.startAfter ?? 0)) { this.defenseWhy = 'later'; return; }
    if (ai.bb.econ?.hold) { this.defenseWhy = 'econ hold'; return; } // [E1] trucks first (see #nextTasks)
    if (this.pending.length || this.activeBuilds >= ai.diff.parallelBuilds) { this.defenseWhy = 'slots'; return; }
    const ready = (plan.requires ?? []).every((r) => this.own.complete.some((s) => structureMatches(r, s.unitId)));
    if (!ready) { this.defenseWhy = 'requires'; return; }
    if (!d.jobs.length) {
      if (d.index >= plan.items.length) { d.done = true; ai.note('defence plan done'); return; }
      d.jobs = this.#expand(plan.items[d.index++]);
      return;
    }
    const job = d.jobs[0];
    if (job.state === 'waiting') {
      // Its command is under way; no result in time (dropped / lost) = try again
      if (now - job.waitingSince > AI.buildResultTimeout) { job.state = null; job.tries = (job.tries ?? 0) + 1; }
      if ((job.tries ?? 0) >= AI.wallTries) job.state = 'failed';
      return;
    }
    job.waitingSince = now;
    if (job.state === 'done' || job.state === 'failed') { d.jobs.shift(); return; }
    if (job.kind === 'turrets') { this.#turrets(job, now); return; }
    this.defenseMinOre ??= { ore: plan.minOre ?? 0 };
    // spare ore above the plan's minOre. [v20] Kept as the build reserve meanwhile: Production spent every ore on
    // parts (normal priority) and the spare ore never came – no tower in 20 min
    if (!affordsAbove(this.world.economy, ai.team, this.defenseMinOre)) { this.#defenseWait('ore', this.defenseMinOre); return; }
    if (job.kind === 'tower') this.#tower(job, now);
    else if (job.kind === 'wall') this.#wall(job, now);
  }

  /** Data item → jobs: { kind: 'tower', point } | { kind: 'wall', posts: [p], turrets: [index], dir } */
  #expand(item) {
    const p = this.ai.perception;
    const anchor = p.own.anchor;
    const dir = rotate(p.frontDir(), item.angleOffset ?? 0);
    const perp = rotate(dir, Math.PI / 2);
    const jobs = [];
    if (item.type === 'tower') {
      const n = item.count ?? 1;
      for (let i = 0; i < n; i++) {
        const off = n > 1 ? (i - (n - 1) / 2) * 2 * (item.spread ?? 0) / Math.max(1, n - 1) : 0;
        jobs.push({ kind: 'tower', point: add(anchor, rotate(dir, off), item.distance), tries: 0 });
      }
    } else if (item.type === 'wall') {
      const n = Math.max(2, item.posts ?? 2);
      const centre = add(anchor, dir, item.distance);
      const start = add(centre, perp, -WALL.postSpacing * (n - 1) / 2);
      const order = [...Array(n).keys()].sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2));
      jobs.push({ kind: 'wall', start, along: perp, posts: n, turrets: order.slice(0, item.turrets ?? 0), shift: dir, tries: 0 });
    } else if (item.type === 'funnel') {
      const gapCentre = add(anchor, dir, item.distance);
      for (const side of [1, -1]) {
        const armDir = normalize({ x: perp.x * side + dir.x * (item.flare ?? 0), z: perp.z * side + dir.z * (item.flare ?? 0) });
        const start = add(gapCentre, perp, side * (item.gap ?? 30) / 2);
        const turrets = [...Array(Math.min(item.turretsPerArm ?? 0, item.armPosts ?? 3)).keys()];
        jobs.push({ kind: 'wall', start, along: armDir, posts: Math.max(2, item.armPosts ?? 3), turrets, shift: dir, tries: 0 });
      }
    } else if (item.type === 'edgeWall') {
      // Flank closing: straight outwards from the side of the base to the map edge (cut there by the game's planner)
      const start = add(anchor, dir, item.distance);
      const turrets = [...Array(Math.max(0, item.turrets ?? 0)).keys()];
      const maxLength = Math.min(item.maxLength ?? Infinity, WALL.postSpacing * WALL.maxSegments);
      jobs.push({ kind: 'wall', edge: true, start, along: dir, maxLength, turrets, shift: perp, tries: 0 });
    }
    return jobs;
  }

  #tower(job, now) {
    const ai = this.ai;
    const id = resolveStructure('@tower', ai.race, ai.teamUnlocks);
    if (!id) { job.state = 'failed'; return; }
    const stats = unitStats('structures', id, ai.race, ai.team);
    if (checkRules(this.world, ai.team, ai.race, id, stats)) { job.state = 'failed'; return; }
    if (!this.world.economy.canAffordUpfront(ai.team, stats.cost)) { this.#defenseWait('money', stats.cost); return; }
    if (!this.#defensePowered(job, stats, now)) { this.#defenseWait('power'); return; } // D3: plants first
    const builder = this.idleBuilders(job.point)[0];
    if (!builder) { this.#defenseWait('builder', stats.cost); return; }
    this.defenseWhy = null;
    const spot = this.findSpot(id, { near: job.point, builders: [builder], keepFront: false, minRadius: 0, maxRadius: AI.placement.defenseSearchRadius });
    if (!spot) { job.state = 'failed'; return; }
    job.state = 'waiting';
    const placed = this.place(id, spot, builder, now, 'structure');
    placed.onResult = (res) => { job.state = res?.structure ? 'done' : (++job.tries >= AI.wallTries ? 'failed' : null); };
  }

  /**
   * Plan of a wall job made by the game's own line planner (Walls.planWallLine – the same geometry as the player's
   * wall placement). Straight line: `posts` posts from `start` along `along`; edge wall: from `start` along `along`
   * to the map edge (the last segment cut there). Every retry moves the start by AI.wallShiftStep along `shift`
   * (edge walls: alternately to both sides). @returns plan or null (footprint not loaded / edge out of reach)
   */
  #wallPlan(job, postId) {
    const k = job.tries;
    const offset = job.edge ? (k % 2 ? -1 : 1) * Math.ceil(k / 2) : k;
    const start = add(job.start, job.shift, offset * AI.wallShiftStep);
    const length = job.edge ? job.maxLength : WALL.postSpacing * (job.posts - 1);
    const plan = planWallLine(this.world, this.ai.team, this.ai.race, postId, start, add(start, job.along, length));
    if (!plan || !plan.ok || !plan.segments.length) return null;
    if (job.edge && !this.#reachesEdge(plan)) return null;
    return plan;
  }

  /** Does a planned line end at the map edge (cut last segment, or its last post next to the edge)? */
  #reachesEdge(plan) {
    if (plan.segments.some((s) => s.trim)) return true;
    const half = this.world.map?.half ?? this.world.nav?.half ?? Infinity;
    const last = plan.posts.at(-1);
    return Math.max(Math.abs(last.x), Math.abs(last.z)) >= half - CMD_WALL.edgeMargin - WALL.postSpacing;
  }

  #wall(job, now) {
    const ai = this.ai;
    const postId = resolveStructure('@wallPost', ai.race, ai.teamUnlocks);
    if (!postId) { job.state = 'failed'; return; }
    const postStats = unitStats('structures', postId, ai.race, ai.team);
    const segId = postStats.wallSegment;
    if (!segId || checkRules(this.world, ai.team, ai.race, postId, postStats)) { job.state = 'failed'; return; }
    if (!cachedFootprint(postId, ai.race) || !cachedFootprint(segId, ai.race)) {
      modelFootprint(postId, ai.race).catch(() => {});
      modelFootprint(segId, ai.race).catch(() => {});
      return;
    }
    const builder = this.idleBuilders(job.start)[0];
    if (!builder) return;
    // The game's own placeWall check decides whether the line stands (no own copy of the wall geometry)
    let cmd = null;
    let waitForMoney = false;
    this.world.nav.withObstacleSnapshot(() => {
      while (job.tries < AI.wallTries) {
        const plan = this.#wallPlan(job, postId);
        if (plan) {
          const c = { ...wallCommandOf(plan, { race: ai.race, postId, builders: [builder] }), team: ai.team };
          const res = checkWallCommand(this.world, c);
          if (!res.error || res.error === 'resources') { cmd = c; waitForMoney = Boolean(res.error); job.plan = plan; return; }
          if (res.error !== 'blocked') { job.tries = AI.wallTries; return; }
        }
        job.tries++;
      }
    });
    if (!cmd) { job.state = 'failed'; ai.note(job.edge ? 'edge wall does not fit / edge too far' : 'defence wall does not fit'); return; }
    if (waitForMoney) return; // fits; tried again once affordable
    const plan = job.plan;
    job.state = 'waiting';
    this.#reserveBuilder(builder, now);
    const ticket = newTicket(ai.team, (res) => {
      if (res?.error) { job.state = null; job.tries++; if (job.tries >= AI.wallTries) job.state = 'failed'; return; }
      job.state = 'done';
      const points = job.turrets.map((i) => plan.posts[i]).filter(Boolean);
      if (points.length) this.defense.jobs.splice(1, 0, { kind: 'turrets', points, since: this.ai.now });
    });
    const { team: _team, ...payload } = cmd;
    ai.issue({ ...payload, ticket }, { priority: PRIORITY.normal, onDrop: () => { job.state = null; } });
    ai.note(`${job.edge ? 'edge' : 'defence'} wall of ${plan.posts.length} posts`);
  }

  #turrets(job, now) {
    const ai = this.ai;
    if (now - job.since > AI.turretWaitSeconds || !job.points.length) { job.state = 'done'; return; }
    const posts = this.own.structures.filter((s) => s.stats.placement === 'wall');
    const point = job.points[0];
    const post = nearest(posts, point);
    if (!post || dist(posOf(post), point) > WALL.snapRadius) {
      if (!this.pending.length && now - job.since > AI.orphanSeconds * 2) job.points.shift(); // post never built / destroyed
      return;
    }
    if (post.hasTurret) { job.points.shift(); return; }
    if (!post.complete) return;
    const turretId = this.#turretFor(post);
    if (!turretId) { job.state = 'done'; return; }
    const stats = unitStats('structures', turretId, ai.race, ai.team);
    if (!this.world.economy.canAffordUpfront(ai.team, stats.cost)) { this.#defenseWait('money', stats.cost); return; }
    if (!this.#defensePowered(job, stats, now)) { this.#defenseWait('power'); return; } // D3: plants first
    const builder = this.idleBuilders(point)[0];
    if (!builder) { this.#defenseWait('builder', stats.cost); return; }
    this.defenseWhy = null;
    job.state = 'waiting';
    this.#reserveBuilder(builder, now);
    const ticket = newTicket(ai.team, (res) => {
      job.state = null;
      if (!res?.error || res.error === 'noPost') job.points.shift();
    });
    ai.issue({ type: 'placeTurret', race: ai.race, unitId: turretId, post: post.eid, builders: [builder.eid], queued: false, ticket },
      { priority: PRIORITY.normal, onDrop: () => { job.state = null; } });
  }

  /**
   * [v20] A defence job waits: `why` for status().defense; `cost` is kept as the build reserve (bb.reserved – Production
   * spends no normal-priority money below it) until the next think of Construction resets it.
   */
  #defenseWait(why, cost = null) {
    this.defenseWhy = why;
    if (cost) this.#reserve(cost);
  }

  /** [v20] status(): "2/6" (defence items started / all), "done", "-" (no plan) + what it waits for */
  defenseText() {
    const items = this.ai.defensePlan?.items?.length ?? 0;
    if (!items) return '-';
    if (this.defense.done) return 'done';
    return `${this.defense.index}/${items}${this.defenseWhy ? ` ${this.defenseWhy}` : ''}`;
  }

  /**
   * D3: may a tower / turret be built – the energy plan covers it? While not, Economy is asked for plants and the job
   * waits; after difficulty.power.defenseWaitSeconds (no room for plants…) it is built anyway.
   */
  #defensePowered(job, stats, now) {
    if (this.powerCovers(stats.energyUse ?? 0, now)) { job.powerSince = null; job.powerNoted = false; return true; }
    job.powerSince ??= now;
    if (now - job.powerSince < (this.ai.diff.power?.defenseWaitSeconds ?? Infinity)) {
      if (!job.powerNoted) { job.powerNoted = true; this.ai.note('defence waits for power'); }
      return false;
    }
    return true;
  }

  /** Cheapest turret this race may put on the post */
  #turretFor(post) {
    const ai = this.ai;
    const candidates = [];
    for (const id of buildableStructures(ai.race, ai.teamUnlocks)) {
      if (!structureMatches('@turret', id)) continue;
      const s = unitStats('structures', id, ai.race, ai.team);
      if (s.mountOn !== post.unitId) continue;
      if (checkRules(this.world, ai.team, ai.race, id, s)) continue;
      candidates.push({ id, cost: (s.cost?.ore ?? 0) + (s.cost?.energy ?? 0) });
    }
    candidates.sort((a, b) => a.cost - b.cost);
    return candidates[0]?.id ?? null;
  }
}

/** v4: "ore 120/250 energy 30/60" – only the resources that are short */
function missingText(eco, team, cost = {}) {
  return Object.entries(cost).filter(([r, v]) => eco.amount(team, r) < (v ?? 0))
    .map(([r, v]) => `${r} ${Math.round(eco.amount(team, r))}/${v}`).join(' ');
}

function normalize(d) {
  const len = Math.hypot(d.x, d.z) || 1;
  return { x: d.x / len, z: d.z / len };
}
