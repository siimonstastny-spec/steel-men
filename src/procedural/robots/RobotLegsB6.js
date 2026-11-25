// Steel Men – procedural robot legs, block B6 (13 parts): armor, frame, highSpeed, steady, hthUpgrade, jumpJet (body variants)
// and laser, powerGun, drunkMissile, blastPulse, powerPulse, powerShield, sonar (legs carrying a weapon / effect).
// Every part reuses the shared leg rig and body of RobotLegs.js (buildLegBase: bones legs → pelvis → thigh / shin / foot per
// side, socket_TorsoMount, soles, shinPoints, stride) with its own proportions (D = a LEG_SHAPES-like record) and adds
// extras on the pelvis / thigh / shin / foot bones. Weapon legs add `socket_Launch_G<n>` muzzles on the pelvis (visual only,
// the simulation reads the hidden GLB), flash + optional recoil through ub.onFire, rig.weapon = { kind, muzzles, shots }
// for a future legs attack clip. Construction time only; shapes follow kit.style.silhouette through the kit primitives.
import { registerRobotPart, block, prismZ, lightLine } from './RobotKit.js';
import * as Legs from './RobotLegs.js';
import { armor } from './RobotSculpt.js';
import { tube } from '../ProcShapes.js';
import { UNIT_KIT, unitStyle } from '../units/UnitKit.js';

const { LEG_SHAPES, LEG_SCULPT } = Legs;
const HALF_PI = Math.PI / 2;
const SEG_SMALL = 6;          // sides of small tubes
const SEG_POD = 8;            // sides of barrels, drums, towers
const SEG_RING = 10;          // sides of glow rings
const PLATE_SINK = 0.15;      // side plates sink into the surface by this
const LINE_OUT = 0.05;        // muzzle sockets stand this far out of the barrel
const GLOW_DIM = 0.6;         // intensity of small glow accents
const FRONT_SHARE = 0.46;     // pelvis front plane = z + this × depth (a little inside the hull)
const FLASH_CORE = 0.55;      // muzzle flash core radius
const JET_SOCKET = 'socket_Jet_';   // jumpJet nozzle sockets (+ L / R), visual effects only

// ---------------------------------------------------------------- shapes

const B = LEG_SHAPES.basic;
const shape = (over) => ({ ...B, ...over });
const GAIT = (g) => ({ bob: 0, ...g });

// medium legs of the weapon / effect sets: a little stockier than basic (boots 3.6, hips 2.7), gap between the boots ≥ 1.2
const MEDIUM = shape({
  hip: [2.7, -1.2, 2.3], knee: [0.45, -7.0, -0.4], ankle: [-0.05, -10.0, -2.1], sole: 2.8, mount: [0, 0.2, 0.3],
  pelvis: { w: 5.2, h: 3.2, d: 5.2, y: -1.6, z: 2.2 },
  hipJoint: { r: 1.1, len: 2.0 },
  thigh: { w: 2.1, d: 2.5 },
  kneeJoint: { r: 1.1, len: 2.4 },
  boot: { w: 3.6, d: 3.8, lineAt: 0.4, lineLen: 4.2 },
  kneeShield: { w: 3.2, h: 3.6, th: 0.65, up: 0.4, tilt: 0.12 },
  foot: { w: 5.0, h: 2.4, len: 7.8, y: -1.6, z: 2.0, toes: 2, toeW: 1.1, toeH: 0.9, toeLen: 1.7, heelW: 1.5, heelH: 1.0, heelLen: 1.3 },
  keel: { w: 2.8, h: 2.9, th: 0.5, y: -0.4, tilt: 0.28 },
  marking: { len: 2.4, h: 0.35, down: 1.4 },
  gait: GAIT({ walkFull: 13, turnRadius: 4, swing: 0.3, knee: 0.7, sway: 0.035, twist: 0.06, toe: 0.18 }),
});

const WEAPON_FLASH = { core: FLASH_CORE };

