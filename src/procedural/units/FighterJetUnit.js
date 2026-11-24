// Steel Men – procedural fighter jet (roadmap U1). Slim air-superiority fighter: strong AA (nose gun + small missile pod
// under the belly), weak against ground, ONE engine nozzle (style flame; the faction look is data-driven). Shape table keyed
// by style.silhouette with only `rounded` (other styles fall back to it).
//   • sockets: muzzle (nose gun), launch_2_1..launch_2_MISSILES (belly pod, fire('launch_2_<i>')), muzzle_2, exhaust_1, aim, smoke
//   • flight: owner calls setMotion(speed, yawRate) (bank into turns, bob) and setThrottle(0..1) (flame length)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 6.4 long, 5.4 span, 2.4 high incl. fin. Visual only.
import * as THREE from 'three';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { fuselage, wings, exhaust, weapon, statusLamp, roofMark, UNIT_MODULES } from './UnitModules.js';

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

// team colour (top-down readable): fuselage top by style.silhouette, V-tail fins painted, a mark on each wing tip.
// rounded / round: cap = polar angle (rad) of a sphere segment laid over the fuselage top (offset CAP_OFFSET model units off the body, no z-fighting), seg = its [width, height] segments
// angular: roofMark on the flat top plate (shares of W, L, L); faceted: strakes on the two upper faces (shares of the face width / L, z share of L, L share)
const FUSELAGE_TEAM = {
  rounded: { cap: 0.7, seg: [12, 2] },
  round: { cap: 0.7, seg: [12, 2] },
  angular: { w: 0.65, d: 0.4, z: -0.2 },
  faceted: { share: 0.6, z: -0.18, l: 0.24 },
};
// wing tip marks (roofMark) – outside the emblem, not on the crescent wing: x share of the half span, w share of the half span, d share of the tip chord
const WING_MARK = { x: 0.88, w: 0.24, d: 0.75, tipZ: 0.45 };   // tipZ: centre z = tip leading edge − tipZ × tip chord
const CAP_OFFSET = 0.03;   // absolute offset of the fuselage cap from the body (model units; >= other team plates, no flicker on slim fuselages)
const WING_MARK_TIP_FACETED = 0.6;   // tipZ for the faceted wing (its swept-forward tip edge would be overhung at 0.45)

const shapeOf = (kit) => FIGHTER_JET_SHAPES[kit.style.silhouette] ?? FIGHTER_JET_SHAPES.rounded;

/** V-tail / single fin in the team colour (same planform as UnitModules.tailFins) */
function teamFins(ub, { y, z, h, chord, count, tilt }) {
  const F = UNIT_MODULES.fin;
  const b = ub.paint('hull');
  for (let i = 0; i < count; i++) {
    const rz = count === 1 ? 0 : (i ? -tilt : tilt);
    const shape = new THREE.Shape();
    shape.moveTo(0, chord / 2);
    shape.lineTo(h, chord * F.tipFront);
    shape.lineTo(h, chord * F.tipBack);
    shape.lineTo(0, -chord / 2);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: F.thick, bevelEnabled: false });
    geo.translate(0, 0, -F.thick / 2);
    geo.rotateX(Math.PI / 2);
    geo.rotateZ(Math.PI / 2);
    b.add(geo, ub.kit.S.teamPaint, { y, z, rz, detail: UNIT_KIT.teamPaint.lod.panel });
  }
}

function teamFuselage(ub, s) {
  const sil = ub.kit.style.silhouette;
  const T = FUSELAGE_TEAM[sil] ?? FUSELAGE_TEAM.rounded;
  const b = ub.paint('hull');
  const S = ub.kit.S;
  const lod = UNIT_KIT.teamPaint.lod.panel;
  if (sil === 'angular') {
    roofMark(ub, 'hull', { y: s.H / 2, z: s.L * T.z, w: s.W * T.w, d: s.L * T.d });
  } else if (sil === 'faceted') {
    const hb = s.H / 2;
    const beta = Math.atan2(hb, s.W / 2);
    const faceW = Math.hypot(s.W / 2, hb);
    const d = UNIT_KIT.teamPaint.panel.depth;
    for (const side of [1, -1]) {
      b.box(faceW * T.share, d, s.L * T.l, S.teamPaint, {
        rz: -side * beta, x: side * (s.W / 4 + Math.sin(beta) * d / 2), y: hb / 2 + Math.cos(beta) * d / 2, z: s.L * T.z, detail: lod,
      });
    }
  } else {
    b.add(new THREE.SphereGeometry(1, T.seg[0], T.seg[1], 0, Math.PI * 2, 0, T.cap), S.teamPaint, {
      sx: s.W / 2 + CAP_OFFSET, sy: s.H / 2 + CAP_OFFSET, sz: s.L / 2 + CAP_OFFSET, detail: lod,
    });
  }
}

function teamWingTips(ub, s) {
  const sil = ub.kit.style.silhouette;
  if (sil === 'round') return;
  const tipF = s.rc / 2 - s.sweep;   // tip leading edge z (rounded / angular), relative to the wing root centre
  const lead = sil === 'faceted' ? tipF + s.sweep * UNIT_MODULES.wing.faceted.tipSweep : tipF;
  const half = s.span / 2;
  const y = s.H * JET.wingY + UNIT_MODULES.wing.thick / 2;
  for (const side of [1, -1]) {
    roofMark(ub, 'hull', { x: side * half * WING_MARK.x, y, z: s.L * JET.wingZ + lead - s.tc * (sil === 'faceted' ? WING_MARK_TIP_FACETED : WING_MARK.tipZ), w: half * WING_MARK.w, d: s.tc * WING_MARK.d });
  }
}

function buildFighterJet(kit) {
  const s = shapeOf(kit);
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L: s.L, W: s.W, H: s.H });
  wings(ub, { bone: 'hull', y: s.H * JET.wingY, z: s.L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  teamFins(ub, { y: s.H * JET.finY, z: s.L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  teamFuselage(ub, s);
  teamWingTips(ub, s);
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
