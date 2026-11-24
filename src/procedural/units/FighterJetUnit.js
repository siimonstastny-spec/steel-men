// Steel Mans – procedural fighter jet (roadmap U1). Slim air-superiority fighter: strong AA (nose gun + small missile pod
// under the belly), weak against ground, ONE engine nozzle (style flame; the faction look is data-driven). Shape table keyed
// by style.silhouette with only `rounded` (other styles fall back to it).
//   • sockets: muzzle (nose gun), launch_2_1..launch_2_MISSILES (belly pod, fire('launch_2_<i>')), muzzle_2, exhaust_1, aim, smoke
//   • flight: owner calls setMotion(speed, yawRate) (bank into turns, bob) and setThrottle(0..1) (flame length)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 6.4 long, 5.4 span, 2.4 high incl. fin. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → rounded); sizes in model units */
export const FIGHTER_JET_SHAPES = {
  rounded: {
    L: 6.4, W: 1.0, H: 0.95, span: 5.4, rc: 2.4, tc: 0.7, sweep: 1.2, fins: 2, missiles: 2,
    engine: { r: 0.3, length: 1.7 },
  },
};

const JET = {
  altitude: 1.0, bobAmp: 0.12, bobFreq: 0.4,         // hull height above the model origin, hover-like bob
  wingY: -0.1, wingZ: -0.1,                          // shares of H / L
  finY: 0.3, finZ: -0.38, finH: 1.0, finChord: 1.2, finTilt: 0.45,
  gunY: -0.3, gunZ: 0.3, gunLen: 1.3, gunCal: 0.08,  // nose gun (shares of H / L, model units)
  podY: -0.55, podZ: 0.02,                           // belly pod (shares of H / L)
  statusY: 0.5, statusZ: -0.2,
};

const SMOKE_Z = 0.3;   // smoke socket z share of L (behind the centre)

const shapeOf = (kit) => FIGHTER_JET_SHAPES[kit.style.silhouette] ?? FIGHTER_JET_SHAPES.rounded;

function buildFighterJet(kit) {
  const s = shapeOf(kit);
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L: s.L, W: s.W, H: s.H });
  wings(ub, { bone: 'hull', y: s.H * JET.wingY, z: s.L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  tailFins(ub, { bone: 'hull', y: s.H * JET.finY, z: s.L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  exhaust(ub, { parent: 'hull', position: [0, 0, -s.L / 2], r: s.engine.r, length: s.engine.length, index: 1 });
  weapon(ub, 'gun', { parent: 'hull', position: [0, s.H * JET.gunY, s.L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, pitch: [0, 0] });
  weapon(ub, 'missile', { parent: 'hull', position: [0, s.H * JET.podY, s.L * JET.podZ], count: s.missiles, sfx: '_2', pitch: [0, 0] });
  statusLamp(ub, { parent: 'hull', position: [0, s.H * JET.statusY, s.L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -s.L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildFighterJet);

export class FighterJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'fighterJet', name: 'FighterJetUnit' });
  }
}

registerProcUnit('fighterJet', (race, teamColor, opts) => new FighterJetUnit({ race, teamColor, ...opts }));
