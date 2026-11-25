// Steel Men – procedural melee arms and shields (B6): armorFist, frameFist, axe, bladeArm, electroGrip, hammerHand,
// katana, laserSword, multiClaw, powerFist, rotaryBlade, shield, energyShield. Same rig contract as the basic fist
// (RobotArms.js): bones 'shoulder{L,R}' → 'elbow{L,R}' → 'fist{L,R}' (GLB-like nodes), arm built for its side
// (ctx.side −1 = left = −x), robot faces +Z, socket_SFX_1_<L|R> (hit spark, on the weapon tip where there is one),
// rig { shoulder, elbow, fist, attack, fire }. Construction time only (visual over the hidden GLB body).
// Weapons hang from the hand along −Y of a weapon bone (child of 'fist', tilted forward: ARM_MELEE.*.tilt) so the swing /
// punch clips (ROBOT_KIT.anim.punch / swing) move them like the GLB arms: axe, hammerHand, bladeArm, katana,
// laserSword, multiClaw → 'swing'; fists, electroGrip, rotaryBlade → 'punch'. Shields have no attack (rig 'punch', unused).
// Fire effects (ub.onFire, driven by the ProcUnit): rotaryBlade spinner (spins up on every hit), powerFist /
// laserSword lens flare, electroGrip arcs (flicker harder on a hit). energyShield: static pane + breathing core lens.
// Style (kit.style.silhouette) changes block / plate shapes (kit primitives), blade sharpness and claw sides only.
import { registerRobotPart, block, plate, limbBetween, lightLine } from './RobotKit.js';
import { hullLoft, limbLoft, armor, piston } from './RobotSculpt.js';
import { ARM_SHAPES, buildUpperArm } from './RobotArms.js';
import { UNIT_KIT } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const MELEE_SEG = 6;         // hafts, prongs, hilts (closed cylinders)
const SAW_SEG = 8;           // rotary blade disc
const PRONG_SEG = 5;         // electroGrip prongs (open tubes: triangle budget)
const DEFAULT_SFX = [0, -2.5, 0.9];   // socket_SFX_1_<L|R> on the fist (GLB: socket_SFX_1)
const SPIN_SPEED = 26;       // rad/s of the saw at full spin (spin-up / linger: UNIT_KIT.spin)
const LINE_GLUE = 0.03;      // light line lift off a flat face

// Blade tip depth share (sharper on angular / faceted) and claw cross-section sides, by silhouette (data, no race names)
const BLADE_TIP = { angular: 0.2, faceted: 0.25, rounded: 0.4, round: 0.5 };
const CLAW_SIDES = { angular: 4, faceted: 4, rounded: 5, round: 6 };
const BLADE_TOP_W = 0.4;     // blade width at the tip end (share of the base width)
const bladeTip =(kit) => BLADE_TIP[kit.style.silhouette] ?? BLADE_TIP.rounded;
const clawSides = (kit) => CLAW_SIDES[kit.style.silhouette] ?? CLAW_SIDES.rounded;

// Shoulder / elbow / pauldron values shared with every arm of RobotArms.js (right arm values, mirrored by ctx.side)
const BASE = (({ elbow, fist, pad, padLoft, fin, shoulderJoint, upper, elbowJoint }) => (
  { elbow, fist, pad, padLoft, fin, shoulderJoint, upper, elbowJoint }
))(ARM_SHAPES.fist);
const FORE_PROFILE = [[-0.07, 0.78, 0.8], [0.55, 1, 1, 0.08], [1.04, 1.02, 1.0]];   // forearm flaring to the wrist
const HAND_LOFT = [[0, 0.88, 0.85], [0.5, 1, 1], [1, 0.9, 0.86]];                  // hand stations [height share, w, d]
const HAND = { w: 2.8, h: 2.5, d: 3.0, y: -1.4, z: 0.5, paint: 'hullDark' };         // paint = kit.S role
const THUMB = { w: 0.6, h: 1.4, d: 0.9, x: 1.5, y: -1.1, z: 1.0 };

/**
 * Arm dimensions (raw GLB units, x for the RIGHT arm; mirrored for the left). fore = forearm loft (null = none),
 * hand = lofted hand, tilt = forward tilt (rad, rx) of the weapon bone.
 */
