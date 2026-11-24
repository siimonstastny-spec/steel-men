// Steel Men – procedural drill truck (support vehicle): slow mining vehicle that parks at an ore deposit and harvests it.
// It carries no cargo (ore goes straight to the team account), only a hopper; the silhouette must read "mining machine".
// One rig per style.silhouette (shape table `rig`, never faction names):
//   • rounded – 6-wheel mine truck, drill arm with a rotating auger that swings down in front, ore hopper + conveyor, hazard stripes
//   • angular – heavy tracked rig, massive percussion drill on a boom (jerky piston hits), exposed rams, two smoke stacks
//   • round   – hovering (visual only), plasma core in a dome; levitating rings sink to the ground, violet beam into the soil
//   • faceted – faceted tracked chassis, mining laser on a jointed arm, thin yellow beam to the ground, glowing radiator fins
// setWork(kind, amount): 'harvest' + 0..1 (smooth) deploys the tool; 0 = folded for driving. Visual only, no allocations in
// update(), no Math.random / real time. Standard ProcUnit API (setMotion, setStatus, setTeamColor, enableBatching, dispose…).
//   • sockets: work (tool tip / beam impact on the ground), aim, smoke, exhaust_1 / exhaust_2 (stacks, angular rig)
//   • bones: hull, arm, drill | head, beam, lens | ring_1..3, core, beam | rad (per rig), status (+ chassis bones)
// Model units (before VEHICLE.modelScale × stats.modelScale / procScale): ≈ 7.4 long (+ tool), 3.8–4.2 wide, 3.0–3.3 high.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hull, tracks, wheels, hover, statusLamp, roofMark, emblemPlate, unitBox, prism, UNIT_MODULES } from './UnitModules.js';
import { smootherstep } from '../ProcKit.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Shapes by style.silhouette (model units; shares where noted). `rig` picks the tool builder, `chassis.kind` the undercarriage. */
export const DRILL_TRUCK_SHAPES = {
  rounded: {
    rig: 'auger', L: 7.4, hullW: 3.2, H: 1.2, hullL: 0.9,
    chassis: { kind: 'wheels', gauge: 3.45, r: 0.64, ww: 0.6, axles: [2.3, 0, -2.3], steer: 1, bellyL: 6.0, lift: 1.3, fenderW: 1.3, fenderOver: 1.1 },
    cab: { x: -1.0, z: 0.3, w: 1.4, h: 1.05, d: 1.5, window: [0.8, 0.45, 0.2] },   // window: width share, height share, y share
    hopper: { x: 0, z: -2.0, w: 2.4, topW: 2.7, h: 1.05, d: 2.1 },
    conveyor: { x: 0.65, z0: 1.7, z1: -1.2, y0: 0.15, y1: 1.4, w: 0.7, rail: 0.1 },
    tool: { pivotY: 0.3, pivotZ: 2.1, armL: 2.2, armW: 0.5, drillL: 1.6, drillR: 0.5, stow: -0.4, flights: 4, spin: 9 },
    grille: { count: 3, w: 1.0, h: 0.06, d: 0.04, gap: 0.16 },
  },
  angular: {
    rig: 'percussion', L: 7.6, hullW: 4.0, H: 1.5, hullL: 0.92,
    chassis: { kind: 'tracks', th: 0.13, gauge: 0.86, tw: 0.24, lift: 0.95 },
    cab: { x: -0.65, z: 0.3, w: 1.2, h: 0.95, d: 1.4 },
    bin: { x: 0.7, z: -0.9, w: 1.25, topW: 1.45, h: 0.9, d: 3.0 },
    tool: { pivotY: 0.2, pivotZ: 2.5, armL: 1.8, armW: 0.8, rodL: 2.0, rodR: 0.2, bitL: 0.5, stow: -0.35, stroke: 0.55, rate: 1.3, rattle: 0.025, rattleRate: 38 },
    stacks: { x: 1.3, z: -3.15, r: 0.26, h: 1.9, seg: 6, ember: 0.3 },
  },
  round: {
    rig: 'plasma', L: 7.0, hullW: 4.2, H: 1.9, hullL: 0.95,
    chassis: { kind: 'hover', gap: 0.6, skirtL: 0.95, skirtW: 1.0, skirtH: 0.32, pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]] },
    pod: { x: 0.5, r: [0.5, 0.45, 1.5], y: 0.5, z: 0.1 },   // collector pods: x share of W, ellipsoid radii, y share of H, z
    dome: { r: 0.85, y: -0.1, z: 0.9, flat: 0.75, core: 0.5, seg: [10, 6], coreSeg: [10, 6] },
    tool: { ringR: 1.3, ringTube: 0.09, ringSeg: [3, 16], stowY: 0.16, stowScale: 0.55, workScale: 1.0, scaleStep: 0.12, beamIn: [0.1, 0.14], beamOut: [0.3, 0.5], beamOutGlow: 0.35, spotR: 0.75, over: 0.12, beamFrom: 0.8, flicker: 0.12 },
  },
  faceted: {
    rig: 'laser', L: 7.0, hullW: 3.8, H: 1.3, hullL: 0.92,
    chassis: { kind: 'tracks', th: 0.16, gauge: 0.88, tw: 0.26, lift: 0.95 },
    mount: { w: 0.9, h: 0.5, d: 1.0, z: 1.3 },
    tool: { armL: 1.7, armT: 0.3, headL: 1.0, headR: 0.42, stowArm: -1.15, stowHead: 1.15, workArm: 0.55, workHead: 0.5, beamT: 0.07, beamHalo: 0.2, beamFrom: 0.8, flicker: 0.1, lens: 0.28 },
    radiator: { count: 6, step: 0.24, z: -0.5, w: 1.0, h: 0.95, t: 0.06, sink: 0.15, glowW: 0.8, glowH: 0.7, glowT: 0.4, glowZ: 0.7, base: 0.3, glow: 0.9 },
  },
};

