// Steel Men – procedural robot legs (experiment): basic, heavyLift (T2, carries more, massive), recon (T2, sensors that
// reveal stealth). Shared rig = the GLB RobotPartsBasic legs: wrapper bone 'legs' at the pelvis height, 'pelvis' →
// thigh{L,R} (hip) → shin{L,R} (knee) → foot{L,R} (ankle), socket_TorsoMount on the pelvis. L = −x (socket_ArmLeft side).
// Geometry of every segment is authored in its bone's space (hanging down, robot faces +Z). Construction time only.
// Legs contract: build(ub, kit, ctx) → { mount: [x, y, z] (pelvis space), rig: { pelvis, chains, stride, walkFull,
// turnRadius, swing, knee, bob, sway, twist, toe } } (see RobotKit.ProcRobot).
// Sculpted (RobotSculpt), proportions after the GLB robots: slim light thigh, massive faceted team boot over the shin and
// ankle (narrow under the sunk knee shield, widening into a cuff over the instep), big faceted wedge foot (claws, heel
// spur), pelvis with team side skirts and a keel
// wedge; heavy: wide boots, pistons + swept hoses, own skirts; recon: boots widening up to the knee, sensors, lathe dishes.
import { registerRobotPart, gltfNode, block, lightLine, markingStrip } from './RobotKit.js';
import { limbLoft, hullLoft, lengthLoft, armor, hinge, piston, hose, frontFlat, sideFaceMid, edgeHalf } from './RobotSculpt.js';
import { lathe, tube } from '../ProcShapes.js';
import { unitStyle } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;       // light lines / markings stand this far off the surface
const MAST_T = 0.22;         // square sensor masts (side)
const SEG_SMALL = 6;         // sides of small tubes (piston rod, scanner base)
const DISH_SEG = 6;         // radial segments of the sensor dish (lathe)
const KEEL_TIP = 0.6;        // pelvis keel: share of its height taken by the pointed bottom
const BOOT_MARK_W = 0.35;    // hazard marking on the boot front ≤ this share of the boot width
const KNEE_SINK = 0.5;       // share of the knee shield thickness sunk into the boot rim
const LINE_FIT = 0.85;       // a light line covers at most this share of its profile segment (never past the flat face)
const LINE_GLUE = 0.02;      // light lines sit this far off the face (half of the line inside the surface)
const STRIDE_MATCH = 4;      // stride = this × leg length × sin(swing): stance foot travel ≈ body travel (little sliding)
const PELVIS_LINE = { share: 0.85, y: 0.15 };                  // front light line (share of the flat front, height share)

/**
 * Leg dimensions (raw GLB units). hip = pelvis → hip joint (x for the +x side), knee / ankle = offsets from the previous
 * joint (x mirrored per side), sole = ankle height above the ground; pelvis height = −(hip.y + knee.y + ankle.y) + sole.
 * Basic copies RobotPartsBasic/BasicLegsX_Skel.glb (pelvis 21.2 above the feet, socket_TorsoMount 0.2 / 0.3).
 */
