// Steel Men – procedural robot torsos, B6 set: armor, frame, drunkMissile, recon, camo, emp, forceField, howitzer, jetPack,
// selfRepair, tracer. Same rig as the basic torso (RobotTorsos.js): 'chest' (on the 'torso' wrapper) → 'head' + 'visor',
// arm sockets at the basic positions (so every arm fits), aim / smoke points. Weapon torsos use rig.weapon
// { kind: 'launch' | 'pulse' | 'artillery', muzzles, shots, charge? } (RobotKit chest attack clips) with socket_Launch_<n>
// muzzles + flashes / recoils through ub.onFire. Robot faces +Z. Construction time only; shapes differ by kit.style.silhouette
// only through the RobotSculpt families (never by race). Visual only – the simulation reads the hidden GLB body.
// Round 2: every torso reads from the RTS camera by its silhouette (big simple shapes: proportions, head, add-ons that
// stand out over the shoulders / beside the arms), not by small details.
import { registerRobotPart, gltfNode, lightLine, shapeOf } from './RobotKit.js';
import { hullLoft, lengthLoft, armor, hinge, frontFlat, frontAt, sideFace } from './RobotSculpt.js';
import { TORSO_SHAPES } from './RobotTorsos.js';
import { UNIT_KIT, unitStyle } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;       // light lines / plates stand this far off the surface
const EMBLEM_OUT = 0.04;     // emblem decal off the front face
const GLOW_DIM = 0.6;
const LINE_GLUE = 0.02;
const LINE_FIT = 0.85;
const VISOR_FIT = 0.95;
const SEG_SMALL = 6;
const SEG_ROUND = 8;
const TUBE_SEG = 5;          // open tubes (rack tubes, barrels)
const MAST_T = 0.24;
const ORB_SEG = [6, 4];      // glow orb (width, height segments)
const RING_SEG = [3, 10];    // torus rings (radial, tubular)
const CAMO_ORB_SEG = [5, 3]; // camo emitter glow node (triangle budget)
const CAMO_RING_SEG = [3, 8];
const PHASE_STEP = 1.3;      // pulse phase offset between sibling glow nodes (rad)

// body scale per variant relative to basic (arm sockets stay at the basic x so every arm fits)
const BODY_SCALE = {
  armor: { w: 1.1, d: 1.3, plates: true, abdomen: true },      // deep, bulky chest
  heavy: { w: 1.05, d: 1.1, plates: true, abdomen: true },
  frame: { w: 0.55, d: 0.8, plates: false, abdomen: false },    // slim core column, the rest is bare cage
  round: { w: 1.0, d: 1.15, plates: true, abdomen: true },
  light: { w: 0.96, d: 0.96, plates: true, abdomen: true },
  basic: { w: 1, d: 1, plates: true, abdomen: true },
};

/**
 * Per-variant dimensions (chest space, raw GLB units). `head` = [width, depth] scale of the basic head (head variation).
 * Arm sockets are at (±5.35, 6.7, −1.6); body top ≈ 8.6; head top ≈ 11.
 */
