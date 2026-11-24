// Steel Men – research of every team (stats.json → research, rules.research, rules.salvageResearch).
// The code knows no research ids or factions, everything comes from the data:
//   • which research a team sees: races[*].exclusive.research (canProduce 'research'), common ones for all
//   • tiers: rules.research.tiers[tier] { requiresStructures, requiresCompleted { tier, count } }
//   • effects of completed research: 'modify' (stats, applied by Stats.js per team), 'rule' (Stats.teamRule),
//     'unlock' (production); items with requiresResearch are unlocked once all their research is done
//   • salvage analysis: a captured part the team cannot make, brought to a research facility, can be analysed
//     there; it unlocks production of that part kind (not the whole set) and is not used up
// Research belongs to one team only (no sharing with allies). Queueing / paying / completion is driven by
// world.production (src/game/Production.js, commands 'queueResearch' / 'queueAnalysis'); ResearchView only shows it.
import { getStats, canProduce, unlockId, setResearchEffects, researchTimeFactor, teamRule, partStats, SLOT_KIND } from '../data/Stats.js';
import { RESEARCH, SALVAGE_DROP } from '../config.js';
import { edgeDistance } from './Combat.js';

const PART_GROUP = 'partSets';   // exclusive group / unlock group of robot parts
const RESEARCH_GROUP = 'research';
// stats.json section -> unlock group, for items unlocked by requiresResearch
const LOCKABLE = { parts: PART_GROUP, vehicles: 'vehicles', structures: 'structures' };
// [B6] building ids that take a mech's captured parts, recomputed only when the rules object changes (like
// Vehicle.dropOffCache) – no arrays / closures per delivery check
const NO_RULE = Symbol('noRule'); // [B6 QA] never equal to a rules object (or its absence), so the first call fills the cache
const deliveryCache = { rule: NO_RULE, ids: [] };
const lootKeys = new Map(); // [B6 QA] set -> Map(kind -> loot key): no template string per part per check
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
    races.forEach((_, team) => setResearchEffects(team, [])); // a new game starts without research
  }

  get defs() { return getStats().research ?? {}; }

  // ---------- research list and locks ----------

  /** Research ids this team's faction may research (data order) */
  available(team) {
    return Object.keys(this.defs).filter((id) => canProduce(this.races[team], RESEARCH_GROUP, id, this.unlocks[team]));
  }

  /** Tier numbers that exist in rules.research.tiers or in the research list, ascending */
  tiers() {
    const fromRules = Object.keys(getStats().rules.research?.tiers ?? {}).map(Number);
    const fromList = Object.values(this.defs).map((d) => d.tier);
    return [...new Set([...fromRules, ...fromList])].filter(Number.isFinite).sort((a, b) => a - b);
  }

  isDone(team, id) { return this.teams[team]?.completed.has(id) ?? false; }

  /** Completed research of one tier */
  doneInTier(team, tier) {
    return [...(this.teams[team]?.completed ?? [])].filter((id) => this.defs[id]?.tier === tier).length;
  }

  /**
   * Is a tier open for the team? @returns {{ open, missing: [{ type: 'structure', id } | { type: 'completed', tier, count, have }] }}
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
    return { open: missing.length === 0, missing };
  }

  /** Starting research of tier N grants tier N (buildings with requiresTier <= N); researching more still needs the facility */
  grantTier(team, tier) {
    if (Number.isFinite(tier) && tier > (this.grantedTier[team] ?? 0)) this.grantedTier[team] = tier;
  }

  /** Highest tier currently open (0 = none): max of the computed one and the granted one */
  openTier(team) {
    let best = this.grantedTier[team] ?? 0;
    for (const tier of this.tiers()) if (tier > best && this.tierStatus(team, tier).open) best = tier;
    return best;
  }

  /** Other research this one needs (research.requiresResearch) that is not done yet */
  missingResearch(team, id) {
    return (this.defs[id]?.requiresResearch ?? []).filter((r) => !this.isDone(team, r));
  }

  /** Can the team queue this research now? @returns {{ ok, reason, tier }} reason: 'done' | 'active' | 'tier' | 'research' */
  status(team, id) {
    const def = this.defs[id];
    if (this.isDone(team, id)) return { ok: false, reason: 'done' };
    if (this.teams[team].active.has(id)) return { ok: false, reason: 'active' };
    const tier = this.tierStatus(team, def.tier);
    if (!tier.open) return { ok: false, reason: 'tier', tier };
    if (this.missingResearch(team, id).length) return { ok: false, reason: 'research' };
    return { ok: true };
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
      if ((needs ?? []).every((r) => t.completed.has(r))) this.#unlock(team, u.group, unlockId(u.id, u.sub));
    }
    this.#applyEffects(team);
  }

  #applyEffects(team) {
    const effects = [...this.teams[team].completed].flatMap((id) => this.defs[id]?.effects ?? []);
    setResearchEffects(team, effects);
    for (const unit of this.world.allUnits) if (unit.team === team) unit.applyResearch?.();
  }

  #unlock(team, group, key) {
    const u = this.unlocks[team];
    if (!u) return;
    u[group] ??= new Set();
    u[group].add(key);
  }

  #hasStructure(team, id) {
    return this.world.structures.some((s) => s.team === team && s.unitId === id && s.complete && !s.destroyed);
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

  /** Stored captured parts that can still be analysed */
  analyses(team) {
    return [...(this.teams[team]?.loot.values() ?? [])].filter((l) => this.#canAnalyse(team, l.set, l.kind));
  }

  /** Cost and time of analysing a captured part: share of its price, time scales with the price */
  analysisStats(team, loot) {
    const rule = getStats().rules.salvageResearch ?? {};
    const slot = Object.keys(SLOT_KIND).find((s) => SLOT_KIND[s] === loot.kind);
    const part = partStats(loot.path, slot, loot.race);
    const factor = rule.costFactor ?? 1;
    const cost = Object.fromEntries(Object.entries(part.cost ?? {}).map(([r, v]) => [r, Math.round(v * factor)]));
    const price = Object.values(part.cost ?? {}).reduce((a, v) => a + v, 0);
    const base = teamRule(team, 'salvageResearch.researchTime') ?? 0;
    const min = teamRule(team, 'salvageResearch.minResearchTime') ?? 0;
    const ref = rule.referenceCost || price || 1;
    const time = Math.max(min, base * (price / ref)) * researchTimeFactor(this.races[team]);
    return { cost, buildTime: time };
  }

  /** Analysis finished: the team may produce that part kind (the part is kept – consumesPart false) */
  completeAnalysis(team, loot) {
    const t = this.teams[team];
    t.active.delete(loot.key);
    t.analysed.add(loot.key);
    this.#unlock(team, PART_GROUP, unlockId(loot.set, loot.kind));
    if (getStats().rules.salvageResearch?.consumesPart) t.loot.delete(loot.key);
  }

  // ---------- per frame: delivery of captured parts ----------

  /**
   * Delivery: an own mech standing within rules.salvageResearch.deliveryRange of an own finished building
   * listed in deliverTo hands over every mounted part the team cannot make (e.g. an arm picked up from an
   * enemy wreck). The mech keeps the part.
   */
  update(dt) {
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
