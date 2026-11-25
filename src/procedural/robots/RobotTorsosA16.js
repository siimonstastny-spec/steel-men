// Steel Men – procedural robot torsos, block A16: observingTorso, ergonomicsTorso, shoulderMissileTorso, lightenedTorso,
// plasmaGunsTorso, lightArmorTorso, lightbendingTorso, laserGunsTorso, photonDeflectorTorso.
// Same rig as the basic torso (RobotTorsos.js): 'chest' (on the 'torso' wrapper) → 'head' + 'visor', arm sockets at the basic
// positions (so every arm fits), aim / smoke points. The body-building helpers are a compact copy of RobotTorsosB3.js (not exported
// there). Weapon torsos use rig.weapon { kind, muzzles, shots, charge? } (RobotKit chest attack clips) with socket_Launch_<n> muzzles
// + flashes / recoils through ub.onFire. Shapes differ by kit.style.silhouette only through the RobotSculpt families and RING_SEG
// (never by race). Visual only – the simulation reads the hidden GLB body. Construction time only, no randomness.
import { registerRobotPart, gltfNode, lightLine, shapeOf } from './RobotKit.js';
import { hullLoft, armor, hinge, frontFlat, sideFace, piston } from './RobotSculpt.js';
import { TORSO_SHAPES } from './RobotTorsos.js';
import { unitStyle, UNIT_KIT } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;       // light lines / plates stand this far off the surface
const EMBLEM_OUT = 0.04;     // emblem decal off the front face
const GLOW_DIM = 0.6;
const LINE_GLUE = 0.02;
const LINE_FIT = 0.85;
const VISOR_FIT = 0.95;
const SEG_SMALL = 6;
const SEG_POD = 8;
const SEG_RING = 10;
const ORB_SEG = [6, 4];      // glow orb (width, height segments)
const PHASE_STEP = 1.3;      // pulse phase offset between sibling glow nodes (rad)
// ring (radial, tubular segments) per silhouette; unknown silhouettes use rounded
const RING_SEG = { rounded: [3, 8], round: [3, 10], angular: [3, 6], faceted: [3, 6] };
const RING_DEFAULT = [3, 8];
const ringOf = (kit) => RING_SEG[kit.style?.silhouette] ?? RING_DEFAULT;

/**
 * Dimensions (chest space, raw GLB units). Arm sockets are at (±5.35, 6.7, −1.6); body top ≈ 8.6; head top ≈ 11.
 * scale = body hull scale in width / depth, head = head scale (arm sockets keep the basic x so every arm fits).
 */
