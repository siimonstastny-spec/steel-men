// Steel Men – procedural robot arms (experiment): basic fist. Rig = the GLB RobotPartsBasic hand arm: 'shoulder{L,R}'
// (on the 'armL' / 'armR' wrapper at socket_ArmLeft / socket_ArmRight) → 'elbow{L,R}' → 'fist{L,R}'. The arm is built
// for its side (sign −1 = left = −x), so no negative scale is needed. Robot faces +Z. Construction time only.
// Arm contract: build(ub, kit, ctx { bone, side, sfx, slot }) → { rig: { shoulder, elbow, fist, attack, fire } }.
// Weapon arms add their muzzles as `socket_Launch_<sfx><n>` (unique per robot, matches MUZZLE.socketPatterns).
// Sculpted (RobotSculpt): lofted pauldron (team), upper arm and flared forearm, rimmed elbow hub, lofted hand.
// gattling (GattlingGun, W start arm): gun housing in place of the forearm, a spinning cluster of barrels on the 'fist'
// bone (spins up with every shot – ProcUnit spinner driver), muzzle flash, socket_Launch_<L|R>1; attack 'gun' (burst).
import { registerRobotPart, gltfNode, lightLine } from './RobotKit.js';
import { hullLoft, limbLoft, armor, hinge, frontFlat, sideFace } from './RobotSculpt.js';
import { UNIT_KIT } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;
const LINE_OUT = 0.05;
const LINE_GLUE = 0.02;      // light lines on flat faces: half of the line inside the surface
const LINE_FIT = 0.85;       // a side light line covers at most this share of its flat face
const BARREL_SEG = 5;        // gattling barrels (open tubes)
const CLAMP_SEG = 6;         // gattling barrel clamps / flash cone

// Shoulder + upper arm + elbow shared by the hand arm and the gun arms (RIGHT arm values, x mirrored for the left)
const UPPER_ARM = {
  elbow: [0.85, -4.9, -0.1], fist: [0, -5.7, 0.1],
  pad: { w: 4.6, h: 3.4, d: 5.0, x: 0.9, y: 0.6, z: 0.3, trimY: -1.0 },   // broad shoulder pauldron (team colour)
  padLoft: [[0, 1, 0.95], [0.6, 1.05, 1], [1, 0.7, 0.75]],                 // pauldron stations [height share, w, d]
  fin: { w: 0.35, h: 1.4, d: 3.0, x: 0.9, y: 2.5 },                        // pad fin (faceted / angular only)
  shoulderJoint: { r: 1.2, len: 1.8, x: -0.4 },
  upper: { w: 1.9, d: 2.1, profile: [[-0.08, 0.9, 0.9], [0.35, 1, 1, 0.05], [1.06, 0.78, 0.8]] },
  elbowJoint: { r: 1.0, len: 2.0 },
};

/**
 * Arm dimensions (raw GLB units, x for the RIGHT arm = +x side; mirrored for the left). Basic follows
 * RobotPartsBasic/*BasicHandArmX_Skel.glb: elbow 4.9 below the socket, fist 5.7 below the elbow, ~13.7 long.
 */
export const ARM_SHAPES = {
  fist: {
    ...UPPER_ARM,
    fore: { w: 3.2, d: 3.3, profile: [[-0.07, 0.78, 0.8], [0.55, 1, 1, 0.08], [1.04, 1.02, 1.0]] },   // massive team forearm, flares to the wrist
    blade: { w: 3.6, h: 2.2, th: 0.35, x: 1.75, y: -2.8, z: 0.3 },           // light armour blade on the outer side
    foreLine: { len: 3.0, at: 0.8 },                                         // at = share elbow → fist (straight wrist segment)
    hand: { w: 2.8, h: 2.5, d: 3.0, y: -1.4, z: 0.5, loft: [[0, 0.88, 0.85], [0.5, 1, 1], [1, 0.9, 0.86]] },
    knuckles: { w: 2.9, h: 0.7, d: 0.8, y: -2.2, z: 1.8 },
    thumb: { w: 0.6, h: 1.4, d: 0.9, x: -1.5, y: -1.1, z: 1.0 },
    laser: { w: 2.6, t: 0.18, y: -2.2, z: 2.25 },                            // knuckle laser edge (lens: flares on a punch)
    sfx: [0, -2.5, 0.9],                                                     // socket_SFX_1_<L|R> (GLB: socket_SFX_1)
  },
  // rotary cannon: housing elbow → 'fist' bone (= cluster hub), barrels from the hub along −Y (forward while the
  // forearm is held up – ROBOT_KIT.anim.gun), muzzle at the cluster front
  gattling: {
    ...UPPER_ARM,
    fin: null,
    housing: { w: 3.1, d: 3.2, profile: [[-0.12, 0.82, 0.82], [0.2, 1, 1, 0.1], [1.02, 0.86, 0.86]] },   // 8-point gun body
    side: { w: 3.4, h: 2.2, th: 0.3, at: 0.5 },                              // team armour on the outer side (at = share elbow → fist)
    topLine: { len: 3.2, at: 0.5 },                                          // light line along the top (front) of the housing
    cluster: { barrels: 6, ring: 0.62, r: 0.19, len: 4.4, clamps: [0.2, 0.82], clampR: 0.98, clampLen: 0.35 },
    spin: 16,                                                                // rad/s at full spin (spin-up / linger: UNIT_KIT.spin)
    flash: { near: 0.55, far: 0.12, len: 1.5, core: 0.5 },
    shots: 16,                                                               // VISUAL default burst (= stats GattlingGun burst); in game pass weapon.burst to playAttack
  },
};

