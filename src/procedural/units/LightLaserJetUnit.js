// Steel Mans – procedural light laser jet (roadmap U4). Average multirole jet: diamond fuselage, swept wings, V-tail, two
// beam-style engine nozzles (style flame), one nose laser. Shape table keyed by style.silhouette with only `faceted`
// (others fall back to it).
//   • sockets: muzzle (nose laser), exhaust_1, exhaust_2, aim, smoke
//   • flight: owner calls setMotion(speed, yawRate) and setThrottle(0..1)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 6.2 long, 5.6 span, 2.2 high incl. fins. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → faceted); sizes in model units */
export const LIGHT_LASER_JET_SHAPES = {
  faceted: {
    L: 6.2, W: 1.0, H: 0.8, span: 5.6, rc: 2.0, tc: 0.5, sweep: -0.6, fins: 2, engines: 2,
    engine: { r: 0.22, length: 1.5, spacing: 0.68 },   // spacing = nozzle distance as a share of W
  },
};

const JET = {
  altitude: 1.0, bobAmp: 0.12, bobFreq: 0.4,         // hull height above the model origin, hover-like bob
  wingY: -0.1, wingZ: -0.1,                          // shares of H / L
  finY: 0.3, finZ: -0.38, finH: 0.9, finChord: 1.1, finTilt: 0.5,
  gunY: -0.3, gunZ: 0.3, gunLen: 1.4, gunCal: 0.07,  // nose laser (shares of H / L, model units)
  statusY: 0.5, statusZ: -0.2,
};
const SMOKE_Z = 0.3;   // smoke socket behind the origin (share of L)

const shapeOf = (kit) => LIGHT_LASER_JET_SHAPES[kit.style.silhouette] ?? LIGHT_LASER_JET_SHAPES.faceted;

function buildLightLaserJet(kit) {
  const s = shapeOf(kit);
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L: s.L, W: s.W, H: s.H });
  wings(ub, { bone: 'hull', y: s.H * JET.wingY, z: s.L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  tailFins(ub, { bone: 'hull', y: s.H * JET.finY, z: s.L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  for (let i = 0; i < s.engines; i++) {
    const x = (i - (s.engines - 1) / 2) * s.W * s.engine.spacing;
    exhaust(ub, { parent: 'hull', position: [x, 0, -s.L / 2], r: s.engine.r, length: s.engine.length, index: i + 1 });
  }
  weapon(ub, 'laser', { parent: 'hull', position: [0, s.H * JET.gunY, s.L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, pitch: [0, 0] });
  statusLamp(ub, { parent: 'hull', position: [0, s.H * JET.statusY, s.L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -s.L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildLightLaserJet);

export class LightLaserJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'lightLaserJet', name: 'LightLaserJetUnit' });
  }
}

registerProcUnit('lightLaserJet', (race, teamColor, opts) => new LightLaserJetUnit({ race, teamColor, ...opts }));