export const TORSO_A16 = {
  // optics: big binocular head, telescope on one shoulder, sensor mast on the other, radar dish on the back
  observingTorso: {
    scale: { w: 1.0, d: 1.05 }, head: [1.15, 1.1],
    plate: { w: 5.6, h: 3.4, th: 0.6, y: 5.0 },                                // team chest plate
    scope: { x: 3.6, y: 9.2, z: -0.8, r: 1.15, len: 5.2, lensR: 1.0, mountW: 2.2, hz: 0.5, depth: 0.25 },
    mast: { x: -3.6, y: 8.6, z: -1.8, h: 5.0, r: 0.18, tipR: 0.45, amp: 0.1, hz: 0.6 },
    dish: { y: 5.4, r: 2.4, th: 0.35, mastH: 1.0, spin: 1.2, out: 1.4 },
  },
  // melee damage: broad muscular V, huge team pauldrons with spikes, front pistons
  ergonomicsTorso: {
    scale: { w: 1.14, d: 1.05 }, head: [0.9, 0.85],
    pauldron: { w: 4.8, h: 4.2, th: 1.0, x: 5.2, y: 8.6, z: -1.0, roll: 0.35 },
    spike: { h: 2.4, r: 0.8, seg: 4, x: 5.6, up: 1.3 },
    plate: { w: 7.0, h: 4.4, th: 0.9, y: 5.2 },                                // heavy team chest plate
    piston: { x: 2.6, yTop: 5.0, yBottom: 2.4, out: 0.45, r: 0.55 },
  },
  // big guided missile on the right shoulder
  shoulderMissileTorso: {
    scale: { w: 1.05, d: 1.1 }, head: [0.9, 0.85],
    pod: { x: 4.4, y: 9.6, z: -2.2, tilt: 0.0 },
    tube: { r: 1.55, len: 8.4, back: 2.6 },
    nose: { r: 1.3, tip: 0.15, len: 3.0 },                                      // missile nose visible in the tube mouth
    band: { r: 1.75, len: 0.8, at: 0.45 },
    mount: { w: 3.2, h: 2.2, d: 4.4, y: -1.5 },
    pauldron: { w: 4.0, h: 3.2, th: 0.8, x: -5.0, y: 8.6, z: -1.0, roll: 0.3 },  // counterweight plate on the other shoulder
    shots: 1, recoil: 0.9, flash: { core: 0.9 },
  },
  // odlehčený trup: slim open frame, swept fins, glowing side vents
  lightenedTorso: {
    scale: { w: 0.88, d: 0.84 }, head: [0.9, 0.9],
    plate: { w: 3.6, h: 3.0, th: 0.4, y: 5.4 },
    pauldron: { w: 3.2, h: 2.8, th: 0.6, x: 4.6, y: 8.4, z: -1.2, roll: 0.35 },
    fin: { w: 1.8, h: 5.2, th: 0.3, x: 2.4, y: 6.0, out: 0.45, sweep: 0.5 },
    vent: { w: 0.12, h: 3.0, d: 2.4, y: 4.2, intensity: 0.7 },
  },
  // twin plasma cannons on the shoulders
  plasmaGunsTorso: {
    scale: { w: 1.08, d: 1.12 }, head: [0.85, 0.8],
    pod: { x: 3.6, y: 9.4, z: -0.6 },
    sleeve: { r: 1.55, len: 2.2 },
    barrel: { r: 1.1, len: 5.0 },
    coils: { r: 1.45, t: 0.3, at: [0.3, 0.62], glow: 0.9, hz: 1.6, depth: 0.3 },
    shroud: { w: 3.0, h: 2.6, d: 3.2, y: 0.2, z: 0.6 },
    support: { w: 2.6, h: 2.2, d: 3.2, y: -1.5, z: -0.2 },
    charge: { r: 1.2, y: 9.8, z: 1.2 },
    plate: { w: 5.0, h: 3.2, th: 0.6, y: 5.0 },
    shots: 2, recoil: 0.7, flash: { core: 0.8 },
  },
  // light armoured torso: large team plates, small fins, light stripe
  lightArmorTorso: {
    scale: { w: 1.04, d: 1.1 }, head: [0.95, 0.95],
    pauldron: { w: 4.2, h: 3.4, th: 0.8, x: 5.0, y: 8.7, z: -1.0, roll: 0.3 },
    plate: { w: 6.4, h: 4.2, th: 0.7, y: 5.0 },
    belly: { w: 3.6, h: 1.8, th: 0.4, y: 2.5 },
    stripe: { len: 4.6 },
    fin: { w: 1.6, h: 3.4, th: 0.3, x: 2.2, y: 6.2, out: 0.4 },
  },
  // light bending: a fan of prisms on the back, shoulder prisms, front lens ring
  lightbendingTorso: {
    scale: { w: 1.0, d: 1.0 }, head: [0.95, 0.95],
    plate: { w: 5.2, h: 3.4, th: 0.6, y: 5.0 },
    prism: { r: 1.0, h: 3.4, glowShare: 0.7, intensity: 0.6, hz: 0.5, depth: 0.3,
      list: [[0, 6.4, 0, 1.25], [-2.6, 5.6, 0.5, 0.95], [2.6, 5.6, -0.5, 0.95]] },   // x, y, roll (rz), size
    shoulderPrism: { x: 4.6, y: 9.4, z: -1.0, r: 0.75, h: 2.4 },
    lens: { r: 1.5, tube: 0.22, y: 7.0, intensity: 0.8 },
  },
  // twin lasers on the shoulders: slim long barrels, lens rings, optic housing
  laserGunsTorso: {
    scale: { w: 1.04, d: 1.1 }, head: [0.85, 0.8],
    pod: { x: 3.8, y: 9.4, z: -0.6 },
    barrel: { r: 0.55, len: 7.8 },
    sleeve: { r: 1.0, len: 2.4 },
    lensRing: { r: 0.95, len: 0.35, at: [0.45, 0.8], glowR: 1.0 },
    casing: { w: 2.6, h: 2.6, d: 4.0, y: 0.1, z: -0.6 },
    support: { w: 2.4, h: 2.0, d: 3.0, y: -1.5, z: -0.2 },
    charge: { r: 1.0, y: 9.9, z: 1.2 },
    plate: { w: 5.0, h: 3.2, th: 0.6, y: 5.0 },
    shots: 2, recoil: 0.35, flash: { core: 0.6 },
  },
  // generator: horizontal halo collar over the shoulders, chest emitter lens, back generator
  photonDeflectorTorso: {
    scale: { w: 1.08, d: 1.2 }, head: [0.9, 0.85],
    halo: { r: 6.3, tube: 0.42, y: 9.0, z: -0.6, spin: 0.8, nodes: 4, nodeR: 0.7 },
    back: { w: 6.2, h: 5.0, d: 2.4, y: 5.2 },
    core: { r: 1.2, hz: 0.6, depth: 0.3 },
    emitter: { r: 1.7, tube: 0.25, y: 5.4, lensR: 1.1 },                        // chest emitter ring + flash lens
    plate: { w: 5.4, h: 3.0, th: 0.5, y: 3.0 },
  },
};

