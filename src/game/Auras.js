// Steel Men – auras of enhancer buildings, target designation and building self-repair (simulation, deterministic).
//
// Auras (stats.json structures[*].aura { type, radius, value[, productionValue] }, read through unitStats so research
// applies): a finished, powered, standing building gives its aura to units / buildings of its own team and of allies
// whose team and the source team are both Data network nodes (world.research.nodes). Types:
//   damageDealt  → unit.auraDealt   (+share of damage dealt; Combat.applyHit / dealDamage)
//   damageTaken  → unit.auraTaken   (share of damage taken, negative = less; units and buildings)
//   sightRange   → unit.auraSight   (+share of sight range, units only; FogOfWar)
//   construction → unit.auraBuild   (+share of construction / repair speed of buildings; Construction, Repair)
//                  unit.auraProd    (+productionValue share of production speed in buildings; Production)
// The same type never adds up: the strongest value (largest |value|) wins, so the result does not depend on order.
// Distance = from the unit's centre to the source's footprint box (Combat.edgeDistance).
// Target designation: a unit with stats.designationRange marks enemies within that range for its alliance
// (unit.designatedBy bit mask, Combat.hitChance adds rules.auras.designationAccuracy).
// Self-repair: finished buildings regain rules.repair.structureSelfRepair (team rule, research) × max HP per second.
// Everything is recomputed every AURAS.recomputeTicks ticks (tick modulo – same ticks on every client), no allocation.
import { getStats, teamRule } from '../data/Stats.js';
import { AURAS, SIM, STEALTH } from '../config.js';
import { edgeDistance } from './Combat.js';
import { areAllies, allianceLeader } from './Alliances.js';

/** Unit field per aura type (bonus share, 0 = none) */
const FIELD = { damageDealt: 'auraDealt', damageTaken: 'auraTaken', sightRange: 'auraSight', construction: 'auraBuild' };
const BONUS = { auraDealt: 0, auraTaken: 0, auraSight: 0, auraBuild: 0, auraProd: 0, designated: false }; // bonusesOf result (reused)

/** Bonus share of a unit (0 when it has none) – cheap readers for Combat / FogOfWar / Production */
export const dealtFactor = (unit) => 1 + (unit?.auraDealt ?? 0);
export const takenFactor = (unit) => Math.max(0, 1 + (unit?.auraTaken ?? 0));
export const sightFactor = (unit) => 1 + (unit?.auraSight ?? 0);
export const buildFactor = (structure) => 1 + (structure?.auraBuild ?? 0);
export const productionFactor = (structure) => 1 + (structure?.auraProd ?? 0);
/** Is `unit` designated for the alliance of `team`? */
export const isDesignatedFor = (unit, team) => ((unit?.designatedBy ?? 0) & teamBit(team)) !== 0;
export const teamBit = (team) => (Number.isInteger(team) && team >= 0 ? 1 << (allianceLeader(team) % AURAS.maxTeams) : 0);