export const TORSO_B6 = {
  armor: {
    scale: 'armor', head: [0.9, 0.85],
    pauldron: { w: 4.6, h: 3.4, th: 0.9, x: 4.9, y: 9.2, z: -1.0, roll: 0.4 },   // huge shoulder plates standing over the arms
    cap: { w: 3.6, h: 1.6, th: 0.45, y: 0.4 },
    collar: { stations: [[7.2, 7.4, 6.4], [8.8, 6.8, 6.0], [10.0, 5.0, 4.4]], z: -0.4 },   // high collar around the head [y, w, d]
    chestPlate: { w: 6.4, h: 4.0, th: 0.7, y: 5.2 },
    back: { w: 6.0, h: 4.4, th: 1.0, y: 5.0 },
  },
  frame: {
    scale: 'frame', head: [0.85, 0.85],
    ribs: { count: 4, w: 7.4, h: 0.5, d: 3.4, y: 2.6, gap: 1.5 },                 // bare rib rings around the slim core
    bar: { w: 10.8, h: 0.8, d: 1.0, y: 7.9, z: -1.6 },                            // shoulder bar linking both arm housings
    spine: { r: 0.45, h: 7.0, y: 4.8 },
    battery: { w: 2.6, h: 3.2, d: 1.6, y: 4.6 },
    cell: { w: 1.6, h: 2.2, d: 0.2 },
    struts: { x: 3.4, len: 5.0, r: 0.3, y: 3.2, tilt: 0.28 },
  },
  recon: {
    scale: 'light', head: [1.5, 1.0],                                             // wide sensor head
    mast: { w: 0.4, h: 6.6, x: 3.5, y: 7.6, z: -2.0 },
    dish: { rTop: 3.2, rBottom: 0.8, h: 1.2, tilt: -0.9, spin: 1.6, lens: 0.6 },
    whip: { x: -3.5, y: 7.6, z: -2.0, r: 0.14, h: 7.6, amp: 0.1, hz: 0.45 },
    eye: { w: 1.4, h: 0.5, y: 2.5 },
    back: { w: 4.4, h: 3.0, d: 1.4, y: 5.0 },
  },
  camo: {
    scale: 'round', head: [1.15, 1.1],                                            // smooth hooded head
    cape: { stations: [[3.0, 7.0, 1.4], [6.0, 10.8, 2.4], [9.4, 8.0, 1.8]], tuck: 0.6 },   // smooth rounded back hood [y, w, d]
    nodes: [[-3.9, 9.0, -0.6], [3.9, 9.0, -0.6], [-2.2, 5.4, -4.2], [2.2, 5.4, -4.2]],   // cloak emitters (chest space)
    node: { r: 0.6, ring: 1.0, tube: 0.2, hz: 0.7, depth: 0.45 },
    back: { w: 5.0, h: 2.6, d: 0.6, y: 5.0 },
  },
  drunkMissile: {
    scale: 'basic',
    pod: { w: 3.2, h: 3.0, d: 4.6, x: 3.5, y: 10.4, z: -0.8, tilt: -0.55 },       // two big rocket boxes over the shoulders
    tubes: [[-0.9, 0.6], [0.9, 0.6], [0, -0.7]],                                  // per pod → 6 rockets (stats burst 6)
    tube: { r: 0.62, len: 1.3, recoil: 0.35 },
    podLoft: [[-0.5, 0.85, 0.85], [0, 1, 1], [0.5, 0.9, 0.9]],
    plate: { w: 2.8, h: 1.6, th: 0.25 },
    shots: 6,
    rear: { w: 4.8, h: 2.4, d: 1.4, y: 6.0 },
  },
  tracer: {
    scale: 'basic',
    pod: { w: 1.8, h: 1.8, d: 4.2, x: 3.4, y: 9.8, z: -0.4, tilt: -0.1 },         // long twin gun pods
    tubes: [[0, 0]],
    tube: { r: 0.38, len: 4.0, recoil: 0.3 },
    podLoft: [[-0.5, 0.8, 0.8], [0, 1, 1], [0.5, 0.85, 0.85]],
    plate: { w: 2.4, h: 1.1, th: 0.2 },
    shots: 8,
    lens: { r: 0.6, y: 0.75, z: -0.4 },
    rear: { w: 4.0, h: 2.2, d: 1.2, y: 5.8 },
  },
  emp: {
    scale: 'light', head: [0.95, 0.95],
    mast: { r: 0.6, h: 1.8, y: 7.6, z: -3.0 },
    ring: { r: 3.4, tube: 0.38, y: 12.0, z: -3.2 },                               // big vertical emitter ring like a halo behind the head
    spoke: { w: 0.5 },
    core: { r: 0.9, charge: 1.8 },
    coils: { x: 2.6, r: 0.8, h: 3.0, y: 5.2, gap: 0.55, count: 2 },
    shots: 1,
    spin: 1.4,
  },
  forceField: {
    scale: 'basic', head: [1.0, 1.0],
    ring: { r: 4.6, tube: 0.45, y: 7.4, out: 0.6, spin: 0.9 },                    // huge projector ring behind the chest, above the shoulders
    core: { r: 1.0, hz: 0.55, depth: 0.25 },
    posts: { x: 3.9, h: 5.0, w: 0.9, y: 10.6, tip: 0.95, tilt: 0.25 },            // two projector prongs rising from the shoulders
    base: { w: 4.6, h: 2.8, d: 1.2, y: 5.6 },
  },
  howitzer: {
    scale: 'heavy', head: [0.95, 0.9],
    side: 1,                                                                       // gun on the right shoulder (+x)
    strut: { x: 3.7, w: 1.6, h: 3.4, d: 1.4, y: 8.6, z: -1.6 },
    drum: { x: -3.7, r: 1.7, h: 3.2, y: 9.4, z: -1.8 },                           // ammo drum on the left shoulder (counterweight)
    cradle: { at: [3.7, 11.4, -1.6], w: 3.2, h: 2.6, d: 3.6 },
    barrel: { r: 0.8, len: 13, z: 0.6, tilt: -0.3, recoil: 1.6, brakeW: 1.9, brakeLen: 1.0, sleeveR: 1.15, sleeveLen: 4.4 },
    flash: { core: 1.0 },
    charge: { r: 1.2 },
    base: { w: 9.6, h: 1.2, d: 4.4, y: 8.7, z: -1.8 },
    shots: 1,
  },
  jetPack: {
    scale: 'basic', head: [1.0, 1.0],
    tank: { x: 2.9, r: 1.5, h: 6.6, y: 6.8, out: 2.0 },                           // tall tanks standing above the shoulders
    nozzle: { rTop: 1.5, rBottom: 0.9, h: 1.2 },
    flame: { rTop: 0.8, rBottom: 0.15, h: 2.0, hz: 4.2, depth: 0.28 },
    brace: { h: 0.6, d: 0.8, y: 6.6 },
    wing: { w: 4.0, h: 6.6, th: 0.35, x: 2.4, y: 1.4, roll: 0.5 },                // big wings spreading beyond the outline
  },
  selfRepair: {
    scale: 'basic', head: [1.05, 1.0],
    housing: { w: 5.2, h: 3.2, d: 2.0, y: 5.6 },
    cross: { len: 1.8, th: 0.45, hz: 0.5, depth: 0.2 },
    manip: { x: 3.6, y: 8.2, z: -2.0, up: 5.0, fore: 4.2, w: 0.8, tipR: 0.75, hz: 0.7, amp: 0.2, tilt: 0.9 },   // service arms rising over the shoulders
  },
};

