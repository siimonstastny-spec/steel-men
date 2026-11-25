// Steel Men – procedural arms for the T2/T3 research content (B3): ionKatana, ionPulseGun, heavyRocketArm, jetHammer,
// arcRifle, plasmaCutter, laserDisc, photonLauncher. Same rig contract as RobotArmsMelee.js / RobotArmsRanged.js:
// bones shoulder → elbow → fist (shared upper arm = buildUpperArm), arm built for its side (ctx.side −1 = left = −x),
// robot faces +Z. Melee arms hang the weapon on a weapon bone (child of 'fist', tilted forward) and use the 'swing' / 'punch'
// clips; ranged arms put the weapon front on the 'fist' bone (barrels along −Y), muzzles = socket_Launch_<L|R><n> with one
// flash bone each, clips 'launcher' / 'blaster' / 'beam' (ROBOT_KIT.anim). Visual only – the GLB stand-in body stays hidden
// underneath and drives the simulation. Style (kit.style.silhouette) changes blade tip, tube sides, fins; no faction names here.
import { registerRobotPart, block, lightLine } from './RobotKit.js';
import { hullLoft, limbLoft, armor, frontFlat } from './RobotSculpt.js';
import { ARM_SHAPES, buildUpperArm } from './RobotArms.js';
import { ARM_MELEE } from './RobotArmsMelee.js';
import { UNIT_KIT } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const MELEE_SEG = 6;
const SAW_SEG = 8;
const SPIN_SPEED = 30;                                     // rad/s of the laser disc at full spin (UNIT_KIT.spin lingers it)
const DEFAULT_SFX = [0, -2.5, 0.9];                        // socket_SFX_1_<L|R> on the fist
const BLADE_TIP = { angular: 0.2, faceted: 0.25, rounded: 0.4, round: 0.5 };
const BLADE_TOP_W = 0.4;
const TUBE_SEG = { rounded: 6, round: 6, angular: 4, faceted: 5 };
const TUBE_SEG_DEFAULT = 6;
const SHARP_STYLES = { angular: true, faceted: true };
const FLASH_SEG = 4;
const ORB_SEG = [5, 3];
const HOUSING_POINTS = 8;
const LINE_OUT = 0.05;
const LINE_GLUE = 0.02;
const LINE_FIT = 0.85;
const AIM_Z = 0.2;
const REST_HOLD = { elbow: -0.12, shoulder: 0 };           // weapon hangs along the body at rest (kit reads rig.hold)
const JET_COLOR = '#ff3a14';                               // jetHammer thruster flame (red)
const PLASMA_COLOR = '#7dff9a';                            // plasmaCutter jet

const bladeTip = (kit) => BLADE_TIP[kit.style.silhouette] ?? BLADE_TIP.rounded;
const segOf = (kit) => TUBE_SEG[kit.style.silhouette] ?? TUBE_SEG_DEFAULT;

// ---------------------------------------------------------------- dimensions (raw GLB units, right arm)

const BASE_MELEE = (({ elbow, fist, pad, padLoft, fin, shoulderJoint, upper, elbowJoint }) => (
  { elbow, fist, pad, padLoft, fin, shoulderJoint, upper, elbowJoint }
))(ARM_SHAPES.fist);
const BASE_RANGED = { ...ARM_SHAPES.gattling, fin: ARM_SHAPES.fist.fin };
const FORE_PROFILE = [[-0.07, 0.78, 0.8], [0.55, 1, 1, 0.08], [1.04, 1.02, 1.0]];
const HAND_LOFT = [[0, 0.88, 0.85], [0.5, 1, 1], [1, 0.9, 0.86]];
const HOUSING_PROFILE = [[-0.12, 0.82, 0.82], [0.2, 1, 1, 0.1], [1.02, 0.86, 0.86]];
const HOUSING_SIDE = { w: 3.2, h: 2.2, th: 0.3, at: 0.5 };
const TOP_LINE = { len: 3.0, at: 0.5 };
const SFX_AT = [0, -2.5, 0.9];