export const LEG_B6_SHAPES = {
  // heavy plated legs: wide stance, thigh / shin / back plates in team shade, slow
  armor: shape({
    hip: [4.2, -1.3, 2.0], knee: [0.6, -6.0, 0.6], ankle: [0, -8.8, -1.8], sole: 2.8, mount: [0, 0.3, 0.3],
    pelvis: { w: 7.6, h: 3.6, d: 6.2, y: -1.8, z: 2.0 },
    hipJoint: { r: 1.6, len: 2.6 },
    thigh: { w: 3.2, d: 3.4 },
    kneeJoint: { r: 1.6, len: 3.0 },
    boot: { w: 5.6, d: 5.6, lineAt: 0.4, lineLen: 4.4 },
    kneeShield: { w: 4.8, h: 4.6, th: 1.0, up: 0.5, tilt: 0.1 },
    foot: { w: 7.0, h: 2.8, len: 8.6, y: -1.4, z: 1.8, toes: 3, toeW: 1.4, toeH: 1.1, toeLen: 1.8, heelW: 2.2, heelH: 1.2, heelLen: 1.5 },
    keel: { w: 4.0, h: 3.2, th: 0.7, y: -0.4, tilt: 0.25 },
    marking: { len: 4, h: 0.5, down: 1.5 },
    sculpt: { boot: [[-0.05, 1, 1, 0.2], [0.18, 0.9, 0.92], [0.6, 1.02, 1, 0.1], [0.88, 1.1, 1.1, 0.2], [1.08, 1.14, 1.28, 0.6]] },
    gait: GAIT({ walkFull: 10, turnRadius: 5, swing: 0.26, knee: 0.55, sway: 0.05, twist: 0.04, toe: 0.1 }),
    plates: { thighAt: 0.42, thighW: 3.6, thighH: 4.6, thighTh: 0.7, shinAt: 0.72, shinW: 3.6, shinH: 3.2, shinTh: 0.6, backW: 5.6, backH: 2.8, backTh: 0.6 },
  }),
  // bare skeleton: thin limbs, exposed pipes and braces, small boots, cheap and fast
  frame: shape({
    hip: [2.0, -1.0, 2.2], knee: [0.35, -7.2, -0.3], ankle: [-0.05, -10.2, -2.1], sole: 2.8, mount: [0, 0.2, 0.3],
    pelvis: { w: 3.0, h: 2.0, d: 3.6, y: -1.0, z: 2.2 },
    hipJoint: { r: 0.65, len: 1.3 },
    thigh: { w: 1.0, d: 1.2 },
    kneeJoint: { r: 0.65, len: 1.5 },
    boot: { w: 1.5, d: 1.8, lineAt: 0.4, lineLen: 3.0 },
    kneeShield: { w: 1.2, h: 1.6, th: 0.3, up: 0.3, tilt: 0.12 },
    foot: { w: 2.8, h: 1.6, len: 5.6, y: -2.0, z: 2.0, toes: 2, toeW: 0.8, toeH: 0.7, toeLen: 1.5, heelW: 1.0, heelH: 0.7, heelLen: 1.1 },
    skirtSide: null,
    keel: { w: 1.4, h: 1.6, th: 0.3, y: -0.4, tilt: 0.28 },
    marking: { len: 1.4, h: 0.3, down: 1.2 },
    sculpt: { boot: [[-0.05, 1, 1, 0.1], [0.3, 0.85, 0.85], [0.75, 0.9, 0.9], [1.0, 1.05, 1.1, 0.1], [1.1, 1.1, 1.2, 0.3]] },
    gait: GAIT({ walkFull: 15, turnRadius: 3.5, swing: 0.34, knee: 0.8, sway: 0.03, twist: 0.07, toe: 0.2 }),
    // pipes: two rods behind each thigh, a brace behind each shin (x offsets, behind = share of the limb depth + gap, radius)
    pipes: { rodX: [-0.45, 0.45], rodTop: -0.8, rodEnd: 0.8, behind: 0.35, r: 0.18, braceTop: -1.2, braceEnd: 0.85, braceR: 0.2 },
  }),
  // slim long legs, high cadence; sleek tapered boots, swept heel fin with a glow vent
  highSpeed: shape({
    // digitigrade: the thigh leans forward (knee z +1), the shin runs back to a long narrow foot
    hip: [1.9, -1.0, 2.0], knee: [0.3, -8.2, 1.0], ankle: [0, -11.0, -3.4], sole: 2.4, mount: [0, 0.2, 0.3],
    pelvis: { w: 3.2, h: 2.2, d: 3.8, y: -1.1, z: 2.0 },
    hipJoint: { r: 0.7, len: 1.3 },
    thigh: { w: 1.3, d: 1.7 },
    kneeJoint: { r: 0.75, len: 1.5 },
    boot: { w: 1.9, d: 2.3, lineAt: 0.4, lineLen: 5.5 },
    kneeShield: { w: 1.8, h: 2.4, th: 0.35, up: 0.3, tilt: 0.18 },
    foot: { w: 2.6, h: 1.6, len: 9.0, y: -1.6, z: 2.8, toes: 2, toeW: 0.6, toeH: 0.5, toeLen: 2.8, heelW: 0.8, heelH: 0.5, heelLen: 1.8 },
    skirtSide: { d: 0.7, h: 1.0, th: 0.28, drop: 0.3, flare: 0.25 },
    keel: { w: 1.8, h: 2.0, th: 0.35, y: -0.4, tilt: 0.32 },
    marking: { len: 1.4, h: 0.28, down: 1.2 },
    sculpt: { boot: [[-0.04, 1.15, 1.1, 0.15], [0.25, 1.0, 1.0, 0.1], [0.65, 0.6, 0.7, 0.05], [0.92, 0.75, 0.85, 0.15], [1.05, 0.85, 1.05, 0.4]] },
    gait: GAIT({ walkFull: 18, turnRadius: 3, swing: 0.42, knee: 0.95, sway: 0.02, twist: 0.08, toe: 0.3 }),
    fin: { at: 0.5, len: 3.6, h: 3.8, th: 0.22, sweep: 0.45, glowW: 0.1, glowH: 0.75 },
  }),
  // short wide squat legs, huge flat feet, hydraulic dampers on the shins, gyroscope ring on the pelvis (stability)
  steady: shape({
    hip: [4.6, -1.2, 2.0], knee: [0.5, -5.8, 0.7], ankle: [0, -8.6, -1.6], sole: 2.6, mount: [0, 0.3, 0.3],
    pelvis: { w: 8.0, h: 3.6, d: 6.4, y: -1.8, z: 2.0 },
    hipJoint: { r: 1.7, len: 2.8 },
    thigh: { w: 3.4, d: 3.6 },
    kneeJoint: { r: 1.7, len: 3.2 },
    boot: { w: 5.2, d: 5.4, lineAt: 0.4, lineLen: 4.4 },
    kneeShield: { w: 4.4, h: 4.0, th: 0.9, up: 0.4, tilt: 0.1 },
    foot: { w: 8.0, h: 2.4, len: 10.0, y: -1.4, z: 1.8, toes: 3, toeW: 1.8, toeH: 0.9, toeLen: 1.6, heelW: 2.8, heelH: 1.0, heelLen: 1.4 },
    keel: { w: 4.2, h: 3.4, th: 0.7, y: -0.4, tilt: 0.25 },
    marking: { len: 3, h: 0.4, down: 1.5 },
    sculpt: { boot: [[-0.05, 1, 1, 0.2], [0.2, 0.88, 0.9], [0.6, 1, 1, 0.1], [0.85, 1.14, 1.12, 0.2], [1.08, 1.2, 1.3, 0.55]] },
    gait: GAIT({ walkFull: 9, turnRadius: 5.5, swing: 0.22, knee: 0.45, sway: 0.04, twist: 0.03, toe: 0.08 }),
    // damper: cylinder + rod on the outer front of each shin (x share of the boot half width, t0 / t1 = shares of the shin, radii)
    damper: { xShare: 0.55, t0: 0.3, t1: 0.75, split: 0.55, r: 0.7, rodR: 0.35, front: 0.3 },
    gyro: { at: [0, -1.8, -3.0], r: 2.2, tube: 0.4, hubR: 0.7, hubLen: 0.7, spin: 2.4, radial: 4, tubular: 10 },
  }),
  // melee legs: muscular, knee spikes, long toe blades and heel spikes
  hthUpgrade: shape({
    hip: [2.7, -1.2, 2.3], knee: [0.45, -7.0, -0.3], ankle: [0, -10.0, -2.2], sole: 2.8, mount: [0, 0.2, 0.3],
    pelvis: { w: 4.8, h: 3.0, d: 5.0, y: -1.5, z: 2.2 },
    hipJoint: { r: 1.1, len: 1.9 },
    thigh: { w: 2.2, d: 2.6 },
    kneeJoint: { r: 1.1, len: 2.4 },
    boot: { w: 3.6, d: 3.8, lineAt: 0.4, lineLen: 4.2 },
    kneeShield: { w: 3.2, h: 3.6, th: 0.7, up: 0.4, tilt: 0.1 },
    foot: { w: 4.8, h: 2.4, len: 8.0, y: -1.6, z: 2.2, toes: 3, toeW: 1.0, toeH: 0.9, toeLen: 2.6, heelW: 1.4, heelH: 1.0, heelLen: 1.8 },
    keel: { w: 2.8, h: 2.9, th: 0.5, y: -0.4, tilt: 0.28 },
    marking: { len: 2.4, h: 0.35, down: 1.4 },
    gait: GAIT({ walkFull: 13, turnRadius: 4, swing: 0.33, knee: 0.8, sway: 0.035, twist: 0.07, toe: 0.22 }),
    spike: { sides: 4, w: 2.0, h: 2.0, len: 4.2, sink: 0.2 },
  }),
  // springy legs with a thruster pod and nozzle behind each shin; the nozzle flame pulses softly, socket_Jet_L / _R
  jumpJet: shape({
    hip: [2.3, -1.2, 2.3], knee: [0.4, -7.0, -0.5], ankle: [-0.05, -10.0, -2.1], sole: 2.6, mount: [0, 0.2, 0.3],
    pelvis: { w: 4.4, h: 3.0, d: 5.0, y: -1.5, z: 2.2 },
    hipJoint: { r: 1.0, len: 1.8 },
    thigh: { w: 1.8, d: 2.2 },
    kneeJoint: { r: 1.0, len: 2.2 },
    boot: { w: 2.4, d: 2.8, lineAt: 0.4, lineLen: 4.0 },
    kneeShield: { w: 2.4, h: 3.0, th: 0.5, up: 0.4, tilt: 0.12 },
    foot: { w: 4.0, h: 2.2, len: 7.2, y: -1.5, z: 2.0, toes: 2, toeW: 1.0, toeH: 0.8, toeLen: 1.7, heelW: 1.3, heelH: 0.9, heelLen: 1.2 },
    keel: { w: 2.4, h: 2.6, th: 0.45, y: -0.4, tilt: 0.3 },
    marking: { len: 2, h: 0.32, down: 1.3 },
    gait: GAIT({ walkFull: 15, turnRadius: 3.5, swing: 0.34, knee: 0.9, sway: 0.03, twist: 0.07, toe: 0.3 }),
    jet: {
      at: 0.45, podR: 1.5, podLen: 6.0, nozzleR: 2.0, nozzleLen: 1.4, flameNear: 1.4, flameFar: 0.25, flameLen: 3.5, flameSeg: 6,
      flameGlow: 0.55, coreR: 0.8, pulseDepth: 0.25, pulseHz: 6,
    },
  }),
  // laser: slim lens barrel with emitter ring on the pelvis front, light line along the housing, pulsing lens
  laser: shape({
    weapon: { kind: 'beam', shots: 1, y: -1.0, w: 3.6, h: 2.2, d: 3.0, sink: 0.5, r: 0.65, len: 4.6, ringR: 1.1, ringLen: 0.8, lensR: 0.5, lineLen: 2.4 },
  }),
  // power gun: thick short shell cannon with a muzzle brake and ammo boxes on the sides, recoils
  powerGun: shapeOf(MEDIUM, {
    weapon: { kind: 'gun', shots: 1, y: -1.0, w: 4.6, h: 2.6, d: 3.2, sink: 0.5, r: 1.1, len: 4.2, brakeR: 1.5, brakeLen: 1.0, boxW: 1.3, boxH: 2.0, boxD: 2.6, recoil: 0.8 },
  }),
  // drunk missile: 2 × 2 tube pod on the pelvis front (team coloured housing), four muzzles
  drunkMissile: shapeOf(MEDIUM, {
    weapon: { kind: 'launch', shots: 4, y: -0.9, w: 5.6, h: 3.0, d: 3.0, sink: 0.5, tubeR: 0.8, tubeLen: 2.0, tubeX: 1.35, tubeY: 0.75 },
  }),
  // blast pulse: two hip drums with flared glowing mouths (area pulse to the sides)
  blastPulse: shapeOf(MEDIUM, {
    weapon: { kind: 'pulse', shots: 1, y: -0.3, out: 0.35, drumR: 1.2, drumLen: 2.0, flareR: 1.9, flareLen: 1.2, z: 0, mouthR: 1.6, mouthGlow: 0.7 },
  }),
  // power pulse: dorsal coil tower with glow rings (stun pulse) and a node at the top
  powerPulse: shapeOf(MEDIUM, {
    weapon: { kind: 'pulse', shots: 1, y: 0.2, back: 1.2, baseR: 2.0, baseH: 2.0, towerR: 1.0, towerH: 5.5, ringR: 2.2, ringT: 0.25, rings: 4, nodeR: 0.9, pulseDepth: 0.3, pulseHz: 1.4 },
  }),
  // power shield: kite shield plates on both hips (team colour, glow edge), emitter node at the pelvis front (socket_Attach_Shield)
  powerShield: shapeOf(MEDIUM, {
    shield: { x: 1.4, z: 0.1, w: 4.5, h: 7.0, th: 0.6, strutR: 0.25, edgeT: 0.16, edgeShare: 0.9, emitterY: -0.9, emitterR: 1.0, emitterH: 0.8, nodeR: 0.5, socket: 'socket_Attach_Shield' },
  }),
  // sonar: dome with expanding ping rings on the pelvis back, flared horns on the outer thighs
  sonar: shape({
    sonar: { y: -0.2, back: 1.2, domeR: 2.4, domeSeg: [8, 5], pingH: 2.6, pingR: 1.8, pingT: 0.18, pingRings: 3, pingDepth: 0.45, pingHz: 0.9, hornAt: 0.3, hornLen: 3.0, hornMouth: 1.6, hornThroat: 0.4, hornZ: 0.2, mouthGlow: 0.5 },
  }),
};