const MAX_SIN = 0.97;          // limit of the reach angle (tool too short for the mount height → nearly horizontal)
const WORK_EASE = 7;           // 1/s – smoothing of the amount set by setWork
const TEAM_DETAIL = UNIT_KIT.teamPaint.lod.panel;   // big team parts stay down to the far silhouette
const SOCKET_AIM = 0.5;        // aim socket height: share of the hull height above the deck
const SMOKE_Z = 0.45;          // smoke socket z share of the hull length (behind the centre)
const HAZARD = { h: 0.3, stripe: 0.3, lift: 0.01, share: 0.8 };   // hazard strips on the auger arm: height, stripe width, off the wall, length share
const COLLAR = { h: 0.14, grow: 1.08 };   // yellow / black collars at the auger base (height, radius × drill radius)
const ARM_HOUSING = { r: 0.42, len: 1.0, seg: 10, stand: [1.2, 1.0] };   // pivot housing radius / length, stand footprint (w, d)
const MOTOR = { w: 0.8, h: 0.8, d: 0.6, back: 0.15 };   // auger gearbox at the arm end
const CONVEYOR_TILT = { lift: 0.5 };   // belt centre height share between the two ends
const STACK = { capGrow: 1.3, capH: 0.18 };   // chimney cap radius × r, height
const RAM = { r: 0.1, y: 0.55, share: 0.7, seg: 6 };   // percussion rig: exposed hydraulic ram along the boom
const FLIGHT = { depth: 0.42, thick: 0.1, turn: 0.8, from: 0.2, step: 0.2, over: 1.1 };   // auger flights: depth along z, thickness, twist per flight, first / step share of length
const CAB_WINDOW = { out: 0.02, t: 0.05 };
const HOPPER_GRATE = { count: 3, w: 0.9, h: 0.08, gap: 0.5 };   // dark bars over the hopper
const SEG = { pod: [10, 6], boomPivot: 6, rod: 6, joint: [6, 4], head: 6, beamIn: 6, beamOut: 8, spot: 10 };   // segment counts of the rig parts (triangle budget)
const BIT_GROW = 2.2;          // percussion bit base radius × rod radius
const JOINT = 1.1;             // laser arm joint ball radius × arm thickness
const LENS = { r: 0.65, t: 0.05, glowR: 0.7 };   // laser lens disc radius share of the head, thickness, glow radius share
const SPOT_LIFT = 0.04;        // beam spot disc above the ground
const GLOW = { ember: 0.9, core: 1.0, ring: 0.9, ringTubeShare: 0.6, spot: 0.8, lens: 1.0, halo: 0.3, hit: 0.9, hitScale: 2 };   // glow intensities
const HIT = { rise: 0.65 };    // percussion cycle share spent retracting (the rest is the fast drop)
const FLICKER = { beam: 40, heat: 11, heatDepth: 0.08, refBlink: 0.9 };   // rad/s of the beam shimmer and radiator pulse at style.anim.blink = refBlink, heat flicker depth