export const LEG_SHAPES = {
  basic: {
    hip: [2.35, -1.2, 2.3], knee: [0.45, -7.1, -0.4], ankle: [-0.05, -10.1, -2.1], sole: 2.8, mount: [0, 0.2, 0.3],
    pelvis: { w: 4.6, h: 3.0, d: 5.0, y: -1.5, z: 2.2 },
    hipJoint: { r: 1.0, len: 1.8 },
    thigh: { w: 1.9, d: 2.3 },                                       // slim thigh (× LEG_SCULPT.thigh profile)
    kneeJoint: { r: 1.0, len: 2.2 },
    // massive faceted boot (team) from the knee over the ankle: narrow under the knee, widening to a cuff that covers the
    // instep (× LEG_SCULPT.boot profile); lineAt = light line centre (it runs along the profile segment there)
    boot: { w: 3.2, d: 3.4, lineAt: 0.4, lineLen: 4.2 },
    kneeShield: { w: 3.0, h: 3.4, th: 0.6, up: 0.4, tilt: 0.12 },   // up = centre above the knee joint, tilt = extra lean forward (rad)
    // faceted wedge foot (heel → toe) under the cuff, claws, heel spur
    foot: { w: 4.6, h: 2.4, len: 7.6, y: -1.6, z: 2.0, toes: 2, toeW: 1.1, toeH: 0.9, toeLen: 1.7, heelW: 1.5, heelH: 1.0, heelLen: 1.3 },
    // pelvis: side skirts (team) hanging over the thigh tops, keel wedge between the thighs
    skirtSide: { d: 0.8, h: 1.2, th: 0.35, drop: 0.35, flare: 0.16 },   // d / h shares of the pelvis, drop = × pelvis h, flare = outward tilt (rad)
    keel: { w: 2.6, h: 2.8, th: 0.5, y: -0.4, tilt: 0.28 },            // y = share of the pelvis height below its centre
    marking: { len: 2.2, h: 0.35, down: 1.4 },                      // boot marking (hazard styles), down = below the boot line centre
    // stride omitted = matched to the leg (strideOf): feet barely slide; bob = 0 (the pelvis follows the stance foot)
    gait: { walkFull: 14, turnRadius: 4, swing: 0.32, knee: 0.75, bob: 0, sway: 0.03, twist: 0.06, toe: 0.2 },
  },
  heavyLift: {
    // hips wider than the GLB-like basic legs: the massive boots must pass each other in a step
    hip: [3.5, -1.4, 2.2], knee: [0.6, -6.6, 0.9], ankle: [0, -9.6, -2.0], sole: 2.6, mount: [0, 0.3, 0.3],
    pelvis: { w: 6.2, h: 3.6, d: 5.8, y: -1.6, z: 2.0 },
    hipJoint: { r: 1.35, len: 2.2 },
    thigh: { w: 2.6, d: 3.0 },
    kneeJoint: { r: 1.4, len: 2.8 },
    boot: { w: 4.6, d: 4.8, lineAt: 0.4, lineLen: 4.6 },
    kneeShield: { w: 3.8, h: 4.0, th: 0.8, up: 0.5, tilt: 0.1 },
    foot: { w: 5.8, h: 2.6, len: 8.2, y: -1.3, z: 1.9, toes: 3, toeW: 1.2, toeH: 1.0, toeLen: 1.8, heelW: 2.0, heelH: 1.1, heelLen: 1.5 },
    keel: { w: 3.4, h: 3.2, th: 0.6, y: -0.4, tilt: 0.25 },
    marking: { len: 3, h: 0.4, down: 1.5 },
    // massive boot: wide all along, little flare at the bottom (the lifted boot passes the other foot), deep cuff
    sculpt: { boot: [[-0.05, 1, 1, 0.2], [0.18, 0.9, 0.92], [0.6, 1.02, 1, 0.1], [0.88, 1.1, 1.1, 0.2], [1.08, 1.14, 1.28, 0.6]] },
    // hydraulics: cylinder behind the thigh (housing → rod end), rod behind the boot sliding into it, a swept hose on the
    // outer side of the thigh (points for the +x side, mirrored); side skirt plates (team) replace the hip skirts
    piston: { xShare: 0.5, r: 0.55, rodR: 0.28, housingTop: -1.2, housingLen: 4.2, split: 0.8, z: -2.0, rodTop: 2.4, rodLen: 4.4, rodZ: -3.0 },
    hose: { r: 0.22, points: [[0.5, -0.9, -1.7], [1.6, -2.3, -1.1], [1.75, -4.4, 0.1]] },
    skirt: { w: 3.0, h: 2.6, th: 0.4, x: 5.4, y: -2.2, z: 2.2 },
    load: { w: 5.0, h: 0.8, d: 1.6, y: -0.4, z: -1.6 },             // rear load clamp bar
    gait: { walkFull: 11, turnRadius: 5, swing: 0.28, knee: 0.6, bob: 0, sway: 0.05, twist: 0.05, toe: 0.12 },
  },
  recon: {
    hip: [2.2, -1.1, 2.2], knee: [0.3, -7.6, -0.2], ankle: [0, -10.2, -2.3], sole: 2.4, mount: [0, 0.2, 0.3],
    pelvis: { w: 3.8, h: 2.6, d: 4.4, y: -1.3, z: 2.1 },
    hipJoint: { r: 0.85, len: 1.6 },
    thigh: { w: 1.6, d: 2.0 },
    kneeJoint: { r: 0.9, len: 1.9 },
    boot: { w: 2.6, d: 2.9, lineAt: 0.4, lineLen: 4.8 },
    kneeShield: { w: 2.4, h: 3.0, th: 0.45, up: 0.3, tilt: 0.14 },
    foot: { w: 3.6, h: 2.0, len: 6.6, y: -1.4, z: 1.9, toes: 2, toeW: 0.8, toeH: 0.7, toeLen: 2.0, heelW: 1.0, heelH: 0.7, heelLen: 1.4 },
    skirtSide: { d: 0.75, h: 1.05, th: 0.3, drop: 0.3, flare: 0.2 },
    keel: { w: 2.0, h: 2.2, th: 0.4, y: -0.4, tilt: 0.3 },
    marking: { len: 1.6, h: 0.3, down: 1.2 },
    // slim, long legs; the boot widens UP to the knee (inverted pyramid) and narrows to a slim ankle (LEG_SCULPT override)
    sculpt: { boot: [[-0.04, 1.08, 1.04, 0.15], [0.2, 1.12, 1.08, 0.1], [0.62, 0.78, 0.82, 0.05], [0.9, 0.92, 0.95, 0.15], [1.05, 1.08, 1.25, 0.5]] },
    // sensors: rotating dish (lathe bowl) on the back of each boot, swaying antenna on each thigh, hip scanner mast with a
    // laser fan, knee sensor lenses on the knee shields (pulse)
    dish: { at: [0.9, -3.4, -2.4], r: 1.1, depth: 0.45, bottomShare: 0.35, innerShare: 0.45, tilt: Math.PI / 4, backShare: 0.3, mastH: 0.7, lensR: 0.25, spin: 3.2 },
    antenna: { at: [1.0, -1.0, -0.4], h: 3.2, t: 0.12, tipR: 0.22, lean: 0.25, amp: 0.12, hz: 0.7 },
    scanner: {
      at: [0, -2.9, 3.4], baseR: 0.6, baseH: 0.6, headW: 1.2, headH: 0.7, headD: 0.9, lensShare: 0.4,
      fanLen: 1.5, fanW: 1.2, fanT: 0.03, fanGlow: 0.28, arc: 0.35, scanHz: 0.4, pulseHz: 1.3, pulseDepth: 0.5,   // short, faint fan
    },
    kneeLens: { r: 0.32, z: 1.95, y: 0.1 },
    gait: { walkFull: 15, turnRadius: 3.5, swing: 0.36, knee: 0.85, bob: 0, sway: 0.025, twist: 0.07, toe: 0.25 },
  },
};