// medium shape + extras (spread keeps the nested weapon record)
function shapeOf(base, extra) { return { ...base, ...extra }; }

// ---------------------------------------------------------------- helpers (construction time only)

const mirror = ([x, y, z], sign) => [x * sign, y, z];
const bootProfile = (D) => D.sculpt?.boot ?? LEG_SCULPT.boot;
const bootTilt = (D) => Math.atan2(-D.ankle[2], -D.ankle[1]);
const limbLength = (end) => Math.hypot(end[1], end[2]);

/** Linear value of profile column `col` at share t (rows sorted by column 0; missing column → 0) */
function profileAt(profile, t, col) {
  const v = (row) => row[col] ?? 0;
  if (t <= profile[0][0]) return v(profile[0]);
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (t <= b[0]) return v(a) + ((v(b) - v(a)) * (t - a[0])) / (b[0] - a[0]);
  }
  return v(profile[profile.length - 1]);
}

/** Point `dist` in front of (− = behind) a limb running from the bone origin to `end`, at share t; rx tilts a +Z panel with it */
function limbPoint(end, t, dist) {
  const rx = Math.atan2(-end[2], -end[1]);
  return { x: end[0] * t, y: end[1] * t - Math.sin(rx) * dist, z: end[2] * t + Math.cos(rx) * dist, rx };
}