// ---------------------------------------------------------------- body (copy of the RobotTorsosB3 helpers)

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
    ...B, body: B.body.map(([y, w, d, z]) => [y, w * V.scale.w, d * V.scale.d, z]),
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
  return { head, visor };
}

/** Waist, belly, chest, shoulder housings, emblem and head. Returns the torso contract (no rig extras yet). */
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
    cb, head: hd, backAt, stationAt: (y) => stationAt(D.body, y),
    frontAt: (y) => { const s = stationAt(D.body, y); const f = frontFlat(kit, s.w, s.d, { keel }); return { z: s.z + f.z, w: f.w, tilt: s.tilt }; },
  };
}

/** Team plate on the chest front at height y (follows the front tilt, never wider than the flat front) */
function chestPlate(base, kit, P, paint) {
  const f = base.frontAt(P.y);
  armor(base.cb, kit, Math.min(P.w, f.w), P.h, P.th, paint, { y: P.y, z: f.z + P.th / 2 + LINE_OUT, rx: -f.tilt });
  return f;
}

/** Shoulder plate standing over an arm, leaning outward */
function shoulderPlate(cb, kit, p, sign, paint) {
  armor(cb, kit, p.w, p.h, p.th, paint, { x: sign * p.x, y: p.y, z: p.z, rz: -sign * p.roll });
}

/** One muzzle on a barrel / tube: flash bone (hidden until fired), recoil, shot socket. Returns the socket name. */
function addMuzzle(ub, ctx, bone, name, len, recoil, index, flashOn) {
  const fl = ub.bone(`${name}Flash`, bone, [0, 0, len]);
  ub.glow(fl).point([0, 0, flashOn.core], flashOn.core, UNIT_KIT.flash.core);
  const fi = ub.meta.flashes.push({ bone: fl }) - 1;
  const ri = ub.meta.recoils.push({ bone, dist: recoil }) - 1;
  const socket = `${ctx.sockets.launch}${index + 1}`;
  ub.socket(socket, bone, [0, 0, len + LINE_OUT]);
  ub.onFire(socket, { flashes: [fi], recoils: [ri] });
  return socket;
}