export const ARM_MELEE = {
  armorFist: {
    ...BASE,
    pad: { ...BASE.pad, w: 5.4, h: 3.8, d: 5.6 },
    fore: { w: 4.7, d: 4.6, paint: 'teamPaint' },
    hand: { ...HAND, w: 4.2, h: 3.4, d: 4.0, y: -1.8, z: 0.6 },
    thumb: THUMB,
    sidePlate: { w: 5.6, h: 5.4, th: 0.7, x: 2.9, y: -2.9, z: 0.3 },        // heavy armour slab on the outer side
    frontPlate: { w: 4.2, h: 4.2, th: 0.6, y: -2.9, z: 2.9 },
    knuckles: { w: 1.3, h: 1.3, d: 1.3, gap: 1.4, y: -2.7, z: 2.5 },
  },
  frameFist: {
    ...BASE,
    fore: null,
    hand: { ...HAND, w: 2.1, h: 2.0, d: 2.3, y: -1.2 },
    thumb: { ...THUMB, w: 0.4, h: 1.0, x: 1.1 },
    rods: { x: 0.8, w: 0.5, bars: [0.3, 0.7], barH: 0.35, barD: 0.5, spineLen: 3.2, spineAt: 0.5 },   // two open rods + cross bars
    plate: { w: 2.2, h: 2.4, th: 0.3, y: -1.9, z: 0.9 },                     // small team plate on the front rod bar
    knuckles: { w: 2.2, h: 0.5, d: 0.6, y: -2.0, z: 1.5 },
  },
  powerFist: {
    ...BASE,
    pad: { ...BASE.pad, w: 5.0, h: 3.6 },
    fore: { w: 5.2, d: 4.8, paint: 'teamPaint' },
    hand: { ...HAND, w: 5.6, h: 4.2, d: 4.8, y: -2.0, z: 0.7 },
    thumb: { ...THUMB, w: 0.9, h: 1.8, x: 2.2, y: -1.4, z: 1.2 },
    knuckles: { w: 5.8, h: 1.3, d: 1.4, y: -3.5, z: 3.2 },
    pistons: { x: 3.1, r: 0.38, fromY: -0.7, fromZ: 0.5, toY: 0.6, toZ: 0.3 },   // hydraulic rams outside the forearm (toY = past the wrist)
    laser: { w: 5.0, t: 0.3, y: -3.5, z: 3.95 },                             // knuckle impact lens (flares on a punch)
  },
  multiClaw: {
    ...BASE,
    fore: { w: 3.4, d: 3.4, paint: 'hull' },
    hand: { ...HAND, w: 3.4, h: 2.4, d: 3.2 },
    thumb: null,
    mount: { w: 3.6, h: 1.0, d: 2.2, y: -2.3, z: 0.9 },                      // claw mount block (team colour)
    tilt: -0.55,
    claws: { count: 3, gap: 1.15, r: 0.4, tipR: 0.05, start: 1.2, len: 3.8, hook: 1.8, curl: 0.55, splay: 0.14 },
  },
  axe: {
    ...BASE,
    fore: { w: 3.3, d: 3.3, paint: 'hull' },
    hand: HAND,
    thumb: THUMB,
    tilt: -0.85,
    haft: { r: 0.45, len: 9.6, top: 1.6 },
    head: { w: 5.2, h: 5.6, th: 0.75, x: 2.1, y: -6.8, z: 0.4 },   // blade plate facing forward, outboard of the haft (readable from the front)
    poll: { w: 1.7, h: 2.6, d: 1.9, y: -6.8, z: 0.0 },
    collar: { r: 0.8, h: 1.1, y: -4.4 },
    spike: { r: 0.36, len: 1.5 },
  },
  hammerHand: {
    ...BASE,
    pad: { ...BASE.pad, w: 5.0, h: 3.6 },
    fore: { w: 3.9, d: 3.8, paint: 'teamPaint' },
    hand: { ...HAND, w: 3.2, h: 2.8, d: 3.3 },
    thumb: THUMB,
    tilt: -0.8,
    haft: { r: 0.55, len: 8.2, top: 1.6 },
    head: { w: 4.6, h: 4.6, d: 7.4, y: -6.6, z: 0.6 },                       // big hammer head, striking faces at both z ends
    face: { w: 4.0, h: 4.0, th: 0.6 },
    band: { grow: 0.25, hShare: 0.35, dShare: 0.4 },                         // team band round the head
  },
  bladeArm: {
    ...BASE,
    fore: { w: 3.4, d: 3.4, paint: 'hull' },
    hand: { ...HAND, w: 2.4, h: 2.2, d: 2.6 },
    thumb: null,
    sidePlate: { w: 3.6, h: 2.6, th: 0.35, x: 1.9, y: -2.7, z: 0.3 },        // team armour blade along the forearm
    tilt: -0.45,
    blade: { len: 9.8, start: 1.0, th: 2.0, d: 0.6 },   // th = width seen from the front (x), d = thickness (z)
    guard: { w: 3.0, h: 0.6, d: 1.6, y: 0.6 },
  },
  katana: {
    ...BASE,
    fore: { w: 3.0, d: 3.1, paint: 'hull' },
    hand: HAND,
    thumb: THUMB,
    tilt: -0.9,
    handle: { r: 0.5, len: 3.2, top: 1.4 },
    guard: { r: 1.5, h: 0.3, y: -1.8 },
    blade: { len1: 6.4, len2: 4.4, start: 1.95, th: 1.8, d: 0.45, curve: 0.12 },   // th = width seen from the front
  },
  laserSword: {
    ...BASE,
    fore: { w: 3.0, d: 3.1, paint: 'hull' },
    hand: HAND,
    thumb: THUMB,
    tilt: -0.8,
    hilt: { r: 0.58, len: 3.4, top: 1.4 },
    guard: { w: 3.8, h: 0.5, d: 1.3, y: -2.0 },
    emitter: { r: 0.85, h: 0.8, y: -2.2 },
    blade: { len: 10, start: 2.4, core: 0.55, halo: 1.5, haloPower: 0.6 },  // static glow beam (core white, halo weapon glow)
    tip: { r: 1.5 },                                                          // tip lens (flares on a hit)
  },
  electroGrip: {
    ...BASE,
    fore: { w: 3.5, d: 3.5, paint: 'hull' },
    hand: { ...HAND, w: 3.0 },
    thumb: THUMB,
    tilt: -0.5,
    housing: { w: 3.6, h: 1.6, d: 3.2, y: -2.0 },                            // team insulator block under the hand
    coil: { r: 2.1, tube: 0.12, y: -2.0 },                                   // coil ring lens (pulses)
    prongs: { count: 3, gap: 1.2, r: 0.28, tipR: 0.18, start: 2.7, len: 4.4, tip: 0.38 },
    arcs: [{ from: 0, to: 1, at: 0.55, thick: 0.14, zig: 0.35 }, { from: 1, to: 2, at: 0.85, thick: 0.14, zig: 0.3 }],   // between prong pairs (by index)
  },
  rotaryBlade: {
    ...BASE,
    fore: { w: 3.4, d: 3.4, paint: 'hull' },
    hand: { ...HAND, w: 2.6 },
    thumb: THUMB,
    strut: { w: 1.0, h: 1.0, d: 2.8, y: -2.3, z: 2.0 },
    hub: { r: 0.7, len: 0.9, y: -2.3, z: 3.5 },                              // saw hub (spinner bone origin)
    disc: { r: 3.4, th: 0.4 },
    teeth: { count: 3, w: 0.45, h: 1.3, d: 0.7 },
    guard: { w: 4.0, h: 2.2, th: 0.35, x: 0.6, up: 1.5 },                    // team guard over the upper saw edge
  },
  shield: {
    ...BASE,
    fore: { w: 2.8, d: 3.0, paint: 'hull' },
    hand: { ...HAND, w: 2.4, h: 2.2, d: 2.5 },
    thumb: null,
    plate: { w: 7.4, h: 10.6, th: 1.2, x: 2.4, y: -3.4, z: 3.3 },             // team face of the shield
    rim: { grow: 1.3, th: 0.6, dz: -0.5 },                                   // frame slab behind the face
    boss: { w: 3.0, h: 3.4, d: 1.2 },
    stripeShare: 0.6,
    straps: { w: 3.2, h: 1.1, d: 2.0, x: 1.3, z: 2.0, ys: [-1.4, -4.8] },
  },
  energyShield: {
    ...BASE,
    fore: { w: 3.2, d: 3.3, paint: 'hull' },
    hand: { ...HAND, w: 2.4, h: 2.2, d: 2.5 },
    thumb: null,
    emitter: { w: 3.8, h: 2.2, d: 3.2, y: -4.6, z: 0.7 },                    // team projector block at the wrist
    pane: { w: 6.6, h: 9.6, t: 0.14, x: 2.4, y: -3.4, z: 3.8, intensity: 0.12 },   // translucent energy pane (double-sided glow)
    frame: { bar: 0.8, depth: 0.9, rodW: 0.6 },                                 // solid team frame round the pane + struts
    core: { r: 2.0 },                                                         // centre lens (breathing)
  },
};

