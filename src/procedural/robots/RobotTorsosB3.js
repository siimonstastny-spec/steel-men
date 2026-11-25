// Steel Men – procedural robot torso, block B3 (T3 content): bastionTorso = heavy armoured torso with a shield generator.
// Same rig as the basic torso (RobotTorsos.js): 'chest' (on the 'torso' wrapper) → 'head' + 'visor', arm sockets at the basic
// positions (so every arm fits), aim / smoke points. The body-building helpers are a compact copy of RobotTorsosB6.js (they are not
// exported there). Shapes differ by kit.style.silhouette only through the RobotSculpt families (never by race). Visual only –
// the simulation reads the hidden GLB body. Construction time only, no randomness.
import { registerRobotPart, gltfNode, lightLine, shapeOf } from './RobotKit.js';
import { hullLoft, armor, hinge, frontFlat, sideFace } from './RobotSculpt.js';
import { TORSO_SHAPES } from './RobotTorsos.js';
import { unitStyle } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;       // light lines / plates stand this far off the surface
const EMBLEM_OUT = 0.04;     // emblem decal off the front face
const GLOW_DIM = 0.6;
const LINE_GLUE = 0.02;
const LINE_FIT = 0.85;
const VISOR_FIT = 0.95;
const SEG_SMALL = 6;
const SEG_ROUND = 8;
const ORB_SEG = [6, 4];      // glow orb (width, height segments)
// halo ring (radial, tubular segments) per silhouette; unknown silhouettes use rounded
const RING_SEG = { rounded: [3, 8], round: [3, 10], angular: [3, 6], faceted: [3, 6] };

/** Body scale relative to basic: heavy and deep (arm sockets keep the basic x so every arm fits) */
const BODY_SCALE = { w: 1.12, d: 1.3 };

/**
 * Dimensions (chest space, raw GLB units). Arm sockets are at (±5.35, 6.7, −1.6); body top ≈ 8.6; head top ≈ 11.
 */
export const TORSO_B3 = {
  bastionTorso: {
    head: [0.85, 0.8],                                                         // small head sunk between the shoulder bulwarks
    pauldron: { w: 4.2, h: 3.8, th: 1.0, x: 5.0, y: 9.0, z: -1.0, roll: 0.3 }, // shoulder bulwark standing over each arm
    cap: { w: 3.2, h: 1.5, th: 0.45, y: 0.3 },                                 // team cap on top of the bulwark
    chestPlate: { w: 6.8, h: 4.2, th: 0.8, y: 5.0 },                           // heavy front plate
    stripe: { len: 5.0 },                                                      // light line across the chest plate
    back: { w: 7.2, h: 5.4, d: 2.6, y: 5.2 },                                  // generator housing on the back
    coil: { x: 2.2, r: 0.9, h: 4.6, out: 0.9 },                                // two vertical coils on the housing
    core: { r: 1.1, y: 5.2, hz: 0.5, depth: 0.25 },                            // pulsing generator core between the coils
    stem: { r: 0.7, h: 3.0 },                                                  // emitter mast above the housing
    halo: { r: 3.0, tube: 0.35, rise: 0.4, spin: 1.1 },                        // horizontal emitter ring (the shield field) above the mast
    spike: { x: 5.0, h: 3.2, w: 0.7, tip: 0.8, tilt: 0.2 },                    // field projector prongs rising from the shoulder bulwarks
  },
};

// ---------------------------------------------------------------- body (copy of the RobotTorsosB6 helpers)

/** Hull section at height y between stations [y, w, d, z]: { w, d, z, tilt } */
function stationAt(stations, y) {
  let i = 1;
  while (i < stations.length - 1 && stations[i][0] < y) i++;
  const a = stations[i - 1];
  const b = stations[i];
  const k = Math.min(1, Math.max(0, (y - a[0]) / (b[0] - a[0])));
  const front = (s) => s[3] + s[2] / 2;
  return {
    w: a[1] + (b[1] - a[1]) * k, d: a[2] + (b[2] - a[2]) * k, z: a[3] + (b[3] - a[3]) * k,
    tilt: Math.atan2(front(a) - front(b), b[0] - a[0]),
  };
}

