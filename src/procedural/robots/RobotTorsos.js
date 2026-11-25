// Steel Men – procedural robot torsos (experiment): basic and flak (T2, anti-air turret, weak against ground). Rig = the
// GLB RobotPartsBasic torso: 'chest' (on the 'torso' wrapper at socket_TorsoMount) → 'head'; arm sockets
// socket_ArmLeft (−x) / socket_ArmRight (+x) at the GLB positions. Robot faces +Z. Construction time only.
// Torso contract: build(ub, kit, ctx) → { arms: { leftArm, rightArm } ([x, y, z] chest space), aim, smoke,
// rig: { chest, head, visor, turret? } } (see RobotKit.ProcRobot).
// Sculpted (RobotSculpt): waist and body are lofted hulls (belly → broad chest → collar), team plates sit on the keel
// chamfers of the chest, the emblem on a big raised neutral plate on the flat front, lofted head with a visor slit.
import { registerRobotPart, gltfNode, lightLine, markingStrip, shapeOf } from './RobotKit.js';
import { hullLoft, lengthLoft, armor, hinge, frontFlat, frontAt, sideFace } from './RobotSculpt.js';
import { UNIT_KIT, unitStyle } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;       // light lines / plates stand this far off the surface
const EMBLEM_OUT = 0.04;     // emblem decal off the front face
const GLOW_DIM = 0.6;
const SEG_SMALL = 6;          // radial segments of small cylinders (neck, barrels, masts, faceted turret ring)
const SEG_ROUND = 8;          // radial segments of larger round parts (fan housing, turret ring)
const BARREL_SEG = 5;         // flak barrels / brakes (open tubes)
const MAST_T = 0.24;          // square radar mast (side)
const VISOR_FIT = 0.95;       // visor width ≤ this share of the head's flat front
const LINE_GLUE = 0.02;       // side light lines: half of the line inside the surface
const LINE_FIT = 0.85;        // side light line ≤ this share of the flat side face
const ORB_SEG = [6, 4];       // plasma orb (width, height segments)
const ORB_RING_SEG = [3, 8];  // ring around the orb (radial, tubular)
const BACK_BAR = 0.5;         // orb ring tube / fan grille bars = lamella width × this

/**
 * Torso dimensions (chest space, raw GLB units). Basic follows RobotPartsBasic/BasicTorsoX_Skel.glb: body −1…8 high,
 * ±5.3 wide, arm sockets (±5.35, 6.7, −1.6), head node at the top.
 */
