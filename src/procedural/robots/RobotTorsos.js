// Steel Men – procedural robot torsos (experiment): basic and flak (T2, anti-air turret, weak against ground). Rig = the
// GLB RobotPartsBasic torso: 'chest' (on the 'torso' wrapper at socket_TorsoMount) → 'head'; arm sockets
// socket_ArmLeft (−x) / socket_ArmRight (+x) at the GLB positions. Robot faces +Z. Construction time only.
// Torso contract: build(ub, kit, ctx) → { arms: { leftArm, rightArm } ([x, y, z] chest space), aim, smoke,
// rig: { chest, head, visor, turret? } } (see RobotKit.ProcRobot).
import { registerRobotPart, gltfNode, block, blockFront, blockFace, joint, plate, lightLine, markingStrip, shapeOf } from './RobotKit.js';
import { UNIT_KIT, unitStyle } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;       // light lines / plates stand this far off the surface
const EMBLEM_OUT = 0.04;     // emblem decal off the front face
const GLOW_DIM = 0.6;
const SEG_SMALL = 6;          // radial segments of small cylinders (neck, barrels, masts, faceted turret ring)
const SEG_ROUND = 12;         // radial segments of larger round parts (fan housing, turret ring)
const ORB_SEG = [8, 6];       // plasma orb (width, height segments)
const ORB_RING_SEG = [3, 12]; // ring around the orb (radial, tubular)
const BACK_BAR = 0.5;         // orb ring tube / fan grille bars = lamella width × this

/**
 * Torso dimensions (chest space, raw GLB units). Basic follows RobotPartsBasic/BasicTorsoX_Skel.glb: body −1…8 high,
 * ±5.3 wide, arm sockets (±5.35, 6.7, −1.6), head node at the top.
 */