/** Boot (shin bone) at share t along the shin, side `sign`: axis point (x, y, z) and half width / half depth / z offset */
function bootAt(D, sign, t) {
  const P = bootProfile(D);
  return {
    x: sign * D.ankle[0] * t, y: D.ankle[1] * t, z: D.ankle[2] * t,
    hw: (D.boot.w * profileAt(P, t, 1)) / 2, hd: (D.boot.d * profileAt(P, t, 2)) / 2, oz: profileAt(P, t, 3),
  };
}

/** Pelvis front plane (bone 'pelvis' space z) */
const pelvisFront = (D) => D.pelvis.z + D.pelvis.d * FRONT_SHARE;

/** Common legs: shared body + rig of RobotLegs, then the extras of the caller */
function buildBase(ub, kit, ctx, D) {
  if (!Legs.buildLegBase) throw new Error('[RobotLegsB6] RobotLegs.js must export buildLegBase (see docs/notes/b6-legs.md)');
  return Legs.buildLegBase(ub, kit, ctx, D);
}

/**
 * Muzzle on `bone` at `at`: flash bone (hidden until fired – ProcUnit flash driver) with a glow core and the socket
 * socket_Launch_G<index> (MUZZLE.socketPatterns). extra = more onFire channels (recoils…).
 */
