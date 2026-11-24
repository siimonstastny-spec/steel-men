// Steel Men AI – research (v2): queueResearch by the plan of the difficulty (data/ai/research.json): research is
// chosen by ROLE derived from its stats.json effects (AiData.researchRolesOf), never by name; weapon research only when
// own units use the weapons it improves. Captured parts at the research facility are analysed (queueAnalysis), and
// spare HoverTrucks fetch legs / torso wrecks (salvage) – a full truck drives to the research facility by itself, a
// partly loaded idle one is sent there (deliver). The facility itself is wanted by Economy (bb.wantStructures).
import { AI } from '../../config.js';
import { PRODUCES, REASON } from '../../game/Production.js';
import { resolve } from '../../game/commands/CommandBus.js';
import { PRIORITY, dist, posOf, isIdle, alive, nearest, weaponDefsOf, sumCost, affordsAbove } from '../util.js';
import { researchRolesOf, researchFitsWeapons, resolveStructure } from '../AiData.js';
import { unitStats } from '../../data/Stats.js';

export class ResearchManager {
  constructor(ai) {
    this.ai = ai;
    this.inflight = new Map(); // research id / loot key -> sim time until it counts as queued
    this.salvaging = new Map(); // truck eid -> { wreck eid, until }
    this.started = [];          // research ids queued (status / note)
    this.waitSince = null;      // sim time the current pick started waiting for resources (reserveAfter)
    this.blocked = 'no facility'; // why no research was queued at the last think (status().researchWhy)
  }

  get plan() { return this.ai.researchPlan; }
  get research() { return this.ai.world.research; }
  get prod() { return this.ai.world.production; }

  think(now) {
    const plan = this.plan;
    if (!plan?.enabled || !this.research || !this.prod) return;
    for (const [k, until] of this.inflight) if (until <= now) this.inflight.delete(k);
    const facilities = this.prod.producersOf(this.ai.team, PRODUCES.research).filter((s) => s.complete);
    if (facilities.length) {
      if (plan.analysis) this.#analyse(facilities, now);
      this.#research(facilities, now);
    } else {
      this.#block('no facility');
    }
    this.#salvage(facilities, now);
  }

  // ---------- research ----------

