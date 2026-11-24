// Steel Men – registers every procedural unit (side-effect imports only: each file calls registerProcUnit).
// No `export *` on purpose: unit files export their own shape tables and must not collide.
// Import this once (main.js / UnitPreview.js) instead of the single unit files.
import './LightTankUnit.js';
import './MediumTankUnit.js';
import './HeavyTankUnit.js';
import './RocketHeavyTankUnit.js';
import './HeavyMissileVehicleUnit.js';
import './MobileArtilleryUnit.js';
import './LightPlasmaTankUnit.js';
import './ElectricTankUnit.js';
import './StealthTankUnit.js';
import './LightMissileHoverUnit.js';
import './LightLaserHoverUnit.js';
import './MediumLaserHoverUnit.js';
import './HeavyLaserHoverUnit.js';
import './TargetingVehicleUnit.js';
import './FighterJetUnit.js';
import './AdvancedFighterJetUnit.js';
import './HeavyFighterJetUnit.js';
import './StealthJetUnit.js';
import './StealthBomberUnit.js';
import './HeavyBomberUnit.js';
import './LightLaserJetUnit.js';
import './LaserHeavyFighterJetUnit.js';
import './HoverTruckUnit.js';
import './DrillTruckUnit.js';