const shapeOf = (kit) => DRILL_TRUCK_SHAPES[kit.style.silhouette] ?? DRILL_TRUCK_SHAPES.rounded;

/** Angle (rx, + = tip down) at which a straight tool of length `reach` from height `h` touches the ground */
const reachAngle = (h, reach) => Math.asin(Math.min(MAX_SIN, h / reach));

// ---------------------------------------------------------------- rigs (each returns the rig data read by DrillTruckUnit.update)

/** Rounded: wheeled mine truck with a swinging auger arm, cab, conveyor and hopper */
function buildAuger(ub, kit, s, c) {
  const S = kit.S;
  const T = s.tool;
  const top = c.hl.top;
  const hb = ub.paint('hull');
  // cab (team lacquer) with windscreen, side emblem on a plate
  const K = s.cab;
  unitBox(hb, kit, K.w, K.h, K.d, S.teamPaint, { x: K.x, y: top + K.h / 2, z: K.z, detail: TEAM_DETAIL });
  hb.box(K.w * K.window[0], K.h * K.window[1], CAB_WINDOW.t, S.window, { x: K.x, y: top + K.h * K.window[2] + K.h * K.window[1] / 2, z: K.z + K.d / 2 + CAB_WINDOW.out });
  emblemPlate(ub, 'hull', { position: [K.x - K.w / 2, top + K.h * 0.5, K.z], normal: [-1, 0, 0], size: 0.55 });
  statusLamp(ub, { parent: 'hull', position: [K.x, top + K.h, K.z - K.d * 0.25] });
  // hopper + team roof mark
  const H = s.hopper;
  hb.taperedBox(H.w, H.topW, H.h, H.d, S.teamShade, { x: H.x, y: top, z: H.z, detail: TEAM_DETAIL });
  roofMark(ub, 'hull', { x: H.x, y: top + H.h, z: H.z, w: H.topW * 0.6, d: H.d * 0.6 });
  for (let i = 0; i < HOPPER_GRATE.count; i++) {
    hb.box(H.topW * 0.8, HOPPER_GRATE.h, HOPPER_GRATE.h, S.dark, { x: H.x, y: top + H.h + HOPPER_GRATE.h / 2, z: H.z + (i - (HOPPER_GRATE.count - 1) / 2) * H.d * 0.25, detail: 0 });
  }
  // conveyor from the drill mount up to the hopper
  const V = s.conveyor;
  const dz = V.z0 - V.z1;
  const dy = V.y1 - V.y0;
  const len = Math.hypot(dz, dy);
  const tilt = Math.atan2(dy, dz);
  const cy = top + V.y0 + dy * CONVEYOR_TILT.lift;
  const cz = (V.z0 + V.z1) / 2;
  hb.box(V.w, V.rail, len, S.dark, { x: V.x, y: cy, z: cz, rx: tilt });
  for (const side of [1, -1]) hb.box(V.rail, V.rail * 2, len, S.frame, { x: V.x + side * V.w / 2, y: cy + V.rail, z: cz, rx: tilt });
  // grille bars on the cab side of the hopper
  const G = s.grille;
  for (let i = 0; i < G.count; i++) hb.box(G.w, G.h, G.d, S.dark, { x: K.x, y: top + K.h * 0.2 + i * G.gap, z: K.z - K.d / 2 - G.d / 2, detail: 0 });
  // drill mount + arm + auger
  const py = top + T.pivotY;
  hb.box(ARM_HOUSING.stand[0], T.pivotY, ARM_HOUSING.stand[1], S.hullDark, { y: top + T.pivotY / 2, z: T.pivotZ });
  ub.bone('arm', 'hull', [0, py, T.pivotZ], { rotation: [T.stow, 0, 0] });
  const ab = ub.paint('arm');
  ab.cylinder(ARM_HOUSING.r, ARM_HOUSING.r, ARM_HOUSING.len, ARM_HOUSING.seg, S.hullDark, { rz: HALF_PI });
  ab.box(T.armW, T.armW * 0.85, T.armL, S.frame, { z: T.armL / 2 });
  for (const side of [1, -1]) {
    ab.hazardStrip(T.armL * HAZARD.share, HAZARD.h, HAZARD.stripe, S.accent, S.dark, { x: side * (T.armW / 2 + HAZARD.lift), z: T.armL / 2, ry: side * HALF_PI });
  }
  ab.box(MOTOR.w, MOTOR.h, MOTOR.d, S.hullDark, { z: T.armL - MOTOR.back });
  ub.bone('drill', 'arm', [0, 0, T.armL]);
  const db = ub.paint('drill');
  db.cylinder(0, T.drillR, T.drillL, UNIT_MODULES.seg, S.frame, { rx: HALF_PI, z: T.drillL / 2 });
  for (let k = 0; k < T.flights; k++) {
    const f = FLIGHT.from + k * FLIGHT.step;
    db.box(2 * T.drillR * (1 - f) * FLIGHT.over, FLIGHT.thick, FLIGHT.depth, S.trim, { z: T.drillL * f, rz: k * FLIGHT.turn, detail: 0 });
  }
  for (let k = 0; k < 2; k++) {
    db.cylinder(T.drillR * COLLAR.grow, T.drillR * COLLAR.grow, COLLAR.h, UNIT_MODULES.seg, k ? S.dark : S.accent, { rx: HALF_PI, z: COLLAR.h * (k + 0.5) });
  }
  ub.socket('work', 'drill', [0, 0, T.drillL]);
  const work = reachAngle(c.hullY + py, T.armL + T.drillL);
  return { arm: { bone: 'arm', stow: T.stow, work }, spin: { bone: 'drill', speed: T.spin } };
}