// ---------------------------------------------------------------- shared pieces

/** Upper arm (shared) + forearm loft + hand loft (+ thumb) – the bones and their paint builders */
function baseArm(ub, kit, ctx, D) {
  const S = kit.S;
  const sg = ctx.side;
  const { shoulder, elbow, fist } = buildUpperArm(ub, kit, ctx, D, { elbowRim: false });
  const eb = ub.paint(elbow);
  if (D.fore) limbLoft(eb, kit, [0, 0, 0], D.fist, D.fore.w, D.fore.d, FORE_PROFILE, S[D.fore.paint]);
  const fb = ub.paint(fist);
  const H = D.hand;
  const hy0 = H.y - H.h / 2;
  hullLoft(fb, kit, HAND_LOFT.map(([ys, ws, ds]) => ({ y: hy0 + ys * H.h, w: H.w * ws, d: H.d * ds, z: H.z })), S[H.paint]);
  const T = D.thumb;
  if (T) fb.box(T.w, T.h, T.d, S.frame, { x: -sg * T.x, y: T.y, z: T.z, detail: 0 });
  return { shoulder, elbow, fist, eb, fb };
}

/** Weapon bone: child of 'fist' at the hand centre, tilted forward; everything of the weapon hangs along its −Y */
function weaponBone(ub, ctx, a, D, name) {
  return ub.bone(`${name}${ctx.sfx}`, a.fist, [0, D.hand.y, D.hand.z], { rotation: [D.tilt, 0, 0] });
}