function addMuzzle(ub, ctx, bone, at, index, color, extra = {}) {
  const fl = ub.bone(`legFlash${index}`, bone, at);
  ub.glow(fl).point([0, 0, WEAPON_FLASH.core], WEAPON_FLASH.core, color);
  const fi = ub.meta.flashes.push({ bone: fl }) - 1;
  const socket = `${ctx.sockets.launch}G${index}`;
  ub.socket(socket, bone, at);
  ub.onFire(socket, { flashes: [fi], ...extra });
  return socket;
}

/** Marks the weapon in the legs rig (a future legs attack clip reads it): { kind, muzzles, shots } */
function setWeapon(out, W, muzzles) {
  out.rig.weapon = { kind: W.kind, muzzles, shots: W.shots };
}

// ---------------------------------------------------------------- armor

registerRobotPart('legs', 'armor', {
  label: 'Armor legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.armor;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const A = D.plates;
    const P = D.pelvis;
    const tilt = bootTilt(D);
    for (const c of out.chains) {
      // plate over the front of the thigh, plate on the outer side of the shin
      const knee = mirror(D.knee, c.side);
      const dist = (D.thigh.d * profileAt(LEG_SCULPT.thigh, A.thighAt, 2)) / 2 + A.thighTh / 2 - PLATE_SINK;
      const tp = limbPoint(knee, A.thighAt, dist);
      armor(ub.paint(c.thigh), kit, A.thighW, A.thighH, A.thighTh, S.teamShade, { x: tp.x, y: tp.y, z: tp.z, rx: tp.rx });
      const b = bootAt(D, c.side, A.shinAt);
      armor(ub.paint(c.shin), kit, A.shinW, A.shinH, A.shinTh, S.teamShade, {
        x: b.x + c.side * (b.hw + A.shinTh / 2 - PLATE_SINK), y: b.y, z: b.z + b.oz, ry: c.side * HALF_PI, rx: tilt,
      });
    }
    // (rear pelvis plate dropped in B4: hidden under the torso, ~44 tri)
    return out;
  },
});

// ---------------------------------------------------------------- frame

registerRobotPart('legs', 'frame', {
  label: 'Frame legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.frame;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const Pp = D.pipes;
    for (const c of out.chains) {
      const knee = mirror(D.knee, c.side);
      const tb = ub.paint(c.thigh);
      const zb = -(D.thigh.d / 2 + Pp.behind);
      for (const dx of Pp.rodX) {
        tb.add(tube([[dx, Pp.rodTop, zb], [knee[0] + dx, knee[1] + Pp.rodEnd, knee[2] + zb]], Pp.r, SEG_SMALL), S.pipe, { detail: 0 });
      }
      // brace behind the shin, from the knee to near the ankle
      const ankle = mirror(D.ankle, c.side);
      const zs = -(D.boot.d / 2 + Pp.behind);
      ub.paint(c.shin).add(
        tube([[0, Pp.braceTop, zs], [ankle[0], ankle[1] * Pp.braceEnd, ankle[2] * Pp.braceEnd + zs]], Pp.braceR, SEG_SMALL), S.pipe, { detail: 0 },
      );
    }
    return out;
  },
});

// ---------------------------------------------------------------- high speed