/** Angular: heavy tracked rig with a boom, a sliding percussion drill, exposed ram, bin and smoke stacks */
function buildPercussion(ub, kit, s, c) {
  const S = kit.S;
  const T = s.tool;
  const top = c.hl.top;
  const hb = ub.paint('hull');
  const K = s.cab;
  hb.box(K.w, K.h, K.d, S.teamPaint, { x: K.x, y: top + K.h / 2, z: K.z, detail: TEAM_DETAIL });
  hb.box(K.w * 0.8, K.h * 0.2, CAB_WINDOW.t, S.window, { x: K.x, y: top + K.h * 0.62, z: K.z + K.d / 2 + CAB_WINDOW.out });
  emblemPlate(ub, 'hull', { position: [K.x - K.w / 2, top + K.h * 0.5, K.z], normal: [-1, 0, 0], size: 0.5 });
  statusLamp(ub, { parent: 'hull', position: [K.x, top + K.h, K.z - K.d * 0.25] });
  const B = s.bin;
  hb.taperedBox(B.w, B.topW, B.h, B.d, S.teamShade, { x: B.x, y: top, z: B.z, detail: TEAM_DETAIL });
  roofMark(ub, 'hull', { x: B.x, y: top + B.h, z: B.z, w: B.topW * 0.7, d: B.d * 0.6 });
  // boom on the front ledge of the lower hull
  const ledge = c.hl.top - (s.H * (1 - UNIT_MODULES.hull.angular.lowerShare));
  const py = ledge + T.pivotY;
  hb.box(ARM_HOUSING.stand[0], T.pivotY, ARM_HOUSING.stand[1], S.hullDark, { y: ledge + T.pivotY / 2, z: T.pivotZ });
  ub.bone('arm', 'hull', [0, py, T.pivotZ], { rotation: [T.stow, 0, 0] });
  const ab = ub.paint('arm');
  ab.cylinder(ARM_HOUSING.r, ARM_HOUSING.r, T.armW * 1.3, SEG.boomPivot, S.frame, { rz: HALF_PI });
  ab.box(T.armW, T.armW * 0.8, T.armL, S.hullDark, { z: T.armL / 2 });
  ab.cylinder(RAM.r, RAM.r, T.armL * RAM.share, RAM.seg, S.trim, { rx: HALF_PI, y: T.armW * 0.5 + RAM.y * 0.5, z: T.armL * RAM.share / 2 });
  ab.box(T.armW * 1.25, T.armW * 1.25, T.armW * 1.1, S.frame, { z: T.armL });   // drill housing
  // drill rod: slides along the boom (percussion), tip at local z = rodL + bitL
  ub.bone('drill', 'arm', [0, 0, T.armL]);
  const db = ub.paint('drill');
  db.cylinder(T.rodR, T.rodR, T.rodL, SEG.rod, S.trim, { rx: HALF_PI, z: T.rodL / 2 });
  db.cylinder(0, T.rodR * BIT_GROW, T.bitL, SEG.rod, S.frame, { rx: HALF_PI, z: T.rodL + T.bitL / 2 });
  db.box(T.rodR * 5, T.rodR * 5, T.rodR * 3, S.dark, { z: T.rodL * 0.25 });   // piston block
  ub.socket('work', 'drill', [0, 0, T.rodL + T.bitL]);
  // smoke stacks with embers (sockets exhaust_1 / exhaust_2, smoke between them)
  const K2 = s.stacks;
  const ember = ub.style.exhaust.outer;
  [1, -1].forEach((side, i) => {
    const x = side * K2.x;
    const base = ledge;
    hb.cylinder(K2.r, K2.r * STACK.capGrow, K2.h, K2.seg, S.frame, { x, y: base + K2.h / 2, z: K2.z });
    hb.cylinder(K2.r * STACK.capGrow, K2.r * STACK.capGrow, STACK.capH, K2.seg, S.dark, { x, y: base + K2.h, z: K2.z });
    ub.glow('hull').point([x, base + K2.h + STACK.capH, K2.z], K2.ember, ember, { intensity: GLOW.ember });
    ub.socket(`exhaust_${i + 1}`, 'hull', [x, base + K2.h + STACK.capH, K2.z]);
  });
  const reach = T.armL + T.rodL + T.bitL;
  const work = reachAngle(c.hullY + py, reach);
  return {
    arm: { bone: 'arm', stow: T.stow, work },
    slide: { bone: 'drill', z0: T.armL, stroke: T.stroke, rate: T.rate },
    rattle: { amp: T.rattle, rate: T.rattleRate },
  };
}