/** Charge orb on its own bone (hidden until the chest attack charges it) */
function addChargeOrb(ub, name, at, r, color) {
  const bone = ub.bone(name, 'chest', at);
  ub.glow(bone).sphere(r, ORB_SEG[0], ORB_SEG[1], color);
  return bone;
}

/** Shoulder gun pods (plasma / laser): returns the muzzle sockets. build(pod bone, index, sign) paints the pod. */
function buildPods(ub, ctx, P, V, paintPod) {
  const muzzles = [];
  let i = 0;
  for (const sign of [-1, 1]) {
    const pod = ub.bone(`gunPod${i}`, 'chest', [sign * P.x, P.y, P.z]);
    const len = paintPod(pod, i, sign);
    muzzles.push(addMuzzle(ub, ctx, pod, `gunPod${i}`, len, V.recoil, i, V.flash));
    i += 1;
  }
  return muzzles;
}

// ---------------------------------------------------------------- observingTorso

registerRobotPart('torso', 'observingTorso', {
  label: 'Observing torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.observingTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    const glow = kit.glowColors.beacon;
    chestPlate(base, kit, V.plate, S.teamPaint);
    // telescope on the right shoulder: mount block, sleeve, big pulsing lens
    const Sc = V.scope;
    cb.box(Sc.mountW, 1.6, Sc.mountW * 1.6, S.frame, { x: Sc.x, y: Sc.y - 1.2, z: Sc.z + 0.6 });
    const scope = ub.bone('obsScope', 'chest', [Sc.x, Sc.y, Sc.z]);
    ub.paint(scope).cylinder(Sc.r, Sc.r * 1.2, Sc.len, SEG_POD, S.teamPaint, { z: Sc.len / 2, rx: HALF_PI }, true);
    ub.paint(scope).cylinder(Sc.r * 1.35, Sc.r * 1.35, 0.7, SEG_POD, S.hullDark, { z: Sc.len + 0.1, rx: HALF_PI }, true);
    const lens = ub.bone('obsLens', scope, [0, 0, Sc.len + 0.5]);
    ub.glow(lens).sphere(Sc.lensR, ORB_SEG[0], ORB_SEG[1], glow, { intensity: GLOW_DIM });
    ctx.robot.extras.pulse.push({ bone: lens, depth: Sc.depth, hz: Sc.hz });
    // sensor mast with a glowing tip on the left shoulder (sways)
    const M = V.mast;
    const mast = ub.bone('obsMast', 'chest', [M.x, M.y, M.z]);
    ub.paint(mast).cylinder(M.r, M.r * 1.4, M.h, 4, S.frame, { y: M.h / 2, detail: 0 }, true);
    ub.glow(mast).sphere(M.tipR, 4, 3, glow, { y: M.h + M.tipR * 0.4, intensity: GLOW_DIM });
    ctx.robot.extras.sway.push({ bone: mast, axis: 'z', amp: M.amp, hz: M.hz });
    // radar dish on the back
    const Dh = V.dish;
    const bz = base.backAt(Dh.y) - Dh.out;
    cb.cylinder(0.3, 0.3, Dh.mastH, 4, S.frame, { y: Dh.y, z: bz + Dh.out * 0.4, detail: 0 }, true);
    const dish = ub.bone('obsDish', 'chest', [0, Dh.y + Dh.mastH * 0.6, bz]);
    ub.paint(dish).cylinder(Dh.r, Dh.r * 0.5, Dh.th, SEG_POD, S.hullDark, { rx: HALF_PI * 0.6 }, true);
    ctx.robot.extras.spin.push({ bone: dish, axis: 'y', speed: Dh.spin });
    return base.out;
  },
});