registerRobotPart('legs', 'highSpeed', {
  label: 'High speed legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.highSpeed;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const F = D.fin;
    const tilt = bootTilt(D);
    const glowColor = kit.glowColors.laser;
    for (const c of out.chains) {
      // swept heel fin behind the calf (a panel in the YZ plane, lower end swept back) with a glow vent along its edge
      const b = bootAt(D, c.side, F.at);
      const p = limbPoint(D.ankle, F.at, -(b.hd - b.oz) - F.len / 2 + PLATE_SINK);
      const rx = tilt + F.sweep;
      armor(ub.paint(c.shin), kit, F.len, F.h, F.th, S.teamShade, { x: b.x, y: p.y, z: p.z, ry: HALF_PI, rx });
      ub.glow(c.shin).box(F.glowW, F.h * F.glowH, F.glowW, glowColor, {
        x: b.x, y: p.y - Math.sin(rx) * (F.len / 2), z: p.z - Math.cos(rx) * (F.len / 2), rx, intensity: GLOW_DIM,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------- steady

registerRobotPart('legs', 'steady', {
  label: 'Steady legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.steady;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const Dm = D.damper;
    for (const c of out.chains) {
      // damper: cylinder + rod on the outer front of the shin (the rod slides in as the knee bends – static here)
      const b = bootAt(D, c.side, (Dm.t0 + Dm.t1) / 2);
      const x = c.side * b.hw * Dm.xShare;
      const dist = b.hd + b.oz + Dm.front;
      const p0 = limbPoint(D.ankle, Dm.t0, dist);
      const p1 = limbPoint(D.ankle, Dm.t1, dist);
      const pm = limbPoint(D.ankle, Dm.t0 + (Dm.t1 - Dm.t0) * Dm.split, dist);
      const sb = ub.paint(c.shin);
      sb.add(tube([[x, p0.y, p0.z], [x, pm.y, pm.z]], Dm.r, SEG_SMALL), S.frame, { detail: 0 });
      sb.add(tube([[x, pm.y, pm.z], [x, p1.y, p1.z]], Dm.rodR, SEG_SMALL), S.pipe, { detail: 0 });
    }
    // gyroscope ring on the back of the pelvis (a spinning torus around a hub), team coloured rim
    const G = D.gyro;
    const gy = ub.bone('steadyGyro', 'pelvis', G.at);
    const gb = ub.paint(gy);
    gb.torus(G.r, G.tube, G.radial, G.tubular, Math.PI * 2, S.teamPaint, {});
    gb.cylinder(G.hubR, G.hubR, G.hubLen, SEG_SMALL, S.frame, { rx: HALF_PI }, true);
    ctx.robot.extras.spin.push({ bone: gy, axis: 'z', speed: G.spin });
    return out;
  },
});

// ---------------------------------------------------------------- hthUpgrade

registerRobotPart('legs', 'hthUpgrade', {
  label: 'HTH upgrade legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.hthUpgrade;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const Sp = D.spike;
    // knee shield front (same placement as the base knee shield): spike along its normal
    const row = bootProfile(D)[0];
    const kt = -D.kneeShield.up / limbLength(D.ankle);
    const kp = limbPoint(D.ankle, kt, (D.boot.d * (row[2] ?? 1)) / 2 + (row[3] ?? 0));
    const n = kp.rx + D.kneeShield.tilt;
    const out0 = D.kneeShield.th / 2 + Sp.len / 2 - Sp.sink;
    for (const c of out.chains) {
      prismZ(ub.paint(c.shin), Sp.sides, Sp.w, Sp.h, Sp.len, S.hullDark, {
        x: kp.x * c.side, y: kp.y - Math.sin(n) * out0, z: kp.z + Math.cos(n) * out0, rx: HALF_PI + n,
      }, true);
    }
    return out;
  },
});

// ---------------------------------------------------------------- jumpJet

registerRobotPart('legs', 'jumpJet', {
  label: 'Jump jet legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.jumpJet;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const J = D.jet;
    const tilt = bootTilt(D);
    const sLen = limbLength(D.ankle);
    const ex = unitStyle(kit).exhaust;
    for (const c of out.chains) {
      const sfx = c.side > 0 ? 'R' : 'L';
      const b = bootAt(D, c.side, J.at);
      const dist = -(b.hd - b.oz) - J.podR + PLATE_SINK;   // pod axis behind the calf
      const sb = ub.paint(c.shin);
      // pod (cylinder), flared nozzle below it
      const pod = limbPoint(D.ankle, J.at, dist);
      sb.cylinder(J.podR, J.podR, J.podLen, SEG_POD, S.hullDark, { x: b.x, y: pod.y, z: pod.z, rx: tilt }, true);
      const tn = J.at + (J.podLen / 2 + J.nozzleLen / 2) / sLen;
      const nz = limbPoint(D.ankle, tn, dist);
      sb.cylinder(J.podR, J.nozzleR, J.nozzleLen, SEG_POD, S.frame, { x: b.x, y: nz.y, z: nz.z, rx: tilt }, true);
      // flame bone at the nozzle mouth, pointing down along the shin axis (pulses softly), jet socket
      const tf = J.at + (J.podLen / 2 + J.nozzleLen) / sLen;
      const fp = limbPoint(D.ankle, tf, dist);
      const flame = ub.bone(`jumpJet${sfx}`, c.shin, [b.x, fp.y, fp.z], { rotation: [tilt, 0, 0] });
      ub.glow(flame).flame(J.flameNear, J.flameFar, J.flameLen, J.flameSeg, ex.outer, { rx: -HALF_PI, intensity: J.flameGlow });
      ub.glow(flame).point([0, 0, 0], J.coreR, ex.core);
      ctx.robot.extras.pulse.push({ bone: flame, depth: J.pulseDepth, hz: J.pulseHz });
      ub.socket(`${JET_SOCKET}${sfx}`, flame);
    }
    return out;
  },
});

// ---------------------------------------------------------------- laser

registerRobotPart('legs', 'laser', {
  label: 'Laser legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.laser;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const W = D.weapon;
    const glow = unitStyle(kit).weaponGlow;
    const z0 = pelvisFront(D);
    const pb = ub.paint('pelvis');
    block(pb, kit, W.w, W.h, W.d, S.teamShade, { y: W.y, z: z0 + W.d / 2 - W.sink });
    lightLine(pb, kit, W.lineLen, 'z', { y: W.y + W.h / 2 + LINE_OUT / 2, z: z0 + W.d / 2 - W.sink });
    const barrel = ub.bone('legLaser', 'pelvis', [0, W.y, z0 + W.d - W.sink]);
    const bb = ub.paint(barrel);
    bb.cylinder(W.r, W.r, W.len, SEG_POD, S.frame, { z: W.len / 2, rx: HALF_PI }, true);
    bb.cylinder(W.ringR, W.ringR * 0.8, W.ringLen, SEG_POD, S.hullDark, { z: W.len - W.ringLen / 2, rx: HALF_PI }, true);
    // pulsing lens at the barrel tip (ProcUnit lens driver) + muzzle
    const lens = ub.bone('legLaserLens', barrel, [0, 0, W.len]);
    ub.glow(lens).point([0, 0, 0], W.lensR, glow);
    ub.meta.lenses.push({ bone: lens });
    const socket = addMuzzle(ub, ctx, barrel, [0, 0, W.len + LINE_OUT], 1, glow);
    setWeapon(out, W, [socket]);
    return out;
  },
});

// ---------------------------------------------------------------- powerGun

registerRobotPart('legs', 'powerGun', {
  label: 'Power gun legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.powerGun;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const W = D.weapon;
    const z0 = pelvisFront(D);
    const pb = ub.paint('pelvis');
    block(pb, kit, W.w, W.h, W.d, S.teamShade, { y: W.y, z: z0 + W.d / 2 - W.sink });
    // ammo boxes beside the housing
    for (const sign of [-1, 1]) {
      block(pb, kit, W.boxW, W.boxH, W.boxD, S.hullDark, { x: sign * (W.w / 2 + W.boxW / 2 - PLATE_SINK), y: W.y, z: z0 + W.boxD / 2 });
    }
    const barrel = ub.bone('legGun', 'pelvis', [0, W.y, z0 + W.d - W.sink]);
    const bb = ub.paint(barrel);
    bb.cylinder(W.r, W.r, W.len, SEG_POD, S.frame, { z: W.len / 2, rx: HALF_PI }, true);
    bb.cylinder(W.brakeR, W.brakeR, W.brakeLen, SEG_POD, S.hullDark, { z: W.len - W.brakeLen / 2, rx: HALF_PI }, true);
    const ri = ub.meta.recoils.push({ bone: barrel, dist: W.recoil }) - 1;
    const socket = addMuzzle(ub, ctx, barrel, [0, 0, W.len + LINE_OUT], 1, UNIT_KIT.flash.core, { recoils: [ri] });
    setWeapon(out, W, [socket]);
    return out;
  },
});

