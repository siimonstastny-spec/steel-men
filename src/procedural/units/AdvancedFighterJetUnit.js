// Steel Men – procedural advanced fighter jet (roadmap U1). Larger multirole fighter: average vs ground and air; TWO engine
// nozzles in side-by-side nacelles, wing pylons with missile pods, nose gun, belly rocket pod. Shape table keyed by
// style.silhouette with only `rounded` (other styles fall back to it).
//   • sockets: muzzle (nose gun), launch_2_1..launch_2_POD_MISSILES (belly pod), muzzle_2, exhaust_1, exhaust_2, aim, smoke
//   • flight: owner calls setMotion(speed, yawRate) and setThrottle(0..1)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 7.6 long, 7.0 span, 2.7 high incl. fins. Visual only.
import * as THREE from 'three';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { fuselage, wings, exhaust, weapon, statusLamp, roofMark, UNIT_MODULES } from './UnitModules.js';

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

// team colour (top-down readable): fuselage top by style.silhouette, V-tail fins + engine housing painted, a mark on each wing tip.
// rounded / round: cap = polar angle (rad) of a sphere segment laid over the fuselage top (offset CAP_OFFSET model units off the body, no z-fighting), seg = its [width, height] segments
// angular: roofMark on the flat top plate (shares of W, L, L); faceted: strakes on the two upper faces (shares of the face width / L, z share of L, L share)
const FUSELAGE_TEAM = {
  rounded: { cap: 0.7, seg: [12, 2] },
  round: { cap: 0.7, seg: [12, 2] },
  angular: { w: 0.55, d: 0.26, z: -0.22 },
  faceted: { share: 0.6, z: -0.18, l: 0.22 },
};
// wing tip marks (roofMark) – outside the emblem, not on the crescent wing: x share of the half span, w share of the half span, d share of the tip chord
const WING_MARK = { x: 0.88, w: 0.2, d: 0.6, tipZ: 0.45 };   // tipZ: centre z = tip leading edge − tipZ × tip chord
const CAP_OFFSET = 0.03;   // absolute offset of the fuselage cap from the body (model units; >= other team plates, no flicker on slim fuselages)
const WING_MARK_TIP_FACETED = 0.6;   // tipZ for the faceted wing (its swept-forward tip edge would be overhung at 0.45)

const shapeOf = (kit) => ADVANCED_FIGHTER_SHAPES[kit.style.silhouette] ?? ADVANCED_FIGHTER_SHAPES.rounded;

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
    geo.rotateX(HALF_PI);
    geo.rotateZ(HALF_PI);
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

function buildAdvancedFighter(kit) {
  const s = shapeOf(kit);
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L: s.L, W: s.W, H: s.H });
  wings(ub, { bone: 'hull', y: s.H * JET.wingY, z: s.L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  teamFins(ub, { y: s.H * JET.finY, z: s.L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  teamFuselage(ub, s);
  teamWingTips(ub, s);
  const hb = ub.paint('hull');
  const N = JET.nacelle;
  hb.box(s.W * N.w, s.H * N.h, s.L * N.l, S.teamShade, { y: s.H * N.y, z: s.L * N.z });   // engine housing in the darker team lacquer
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