// ---------------------------------------------------------------- ergonomicsTorso

registerRobotPart('torso', 'ergonomicsTorso', {
  label: 'Ergonomics torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.ergonomicsTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    for (const sign of [-1, 1]) {
      shoulderPlate(cb, kit, V.pauldron, sign, S.teamPaint);
      const sp = V.spike;
      cb.cylinder(sp.r * 0.12, sp.r, sp.h, sp.seg, S.frame, { x: sign * sp.x, y: V.pauldron.y + V.pauldron.h / 2 + sp.up, z: V.pauldron.z, detail: 0 }, true);
    }
    chestPlate(base, kit, V.plate, S.teamPaint);
    // front pistons (muscle): cylinder + rod either side of the chest plate
    const Pi = V.piston;
    const zTop = base.frontAt(Pi.yTop).z + Pi.out;
    const zBot = base.frontAt(Pi.yBottom).z + Pi.out;
    for (const sign of [-1, 1]) {
      piston(cb, kit, [sign * Pi.x, Pi.yTop, zTop], [sign * Pi.x * 0.85, Pi.yBottom, zBot], Pi.r, S.hullDark, S.pipe);
    }
    return base.out;
  },
});

// ---------------------------------------------------------------- shoulderMissileTorso

registerRobotPart('torso', 'shoulderMissileTorso', {
  label: 'Shoulder missile torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.shoulderMissileTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    shoulderPlate(cb, kit, V.pauldron, 1, S.teamPaint);
    const Pd = V.pod;
    const M = V.mount;
    cb.box(M.w, M.h, M.d, S.frame, { x: Pd.x, y: Pd.y + M.y, z: Pd.z + 1.0 });
    const pod = ub.bone('missilePod', 'chest', [Pd.x, Pd.y, Pd.z], { rotation: [Pd.tilt, 0, 0] });
    const T = V.tube;
    const pb = ub.paint(pod);
    pb.cylinder(T.r, T.r, T.len, SEG_POD, S.hullDark, { z: T.len / 2 - T.back, rx: HALF_PI }, true);
    pb.cylinder(V.band.r, V.band.r, V.band.len, SEG_POD, S.teamPaint, { z: T.len * V.band.at - T.back, rx: HALF_PI }, true);
    pb.cylinder(T.r * 1.18, T.r * 1.18, 1.0, SEG_POD, S.teamPaint, { z: -T.back + 0.4, rx: HALF_PI }, true);
    const N = V.nose;
    pb.cylinder(N.tip, N.r, N.len, SEG_POD, S.hull, { z: T.len - T.back - N.len * 0.35, rx: HALF_PI }, false);
    const socketLen = T.len - T.back + 0.3;
    const muzzle = addMuzzle(ub, ctx, pod, 'missilePod', socketLen, V.recoil, 0, V.flash);
    base.out.rig.weapon = { kind: 'launch', muzzles: [muzzle], shots: V.shots };
    return base.out;
  },
});

// ---------------------------------------------------------------- lightenedTorso

registerRobotPart('torso', 'lightenedTorso', {
  label: 'Lightened torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.lightenedTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    const glow = kit.glowColors.laser;
    chestPlate(base, kit, V.plate, S.teamPaint);
    const sideAt = base.stationAt(V.vent.y);
    for (const sign of [-1, 1]) {
      shoulderPlate(cb, kit, V.pauldron, sign, S.teamPaint);
      // swept fin on the back, facing back and outward
      const F = V.fin;
      armor(cb, kit, F.w, F.h, F.th, S.teamShade, { x: sign * F.x, y: F.y, z: base.backAt(F.y) - F.out, ry: Math.PI - sign * F.sweep });
      // glowing vent on each side of the ribs
      ub.glow('chest').box(V.vent.w, V.vent.h, V.vent.d, glow, { x: sign * (sideAt.w / 2 + V.vent.w / 2), y: V.vent.y, z: sideAt.z, intensity: V.vent.intensity });
    }
    return base.out;
  },
});

