// Steel Men – procedural ranged robot arms (B6): carpetBomb, energyBlaster, homingMissile, longMissile, plasmaCannon,
// protoBlast, sniperLaser. Same rig and contract as the gattling arm in RobotArms.js: bones shoulder → elbow → fist
// (shared upper arm = buildUpperArm), a gun housing in place of the forearm, the weapon front on the 'fist' bone and
// the barrels along −Y (forward while the forearm is held up). Muzzles are `socket_Launch_<L|R><n>` (MUZZLE.socketPatterns,
// unique per robot) with one flash bone each (ub.onFire); beam arms add a charge glow bone (rig.charge, grows while charging).
// Attack clips (ROBOT_KIT.anim, B5): launcher (carpetBomb, homingMissile, longMissile), blaster (energyBlaster),
// beam (plasmaCannon, protoBlast, sniperLaser). Visual only – the GLB body stays hidden underneath and drives the simulation.
// Style (kit.style.silhouette) changes barrel sides and adds a fin on the sharp styles; faction names never appear here.
import { registerRobotPart, lightLine } from './RobotKit.js';
import { limbLoft, armor, frontFlat } from './RobotSculpt.js';
import { ARM_SHAPES, buildUpperArm } from './RobotArms.js';
import { UNIT_KIT } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;
const LINE_GLUE = 0.02;
const LINE_FIT = 0.85;
const HOUSING_POINTS = 8;
const FLASH_SEG = 4;                                       // muzzle flash cone sides (budget)
const TUBE_SEG = { rounded: 6, round: 6, angular: 4, faceted: 5 };   // open barrel / tube sides by silhouette
const TUBE_SEG_DEFAULT = 6;
const SHARP_STYLES = { angular: true, faceted: true };
const ORB_SEG = [5, 4];                                    // glow orbs (charge cores)
const BULB_SEG = [6, 4];                                   // protoBlast emitter bulb

// Shared upper arm (pauldron, upper arm, elbow) from the gattling arm; the pad fin is drawn on sharp styles
const BASE = { ...ARM_SHAPES.gattling, fin: ARM_SHAPES.fist.fin };
const HOUSING_PROFILE = [[-0.12, 0.82, 0.82], [0.2, 1, 1, 0.1], [1.02, 0.86, 0.86]];
const HOUSING_SIDE = { w: 3.2, h: 2.2, th: 0.3, at: 0.5 };   // team armour on the outer side (at = share elbow → fist)
const TOP_LINE = { len: 3.0, at: 0.5 };
const SFX_AT = [0, -2.5, 0.9];                             // socket_SFX_1_<L|R> (GLB sets with socket_SFX_1)
const REST_HOLD = { elbow: -0.12, shoulder: 0 };            // rest pose request: forearm (weapon) hangs down like the GLB
const AIM_Z = 0.2;                                        // barrel axis offset along z (hand z)