// ---------------------------------------------------------------- shared body

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
function shapeFor(variant) {
  const B = TORSO_SHAPES.basic;
  const V = TORSO_B6[variant];
  const K = BODY_SCALE[V.scale];
  return {
    ...B, body: B.body.map(([y, w, d, z]) => [y, w * K.w, d * K.d, z]),
    head: V.head ? { ...B.head, scale: V.head } : B.head, K,
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

/** Waist, belly, chest, collar, shoulder housings, plates, emblem and head. Returns the torso contract (no rig extras yet). */
function buildBase(ub, kit, ctx, D) {
  const S = kit.S;
  const K = D.K;
  ub.bone(gltfNode(ctx, 'chest'), ctx.bone);
  const cb = ub.paint('chest');
  const keel = D.bodyKeel;
  hullLoft(cb, kit, D.waist.map(([y, w, d, z]) => ({ y, w, d, z })), S.frame);
  hullLoft(cb, kit, D.body.map(([y, w, d, z]) => ({ y, w, d, z, keel })), K.w < 0.7 ? S.hullDark : S.hull);
  const A = D.arms;
  const side = stationAt(D.body, D.sideLine.y);
  const face = sideFace(kit, side.w, side.d, { keel });
  for (const sign of [-1, 1]) {
    hinge(cb, kit, D.shoulder.r, D.shoulder.len, S.frame, { x: sign * D.shoulder.x, y: A.y, z: A.z });
    lightLine(cb, kit, Math.min(D.sideLine.len, face.len * LINE_FIT), 'z', { x: sign * (side.w / 2 + LINE_GLUE), y: D.sideLine.y, z: side.z + face.v });
  }
  const Ab = D.abdomen;
  const ab = stationAt(D.body, Ab.y);
  const abf = frontFlat(kit, ab.w, ab.d, { keel });
  if (K.abdomen) armor(cb, kit, Math.min(Ab.w, abf.w), Ab.h, Ab.th, S.teamShade, { y: Ab.y, z: ab.z + abf.z + Ab.th / 2, rx: -ab.tilt });
  const P = D.plates;
  const pc = stationAt(D.body, P.y);
  if (K.plates) {
    for (const sign of [-1, 1]) {
      const f = frontAt(kit, pc.w, pc.d, sign * P.x, { keel });
      const out = P.th / 2 + LINE_OUT;
      armor(cb, kit, P.w, P.h, P.th, S.teamPaint, {
        x: sign * P.x + Math.sin(f.yaw) * out, y: P.y, z: pc.z + f.z + Math.cos(f.yaw) * out, rx: -pc.tilt, ry: f.yaw,
      });
    }
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
    cb, head: hd, backAt, frontAt: (y) => { const s = stationAt(D.body, y); const f = frontFlat(kit, s.w, s.d, { keel }); return { z: s.z + f.z, w: f.w, tilt: s.tilt }; },
  };
}

/** Back housing (frame colour) glued onto the back of the chest at height y */
function backBox(b, kit, base, B) {
  b.box(B.w, B.h, B.d, kit.S.frame, { y: B.y, z: base.backAt(B.y) - B.d / 2 + LINE_OUT });
}

/** One muzzle on a barrel / tube: flash bone (hidden until fired), recoil, shot socket. Returns the socket name. */
function addMuzzle(ub, ctx, bone, name, len, recoil, index, flashOn) {
  const flash = UNIT_KIT.flash;
  const fl = ub.bone(`${name}Flash`, bone, [0, 0, len]);
  ub.glow(fl).point([0, 0, flashOn.core], flashOn.core, flash.core);
  const fi = ub.meta.flashes.push({ bone: fl }) - 1;
  const ri = ub.meta.recoils.push({ bone, dist: recoil }) - 1;
  const socket = `${ctx.sockets.launch}${index + 1}`;
  ub.socket(socket, bone, [0, 0, len + LINE_OUT]);
  ub.onFire(socket, { flashes: [fi], recoils: [ri] });
  return socket;
}

const FLASH_SMALL = { core: 0.5 };

// ---------------------------------------------------------------- shoulder pods (drunkMissile racks, tracer guns)

function buildPods(ub, kit, ctx, base, P, glowLens) {
  const S = kit.S;
  const muzzles = [];
  let n = 0;
  for (const sign of [-1, 1]) {
    const pod = ub.bone(`pod${sign < 0 ? 'L' : 'R'}`, 'chest', [sign * P.pod.x, P.pod.y, P.pod.z], { rotation: [P.pod.tilt, 0, 0] });
    const pb = ub.paint(pod);
    const Pd = P.pod;
    lengthLoft(pb, kit, P.podLoft.map(([zs, ws, hs]) => ({ z: zs * Pd.d, w: Pd.w * ws, h: Pd.h * hs })), S.hullDark, {}, { points: SEG_SMALL });
    armor(pb, kit, P.plate.w, P.plate.h, P.plate.th, S.teamPaint, { x: sign * (Pd.w / 2 + P.plate.th / 2), ry: sign * HALF_PI });
    const zEnd = Pd.d * P.podLoft[P.podLoft.length - 1][0];
    // pod mount to the shoulder (so it does not float over the collar)
    pb.box(Pd.w * 0.7, Pd.h * 0.6, Pd.d * 0.5, S.frame, { y: -Pd.h * 0.55, z: -Pd.d * 0.1 });
    for (const [x, y] of P.tubes) {
      const tube = ub.bone(`tube${n}`, pod, [x, y, zEnd]);
      ub.paint(tube).cylinder(P.tube.r, P.tube.r, P.tube.len, TUBE_SEG, S.dark, { z: P.tube.len / 2, rx: HALF_PI }, true);
      muzzles.push(addMuzzle(ub, ctx, tube, `tube${n}`, P.tube.len, P.tube.recoil, n, FLASH_SMALL));
      n++;
    }
    if (glowLens) ub.glow(pod).point([0, glowLens.y * Pd.h, glowLens.z * Pd.d], glowLens.r, unitStyle(kit).weaponGlow, { intensity: GLOW_DIM });
  }
  return muzzles;
}

// ---------------------------------------------------------------- armor / frame

registerRobotPart('torso', 'armor', {
  label: 'Armor torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.armor;
    const base = buildBase(ub, kit, ctx, shapeFor('armor'));
    const S = kit.S;
    const cb = base.cb;
    for (const sign of [-1, 1]) {
      const p = V.pauldron;
      armor(cb, kit, p.w, p.h, p.th, S.hull, { x: sign * p.x, y: p.y, z: p.z, rz: -sign * p.roll });
      armor(cb, kit, V.cap.w, V.cap.h, V.cap.th, S.teamPaint, { x: sign * (p.x + Math.sin(p.roll) * (p.th / 2 + V.cap.th / 2)), y: p.y + V.cap.y + Math.cos(p.roll) * (p.th / 2 + V.cap.th / 2), z: p.z, rz: -sign * p.roll });
    }
    hullLoft(cb, kit, V.collar.stations.map(([y, w, d]) => ({ y, w, d, z: V.collar.z })), S.hullDark, {}, { points: SEG_ROUND });
    const f1 = base.frontAt(V.chestPlate.y);
    armor(cb, kit, Math.min(V.chestPlate.w, f1.w), V.chestPlate.h, V.chestPlate.th, S.hullDark, { y: V.chestPlate.y - 1.4, z: f1.z + V.chestPlate.th / 2 + LINE_OUT, rx: -f1.tilt });
    cb.box(V.back.w, V.back.h, V.back.th, S.frame, { y: V.back.y, z: base.backAt(V.back.y) - V.back.th / 2 + LINE_OUT });
    return base.out;
  },
});

registerRobotPart('torso', 'frame', {
  label: 'Frame torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.frame;
    const base = buildBase(ub, kit, ctx, shapeFor('frame'));
    const S = kit.S;
    const cb = base.cb;
    const R = V.ribs;
    for (let i = 0; i < R.count; i++) {
      const y = R.y + i * R.gap;
      const fy = base.frontAt(y);
      cb.box(R.w, R.h, R.d, S.frame, { y, z: fy.z - R.d / 2 + 0.3 });
    }
    cb.box(V.bar.w, V.bar.h, V.bar.d, S.frame, { y: V.bar.y, z: V.bar.z });
    // exposed spine and a power cell on the back, bracing struts from the pelvis to the shoulder housings
    cb.cylinder(V.spine.r, V.spine.r, V.spine.h, SEG_SMALL, S.dark, { y: V.spine.y, z: base.backAt(V.spine.y) - V.spine.r + LINE_OUT }, true);
    const B = V.battery;
    const bz = base.backAt(B.y) - V.spine.r * 2 - B.d / 2 + LINE_OUT;
    cb.box(B.w, B.h, B.d, S.frame, { y: B.y, z: bz });
    ub.glow('chest').box(V.cell.w, V.cell.h, V.cell.d, kit.glowColors.reactor, { y: B.y, z: bz - B.d / 2 - LINE_OUT, intensity: GLOW_DIM });
    const f = base.frontAt(R.y);
    for (const sign of [-1, 1]) {
      const s = V.struts;
      cb.cylinder(s.r, s.r, s.len, SEG_SMALL, S.dark, { x: sign * s.x, y: s.y + s.len / 2 * Math.cos(s.tilt), z: f.z - 0.3, rz: sign * s.tilt }, true);
    }
    return base.out;
  },
});

