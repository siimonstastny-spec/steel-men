// Steel Mans – procedural laser heavy fighter jet (roadmap U4). Bigger and stronger than the light laser jet: broad
// fuselage, long swept wings with emitter pods on pylons, three beam-style nozzles, twin nose lasers. Shape table keyed
// by style.silhouette with only `faceted` (others fall back to it).
//   • sockets: muzzle, muzzle_2 (twin laser, fire('muzzle_2')), exhaust_1..3, aim, smoke
//   • flight: owner calls setMotion(speed, yawRate) and setThrottle(0..1)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 8.0 long, 7.8 span, 2.7 high incl. fins. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → faceted); sizes in model units */
export const LASER_HEAVY_FIGHTER_SHAPES = {
  faceted: {
    L: 8.0, W: 1.6, H: 1.1, span: 7.8, rc: 3.0, tc: 0.7, sweep: -0.8, fins: 2, engines: 3,
    engine: { r: 0.26, length: 1.8, spacing: 0.55 },   // spacing = share of W
  },
};

const JET = {
  altitude: 1.0, bobAmp: 0.1, bobFreq: 0.35,
  wingY: -0.1, wingZ: -0.1,
  finY: 0.3, finZ: -0.38, finH: 1.2, finChord: 1.5, finTilt: 0.5,
  gunY: -0.3, gunX: 0.2, gunZ: 0.28, gunLen: 1.6, gunCal: 0.08,   // twin nose lasers: x share of W
  statusY: 0.5, statusZ: -0.2,
};
const SMOKE_Z = 0.3;        // smoke socket behind the origin (share of L)
const SECOND_RINGS = 1;     // barrel rings of the second nose laser
const POD = { x: 0.32, y: -0.2, z: 0.0, w: 0.22, h: 0.22, d: 1.1, glowR: 0.09, glowOut: 0.05 };   // wing emitter pods: x share of span (each side), z offset of the wing chord centre

const shapeOf = (kit) => LASER_HEAVY_FIGHTER_SHAPES[kit.style.silhouette] ?? LASER_HEAVY_FIGHTER_SHAPES.faceted;

function buildLaserHeavyFighter(kit) {
  const s = shapeOf(kit);
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L: s.L, W: s.W, H: s.H });
  wings(ub, { bone: 'hull', y: s.H * JET.wingY, z: s.L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  tailFins(ub, { bone: 'hull', y: s.H * JET.finY, z: s.L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  for (const side of [1, -1]) {
    const px = side * s.span * POD.x;
    const py = s.H * JET.wingY + POD.y;
    const pz = s.L * JET.wingZ + POD.z;
    hb.box(POD.w, POD.h, POD.d, S.hullDark, { x: px, y: py, z: pz });
    hg.point([px, py, pz + POD.d / 2 + POD.glowOut], POD.glowR, ub.style.weaponGlow, {});
  }
  for (let i = 0; i < s.engines; i++) {
    const x = (i - (s.engines - 1) / 2) * s.W * s.engine.spacing;
    exhaust(ub, { parent: 'hull', position: [x, 0, -s.L / 2], r: s.engine.r, length: s.engine.length, index: i + 1 });
  }
  const gx = s.W * JET.gunX;
  weapon(ub, 'laser', { parent: 'hull', position: [gx, s.H * JET.gunY, s.L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, pitch: [0, 0] });
  weapon(ub, 'laser', { parent: 'hull', position: [-gx, s.H * JET.gunY, s.L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, sfx: '_2', pitch: [0, 0], rings: SECOND_RINGS });
  statusLamp(ub, { parent: 'hull', position: [0, s.H * JET.statusY, s.L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -s.L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildLaserHeavyFighter);

export class LaserHeavyFighterJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'laserHeavyFighterJet', name: 'LaserHeavyFighterJetUnit' });
  }
}

registerProcUnit('laserHeavyFighterJet', (race, teamColor, opts) => new LaserHeavyFighterJetUnit({ race, teamColor, ...opts }));
