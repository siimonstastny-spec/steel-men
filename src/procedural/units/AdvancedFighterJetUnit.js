// Steel Mans – procedural advanced fighter jet (roadmap U1). Larger multirole fighter: average vs ground and air; TWO engine
// nozzles in side-by-side nacelles, wing pylons with missile pods, nose gun, belly rocket pod. Shape table keyed by
// style.silhouette with only `rounded` (other styles fall back to it).
//   • sockets: muzzle (nose gun), launch_2_1..launch_2_POD_MISSILES (belly pod), muzzle_2, exhaust_1, exhaust_2, aim, smoke
//   • flight: owner calls setMotion(speed, yawRate) and setThrottle(0..1)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 7.6 long, 7.0 span, 2.7 high incl. fins. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → rounded); sizes in model units */
export const ADVANCED_FIGHTER_SHAPES = {
  rounded: {
    L: 7.6, W: 1.6, H: 1.1, span: 7.0, rc: 3.3, tc: 0.9, sweep: 1.8, fins: 2, podMissiles: 4,
    engine: { r: 0.3, length: 1.9, spacing: 0.62 },
  },
};

const JET = {
  altitude: 1.0, bobAmp: 0.12, bobFreq: 0.4,
  wingY: -0.12, wingZ: -0.08,
  finY: 0.3, finZ: -0.4, finH: 1.1, finChord: 1.4, finTilt: 0.5,
  gunY: -0.2, gunZ: 0.3, gunLen: 1.4, gunCal: 0.09,
  podY: -0.62, podZ: 0.0,
  statusY: 0.5, statusZ: -0.15,
  nacelle: { w: 0.9, h: 0.75, l: 0.3, y: -0.05, z: -0.3 },     // shares of W (w), H (h), L (l, z): engine housing box
  // wing pylon (x share of half span; y of H; z of L); podSeg: pod sides, podDrop: pod axis below the pylon centre (share of pylon h), podZ: pod z shift
  pylon: { x: 0.3, w: 0.12, h: 0.22, l: 1.0, y: -0.28, z: -0.05, podR: 0.1, podL: 1.3, podSeg: 6, podDrop: 0.7, podZ: 0.1 },
  engines: 2,
  smokeZ: 0.3,   // smoke socket z share of L (behind the centre)
};
const HALF_PI = Math.PI / 2;

const shapeOf = (kit) => ADVANCED_FIGHTER_SHAPES[kit.style.silhouette] ?? ADVANCED_FIGHTER_SHAPES.rounded;

function buildAdvancedFighter(kit) {
  const s = shapeOf(kit);
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L: s.L, W: s.W, H: s.H });
  wings(ub, { bone: 'hull', y: s.H * JET.wingY, z: s.L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  tailFins(ub, { bone: 'hull', y: s.H * JET.finY, z: s.L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  const hb = ub.paint('hull');
  const N = JET.nacelle;
  hb.box(s.W * N.w, s.H * N.h, s.L * N.l, S.hullDark, { y: s.H * N.y, z: s.L * N.z });
  const P = JET.pylon;
  for (const side of [1, -1]) {
    const x = side * (s.span / 2) * P.x;
    const y = s.H * P.y;
    const z = s.L * P.z;
    hb.box(P.w, s.H * P.h, P.l, S.hullDark, { x, y, z });
    hb.cylinder(P.podR, P.podR, P.podL, P.podSeg, S.frame, { rx: HALF_PI, x, y: y - s.H * P.h * P.podDrop, z: z + P.podZ });
  }
  for (let i = 0; i < JET.engines; i++) {
    const x = (i - (JET.engines - 1) / 2) * s.engine.spacing;
    exhaust(ub, { parent: 'hull', position: [x, 0, -s.L / 2], r: s.engine.r, length: s.engine.length, index: i + 1 });
  }
  weapon(ub, 'gun', { parent: 'hull', position: [0, s.H * JET.gunY, s.L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, pitch: [0, 0] });
  weapon(ub, 'missile', { parent: 'hull', position: [0, s.H * JET.podY, s.L * JET.podZ], count: s.podMissiles, sfx: '_2', pitch: [0, 0] });
  statusLamp(ub, { parent: 'hull', position: [0, s.H * JET.statusY, s.L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -s.L * JET.smokeZ]);
  return ub.build();
}

const CACHE = createUnitCache(buildAdvancedFighter);

export class AdvancedFighterJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'advancedFighterJet', name: 'AdvancedFighterJetUnit' });
  }
}

registerProcUnit('advancedFighterJet', (race, teamColor, opts) => new AdvancedFighterJetUnit({ race, teamColor, ...opts }));
