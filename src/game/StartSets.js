// Steel Men – start sets (ROADMAP 16 / N15a): which buildings, vehicles, mech and crew a team starts with.
// Pure functions over stats.json (rules.economy.startSets / startSetOrder / defaultStartSet, races.<race>.startArm)
// and START_LAYOUT (config.js). No world access and no randomness: the same set + race give the same plan, in a fixed
// creation order (structures, vehicles, mech, crews), so entity ids match on every client of a lockstep match.
// The code knows no faction names; the faction's own arm comes from the data.
import { START_LAYOUT, VICTORY } from '../config.js';
import { startSetLoadout } from './StartLoadouts.js';

const economy = (stats) => stats?.rules?.economy ?? {};

/** Ids of the sets in menu order (only those that have data) */
export function startSetOrder(stats) {
  const sets = economy(stats).startSets ?? {};
  return (economy(stats).startSetOrder ?? Object.keys(sets)).filter((id) => sets[id]);
}

/** Default set id (stats.json defaultStartSet, else the first one in the order) */
export function defaultStartSet(stats) {
  const order = startSetOrder(stats);
  const wanted = economy(stats).defaultStartSet;
  return order.includes(wanted) ? wanted : (order[0] ?? null);
}

/** Valid set id: the id itself, or the default for anything unknown / missing (menu, profile, host message) */
export function validStartSet(id, stats) {
  return startSetOrder(stats).includes(id) ? id : defaultStartSet(stats);
}

/** Raw data of a set (invalid id = the default set), or null when stats.json has none */
export function startSetData(id, stats) {
  return economy(stats).startSets?.[validStartSet(id, stats)] ?? null;
}

/** Does the set start with a main building (a structure whose stats carry VICTORY.mainBuildingFlag)? Read from the data */
export function startSetHasMainBuilding(id, stats) {
  const structures = startSetData(id, stats)?.structures ?? [];
  return structures.some((sid) => stats?.structures?.[sid]?.[VICTORY.mainBuildingFlag]);
}

/** Spot of a unit id: START_LAYOUT[id], else the fallback row (index i, step apart) */
function spotOf(id, i) {
  return START_LAYOUT[id]
    ?? { ...START_LAYOUT.fallback, side: START_LAYOUT.fallback.side + i * START_LAYOUT.fallback.step };
}

/**
 * Plan of a team's start for a set, in creation order. Offsets are relative to the start position
 * (forward / side as START_LAYOUT; main.js converts with startOffset).
 * @param {string} setId   start set id (invalid = default)
 * @param {string} race    stats.json race key
 * @param {object} stats   getStats() result
 * @param {object} catalog loadPartCatalog() result (needed for the mech of set 4; without it the mech is skipped)
 * @returns {{
 *   structures: {id: string, spot: object}[],
 *   vehicles: {id: string, spot: object}[],
 *   mech: {loadout: object, spot: object}|null,
 *   crews: {spot: object, boardMech: boolean}[]
 * }}
 */
export function startSetPlan(setId, race, stats, catalog) {
  const data = startSetData(setId, stats) ?? { structures: [], vehicles: [], mech: null, crew: 0 };
  const loadout = catalog ? startSetLoadout(catalog, race, data.mech, stats?.races?.[race]) : null;
  const crewCount = data.crew ?? 0;
  return {
    structures: (data.structures ?? []).map((id, i) => ({ id, spot: spotOf(id, i) })),
    vehicles: (data.vehicles ?? []).map((id, i) => ({ id, spot: spotOf(id, i) })),
    mech: loadout ? { loadout, spot: START_LAYOUT.startMech } : null,
    // A crew boards the set's mech (the first crew only; extra crews stand at the crew spot)
    crews: Array.from({ length: crewCount }, (_, i) => ({ spot: START_LAYOUT.startCrew, boardMech: i === 0 && Boolean(loadout) })),
  };
}