// ---------------------------------------------------------------- weapon torsos

registerRobotPart('torso', 'drunkMissile', {
  label: 'Drunk missile torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.drunkMissile;
    const base = buildBase(ub, kit, ctx, shapeFor('drunkMissile'));
    backBox(base.cb, kit, base, V.rear);
    const muzzles = buildPods(ub, kit, ctx, base, V, null);
    base.out.rig.weapon = { kind: 'launch', muzzles, shots: V.shots };
    return base.out;
  },
});

registerRobotPart('torso', 'tracer', {
  label: 'Tracer torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.tracer;
    const base = buildBase(ub, kit, ctx, shapeFor('tracer'));
    backBox(base.cb, kit, base, V.rear);
    const muzzles = buildPods(ub, kit, ctx, base, V, V.lens);
    base.out.rig.weapon = { kind: 'launch', muzzles, shots: V.shots };
    return base.out;
  },
});

registerRobotPart('torso', 'emp', {
  label: 'EMP torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.emp;
    const base = buildBase(ub, kit, ctx, shapeFor('emp'));
    const S = kit.S;
    const cb = base.cb;
    const weaponGlow = unitStyle(kit).weaponGlow;
    cb.cylinder(V.mast.r, V.mast.r * 1.3, V.mast.h, SEG_SMALL, S.frame, { y: V.mast.y + V.mast.h / 2, z: V.mast.z }, true);
    const C = V.coils;
    for (const sign of [-1, 1]) {
      for (let i = 0; i < C.count; i++) {
        cb.cylinder(C.r, C.r, C.h / C.count - C.gap, SEG_ROUND, S.hullDark, { x: sign * C.x, y: C.y - C.h / 2 + (i + 0.5) * (C.h / C.count), z: base.backAt(C.y) - C.r + LINE_OUT }, true);
      }
    }
    // vertical emitter ring (spins around the view axis) with a cross spoke, a glowing core and a bigger charge orb
    const R = V.ring;
    const emit = ub.bone('empEmitter', 'chest', [0, R.y, R.z]);
    const eb = ub.paint(emit);
    eb.torus(R.r, R.tube, RING_SEG[0], RING_SEG[1], Math.PI * 2, S.frame, {});
    eb.box(R.r * 2, V.spoke.w, V.spoke.w, S.frame, { detail: 0 });
    eb.box(V.spoke.w, R.r * 2, V.spoke.w, S.frame, { detail: 0 });
    ub.glow(emit).torus(R.r * 0.7, R.tube * 0.6, RING_SEG[0], RING_SEG[1], weaponGlow, { intensity: GLOW_DIM });
    ub.glow(emit).sphere(V.core.r, ORB_SEG[0], ORB_SEG[1], weaponGlow, { intensity: GLOW_DIM });
    ctx.robot.extras.spin.push({ bone: emit, axis: 'z', speed: V.spin });
    const charge = ub.bone('empCharge', 'chest', [0, R.y, R.z]);
    ub.glow(charge).sphere(V.core.charge, ORB_SEG[0], ORB_SEG[1], weaponGlow);
    // shot socket at the ring centre (area pulse), flash via the fire map
    const fl = ub.bone('empFlash', 'chest', [0, R.y, R.z]);
    ub.glow(fl).point([0, 0, 0], V.core.charge, UNIT_KIT.flash.core);
    const fi = ub.meta.flashes.push({ bone: fl }) - 1;
    const socket = `${ctx.sockets.launch}1`;
    ub.socket(socket, 'chest', [0, R.y, R.z]);
    ub.onFire(socket, { flashes: [fi] });
    base.out.rig.weapon = { kind: 'pulse', muzzles: [socket], shots: V.shots, charge };
    return base.out;
  },
});