/** Registers the fire entry, the SFX socket and returns the part result (sfx = { bone, at } overrides the fist socket) */
function finish(ub, ctx, a, attack, fx = {}, sfx = null) {
  const fire = `${attack}_${ctx.sfx}`;
  ub.onFire(fire, fx);
  const at = sfx ?? { bone: a.fist, at: DEFAULT_SFX };
  ub.socket(`${ctx.sockets.sfx}_${ctx.sfx}`, at.bone, at.at);   // socket_SFX_1_L / _R: unique per robot
  return { rig: { shoulder: a.shoulder, elbow: a.elbow, fist: a.fist, attack, fire } };
}

/** Straight blade hanging along −Y from y = −start (tapered, tip depth by style); thickness th (x), width d (z). Returns nothing */
function bladeSeg(wp, kit, s, th, len, d, start, t = {}) {
  const tip = bladeTip(kit);
  wp.taperedBox(th, th * BLADE_TOP_W, len, d, s, { y: -start, rz: Math.PI, ...t }, d * tip);
}

// ---------------------------------------------------------------- fists

registerRobotPart('arm', 'armorFist', {
  label: 'Armor fist',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.armorFist;
    const S = kit.S;
    const sg = ctx.side;
    const a = baseArm(ub, kit, ctx, D);
    const P = D.sidePlate;
    armor(a.eb, kit, P.w, P.h, P.th, S.hull, { x: sg * P.x, y: P.y, z: P.z, ry: sg * HALF_PI });
    const Fr = D.frontPlate;
    armor(a.eb, kit, Fr.w, Fr.h, Fr.th, S.hullDark, { y: Fr.y, z: Fr.z });
    const K = D.knuckles;
    for (let i = -1; i <= 1; i++) a.fb.box(K.w, K.h, K.d, S.frame, { x: i * K.gap, y: K.y, z: K.z });
    return finish(ub, ctx, a, 'punch');
  },
});