export const TORSO_SHAPES = {
  basic: {
    arms: { x: 5.35, y: 6.7, z: -1.6 },
    // waist hull (frame) and body hull (belly → chest → collar): stations [y, w, d, z]
    waist: [[-0.6, 3.2, 3.2, 0], [0.6, 3.8, 3.7, 0.05], [1.8, 3.4, 3.4, 0.1]],
    body: [[1.4, 5.0, 4.6, 0.2], [3.2, 7.0, 6.2, 0.05], [5.3, 9.0, 7.6, -0.4], [7.3, 8.8, 7.2, -0.6], [8.6, 6.4, 5.2, -0.9]],
    bodyKeel: 0.32,                                               // front chamfer share (flat front for the emblem, chamfers for the team plates)
    shoulder: { r: 1.4, len: 1.8, x: 4.4 },                       // housings under the arm sockets
    abdomen: { w: 3.4, h: 2.0, th: 0.35, y: 2.5 },                // armour plate on the belly front (hullDark)
    plates: { w: 2.7, h: 3.3, th: 0.35, x: 3.25, y: 6.1 },        // team plates on the chest keel chamfers
    emblem: { size: 2.5, y: 5.9, plate: 1.14, th: 0.22 },          // decal size; neutral raised plate = size × plate
    sideLine: { len: 3.0, y: 5.2 },
    marking: { len: 3.0, h: 0.3, down: 0.28 },                    // abdomen plate marking (hazard styles), down = share of the plate below its centre
    back: { y: 5.2, count: 5, w: 0.3, h: 3.2, d: 2.0, gap: 1.0, fanR: 1.7, fanD: 0.6, fanHole: 0.85, orbR: 1.1, orbRing: 1.2 },   // radiator / fan / orb
    head: {
      at: [0, 8.2, 0.4], neck: { r: 0.9, h: 0.8 },
      stations: [[0.2, 2.3, 2.9, 0.1], [1.4, 3.0, 3.8, 0.3], [2.8, 2.1, 2.7, 0]], keel: 0.22,
      visor: { w: 2.2, h: 0.32, y: 1.6 }, crest: { w: 0.35, h: 1.1, d: 2.4, y: 2.9, z: -0.2 },
    },
    aim: [0, 4.5, 0], smoke: [0, 7.5, -3],
  },
};
// flak = basic body without the back radiator, a turret on the shoulders instead
TORSO_SHAPES.flak = {
  ...TORSO_SHAPES.basic,
  back: { ...TORSO_SHAPES.basic.back, count: 3, h: 2.2, y: 4.2 },
  turret: {
    at: [0, 8.6, -3.4], ring: { r: 1.9, h: 0.7 }, body: { w: 3.4, h: 1.8, d: 3.2, y: 1.0 },
    cradle: [0, 2.4, 0.4], pod: { w: 1.3, h: 1.6, d: 3.2, x: 2.2, z: 0.4 },
    barrels: [[-2.45, 0.35], [-1.95, -0.35], [1.95, 0.35], [2.45, -0.35]],   // x, y in the cradle (two per pod)
    barrel: { r: 0.17, len: 3.0, z: 2.0, brakeW: 0.45, brakeLen: 0.5, recoil: 0.5 },
    flash: { near: 0.35, far: 0.05, len: 1.6, core: 0.4 },
    radar: { at: [0, 2.0, -1.4], mastH: 0.6, w: 2.2, h: 0.9, th: 0.18, spin: 2.6 },
    bodyLoft: [[0, 1, 1], [0.6, 1, 0.95], [1, 0.8, 0.75]],          // turret body stations [y share, w, d]
    podLoft: [[-0.5, 0.85, 0.85], [0, 1, 1], [0.5, 0.8, 0.7]],      // gun pod stations [z share of d, w, h]
    limits: [-0.1, 1.1],      // rad: a little against ground targets, mostly up (anti-air)
    shots: 4,                 // VISUAL default of the preview (= stats.json Flak burst); in game pass weapon.burst to playAttack(slot, time, shots)
    plate: { w: 2.6, h: 1.2, th: 0.25 },   // team plates on the pod sides
  },
};

/** Head on the chest: neck, head block, crest, visor glow bar on its own bone (on / off with the crew) */
function buildHead(ub, kit, ctx, H) {
  const S = kit.S;
  const head = gltfNode(ctx, 'head');
  ub.bone(head, 'chest', H.at);
  const hb = ub.paint(head);
  hb.cylinder(H.neck.r, H.neck.r, H.neck.h, SEG_SMALL, S.frame, { y: H.neck.h / 2 - H.neck.h, detail: 1 }, true);
  hullLoft(hb, kit, H.stations.map(([y, w, d, z]) => ({ y, w, d, z, keel: H.keel })), S.teamPaint);   // team helmet
  if (shapeOf(kit).block === 'prism' || shapeOf(kit).block === 'tapered') {
    armor(hb, kit, H.crest.d, H.crest.h, H.crest.w, S.hull, { y: H.crest.y, z: H.crest.z, ry: HALF_PI });
  }
  // visor slit on the flat front of the head
  const at = stationAt(H.stations, H.visor.y);
  const ff = frontFlat(kit, at.w, at.d, { keel: H.keel });
  const visor = ub.bone('visor', head, [0, H.visor.y, at.z + ff.z + LINE_OUT]);
  ub.glow(visor).box(Math.min(H.visor.w, ff.w * VISOR_FIT), H.visor.h, H.visor.h, kit.glowColors.beacon);
  return { head, visor };
}

/** Hull section at height y between stations [y, w, d, z]: { w, d, z, tilt } (tilt = how far the front leans back, rad) */
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

