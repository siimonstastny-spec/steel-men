// Steel Men – research of every team (stats.json → research, rules.research, rules.salvageResearch).
// The code knows no research ids or factions, everything comes from the data:
//   • which research a team sees: races[*].exclusive.research (canProduce 'research'), common ones for all
//   • tiers: rules.research.tiers[tier] { requiresStructures, requiresCompleted { tier, count } }
//   • effects of completed research: 'modify' (stats, applied by Stats.js per team), 'rule' (Stats.teamRule),
//     'unlock' (production); items with requiresResearch are unlocked once all their research is done
//   • salvage analysis: a captured part the team cannot make, brought to a research facility, can be analysed
//     there; it unlocks production of that part kind (not the whole set) and is not used up
//   • [A9] tiers may also need completed research with a flag (requiresCompletedFlag, e.g. a superweapon program)
//     and the match option superweapons (tier rule "superweapons": true); research may need one of a list
//     (requiresAnyResearch). Superweapon items are unavailable while world.settings.superweapons === false
//     (superweaponsEnabled() is the one place reading it; Stats.canProduce asks through setResearchContext).
// Research belongs to one team. [A9] Data network: a team with a research whose effect type is
// RESEARCH_A9.networkEffect and a finished standing building from its nodeStructures is a node; allied nodes get
// the 'modify' / 'rule' effects of each other's common research (not faction / exclusive / program research, no
// unlocks, no tiers, the same research counts once). Nodes are re-checked every RESEARCH_A9.networkCheckInterval
// and on every completion; effects are recomputed only when the shared list changes. Allies share fog anyway
// (Alliances / FogOfWar), so the network adds no sight of its own.
// Queueing / paying / completion is driven by world.production (src/game/Production.js, commands
// 'queueResearch' / 'queueAnalysis'); ResearchView only shows it.
import { getStats, canProduce, unlockId, setResearchEffects, researchTimeFactor, teamRule, partStats, SLOT_KIND, setResearchContext, isSuperweaponItem, unitStats } from '../data/Stats.js';
import { RESEARCH, SALVAGE_DROP, RESEARCH_A9, ARCHEOLOGY } from '../config.js';
import { edgeDistance } from './Combat.js';
import { areAllies, allianceLeader } from './Alliances.js';

const EMPTY = Object.freeze([]);

const PART_GROUP = 'partSets';   // exclusive group / unlock group of robot parts
const RESEARCH_GROUP = 'research';
// stats.json section -> unlock group, for items unlocked by requiresResearch
const LOCKABLE = { parts: PART_GROUP, vehicles: 'vehicles', structures: 'structures' };
// [B6] building ids that take a mech's captured parts, recomputed only when the rules object changes (like
// Vehicle.dropOffCache) – no arrays / closures per delivery check
const NO_RULE = Symbol('noRule'); // [B6 QA] never equal to a rules object (or its absence), so the first call fills the cache
const deliveryCache = { rule: NO_RULE, ids: [] };
const lootKeys = new Map(); // [B6 QA] set -> Map(kind -> loot key): no template string per part per check
const vehicleLootKeys = new Map(); // [A9-buildings] vehicle id -> loot key of its wreck
const VEHICLE_GROUP = 'vehicles'; // [A9-buildings] exclusive / unlock group of vehicles
const lootScratch = { set: null, kind: null, path: null, race: null }; // addLoot argument, reused (addLoot copies it)

function deliveryIds(rule) {
  if (rule !== deliveryCache.rule) {
    deliveryCache.rule = rule;
    deliveryCache.ids = [...new Set([...(rule?.deliverTo ?? []), ...(rule?.stockOnlyTo ?? []), ...SALVAGE_DROP.stockBuildings])];
  }
  return deliveryCache.ids;
}