registerRobotPart('arm', 'frameFist', {
  label: 'Frame fist',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.frameFist;
    const S = kit.S;
    const a = baseArm(ub, kit, ctx, D);
    // forearm = two open rods (elbow → wrist) joined by cross bars, small team plate and a light spine between them
    const R = D.rods;
    for (const s of [-1, 1]) limbBetween(a.eb, kit, [s * R.x, 0, 0], [s * R.x * 0.8, D.fist[1], D.fist[2]], R.w, R.w, S.frame);
    for (const at of R.bars) a.eb.box(R.x * 2 + R.w, R.barH, R.barD, S.hullDark, { y: D.fist[1] * at, z: D.fist[2] * at });
    const Pl = D.plate;
    armor(a.eb, kit, Pl.w, Pl.h, Pl.th, S.teamPaint, { y: Pl.y, z: Pl.z });
    lightLine(a.eb, kit, R.spineLen, 'y', { y: D.fist[1] * R.spineAt, z: D.fist[2] * R.spineAt + Pl.th / 2 + Pl.z + LINE_GLUE });
    const K = D.knuckles;
    a.fb.box(K.w, K.h, K.d, S.frame, { y: K.y, z: K.z });
    return finish(ub, ctx, a, 'punch');
  },
});

registerRobotPart('arm', 'powerFist', {
  label: 'Power fist',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.powerFist;
    const S = kit.S;
    const sg = ctx.side;
    const a = baseArm(ub, kit, ctx, D);
    const K = D.knuckles;
    a.fb.box(K.w, K.h, K.d, S.frame, { y: K.y, z: K.z });
    const Pi = D.pistons;
    for (const s of [-1, 1]) {
      piston(a.eb, kit, [s * Pi.x, Pi.fromY, Pi.fromZ], [s * Pi.x * 0.85, D.fist[1] - Pi.toY, D.fist[2] + Pi.toZ], Pi.r, S.hullDark, S.pipe);
    }
    // knuckle impact lens (like the basic fist laser edge)
    const L = D.laser;
    const lens = ub.bone(`knuckle${ctx.sfx}`, a.fist, [0, L.y, L.z]);
    ub.glow(lens).box(L.w, L.t, L.t, kit.glowColors.laser);
    const li = ub.meta.lenses.push({ bone: lens }) - 1;
    return finish(ub, ctx, a, 'punch', { lenses: [li] }, { bone: a.fist, at: [0, L.y, L.z] });
  },
});

registerRobotPart('arm', 'multiClaw', {
  label: 'Multi claw',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.multiClaw;
    const S = kit.S;
    const a = baseArm(ub, kit, ctx, D);
    const M = D.mount;
    a.fb.box(M.w, M.h, M.d, S.teamPaint, { y: M.y, z: M.z });
    const wb = weaponBone(ub, ctx, a, D, 'claws');
    const wp = ub.paint(wb);
    const C = D.claws;
    const sides = clawSides(kit);
    const hookR = C.r * 0.6;
    for (let i = 0; i < C.count; i++) {
      const k = i - (C.count - 1) / 2;
      const x = k * C.gap;
      wp.cylinder(C.r, C.tipR * 2, C.len, sides, S.pipe, { x, y: -C.start - C.len / 2, rz: -k * D.claws.splay });
      // hooked tip: second cone tilted forward (+Z) from the end of the claw
      wp.cylinder(hookR, C.tipR * 0.5, C.hook, sides, S.pipe, {
        x, y: -C.start - C.len - (C.hook / 2) * Math.cos(C.curl), z: (C.hook / 2) * Math.sin(C.curl), rx: -C.curl, rz: -k * C.splay,
      });
    }
    const tipAt = [0, -C.start - C.len - C.hook * 0.5, C.hook * 0.4];
    return finish(ub, ctx, a, 'swing', {}, { bone: wb, at: tipAt });
  },
});

// ---------------------------------------------------------------- hafted weapons

