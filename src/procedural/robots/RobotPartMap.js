// Steel Men – [B6] fallback table: robot part set (stats.json parts.<Set>, = model folder RobotParts<Set>) → procedural part id.
// stats.json `procModel` (when present) wins; this table covers the sets that have no `procModel` there (B6 does not edit
// stats.json). Ids are fixed in docs/notes/b6-common.md. Display only, no simulation use. [A15] Sets removed from
// stats.json are no longer listed (their procedural part files stay until A12; some ids are still procModel of kept sets,
// e.g. 'laserSword' for LaserRipper).

/** set → { legs, torso, arm } procedural part ids (a kind a set does not have is simply absent) */
export const ROBOT_PART_MAP = {
  Basic:         { legs: 'basic', torso: 'basic', arm: 'fist' },
  Armor:         { legs: 'armor', torso: 'armor' },
  Frame:         { legs: 'frame', torso: 'frame', arm: 'frameFist' },
  DrunkMissile:  { legs: 'drunkMissile', torso: 'drunkMissile' },
  HighSpeed:     { legs: 'highSpeed' },
  HighStrength:  { legs: 'heavyLift' },
  HTHupgrade:    { legs: 'hthUpgrade' },
  Laser:         { legs: 'laser' },
  PowerShield:   { legs: 'powerShield' },
  Recon:         { legs: 'recon', torso: 'recon' },
  Camo:          { torso: 'camo' },
  EMP:           { torso: 'emp' },
  Flak:          { torso: 'flak' },
  ForceField:    { torso: 'forceField' },
  Howitzer:      { torso: 'howitzer' },
  JetPack:       { torso: 'jetPack' },
  SelfRepair:    { torso: 'selfRepair' },
  CarpetBomb:    { arm: 'carpetBomb' },
  ElectroGrip:   { arm: 'electroGrip' },
  EnergyShield:  { arm: 'energyShield' },
  GattlingGun:   { arm: 'gattling' },
  HammerHand:    { arm: 'hammerHand' },
  KatanaSword:   { arm: 'katana' },
  PlasmaCannon:  { arm: 'plasmaCannon' },
  Shield:        { arm: 'shield' },
  SniperLaser:   { arm: 'sniperLaser' },
  // [B3] T2 / T3 content sets (stats.json standInSet / standInModel); id = set name with a lower-case first letter
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