/** basic dimensions with the body hull scaled in width / depth and the head scaled (waist, arm sockets unchanged) */
function shapeFor(V) {
  const B = TORSO_SHAPES.basic;
  return {
    ...B, body: B.body.map(([y, w, d, z]) => [y, w * BODY_SCALE.w, d * BODY_SCALE.d, z]),
    head: V.head ? { ...B.head, scale: V.head } : B.head,
  };
}

/** Head: neck, team helmet, visor slit (own bone: crew on / off). Layout of the basic head, scaled by H.scale. */
function buildHead(ub, kit, ctx, H) {
  const S = kit.S;
  const hs = H.scale ?? [1, 1];
  const stations = H.stations.map(([y, w, d, z]) => [y, w * hs[0], d * hs[1], z]);
  const head = gltfNode(ctx, 'head');
  ub.bone(head, 'chest', H.at);
  const hb = ub.paint(head);
  hb.cylinder(H.neck.r, H.neck.r, H.neck.h, SEG_SMALL, S.frame, { y: H.neck.h / 2 - H.neck.h, detail: 1 }, true);
  hullLoft(hb, kit, stations.map(([y, w, d, z]) => ({ y, w, d, z, keel: H.keel })), S.teamPaint);
  if (shapeOf(kit).block === 'prism' || shapeOf(kit).block === 'tapered') {
    armor(hb, kit, H.crest.d * hs[1], H.crest.h, H.crest.w, S.hull, { y: H.crest.y, z: H.crest.z, ry: HALF_PI });
  }
  const at = stationAt(stations, H.visor.y);
  const ff = frontFlat(kit, at.w, at.d, { keel: H.keel });
  const visor = ub.bone('visor', head, [0, H.visor.y, at.z + ff.z + LINE_OUT]);
  ub.glow(visor).box(Math.min(H.visor.w * hs[0], ff.w * VISOR_FIT), H.visor.h, H.visor.h, kit.glowColors.beacon);
  return { head, visor, ff, at };
}

/** Waist, belly, chest, shoulder housings, plates, emblem and head. Returns the torso contract (no rig extras yet). */
function buildBase(ub, kit, ctx, D) {
  const S = kit.S;
  ub.bone(gltfNode(ctx, 'chest'), ctx.bone);
  const cb = ub.paint('chest');
  const keel = D.bodyKeel;
  hullLoft(cb, kit, D.waist.map(([y, w, d, z]) => ({ y, w, d, z })), S.frame);
  hullLoft(cb, kit, D.body.map(([y, w, d, z]) => ({ y, w, d, z, keel })), S.hull);
  const A = D.arms;
  const side = stationAt(D.body, D.sideLine.y);
  const face = sideFace(kit, side.w, side.d, { keel });
  for (const sign of [-1, 1]) {
    hinge(cb, kit, D.shoulder.r, D.shoulder.len, S.frame, { x: sign * D.shoulder.x, y: A.y, z: A.z });
    lightLine(cb, kit, Math.min(D.sideLine.len, face.len * LINE_FIT), 'z', { x: sign * (side.w / 2 + LINE_GLUE), y: D.sideLine.y, z: side.z + face.v });
  }
  // (round 2, budget: no abdomen plate and no front side plates – the heavy chest plate and bulwarks carry the look, ~120 tri)
  const Em = D.emblem;
  const ec = stationAt(D.body, Em.y);
  const ef = frontFlat(kit, ec.w, ec.d, { keel });
  const nY = Math.sin(ec.tilt);
  const nZ = Math.cos(ec.tilt);
  const plateW = Math.min(Em.size * Em.plate, ef.w);
  armor(cb, kit, plateW, plateW, Em.th, S.plate, { y: Em.y + nY * (Em.th / 2), z: ec.z + ef.z + nZ * (Em.th / 2), rx: -ec.tilt }, { corner: 'chamfer' });
  ub.emblem('chest', [{
    position: [0, Em.y + nY * (Em.th + EMBLEM_OUT), ec.z + ef.z + nZ * (Em.th + EMBLEM_OUT)], normal: [0, nY, nZ], size: plateW / Em.plate,
  }]);
  const hd = buildHead(ub, kit, ctx, D.head);
  const backAt = (y) => { const s = stationAt(D.body, y); return s.z - s.d / 2; };
  return {
    out: {
      arms: { leftArm: [-A.x, A.y, A.z], rightArm: [A.x, A.y, A.z] },
      aim: D.aim, smoke: D.smoke,
      rig: { chest: 'chest', head: hd.head, visor: hd.visor },
    },
    cb, head: hd, backAt,
    frontAt: (y) => { const s = stationAt(D.body, y); const f = frontFlat(kit, s.w, s.d, { keel }); return { z: s.z + f.z, w: f.w, tilt: s.tilt }; },
  };
}