/**
 * Sculpt profiles shared by the leg types (LEG_SHAPES[type].sculpt overrides single keys).
 * pelvis: [height share 0 bottom … 1 top, w share, d share]; thigh / shin: [t (0 hip|knee … 1 knee|ankle, beyond = past
 * the joint), w share, d share, z offset]; foot: [z share of the length (−0.5 heel … 0.5 toe), w share, h share].
 */
export const LEG_SCULPT = {
  pelvis: [[0, 0.62, 0.72], [0.38, 1, 1], [0.82, 0.95, 0.9], [1, 0.76, 0.8]],
  pelvisKeel: 0.28,
  thigh: [[-0.08, 0.95, 0.95], [0.3, 1, 1], [1.04, 0.84, 0.86]],                       // slim, slightly tapering
  // knee rim (a little forward) → narrow under the knee → calf → widening to the ankle → cuff (wide, deep, forward over the instep)
  boot: [[-0.05, 0.95, 1, 0.2], [0.16, 0.8, 0.84], [0.62, 1, 1, 0.1], [0.9, 1.28, 1.22, 0.25], [1.1, 1.36, 1.4, 0.7]],
  bootPoints: 8,    // boot section points (keeled octagon: front ridge)
  bootKeel: 0.36,
  foot: [[-0.5, 0.82, 0.9], [-0.1, 1, 1], [0.5, 0.78, 0.34]],                            // wedge: high heel, low pointed toe
  footKeel: 0.3,    // ridge on top of the foot
  footSole: 0.05,   // tiny bottom chamfer = flat sole
  clawSink: 0.3,    // share of the claw length inside the toe
};