// ---------------------------------------------------------------- plasmaGunsTorso / laserGunsTorso (shoulder pods)

registerRobotPart('torso', 'plasmaGunsTorso', {
  label: 'Plasma guns torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.plasmaGunsTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const glow = unitStyle(kit).weaponGlow;
    chestPlate(base, kit, V.plate, S.hullDark);
    const muzzles = buildPods(ub, ctx, V.pod, V, (pod, i, sign) => {
      const pb = ub.paint(pod);
      const Su = V.support;
      pb.box(Su.w, Su.h, Su.d, S.frame, { y: Su.y, z: Su.z });
      const Sh = V.shroud;
      pb.box(Sh.w, Sh.h, Sh.d, S.teamPaint, { y: Sh.y, z: Sh.z });
      pb.cylinder(V.sleeve.r, V.sleeve.r, V.sleeve.len, SEG_POD, S.hullDark, { z: V.sleeve.len / 2 + Sh.z, rx: HALF_PI }, true);
      pb.cylinder(V.barrel.r, V.barrel.r, V.barrel.len, SEG_POD, S.frame, { z: V.barrel.len / 2 + Sh.z, rx: HALF_PI }, true);
      // glowing coil rings along the barrel (pulse, offset between the two)
      const coils = ub.bone(`plasmaCoils${i}`, pod, [0, 0, Sh.z]);
      for (const at of V.coils.at) {
        ub.glow(coils).cylinder(V.coils.r, V.coils.r, V.coils.t, SEG_RING, glow, { z: V.barrel.len * at, rx: HALF_PI, intensity: V.coils.glow }, true);
      }
      ctx.robot.extras.pulse.push({ bone: coils, depth: V.coils.depth, hz: V.coils.hz, phase: i * PHASE_STEP });
      return V.barrel.len + Sh.z;
    });
    const charge = addChargeOrb(ub, 'plasmaCharge', [0, V.charge.y, V.charge.z], V.charge.r, glow);
    base.out.rig.weapon = { kind: 'pulse', muzzles, shots: V.shots, charge };
    return base.out;
  },
});

registerRobotPart('torso', 'laserGunsTorso', {
  label: 'Laser guns torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.laserGunsTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const glow = unitStyle(kit).weaponGlow;
    chestPlate(base, kit, V.plate, S.teamPaint);
    const muzzles = buildPods(ub, ctx, V.pod, V, (pod) => {
      const pb = ub.paint(pod);
      const Su = V.support;
      pb.box(Su.w, Su.h, Su.d, S.frame, { y: Su.y, z: Su.z });
      const Cs = V.casing;
      pb.box(Cs.w, Cs.h, Cs.d, S.hullDark, { y: Cs.y, z: Cs.z });
      pb.box(Cs.w * 0.7, Cs.h * 0.45, Cs.d * 0.5, S.teamPaint, { y: Cs.y + Cs.h / 2 + 0.15, z: Cs.z + 0.4, detail: 0 });
      const z0 = Cs.z + Cs.d / 2 - 0.4;
      pb.cylinder(V.sleeve.r, V.sleeve.r, V.sleeve.len, SEG_POD, S.frame, { z: z0 + V.sleeve.len / 2, rx: HALF_PI }, true);
      pb.cylinder(V.barrel.r, V.barrel.r, V.barrel.len, SEG_POD, S.pipe, { z: z0 + V.barrel.len / 2, rx: HALF_PI }, true);
      const R = V.lensRing;
      for (const at of R.at) {
        pb.cylinder(R.r, R.r, R.len, SEG_POD, S.hullDark, { z: z0 + V.barrel.len * at, rx: HALF_PI }, true);
        ub.glow(pod).cylinder(R.glowR, R.glowR, R.len * 0.4, SEG_RING, glow, { z: z0 + V.barrel.len * at, rx: HALF_PI, intensity: GLOW_DIM }, true);
      }
      return z0 + V.barrel.len;
    });
    const charge = addChargeOrb(ub, 'laserCharge', [0, V.charge.y, V.charge.z], V.charge.r, glow);
    base.out.rig.weapon = { kind: 'pulse', muzzles, shots: V.shots, charge };
    return base.out;
  },
});