// ---------------------------------------------------------------- bastionTorso

registerRobotPart('torso', 'bastionTorso', {
  label: 'Bastion torso',
  build(ub, kit, ctx) {
    const V = TORSO_B3.bastionTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    const glow = unitStyle(kit).weaponGlow;
    const ringSeg = RING_SEG[kit.style?.silhouette] ?? RING_SEG.rounded;
    // shoulder bulwarks with team caps and projector prongs (glowing tips)
    const p = V.pauldron;
    const sp = V.spike;
    for (const sign of [-1, 1]) {
      armor(cb, kit, p.w, p.h, p.th, S.teamPaint, { x: sign * p.x, y: p.y, z: p.z, rz: -sign * p.roll });
      // (round 2: no team cap – the bulwark itself is team painted; tips are 4-sided glow pyramids instead of orbs)
      const px = sign * sp.x;
      const py = p.y + p.h / 2 + sp.h / 2 - 0.4;
      cb.box(sp.w, sp.h, sp.w, S.frame, { x: px, y: py, z: p.z, rz: -sign * sp.tilt, detail: 0 });
      ub.glow('chest').cylinder(0, sp.tip, sp.tip * 1.4, 4, glow, {
        x: px + sign * Math.sin(sp.tilt) * sp.h / 2, y: py + Math.cos(sp.tilt) * sp.h / 2 + sp.tip * 0.7, z: p.z, intensity: GLOW_DIM,
      }, true);
    }
    // heavy front plate with a light line
    const C = V.chestPlate;
    const f = base.frontAt(C.y);
    armor(cb, kit, Math.min(C.w, f.w), C.h, C.th, S.hullDark, { y: C.y - 1.2, z: f.z + C.th / 2 + LINE_OUT, rx: -f.tilt });
    lightLine(cb, kit, V.stripe.len, 'x', { y: C.y + C.h / 2 - 1.0, z: f.z + C.th + LINE_OUT * 2 });
    // shield generator on the back: housing, two coils, pulsing core, mast with a horizontal emitter halo above it
    const B = V.back;
    const bz = base.backAt(B.y) - B.d / 2 + LINE_OUT;
    cb.box(B.w, B.h, B.d, S.frame, { y: B.y, z: bz });
    const K = V.coil;
    const cz = bz - B.d / 2 - K.out * 0.5;
    for (const sign of [-1, 1]) {
      cb.cylinder(K.r, K.r, K.h, SEG_SMALL, S.hullDark, { x: sign * K.x, y: B.y, z: cz }, true);
    }
    const core = ub.bone('bastionCore', 'chest', [0, V.core.y, bz - B.d / 2 - LINE_OUT]);
    ub.glow(core).sphere(V.core.r, ORB_SEG[0], ORB_SEG[1], kit.glowColors.reactor, { intensity: GLOW_DIM });
    ctx.robot.extras.pulse.push({ bone: core, depth: V.core.depth, hz: V.core.hz });
    const top = B.y + B.h / 2;
    cb.cylinder(V.stem.r, V.stem.r * 1.3, V.stem.h, SEG_SMALL, S.frame, { y: top + V.stem.h / 2, z: bz }, true);
    const H = V.halo;
    const halo = ub.bone('bastionHalo', 'chest', [0, top + V.stem.h + H.rise, bz]);
    ub.paint(halo).torus(H.r, H.tube, ringSeg[0], ringSeg[1], Math.PI * 2, S.frame, { rx: HALF_PI });
    // (round 2: no second glow torus; the single ring is the shield-field halo)
    ctx.robot.extras.spin.push({ bone: halo, axis: 'y', speed: H.spin });
    return base.out;
  },
});