/** Back equipment by style.fan: radiator lamellae with neon edges, a (guarded / open) fan, or a plasma orb */
function buildBack(ub, kit, B, body) {
  const S = kit.S;
  const cb = ub.paint('chest');
  const at = stationAt(body, B.y);
  const backZ = at.z - at.d / 2;
  const fan = kit.style.fan;
  if (fan === 'radiator') {
    // radiator fins + one light bar across their top edges
    const span = (B.count - 1) * B.gap;
    for (let i = 0; i < B.count; i++) {
      const x = -span / 2 + i * B.gap;
      cb.box(B.w, B.h, B.d, S.frame, { x, y: B.y, z: backZ - B.d / 2 + LINE_OUT });
    }
    lightLine(cb, kit, span + B.w, 'x', { y: B.y + B.h / 2, z: backZ - B.d / 2 + LINE_OUT });
    return;
  }
  if (fan === 'none') {
    ub.glow('chest').sphere(B.orbR, ORB_SEG[0], ORB_SEG[1], kit.glowColors.reactor, { y: B.y, z: backZ - B.orbR * GLOW_DIM, intensity: GLOW_DIM });
    cb.torus(B.orbR * B.orbRing, B.w * BACK_BAR, ORB_RING_SEG[0], ORB_RING_SEG[1], Math.PI * 2, S.frame, { y: B.y, z: backZ - B.orbR * GLOW_DIM });
    return;
  }
  // 'guarded' / 'open' fan housing facing back (blades static at robot size; grille bars only when guarded)
  cb.cylinder(B.fanR, B.fanR, B.fanD, SEG_ROUND, S.frame, { y: B.y, z: backZ - B.fanD / 2, rx: HALF_PI }, true);
  cb.cylinder(B.fanR * B.fanHole, B.fanR * B.fanHole, B.fanD, SEG_ROUND, S.dark, { y: B.y, z: backZ - B.fanD + LINE_OUT, rx: HALF_PI, detail: 0 });
  if (fan === 'guarded') {
    for (const ry of [0, HALF_PI]) cb.box(B.fanR * 2, B.w * BACK_BAR, B.w * BACK_BAR, S.frame, { y: B.y, z: backZ - B.fanD - LINE_OUT, rz: ry, detail: 0 });
  }
}

/** Common torso body (waist, belly, chest, collar, shoulder housings, team plates, emblem, back, head) */
function buildTorsoBase(ub, kit, ctx, D) {
  const S = kit.S;
  ub.bone(gltfNode(ctx, 'chest'), ctx.bone);
  const cb = ub.paint('chest');
  const keel = D.bodyKeel;
  hullLoft(cb, kit, D.waist.map(([y, w, d, z]) => ({ y, w, d, z })), S.frame, {}, { points: SEG_SMALL });   // hidden frame: 6 points (B4 trim)
  hullLoft(cb, kit, D.body.map(([y, w, d, z]) => ({ y, w, d, z, keel })), S.hull);
  const A = D.arms;
  const side = stationAt(D.body, D.sideLine.y);
  const face = sideFace(kit, side.w, side.d, { keel });   // light lines stay on the flat side face (glued, never past it)
  for (const sign of [-1, 1]) {
    hinge(cb, kit, D.shoulder.r, D.shoulder.len, S.frame, { x: sign * D.shoulder.x, y: A.y, z: A.z });
    lightLine(cb, kit, Math.min(D.sideLine.len, face.len * LINE_FIT), 'z', { x: sign * (side.w / 2 + LINE_GLUE), y: D.sideLine.y, z: side.z + face.v });
  }
  // armour plate on the belly front (darker team lacquer), leaning with the hull
  const Ab = D.abdomen;
  const ab = stationAt(D.body, Ab.y);
  const abf = frontFlat(kit, ab.w, ab.d, { keel });
  armor(cb, kit, Math.min(Ab.w, abf.w), Ab.h, Ab.th, S.teamShade, { y: Ab.y, z: ab.z + abf.z + Ab.th / 2, rx: -ab.tilt });
  // team plates on the keel chamfers of the chest (turned onto the surface)
  const P = D.plates;
  const pc = stationAt(D.body, P.y);
  for (const sign of [-1, 1]) {
    const f = frontAt(kit, pc.w, pc.d, sign * P.x, { keel });
    const out = P.th / 2 + LINE_OUT;
    armor(cb, kit, P.w, P.h, P.th, S.teamPaint, {
      x: sign * P.x + Math.sin(f.yaw) * out, y: P.y, z: pc.z + f.z + Math.cos(f.yaw) * out, rx: -pc.tilt, ry: f.yaw,
    });
  }
  // emblem on a big raised neutral plate on the flat front (readable from the RTS camera)
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
  if (kit.style.markings !== 'light') {   // hazard styles: marking across the lower abdomen plate
    const M = D.marking;
    markingStrip(cb, kit, Math.min(M.len, abf.w), M.h, { y: Ab.y - Ab.h * M.down, z: ab.z + abf.z + Ab.th + LINE_OUT, rx: -ab.tilt });
  }
  buildBack(ub, kit, D.back, D.body);
  const { head, visor } = buildHead(ub, kit, ctx, D.head);
  return {
    arms: { leftArm: [-A.x, A.y, A.z], rightArm: [A.x, A.y, A.z] },
    aim: D.aim, smoke: D.smoke,
    rig: { chest: 'chest', head, visor },
  };
}