export class Auras {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    this.sources = [];          // aura buildings of the current recompute (reused, cleared after it)
    this.designators = [];      // units with designationRange (reused, cleared after it)
    this.selfRepair = [];       // team -> rules.repair.structureSelfRepair (refreshed every AURAS.ruleRefreshTicks)
    this.ruleTick = -Infinity;
  }

  /** Called every tick from World.update (after Economy: structure.powered is fresh) */
  update() {
    const tick = this.world.tick;
    if (tick % AURAS.recomputeTicks !== 0) return;
    if (tick - this.ruleTick >= AURAS.ruleRefreshTicks || tick < this.ruleTick) this.#refreshRules(tick);
    this.recompute();
    this.#selfRepair(AURAS.recomputeTicks / SIM.tickRate);
  }

  /** Recomputes every unit's aura fields and designation marks now (tests may call it directly) */
  recompute() {
    const w = this.world;
    const sources = this.sources;
    const designators = this.designators;
    sources.length = 0;
    designators.length = 0;
    for (const s of w.structures) if (this.isActive(s)) sources.push(s);
    for (const v of w.vehicles) if (!v.dead && !v.removed && (v.stats?.[STEALTH.designationStat] ?? 0) > 0) designators.push(v);
    this.#apply(w.mechs, false);
    this.#apply(w.crews, false);
    this.#apply(w.vehicles, false);
    this.#apply(w.structures, true);
    sources.length = 0; // no references to removed buildings kept between recomputes
    designators.length = 0;
  }

  /** Does this building give its aura right now? (finished, standing, powered, has stats.aura) */
  isActive(s) {
    return Boolean(s?.isStructure && s.stats?.aura && s.complete && !s.dead && !s.removed && s.powered !== false);
  }

  /**
   * Aura of a building for the UI (F4a): { type, radius, value, productionValue, active } or null. Shared object –
   * read it at once.
   */
  auraOf(structure) {
    const a = structure?.stats?.aura;
    if (!a) return null;
    AURA_INFO.type = a.type; AURA_INFO.radius = a.radius ?? 0; AURA_INFO.value = a.value ?? 0;
    AURA_INFO.productionValue = a.productionValue ?? 0; AURA_INFO.active = this.isActive(structure);
    return AURA_INFO;
  }

  /** Aura bonuses a unit has now (UI): shared object { auraDealt, auraTaken, auraSight, auraBuild, auraProd, designated } */
  bonusesOf(unit, viewerTeam = null) {
    BONUS.auraDealt = unit?.auraDealt ?? 0; BONUS.auraTaken = unit?.auraTaken ?? 0; BONUS.auraSight = unit?.auraSight ?? 0;
    BONUS.auraBuild = unit?.auraBuild ?? 0; BONUS.auraProd = unit?.auraProd ?? 0;
    BONUS.designated = viewerTeam === null ? (unit?.designatedBy ?? 0) !== 0 : isDesignatedFor(unit, viewerTeam);
    return BONUS;
  }

  dispose() {
    this.sources.length = 0;
    this.designators.length = 0;
  }

  // ---------- internal ----------

  #refreshRules(tick) {
    this.ruleTick = tick;
    const n = this.world.economy?.races?.length ?? this.world.research?.races?.length ?? 0;
    this.selfRepair.length = n;
    for (let team = 0; team < n; team++) this.selfRepair[team] = teamRule(team, 'repair.structureSelfRepair') ?? 0;
  }

  // Aura fields of one unit list (buildings: isStructure true)
  #apply(list, isStructure) {
    const sources = this.sources;
    const designators = this.designators;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      u.auraDealt = 0; u.auraTaken = 0; u.auraSight = 0; u.auraBuild = 0; u.auraProd = 0; u.designatedBy = 0;
      if (u.destroyed || u.removed || u.inside || !Number.isInteger(u.team)) continue;
      for (let k = 0; k < sources.length; k++) {
        const src = sources[k];
        if (src === u || !this.#reaches(src, u)) continue;
        const a = src.stats.aura;
        const type = a.type;
        if (isStructure ? AURAS.unitOnlyTypes.includes(type) : AURAS.structureOnlyTypes.includes(type)) continue;
        if (edgeDistance(u, src) > (a.radius ?? 0)) continue;
        const field = FIELD[type];
        if (field && Math.abs(a.value ?? 0) > Math.abs(u[field])) u[field] = a.value ?? 0;
        if (type === 'construction' && (a.productionValue ?? 0) > u.auraProd) u.auraProd = a.productionValue;
      }
      for (let k = 0; k < designators.length; k++) {
        const d = designators[k];
        if (areAllies(d.team, u.team)) continue;
        const range = d.stats[STEALTH.designationStat];
        const dx = u.position.x - d.position.x;
        const dz = u.position.z - d.position.z;
        if (dx * dx + dz * dz <= range * range) u.designatedBy |= teamBit(d.team);
      }
    }
  }

  // Own team always; an ally only when both teams are Data network nodes (Research.nodes, state of its last check)
  #reaches(src, u) {
    if (src.team === u.team) return true;
    if (!areAllies(src.team, u.team)) return false;
    const nodes = this.world.research?.nodes;
    return Boolean(nodes && nodes[src.team] === 1 && nodes[u.team] === 1);
  }

  // Finished buildings regain structureSelfRepair × max HP per second (team rule, e.g. nanoRepair research)
  #selfRepair(seconds) {
    const rates = this.selfRepair;
    for (const s of this.world.structures) {
      const rate = rates[s.team] ?? 0;
      if (rate <= 0 || !s.complete || s.dead || s.removed || !(s.hp < s.maxHp)) continue;
      s.hp = Math.min(s.maxHp, s.hp + s.maxHp * rate * seconds);
    }
  }
}

const AURA_INFO = { type: null, radius: 0, value: 0, productionValue: 0, active: false }; // auraOf result (reused)

/** rules.auras value (stats.json) */
export const auraRule = (key) => getStats().rules.auras?.[key] ?? 0;