// Weapon dimensions (fist bone space, forward = −Y). hw / hd = housing width / depth. sfx = GLB has socket_SFX_1.
export const RANGED_ARM_SHAPES = {
  carpetBomb: {
    hw: 4.4, hd: 4.4, sfx: true,
    pod: { w: 6.6, h: 8.0, d: 5.4, z: 0.2, front: -3.0 },     // big team box (forearm sized), 3 × 2 tubes in the front face
    tubes: { cols: 3, rows: 2, dx: 2.0, dz: 2.7, r: 0.85, len: 1.6, inset: 1.0 },
    flash: { near: 0.5, far: 0.1, len: 1.0, core: 0.5, noCore: true },
  },
  homingMissile: {
    hw: 4.2, hd: 4.2, sfx: true,
    tubes: { dx: 1.75, r: 1.55, len: 9.0, top: 4.5 }, plate: { w: 4.6, h: 8.0, d: 0.45 },   // double pod, plate between the tubes
    nose: { r: 1.2, tip: 0.1, len: 2.2, back: 1.0 }, seeker: { r: 0.45 },
    flash: { near: 0.6, far: 0.12, len: 1.2, core: 0.55 },
  },
  longMissile: {
    hw: 4.0, hd: 4.0, sfx: true,
    tube: { r: 2.1, len: 13.0, top: 5.0 }, rim: { r: 2.4, len: 0.6, at: 0.3 }, collar: { r: 2.3, len: 0.6, y: 1.5 },   // one long fat tube
    nose: { r: 1.7, tip: 0.15, len: 3.0, back: 0.8 }, stripe: { w: 1.3, h: 9.0, th: 0.35 },
    fin: { w: 0.4, h: 3.2, d: 2.0, y: 2.0 },                 // top fin (sharp styles)
    flash: { near: 0.9, far: 0.15, len: 2.0, core: 0.8 },
  },
  plasmaCannon: {
    hw: 4.4, hd: 4.4, sfx: true,
    barrel: { rRear: 2.6, rFront: 1.9, len: 9.0, top: 4.0 },   // thick barrel with glowing coil rings
    coils: { r: 3.0, len: 0.7, at: [-3.0, -0.5, 2.0], glowR: 3.05, glowLen: 0.2, team: 1 },   // at = −y on the fist bone
    nozzle: { rRear: 2.3, rFront: 1.6, len: 1.2, y: -5.4 },
    orb: { r: 1.6, y: -6.2 }, muzzleY: -6.4,
    flash: { near: 1.0, far: 0.2, len: 2.0, core: 0.9 },
  },
  protoBlast: {
    hw: 4.2, hd: 4.2, sfx: false,
    bulb: { r: 3.3, y: -0.5 },                                  // big reactor sphere
    prongs: { ring: 2.6, w: 1.0, len: 5.0, y: -4.5, tilt: 0.22, team: 0 },   // 4 prongs (cage) round the axis, team = index of the team-coloured one
    orb: { r: 1.8, y: -3.2, seg: [5, 3] }, muzzleY: -6.8,
    flash: { near: 1.1, far: 0.25, len: 1.8, core: 1.0, noCore: true },
  },
  energyBlaster: {
    hw: 4.0, hd: 4.0, sfx: true,
    shroud: { w: 4.6, h: 6.0, d: 3.6, y: 0.5 },                 // wide team body
    barrels: { dx: 1.1, r: 0.8, len: 3.0, top: 3.0, flare: 1.7, flareR: 1.5 }, vein: { w: 0.16, len: 4.0 },   // twin barrels with flared mouths
    lens: { r: 0.55, y: -4.3 },
    flash: { near: 0.45, far: 0.1, len: 1.2, core: 0.45 },
  },
  sniperLaser: {
    hw: 3.4, hd: 3.4, sfx: true,
    barrel: { r: 0.75, len: 14.0, top: 3.0 }, clamps: { r: 1.2, len: 0.5, at: [3.0, 7.0] },   // very long thin barrel
    shroud: { w: 3.2, h: 6.0, d: 3.2, y: 0.5 },
    scope: { w: 1.4, h: 5.0, d: 1.4, y: -1.0 }, scopeLens: { w: 0.9, t: 0.14, y: -3.55 },
    orb: { r: 0.9 }, muzzleY: -11.0,
    flash: { near: 0.35, far: 0.08, len: 3.0, core: 0.35 },
  },
};

const segOf = (kit) => TUBE_SEG[kit.style.silhouette] ?? TUBE_SEG_DEFAULT;