/** Limb profile [t, w, d, z?] at t: { ws, ds, oz, span (t length of the segment holding t) } */
function profileAt(profile, t) {
  let i = 1;
  while (i < profile.length - 1 && profile[i][0] < t) i++;
  const a = profile[i - 1];
  const b = profile[i];
  const k = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
  return {
    ws: a[1] + (b[1] - a[1]) * k, ds: a[2] + (b[2] - a[2]) * k, oz: (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * k, span: b[0] - a[0],
  };
}

/**
 * Shoulder, upper arm and elbow of every arm: bones shoulder → elbow → fist (GLB-like nodes), hub + team pauldron with a
 * light trim (fin on sharp styles), lofted upper arm, elbow hub. Returns the bone names and the mirror helper.
 */
function buildUpperArm(ub, kit, ctx, D, { elbowRim = true } = {}) {
  const S = kit.S;
  const sg = ctx.side;
  const m = ([x, y, z]) => [x * sg, y, z];
  const shoulder = gltfNode(ctx, `shoulder${ctx.sfx}`);
  const elbow = gltfNode(ctx, `elbow${ctx.sfx}`);
  const fist = gltfNode(ctx, `fist${ctx.sfx}`);
  ub.bone(shoulder, ctx.bone);
  ub.bone(elbow, shoulder, m(D.elbow));
  ub.bone(fist, elbow, D.fist);

  const sb = ub.paint(shoulder);
  hinge(sb, kit, D.shoulderJoint.r, D.shoulderJoint.len, S.frame, { x: sg * D.shoulderJoint.x });
  const P = D.pad;
  const y0 = P.y - P.h / 2;
  hullLoft(sb, kit, D.padLoft.map(([ys, ws, ds]) => ({ y: y0 + ys * P.h, w: P.w * ws, d: P.d * ds, x: sg * P.x, z: P.z })), S.teamPaint);
  // light trim glued to the flat outer face of the pauldron (section interpolated at the trim height)
  const [s0, s1] = D.padLoft;
  const k = Math.min(1, Math.max(0, (P.y + P.trimY - (y0 + s0[0] * P.h)) / ((s1[0] - s0[0]) * P.h)));
  const tw = P.w * (s0[1] + (s1[1] - s0[1]) * k);
  const td = P.d * (s0[2] + (s1[2] - s0[2]) * k);
  const face = sideFace(kit, tw, td);
  lightLine(sb, kit, face.len * LINE_FIT, 'z', { x: sg * (P.x + tw / 2 + LINE_GLUE), y: P.y + P.trimY, z: P.z + face.v });
  const style = kit.style.silhouette;
  if (D.fin && (style === 'faceted' || style === 'angular')) {
    sb.box(D.fin.w, D.fin.h, D.fin.d, S.hullDark, { x: sg * D.fin.x, y: D.fin.y, z: P.z });   // 12 triangles (budget)
  }
  const U = D.upper;
  limbLoft(sb, kit, [0, 0, 0], m(D.elbow), U.w, U.d, U.profile, S.hull);   // light upper arm between the team pauldron and forearm
  hinge(ub.paint(elbow), kit, D.elbowJoint.r, D.elbowJoint.len, S.frame, {}, { rim: elbowRim });
  return { shoulder, elbow, fist, m };
}

registerRobotPart('arm', 'fist', {
  label: 'Basic fist',
  build(ub, kit, ctx) {
    const D = ARM_SHAPES.fist;
    const S = kit.S;
    const sg = ctx.side;
    const { shoulder, elbow, fist } = buildUpperArm(ub, kit, ctx, D);

    // forearm flaring to the wrist, armour blade on the outer side, light line on the front
    const eb = ub.paint(elbow);
    const F = D.fore;
    limbLoft(eb, kit, [0, 0, 0], D.fist, F.w, F.d, F.profile, S.teamPaint);
    const B = D.blade;
    armor(eb, kit, B.w, B.h, B.th, S.hull, { x: sg * B.x, y: B.y, z: B.z, ry: sg * HALF_PI });
    // light line glued to the front ridge on the straight wrist segment of the profile
    const fl = D.foreLine;
    const fp = profileAt(F.profile, fl.at);
    const flen = Math.min(fl.len, fp.span * -D.fist[1] * LINE_FIT);
    lightLine(eb, kit, flen, 'y', { y: D.fist[1] * fl.at, z: D.fist[2] * fl.at + (F.d * fp.ds) / 2 + fp.oz + LINE_GLUE });

    // fist: lofted hand, knuckle bar, thumb, laser edge on the knuckles (lens bone, flares on the punch)
    const fb = ub.paint(fist);
    const H = D.hand;
    const hy0 = H.y - H.h / 2;
    hullLoft(fb, kit, H.loft.map(([ys, ws, ds]) => ({ y: hy0 + ys * H.h, w: H.w * ws, d: H.d * ds, z: H.z })), S.hullDark);
    const K = D.knuckles;
    fb.box(K.w, K.h, K.d, S.frame, { y: K.y, z: K.z });
    const T = D.thumb;
    fb.box(T.w, T.h, T.d, S.frame, { x: -sg * T.x, y: T.y, z: T.z, detail: 0 });
    const L = D.laser;
    const lens = ub.bone(`knuckle${ctx.sfx}`, fist, [0, L.y, L.z]);
    ub.glow(lens).box(L.w, L.t, L.t, kit.glowColors.laser);
    const li = ub.meta.lenses.push({ bone: lens }) - 1;
    const fire = `punch_${ctx.sfx}`;
    ub.onFire(fire, { lenses: [li] });
    ub.socket(`${ctx.sockets.sfx}_${ctx.sfx}`, fist, D.sfx);   // socket_SFX_1_L / _R: unique per robot (ProcUnit sockets are keyed by name)
    return { rig: { shoulder, elbow, fist, attack: 'punch', fire } };
  },
});

registerRobotPart('arm', 'gattling', {
  label: 'Gattling gun',
  build(ub, kit, ctx) {
    const D = ARM_SHAPES.gattling;
    const S = kit.S;
    const sg = ctx.side;
    const { shoulder, elbow, fist } = buildUpperArm(ub, kit, ctx, D, { elbowRim: false });

    // gun housing (8-point loft) from the elbow to the cluster hub, team armour outside, light line on the top face
    const eb = ub.paint(elbow);
    const Hs = D.housing;
    limbLoft(eb, kit, [0, 0, 0], D.fist, Hs.w, Hs.d, Hs.profile, S.hullDark, { points: 8 });
    const Sd = D.side;
    const sideW = (Hs.w * Hs.profile[1][1]) / 2;
    armor(eb, kit, Sd.w, Sd.h, Sd.th, S.teamPaint, {
      x: sg * (sideW + Sd.th / 2), y: D.fist[1] * Sd.at, z: D.fist[2] * Sd.at, ry: sg * HALF_PI,
    });
    const Tl = D.topLine;
    const tp = profileAt(Hs.profile, Tl.at);
    const top = frontFlat(kit, Hs.w * tp.ws, Hs.d * tp.ds, { points: 8 });
    lightLine(eb, kit, Math.min(Tl.len, tp.span * -D.fist[1] * LINE_FIT), 'y', { y: D.fist[1] * Tl.at, z: D.fist[2] * Tl.at + top.z + tp.oz + LINE_GLUE });

    // spinning barrel cluster on its own bone (child of the 'fist' hub): barrels round the axis, two clamps
    const C = D.cluster;
    const spin = ub.bone(`gattling${ctx.sfx}`, fist);
    const cb = ub.paint(spin);
    for (let i = 0; i < C.barrels; i++) {
      const a = (TAU * i) / C.barrels;
      cb.cylinder(C.r, C.r, C.len, BARREL_SEG, S.frame, { x: Math.cos(a) * C.ring, y: -C.len / 2, z: Math.sin(a) * C.ring }, true);
    }
    for (const at of C.clamps) cb.cylinder(C.clampR, C.clampR, C.clampLen, CLAMP_SEG, S.hullDark, { y: -C.len * at }, true);
    const si = ub.meta.spinners.push({ bone: spin, axis: 'y', speed: D.spin * sg }) - 1;

    // muzzle flash (hidden until fired) in front of the cluster and the shot socket (both on the non-spinning hub)
    const Fl = D.flash;
    const fl = ub.bone(`gattlingFlash${ctx.sfx}`, fist, [0, -C.len, 0]);
    ub.glow(fl).flame(Fl.near, Fl.far, Fl.len, CLAMP_SEG, UNIT_KIT.flash.color, { rx: -HALF_PI });
    ub.glow(fl).point([0, -Fl.core, 0], Fl.core, UNIT_KIT.flash.core);
    const fi = ub.meta.flashes.push({ bone: fl }) - 1;
    const socket = `${ctx.sockets.launch}${ctx.sfx}1`;   // socket_Launch_L1 / _R1 (MUZZLE.socketPatterns, unique per robot)
    ub.socket(socket, fist, [0, -C.len - LINE_OUT, 0]);
    ub.onFire(socket, { flashes: [fi], spinners: [si] });
    return { rig: { shoulder, elbow, fist, attack: 'gun', fire: socket, muzzles: [socket], shots: D.shots } };
  },
});