const SIDES = [{ sign: -1, sfx: 'L' }, { sign: 1, sfx: 'R' }];

const mirror = ([x, y, z], sign) => [x * sign, y, z];

/** Pelvis height of a leg shape (feet on the ground) */
export const pelvisHeight = (D) => -(D.hip[1] + D.knee[1] + D.ankle[1]) + D.sole;

/**
 * Common leg rig + body of every leg type. Returns { mount, rig, chains (bone names per side) } and leaves the per-type
 * extras to the caller (pistons, sensors…).
 */
export function buildLegBase(ub, kit, ctx, D) {
  const S = kit.S;
  const L = { ...LEG_SCULPT, ...D.sculpt };
  ub.bone(ctx.bone, 'root', [0, pelvisHeight(D), 0], { far: true });   // own far LOD group + pick proxy (RobotKit)
  ub.bone(gltfNode(ctx, 'pelvis'), ctx.bone);
  const pb = ub.paint('pelvis');
  const P = D.pelvis;
  const y0 = P.y - P.h / 2;
  hullLoft(pb, kit, L.pelvis.map(([ys, ws, ds]) => ({ y: y0 + ys * P.h, w: P.w * ws, d: P.d * ds, z: P.z, keel: L.pelvisKeel })), S.hull);
  // side skirts in the team colour hanging over the thigh tops, flared out (heavy legs carry their own skirts instead)
  const SK = D.skirtSide;
  if (!D.skirt && SK) {
    for (const { sign } of SIDES) {
      armor(pb, kit, P.d * SK.d, P.h * SK.h, SK.th, S.teamPaint,
        { x: sign * (P.w / 2 + SK.th / 2), y: P.y - P.h * SK.drop, z: P.z, ry: sign * HALF_PI }, { tilt: -SK.flare });
    }
  }
  // keel wedge between the thighs (points down, top leaning forward)
  const K = D.keel;
  const ky = 0.5 + K.y;
  const kf = frontFlat(kit, P.w * stationAt(L.pelvis, ky, 1), P.d * stationAt(L.pelvis, ky, 2), { keel: L.pelvisKeel });
  armor(pb, kit, K.w, K.h, K.th, S.teamPaint,
    { y: y0 + ky * P.h, z: P.z + kf.z + K.th / 2, rx: K.tilt }, { corner: 'shield', tip: KEEL_TIP });
  const lineY = 0.5 + PELVIS_LINE.y;
  const ff = frontFlat(kit, P.w * stationAt(L.pelvis, lineY, 1), P.d * stationAt(L.pelvis, lineY, 2), { keel: L.pelvisKeel });
  lightLine(pb, kit, ff.w * PELVIS_LINE.share, 'x', { y: y0 + lineY * P.h, z: P.z + ff.z + LINE_OUT });

  const chains = [];
  for (const { sign, sfx } of SIDES) {
    const hip = mirror(D.hip, sign);
    const knee = mirror(D.knee, sign);
    const ankle = mirror(D.ankle, sign);
    const thigh = gltfNode(ctx, `thigh${sfx}`);
    const shin = gltfNode(ctx, `shin${sfx}`);
    const foot = gltfNode(ctx, `foot${sfx}`);
    ub.bone(thigh, 'pelvis', hip);
    ub.bone(shin, thigh, knee);
    ub.bone(foot, shin, ankle);
    chains.push({ side: sign, thigh, shin, foot });

    // hip hub on the pelvis side, slim light thigh
    hinge(pb, kit, D.hipJoint.r, D.hipJoint.len, S.frame, { x: hip[0], y: hip[1], z: hip[2] });
    const T = D.thigh;
    limbLoft(ub.paint(thigh), kit, [0, 0, 0], knee, T.w, T.d, L.thigh, S.hull);

    // knee hub, massive faceted team boot (knee → over the ankle), big knee shield, light line on the outer side
    const sb = ub.paint(shin);
    const KJ = D.kneeJoint;
    hinge(sb, kit, KJ.r, KJ.len, S.frame, {});
    const B = D.boot;
    const sLen = limbLoft(sb, kit, [0, 0, 0], ankle, B.w, B.d, L.boot, S.teamPaint, { points: L.bootPoints, keel: L.bootKeel });
    // knee shield sunk into the top rim of the boot (only the front half stands out)
    const KS = D.kneeShield;
    const kt = -KS.up / sLen;
    const kp = onLimbFront(ankle, kt, (B.d * stationAt(L.boot, kt, 2)) / 2 + stationAt(L.boot, kt, 3) + KS.th * (0.5 - KNEE_SINK));
    armor(sb, kit, KS.w, KS.h, KS.th, S.teamShade, { x: kp.x, y: kp.y, z: kp.z, rx: kp.rx + KS.tilt });
    // light line glued to the flat outer side along the profile segment around lineAt (follows its taper)
    const seg = segmentAround(L.boot, B.lineAt);
    const lt = (seg[0] + seg[1]) / 2;
    const lineLen = Math.min(B.lineLen, (seg[1] - seg[0]) * sLen * LINE_FIT);
    const dx = (B.w * (stationAt(L.boot, seg[1], 1) - stationAt(L.boot, seg[0], 1))) / 2;
    const taper = Math.atan2(dx, (seg[1] - seg[0]) * sLen);
    if (kit.style.markings !== 'light') {   // hazard styles: marking across the boot front (light styles: the side line)
      const M = D.marking;
      const mp = onLimbFront(ankle, lt + M.down / sLen, (B.d * stationAt(L.boot, lt, 2)) / 2 + stationAt(L.boot, lt, 3) + LINE_OUT);
      markingStrip(sb, kit, Math.min(M.len, B.w * BOOT_MARK_W), M.h, { x: mp.x, y: mp.y, z: mp.z, rx: mp.rx });
    }
    const sideX = sign * ((B.w * stationAt(L.boot, lt, 1)) / 2 + LINE_GLUE);
    const sideZ = sideFaceMid(kit, B.w * stationAt(L.boot, lt, 1), B.d * stationAt(L.boot, lt, 2), L.bootKeel) + stationAt(L.boot, lt, 3);
    lightLine(sb, kit, lineLen, 'y', {
      x: ankle[0] * lt + sideX, y: ankle[1] * lt - Math.sin(kp.rx) * sideZ, z: ankle[2] * lt + Math.cos(kp.rx) * sideZ, rx: kp.rx, rz: sign * taper,
    });

    // faceted wedge foot under the cuff (the boot hides the ankle): heel → low pointed toe (no claws / spur / glow edge: B4 triangle trim)
    footShape(ub.paint(foot), kit, D.foot, S, L);
  }
  return {
    mount: D.mount,
    chains,
    rig: {
      pelvis: 'pelvis', chains, ...D.gait, stride: D.gait.stride ?? strideOf(D),
      soles: solePoints(kit, D.foot, L), shinPoints: cuffPoints(kit, D, L),
    },
  };
}