registerRobotPart('torso', 'howitzer', {
  label: 'Howitzer torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.howitzer;
    const base = buildBase(ub, kit, ctx, shapeFor('howitzer'));
    const S = kit.S;
    const cb = base.cb;
    const weaponGlow = unitStyle(kit).weaponGlow;
    // base plate over both shoulders, a strut lifting the gun on one side, an ammo drum on the other
    cb.box(V.base.w, V.base.h, V.base.d, S.frame, { y: V.base.y, z: V.base.z });
    const St = V.strut;
    cb.box(St.w, St.h, St.d, S.hullDark, { x: V.side * St.x, y: St.y + St.h / 2, z: St.z });
    cb.cylinder(V.drum.r, V.drum.r, V.drum.h, SEG_ROUND, S.hullDark, { x: V.drum.x, y: V.drum.y, z: V.drum.z }, true);
    cb.cylinder(V.drum.r * 0.8, V.drum.r * 0.8, V.drum.h + 0.4, SEG_ROUND, S.teamPaint, { x: V.drum.x, y: V.drum.y, z: V.drum.z }, true);
    const Cd = V.cradle;
    const cradle = ub.bone('howCradle', 'chest', Cd.at);
    hullLoft(ub.paint(cradle), kit, [
      { y: -Cd.h / 2, w: Cd.w * 0.8, d: Cd.d * 0.8 }, { y: 0, w: Cd.w, d: Cd.d }, { y: Cd.h / 2, w: Cd.w * 0.85, d: Cd.d * 0.85 },
    ], S.hull, {}, { points: SEG_SMALL });
    // barrel pitched up: sleeve (recoil jacket), tube, muzzle brake
    const B = V.barrel;
    const pitch = ub.bone('howPitch', cradle, [0, 0, 0], { rotation: [B.tilt, 0, 0] });
    const barrel = ub.bone('howBarrel', pitch, [0, 0, B.z]);
    const bb = ub.paint(barrel);
    bb.cylinder(B.sleeveR, B.sleeveR, B.sleeveLen, SEG_ROUND, S.hullDark, { z: B.sleeveLen / 2, rx: HALF_PI }, true);
    bb.cylinder(B.r, B.r, B.len, SEG_ROUND, S.frame, { z: B.len / 2, rx: HALF_PI }, true);
    bb.box(B.brakeW, B.brakeW, B.brakeLen, S.dark, { z: B.len - B.brakeLen / 2 });
    ub.glow(barrel).box(B.brakeW * 0.6, B.brakeW * 0.6, 0.15, weaponGlow, { z: B.len, intensity: GLOW_DIM });
    const charge = ub.bone('howCharge', pitch, [0, 0, B.z + B.sleeveLen * 0.5]);
    ub.glow(charge).sphere(V.charge.r, ORB_SEG[0], ORB_SEG[1], weaponGlow);
    const socket = addMuzzle(ub, ctx, barrel, 'howBarrel', B.len, B.recoil, 0, V.flash);
    base.out.rig.weapon = { kind: 'artillery', muzzles: [socket], shots: V.shots, charge };
    return base.out;
  },
});

