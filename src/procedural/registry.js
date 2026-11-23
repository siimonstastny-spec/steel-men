// Steel Mans – registry of procedural building models (roadmap 18). Structure.js and the preview ask here whether a
// structure id has a procedural model and create it. A new building registers with one line in
// PROCEDURAL_STRUCTURES (id = stats.json → structures key). Visual only.
import { PROC_BUILDINGS } from '../config.js';
import { VehicleFactoryProc } from './VehicleFactoryProc.js';

export { loadBuildingStyles } from './BuildingStyle.js';

/** structure id → (race, teamColor) => ProcModel */
const PROCEDURAL_STRUCTURES = {
  vehicleFactory: (race, teamColor) => new VehicleFactoryProc({ race, teamColor }),
};

/** Structure ids that have a procedural model */
export const proceduralIds = () => Object.keys(PROCEDURAL_STRUCTURES);

/** Has this structure id a procedural model? */
export const hasProceduralModel = (id) => Object.hasOwn(PROCEDURAL_STRUCTURES, id);

/** Procedural models switched on: PROC_BUILDINGS.enabled, and `window.steelMans.procedural = false` turns them off (comparison) */
export const proceduralEnabled = () => PROC_BUILDINGS.enabled && globalThis.window?.steelMans?.procedural !== false;

/** Should this structure use its procedural model now? */
export const useProceduralModel = (id) => proceduralEnabled() && hasProceduralModel(id);

/** New procedural model for a structure id, or null when there is none (needs loadBuildingStyles() done) */
export function createProceduralStructure(id, race, teamColor) {
  const create = PROCEDURAL_STRUCTURES[id];
  return create ? create(race, teamColor) : null;
}
