// Steel Men – procedural arms of block A16: rocketArm, tankCannon, ionHeavySword, flamethrower, plasmaBlade, plasmaSniper,
// photonDeflector. Same rig contract and helper layout as RobotArmsB3.js (the helpers are a compact copy – they are not exported
// there): bones shoulder → elbow → fist (shared upper arm = buildUpperArm), arm built for its side (ctx.side −1 = left = −x),
// robot faces +Z. Melee arms hang the weapon on a weapon bone (child of 'fist', tilted forward, 'swing' / 'punch' clips); ranged
// arms put the weapon front on the 'fist' bone (barrels along −Y, +Z = up while aiming), muzzles = socket_Launch_<L|R><n> with a
// flash bone each, clips 'launcher' / 'gun' / 'beam' (ROBOT_KIT.anim). Visual only – the GLB stand-in body stays hidden underneath
// and drives the simulation. Style (kit.style.silhouette) changes blade tips and tube sides; no faction names here.
import { registerRobotPart, block, lightLine, limbBetween } from './RobotKit.js';
import { hullLoft, limbLoft, armor, frontFlat } from './RobotSculpt.js';
import { ARM_SHAPES, buildUpperArm } from './RobotArms.js';
import { ARM_MELEE } from './RobotArmsMelee.js';
import { UNIT_KIT } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const MELEE_SEG = 6;
const BLADE_TIP = { angular: 0.2, faceted: 0.25, rounded: 0.4, round: 0.5 };
const BLADE_TOP_W = 0.4;
const TUBE_SEG = { rounded: 6, round: 6, angular: 4, faceted: 5 };
const TUBE_SEG_DEFAULT = 6;
const RING_SEG = { rounded: [3, 8], round: [3, 10], angular: [3, 6], faceted: [3, 6] };   // torus (radial, tubular) per silhouette
const RING_SEG_DEFAULT = [3, 8];
const FLASH_SEG = 4;
const ORB_SEG = [5, 3];
const HOUSING_POINTS = 8;
const LINE_OUT = 0.05;
const LINE_GLUE = 0.02;
const LINE_FIT = 0.85;
const AIM_Z = 0.2;
const REST_HOLD = { elbow: -0.12, shoulder: 0 };           // weapon hangs along the body at rest (kit reads rig.hold)
const DEFAULT_SFX = [0, -2.5, 0.9];                        // socket_SFX_1_<L|R> on the fist
const FLAME_COLOR = '#ff6a1a';                             // flamethrower fire
const PLASMA_COLOR = '#7dff9a';                            // plasma blade / sniper bolt accent
const GLOW_DIM = 0.6;

const bladeTip = (kit) => BLADE_TIP[kit.style.silhouette] ?? BLADE_TIP.rounded;
const segOf = (kit) => TUBE_SEG[kit.style.silhouette] ?? TUBE_SEG_DEFAULT;
const ringOf = (kit) => RING_SEG[kit.style.silhouette] ?? RING_SEG_DEFAULT;

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