  /**
   * Spare resources for `cost` above what Construction keeps for its next building (bb.buildReserve – never our
   * own bb.researchReserve) and above `min` (the plan's minOre / minEnergy, or nothing once the pick has waited
   * reserveAfter s and its money is reserved).
   */
  #affordable(cost = {}, min = {}) {
    const eco = this.ai.world.economy;
    const team = this.ai.team;
    const build = this.ai.bb.buildReserve ?? {};
    return affordsAbove(eco, team, cost, build, min);
  }

  /** v3: resources missing for `cost` above the build reserve and `min` (Budget: Production holds back on them) */
  #short(cost = {}, min = {}) {
    const eco = this.ai.world.economy;
    const build = this.ai.bb.buildReserve ?? {};
    if (eco.infiniteResources) return [];
    return Object.entries(cost).filter(([r, v]) => eco.amount(this.ai.team, r) - (build[r] ?? 0) - (min[r] ?? 0) < (v ?? 0)).map(([r]) => r);
  }

  /** Short text of what is missing for `cost` (researchWhy) */
  #shortText(cost = {}) {
    const eco = this.ai.world.economy;
    const build = this.ai.bb.buildReserve ?? {};
    return Object.entries(cost).map(([r, v]) => `${r} ${Math.round(eco.amount(this.ai.team, r) - (build[r] ?? 0))}/${v}`).join(' ');
  }

  /**
   * Money Research saves for its next item: Production (normal priority) spends nothing below bb.reserved, so the
   * research is not starved by an endless stream of parts. {} = nothing reserved.
   */
  #setReserve(cost) {
    const bb = this.ai.bb;
    bb.researchReserve = { ...cost };
    bb.reserved = sumCost(bb.buildReserve, bb.researchReserve);
  }

  /** Remembers why nothing was queued; a new reason goes to the log once (aiReport) */
  #block(reason, { waiting = false } = {}) {
    if (!waiting) { // not waiting for money: no reservation, the reserveAfter clock starts again
      if (Object.keys(this.ai.bb.researchReserve ?? {}).length) this.#setReserve({});
      this.waitSince = null;
      this.ai.budget?.wait('research', null);
    }
    const key = reason.replace(/\s\d.*$/, ''); // the numbers change every think – log the kind only
    // v5: reasons flip (resources ↔ saving ↔ budget …), so a kind is logged at most once per AI.researchNoteSeconds
    const kind = key.split(' ')[0];
    this.notedAt ??= new Map();
    if (key !== this.blockedKey && kind !== 'running' && this.ai.now - (this.notedAt.get(kind) ?? -Infinity) >= AI.researchNoteSeconds) {
      this.notedAt.set(kind, this.ai.now);
      this.ai.note(`research waits: ${reason}`);
    }
    this.blockedKey = key;
    this.blocked = reason;
  }

  /** Research / analysis items of the team now (queued or running) + commands still in flight */
  #activeCount() {
    const items = this.prod.itemsOfTeam(this.ai.team).filter((i) => i.kind === 'research' || i.kind === 'analysis');
    return items.length + this.inflight.size;
  }

  /** Facility with room (shortest queue first) */
  #freeFacility(facilities) {
    return facilities.filter((s) => this.prod.itemsOf(s.eid).length < 1)
      .sort((a, b) => this.prod.itemsOf(a.eid).length - this.prod.itemsOf(b.eid).length)[0] ?? null;
  }

  #phase(now) {
    const phases = this.plan.phases ?? [];
    return phases.find((p) => p.until === null || p.until === undefined || now < p.until) ?? phases.at(-1) ?? null;
  }

  /** Weapon classes / ids the team fields now (own robots, combat vehicles, towers) */
  #ownWeapons() {
    const own = this.ai.perception.own;
    const classes = new Set();
    const ids = new Set();
    for (const u of [...own.mechs, ...own.combatVehicles, ...own.complete]) {
      for (const w of weaponDefsOf(u)) { if (w.class) classes.add(w.class); if (w.id) ids.add(w.id); }
    }
    return { classes, ids };
  }

  /** Best research to queue now: first role of the phase that has an available one, cheapest of that role */
  #choose(facility, now) {
    const r = this.research;
    const team = this.ai.team;
    const phase = this.#phase(now);
    if (!phase) return null;
    const weapons = this.#ownWeapons();
    const options = this.prod.researchOptions(facility).filter((id) => {
      if (this.inflight.has(id) || r.hasPendingEffects(id) && !(r.defs[id].effects ?? []).some((e) => !e.pending)) return false;
      return r.status(team, id).ok;
    });
    const costOf = (id) => Object.values(r.defs[id].cost ?? {}).reduce((s, v) => s + (v ?? 0), 0);
    // [E1] the air plan needs a research tier (hangar requiresTier): the cheapest research of the tier whose
    // completions are missing comes first (v20b/wave E2: normal opened tier 2 too late or never – no hangar)
    const rushTier = this.#rushTier(now);
    if (rushTier !== null) {
      const fits = options.filter((id) => r.defs[id]?.tier === rushTier).sort((a, b) => costOf(a) - costOf(b));
      if (fits.length) return { id: fits[0], role: 'air tier' };
    }
    for (const role of phase.roles ?? []) {
      const fits = options.filter((id) => {
        const roles = researchRolesOf(r.defs[id], r.unlocksOf(id));
        if (!roles.has(role)) return false;
        return role !== 'weapons' || researchFitsWeapons(r.defs[id], weapons.classes, weapons.ids);
      });
      if (!fits.length) continue;
      fits.sort((a, b) => costOf(a) - costOf(b));
      return { id: fits[0], role };
    }
    return null;
  }

  /**
   * Queues the next research. Money: at once when the cost fits above the plan's minOre / minEnergy; a pick that
   * waited reserveAfter s reserves its cost (bb.researchReserve) and is queued as soon as the cost alone fits.
   * Without the reservation Production spent every ore above Construction's reserve on parts, so the research
   * (cost + minOre + reserve) never fitted – the AI never researched (docs/notes/ai-research-fix.md).
   */
  #research(facilities, now) {
    const plan = this.plan;
    if (this.#activeCount() >= (plan.maxActive ?? 1)) return this.#block(`running ${this.#activeCount()}/${plan.maxActive ?? 1}`);
    // [E1] economy hold (Economy #econ: too few trucks): no research, no reservation – the ore goes to the trucks
    // (v20b: normal kept 1/3 trucks for minutes while "saving missileArtillery" took the ore)
    if (this.ai.bb.econ?.hold) return this.#block('economy hold');
    const facility = this.#freeFacility(facilities);
    if (!facility) return this.#block('facility queue full');
    const pick = this.#choose(facility, now);
    if (!pick) return this.#block(`no research for roles ${(this.#phase(now)?.roles ?? []).join(',')}`);
    const cmd = { type: 'queueResearch', producer: facility.eid, researchId: pick.id };
    const res = this.prod.check({ ...cmd, team: this.ai.team });
    const cost = res.cost ?? this.research.defs[pick.id]?.cost ?? {};
    if (!res.ok && res.reason !== REASON.resources) return this.#block(`check ${pick.id}: ${res.reason}`);
    if (!res.ok) this.#starve(cost);
    // v3: budget buckets – above the phase's research share while the army is short of money: wait (no reservation)
    const budget = this.ai.budget;
    if (budget && !budget.allows('research', cost)) return this.#block(`budget ${budget.summary()} – army first`);
    const min = { ore: plan.minOre ?? 0, energy: plan.minEnergy ?? 0 };
    this.waitSince ??= now;
    const reserving = this.ai.bb.state !== 'defend' && now - this.waitSince >= (plan.reserveAfter ?? Infinity);
    this.#setReserve(reserving ? cost : {}); // no reservation while defending (units first)
    if (!res.ok || !this.#affordable(cost, reserving ? {} : min)) {
      budget?.wait('research', this.#short(cost, reserving ? {} : min)); // v3: Production holds back on these
      return this.#block(`${reserving ? 'saving' : 'resources'} ${pick.id} ${this.#shortText(cost)}`
        + (reserving ? '' : ` (+min ${min.ore}/${min.energy})`), { waiting: true });
    }
    this.ai.issue(cmd, { priority: PRIORITY.normal });
    this.inflight.set(pick.id, now + AI.perceptionInterval * 2 + 2);
    this.started.push(pick.id);
    budget?.wait('research', null);
    budget?.record('research', cost);
    // A held reservation stays until the next think: the command waits in the rate limiter meanwhile
    this.waitSince = null;
    this.blocked = `queued ${pick.id}`;
    this.blockedKey = null;
    this.ai.note(`research ${pick.id} (${pick.role})`);
  }

  #starve(cost) {
    const eco = this.ai.world.economy;
    for (const r of Object.keys(eco.missing(this.ai.team, cost ?? {}))) this.ai.bb.starved[r] = this.ai.now;
  }

  /**
   * [E1] Tier whose completed research the aircraft hangar still lacks, from difficulty.air.hangarAt −
   * air.tierLead s on (no hangar owned yet), or null. Uses Research.tierStatus(team, hangar requiresTier).missing.
   */
  #rushTier(now) {
    const ai = this.ai;
    const air = ai.diff.air;
    if (!air || !((air.aircraft ?? 0) > 0) || air.hangarAt === null || air.hangarAt === undefined) return null;
    if (now < air.hangarAt - (air.tierLead ?? 0) || (ai.construction?.ownedCount('@aircraft') ?? 0) > 0) return null;
    const id = resolveStructure('@aircraft', ai.race, ai.teamUnlocks);
    const tier = id ? unitStats('structures', id, ai.race, ai.team)?.requiresTier : null;
    if (!tier || !this.research.tierStatus) return null;
    const need = this.research.tierStatus(ai.team, tier).missing.find((m) => m.type === 'completed');
    return need ? need.tier : null;
  }

  // ---------- salvage analysis ----------

  #analyse(facilities, now) {
    const r = this.research;
    const team = this.ai.team;
    for (const loot of r.analyses(team)) {
      if (r.isActive(team, loot.key) || this.inflight.has(loot.key)) continue;
      const facility = this.#freeFacility(facilities);
      if (!facility) return;
      const cmd = { type: 'queueAnalysis', producer: facility.eid, lootKey: loot.key };
      const res = this.prod.check({ ...cmd, team });
      if (!res.ok || !this.#affordable(res.cost, { ore: this.plan.minOre ?? 0, energy: this.plan.minEnergy ?? 0 })) continue;
      this.ai.issue(cmd, { priority: PRIORITY.high });
      this.ai.budget?.record('research', res.cost);
      this.inflight.set(loot.key, now + AI.perceptionInterval * 2 + 2);
      this.ai.stats.analyses = (this.ai.stats.analyses ?? 0) + 1;
      this.ai.note(`analyse captured ${loot.kind} (${loot.set})`);
      return; // one per think
    }
  }

  // ---------- salvage (HoverTrucks fetch wrecks) ----------

  #salvage(facilities, now) {
    const ai = this.ai;
    const want = this.plan.salvage?.trucks ?? 0;
    for (const [eid, s] of this.salvaging) {
      const v = resolve(ai.world, eid);
      if (!v || !alive(v) || s.until <= now || (isIdle(v) && !(v.cargo?.length))) this.salvaging.delete(eid);
    }
    if (want <= 0 || !facilities.length) return;
    const own = ai.perception.own;
    const construction = ai.construction;
    // Idle loaded trucks: unload at the nearest research facility
    for (const v of own.vehicles) {
      if (!v.salvager || !v.cargo?.length || !isIdle(v)) continue;
      const site = nearest(facilities, posOf(v));
      ai.issue({ type: 'deliver', units: [v.eid], structure: site.eid, queued: false }, { priority: PRIORITY.normal, key: `truck:${v.eid}` });
      this.salvaging.set(v.eid, { wreck: null, until: now + AI.research.salvageOrderSeconds });
    }
    if (ai.bb.state === 'defend' || this.salvaging.size >= want) return;
    if (construction?.needsBuilder(now)) return; // builders are needed for buildings
    const free = construction ? construction.idleBuilders() : own.builders.filter(isIdle);
    const truck = free.find((v) => v.salvager && !v.cargoFull && !this.salvaging.has(v.eid)
      && !ai.bb.truckJobs?.has(v.eid));
    if (!truck) return;
    // Spare one builder: only when another idle builder stays for construction
    if (free.length < 2 && own.builders.length <= (ai.diff.builders ?? 1)) return;
    const wreck = this.#pickWreck(truck);
    if (!wreck) return;
    construction?.busyBuilders.set(truck.eid, now + AI.maintenance.truckReserveSeconds);
    this.salvaging.set(truck.eid, { wreck: wreck.eid, until: now + AI.research.salvageOrderSeconds });
    ai.issue({ type: 'salvage', units: [truck.eid], wreck: wreck.eid, queued: false }, { priority: PRIORITY.low, key: `truck:${truck.eid}` });
    ai.stats.salvaged = (ai.stats.salvaged ?? 0) + 1;
  }

  /** Visible legs / torso wreck near the base, away from known enemy armies, not taken by another truck */
  #pickWreck(truck) {
    const ai = this.ai;
    const p = ai.perception;
    const anchor = p.own.anchor;
    const taken = new Set([...this.salvaging.values()].map((s) => s.wreck));
    const danger = p.known().filter((m) => !m.isStructure && m.armed);
    const list = (ai.world.salvage ?? []).filter((w) => {
      if (!w.available || !w.salvageable || w.part?.isArm || w.eid == null || taken.has(w.eid)) return false;
      const at = w.object?.position;
      if (!at || dist(at, anchor) > AI.research.salvageRadius) return false;
      if (!p.isVisible(at)) return false;
      return !danger.some((m) => dist(m, at) < AI.research.salvageEnemyRadius);
    });
    // Enemy parts first (they can be analysed), then the nearest
    list.sort((a, b) => Number(b.info?.team !== ai.team) - Number(a.info?.team !== ai.team)
      || dist(a.object.position, posOf(truck)) - dist(b.object.position, posOf(truck)));
    return list[0] ?? null;
  }

  /** Completed research count (status().research) */
  summary() {
    const r = this.research;
    if (!r) return '-';
    return `${r.teams[this.ai.team]?.completed.size ?? 0}`;
  }

  /** Research / analysis items queued or running now, e.g. "compositeArmor 40%" (status().researchRun) */
  running() {
    if (!this.prod) return '-';
    const items = this.prod.itemsOfTeam(this.ai.team).filter((i) => i.kind === 'research' || i.kind === 'analysis');
    if (!items.length) return '-';
    return items.map((i) => `${i.researchId ?? i.lootKey} ${Math.round((i.total > 0 ? Math.min(1, i.elapsed / i.total) : 0) * 100)}%`).join(', ');
  }

  /** Why nothing is being queued now (status().researchWhy) */
  why() {
    if (!this.plan?.enabled) return 'disabled';
    return this.blocked ?? '-';
  }
}