registerRobotPart('arm', 'axe', {
  label: 'Axe',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.axe;
    const S = kit.S;
    const a = baseArm(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'axe');
    const wp = ub.paint(wb);
    const H = D.haft;
    wp.cylinder(H.r, H.r, H.len, MELEE_SEG, S.hullDark, { y: H.top - H.len / 2 });
    const Sp = D.spike;
    wp.cylinder(Sp.r, 0.04, Sp.len, 5, S.pipe, { y: H.top - H.len - Sp.len / 2 });
    const C = D.collar;
    wp.cylinder(C.r, C.r, C.h, MELEE_SEG, S.teamPaint, { y: C.y });
    const Hd = D.head;
    plate(wp, kit, Hd.w, Hd.h, Hd.th, S.pipe, { x: ctx.side * Hd.x, y: Hd.y, z: Hd.z });   // blade plate facing forward, outboard of the haft
    const Po = D.poll;
    block(wp, kit, Po.w, Po.h, Po.d, S.hullDark, { y: Po.y, z: Po.z });
    return finish(ub, ctx, a, 'swing', {}, { bone: wb, at: [ctx.side * (Hd.x + Hd.w / 2), Hd.y, Hd.z] });
  },
});

registerRobotPart('arm', 'hammerHand', {
  label: 'Hammer hand',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.hammerHand;
    const S = kit.S;
    const a = baseArm(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'hammer');
    const wp = ub.paint(wb);
    const H = D.haft;
    wp.cylinder(H.r, H.r, H.len, MELEE_SEG, S.hullDark, { y: H.top - H.len / 2 });
    const Hd = D.head;
    block(wp, kit, Hd.w, Hd.h, Hd.d, S.hullDark, { y: Hd.y, z: Hd.z });
    const B = D.band;
    wp.box(Hd.w + B.grow, Hd.h * B.hShare, Hd.d * B.dShare, S.teamPaint, { y: Hd.y, z: Hd.z, detail: 0 });
    const F = D.face;
    for (const s of [-1, 1]) wp.box(F.w, F.h, F.th, S.frame, { y: Hd.y, z: Hd.z + s * (Hd.d / 2 + F.th * 0.3) });
    return finish(ub, ctx, a, 'swing', {}, { bone: wb, at: [0, Hd.y, Hd.z + Hd.d / 2 + F.th] });
  },
});

// ---------------------------------------------------------------- blades

registerRobotPart('arm', 'bladeArm', {
  label: 'Blade arm',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.bladeArm;
    const S = kit.S;
    const sg = ctx.side;
    const a = baseArm(ub, kit, ctx, D);
    const P = D.sidePlate;
    armor(a.eb, kit, P.w, P.h, P.th, S.teamPaint, { x: sg * P.x, y: P.y, z: P.z, ry: sg * HALF_PI });
    const wb = weaponBone(ub, ctx, a, D, 'blade');
    const wp = ub.paint(wb);
    const B = D.blade;
    const G = D.guard;
    wp.box(G.w, G.h, G.d, S.frame, { y: G.y });
    bladeSeg(wp, kit, S.pipe, B.th, B.len, B.d, B.start);
    return finish(ub, ctx, a, 'swing', {}, { bone: wb, at: [0, -B.start - B.len, 0] });
  },
});

registerRobotPart('arm', 'katana', {
  label: 'Katana',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.katana;
    const S = kit.S;
    const a = baseArm(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'katana');
    const wp = ub.paint(wb);
    const Hn = D.handle;
    wp.cylinder(Hn.r, Hn.r, Hn.len, MELEE_SEG, S.teamPaint, { y: Hn.top - Hn.len / 2 });
    wp.box(Hn.r * 2.6, Hn.r * 2, Hn.r * 2.6, S.frame, { y: Hn.top, detail: 0 });   // pommel
    const G = D.guard;
    wp.cylinder(G.r, G.r, G.h, MELEE_SEG, S.frame, { y: G.y });
    // slightly curved blade: straight base, tip segment bent forward
    const B = D.blade;
    bladeSeg(wp, kit, S.pipe, B.th, B.len1, B.d, B.start);
    bladeSeg(wp, kit, S.pipe, B.th * 0.75, B.len2, B.d * 0.9, B.start + B.len1, { rx: -B.curve });
    return finish(ub, ctx, a, 'swing', {}, { bone: wb, at: [0, -B.start - B.len1 - B.len2, B.len2 * B.curve] });
  },
});