export const B3_ARM_SHAPES = {
  // --- melee (hand / fore / tilt reused from the stand-in arms in ARM_MELEE)
  ionKatana: {
    ...BASE_MELEE, fore: ARM_MELEE.katana.fore, hand: ARM_MELEE.katana.hand, thumb: ARM_MELEE.katana.thumb, tilt: -0.9,
    handle: { r: 0.5, len: 3.2, top: 1.4 },
    guard: { w: 3.2, h: 0.35, d: 1.4, y: -1.8 },
    blade: { len1: 6.6, len2: 4.8, start: 1.95, th: 1.8, d: 0.5, curve: 0.12 },
    edge: { share: 0.55, t: 0.12, intensity: 0.9 },                       // glowing ion edge (share of blade width)
    arcs: [{ at: 0.3, len: 3.2, zig: 0.8 }, { at: 0.7, len: 3.2, zig: 0.7 }],   // arcs trailing behind the blade (at = share of blade)
    arcBack: -1.3, arcThick: 0.14,
    tip: { r: 1.2 },
  },
  jetHammer: {
    ...BASE_MELEE, pad: { ...BASE_MELEE.pad, w: 5.0, h: 3.6 },
    fore: ARM_MELEE.hammerHand.fore, hand: ARM_MELEE.hammerHand.hand, thumb: ARM_MELEE.hammerHand.thumb, tilt: -0.8,
    haft: { r: 0.6, len: 8.2, top: 1.6 },
    head: { w: 5.0, h: 4.8, d: 7.6, y: -6.6, z: 0.6 },
    band: { grow: 0.25, hShare: 0.35, dShare: 0.4 },
    face: { w: 4.4, h: 4.2, th: 0.6 },
    jets: { dx: 1.5, r: 0.9, rFlare: 1.3, len: 1.6, back: 0.9, y: -0.3 },  // two thruster nozzles on the rear face (−z)
    flame: { near: 1.0, far: 0.2, len: 4.5 },
  },
  plasmaCutter: {
    ...BASE_MELEE, fore: ARM_MELEE.electroGrip.fore, hand: ARM_MELEE.electroGrip.hand, thumb: ARM_MELEE.electroGrip.thumb, tilt: -0.5,
    housing: { w: 3.8, h: 1.8, d: 3.4, y: -2.0 },
    tank: { r: 1.0, len: 3.0, x: 1.7, y: -2.4 },                         // side fuel cell (team)
    nozzle: { rBack: 1.3, rFront: 0.7, len: 3.4, start: 2.7 },
    jet: { near: 0.6, far: 0.12, len: 6.5, idle: 0.55 },                  // plasma jet (static glow cone + flash cone on a hit)
    lens: { r: 1.1 },
  },
  laserDisc: {
    ...BASE_MELEE, fore: ARM_MELEE.rotaryBlade.fore, hand: ARM_MELEE.rotaryBlade.hand, thumb: ARM_MELEE.rotaryBlade.thumb,
    strut: { w: 1.0, h: 1.0, d: 3.0, y: -2.3, z: 2.0 },
    hub: { r: 0.8, len: 1.0, y: -2.3, z: 3.7 },
    disc: { r: 3.6, th: 0.35, ring: 0.2, glowSeg: 8 },
    blades: { count: 3, w: 0.5, h: 1.4, d: 0.8 },
    guard: { w: 4.2, h: 2.2, th: 0.35, x: 0.6, up: 1.6 },
  },

  // --- ranged (hw / hd = housing size, muzzles on the fist bone, forward = −Y)
  ionPulseGun: {
    hw: 4.2, hd: 4.0, sfx: true, shots: 3,
    shroud: { w: 4.8, h: 6.4, d: 3.8, y: 0.3 },
    barrels: { dx: 1.2, r: 0.8, len: 4.2, top: 3.0 },
    rings: { r: 1.25, len: 0.5, at: [2.2] },                               // glowing ion ring round each barrel (B3 round 2: one ring, no rail: −60 tri)
    lens: { r: 0.5 },
    flash: { near: 0.45, far: 0.1, len: 1.4, core: 0.45 },
  },
  heavyRocketArm: {
    hw: 4.4, hd: 4.4, sfx: true, shots: 1,
    tube: { r: 2.7, len: 13.5, top: 5.5 },
    breech: { r: 3.1, len: 2.4, y: 4.5 },
    collars: [{ r: 3.0, len: 0.8, y: -1.0 }, { r: 3.0, len: 0.8, y: -6.0 }],
    nose: { r: 2.1, tip: 0.2, len: 3.6, back: 0.9 },
    stripe: { w: 1.5, h: 9.5, th: 0.4 },
    fin: { w: 0.4, h: 3.6, d: 2.2, y: 2.0 },
    flash: { near: 1.1, far: 0.2, len: 2.4, core: 0.9 },
    sfxAt: [0, -10.7, 0.2],                                               // socket_SFX_1 on the muzzle (nose tip = tube top − len − nose len + back)
  },
  arcRifle: {
    hw: 4.0, hd: 4.0, sfx: true, shots: 1,
    barrel: { rRear: 2.0, rFront: 1.5, len: 10.0, top: 4.0 },
    coils: { r: 2.7, len: 0.7, at: [-2.6, -5.4], glowR: 2.75, glowLen: 0.2, seg: 5, glowSeg: 4, team: 0 },   // 2 coils (round 2 trim)
    rails: { dx: 1.7, w: 0.5, len: 5.0, y: -5.2 },                        // twin electrodes the arcs jump between
    arc: { thick: 0.16, zig: 0.55, y: -7.4 },
    orb: { r: 1.2, y: -4.0, seg: [4, 3] }, muzzleY: -9.0, sfxAt: [0, -9.0, 0.2],   // sfxAt = socket_SFX_1 on the muzzle
    flash: { near: 0.5, far: 0.1, len: 4.0, core: 0.6, noCore: true },
  },
  photonLauncher: {
    hw: 4.4, hd: 4.4, sfx: true, shots: 1,
    body: { w: 6.2, h: 6.0, d: 5.6, y: 0.5 },
    tube: { rBack: 2.4, rFront: 3.3, len: 7.0, top: -2.4 },               // flared mortar tube
    ring: { r: 3.4, len: 0.5, glowR: 3.45, y: -9.1 },                      // glowing mouth ring
    canister: { r: 1.5, len: 5.0, y: 1.0, z: 3.2 },                        // photon canister on top
    orb: { r: 2.0, y: -5.0 }, muzzleY: -9.4, sfxAt: [0, -9.4, 0.2],     // socket_SFX_1 on the muzzle
    flash: { near: 1.4, far: 0.3, len: 2.2, core: 1.0 },
  },
};