/** Round: hovering plasma rig – levitating rings sink to the ground, a violet beam drills into it */
function buildPlasma(ub, kit, s, c) {
  const S = kit.S;
  const T = s.tool;
  const { W } = c;
  const top = c.hl.top;
  const hb = ub.paint('hull');
  const P = s.pod;
  const [pr0, pr1, pr2] = P.r;
  for (const side of [1, -1]) {
    hb.sphere(1, SEG.pod[0], SEG.pod[1], S.teamPaint, { sx: pr0, sy: pr1, sz: pr2, x: side * W * P.x, y: c.base + s.H * P.y, z: P.z, detail: TEAM_DETAIL });
  }
  emblemPlate(ub, 'hull', { position: [-(W * P.x + pr0), c.base + s.H * P.y, P.z], normal: [-1, 0, 0], size: 0.6, backing: false });
  // dome with the plasma core (core bone pulses through the lens driver)
  const D = s.dome;
  hb.sphere(D.r, D.seg[0], D.seg[1], S.lens, { sy: D.flat, y: top + D.y, z: D.z, detail: 1 });
  ub.bone('core', 'hull', [0, top + D.y + D.r * D.flat * 0.2, D.z]);
  ub.glow('core').sphere(D.r * D.core, D.coreSeg[0], D.coreSeg[1], ub.style.plasma, { intensity: GLOW.core });
  ub.meta.lenses.push({ bone: 'core' });
  statusLamp(ub, { parent: 'hull', position: [0, top, -c.hullLen * 0.3] });
  // rings: hidden in the skirt while driving, sink to the ground when working
  const rings = [];
  const ringColor = ub.style.weaponGlow;
  for (let i = 0; i < 3; i++) {
    const name = ub.bone(`ring_${i + 1}`, 'hull', [0, T.stowY, 0]);
    ub.paint(name).torus(T.ringR, T.ringTube, T.ringSeg[0], T.ringSeg[1], TAU, S.frame, { rx: HALF_PI });
    ub.glow(name).torus(T.ringR, T.ringTube * GLOW.ringTubeShare, T.ringSeg[0], T.ringSeg[1], ringColor, { rx: HALF_PI, intensity: GLOW.ring });
    rings.push({
      bone: name, y0: T.stowY, y1: -c.hullY * (i + 1) / 3 + T.over * (i === 2 ? 0.5 : 0),
      s0: T.stowScale, s1: T.workScale * (1 + T.scaleStep * i),
    });
  }
  // beam: from the belly centre down to the ground (bone scale y = length)
  const len = c.hullY + T.over;
  ub.bone('beam', 'hull', [0, 0, 0]);
  const g = ub.glow('beam');
  g.cylinder(T.beamIn[0], T.beamIn[1], len, SEG.beamIn, ub.style.exhaust.core, { y: -len / 2 }, false);
  g.cylinder(T.beamOut[0], T.beamOut[1], len, SEG.beamOut, ub.style.plasma, { y: -len / 2, intensity: T.beamOutGlow });
  g.disc(T.spotR, SEG.spot, ub.style.plasma, { y: -len + SPOT_LIFT, intensity: GLOW.spot });
  ub.socket('work', 'hull', [0, -c.hullY, 0]);
  return { rings, beam: { bone: 'beam', axis: 'y', from: T.beamFrom, flicker: T.flicker } };
}