// ---------------------------------------------------------------- lightArmorTorso

registerRobotPart('torso', 'lightArmorTorso', {
  label: 'Light armor torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.lightArmorTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    for (const sign of [-1, 1]) {
      shoulderPlate(cb, kit, V.pauldron, sign, S.teamPaint);
      const F = V.fin;
      armor(cb, kit, F.w, F.h, F.th, S.hullDark, { x: sign * F.x, y: F.y, z: base.backAt(F.y) - F.out, ry: Math.PI - sign * 0.4 });
    }
    const f = chestPlate(base, kit, V.plate, S.teamPaint);
    lightLine(cb, kit, V.stripe.len, 'x', { y: V.plate.y + V.plate.h / 2 + 0.4, z: f.z + V.plate.th + LINE_OUT * 2 });
    const Bl = V.belly;
    const bf = base.frontAt(Bl.y);
    armor(cb, kit, Math.min(Bl.w, bf.w), Bl.h, Bl.th, S.hullDark, { y: Bl.y, z: bf.z + Bl.th / 2 + LINE_OUT, rx: -bf.tilt });
    return base.out;
  },
});

// ---------------------------------------------------------------- lightbendingTorso

registerRobotPart('torso', 'lightbendingTorso', {
  label: 'Lightbending torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.lightbendingTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    const glow = kit.glowColors.beacon;
    chestPlate(base, kit, V.plate, S.teamPaint);
    // fan of diamond prisms on the back (4-sided double cones), each with a glowing core that pulses
    const P = V.prism;
    P.list.forEach(([x, y, roll, size], i) => {
      const bz = base.backAt(y) - 1.6;
      const h = P.h * size;
      const r = P.r * size;
      // solid paint on the chest (static); only the glow lives on the pulsing bone
      const bone = ub.bone(`prism${i}`, 'chest', [x, y, bz], { rotation: [0, 0, roll] });
      const dx = Math.sin(roll) * h / 4;
      const dy = Math.cos(roll) * h / 4;
      cb.cylinder(0.05, r, h / 2, 4, S.frame, { x: x - dx, y: y + dy, z: bz, rz: roll, detail: 0 }, true);
      cb.cylinder(r, 0.05, h / 2, 4, S.teamPaint, { x: x + dx, y: y - dy, z: bz, rz: roll, detail: 0 }, true);
      ub.glow(bone).cylinder(0.02, r * P.glowShare, h * 0.36, 4, glow, { y: h * 0.18, intensity: P.intensity }, true);
      ub.glow(bone).cylinder(r * P.glowShare, 0.02, h * 0.36, 4, glow, { y: -h * 0.18, intensity: P.intensity }, true);
      ctx.robot.extras.pulse.push({ bone, depth: P.depth, hz: P.hz, phase: i * PHASE_STEP });
    });
    // shoulder prisms
    const Sp = V.shoulderPrism;
    for (const sign of [-1, 1]) {
      cb.cylinder(0.05, Sp.r, Sp.h / 2, 4, S.frame, { x: sign * Sp.x, y: Sp.y + Sp.h / 4, z: Sp.z, detail: 0 }, true);
      cb.cylinder(Sp.r, 0.05, Sp.h / 2, 4, S.teamPaint, { x: sign * Sp.x, y: Sp.y - Sp.h / 4, z: Sp.z, detail: 0 }, true);
    }
    // front lens ring above the chest plate (bends the light round the pilot)
    const L = V.lens;
    const lf = base.frontAt(L.y);
    const ring = ringOf(kit);
    const lens = ub.bone('bendLens', 'chest', [0, L.y, lf.z + L.tube]);
    ub.glow(lens).torus(L.r, L.tube, ring[0], ring[1] * 2, glow, { intensity: L.intensity });
    ctx.robot.extras.pulse.push({ bone: lens, depth: P.depth, hz: P.hz, phase: PHASE_STEP * 4 });
    return base.out;
  },
});