/**
 * Lowest points of the boot cuff in shin space [z, y]: front and back bottom edges of the last boot station. The cuff
 * reaches below the ankle and forward over the instep, so when the shin tilts (crouch, early swing) its front edge can
 * dip lower than the sole – the ProcRobot ground contact keeps it above the ground too.
 */
function cuffPoints(kit, D, L) {
  const row = L.boot[L.boot.length - 1];
  const t = row[0];
  const w = D.boot.w * row[1];
  const d = D.boot.d * row[2];
  const oz = row[3] ?? 0;
  const rx = Math.atan2(-D.ankle[2], -D.ankle[1]);
  const ay = D.ankle[1] * t;
  const az = D.ankle[2] * t;
  const o = { keel: L.bootKeel, points: L.bootPoints };
  const at = (v, front) => [az + Math.cos(rx) * v, ay - Math.sin(rx) * v, edgeHalf(kit, w, d, front, o)];
  return [at(oz + d / 2, true), at(oz - d / 2, false)];
}

/**
 * Lowest points of the foot in foot space [z, y] (the ProcRobot ground contact keeps the lowest one on the ground):
 * heel and toe bottom edges, claw tips, heel spur tip – same positions footShape builds.
 */
function solePoints(kit, F, L) {
  const yBot = F.y - F.h / 2;
  const first = L.foot[0];
  const last = L.foot[L.foot.length - 1];
  const heel = F.z + first[0] * F.len;
  const toe = F.z + last[0] * F.len;
  // third value = how far the point reaches sideways (bottom edge half width): a rolled pelvis lowers the outer edge
  const bottom = (row) => edgeHalf(kit, F.w * row[1], F.h * row[2], false, { keel: L.footKeel, back: L.footSole });
  return [[heel, yBot, bottom(first)], [toe, yBot, bottom(last)]];
}