// ---------------------------------------------------------------- shared melee pieces

function meleeBase(ub, kit, ctx, D) {
  const S = kit.S;
  const sg = ctx.side;
  const { shoulder, elbow, fist } = buildUpperArm(ub, kit, ctx, D, { elbowRim: false });
  const eb = ub.paint(elbow);
  limbLoft(eb, kit, [0, 0, 0], D.fist, D.fore.w, D.fore.d, FORE_PROFILE, S[D.fore.paint]);
  const fb = ub.paint(fist);
  const H = D.hand;
  const hy0 = H.y - H.h / 2;
  hullLoft(fb, kit, HAND_LOFT.map(([ys, ws, ds]) => ({ y: hy0 + ys * H.h, w: H.w * ws, d: H.d * ds, z: H.z })), S[H.paint]);
  if (D.thumb) fb.box(D.thumb.w, D.thumb.h, D.thumb.d, S.frame, { x: -sg * D.thumb.x, y: D.thumb.y, z: D.thumb.z, detail: 0 });
  return { shoulder, elbow, fist, eb, fb };
}

const weaponBone = (ub, ctx, a, D, name) => ub.bone(`${name}${ctx.sfx}`, a.fist, [0, D.hand.y, D.hand.z], { rotation: [D.tilt, 0, 0] });