export class Research {
  /**
   * @param {object} world
   * @param {object} opts  races[team] = race key, unlocks[team] = Stats.createUnlocks() record of the team
   */
  constructor(world, { races, unlocks }) {
    this.world = world;
    this.races = races;
    this.unlocks = unlocks;
    // completed: research ids; active: queue key -> facility; loot: lootKey -> { set, kind, path, race }
    this.teams = races.map(() => ({ completed: new Set(), active: new Map(), loot: new Map(), analysed: new Set() }));
    this.grantedTier = races.map(() => 0); // tier granted per team by the starting research (applyStartResearch)
    this.deliveryTimer = 0;
    this.sites = []; // [B6] delivery sites of the current check (reused)
    // [A9] Data network state: node flag and alliance leader per team at the last check, research ids shared to
    // each team (sorted), teams with the network research
    this.nodes = new Uint8Array(races.length);
    this.leaders = Int32Array.from(races, (_, team) => allianceLeader(team));
    this.shared = races.map(() => EMPTY);
    this.memberEffect = races.map(() => null); // network research effect per team (null = not a member)
    this.networkUsers = 0;
    this.networkTimer = 0;
    this.tierList = null;          // tiers() – the data does not change during a match
    this.exclusiveResearch = null; // ids listed in any races[*].exclusive.research (never shared)
    races.forEach((_, team) => setResearchEffects(team, [])); // a new game starts without research
    setResearchContext({ tierOf: (unlocked) => this.#tierOfUnlocks(unlocked), superweaponsEnabled: () => this.superweaponsEnabled() });
  }

  /** Detaches this match from Stats.canProduce (call when the match is thrown away) */
  dispose() { setResearchContext(null); }

  get defs() { return getStats().research ?? {}; }

  /** [A9] Match option: superweapons and their programs exist (world.settings.superweapons, missing = on) */
  superweaponsEnabled() { return this.world.settings?.[RESEARCH_A9.superweaponsSetting] !== false; }

  // ---------- research list and locks ----------

  /** Research ids this team's faction may research (data order) */
  available(team) {
    return Object.keys(this.defs).filter((id) => canProduce(this.races[team], RESEARCH_GROUP, id, this.unlocks[team]));
  }

  /** Tier numbers that exist in rules.research.tiers or in the research list, ascending */
  tiers() {
    if (!this.tierList) {
      const fromRules = Object.keys(getStats().rules.research?.tiers ?? {}).map(Number);
      const fromList = Object.values(this.defs).map((d) => d.tier);
      this.tierList = [...new Set([...fromRules, ...fromList])].filter(Number.isFinite).sort((a, b) => a - b);
    }
    return this.tierList;
  }

  isDone(team, id) { return this.teams[team]?.completed.has(id) ?? false; }

  /** Completed research of one tier (own research only – shared Data network research does not count) */
  doneInTier(team, tier) {
    const defs = this.defs;
    let n = 0;
    for (const id of this.teams[team]?.completed ?? EMPTY) if (defs[id]?.tier === tier) n++;
    return n;
  }

  /** [A9] Completed research whose stats entry has a truthy field `flag` (e.g. 'superweaponProgram') */
  doneWithFlag(team, flag) {
    const defs = this.defs;
    let n = 0;
    for (const id of this.teams[team]?.completed ?? EMPTY) if (defs[id]?.[flag]) n++;
    return n;
  }

  /**
   * Is a tier open for the team? @returns {{ open, missing: [{ type: 'structure', id } | { type: 'completed', tier, count, have }
   *   | { type: 'flag', flag, count, have } | { type: 'option', option }] }}
   */
  tierStatus(team, tier) {
    const rule = getStats().rules.research?.tiers?.[tier] ?? {};
    const missing = [];
    for (const id of rule.requiresStructures ?? []) {
      if (!this.#hasStructure(team, id)) missing.push({ type: 'structure', id });
    }
    const need = rule.requiresCompleted;
    if (need) {
      const have = this.doneInTier(team, need.tier);
      if (have < need.count) missing.push({ type: 'completed', tier: need.tier, count: need.count, have });
    }
    const flag = rule.requiresCompletedFlag;
    if (flag) {
      const have = this.doneWithFlag(team, flag.flag);
      if (have < flag.count) missing.push({ type: 'flag', flag: flag.flag, count: flag.count, have });
    }
    if (rule.superweapons && !this.superweaponsEnabled()) missing.push({ type: 'option', option: RESEARCH_A9.superweaponsSetting });
    return { open: missing.length === 0, missing };
  }

  /** Same answer as tierStatus(team, tier).open, without allocating (canProduce asks it per item) */
  #tierOpen(team, tier) {
    const rule = getStats().rules.research?.tiers?.[tier];
    if (!rule) return true;
    for (const id of rule.requiresStructures ?? EMPTY) if (!this.#hasStructure(team, id)) return false;
    const need = rule.requiresCompleted;
    if (need && this.doneInTier(team, need.tier) < need.count) return false;
    const flag = rule.requiresCompletedFlag;
    if (flag && this.doneWithFlag(team, flag.flag) < flag.count) return false;
    return !(rule.superweapons && !this.superweaponsEnabled());
  }

  /** Open tier of the team owning an unlock record (Stats.canProduce); Infinity for a record of no team */
  #tierOfUnlocks(unlocked) {
    const team = this.unlocks.indexOf(unlocked);
    return team < 0 ? Infinity : this.openTier(team);
  }

  /** Starting research of tier N grants tier N (buildings with requiresTier <= N); researching more still needs the facility */
  grantTier(team, tier) {
    if (Number.isFinite(tier) && tier > (this.grantedTier[team] ?? 0)) this.grantedTier[team] = tier;
  }

  /** Highest tier currently open (0 = none): max of the computed one and the granted one */
  openTier(team) {
    let best = this.grantedTier[team] ?? 0;
    for (const tier of this.tiers()) if (tier > best && this.#tierOpen(team, tier)) best = tier;
    return best;
  }

  /** Other research this one needs (research.requiresResearch) that is not done yet */
  missingResearch(team, id) {
    return (this.defs[id]?.requiresResearch ?? []).filter((r) => !this.isDone(team, r));
  }

  /**
   * [A9] research.requiresAnyResearch (at least one of the list): [] when met or absent, else the listed ids the
   * team's faction may research (what the UI offers as "one of")
   */
  missingAnyResearch(team, id) {
    const any = this.defs[id]?.requiresAnyResearch;
    if (!any?.length || any.some((r) => this.isDone(team, r))) return [];
    return any.filter((r) => this.defs[r] && canProduce(this.races[team], RESEARCH_GROUP, r, this.unlocks[team]));
  }

  /**
   * Can the team queue this research now? @returns {{ ok, reason, tier }}
   * reason: 'done' | 'active' | 'disabled' (superweapons off / not the faction's) | 'tier' | 'research'
   */
  status(team, id) {
    const def = this.defs[id];
    if (!def) return { ok: false, reason: 'disabled' };
    if (this.isDone(team, id)) return { ok: false, reason: 'done' };
    if (this.teams[team].active.has(id)) return { ok: false, reason: 'active' };
    if (!canProduce(this.races[team], RESEARCH_GROUP, id, this.unlocks[team])) return { ok: false, reason: 'disabled' };
    const tier = this.tierStatus(team, def.tier);
    if (!tier.open) return { ok: false, reason: 'tier', tier };
    if (this.missingResearch(team, id).length || this.missingAnyResearch(team, id).length) return { ok: false, reason: 'research' };
    return { ok: true };
  }

  /** [A9] Superweapon program (RESEARCH_A9.programFlag) */
  isProgram(id) { return Boolean(this.defs[id]?.[RESEARCH_A9.programFlag]); }

  /** [A9] May a completed research be shared over the Data network? Common, not exclusive, not a program */
  isShareable(id) {
    const def = this.defs[id];
    if (!def || def.exclusive === true || isSuperweaponItem(def)) return false;
    this.exclusiveResearch ??= new Set(Object.values(getStats().races ?? {}).flatMap((r) => r.exclusive?.research ?? []));
    return !this.exclusiveResearch.has(id);
  }

  /** [A9] Research the team gets from allied Data network nodes (not completed by itself) */
  isShared(team, id) { return this.shared[team]?.includes(id) ?? false; }

  /**
   * [A9] Data network of a team for the UI: member = has the network research; node = member with a finished node
   * building (state of the last check); partners = allied nodes it shares with (ascending); sharedIds = research
   * effects it gets from them
   */
  networkStatus(team) {
    const member = Boolean(this.memberEffect[team]);
    const node = this.nodes[team] === 1;
    const partners = [];
    if (node) for (let t = 0; t < this.races.length; t++) if (t !== team && this.nodes[t] && areAllies(t, team)) partners.push(t);
    return { member, node, partners, sharedIds: this.shared[team] ?? EMPTY };
  }

  /** Research time of the team's faction (races[*].modifiers.researchTime) */
  timeOf(team, id) {
    return (this.defs[id]?.researchTime ?? 0) * researchTimeFactor(this.races[team]);
  }

  /** Effects of the research that do not work yet (stats.json "pending": true) */
  hasPendingEffects(id) { return (this.defs[id]?.effects ?? []).some((e) => e.pending); }

  /** Items whose requiresResearch includes this research: [{ group, id, sub }] (group = unlock group) */
  unlocksOf(id) {
    const s = getStats();
    const out = [];
    for (const [section, group] of Object.entries(LOCKABLE)) {
      for (const [itemId, data] of Object.entries(s[section] ?? {})) {
        if (section === 'parts') {
          for (const [kind, part] of Object.entries(data)) if (part.requiresResearch?.includes(id)) out.push({ group, id: itemId, sub: kind });
        } else if (data.requiresResearch?.includes(id)) out.push({ group, id: itemId, sub: null });
      }
    }
    for (const e of this.defs[id]?.effects ?? []) {
      if (e.type !== 'unlock') continue;
      if (e.partSet) out.push({ group: PART_GROUP, id: e.partSet, sub: e.kind ?? null });
      if (e.vehicle) out.push({ group: 'vehicles', id: e.vehicle, sub: null });
      if (e.structure) out.push({ group: 'structures', id: e.structure, sub: null });
    }
    return out;
  }

  // ---------- queue bookkeeping (Production pays and queues) ----------

  /** Marks a research / analysis as running (queued) at a facility; the same key cannot run twice */
  markActive(team, key, facility) { this.teams[team].active.set(key, facility); }
  clearActive(team, key) { this.teams[team].active.delete(key); }
  isActive(team, key) { return this.teams[team].active.has(key); }

  /** Research finished: effects, unlocks and stats of the team's existing units are refreshed */
  complete(team, id) {
    const t = this.teams[team];
    t.active.delete(id);
    if (!this.defs[id] || t.completed.has(id)) return;
    t.completed.add(id);
    for (const u of this.unlocksOf(id)) {
      const needs = u.group === PART_GROUP
        ? getStats().parts?.[u.id]?.[u.sub]?.requiresResearch
        : getStats()[u.group]?.[u.id]?.requiresResearch;
      if (!this.#raceMayOwn(team, u.group, u.id)) continue; // [A9] research never unlocks another faction's exclusive item
      if ((needs ?? []).every((r) => t.completed.has(r))) this.#unlock(team, u.group, unlockId(u.id, u.sub));
    }
    this.#syncNetwork(team);
  }

  /** [A9] false when the item is exclusive to other races (races[*].exclusive[group]); salvage unlocks go elsewhere */
  #raceMayOwn(team, group, id) {
    const races = getStats().races ?? {};
    let listed = false;
    for (const key in races) {
      if (!races[key].exclusive?.[group]?.includes(id)) continue;
      if (key === this.races[team]) return true;
      listed = true;
    }
    return !listed;
  }

  #applyEffects(team) {
    const defs = this.defs;
    const own = [...this.teams[team].completed].flatMap((id) => defs[id]?.effects ?? []);
    const types = RESEARCH_A9.sharedEffectTypes;
    const shared = this.shared[team].flatMap((id) => (defs[id]?.effects ?? []).filter((e) => types.includes(e.type)));
    setResearchEffects(team, shared.length ? own.concat(shared) : own);
    for (const unit of this.world.allUnits) if (unit.team === team) unit.applyResearch?.();
  }

  // ---------- [A9] Data network ----------

  /** The team's completed network research effect ({ type: RESEARCH_A9.networkEffect, nodeStructures }), or null */
  #networkEffect(team) {
    const defs = this.defs;
    for (const id of this.teams[team]?.completed ?? EMPTY) {
      for (const e of defs[id]?.effects ?? EMPTY) if (e.type === RESEARCH_A9.networkEffect) return e;
    }
    return null;
  }

  /** Member (cached network effect, see #syncNetwork) with a finished standing node building */
  #isNode(team) {
    const ids = this.memberEffect[team]?.nodeStructures;
    if (!ids) return false;
    for (let i = 0; i < ids.length; i++) if (this.#hasStructure(team, ids[i])) return true;
    return false;
  }

  /** Common research of allied nodes this node lacks, sorted (stable, not insertion order) */
  #sharedIds(team) {
    if (!this.nodes[team]) return EMPTY;
    const own = this.teams[team].completed;
    const out = [];
    for (let other = 0; other < this.races.length; other++) {
      if (other === team || !this.nodes[other] || !areAllies(other, team)) continue;
      for (const id of this.teams[other].completed) if (!own.has(id) && !out.includes(id) && this.isShareable(id)) out.push(id);
    }
    return out.length ? out.sort() : EMPTY;
  }

