// Steel Men – registry of procedural building models (roadmap 18). Structure.js and the preview ask here whether a
// structure id has a procedural model and create it. A new building registers with one line in
// PROCEDURAL_STRUCTURES (id = stats.json → structures key). Visual only.
import { PROC_BUILDINGS } from '../config.js';
import { VehicleFactoryProc } from './VehicleFactoryProc.js';
import { MatterConverterProc } from './MatterConverterProc.js';
import { ResearchFacilityProc } from './ResearchFacilityProc.js';
import { SolarPanelProc } from './SolarPanelProc.js';
import { RobotPartFactoryProc } from './RobotPartFactoryProc.js';
import { RobotAssemblyBayProc } from './RobotAssemblyBayProc.js';
import { CryoFarmProc } from './CryoFarmProc.js';
import { CrewTrainingFacilityProc } from './CrewTrainingFacilityProc.js';
import { AircraftHangarProc } from './AircraftHangarProc.js';
import { EnergyBankProc } from './EnergyBankProc.js';
import { AdvancedResearchFacilityProc } from './AdvancedResearchFacilityProc.js';
import { PointDefenseProc } from './PointDefenseProc.js';
import { AaTurretProc } from './AaTurretProc.js';
import { RailGunProc } from './RailGunProc.js';
import { OutpostProc } from './OutpostProc.js';
import { ReconTowerProc } from './ReconTowerProc.js';
import { PowerGeneratorProc } from './PowerGeneratorProc.js';
import { OreDeepExtractorProc } from './OreDeepExtractorProc.js';
import { MobileWallProc } from './MobileWallProc.js';
import { WallSegmentProc } from './WallSegmentProc.js';
import { MobileWallGunTurretProc, MobileWallLaserTurretProc } from './WallTurretProc.js';
import { WallGateProc } from './WallGateProc.js';
import { CrewQuartersProc } from './CrewQuartersProc.js';
// [B3] research T2/T3 buildings
import { OrbitalBombProc } from './OrbitalBombProc.js';
import { TectonicTorpedoProc } from './TectonicTorpedoProc.js';
import { PhaseChargeProc } from './PhaseChargeProc.js';
import { NeutronBombProc } from './NeutronBombProc.js';
import { AttackEnhancerProc } from './AttackEnhancerProc.js';
import { DefenseEnhancerProc } from './DefenseEnhancerProc.js';
import { ReconEnhancerProc } from './ReconEnhancerProc.js';
import { ConstructionEnhancerProc } from './ConstructionEnhancerProc.js';
import { ImagingPoleProc } from './ImagingPoleProc.js';
import { ArcheologyStationProc } from './ArcheologyStationProc.js';

export { loadBuildingStyles } from './BuildingStyle.js';

/** structure id → (race, teamColor) => ProcModel */
const PROCEDURAL_STRUCTURES = {
  vehicleFactory: (race, teamColor) => new VehicleFactoryProc({ race, teamColor }),
  matterConverter: (race, teamColor) => new MatterConverterProc({ race, teamColor }),
  researchFacility: (race, teamColor) => new ResearchFacilityProc({ race, teamColor }),
  solarPanel: (race, teamColor) => new SolarPanelProc({ race, teamColor }),
  robotPartFactory: (race, teamColor) => new RobotPartFactoryProc({ race, teamColor }),
  robotAssemblyBay: (race, teamColor) => new RobotAssemblyBayProc({ race, teamColor }),
  cryoFarm: (race, teamColor) => new CryoFarmProc({ race, teamColor }),
  crewTrainingFacility: (race, teamColor) => new CrewTrainingFacilityProc({ race, teamColor }),
  aircraftHangar: (race, teamColor) => new AircraftHangarProc({ race, teamColor }),
  energyBank: (race, teamColor) => new EnergyBankProc({ race, teamColor }),
  advancedResearchFacility: (race, teamColor) => new AdvancedResearchFacilityProc({ race, teamColor }),
  pointDefenseSystem: (race, teamColor) => new PointDefenseProc({ race, teamColor }),
  aaTurret: (race, teamColor) => new AaTurretProc({ race, teamColor }),
  railGun: (race, teamColor) => new RailGunProc({ race, teamColor }),
  outpost: (race, teamColor) => new OutpostProc({ race, teamColor }),
  reconTower: (race, teamColor) => new ReconTowerProc({ race, teamColor }),
  powerGenerator: (race, teamColor) => new PowerGeneratorProc({ race, teamColor }),
  oreDeepExtractor: (race, teamColor) => new OreDeepExtractorProc({ race, teamColor }),
  mobileWall: (race, teamColor) => new MobileWallProc({ race, teamColor }),
  mobileWallSegment: (race, teamColor) => new WallSegmentProc({ race, teamColor }),
  mobileWallGunTurret: (race, teamColor) => new MobileWallGunTurretProc({ race, teamColor }),
  mobileWallLaserTurret: (race, teamColor) => new MobileWallLaserTurretProc({ race, teamColor }),
  wallGate: (race, teamColor) => new WallGateProc({ race, teamColor }),
  crewQuarters: (race, teamColor) => new CrewQuartersProc({ race, teamColor }),
  orbitalBomb: (race, teamColor) => new OrbitalBombProc({ race, teamColor }),
  tectonicTorpedo: (race, teamColor) => new TectonicTorpedoProc({ race, teamColor }),
  phaseCharge: (race, teamColor) => new PhaseChargeProc({ race, teamColor }),
  neutronBomb: (race, teamColor) => new NeutronBombProc({ race, teamColor }),
  attackEnhancer: (race, teamColor) => new AttackEnhancerProc({ race, teamColor }),
  defenseEnhancer: (race, teamColor) => new DefenseEnhancerProc({ race, teamColor }),
  reconEnhancer: (race, teamColor) => new ReconEnhancerProc({ race, teamColor }),
  constructionEnhancer: (race, teamColor) => new ConstructionEnhancerProc({ race, teamColor }),
  imagingPole: (race, teamColor) => new ImagingPoleProc({ race, teamColor }),
  archeologyStation: (race, teamColor) => new ArcheologyStationProc({ race, teamColor }),
};

/** Structure ids that have a procedural model */
export const proceduralIds = () => Object.keys(PROCEDURAL_STRUCTURES);

/** Has this structure id a procedural model? */
export const hasProceduralModel = (id) => Object.hasOwn(PROCEDURAL_STRUCTURES, id);

/** Procedural models switched on: PROC_BUILDINGS.enabled, and `window.steelMen.procedural = false` turns them off (comparison) */
export const proceduralEnabled = () => PROC_BUILDINGS.enabled && globalThis.window?.steelMen?.procedural !== false;

/** Should this structure use its procedural model now? */
export const useProceduralModel = (id) => proceduralEnabled() && hasProceduralModel(id);

/** New procedural model for a structure id, or null when there is none (needs loadBuildingStyles() done) */
export function createProceduralStructure(id, race, teamColor) {
  const create = PROCEDURAL_STRUCTURES[id];
  return create ? create(race, teamColor) : null;
}