/** Faceted: tracked chassis, mining laser on a jointed arm (beam to the ground), glowing radiator fins */
function buildLaser(ub, kit, s, c) {
  const S = kit.S;
  const T = s.tool;
  const top = c.hl.top;
  const hb = ub.paint('hull');
  const M = s.mount;
  hb.box(M.w, M.h, M.d, S.teamPaint, { y: top + M.h / 2, z: M.z, detail: TEAM_DETAIL });
  emblemPlate(ub, 'hull', { position: [-M.w / 2, top + M.h / 2, M.z], normal: [-1, 0, 0], size: 0.4 });
  statusLamp(ub, { parent: 'hull', position: [0, top, 0.3] });
  // arm → head (lens housing + lens) → beam
  const py = top + M.h + T.armT / 2;
  ub.bone('arm', 'hull', [0, py, M.z], { rotation: [T.stowArm, 0, 0] });
  const ab = ub.paint('arm');
  ab.sphere(T.armT * JOINT, SEG.joint[0], SEG.joint[1], S.frame, {});
  ab.box(T.armT, T.armT, T.armL, S.hullDark, { z: T.armL / 2 });
  ub.bone('head', 'arm', [0, 0, T.armL], { rotation: [T.stowHead, 0, 0] });
  const hd = ub.paint('head');
  hd.sphere(T.armT * JOINT, SEG.joint[0], SEG.joint[1], S.frame, {});
  prism(hd, SEG.head, T.headR * 2, T.headR * 2, T.headL, S.hullDark, { z: T.headL / 2 });
  hd.cylinder(T.headR * LENS.r, T.headR * LENS.r, LENS.t, SEG.head, S.lens, { rx: HALF_PI, z: T.headL });
  ub.bone('lens', 'head', [0, 0, T.headL]);
  ub.glow('lens').point([0, 0, LENS.t], T.headR * LENS.glowR, ub.style.weaponGlow, { intensity: GLOW.lens });
  ub.meta.lenses.push({ bone: 'lens' });
  // beam length: forward kinematics of the working pose so that the beam ends exactly on the ground
  const pitch = T.workArm + T.workHead;
  const yHead = c.hullY + py - T.armL * Math.sin(T.workArm);
  const yTip = yHead - T.headL * Math.sin(pitch);
  const beamLen = Math.max(0.2, yTip / Math.max(0.1, Math.sin(pitch)));
  ub.bone('beam', 'head', [0, 0, T.headL]);
  const g = ub.glow('beam');
  g.box(T.beamT, T.beamT, beamLen, ub.style.exhaust.core, { z: beamLen / 2 });
  g.box(T.beamHalo, T.beamHalo, beamLen, ub.style.exhaust.outer, { z: beamLen / 2, intensity: GLOW.halo });
  g.point([0, 0, beamLen], T.beamHalo * GLOW.hitScale, ub.style.exhaust.outer, { intensity: GLOW.hit });
  ub.socket('work', 'head', [0, 0, T.headL + beamLen]);
  // radiator fins on the ridge: dark plates + glowing slats on a bone (glow rises with the work)
  const R = s.radiator;
  const z0 = R.z - ((R.count - 1) * R.step) / 2;
  ub.bone('rad', 'hull', [0, top - R.sink, z0]);
  const rg = ub.glow('rad');
  for (let i = 0; i < R.count; i++) {
    hb.box(R.w, R.h, R.t, S.hullDark, { y: top - R.sink + R.h / 2, z: z0 + i * R.step });
    rg.box(R.glowW, R.glowH, R.t * R.glowT, ub.style.exhaust.outer, { y: R.sink + R.glowH / 2 + (R.h - R.glowH) * 0.5, z: i * R.step + R.t * R.glowZ, intensity: R.glow });
  }
  return {
    arm: { bone: 'arm', stow: T.stowArm, work: T.workArm },
    head: { bone: 'head', stow: T.stowHead, work: T.workHead },
    beam: { bone: 'beam', axis: 'z', from: T.beamFrom, flicker: T.flicker },
    heat: { bone: 'rad', base: R.base },
  };
}