  /** Did a node or an alliance change since the last sync? (no allocation – runs on the check cadence) */
  #networkChanged() {
    for (let team = 0; team < this.races.length; team++) {
      if ((this.#isNode(team) ? 1 : 0) !== this.nodes[team] || allianceLeader(team) !== this.leaders[team]) return true;
    }
    return false;
  }

  /** Recomputes nodes and shared lists; re-applies effects of teams whose list changed, and of `force` (a team, or -1) */
  #syncNetwork(force = -1) {
    const n = this.races.length;
    let users = 0;
    for (let team = 0; team < n; team++) {
      this.memberEffect[team] = this.#networkEffect(team); // membership changes only on completion (this call)
      this.nodes[team] = this.#isNode(team) ? 1 : 0;
      this.leaders[team] = allianceLeader(team);
      if (this.memberEffect[team]) users++;
    }
    this.networkUsers = users;
    for (let team = 0; team < n; team++) {
      const ids = this.#sharedIds(team);
      const before = this.shared[team];
      const same = ids.length === before.length && ids.every((id, i) => id === before[i]);
      this.shared[team] = ids;
      if (team === force || !same) this.#applyEffects(team);
    }
  }

  #unlock(team, group, key) {
    const u = this.unlocks[team];
    if (!u) return;
    u[group] ??= new Set();
    u[group].add(key);
  }

  #hasStructure(team, id) {
    const list = this.world.structures;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.team === team && s.unitId === id && s.complete && !s.destroyed) return true;
    }
    return false;
  }

  // ---------- salvage analysis ----------

  static lootKey(set, kind) {
    let byKind = lootKeys.get(set);
    if (!byKind) { byKind = new Map(); lootKeys.set(set, byKind); }
    let key = byKind.get(kind);
    if (key === undefined) { key = `salvage${unlockId(set, kind)}`; byKind.set(kind, key); }
    return key;
  }

  /**
   * A captured part reached the team's research facility. Stored only when the team cannot make that part
   * kind and it is buildable at all (Alien parts are loot only). @returns {boolean} newly stored
   */
  addLoot(team, { set, kind, path, race = null }) {
    const t = this.teams[team];
    const key = Research.lootKey(set, kind);
    if (!t || t.loot.has(key) || !this.#canAnalyse(team, set, kind)) return false;
    t.loot.set(key, { key, set, kind, path, race });
    return true;
  }

  #canAnalyse(team, set, kind) {
    const raw = getStats().parts?.[set]?.[kind];
    return Boolean(raw) && raw.buildable !== false && !canProduce(this.races[team], PART_GROUP, set, this.unlocks[team], kind);
  }

  // [A9-buildings] loot still worth analysing: a part kind the team cannot make, or a foreign vehicle not unlocked yet
  #lootOpen(team, loot) {
    return loot.vehicle ? this.canAnalyseVehicle(team, loot.vehicle) : this.#canAnalyse(team, loot.set, loot.kind);
  }

  /** Stored captured parts (and [A9-buildings] vehicle wrecks) that can still be analysed */
  analyses(team) {
    return [...(this.teams[team]?.loot.values() ?? [])].filter((l) => this.#lootOpen(team, l));
  }

  /**
   * Cost and time of analysing a captured part (or [A9-buildings] a vehicle wreck): share of its price, time scales
   * with the price; a finished powered archeology station of the team divides the time by its analysisSpeed
   */
  analysisStats(team, loot) {
    const rule = getStats().rules.salvageResearch ?? {};
    let item;
    if (loot.vehicle) item = unitStats('vehicles', loot.vehicle, loot.race ?? this.races[team]);
    else {
      const slot = Object.keys(SLOT_KIND).find((s) => SLOT_KIND[s] === loot.kind);
      item = partStats(loot.path, slot, loot.race);
    }
    const factor = rule.costFactor ?? 1;
    const cost = Object.fromEntries(Object.entries(item.cost ?? {}).map(([r, v]) => [r, Math.round(v * factor)]));
    const price = Object.values(item.cost ?? {}).reduce((a, v) => a + v, 0);
    const base = teamRule(team, 'salvageResearch.researchTime') ?? 0;
    const min = teamRule(team, 'salvageResearch.minResearchTime') ?? 0;
    const ref = rule.referenceCost || price || 1;
    const time = Math.max(min, base * (price / ref)) * researchTimeFactor(this.races[team]) / this.archeologySpeed(team);
    return { cost, buildTime: time };
  }

  /** Analysis finished: the team may produce that part kind (the part is kept – consumesPart false) or that vehicle */
  completeAnalysis(team, loot) {
    const t = this.teams[team];
    t.active.delete(loot.key);
    t.analysed.add(loot.key);
    if (loot.vehicle) this.#unlock(team, VEHICLE_GROUP, loot.vehicle); // [A9-buildings]
    else this.#unlock(team, PART_GROUP, unlockId(loot.set, loot.kind));
    if (getStats().rules.salvageResearch?.consumesPart) t.loot.delete(loot.key);
  }

  // ---------- [A9-buildings] archeology station: faster analysis, vehicle wrecks ----------

  /** Finished powered building of the team with stats.archeology (the best one), or null */
  #archeology(team) {
    let best = null;
    for (const s of this.world.structures) {
      const a = s.stats?.archeology;
      if (!a || s.team !== team || !s.complete || s.dead || s.removed || s.powered === false) continue;
      if (!best || (a.analysisSpeed ?? 1) > (best.analysisSpeed ?? 1)) best = a;
    }
    return best;
  }

  /** Analysis speed of the team (best archeology station's analysisSpeed; 1 without one) */
  archeologySpeed(team) {
    return Math.max(1, this.#archeology(team)?.analysisSpeed ?? 1);
  }

  /**
   * Can the team analyse a wreck of this vehicle? It is exclusive to other factions only, not unlocked yet, and the
   * team's faction can show its model (vehicles[id].races lists the faction or its modelRace; no list = every faction)
   */
  canAnalyseVehicle(team, id) {
    const s = getStats();
    const raw = s.vehicles?.[id];
    const race = this.races[team];
    if (!raw || raw.buildable === false || this.unlocks[team]?.[VEHICLE_GROUP]?.has?.(id)) return false;
    if (raw.races && !raw.races.includes(race) && !raw.races.includes(s.races?.[race]?.modelRace)) return false;
    let owners = 0;
    for (const key in s.races ?? {}) {
      if (!s.races[key].exclusive?.[VEHICLE_GROUP]?.includes(id)) continue;
      if (key === race) return false;
      owners++;
    }
    return owners > 0;
  }

  /**
   * World.update, before destroyed vehicles leave the list: every enemy team with a finished powered archeology station
   * (archeology.vehicleWrecks) that sees the spot gets the wreck as loot (analysable like a captured part). No
   * allocation unless a wreck is stored; teams in ascending order.
   */
  noteDestroyedVehicles(list) {
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.dead || v.wreckNoted) continue;
      v.wreckNoted = true;
      for (let team = 0; team < this.races.length; team++) {
        if (areAllies(team, v.team) || !this.#archeology(team)?.vehicleWrecks) continue;
        if (this.world.fog && !this.world.fog.isPointVisibleTo(team, v.position.x, v.position.z)) continue;
        this.addVehicleLoot(team, v.unitId, v.race);
      }
    }
  }

  /** Stores a vehicle wreck as loot of the team (tests / console); @returns {boolean} newly stored */
  addVehicleLoot(team, id, race = null) {
    const t = this.teams[team];
    const key = Research.vehicleLootKey(id);
    if (!t || t.loot.has(key) || !this.canAnalyseVehicle(team, id)) return false;
    t.loot.set(key, { key, set: null, kind: ARCHEOLOGY.vehicleLootKind, path: null, race, vehicle: id });
    return true;
  }

  static vehicleLootKey(id) {
    let key = vehicleLootKeys.get(id);
    if (key === undefined) { key = `${ARCHEOLOGY.vehicleLootPrefix}${id}`; vehicleLootKeys.set(id, key); }
    return key;
  }

  // ---------- per frame: delivery of captured parts ----------

  /**
   * Delivery: an own mech standing within rules.salvageResearch.deliveryRange of an own finished building
   * listed in deliverTo hands over every mounted part the team cannot make (e.g. an arm picked up from an
   * enemy wreck). The mech keeps the part.
   */
  update(dt) {
    // [A9] Data network: node buildings built / destroyed, alliances (only while some team has the research)
    if (this.networkUsers > 0 && (this.networkTimer -= dt) <= 0) {
      this.networkTimer = RESEARCH_A9.networkCheckInterval;
      if (this.#networkChanged()) this.#syncNetwork();
    }
    if ((this.deliveryTimer -= dt) > 0) return;
    this.deliveryTimer = RESEARCH.deliveryCheckInterval;
    const rule = getStats().rules.salvageResearch;
    // deliverTo + stockOnlyTo + SALVAGE_DROP.stockBuildings: part factory / assembly bay take captured parts as well (loot only)
    const ids = deliveryIds(rule);
    const range = rule?.deliveryRange ?? 0;
    const sites = this.sites; // [B6] reused array (no allocation per check)
    sites.length = 0;
    for (const s of this.world.structures) {
      if (s.complete && !s.dead && !s.removed && ids.includes(s.unitId)) sites.push(s);
    }
    if (!sites.length) return;
    for (const mech of this.world.mechs) {
      if (mech.destroyed || !this.teams[mech.team] || !this.#nearSite(mech, sites, range)) continue;
      for (const slot in mech.parts) {
        const part = mech.parts[slot];
        const st = part.stats;
        if (!part.alive || !st) continue;
        lootScratch.set = st.set; lootScratch.kind = st.kind; lootScratch.path = st.path; lootScratch.race = st.race;
        this.addLoot(mech.team, lootScratch);
      }
    }
    sites.length = 0; // no references to removed buildings kept between checks
  }

  /** [B6] Is an own delivery site within range of the mech? */
  #nearSite(mech, sites, range) {
    for (const s of sites) if (s.team === mech.team && edgeDistance(mech, s) <= range) return true;
    return false;
  }
}