// ---------------------------------------------------------------- effect torsos

registerRobotPart('torso', 'recon', {
  label: 'Recon torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.recon;
    const base = buildBase(ub, kit, ctx, shapeFor('recon'));
    const S = kit.S;
    const cb = base.cb;
    backBox(cb, kit, base, V.back);
    const M = V.mast;
    cb.box(M.w, M.h, M.w, S.frame, { x: M.x, y: M.y + M.h / 2, z: M.z, detail: 0 });
    // big spinning radar dish at the top of the mast (cone facing forward-up) with a beacon lens
    const dish = ub.bone('reconDish', 'chest', [M.x, M.y + M.h, M.z]);
    const Ds = V.dish;
    const tilt = ub.bone('reconDishTilt', dish, [0, 0, 0], { rotation: [Ds.tilt, 0, 0] });
    ub.paint(tilt).cylinder(Ds.rTop, Ds.rBottom, Ds.h, SEG_ROUND, S.hullDark, { y: Ds.h / 2 }, true);
    ub.glow(tilt).point([0, Ds.h, 0], Ds.lens, kit.glowColors.beacon, { intensity: GLOW_DIM });
    ctx.robot.extras.spin.push({ bone: dish, axis: 'y', speed: Ds.spin });
    // tall whip antenna that sways on the other shoulder
    const W = V.whip;
    const whip = ub.bone('reconWhip', 'chest', [W.x, W.y, W.z]);
    ub.paint(whip).cylinder(W.r, W.r * 1.6, W.h, SEG_SMALL, S.frame, { y: W.h / 2 }, true);
    ub.glow(whip).point([0, W.h, 0], W.r * 3, kit.glowColors.beacon, { intensity: GLOW_DIM });
    ctx.robot.extras.sway.push({ bone: whip, axis: 'z', amp: W.amp, hz: W.hz });
    // second sensor bar over the visor of the wide head
    const E = V.eye;
    const head = base.head;
    const eye = ub.bone('reconEye', head.head, [0, E.y, head.at.z + head.ff.z + LINE_OUT]);
    ub.glow(eye).box(Math.min(E.w, head.ff.w * VISOR_FIT), E.h, E.h, kit.glowColors.reactor, { intensity: GLOW_DIM });
    return base.out;
  },
});