registerRobotPart('arm', 'laserSword', {
  label: 'Laser sword',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.laserSword;
    const S = kit.S;
    const a = baseArm(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'laser');
    const wp = ub.paint(wb);
    const Hl = D.hilt;
    wp.cylinder(Hl.r, Hl.r, Hl.len, MELEE_SEG, S.frame, { y: Hl.top - Hl.len / 2 });
    wp.cylinder(Hl.r * 1.15, Hl.r * 1.15, Hl.len * 0.3, MELEE_SEG, S.teamPaint, { y: Hl.top - Hl.len * 0.4 });
    const G = D.guard;
    wp.box(G.w, G.h, G.d, S.hullDark, { y: G.y });
    const E = D.emitter;
    wp.cylinder(E.r * 0.8, E.r, E.h, MELEE_SEG, S.frame, { y: E.y });
    // beam: static glow (white core inside a weapon-glow halo)
    const B = D.blade;
    const cy = -B.start - B.len / 2;
    const gl = ub.glow(wb);
    gl.box(B.halo, B.len, B.halo, kit.glowColors.laser, { y: cy, intensity: B.haloPower });
    gl.box(B.core, B.len, B.core, UNIT_KIT.flash.core, { y: cy });
    // tip lens flares on a hit
    const tipAt = [0, -B.start - B.len, 0];
    const tip = ub.bone(`laserTip${ctx.sfx}`, wb, tipAt);
    ub.glow(tip).point([0, 0, 0], D.tip.r, kit.glowColors.laser);
    const li = ub.meta.lenses.push({ bone: tip }) - 1;
    return finish(ub, ctx, a, 'swing', { lenses: [li] }, { bone: wb, at: tipAt });
  },
});

// ---------------------------------------------------------------- energy / saw

registerRobotPart('arm', 'electroGrip', {
  label: 'Electro grip',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.electroGrip;
    const S = kit.S;
    const a = baseArm(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'grip');
    const wp = ub.paint(wb);
    const Hs = D.housing;
    wp.box(Hs.w, Hs.h, Hs.d, S.teamPaint, { y: Hs.y });
    const P = D.prongs;
    const xs = [];
    for (let i = 0; i < P.count; i++) xs.push((i - (P.count - 1) / 2) * P.gap);
    const color = kit.glowColors.laser;
    const gl = ub.glow(wb);
    for (const x of xs) {
      wp.cylinder(P.r, P.tipR, P.len, PRONG_SEG, S.frame, { x, y: -P.start - P.len / 2 }, true);
    }
    // coil ring on the housing (breathing lens)
    const C = D.coil;
    const coil = ub.bone(`gripCoil${ctx.sfx}`, wb, [0, C.y, 0]);
    ub.glow(coil).torus(C.r, C.tube, 3, 6, color, { rx: HALF_PI });
    const li = ub.meta.lenses.push({ bone: coil }) - 1;
    // lightning arcs between prong pairs (flicker; harder on a hit)
    const arcs = [];
    D.arcs.forEach((A, n) => {
      const bone = ub.bone(`gripArc${n}${ctx.sfx}`, wb, [0, -P.start - P.len * A.at, 0]);
      const x0 = xs[A.from];
      const x1 = xs[A.to];
      const pts = [[x0, 0], [(x0 + x1) / 2, A.zig], [x1, 0]];
      for (let k = 0; k < pts.length - 1; k++) {
        ub.glow(bone).segment([pts[k][0], pts[k][1], 0], [pts[k + 1][0], pts[k + 1][1], 0], A.thick, color);
      }
      arcs.push(ub.meta.arcs.push({ bone }) - 1);
    });
    return finish(ub, ctx, a, 'punch', { lenses: [li], arcs }, { bone: wb, at: [0, -P.start - P.len, 0] });
  },
});