export const A16_ARM_SHAPES = {
  // --- melee
  ionHeavySword: {
    ...BASE_MELEE, fore: ARM_MELEE.hammerHand.fore, hand: ARM_MELEE.hammerHand.hand, thumb: ARM_MELEE.hammerHand.thumb, tilt: -0.85,
    handle: { r: 0.7, len: 3.6, top: 1.6 },
    pommel: { w: 2.0, h: 1.2, d: 2.0 },
    guard: { w: 6.0, h: 0.8, d: 2.4, y: -2.2 },
    blade: { len: 11.5, start: 2.8, th: 3.6, d: 1.0 },                    // broad slab, widest at the guard
    fuller: { share: 0.3, len: 0.55, th: 0.12 },                          // team stripe down the blade
    edge: { share: 0.62, t: 0.14, intensity: 0.9 },                       // glowing ion edge (share of blade width)
    tip: { r: 1.4 },
  },
  plasmaBlade: {
    ...BASE_MELEE, fore: ARM_MELEE.laserSword.fore, hand: ARM_MELEE.laserSword.hand, thumb: ARM_MELEE.laserSword.thumb, tilt: -0.8,
    hilt: { r: 0.52, len: 3.0, top: 1.4 },
    emitter: { w: 2.4, h: 1.4, d: 1.8, y: -2.0 },                         // team emitter block
    prongs: { x: 0.9, w: 0.35, h: 2.6, d: 0.8, y: -3.6 },                 // two forks holding the plasma
    blade: { len: 7.4, start: 2.6, w: 1.2, d: 0.5, halo: 1.9, haloPower: 0.5 },   // shorter and narrower than the katana
    tip: { r: 1.0 },
  },
  photonDeflector: {
    ...BASE_MELEE, fore: ARM_MELEE.energyShield.fore, hand: ARM_MELEE.energyShield.hand, thumb: null,
    projector: { w: 3.6, h: 2.2, d: 3.2, y: -4.6, z: 0.7 },               // team projector at the wrist
    ring: { r: 4.9, tube: 0.55, x: 2.6, y: -3.4, z: 3.8 },                // big team ring (the emitter)
    inner: { r: 3.9, tube: 0.16, intensity: 0.8 },                        // glowing inner ring
    pane: { r: 4.2, t: 0.12, intensity: 0.1 },                            // faint deflection field
    spokes: [[1, 0], [-0.5, 0.87], [-0.5, -0.87]],                        // three struts ring → wrist (unit directions in the ring plane)
    spokeW: 0.55,
    core: { r: 1.5 },                                                     // central flash lens (a reflected shot flares it)
    pulse: { depth: 0.15, hz: 0.8 },
  },

  // --- ranged (hw / hd = housing size, muzzles on the fist bone, forward = −Y)
  rocketArm: {
    hw: 4.6, hd: 4.6, sfx: true, shots: 6,
    pod: { w: 5.6, h: 7.2, d: 5.4, y: -0.2 },
    tubes: { r: 0.95, len: 7.6, top: 3.4, xs: [-1.45, 1.45], zs: [-1.7, 0, 1.7] },   // 2 × 3 tubes
    nose: { r: 0.8, tip: 0.1, len: 1.5, back: 0.6 },                      // rocket nose cone seen in each tube mouth
    band: { w: 5.9, h: 1.0, d: 5.7, y: 2.2 },                             // team band round the pod
    flash: { near: 0.7, far: 0.12, len: 2.0, core: 0.5 },
  },
  tankCannon: {
    hw: 4.6, hd: 4.6, sfx: true, shots: 1,
    breech: { w: 5.4, h: 4.2, d: 4.8, y: 1.6 },                           // team breech block
    sleeve: { r: 2.1, len: 5.0, top: 3.4 },                               // recoil jacket
    barrel: { r: 1.35, len: 12.0, top: 3.4 },
    evac: { r: 1.75, len: 2.2, at: 7.2 },                                 // fume extractor
    brake: { r: 2.0, len: 1.5, teamR: 2.1, teamLen: 0.5 },                // muzzle brake + team ring
    flash: { near: 1.0, far: 0.2, len: 2.6, core: 0.9 },
    sfxAt: [0, -11.2, 0.2],
  },
  flamethrower: {
    hw: 4.0, hd: 4.0, sfx: true, shots: 10,
    tank: { r: 2.5, len: 7.4, y: 3.4, z: -2.8 },                          // big team fuel tank on the back
    cap: { r: 2.6, len: 0.8 },
    hose: { w: 0.55, from: [0, -0.6, -3.0], to: [0, -2.0, 0.6] },
    nozzle: { rRear: 1.2, rFront: 0.85, len: 6.0, top: 3.0 },
    flare: { r: 1.7, len: 1.0, at: 5.4 },                                 // heat shroud at the mouth (hullDark)
    pilot: { near: 0.5, far: 0.1, len: 2.4, idle: 0.55 },                  // always-on pilot flame
    flash: { near: 1.5, far: 0.35, len: 6.0, core: 0.9 },
    muzzleY: -3.6, sfxAt: [0, -3.6, 0.2],
  },
  plasmaSniper: {
    hw: 3.8, hd: 3.8, sfx: true, shots: 1,
    barrel: { rRear: 1.35, rFront: 0.85, len: 20.0, top: 3.4 },           // long needle: reads from afar
    shroud: { w: 3.0, h: 5.2, d: 3.0, y: 1.0 },                           // team receiver
    coils: { r: 1.55, len: 0.6, at: [-1.4, -6.0, -11.0], glowR: 1.62, glowLen: 0.16, seg: 6, glowSeg: 5 },
    scope: { r: 1.1, len: 6.0, y: 1.6, z: 2.8, lensR: 0.9 },              // big optics on top
    orb: { r: 1.1, y: -2.0, seg: [4, 3] },
    muzzleY: -16.6, sfxAt: [0, -16.6, 0.2],
    flash: { near: 0.5, far: 0.1, len: 3.4, core: 0.6, noCore: true },
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

// ---------------------------------------------------------------- melee arms

registerRobotPart('arm', 'ionHeavySword', {
  label: 'Ion heavy sword',
  build(ub, kit, ctx) {
    const D = A16_ARM_SHAPES.ionHeavySword;
    const S = kit.S;
    const a = meleeBase(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'heavySword');
    const wp = ub.paint(wb);
    const Hn = D.handle;
    wp.cylinder(Hn.r, Hn.r, Hn.len, MELEE_SEG, S.frame, { y: Hn.top - Hn.len / 2 });
    wp.box(D.pommel.w, D.pommel.h, D.pommel.d, S.teamPaint, { y: Hn.top + D.pommel.h * 0.3, detail: 0 });
    const G = D.guard;
    block(wp, kit, G.w, G.h, G.d, S.teamPaint, { y: G.y });
    const B = D.blade;
    wp.taperedBox(B.th, B.th * BLADE_TOP_W, B.len, B.d, S.pipe, { y: -B.start, rz: Math.PI }, B.d * bladeTip(kit));
    // team stripe down the blade (fuller) under the glowing edge
    wp.box(B.th * D.fuller.share, B.len * D.fuller.len, B.d + D.fuller.th, S.teamPaint, { y: -B.start - B.len * 0.36, detail: 0 });
    const color = kit.glowColors.laser;
    const E = D.edge;
    ub.glow(wb).box(B.th * E.share * 0.34, B.len * 0.95, B.d + E.t, color, { x: -B.th * 0.3, y: -B.start - B.len / 2, intensity: E.intensity });
    ub.glow(wb).box(B.th * E.share * 0.34, B.len * 0.95, B.d + E.t, color, { x: B.th * 0.3, y: -B.start - B.len / 2, intensity: E.intensity });
    const tipAt = [0, -B.start - B.len, 0];
    const tip = ub.bone(`heavyTip${ctx.sfx}`, wb, tipAt);
    ub.glow(tip).point([0, 0, 0], D.tip.r, color);
    const li = ub.meta.lenses.push({ bone: tip }) - 1;
    return meleeFinish(ub, ctx, a, 'swing', { lenses: [li] }, { bone: wb, at: tipAt });
  },
});

registerRobotPart('arm', 'plasmaBlade', {
  label: 'Plasma blade',
  build(ub, kit, ctx) {
    const D = A16_ARM_SHAPES.plasmaBlade;
    const S = kit.S;
    const a = meleeBase(ub, kit, ctx, D);
    const wb = weaponBone(ub, ctx, a, D, 'plasmaBlade');
    const wp = ub.paint(wb);
    const Hl = D.hilt;
    wp.cylinder(Hl.r, Hl.r, Hl.len, MELEE_SEG, S.frame, { y: Hl.top - Hl.len / 2 });
    const Em = D.emitter;
    block(wp, kit, Em.w, Em.h, Em.d, S.teamPaint, { y: Em.y });
    const P = D.prongs;
    for (const s of [-1, 1]) wp.box(P.w, P.h, P.d, S.hullDark, { x: s * P.x, y: P.y, detail: 0 });
    // the plasma itself: a bright core inside a wider soft halo (static glow, flares at the tip on a hit)
    const B = D.blade;
    const color = kit.glowColors.laser;
    const gl = ub.glow(wb);
    gl.box(B.w * 0.45, B.len, B.d * 0.5, UNIT_KIT.flash.core, { y: -B.start - B.len / 2 });
    gl.box(B.w, B.len, B.d, color, { y: -B.start - B.len / 2, intensity: B.haloPower });
    const tipAt = [0, -B.start - B.len, 0];
    const tip = ub.bone(`plasmaTip${ctx.sfx}`, wb, tipAt);
    ub.glow(tip).point([0, 0, 0], D.tip.r, PLASMA_COLOR);
    const li = ub.meta.lenses.push({ bone: tip }) - 1;
    return meleeFinish(ub, ctx, a, 'swing', { lenses: [li] }, { bone: wb, at: tipAt });
  },
});

registerRobotPart('arm', 'photonDeflector', {
  label: 'Photon deflector',
  build(ub, kit, ctx) {
    const D = A16_ARM_SHAPES.photonDeflector;
    const S = kit.S;
    const sg = ctx.side;
    const a = meleeBase(ub, kit, ctx, D);
    const color = kit.glowColors.laser;
    const Pj = D.projector;
    block(a.eb, kit, Pj.w, Pj.h, Pj.d, S.teamPaint, { y: Pj.y, z: Pj.z });
    const R = D.ring;
    const rx = sg * R.x;
    const ring = ringOf(kit);
    // big team ring facing forward; glowing inner ring and a faint field disc inside it
    a.eb.torus(R.r, R.tube, ring[0], ring[1] * 2, Math.PI * 2, S.teamPaint, { x: rx, y: R.y, z: R.z });
    ub.glow(a.elbow).torus(D.inner.r, D.inner.tube, ring[0], ring[1] * 2, color, { x: rx, y: R.y, z: R.z, intensity: D.inner.intensity });
    ub.glow(a.elbow).cylinder(D.pane.r, D.pane.r, D.pane.t, 8, color, { x: rx, y: R.y, z: R.z, rx: HALF_PI, intensity: D.pane.intensity });
    // three struts from the projector to the ring
    for (const [ux, uy] of D.spokes) {
      const end = [rx + ux * (R.r - R.tube), R.y + uy * (R.r - R.tube), R.z];
      limbBetween(a.eb, kit, [0, Pj.y, Pj.z], end, D.spokeW, D.spokeW, S.frame);
    }
    // centre flash lens (breathes; the mech's flash channel can flare it on a reflection)
    const core = ub.bone(`deflectCore${ctx.sfx}`, a.elbow, [rx, R.y, R.z]);
    ub.glow(core).point([0, 0, 0], D.core.r, color);
    const li = ub.meta.lenses.push({ bone: core }) - 1;
    ctx.robot.extras.pulse.push({ bone: core, depth: D.pulse.depth, hz: D.pulse.hz });
    return meleeFinish(ub, ctx, a, 'punch', { lenses: [li] }, { bone: a.elbow, at: [rx, R.y, R.z + 0.3] });
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

function addCharge(ub, ctx, name, fist, pos, r, color, seg = ORB_SEG) {
  const bone = ub.bone(`${name}${ctx.sfx}`, fist, pos);
  ub.glow(bone).sphere(r, seg[0], seg[1], color);
  ub.meta.flashes.push({ bone });   // hidden at rest (arm wreck / icon); the robot drives its charge scale
  return bone;
}

// ---------------------------------------------------------------- ranged arms

const FRONTS = {
  // 2 × 3 pod of small unguided rockets: team pod + band, nose cones in the tube mouths, one muzzle per tube
  rocketArm(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const Pd = W.pod;
    block(fb, kit, Pd.w, Pd.h, Pd.d, S.hullDark, { y: Pd.y, z: AIM_Z });
    fb.box(W.band.w, W.band.h, W.band.d, S.teamPaint, { y: W.band.y, z: AIM_Z, detail: 0 });
    fb.box(Pd.w * 0.9, 1.2, Pd.d * 0.9, S.teamPaint, { y: Pd.y - Pd.h / 2 + 0.6, z: AIM_Z, detail: 0 });
    const T = W.tubes;
    const N = W.nose;
    const endY = T.top - T.len;
    const muzzles = [];
    let n = 0;
    for (const x of T.xs) {
      for (const z of T.zs) {
        n += 1;
        fb.cylinder(T.r, T.r, T.len, seg, S.frame, { x, y: T.top - T.len / 2, z: AIM_Z + z }, true);
        fb.cylinder(N.r, N.tip, N.len, seg, S.hull, { x, y: endY + N.len / 2 + N.back - N.len, z: AIM_Z + z }, false);
        muzzles.push(addMuzzle(ub, ctx, 'rocketA', fist, n, [x, endY - N.back, AIM_Z + z], W.flash, UNIT_KIT.flash.color));
      }
    }
    return { muzzles };
  },

  // tank gun: team breech block, thick recoil jacket, long barrel with a fume extractor and a muzzle brake with a team ring
  tankCannon(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const Br = W.breech;
    block(fb, kit, Br.w, Br.h, Br.d, S.teamPaint, { y: Br.y, z: AIM_Z });
    const Sl = W.sleeve;
    fb.cylinder(Sl.r, Sl.r, Sl.len, seg + 2, S.hullDark, { y: Sl.top - Sl.len / 2, z: AIM_Z }, true);
    const B = W.barrel;
    fb.cylinder(B.r, B.r, B.len, seg, S.frame, { y: B.top - B.len / 2, z: AIM_Z }, true);
    const Ev = W.evac;
    fb.cylinder(Ev.r, Ev.r, Ev.len, seg, S.hullDark, { y: B.top - Ev.at, z: AIM_Z }, true);
    const endY = B.top - B.len;
    const Bk = W.brake;
    fb.cylinder(Bk.r, Bk.r * 0.9, Bk.len, seg, S.hullDark, { y: endY + Bk.len * 0.5, z: AIM_Z }, true);
    fb.cylinder(Bk.teamR, Bk.teamR, Bk.teamLen, seg, S.teamPaint, { y: endY + Bk.len + Bk.teamLen * 0.3, z: AIM_Z }, true);
    return { muzzles: [addMuzzle(ub, ctx, 'tank', fist, 1, [0, endY - 0.3, AIM_Z], W.flash, UNIT_KIT.flash.color)] };
  },

  // fuel tank (team) + hose + short nozzle with a heat shroud; the pilot flame always burns, the muzzle flash is a long fire cone
  flamethrower(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const Tk = W.tank;
    fb.cylinder(Tk.r, Tk.r, Tk.len, seg + 2, S.teamPaint, { y: Tk.y - Tk.len / 2 + 1.2, z: AIM_Z + Tk.z }, true);
    fb.cylinder(W.cap.r, W.cap.r * 0.7, W.cap.len, seg + 2, S.hullDark, { y: Tk.y + 1.2 + W.cap.len / 2, z: AIM_Z + Tk.z }, true);
    fb.cylinder(W.cap.r, W.cap.r * 0.7, W.cap.len, seg + 2, S.hullDark, { y: Tk.y - Tk.len + 1.2 - W.cap.len / 2, z: AIM_Z + Tk.z }, true);
    const Hs = W.hose;
    limbBetween(fb, kit, [Hs.from[0], Hs.from[1], AIM_Z + Hs.from[2]], [Hs.to[0], Hs.to[1], AIM_Z + Hs.to[2]], Hs.w, Hs.w, S.frame);
    const N = W.nozzle;
    fb.cylinder(N.rRear, N.rFront, N.len, seg, S.frame, { y: N.top - N.len / 2, z: AIM_Z }, true);
    const endY = N.top - N.len;
    fb.cylinder(W.flare.r, W.flare.r * 0.8, W.flare.len, seg, S.hullDark, { y: N.top - W.flare.at, z: AIM_Z }, true);
    const Pl = W.pilot;
    ub.glow(fist).flame(Pl.near, Pl.far, Pl.len, FLASH_SEG, FLAME_COLOR, { rx: -HALF_PI, y: endY, z: AIM_Z, intensity: Pl.idle });
    return { muzzles: [addMuzzle(ub, ctx, 'flame', fist, 1, [0, endY - 0.2, AIM_Z], W.flash, FLAME_COLOR)] };
  },

  // long plasma rifle: team receiver, scope with a lens on top, glowing coils along a slim barrel, charge orb
  plasmaSniper(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const color = kit.glowColors.beam;
    const B = W.barrel;
    fb.cylinder(B.rRear, B.rFront, B.len, seg, S.frame, { y: B.top - B.len / 2, z: AIM_Z }, true);
    const Sh = W.shroud;
    block(fb, kit, Sh.w, Sh.h, Sh.d, S.teamPaint, { y: Sh.y, z: AIM_Z });
    const gl = ub.glow(fist);
    W.coils.at.forEach((y, i) => {
      fb.cylinder(W.coils.r, W.coils.r, W.coils.len, W.coils.seg, i === 0 ? S.teamPaint : S.hullDark, { y, z: AIM_Z }, true);
      gl.cylinder(W.coils.glowR, W.coils.glowR, W.coils.glowLen, W.coils.glowSeg, color, { y, z: AIM_Z });
    });
    const Sc = W.scope;
    fb.cylinder(Sc.r, Sc.r, Sc.len, seg, S.hullDark, { y: Sc.y - Sc.len / 2 + 1.0, z: AIM_Z + Sc.z }, true);
    gl.point([0, Sc.y - Sc.len + 1.0, AIM_Z + Sc.z], Sc.lensR, color, { intensity: GLOW_DIM });
    const charge = addCharge(ub, ctx, 'sniperCharge', fist, [0, W.orb.y, AIM_Z], W.orb.r, color, W.orb.seg);
    const muzzle = addMuzzle(ub, ctx, 'sniper', fist, 1, [0, W.muzzleY, AIM_Z], W.flash, color);
    return { muzzles: [muzzle], charge };
  },
};

const RANGED = {
  rocketArm: { label: 'Rocket arm', attack: 'launcher' },
  tankCannon: { label: 'Tank cannon', attack: 'launcher' },
  flamethrower: { label: 'Flamethrower', attack: 'gun' },
  plasmaSniper: { label: 'Plasma sniper', attack: 'beam' },
};

for (const [id, def] of Object.entries(RANGED)) {
  registerRobotPart('arm', id, {
    label: def.label,
    build(ub, kit, ctx) {
      const W = A16_ARM_SHAPES[id];
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