// ---------------------------------------------------------------- drunkMissile

registerRobotPart('legs', 'drunkMissile', {
  label: 'Drunk missile legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.drunkMissile;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const W = D.weapon;
    const z0 = pelvisFront(D);
    const pb = ub.paint('pelvis');
    block(pb, kit, W.w, W.h, W.d, S.teamPaint, { y: W.y, z: z0 + W.d / 2 - W.sink });
    const zEnd = z0 + W.d - W.sink + W.tubeLen;
    const muzzles = [];
    let i = 0;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const x = sx * W.tubeX;
        const y = W.y + sy * W.tubeY;
        pb.cylinder(W.tubeR, W.tubeR, W.tubeLen + W.sink, SEG_POD, S.frame, { x, y, z: zEnd - (W.tubeLen + W.sink) / 2, rx: HALF_PI }, false);
        i += 1;
        muzzles.push(addMuzzle(ub, ctx, 'pelvis', [x, y, zEnd + LINE_OUT], i, UNIT_KIT.flash.core));
      }
    }
    setWeapon(out, W, muzzles);
    return out;
  },
});

// ---------------------------------------------------------------- blastPulse

registerRobotPart('legs', 'blastPulse', {
  label: 'Blast pulse legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.blastPulse;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const W = D.weapon;
    const glow = unitStyle(kit).weaponGlow;
    const P = D.pelvis;
    const pb = ub.paint('pelvis');
    const muzzles = [];
    let i = 0;
    for (const sign of [-1, 1]) {
      // drum along X outside the pelvis side, flared mouth outwards (cone: wide end = top = outward), glowing mouth disc
      const x0 = sign * (P.w / 2 + W.out);
      const y = P.y + P.h / 2 + W.y;
      const z = P.z + W.z;
      pb.cylinder(W.drumR, W.drumR, W.drumLen, SEG_POD, S.teamShade, { x: x0 + (sign * W.drumLen) / 2, y, z, rz: -sign * HALF_PI }, true);
      const xf = x0 + sign * (W.drumLen + W.flareLen / 2);
      pb.cylinder(W.flareR, W.drumR, W.flareLen, SEG_POD, S.frame, { x: xf, y, z, rz: -sign * HALF_PI }, true);
      const xm = x0 + sign * (W.drumLen + W.flareLen);
      ub.glow('pelvis').disc(W.mouthR, SEG_POD, glow, { x: xm, y, z, rx: 0, ry: HALF_PI, intensity: W.mouthGlow });
      i += 1;
      muzzles.push(addMuzzle(ub, ctx, 'pelvis', [xm + sign * LINE_OUT, y, z], i, glow));
    }
    setWeapon(out, W, muzzles);
    return out;
  },
});

// ---------------------------------------------------------------- powerPulse