function meleeFinish(ub, ctx, a, attack, fx, sfx) {
  ub.onFire(`${attack}_${ctx.sfx}`, fx);
  const at = sfx ?? { bone: a.fist, at: DEFAULT_SFX };
  ub.socket(`${ctx.sockets.sfx}_${ctx.sfx}`, at.bone, at.at);
  return { rig: { shoulder: a.shoulder, elbow: a.elbow, fist: a.fist, attack, fire: `${attack}_${ctx.sfx}` } };
}

function bladeSeg(wp, kit, s, th, len, d, start, t = {}) {
  wp.taperedBox(th, th * BLADE_TOP_W, len, d, s, { y: -start, rz: Math.PI, ...t }, d * bladeTip(kit));
}

/** Flash bone (hidden until the weapon fires) with a flame cone; returns its meta.flashes index */
function addFlame(ub, name, parent, pos, F, color, rot = {}) {
  const bone = ub.bone(name, parent, pos);
  ub.glow(bone).flame(F.near, F.far, F.len, FLASH_SEG, color, rot);
  return ub.meta.flashes.push({ bone }) - 1;
}

// ---------------------------------------------------------------- melee arms

registerRobotPart('arm', 'ionKatana', {
  label: 'Ion katana',
  build(ub, kit, ctx) {
    const D = B3_ARM_SHAPES.ionKatana;
    const S = kit.S;
    const a = meleeBase(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'ionKatana');
    const wp = ub.paint(wb);
    const Hn = D.handle;
    wp.cylinder(Hn.r, Hn.r, Hn.len, MELEE_SEG, S.teamPaint, { y: Hn.top - Hn.len / 2 });
    wp.box(Hn.r * 2.6, Hn.r * 2, Hn.r * 2.6, S.frame, { y: Hn.top, detail: 0 });
    const G = D.guard;
    wp.box(G.w, G.h, G.d, S.frame, { y: G.y });
    const B = D.blade;
    bladeSeg(wp, kit, S.pipe, B.th, B.len1, B.d, B.start);
    bladeSeg(wp, kit, S.pipe, B.th * 0.75, B.len2, B.d * 0.9, B.start + B.len1, { rx: -B.curve });
    // glowing ion edge laid over both blade segments (static)
    const color = kit.glowColors.laser;
    const E = D.edge;
    const gl = ub.glow(wb);
    gl.box(B.th * E.share, B.len1, B.d + E.t, color, { y: -B.start - B.len1 / 2, intensity: E.intensity });
    gl.box(B.th * 0.75 * E.share, B.len2, B.d * 0.9 + E.t, color, {
      y: -B.start - B.len1 - (B.len2 / 2) * Math.cos(B.curve), z: (B.len2 / 2) * Math.sin(B.curve), rx: -B.curve, intensity: E.intensity,
    });
    // arcs trailing behind the blade (−z), flicker harder on a swing
    const arcs = [];
    D.arcs.forEach((A, n) => {
      const bone = ub.bone(`ionArc${n}${ctx.sfx}`, wb, [0, -B.start - (B.len1 + B.len2) * A.at, D.arcBack]);
      const h = A.len / 2;
      const pts = [[0, h], [A.zig * (n % 2 ? -1 : 1), 0], [0, -h]];
      for (let k = 0; k < pts.length - 1; k++) {
        ub.glow(bone).segment([pts[k][0], pts[k][1], 0], [pts[k + 1][0], pts[k + 1][1], 0], D.arcThick, color);
      }
      arcs.push(ub.meta.arcs.push({ bone }) - 1);
    });
    const tipAt = [0, -B.start - B.len1 - B.len2 * Math.cos(B.curve), B.len2 * Math.sin(B.curve)];
    const tip = ub.bone(`ionTip${ctx.sfx}`, wb, tipAt);
    ub.glow(tip).point([0, 0, 0], D.tip.r, color);
    const li = ub.meta.lenses.push({ bone: tip }) - 1;
    return meleeFinish(ub, ctx, a, 'swing', { arcs, lenses: [li] }, { bone: wb, at: tipAt });
  },
});