const RIGS = { auger: buildAuger, percussion: buildPercussion, plasma: buildPlasma, laser: buildLaser };

// ---------------------------------------------------------------- model

function buildDrillTruck(kit) {
  const s = shapeOf(kit);
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  const C = s.chassis;
  const L = s.L;
  const W = s.hullW;
  let hullY;
  let base = 0;   // hull bottom in the hull bone's space (hover skirt height)
  if (C.kind === 'wheels') {
    wheels(ub, { L: C.bellyL, gauge: C.gauge, r: C.r, ww: C.ww, axles: C.axles, steer: C.steer });
    // team fenders above the wheels (big team surface seen from above)
    const zMax = Math.max(...C.axles);
    const zMin = Math.min(...C.axles);
    for (const side of [1, -1]) {
      ub.paint('root').box(C.ww * C.fenderW, 0.06, zMax - zMin + 2 * C.r * C.fenderOver, S.teamPaint, {
        x: side * C.gauge / 2, y: 2 * C.r + 0.05, z: (zMin + zMax) / 2, detail: TEAM_DETAIL,
      });
    }
    hullY = C.r * C.lift;
    ub.bone('hull', 'root', [0, hullY, 0]);
    ub.meta.hull = { bone: 'hull', bank: false };
  } else if (C.kind === 'tracks') {
    const th = L * C.th;
    tracks(ub, { L, gauge: s.hullW * C.gauge, tw: s.hullW * C.tw, th, team: true });
    hullY = th * C.lift;
    ub.bone('hull', 'root', [0, hullY, 0]);
    ub.meta.hull = { bone: 'hull', bank: false };
  } else {
    hullY = C.gap;
    ub.bone('hull', 'root', [0, hullY, 0]);
    base = hover(ub, { bone: 'hull', L: L * C.skirtL, W: W * C.skirtW, skirtH: C.skirtH, pads: C.pads.map(([x, z]) => [x * W, z * L]) });
  }
  const hullLen = L * s.hullL;
  const hl = hull(ub, { bone: 'hull', y: base, L: hullLen, W, H: s.H, team: true });
  const ctx = { hl, hullY, hullLen, base, W };
  const rig = RIGS[s.rig](ub, kit, s, ctx);
  ub.socket('aim', 'hull', [0, hl.top + s.H * SOCKET_AIM, 0]);
  ub.socket('smoke', 'hull', [0, hl.top, -hullLen * SMOKE_Z]);
  const data = ub.build();
  data.rig = rig;
  return data;
}

const CACHE = createUnitCache(buildDrillTruck);

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