registerRobotPart('legs', 'powerPulse', {
  label: 'Power pulse legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.powerPulse;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const W = D.weapon;
    const glow = unitStyle(kit).weaponGlow;
    const P = D.pelvis;
    // coil tower on the back of the pelvis: base drum, slim tower, glow rings (pulse), node + muzzle on top
    const tz = P.z - P.d / 2 - W.back;
    const tower = ub.bone('legTower', 'pelvis', [0, P.y + P.h / 2 + W.y, tz]);
    const tb = ub.paint(tower);
    tb.cylinder(W.baseR, W.baseR, W.baseH, SEG_POD, S.teamShade, { y: W.baseH / 2 }, true);
    tb.cylinder(W.towerR, W.towerR, W.towerH, SEG_POD, S.frame, { y: W.baseH + W.towerH / 2 }, true);
    const rings = ub.bone('legTowerRings', tower, [0, W.baseH, 0]);
    for (let k = 0; k < W.rings; k++) {
      const share = (k + 1) / (W.rings + 1);
      const r = W.ringR * (1 - share * 0.4);
      ub.glow(rings).cylinder(r, r, W.ringT, SEG_RING, glow, { y: W.towerH * share, intensity: GLOW_DIM }, true);
    }
    ctx.robot.extras.pulse.push({ bone: rings, depth: W.pulseDepth, hz: W.pulseHz });
    const top = W.baseH + W.towerH;
    ub.glow(tower).point([0, top + W.nodeR, 0], W.nodeR, glow);
    const socket = addMuzzle(ub, ctx, tower, [0, top + W.nodeR * 2, 0], 1, glow);
    setWeapon(out, W, [socket]);
    return out;
  },
});

// ---------------------------------------------------------------- powerShield

registerRobotPart('legs', 'powerShield', {
  label: 'Power shield legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.powerShield;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const H = D.shield;
    const glow = unitStyle(kit).weaponGlow;
    const P = D.pelvis;
    const pb = ub.paint('pelvis');
    const gp = ub.glow('pelvis');
    for (const sign of [-1, 1]) {
      // big kite plate beside each hip, held by a strut; a glow edge along its outer rim
      const x = sign * (D.hip[0] + D.thigh.w / 2 + H.x);
      const y = P.y + P.h / 2 - H.h / 2 + H.h * 0.05;
      const z = P.z + H.z;
      armor(pb, kit, H.w, H.h, H.th, S.teamPaint, { x, y, z, ry: sign * HALF_PI });
      pb.add(tube([[sign * (P.w / 2 - PLATE_SINK), y, z], [x - sign * H.th / 2, y, z]], H.strutR, SEG_SMALL), S.frame, { detail: 0 });
      gp.box(H.edgeT, H.h * H.edgeShare, H.edgeT, glow, { x: x + sign * (H.th / 2 + H.edgeT / 2), y, z: z + H.w / 2 - H.edgeT, intensity: GLOW_DIM });
    }
    // emitter on the pelvis front: ring + node, socket for the shield effect
    const z0 = pelvisFront(D);
    const em = ub.bone('legShieldEmitter', 'pelvis', [0, H.emitterY, z0]);
    ub.paint(em).cylinder(H.emitterR, H.emitterR, H.emitterH, SEG_POD, S.hullDark, { z: H.emitterH / 2, rx: HALF_PI }, true);
    ub.glow(em).point([0, 0, H.emitterH + H.nodeR * 0.5], H.nodeR, glow);
    ub.meta.lenses.push({ bone: em });
    ub.socket(H.socket, em, [0, 0, H.emitterH]);
    return out;
  },
});

// ---------------------------------------------------------------- sonar

registerRobotPart('legs', 'sonar', {
  label: 'Sonar legs',
  build(ub, kit, ctx) {
    const D = LEG_B6_SHAPES.sonar;
    const out = buildBase(ub, kit, ctx, D);
    const S = kit.S;
    const N = D.sonar;
    const glow = unitStyle(kit).weaponGlow;
    const P = D.pelvis;
    const X = ctx.robot.extras;
    // dome on the back of the pelvis, ping rings above it expand and fade in step (pulse)
    const at = [0, P.y + P.h / 2 + N.y, P.z - P.d / 2 - N.back];
    const dome = ub.bone('sonarDome', 'pelvis', at);
    ub.paint(dome).sphere(N.domeR, N.domeSeg[0], N.domeSeg[1], S.hullDark, {});
    const ping = ub.bone('sonarPing', dome, [0, N.pingH, 0]);
    for (let k = 0; k < N.pingRings; k++) {
      const r = N.pingR * (1 + k * 0.45);
      ub.glow(ping).cylinder(r, r, N.pingT, SEG_RING, glow, { y: k * N.pingT * 3, intensity: GLOW_DIM }, true);
    }
    X.pulse.push({ bone: ping, depth: N.pingDepth, hz: N.pingHz });
    // flared horn on the outer side of each thigh (wide mouth = cylinder top = outward), glowing throat
    for (const c of out.chains) {
      const knee = mirror(D.knee, c.side);
      const x = knee[0] * N.hornAt + c.side * (D.thigh.w / 2 + N.hornLen / 2 - PLATE_SINK);
      ub.paint(c.thigh).cylinder(N.hornMouth, N.hornThroat, N.hornLen, SEG_POD, S.frame, { x, y: knee[1] * N.hornAt, z: N.hornZ, rz: -c.side * HALF_PI }, true);
      ub.glow(c.thigh).point([x + c.side * (N.hornLen / 2), knee[1] * N.hornAt, N.hornZ], N.mouthGlow * N.hornMouth, glow, { intensity: GLOW_DIM });
    }
    return out;
  },
});

export const LEG_B6_IDS = Object.keys(LEG_B6_SHAPES);