registerRobotPart('arm', 'rotaryBlade', {
  label: 'Rotary blade',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.rotaryBlade;
    const S = kit.S;
    const sg = ctx.side;
    const a = baseArm(ub, kit, ctx, D);
    const St = D.strut;
    a.fb.box(St.w, St.h, St.d, S.frame, { y: St.y, z: St.z });
    // saw on its own spinner bone (child of the fist): disc in the YZ plane, spins about X
    const Hb = D.hub;
    const spin = ub.bone(`saw${ctx.sfx}`, a.fist, [0, Hb.y, Hb.z]);
    const sp = ub.paint(spin);
    const Ds = D.disc;
    sp.cylinder(Ds.r, Ds.r, Ds.th, SAW_SEG, S.pipe, { rz: HALF_PI });
    sp.cylinder(Hb.r, Hb.r, Hb.len, MELEE_SEG, S.frame, { rz: HALF_PI }, true);
    const T = D.teeth;
    for (let i = 0; i < T.count; i++) {
      const ang = (Math.PI * 2 * i) / T.count;
      sp.box(T.d, T.h, T.w, S.hullDark, { y: Math.cos(ang) * Ds.r, z: Math.sin(ang) * Ds.r, rx: -ang, detail: 0 });
    }
    const si = ub.meta.spinners.push({ bone: spin, axis: 'x', speed: SPIN_SPEED * sg }) - 1;
    // team guard over the upper edge of the saw (static, on the fist)
    const G = D.guard;
    a.fb.box(G.th, G.h, G.w, S.teamPaint, { x: sg * G.x, y: Hb.y + G.up, z: Hb.z });
    return finish(ub, ctx, a, 'punch', { spinners: [si] }, { bone: a.fist, at: [0, Hb.y, Hb.z + Ds.r] });
  },
});

// ---------------------------------------------------------------- shields

registerRobotPart('arm', 'shield', {
  label: 'Shield',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.shield;
    const S = kit.S;
    const sg = ctx.side;
    const a = baseArm(ub, kit, ctx, D);
    const P = D.plate;
    const px = sg * P.x;
    const R = D.rim;
    a.eb.box(P.w + R.grow, P.h + R.grow, R.th, S.frame, { x: px, y: P.y, z: P.z + R.dz, detail: 0 });   // plain slab (B4 trim: was a shaped plate)
    plate(a.eb, kit, P.w, P.h, P.th, S.teamPaint, { x: px, y: P.y, z: P.z });
    const front = P.z + P.th / 2;
    const B = D.boss;
    block(a.eb, kit, B.w, B.h, B.d, S.hull, { x: px, y: P.y, z: front + B.d * 0.3 });
    lightLine(a.eb, kit, P.h * D.stripeShare, 'y', { x: px, y: P.y + P.h * 0.05, z: front + B.d * 0.75 });
    const St = D.straps;
    for (const y of St.ys) a.eb.box(St.w, St.h, St.d, S.frame, { x: sg * St.x, y, z: St.z, detail: 0 });
    return finish(ub, ctx, a, 'punch');
  },
});

registerRobotPart('arm', 'energyShield', {
  label: 'Energy shield',
  build(ub, kit, ctx) {
    const D = ARM_MELEE.energyShield;
    const S = kit.S;
    const sg = ctx.side;
    const a = baseArm(ub, kit, ctx, D);
    const color = kit.glowColors.laser;
    const E = D.emitter;
    a.eb.box(E.w, E.h, E.d, S.teamPaint, { y: E.y, z: E.z });
    const Pn = D.pane;
    const px = sg * Pn.x;
    // solid team frame (4 bars) round a translucent glow pane (static); the core lens in the middle breathes
    const F = D.frame;
    const eb = a.eb;
    eb.box(Pn.w + F.bar, F.bar, F.depth, S.teamPaint, { x: px, y: Pn.y + Pn.h / 2, z: Pn.z });
    eb.box(Pn.w + F.bar, F.bar, F.depth, S.teamPaint, { x: px, y: Pn.y - Pn.h / 2, z: Pn.z });
    eb.box(F.bar, Pn.h, F.depth, S.teamPaint, { x: px + Pn.w / 2, y: Pn.y, z: Pn.z });
    eb.box(F.bar, Pn.h, F.depth, S.teamPaint, { x: px - Pn.w / 2, y: Pn.y, z: Pn.z });
    ub.glow(a.elbow).box(Pn.w, Pn.h, Pn.t, color, { x: px, y: Pn.y, z: Pn.z, intensity: Pn.intensity });
    // struts from the projector to the frame's top and bottom bars
    for (const s of [-1, 1]) {
      limbBetween(eb, kit, [0, E.y, E.z], [px, Pn.y + s * Pn.h / 2, Pn.z - F.depth / 2], F.rodW, F.rodW, S.frame);
    }
    const core = ub.bone(`shieldCore${ctx.sfx}`, a.elbow, [px, Pn.y, Pn.z]);
    ub.glow(core).point([0, 0, 0], D.core.r, color);
    ub.meta.lenses.push({ bone: core });
    return finish(ub, ctx, a, 'punch');
  },
});