/**
 * Stride (units per gait cycle) matched to the leg: a straight leg swinging ±swing about the hip moves its foot
 * 2 · L · sin(swing) per half cycle, the body moves stride / 2 → stride = 4 · L · sin(swing) (L = hip → ankle).
 */
export function strideOf(D) {
  const ly = D.knee[1] + D.ankle[1];
  const lz = D.knee[2] + D.ankle[2];
  return STRIDE_MATCH * Math.hypot(ly, lz) * Math.sin(D.gait.swing);
}

function footShape(fb, kit, F, S, L) {
  const yBot = F.y - F.h / 2;
  lengthLoft(fb, kit, L.foot.map(([zs, ws, hs]) => ({
    z: F.z + zs * F.len, w: F.w * ws, h: F.h * hs, y: yBot + (F.h * hs) / 2, keel: L.footKeel, back: L.footSole,
  })), S.hullDark);
  // claws (toes) and heel spur dropped in B4: ~6 triangles each, not readable from the RTS camera
}

/** [t0, t1] of the profile segment that contains t */
function segmentAround(profile, t) {
  for (let i = 1; i < profile.length; i++) if (t <= profile[i][0]) return [profile[i - 1][0], profile[i][0]];
  return [profile[profile.length - 2][0], profile[profile.length - 1][0]];
}

/** Linear value of profile column `col` at t (profile rows sorted by column 0; missing column → 0) */
function stationAt(profile, t, col) {
  const v = (row) => row[col] ?? 0;
  if (t <= profile[0][0]) return v(profile[0]);
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (t <= b[0]) return v(a) + ((v(b) - v(a)) * (t - a[0])) / (b[0] - a[0]);
  }
  return v(profile[profile.length - 1]);
}

/**
 * Panel placement on the front of a limb running from the bone origin to `end`, at share t, `dist` in front of the axis:
 * { x, y, z, rx } – rx tilts a +Z panel with the limb (front normal (0, −sin rx, cos rx)).
 */
function onLimbFront(end, t, dist) {
  const rx = Math.atan2(-end[2], -end[1]);
  return { x: end[0] * t, y: end[1] * t - Math.sin(rx) * dist, z: end[2] * t + Math.cos(rx) * dist, rx };
}

// ---------------------------------------------------------------- basic

registerRobotPart('legs', 'basic', {
  label: 'Basic legs',
  build(ub, kit, ctx) {
    return buildLegBase(ub, kit, ctx, LEG_SHAPES.basic);
  },
});

// ---------------------------------------------------------------- heavy lifting (T2)

registerRobotPart('legs', 'heavyLift', {
  label: 'Heavy lifting legs',
  build(ub, kit, ctx) {
    const D = LEG_SHAPES.heavyLift;
    const out = buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const pb = ub.paint('pelvis');
    const Pi = D.piston;
    const Ho = D.hose;
    for (const c of out.chains) {
      // hydraulic cylinder behind the thigh (housing + rod end), rod behind the shin (slides into it as the knee bends),
      // swept hose curving round the outer side of the thigh
      const knee = mirror(D.knee, c.side);
      const tb = ub.paint(c.thigh);
      const x = knee[0] * Pi.xShare;
      piston(tb, kit, [x, Pi.housingTop, Pi.z], [x, Pi.housingTop - Pi.housingLen, Pi.z], Pi.r, S.frame, S.pipe, { split: Pi.split });
      ub.paint(c.shin).add(tube([[0, Pi.rodTop, Pi.rodZ], [0, Pi.rodTop - Pi.rodLen, Pi.rodZ]], Pi.rodR, SEG_SMALL), S.pipe, { detail: 0 });
      hose(tb, kit, Ho.points.map((p) => mirror(p, c.side)), Ho.r, S.pipe);
      // side skirt plate (team) on the pelvis, outside each hip
      const K = D.skirt;
      armor(pb, kit, K.w, K.h, K.th, S.teamPaint, { x: c.side * K.x, y: K.y, z: K.z, ry: c.side * HALF_PI });
    }
    const Ld = D.load;
    pb.box(Ld.w, Ld.h, Ld.d, S.frame, { y: Ld.y, z: Ld.z });   // plain box: heavy legs are the heaviest part (budget)
    return out;
  },
});