// ---------------------------------------------------------------- photonDeflectorTorso

registerRobotPart('torso', 'photonDeflectorTorso', {
  label: 'Photon deflector torso',
  build(ub, kit, ctx) {
    const V = TORSO_A16.photonDeflectorTorso;
    const base = buildBase(ub, kit, ctx, shapeFor(V));
    const S = kit.S;
    const cb = base.cb;
    const glow = unitStyle(kit).weaponGlow;
    const ring = ringOf(kit);
    chestPlate(base, kit, V.plate, S.teamPaint);
    // back generator: housing + pulsing core
    const B = V.back;
    const bz = base.backAt(B.y) - B.d / 2 + LINE_OUT;
    cb.box(B.w, B.h, B.d, S.frame, { y: B.y, z: bz });
    cb.box(B.w * 0.7, B.h * 0.55, B.d * 0.6, S.teamPaint, { y: B.y, z: bz - B.d * 0.55, detail: 0 });
    const core = ub.bone('deflectCore', 'chest', [0, B.y, bz - B.d - LINE_OUT]);
    ub.glow(core).sphere(V.core.r, ORB_SEG[0], ORB_SEG[1], kit.glowColors.reactor, { intensity: GLOW_DIM });
    ctx.robot.extras.pulse.push({ bone: core, depth: V.core.depth, hz: V.core.hz });
    // horizontal halo collar over the shoulders (turns slowly) with emitter nodes that flare on a reflection
    const H = V.halo;
    const halo = ub.bone('deflectHalo', 'chest', [0, H.y, H.z]);
    ub.paint(halo).torus(H.r, H.tube, ring[0], ring[1] * 2, Math.PI * 2, S.teamPaint, { rx: HALF_PI });
    ub.glow(halo).torus(H.r * 0.97, H.tube * 0.45, ring[0], ring[1] * 2, glow, { rx: HALF_PI, intensity: GLOW_DIM });
    for (let i = 0; i < H.nodes; i++) {
      const a = (Math.PI * 2 * i) / H.nodes + Math.PI / H.nodes;
      const node = ub.bone(`deflectNode${i}`, halo, [Math.sin(a) * H.r, 0, Math.cos(a) * H.r]);
      ub.paint(node).box(H.nodeR * 1.4, H.nodeR * 1.4, H.nodeR * 1.4, S.frame, { detail: 0 });
      ub.glow(node).sphere(H.nodeR * 0.8, 4, 3, glow, { intensity: GLOW_DIM });
      ub.meta.lenses.push({ bone: node });
    }
    ctx.robot.extras.spin.push({ bone: halo, axis: 'y', speed: H.spin });
    // chest emitter: ring + flash lens (the reflection channel)
    const E = V.emitter;
    const ef = base.frontAt(E.y);
    const em = ub.bone('deflectEmitter', 'chest', [0, E.y, ef.z + E.tube + 0.1]);
    ub.paint(em).torus(E.r, E.tube, ring[0], ring[1] * 2, Math.PI * 2, S.hullDark, {});
    ub.glow(em).point([0, 0, 0.1], E.lensR, glow);
    ub.meta.lenses.push({ bone: em });
    ub.socket(`${ctx.sockets.sfx}_T`, em, [0, 0, 0.3]);
    return base.out;
  },
});

export const TORSO_A16_IDS = Object.keys(TORSO_A16);