export class DrillTruckUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'drillTruck', name: 'DrillTruckUnit' });
    this.workKind = 'none';
    this.workTarget = 0;   // amount set by the owner (0 unless 'harvest')
    this.workLevel = 0;    // smoothed 0..1
    this.spinAngle = 0;
    this.flickerRate = FLICKER.refBlink / this.kit.style.anim.blink;   // faster shimmer in styles with a short blink period
    const R = this.shared.rig ?? {};
    const bone = (name) => (name ? this.getBone(name) : null);
    // rig with resolved bones (built once; update() only reads it)
    this.rig = {
      arm: R.arm ? { ...R.arm, bone: bone(R.arm.bone) } : null,
      head: R.head ? { ...R.head, bone: bone(R.head.bone) } : null,
      spin: R.spin ? { ...R.spin, bone: bone(R.spin.bone) } : null,
      slide: R.slide ? { ...R.slide, bone: bone(R.slide.bone) } : null,
      rings: (R.rings ?? []).map((r) => ({ ...r, bone: bone(r.bone) })),
      beam: R.beam ? { ...R.beam, bone: bone(R.beam.bone) } : null,
      heat: R.heat ? { ...R.heat, bone: bone(R.heat.bone) } : null,
      rattle: R.rattle ?? null,
    };
    this.applyWork(0, 0);
  }

  /** kind 'none' | 'harvest', amount 0..1 (smooth, set by the owner every tick): deploys / folds the mining tool */
  setWork(kind, amount = 1) {
    this.workKind = kind;
    this.workTarget = kind === 'harvest' ? clamp01(amount) : 0;
  }

  /** True while the tool is (partly) out */
  get working() { return this.workLevel > 0.01; }

  update(dt) {
    const k = Math.min(1, dt * WORK_EASE);
    this.workLevel += (this.workTarget - this.workLevel) * k;
    if (this.workLevel < 1e-3 && this.workTarget === 0) this.workLevel = 0;
    this.applyWork(this.workLevel, dt);
  }

  /** Poses the tool bones for work level w (0 folded … 1 working); dt advances spin / percussion (0 = pose only) */
  applyWork(w, dt) {
    const R = this.rig;
    const e = smootherstep(w);
    const t = this.time;
    const hidden = UNIT_KIT.hiddenScale;
    if (R.arm) R.arm.bone.rotation.x = R.arm.stow + (R.arm.work - R.arm.stow) * e;
    if (R.head) R.head.bone.rotation.x = R.head.stow + (R.head.work - R.head.stow) * e;
    if (R.spin) {
      this.spinAngle = (this.spinAngle + R.spin.speed * this.kit.style.anim.spin * e * dt) % TAU;
      R.spin.bone.rotation.z = this.spinAngle;
    }
    if (R.slide) {
      // percussion: slow retract, fast drop onto the ground (k = 0 at the hit, tip touches the ground at z0)
      const p = (t * R.slide.rate * this.kit.style.anim.tempo) % 1;
      const kk = p < HIT.rise ? Math.sin((p / HIT.rise) * HALF_PI) : 1 - ((p - HIT.rise) / (1 - HIT.rise)) ** 2;
      R.slide.bone.position.z = R.slide.z0 - R.slide.stroke * kk * e;
    }
    if (R.rattle && this.hull) {
      this.hull.bone.position.y = this.hull.y + R.rattle.amp * e * Math.sin(t * R.rattle.rate);
    }
    for (let i = 0; i < R.rings.length; i++) {
      const r = R.rings[i];
      const sc = r.s0 + (r.s1 - r.s0) * e;
      r.bone.position.y = r.y0 + (r.y1 - r.y0) * e;
      r.bone.scale.set(sc, 1, sc);
    }
    if (R.beam) {
      const bk = clamp01((e - R.beam.from) / (1 - R.beam.from));
      const fl = 1 + R.beam.flicker * Math.sin(this.flickerRate * FLICKER.beam * t + this.phase);
      const len = bk > 0 ? bk : hidden;
      if (R.beam.axis === 'y') R.beam.bone.scale.set(fl, len, fl);
      else R.beam.bone.scale.set(fl, fl, len);
    }
    if (R.heat) {
      const fl = 1 + FLICKER.heatDepth * Math.sin(this.flickerRate * FLICKER.heat * t + this.phase);
      R.heat.bone.scale.set(1, (R.heat.base + (1 - R.heat.base) * e) * fl, 1);
    }
  }
}

registerProcUnit('drillTruck', (race, teamColor, opts) => new DrillTruckUnit({ race, teamColor, ...opts }));