registerRobotPart('torso', 'camo', {
  label: 'Camo torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.camo;
    const base = buildBase(ub, kit, ctx, shapeFor('camo'));
    const S = kit.S;
    const cb = base.cb;
    // smooth rounded hood / cloak over the back and shoulders (one loft, no seams)
    hullLoft(cb, kit, V.cape.stations.map(([y, w, d]) => ({ y, w, d, z: base.backAt(y) - d / 2 + V.cape.tuck })), S.hullDark, {}, { points: SEG_ROUND });
    // cloak emitters: ring + pulsing glow node
    V.nodes.forEach(([x, y, z], i) => {
      const node = ub.bone(`camoNode${i}`, 'chest', [x, y, z]);
      const rx = z < -2 ? 0 : HALF_PI;   // back nodes face back, shoulder nodes face up
      ub.paint(node).torus(V.node.ring, V.node.tube, CAMO_RING_SEG[0], CAMO_RING_SEG[1], Math.PI * 2, S.frame, { rx });
      ub.glow(node).sphere(V.node.r, CAMO_ORB_SEG[0], CAMO_ORB_SEG[1], kit.glowColors.reactor, { intensity: GLOW_DIM });
      ctx.robot.extras.pulse.push({ bone: node, depth: V.node.depth, hz: V.node.hz, phase: i * PHASE_STEP });
    });
    return base.out;
  },
});

registerRobotPart('torso', 'forceField', {
  label: 'Force field torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.forceField;
    const base = buildBase(ub, kit, ctx, shapeFor('forceField'));
    const S = kit.S;
    const cb = base.cb;
    backBox(cb, kit, base, V.base);
    const R = V.ring;
    const cz = base.backAt(V.base.y) - V.base.d - R.out;
    // two projector prongs leaning outward from the shoulders, glowing tips (readable from the front)
    const P = V.posts;
    for (const sign of [-1, 1]) {
      const px = sign * P.x;
      const pz = base.backAt(P.y) + 1.4;
      cb.box(P.w, P.h, P.w, S.frame, { x: px, y: P.y, z: pz, rz: -sign * P.tilt, detail: 0 });
      ub.glow('chest').sphere(P.tip, CAMO_ORB_SEG[0], CAMO_ORB_SEG[1], kit.glowColors.beacon, { x: px + sign * Math.sin(P.tilt) * P.h / 2, y: P.y + Math.cos(P.tilt) * P.h / 2 + P.tip * 0.5, z: pz, intensity: GLOW_DIM });
    }
    // huge vertical projector ring spinning behind the chest around the pulsing core
    const ring = ub.bone('fieldRing', 'chest', [0, R.y, cz]);
    ub.paint(ring).torus(R.r, R.tube, RING_SEG[0], RING_SEG[1], Math.PI * 2, S.frame, {});
    ub.glow(ring).torus(R.r * 0.8, R.tube * 0.5, RING_SEG[0], RING_SEG[1], kit.glowColors.beacon, { intensity: GLOW_DIM });
    ctx.robot.extras.spin.push({ bone: ring, axis: 'z', speed: R.spin });
    const core = ub.bone('fieldCore', 'chest', [0, R.y, cz]);
    ub.glow(core).sphere(V.core.r, ORB_SEG[0], ORB_SEG[1], kit.glowColors.reactor, { intensity: GLOW_DIM });
    ctx.robot.extras.pulse.push({ bone: core, depth: V.core.depth, hz: V.core.hz });
    // tie rod from the housing to the ring hub
    cb.cylinder(0.3, 0.3, V.base.d + R.out, SEG_SMALL, S.dark, { y: R.y, z: cz + (V.base.d + R.out) / 2, rx: HALF_PI }, true);
    return base.out;
  },
});