registerRobotPart('arm', 'jetHammer', {
  label: 'Jet hammer',
  build(ub, kit, ctx) {
    const D = B3_ARM_SHAPES.jetHammer;
    const S = kit.S;
    const a = meleeBase(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'jetHammer');
    const wp = ub.paint(wb);
    const H = D.haft;
    wp.cylinder(H.r, H.r, H.len, MELEE_SEG, S.hullDark, { y: H.top - H.len / 2 });
    const Hd = D.head;
    block(wp, kit, Hd.w, Hd.h, Hd.d, S.hullDark, { y: Hd.y, z: Hd.z });
    const B = D.band;
    wp.box(Hd.w + B.grow, Hd.h * B.hShare, Hd.d * B.dShare, S.teamPaint, { y: Hd.y, z: Hd.z, detail: 0 });
    const F = D.face;
    for (const s of [-1, 1]) wp.box(F.w, F.h, F.th, S.frame, { y: Hd.y, z: Hd.z + s * (Hd.d / 2 + F.th * 0.3) });
    // two thruster nozzles on the rear face; red flames burst out on the swing
    const J = D.jets;
    const rearZ = Hd.z - Hd.d / 2 - F.th * 0.6;
    const flashes = [];
    for (const s of [-1, 1]) {
      const x = s * J.dx;
      wp.cylinder(J.r, J.rFlare, J.len, MELEE_SEG, S.pipe, { x, y: Hd.y + J.y, z: rearZ - J.len / 2 + J.back, rx: HALF_PI }, true);
      flashes.push(addFlame(ub, `jetFlame${s < 0 ? 0 : 1}${ctx.sfx}`, wb, [x, Hd.y + J.y, rearZ - J.len + J.back], D.flame, JET_COLOR));
    }
    return meleeFinish(ub, ctx, a, 'swing', { flashes }, { bone: wb, at: [0, Hd.y, Hd.z + Hd.d / 2 + F.th] });
  },
});

registerRobotPart('arm', 'plasmaCutter', {
  label: 'Plasma cutter',
  build(ub, kit, ctx) {
    const D = B3_ARM_SHAPES.plasmaCutter;
    const S = kit.S;
    const sg = ctx.side;
    const a = meleeBase(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'cutter');
    const wp = ub.paint(wb);
    const Hs = D.housing;
    wp.box(Hs.w, Hs.h, Hs.d, S.teamPaint, { y: Hs.y });
    const Tk = D.tank;
    wp.cylinder(Tk.r, Tk.r, Tk.len, MELEE_SEG, S.hullDark, { x: sg * Tk.x, y: Tk.y - Tk.len / 2 + 0.6 });
    const N = D.nozzle;
    wp.cylinder(N.rFront, N.rBack, N.len, MELEE_SEG, S.frame, { y: -N.start - N.len / 2 }, true);
    // plasma jet: static glow cone (idle) + stronger flash cone while hitting, lens at the nozzle tip
    const color = kit.glowColors.laser;
    const J = D.jet;
    const tipY = -N.start - N.len;
    ub.glow(wb).flame(J.near, J.far, J.len, FLASH_SEG, color, { rx: -HALF_PI, y: tipY, intensity: J.idle });
    const flash = addFlame(ub, `plasmaJet${ctx.sfx}`, wb, [0, tipY, 0], { near: J.near * 1.6, far: J.far, len: J.len * 1.15 }, PLASMA_COLOR, { rx: -HALF_PI });
    const lens = ub.bone(`cutterLens${ctx.sfx}`, wb, [0, tipY, 0]);
    ub.glow(lens).point([0, 0, 0], D.lens.r, color);
    const li = ub.meta.lenses.push({ bone: lens }) - 1;
    return meleeFinish(ub, ctx, a, 'punch', { flashes: [flash], lenses: [li] }, { bone: wb, at: [0, tipY - J.len * 0.4, 0] });
  },
});

