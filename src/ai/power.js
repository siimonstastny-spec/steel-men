// Steel Mans AI – energy plan (D3, docs/notes/d3-ai-economy.md).
// Planned power of the team: energy income of the power plants it owns (finished, under construction and placements
// waiting for their result) + the HQ, against what every owned consumer (stats.energyUse: production buildings while
// they work, towers always) would draw. Construction asks it before a consumer is placed (a power plant goes first
// when the plan does not cover it); Economy sizes the number of power plants with it (difficulty.power).
import { getStats, unitStats } from '../data/Stats.js';
import { resolveStructure } from './AiData.js';

/**
 * Fills `out` (reused, no allocation): { income, demand, plants, plantsBuilding, plantIncome, plantId, towerUse }
 * income = energy per second the owned plants + HQ give (× noHqIncomeFactor when no HQ is owned at all)
 * demand = energy per second of every owned consumer at full work rate
 */
export function plannedPower(ai, out) {
  const own = ai.perception.own;
  out.income = 0;
  out.demand = 0;
  out.plants = 0;
  out.plantsBuilding = 0;
  out.towerUse = 0; // finished armed consumers: they draw their full energyUse even while switched off (low energy)
  out.plantId = resolveStructure('@power', ai.race, ai.teamUnlocks);
  out.plantIncome = out.plantId ? (unitStats('structures', out.plantId, ai.race, ai.team)?.income?.energy ?? 0) : 0;
  let hq = false;
  for (let i = 0; i < own.structures.length; i++) {
    const s = own.structures[i];
    hq = add(out, s.stats, !s.complete) || hq;
    if (s.complete && s.stats?.weapons?.length) out.towerUse += s.stats.energyUse ?? 0;
  }
  const pending = ai.construction?.pending ?? NO_PENDING;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    if (p.kind !== 'structure' || (p.structure && own.structures.includes(p.structure))) continue;
    hq = add(out, unitStats('structures', p.unitId, ai.race, ai.team), true) || hq;
  }
  if (!hq) out.income *= getStats().rules.economy?.noHqIncomeFactor ?? 1;
  return out;
}

/** Adds one structure to the plan; @returns {boolean} it is an HQ */
function add(out, stats, building) {
  if (!stats) return false;
  const income = stats.income?.energy ?? 0;
  if (income > 0) {
    out.income += income;
    if (!stats.hq) {
      out.plants++;
      if (building) out.plantsBuilding++;
    }
  }
  out.demand += stats.energyUse ?? 0;
  return Boolean(stats.hq);
}

/**
 * Energy per second missing when a consumer drawing `extraUse` is added:
 *   max(demand × coverage, measured) + extraUse − income      (≤ 0 = covered)
 * Production buildings rarely all work at once (ore limits them) – the expected use of the owned ones is the measured
 * demand (Economy avgDemand), at least `coverage` × their full use; the new consumer counts fully (it starts working
 * when finished). `plan` = a plannedPower result of this think.
 */
export function powerGap(plan, extraUse, coverage, measured = 0) {
  return Math.max(plan.demand * coverage, measured) + extraUse - plan.income;
}

const NO_PENDING = Object.freeze([]);