// ---------------------------------------------------------------- basic

registerRobotPart('torso', 'basic', {
  label: 'Basic torso',
  build(ub, kit, ctx) {
    return buildTorsoBase(ub, kit, ctx, TORSO_SHAPES.basic);
  },
});

// ---------------------------------------------------------------- flak (T2)

registerRobotPart('torso', 'flak', {
  label: 'Flak torso',
  build(ub, kit, ctx) {
    const D = TORSO_SHAPES.flak;
    const out = buildTorsoBase(ub, kit, ctx, D);
    const S = kit.S;
    const T = D.turret;
    const flash = UNIT_KIT.flash;
    // turret: ring on the shoulders (yaw bone), body, cradle (pitch bone) with two gun pods
    const yaw = ub.bone('flakTurret', 'chest', T.at);
    const yb = ub.paint(yaw);
    yb.cylinder(T.ring.r, T.ring.r, T.ring.h, shapeOf(kit).joint === 'prism' ? SEG_SMALL : SEG_ROUND, S.frame, { y: T.ring.h / 2 }, true);
    const Tb = T.body;
    const by0 = Tb.y - Tb.h / 2;
    hullLoft(yb, kit, T.bodyLoft.map(([ys, ws, ds]) => ({ y: by0 + ys * Tb.h, w: Tb.w * ws, d: Tb.d * ds })), S.hullDark, {}, { points: SEG_SMALL });
    const pitch = ub.bone('flakCradle', yaw, T.cradle);
    const pb = ub.paint(pitch);
    const Pd = T.pod;
    for (const sign of [-1, 1]) {
      lengthLoft(pb, kit, T.podLoft.map(([zs, ws, hs]) => ({ z: Pd.z + zs * Pd.d, w: Pd.w * ws, h: Pd.h * hs, x: sign * Pd.x })), S.hull, {}, { points: SEG_SMALL });
      armor(pb, kit, T.plate.w, T.plate.h, T.plate.th, S.teamPaint, { x: sign * (Pd.x + Pd.w / 2 + T.plate.th / 2), z: Pd.z, ry: sign * HALF_PI });
    }
    const B = T.barrel;
    const muzzles = [];
    T.barrels.forEach(([x, y], i) => {
      const name = `flakBarrel${i + 1}`;
      const barrel = ub.bone(name, pitch, [x, y, Pd.z + (Pd.d * T.podLoft[T.podLoft.length - 1][0])]);
      const bb = ub.paint(barrel);
      bb.cylinder(B.r, B.r, B.len, BARREL_SEG, S.frame, { z: B.len / 2, rx: HALF_PI }, true);
      // muzzle flash (hidden until fired – ProcUnit flash driver) and the shot socket
      const fl = ub.bone(`${name}Flash`, barrel, [0, 0, B.len]);
      const F = T.flash;
      ub.glow(fl).point([0, 0, F.core], F.core, flash.core);
      const fi = ub.meta.flashes.push({ bone: fl }) - 1;
      const ri = ub.meta.recoils.push({ bone: barrel, dist: B.recoil }) - 1;
      const socket = `${ctx.sockets.launch}T${i + 1}`;
      ub.socket(socket, barrel, [0, 0, B.len + LINE_OUT]);
      ub.onFire(socket, { flashes: [fi], recoils: [ri] });
      muzzles.push(socket);
    });
    // rotating radar plate on the turret
    const R = T.radar;
    const radar = ub.bone('flakRadar', yaw, R.at);
    const rb = ub.paint(radar);
    // plate sits straight on the turret roof (no mast: B4 triangle trim, −12 tri)
    rb.box(R.w, R.h, R.th, S.hullDark, { y: R.h / 2 });
    ub.glow(radar).point([0, R.h / 2, R.th], R.th * 2, unitStyle(kit).weaponGlow, { intensity: GLOW_DIM });
    ctx.robot.extras.spin.push({ bone: radar, axis: 'y', speed: R.spin });
    out.rig.turret = { yaw, pitch, limits: T.limits, muzzles, shots: T.shots };
    return out;
  },
});