registerRobotPart('torso', 'jetPack', {
  label: 'Jet pack torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.jetPack;
    const base = buildBase(ub, kit, ctx, shapeFor('jetPack'));
    const S = kit.S;
    const cb = base.cb;
    const T = V.tank;
    const tz = base.backAt(T.y) - T.out + 0.3;
    cb.box(T.x * 2 + T.r, V.brace.h, V.brace.d, S.frame, { y: V.brace.y, z: tz + T.r * 0.9 });
    let n = 0;
    for (const sign of [-1, 1]) {
      const unit = ub.bone(`jetUnit${n}`, 'chest', [sign * T.x, T.y, tz]);
      const ub0 = ub.paint(unit);
      ub0.cylinder(T.r, T.r, T.h, SEG_ROUND, S.hullDark, { y: 0 }, true);
      ub0.cylinder(T.r * 0.7, T.r, 0.5, SEG_ROUND, S.teamPaint, { y: T.h / 2 + 0.25 }, true);
      ub0.cylinder(V.nozzle.rTop, V.nozzle.rBottom, V.nozzle.h, SEG_ROUND, S.dark, { y: -T.h / 2 - V.nozzle.h / 2 }, true);
      // flickering exhaust flame (glow), cone pointing down
      const flame = ub.bone(`jetFlame${n}`, unit, [0, -T.h / 2 - V.nozzle.h - V.flame.h / 2, 0]);
      ub.glow(flame).cylinder(V.flame.rTop, V.flame.rBottom, V.flame.h, SEG_SMALL, kit.glowColors.reactor, { intensity: GLOW_DIM }, true);
      ctx.robot.extras.pulse.push({ bone: flame, depth: V.flame.depth, hz: V.flame.hz, phase: n * PHASE_STEP });
      // big wing panel spreading outward (faces the camera, leans away from the tank)
      const Wg = V.wing;
      armor(ub0, kit, Wg.w, Wg.h, Wg.th, S.frame, { x: sign * (T.r + Wg.x), y: Wg.y, z: -0.3, rz: -sign * Wg.roll });
      n++;
    }
    return base.out;
  },
});

registerRobotPart('torso', 'selfRepair', {
  label: 'Self repair torso',
  build(ub, kit, ctx) {
    const V = TORSO_B6.selfRepair;
    const base = buildBase(ub, kit, ctx, shapeFor('selfRepair'));
    const S = kit.S;
    const cb = base.cb;
    const H = V.housing;
    const hz = base.backAt(H.y) - H.d / 2 + LINE_OUT;
    cb.box(H.w, H.h, H.d, S.frame, { y: H.y, z: hz });
    // glowing repair cross on the back of the housing
    const C = V.cross;
    const cross = ub.bone('repairCross', 'chest', [0, H.y, hz - H.d / 2 - LINE_OUT]);
    ub.glow(cross).box(C.len, C.th, C.th, kit.glowColors.reactor, { intensity: GLOW_DIM });
    ub.glow(cross).box(C.th, C.len, C.th, kit.glowColors.reactor, { intensity: GLOW_DIM });
    ctx.robot.extras.pulse.push({ bone: cross, depth: C.depth, hz: C.hz });
    // two long service arms rising over the shoulders: upper link, forearm folded forward, glowing tip (gentle sway)
    const M = V.manip;
    for (const sign of [-1, 1]) {
      const root = ub.bone(`repairArm${sign < 0 ? 'L' : 'R'}`, 'chest', [sign * M.x, M.y, M.z]);
      const rb = ub.paint(root);
      rb.cylinder(M.w * 0.8, M.w * 0.8, M.up, SEG_SMALL, S.frame, { y: M.up / 2 }, true);
      rb.cylinder(M.w * 1.1, M.w * 1.1, M.w * 1.4, SEG_SMALL, S.dark, { y: M.up, rz: HALF_PI }, true);
      const fore = ub.bone(`repairFore${sign < 0 ? 'L' : 'R'}`, root, [0, M.up, 0], { rotation: [M.tilt, 0, 0] });
      ub.paint(fore).cylinder(M.w * 0.6, M.w * 0.6, M.fore, SEG_SMALL, S.hullDark, { z: M.fore / 2, rx: HALF_PI }, true);
      ub.glow(fore).point([0, 0, M.fore], M.tipR, kit.glowColors.reactor, { intensity: GLOW_DIM });
      ctx.robot.extras.sway.push({ bone: root, axis: 'x', amp: M.amp, hz: M.hz, phase: sign * PHASE_STEP });
    }
    return base.out;
  },
});