// Interpolated depth share of a limb profile at t (light line height on the housing)
function depthAt(profile, t) {
  let i = 1;
  while (i < profile.length - 1 && profile[i][0] < t) i++;
  const a = profile[i - 1];
  const b = profile[i];
  const k = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
  return { ds: a[2] + (b[2] - a[2]) * k, oz: (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * k };
}

// Upper arm + housing (elbow → fist) + side armour + top light line; returns the arm bones
function buildBase(ub, kit, ctx, W) {
  const S = kit.S;
  const sg = ctx.side;
  const { shoulder, elbow, fist } = buildUpperArm(ub, kit, ctx, BASE, { elbowRim: false });
  const eb = ub.paint(elbow);
  limbLoft(eb, kit, [0, 0, 0], BASE.fist, W.hw, W.hd, HOUSING_PROFILE, S.hullDark, { points: HOUSING_POINTS });
  const Sd = HOUSING_SIDE;
  const sideW = (W.hw * HOUSING_PROFILE[1][1]) / 2;
  armor(eb, kit, Sd.w, Sd.h, Sd.th, S.teamPaint, {
    x: sg * (sideW + Sd.th / 2), y: BASE.fist[1] * Sd.at, z: BASE.fist[2] * Sd.at, ry: sg * HALF_PI,
  });
  const dp = depthAt(HOUSING_PROFILE, TOP_LINE.at);
  const top = frontFlat(kit, W.hw * HOUSING_PROFILE[1][1], W.hd * dp.ds, { points: HOUSING_POINTS });
  lightLine(eb, kit, Math.min(TOP_LINE.len, -BASE.fist[1] * LINE_FIT * 0.5), 'y', {
    y: BASE.fist[1] * TOP_LINE.at, z: BASE.fist[2] * TOP_LINE.at + top.z + dp.oz + LINE_GLUE,
  });
  return { shoulder, elbow, fist };
}

// Muzzle socket n + its flash bone (hidden until fired); returns the socket name
function addMuzzle(ub, ctx, id, fist, n, pos, F, outer, lensIndex = -1) {
  const bone = ub.bone(`${id}Flash${ctx.sfx}${n}`, fist, pos);
  const g = ub.glow(bone);
  g.flame(F.near, F.far, F.len, FLASH_SEG, outer, { rx: -HALF_PI });
  if (!F.noCore) g.point([0, -F.core, 0], F.core, UNIT_KIT.flash.core);   // noCore: triangle budget (flame only)
  const fi = ub.meta.flashes.push({ bone }) - 1;
  const socket = `${ctx.sockets.launch}${ctx.sfx}${n}`;   // socket_Launch_L1 … (MUZZLE.socketPatterns)
  ub.socket(socket, fist, [pos[0], pos[1] - LINE_OUT, pos[2]]);
  ub.onFire(socket, lensIndex >= 0 ? { flashes: [fi], lenses: [lensIndex] } : { flashes: [fi] });
  return socket;
}

// Glow lens bone (idle pulse, flares when its muzzle fires); returns the lens index
function addLens(ub, ctx, name, fist, pos) {
  const bone = ub.bone(`${name}${ctx.sfx}`, fist, pos);
  return { bone, index: ub.meta.lenses.push({ bone }) - 1 };
}

// Charge glow bone (rig.charge: scale 0 → 1 while the beam charges)
function addCharge(ub, ctx, name, fist, pos, r, color, seg = ORB_SEG) {
  const bone = ub.bone(`${name}${ctx.sfx}`, fist, pos);
  ub.glow(bone).sphere(r, seg[0], seg[1], color);
  // [B6 QA-2] also a flash: ProcUnit keeps it hidden at rest (arm wreck, part icon); ProcRobot.update runs after the flash
  // pass and drives its charge scale, so on a robot the charge glow still grows
  ub.meta.flashes.push({ bone });
  return bone;
}

const FLASH_FIRE = () => UNIT_KIT.flash.color;

const FRONTS = {
  carpetBomb(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const P = W.pod;
    const T = W.tubes;
    const seg = segOf(kit);
    fb.box(P.w, P.h, P.d, S.teamPaint, { y: P.front + P.h / 2, z: P.z });
    const muzzles = [];
    let n = 1;
    const frontY = P.front - T.len + T.inset;   // tube front end
    for (let r = 0; r < T.rows; r++) {
      for (let c = 0; c < T.cols; c++) {
        const x = (c - (T.cols - 1) / 2) * T.dx;
        const z = P.z + (r - (T.rows - 1) / 2) * T.dz;
        fb.cylinder(T.r, T.r, T.len, seg, S.frame, { x, y: P.front + T.inset - T.len / 2, z }, true);
        muzzles.push(addMuzzle(ub, ctx, 'carpet', fist, n++, [x, frontY, z], W.flash, FLASH_FIRE()));
      }
    }
    return { muzzles };
  },

  homingMissile(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const T = W.tubes;
    const N = W.nose;
    const muzzles = [];
    for (let i = 0; i < 2; i++) {
      const x = (i === 0 ? -1 : 1) * T.dx;
      fb.cylinder(T.r, T.r, T.len, seg, S.frame, { x, y: T.top - T.len / 2, z: AIM_Z }, true);
      // missile nose: base inside the tube mouth, tip sticks out (cylinder top radius is at +y)
      const tipY = T.top - T.len - N.len + N.back;
      fb.cylinder(N.r, N.tip, N.len, seg, S.hull, { x, y: tipY + N.len / 2, z: AIM_Z }, false);
      ub.glow(fist).point([x, tipY, AIM_Z], W.seeker.r, kit.glowColors.beacon);
      muzzles.push(addMuzzle(ub, ctx, 'homing', fist, i + 1, [x, tipY, AIM_Z], W.flash, FLASH_FIRE()));
    }
    const Pl = W.plate;
    fb.box(Pl.w, Pl.h, Pl.d, S.teamPaint, { y: T.top - Pl.h / 2, z: AIM_Z + T.r + Pl.d / 2 });
    return { muzzles };
  },

  longMissile(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const T = W.tube;
    fb.cylinder(T.r, T.r, T.len, seg, S.frame, { y: T.top - T.len / 2, z: AIM_Z }, true);
    fb.cylinder(W.rim.r, W.rim.r, W.rim.len, seg, S.hullDark, { y: T.top - T.len + W.rim.at, z: AIM_Z }, true);
    fb.cylinder(W.collar.r, W.collar.r, W.collar.len, seg, S.hullDark, { y: W.collar.y, z: AIM_Z }, true);
    const N = W.nose;
    const tipY = T.top - T.len - N.len + N.back;
    fb.cylinder(N.r, N.tip, N.len, seg, S.hull, { y: tipY + N.len / 2, z: AIM_Z }, false);
    const St = W.stripe;
    fb.box(St.w, St.h, St.th, S.teamPaint, { y: T.top - St.h / 2 - 0.5, z: AIM_Z + T.r + St.th / 2 });
    if (SHARP_STYLES[kit.style.silhouette]) {
      fb.box(W.fin.w, W.fin.h, W.fin.d, S.hullDark, { y: W.fin.y, z: AIM_Z + T.r + W.fin.d / 2 });
    }
    return { muzzles: [addMuzzle(ub, ctx, 'long', fist, 1, [0, tipY, AIM_Z], W.flash, FLASH_FIRE())] };
  },

  plasmaCannon(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const B = W.barrel;
    fb.cylinder(B.rRear, B.rFront, B.len, seg, S.frame, { y: B.top - B.len / 2, z: AIM_Z }, true);
    const C = W.coils;
    const gb = ub.glow(fist);
    C.at.forEach((y, i) => {
      fb.cylinder(C.r, C.r, C.len, seg, i === C.team ? S.teamPaint : S.hullDark, { y: -y, z: AIM_Z }, true);
      gb.cylinder(C.glowR, C.glowR, C.glowLen, seg, kit.glowColors.beam, { y: -y, z: AIM_Z });
    });
    const Nz = W.nozzle;
    fb.cylinder(Nz.rRear, Nz.rFront, Nz.len, seg, S.hullDark, { y: Nz.y, z: AIM_Z }, true);
    const charge = addCharge(ub, ctx, 'plasmaCharge', fist, [0, W.orb.y, AIM_Z], W.orb.r, kit.glowColors.beam);
    return { muzzles: [addMuzzle(ub, ctx, 'plasma', fist, 1, [0, W.muzzleY, AIM_Z], W.flash, kit.glowColors.beam)], charge };
  },

  protoBlast(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    fb.sphere(W.bulb.r, BULB_SEG[0], BULB_SEG[1], S.hullDark, { y: W.bulb.y, z: AIM_Z });
    const P = W.prongs;
    // four prongs round the axis (+x, +z, −x, −z), tips leaning inward
    for (let i = 0; i < 4; i++) {
      const a = HALF_PI * i;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      const t = {
        x: cx * P.ring, y: P.y, z: AIM_Z + cz * P.ring,
        rz: -cx * P.tilt, rx: cz * P.tilt,
      };
      fb.box(P.w, P.len, P.w, i === P.team ? S.teamPaint : S.frame, t);
    }
    const charge = addCharge(ub, ctx, 'protoCharge', fist, [0, W.orb.y, AIM_Z], W.orb.r, kit.glowColors.beam, W.orb.seg);
    return { muzzles: [addMuzzle(ub, ctx, 'proto', fist, 1, [0, W.muzzleY, AIM_Z], W.flash, kit.glowColors.beam)], charge };
  },

  energyBlaster(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const Sh = W.shroud;
    fb.box(Sh.w, Sh.h, Sh.d, S.teamPaint, { y: Sh.y, z: AIM_Z });
    const B = W.barrels;
    const muzzles = [];
    const endY = B.top - B.len - B.flare;   // flared mouth end
    for (let i = 0; i < 2; i++) {
      const x = (i === 0 ? -1 : 1) * B.dx;
      fb.cylinder(B.r, B.r, B.len, seg, S.frame, { x, y: B.top - B.len / 2, z: AIM_Z }, true);
      fb.cylinder(B.r, B.flareR, B.flare, seg, S.hullDark, { x, y: B.top - B.len - B.flare / 2, z: AIM_Z }, true);
      ub.glow(fist).box(W.vein.w, W.vein.len, W.vein.w, kit.glowColors.beam, { x, y: B.top - W.vein.len / 2 - 0.3, z: AIM_Z + B.r });
      const lens = addLens(ub, ctx, `blasterLens${i + 1}`, fist, [x, W.lens.y, AIM_Z]);
      ub.glow(lens.bone).point([0, 0, 0], W.lens.r, kit.glowColors.beam);
      muzzles.push(addMuzzle(ub, ctx, 'blaster', fist, i + 1, [x, endY - LINE_OUT, AIM_Z], W.flash, kit.glowColors.beam, lens.index));
    }
    return { muzzles };
  },

  sniperLaser(ub, kit, ctx, W, fist) {
    const S = kit.S;
    const fb = ub.paint(fist);
    const seg = segOf(kit);
    const B = W.barrel;
    fb.cylinder(B.r, B.r, B.len, seg, S.frame, { y: B.top - B.len / 2, z: AIM_Z }, true);
    for (const y of W.clamps.at) fb.cylinder(W.clamps.r, W.clamps.r, W.clamps.len, seg, S.hullDark, { y: -y, z: AIM_Z }, true);
    const Sh = W.shroud;
    fb.box(Sh.w, Sh.h, Sh.d, S.teamPaint, { y: Sh.y, z: AIM_Z });
    const Sc = W.scope;
    const scopeZ = AIM_Z + Sh.d / 2 + Sc.d / 2 - 0.2;   // sits on top of the shroud
    fb.box(Sc.w, Sc.h, Sc.d, S.hullDark, { y: Sc.y, z: scopeZ });
    const L = W.scopeLens;
    const lens = addLens(ub, ctx, 'sniperLens', fist, [0, L.y, scopeZ]);
    ub.glow(lens.bone).box(L.w, L.t, L.w, kit.glowColors.beam);
    const charge = addCharge(ub, ctx, 'sniperCharge', fist, [0, W.muzzleY - W.orb.r, AIM_Z], W.orb.r, kit.glowColors.beam);
    return { muzzles: [addMuzzle(ub, ctx, 'sniper', fist, 1, [0, W.muzzleY, AIM_Z], W.flash, kit.glowColors.beam, lens.index)], charge };
  },
};

// id → label, attack clip (ROBOT_KIT.anim), burst = shots per attack (= stats burst: carpetBomb 6, the rest 1)
const ARMS = {
  carpetBomb: { label: 'Carpet bomb', attack: 'launcher', shots: 6 },
  homingMissile: { label: 'Homing missile', attack: 'launcher', shots: 1 },
  longMissile: { label: 'Long missile', attack: 'launcher', shots: 1 },
  energyBlaster: { label: 'Energy blaster', attack: 'blaster', shots: 1 },
  plasmaCannon: { label: 'Plasma cannon', attack: 'beam', shots: 1 },
  protoBlast: { label: 'Proto blast', attack: 'beam', shots: 1 },
  sniperLaser: { label: 'Sniper laser', attack: 'beam', shots: 1 },
};

for (const [id, def] of Object.entries(ARMS)) {
  registerRobotPart('arm', id, {
    label: def.label,
    build(ub, kit, ctx) {
      const W = RANGED_ARM_SHAPES[id];
      const { shoulder, elbow, fist } = buildBase(ub, kit, ctx, W);
      const F = FRONTS[id](ub, kit, ctx, W, fist);
      if (W.sfx) ub.socket(`${ctx.sockets.sfx}_${ctx.sfx}`, fist, SFX_AT);   // socket_SFX_1_L / _R
      const rig = { shoulder, elbow, fist, attack: def.attack, fire: F.muzzles[0], muzzles: F.muzzles, shots: def.shots };
      if (F.charge) rig.charge = F.charge;
      rig.hold = REST_HOLD;   // requested kit support: rest pose (weapon hangs along the body); ignored by the kit until it reads rig.hold
      return { rig };
    },
  });
}