registerRobotPart('arm', 'laserDisc', {
  label: 'Laser disc',
  build(ub, kit, ctx) {
    const D = B3_ARM_SHAPES.laserDisc;
    const S = kit.S;
    const sg = ctx.side;
    const a = meleeBase(ub, kit, ctx, D);
    const St = D.strut;
    a.fb.box(St.w, St.h, St.d, S.frame, { y: St.y, z: St.z });
    const Hb = D.hub;
    const spin = ub.bone(`disc${ctx.sfx}`, a.fist, [0, Hb.y, Hb.z]);
    const sp = ub.paint(spin);
    const Ds = D.disc;
    sp.cylinder(Ds.r, Ds.r, Ds.th, SAW_SEG, S.pipe, { rz: HALF_PI });
    sp.cylinder(Hb.r, Hb.r, Hb.len, MELEE_SEG, S.teamPaint, { rz: HALF_PI }, true);
    const T = D.blades;
    for (let i = 0; i < T.count; i++) {
      const ang = (Math.PI * 2 * i) / T.count;
      sp.box(T.d, T.h, T.w, S.hullDark, { y: Math.cos(ang) * Ds.r, z: Math.sin(ang) * Ds.r, rx: -ang, detail: 0 });
    }
    // glowing laser rim on the spinner (disc in the YZ plane)
    ub.glow(spin).torus(Ds.r, Ds.ring, 3, Ds.glowSeg, kit.glowColors.laser, { ry: HALF_PI });
    const si = ub.meta.spinners.push({ bone: spin, axis: 'x', speed: SPIN_SPEED * sg }) - 1;
    const G = D.guard;
    a.fb.box(G.th, G.h, G.w, S.teamPaint, { x: sg * G.x, y: Hb.y + G.up, z: Hb.z });
    return meleeFinish(ub, ctx, a, 'punch', { spinners: [si] }, { bone: a.fist, at: [0, Hb.y, Hb.z + Ds.r] });
  },
});

// ---------------------------------------------------------------- shared ranged pieces

function depthAt(profile, t) {
  let i = 1;
  while (i < profile.length - 1 && profile[i][0] < t) i++;
  const p = profile[i - 1];
  const q = profile[i];
  const k = Math.min(1, Math.max(0, (t - p[0]) / (q[0] - p[0])));
  return { ds: p[2] + (q[2] - p[2]) * k, oz: (p[3] ?? 0) + ((q[3] ?? 0) - (p[3] ?? 0)) * k };
}

function rangedBase(ub, kit, ctx, W) {
  const S = kit.S;
  const sg = ctx.side;
  const { shoulder, elbow, fist } = buildUpperArm(ub, kit, ctx, BASE_RANGED, { elbowRim: false });
  const eb = ub.paint(elbow);
  limbLoft(eb, kit, [0, 0, 0], BASE_RANGED.fist, W.hw, W.hd, HOUSING_PROFILE, S.hullDark, { points: HOUSING_POINTS });
  const Sd = HOUSING_SIDE;
  const sideW = (W.hw * HOUSING_PROFILE[1][1]) / 2;
  armor(eb, kit, Sd.w, Sd.h, Sd.th, S.teamPaint, {
    x: sg * (sideW + Sd.th / 2), y: BASE_RANGED.fist[1] * Sd.at, z: BASE_RANGED.fist[2] * Sd.at, ry: sg * HALF_PI,
  });
  const dp = depthAt(HOUSING_PROFILE, TOP_LINE.at);
  const top = frontFlat(kit, W.hw * HOUSING_PROFILE[1][1], W.hd * dp.ds, { points: HOUSING_POINTS });
  lightLine(eb, kit, Math.min(TOP_LINE.len, -BASE_RANGED.fist[1] * LINE_FIT * 0.5), 'y', {
    y: BASE_RANGED.fist[1] * TOP_LINE.at, z: BASE_RANGED.fist[2] * TOP_LINE.at + top.z + dp.oz + LINE_GLUE,
  });
  return { shoulder, elbow, fist };
}

function addMuzzle(ub, ctx, id, fist, n, pos, F, color, lensIndex = -1) {
  const bone = ub.bone(`${id}Flash${ctx.sfx}${n}`, fist, pos);
  const g = ub.glow(bone);
  g.flame(F.near, F.far, F.len, FLASH_SEG, color, { rx: -HALF_PI });
  if (!F.noCore) g.point([0, -F.core, 0], F.core, UNIT_KIT.flash.core);
  const fi = ub.meta.flashes.push({ bone }) - 1;
  const socket = `${ctx.sockets.launch}${ctx.sfx}${n}`;
  ub.socket(socket, fist, [pos[0], pos[1] - LINE_OUT, pos[2]]);
  ub.onFire(socket, lensIndex >= 0 ? { flashes: [fi], lenses: [lensIndex] } : { flashes: [fi] });
  return socket;
}