export const TORSO_SHAPES = {
  basic: {
    arms: { x: 5.35, y: 6.7, z: -1.6 },
    waist: { w: 3.6, h: 2.4, d: 3.6, y: 0.6 },
    belly: { w: 5.6, h: 2.6, d: 5.0, y: 2.4, z: 0.2 },
    chest: { w: 9.0, h: 4.0, d: 7.6, y: 5.4, z: -0.4 },
    collar: { w: 7.0, h: 1.4, d: 5.6, y: 7.9, z: -0.8 },
    shoulder: { r: 1.4, len: 1.8, x: 4.4 },                       // housings under the arm sockets
    plates: { w: 2.6, h: 3.0, th: 0.4, x: 2.55, y: 5.6, yaw: 0.28 },   // team plates on the chest front
    emblem: { size: 1.8, y: 5.2 },
    sideLine: { len: 3.0, y: 5.2 },
    marking: { len: 3.0, h: 0.3, y: 3.3 },                        // belly marking (style markings)
    back: { y: 5.2, count: 5, w: 0.3, h: 3.2, d: 2.0, gap: 1.0, fanR: 1.7, fanD: 0.6, fanHole: 0.85, orbR: 1.1, orbRing: 1.2 },   // radiator / fan / orb
    head: {
      at: [0, 8.2, 0.4], neck: { r: 0.9, h: 0.8 }, w: 3.0, h: 2.4, d: 3.8, y: 1.4, z: 0.2,
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
    radar: { at: [0, 2.0, -1.4], mastH: 0.6, mastR: 0.15, w: 2.2, h: 0.9, th: 0.18, spin: 2.6 },
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
  hb.cylinder(H.neck.r, H.neck.r, H.neck.h, SEG_SMALL, S.frame, { y: H.neck.h / 2 - H.neck.h, detail: 1 });
  block(hb, kit, H.w, H.h, H.d, S.hullDark, { y: H.y, z: H.z });
  if (shapeOf(kit).block === 'prism' || shapeOf(kit).block === 'tapered') {
    plate(hb, kit, H.crest.d, H.crest.h, H.crest.w, S.teamPaint, { y: H.crest.y, z: H.crest.z, ry: HALF_PI });
  }
  const visor = ub.bone('visor', head, [0, H.visor.y, H.z + blockFace(kit, H.h, H.d, H.visor.y - H.y).z + LINE_OUT]);
  ub.glow(visor).box(H.visor.w, H.visor.h, H.visor.h, kit.glowColors.beacon);
  return { head, visor };
}

/** Back equipment by style.fan: radiator lamellae with neon edges, a (guarded / open) fan, or a plasma orb */
function buildBack(ub, kit, B, C) {
  const S = kit.S;
  const cb = ub.paint('chest');
  const backZ = C.z - blockFace(kit, C.h, C.d, B.y - C.y).z;
  const fan = kit.style.fan;
  if (fan === 'radiator') {
    const span = (B.count - 1) * B.gap;
    for (let i = 0; i < B.count; i++) {
      const x = -span / 2 + i * B.gap;
      cb.box(B.w, B.h, B.d, S.frame, { x, y: B.y, z: backZ - B.d / 2 + LINE_OUT });
      lightLine(cb, kit, B.d, 'z', { x, y: B.y + B.h / 2, z: backZ - B.d / 2 + LINE_OUT });
    }
    return;
  }
  if (fan === 'none') {
    ub.glow('chest').sphere(B.orbR, ORB_SEG[0], ORB_SEG[1], kit.glowColors.reactor, { y: B.y, z: backZ - B.orbR * GLOW_DIM, intensity: GLOW_DIM });
    cb.torus(B.orbR * B.orbRing, B.w * BACK_BAR, ORB_RING_SEG[0], ORB_RING_SEG[1], Math.PI * 2, S.frame, { y: B.y, z: backZ - B.orbR * GLOW_DIM });
    return;
  }
  // 'guarded' / 'open' fan housing facing back (blades static at robot size; grille bars only when guarded)
  cb.cylinder(B.fanR, B.fanR, B.fanD, SEG_ROUND, S.frame, { y: B.y, z: backZ - B.fanD / 2, rx: HALF_PI });
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
  const W = D.waist;
  block(cb, kit, W.w, W.h, W.d, S.frame, { y: W.y });
  block(cb, kit, D.belly.w, D.belly.h, D.belly.d, S.hullDark, { y: D.belly.y, z: D.belly.z });
  const C = D.chest;
  block(cb, kit, C.w, C.h, C.d, S.hull, { y: C.y, z: C.z });
  block(cb, kit, D.collar.w, D.collar.h, D.collar.d, S.hullDark, { y: D.collar.y, z: D.collar.z });
  const A = D.arms;
  for (const sign of [-1, 1]) {
    joint(cb, kit, D.shoulder.r, D.shoulder.len, S.frame, { x: sign * D.shoulder.x, y: A.y, z: A.z });
    lightLine(cb, kit, D.sideLine.len, 'z', { x: sign * (blockFace(kit, C.h, C.w, D.sideLine.y - C.y).z + LINE_OUT), y: D.sideLine.y, z: C.z });
  }
  // team plates on the chest front, angled to the sides; the emblem sits between them on the neutral plate
  const P = D.plates;
  const pf = blockFace(kit, C.h, C.d, P.y - C.y);
  for (const sign of [-1, 1]) {
    plate(cb, kit, P.w, P.h, P.th, S.teamPaint, { x: sign * P.x, y: P.y, z: C.z + pf.z + P.th / 2 + LINE_OUT, rx: -pf.tilt, ry: sign * P.yaw });
  }
  const ef = blockFace(kit, C.h, C.d, D.emblem.y - C.y);
  ub.emblem('chest', [{
    position: [0, D.emblem.y, C.z + ef.z + EMBLEM_OUT], normal: [0, Math.sin(ef.tilt), Math.cos(ef.tilt)], size: D.emblem.size,
  }]);
  markingStrip(cb, kit, D.marking.len, D.marking.h, { y: D.marking.y, z: D.belly.z + blockFront(kit, D.belly.d) + LINE_OUT });
  buildBack(ub, kit, D.back, C);
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
    yb.cylinder(T.ring.r, T.ring.r, T.ring.h, shapeOf(kit).joint === 'prism' ? SEG_SMALL : SEG_ROUND, S.frame, { y: T.ring.h / 2 });
    block(yb, kit, T.body.w, T.body.h, T.body.d, S.hullDark, { y: T.body.y });
    const pitch = ub.bone('flakCradle', yaw, T.cradle);
    const pb = ub.paint(pitch);
    for (const sign of [-1, 1]) {
      block(pb, kit, T.pod.w, T.pod.h, T.pod.d, S.hull, { x: sign * T.pod.x, z: T.pod.z });
      plate(pb, kit, T.plate.w, T.plate.h, T.plate.th, S.teamPaint, { x: sign * (T.pod.x + T.pod.w / 2 + T.plate.th / 2), z: T.pod.z, ry: HALF_PI });
    }
    const B = T.barrel;
    const muzzles = [];
    T.barrels.forEach(([x, y], i) => {
      const name = `flakBarrel${i + 1}`;
      const barrel = ub.bone(name, pitch, [x, y, T.pod.z + T.pod.d / 2]);
      const bb = ub.paint(barrel);
      bb.cylinder(B.r, B.r, B.len, SEG_SMALL, S.frame, { z: B.len / 2, rx: HALF_PI });
      bb.box(B.brakeW, B.brakeW, B.brakeLen, S.dark, { z: B.len - B.brakeLen / 2, detail: 0 });
      // muzzle flash (hidden until fired – ProcUnit flash driver) and the shot socket
      const fl = ub.bone(`${name}Flash`, barrel, [0, 0, B.len]);
      const F = T.flash;
      ub.glow(fl).flame(F.near, F.far, F.len, SEG_SMALL, flash.color, { ry: Math.PI });
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
    rb.cylinder(R.mastR, R.mastR, R.mastH, SEG_SMALL, S.frame, { y: R.mastH / 2, detail: 0 });
    plate(rb, kit, R.w, R.h, R.th, S.hullDark, { y: R.mastH + R.h / 2 });
    ub.glow(radar).point([0, R.mastH + R.h / 2, R.th], R.th * 2, unitStyle(kit).weaponGlow, { intensity: GLOW_DIM });
    ctx.robot.extras.spin.push({ bone: radar, axis: 'y', speed: R.spin });
    out.rig.turret = { yaw, pitch, limits: T.limits, muzzles, shots: T.shots };
    return out;
  },
});