// ---------------------------------------------------------------- recon (T2)

registerRobotPart('legs', 'recon', {
  label: 'Recon legs',
  build(ub, kit, ctx) {
    const D = LEG_SHAPES.recon;
    const out = buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const sensor = unitStyle(kit).weaponGlow;
    const X = ctx.robot.extras;
    const Di = D.dish;
    const An = D.antenna;
    const KL = D.kneeLens;
    for (const c of out.chains) {
      const sfx = c.side > 0 ? 'R' : 'L';
      // rotating sensor dish on the back of the shin
      const dish = ub.bone(`reconDish${sfx}`, c.shin, mirror(Di.at, c.side));
      const db = ub.paint(dish);
      db.box(MAST_T, Di.mastH, MAST_T, S.frame, { y: Di.mastH / 2, detail: 0 });
      // dish bowl (lathe: flat bottom, flared wall, hollow inside) tilted up and back, lens in its centre
      const bowl = lathe([[0, 0], [Di.r * Di.bottomShare, 0], [Di.r, Di.depth], [0, Di.depth * Di.innerShare]], { segments: DISH_SEG, crease: 0 });
      db.add(bowl, S.hull, { y: Di.mastH, rx: -Di.tilt, z: -Di.depth * Di.backShare });
      ub.glow(dish).point([0, Di.mastH + Di.depth, -Di.depth * Di.backShare], Di.lensR, sensor);
      X.spin.push({ bone: dish, axis: 'y', speed: Di.spin * c.side });
      // swaying antenna on the outer side of the thigh, leaning outwards
      const ant = ub.bone(`reconAnt${sfx}`, c.thigh, mirror(An.at, c.side), { rotation: [0, 0, -An.lean * c.side] });
      const ab = ub.paint(ant);
      ab.box(An.t, An.h, An.t, S.frame, { y: An.h / 2, detail: 0 });
      ub.glow(ant).point([0, An.h, 0], An.tipR, kit.glowColors.beacon);
      X.sway.push({ bone: ant, axis: 'z', amp: An.amp * c.side, hz: An.hz });
      // knee sensor lens (pulse via the ProcUnit lens driver)
      const lens = ub.bone(`reconKneeLens${sfx}`, c.shin, [0, KL.y, KL.z]);
      ub.glow(lens).point([0, 0, 0], KL.r, sensor);
      ub.meta.lenses.push({ bone: lens });
    }
    // scanner hanging under the front of the pelvis, a sweeping laser fan (reveals stealth)
    const Sc = D.scanner;
    const scan = ub.bone('reconScanner', 'pelvis', Sc.at);
    const sb = ub.paint('pelvis');
    sb.cylinder(Sc.baseR, Sc.baseR, Sc.baseH, SEG_SMALL, S.frame, { x: Sc.at[0], y: Sc.at[1] + Sc.baseH / 2, z: Sc.at[2] }, true);
    block(ub.paint(scan), kit, Sc.headW, Sc.headH, Sc.headD, S.hullDark, { y: -Sc.headH / 2 });
    const fan = ub.bone('reconFan', scan, [0, -Sc.headH / 2, Sc.headD / 2]);
    ub.glow(fan).box(Sc.fanW, Sc.fanT, Sc.fanLen, sensor, { z: Sc.fanLen / 2, intensity: Sc.fanGlow });
    ub.glow(fan).point([0, 0, 0], Sc.headH * Sc.lensShare, sensor);
    X.sway.push({ bone: scan, axis: 'y', amp: Sc.arc, hz: Sc.scanHz });
    X.pulse.push({ bone: fan, depth: Sc.pulseDepth, hz: Sc.pulseHz });
    return out;
  },
});
