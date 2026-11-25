// Steel Men – [B6] fallback table: robot part set (stats.json parts.<Set>, = model folder RobotParts<Set>) → procedural part id.
// stats.json `procModel` (when present) wins; this table covers the sets that have no `procModel` there (B6 does not edit
// stats.json). Ids are fixed in docs/notes/b6-common.md. Set `Alien` has no procedural model. Display only, no simulation use.

/** set → { legs, torso, arm } procedural part ids (a kind a set does not have is simply absent) */
export const ROBOT_PART_MAP = {
  Basic:         { legs: 'basic', torso: 'basic', arm: 'fist' },
  Armor:         { legs: 'armor', torso: 'armor', arm: 'armorFist' },
  Frame:         { legs: 'frame', torso: 'frame', arm: 'frameFist' },
  BlastPulse:    { legs: 'blastPulse' },
  DrunkMissile:  { legs: 'drunkMissile', torso: 'drunkMissile' },
  HighSpeed:     { legs: 'highSpeed' },
  HighStrength:  { legs: 'heavyLift' },
  HTHupgrade:    { legs: 'hthUpgrade' },
  JumpJet:       { legs: 'jumpJet' },
  Laser:         { legs: 'laser' },
  PowerGun:      { legs: 'powerGun' },
  PowerPulse:    { legs: 'powerPulse' },
  PowerShield:   { legs: 'powerShield' },
  Recon:         { legs: 'recon', torso: 'recon' },
  Sonar:         { legs: 'sonar' },
  Steady:        { legs: 'steady' },
  Camo:          { torso: 'camo' },
  EMP:           { torso: 'emp' },
  Flak:          { torso: 'flak' },
  ForceField:    { torso: 'forceField' },
  Howitzer:      { torso: 'howitzer' },
  JetPack:       { torso: 'jetPack' },
  SelfRepair:    { torso: 'selfRepair' },
  Tracer:        { torso: 'tracer' },
  Axe:           { arm: 'axe' },
  BladeArm:      { arm: 'bladeArm' },
  CarpetBomb:    { arm: 'carpetBomb' },
  ElectroGrip:   { arm: 'electroGrip' },
  EnergyBlaster: { arm: 'energyBlaster' },
  EnergyShield:  { arm: 'energyShield' },
  GattlingGun:   { arm: 'gattling' },
  HammerHand:    { arm: 'hammerHand' },
  HomingMissile: { arm: 'homingMissile' },
  KatanaSword:   { arm: 'katana' },
  LaserSword:    { arm: 'laserSword' },
  LongMissile:   { arm: 'longMissile' },
  MultiClaw:     { arm: 'multiClaw' },
  PlasmaCannon:  { arm: 'plasmaCannon' },
  PowerFist:     { arm: 'powerFist' },
  ProtoBlast:    { arm: 'protoBlast' },
  RotaryBlade:   { arm: 'rotaryBlade' },
  Shield:        { arm: 'shield' },
  SniperLaser:   { arm: 'sniperLaser' },
  // [B3] T2 / T3 content sets (stats.json standInSet); id = set name with a lower-case first letter
  IonKatana:       { arm: 'ionKatana' },
  IonPulseGun:     { arm: 'ionPulseGun' },
  HeavyRocketArm:  { arm: 'heavyRocketArm' },
  JetHammer:       { arm: 'jetHammer' },
  ArcRifle:        { arm: 'arcRifle' },
  PlasmaCutter:    { arm: 'plasmaCutter' },
  LaserDisc:       { arm: 'laserDisc' },
  PhotonLauncher:  { arm: 'photonLauncher' },
  SprintLegs:      { legs: 'sprintLegs' },
  PlasmaLegs:      { legs: 'plasmaLegs' },
  LaserShieldLegs: { legs: 'laserShieldLegs' },
  BastionTorso:    { torso: 'bastionTorso' },
};

/**
 * Procedural part id of a part: stats.procModel, else the table, else '' (= not procedural → GLB / letters).
 * @param {string} set   part set ('Basic', 'Flak' …; stats.set / setFromPath(model))
 * @param {'legs'|'torso'|'arm'} kind
 * @param {{procModel?: string}} [stats]
 */
export const procPartId = (set, kind, stats) => stats?.procModel ?? ROBOT_PART_MAP[set]?.[kind] ?? '';