function addLens(ub, ctx, name, fist, pos) {
  const bone = ub.bone(`${name}${ctx.sfx}`, fist, pos);
  return { bone, index: ub.meta.lenses.push({ bone }) - 1 };
}

function addCharge(ub, ctx, name, fist, pos, r, color, seg = ORB_SEG) {
  const bone = ub.bone(`${name}${ctx.sfx}`, fist, pos);
  ub.glow(bone).sphere(r, seg[0], seg[1], color);
  ub.meta.flashes.push({ bone });   // hidden at rest (arm wreck / icon); the robot drives its charge scale
  return bone;
}

// ---------------------------------------------------------------- ranged arms

const FRONTS = {
  ionPulseGun(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const color = kit.glowColors.beam;
    const Sh = W.shroud;
    fb.box(Sh.w, Sh.h, Sh.d, S.teamPaint, { y: Sh.y, z: AIM_Z });
    const B = W.barrels;
    const gl = ub.glow(fist);
    const endY = B.top - B.len;
    const muzzles = [];
    for (let i = 0; i < 2; i++) {
      const x = (i === 0 ? -1 : 1) * B.dx;
      fb.cylinder(B.r, B.r, B.len, seg, S.frame, { x, y: B.top - B.len / 2, z: AIM_Z }, true);
      for (const at of W.rings.at) {
        gl.cylinder(W.rings.r, W.rings.r, W.rings.len * 0.4, seg, color, { x, y: B.top - at, z: AIM_Z });
        fb.cylinder(W.rings.r * 0.8, W.rings.r * 0.8, W.rings.len, seg, S.hullDark, { x, y: B.top - at, z: AIM_Z }, true);
      }
      const lens = addLens(ub, ctx, `ionLens${i + 1}`, fist, [x, endY, AIM_Z]);
      ub.glow(lens.bone).point([0, 0, 0], W.lens.r, color);
      muzzles.push(addMuzzle(ub, ctx, 'ionPulse', fist, i + 1, [x, endY - LINE_OUT, AIM_Z], W.flash, color, lens.index));
    }
    return { muzzles };
  },

  heavyRocketArm(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const T = W.tube;
    fb.cylinder(T.r, T.r, T.len, seg, S.frame, { y: T.top - T.len / 2, z: AIM_Z }, true);
    fb.cylinder(W.breech.r, W.breech.r, W.breech.len, seg, S.hullDark, { y: W.breech.y, z: AIM_Z });
    for (const C of W.collars) fb.cylinder(C.r, C.r, C.len, seg, S.hullDark, { y: C.y, z: AIM_Z }, true);
    const N = W.nose;
    const tipY = T.top - T.len - N.len + N.back;
    fb.cylinder(N.r, N.tip, N.len, seg, S.hull, { y: tipY + N.len / 2, z: AIM_Z }, false);
    const St = W.stripe;
    fb.box(St.w, St.h, St.th, S.teamPaint, { y: T.top - St.h / 2 - 0.5, z: AIM_Z + T.r + St.th / 2 });
    if (SHARP_STYLES[kit.style.silhouette]) fb.box(W.fin.w, W.fin.h, W.fin.d, S.hullDark, { y: W.fin.y, z: AIM_Z + T.r + W.fin.d / 2 });
    return { muzzles: [addMuzzle(ub, ctx, 'rocket', fist, 1, [0, tipY, AIM_Z], W.flash, UNIT_KIT.flash.color)] };
  },

  arcRifle(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const color = kit.glowColors.beam;
    const B = W.barrel;
    fb.cylinder(B.rRear, B.rFront, B.len, seg, S.frame, { y: B.top - B.len / 2, z: AIM_Z }, true);
    const gl = ub.glow(fist);
    W.coils.at.forEach((y, i) => {
      fb.cylinder(W.coils.r, W.coils.r, W.coils.len, W.coils.seg, i === W.coils.team ? S.teamPaint : S.hullDark, { y, z: AIM_Z }, true);
      gl.cylinder(W.coils.glowR, W.coils.glowR, W.coils.glowLen, W.coils.glowSeg, color, { y, z: AIM_Z });
    });
    // twin electrodes at the front, arcs jump between them (flicker; harder on a shot)
    const Rl = W.rails;
    for (const s of [-1, 1]) fb.box(Rl.w, Rl.len, Rl.w, S.pipe, { x: s * Rl.dx, y: Rl.y - Rl.len / 2, z: AIM_Z });
    const arcBone = ub.bone(`arcBolt${ctx.sfx}`, fist, [0, W.arc.y, AIM_Z]);
    const A = W.arc;
    const pts = [[-Rl.dx, 0], [0, A.zig], [Rl.dx, 0]];   // 2 segments (trim)
    for (let k = 0; k < pts.length - 1; k++) ub.glow(arcBone).segment([pts[k][0], 0, pts[k][1]], [pts[k + 1][0], 0, pts[k + 1][1]], A.thick, color);
    const arc = ub.meta.arcs.push({ bone: arcBone }) - 1;
    const charge = addCharge(ub, ctx, 'arcCharge', fist, [0, W.orb.y, AIM_Z], W.orb.r, color, W.orb.seg);
    const muzzle = addMuzzle(ub, ctx, 'arc', fist, 1, [0, W.muzzleY, AIM_Z], W.flash, color);
    ub.onFire(muzzle, { arcs: [arc] });
    return { muzzles: [muzzle], charge };
  },

  photonLauncher(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const color = kit.glowColors.beam;
    const Bd = W.body;
    fb.box(Bd.w, Bd.h, Bd.d, S.teamPaint, { y: Bd.y, z: AIM_Z });
    const T = W.tube;
    fb.cylinder(T.rFront, T.rBack, T.len, seg, S.frame, { y: T.top - T.len / 2, z: AIM_Z }, true);
    const Rg = W.ring;
    fb.cylinder(Rg.r, Rg.r, Rg.len, seg, S.hullDark, { y: Rg.y + 0.1, z: AIM_Z }, true);
    ub.glow(fist).cylinder(Rg.glowR, Rg.glowR, Rg.len * 0.4, seg, color, { y: Rg.y, z: AIM_Z });
    const C = W.canister;
    fb.cylinder(C.r, C.r, C.len, seg, S.hullDark, { y: C.y - C.len / 2, z: AIM_Z + C.z });
    const charge = addCharge(ub, ctx, 'photonCharge', fist, [0, W.orb.y, AIM_Z], W.orb.r, color);
    return { muzzles: [addMuzzle(ub, ctx, 'photon', fist, 1, [0, W.muzzleY, AIM_Z], W.flash, color)], charge };
  },
};

const RANGED = {
  ionPulseGun: { label: 'Ion pulse gun', attack: 'blaster' },
  heavyRocketArm: { label: 'Heavy rocket arm', attack: 'launcher' },
  arcRifle: { label: 'Arc rifle', attack: 'beam' },
  photonLauncher: { label: 'Photon launcher', attack: 'beam' },
};

for (const [id, def] of Object.entries(RANGED)) {
  registerRobotPart('arm', id, {
    label: def.label,
    build(ub, kit, ctx) {
      const W = B3_ARM_SHAPES[id];
      const { shoulder, elbow, fist } = rangedBase(ub, kit, ctx, W);
      const F = FRONTS[id](ub, kit, ctx, W, fist);
      if (W.sfx) ub.socket(`${ctx.sockets.sfx}_${ctx.sfx}`, fist, W.sfxAt ?? SFX_AT);
      const rig = { shoulder, elbow, fist, attack: def.attack, fire: F.muzzles[0], muzzles: F.muzzles, shots: W.shots };
      if (F.charge) rig.charge = F.charge;
      rig.hold = REST_HOLD;
      return { rig };
    },
  });
}
