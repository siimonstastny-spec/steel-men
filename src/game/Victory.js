// Steel Mans – victory conditions. A condition decides whether a team is eliminated; Match.js polls it a few times
// per second. Add a condition by adding an entry here, its id to config.js VICTORY.conditions and the i18n keys
// victory.<id> + victory.<id>.hint (e.g. 'kingOfTheHill' for the super node later).
import { VICTORY } from '../config.js';
import { startSetHasMainBuilding } from './StartSets.js';

const isLive = (u) => !u.destroyed && !u.dead && !u.removed;

/** Buildings that keep a team alive */
const teamStructures = (world, team) => world.structures.filter((s) =>
  s.team === team && isLive(s) && (VICTORY.countUnfinishedBuildings || s.complete));

/** Robots and armed vehicles of a team (a crew without a robot does not count) */
export function teamCombatUnits(world, team) {
  const mechs = world.mechs.filter((m) => m.team === team && isLive(m) && (VICTORY.crewlessMechsCount || m.crew));
  const vehicles = world.vehicles.filter((v) => v.team === team && isLive(v)
    && (v.stats?.weapons?.length ?? 0) >= VICTORY.combatVehicleMinWeapons);
  return [...mechs, ...vehicles];
}

/** Does the team still own a unit that can construct (stats abilities 'construct')? It can rebuild a main building (start set 1) */
export function teamHasBuilder(world, team) {
  return world.vehicles.some((v) => v.team === team && isLive(v) && v.canConstruct);
}

/** id -> { isEliminated(world, team) } */
export const CONDITIONS = {
  // Destruction: a team without buildings, without combat units and (VICTORY.builderKeepsAlive) without a builder loses
  destruction: {
    isEliminated: (world, team) => teamStructures(world, team).length === 0 && teamCombatUnits(world, team).length === 0
      && !(VICTORY.builderKeepsAlive && teamHasBuilder(world, team)),
  },
  // Main building: a team that lost all its main buildings (stats.json hq: true, the Matter converter) loses
  mainBuilding: {
    needsMainBuilding: true, // not offered for a start set without a main building (everybody would lose at once)
    isEliminated: (world, team) => !teamStructures(world, team).some((s) => s.stats?.[VICTORY.mainBuildingFlag]),
  },
};

/** A saved / unknown id falls back to the default condition */
export const validCondition = (id) => (VICTORY.conditions.includes(id) && CONDITIONS[id] ? id : VICTORY.defaultCondition);

/** Can the condition be played with this start set? (a main-building condition needs a set that starts with one) */
export const conditionAllowed = (id, startSetId, stats) =>
  !CONDITIONS[id]?.needsMainBuilding || startSetHasMainBuilding(startSetId, stats);

/** Valid condition for the start set: a condition the set cannot play falls back to the default one */
export const validConditionForSet = (id, startSetId, stats) => {
  const valid = validCondition(id);
  return conditionAllowed(valid, startSetId, stats) ? valid : VICTORY.defaultCondition;
};
