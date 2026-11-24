// Steel Mans – procedural robot assembly bay (roadmap 18, wave 1). A drop-in alternative to
// models/3DStructures{race}/RobotAssemblyBay{race}_Anim.glb built in code from the style modules (ProcModules.js):
//   • the GLB is only a flat pad (±16 × ±16, 2 high); the mech hologram (RobotProduction → MechHologram) and a serviced
//     mech stand in the middle of it (feet 0.5 above the pad top), so the middle stays free: a turntable with a team
//     emblem on it, an open front (+Z, where the mech leaves) and the building masses on the back / flanks
//   • body per style.silhouette (rounded: chamfered hall + 2 towers · angular: armoured block with buttresses, spikes and
//     chimneys · round: elliptic domed hall, pods and plasma coils · faceted: slim blade block, radiators, emitter pylons
//     joined by laser barriers); vents / lamps / markings / industry come from the style (ventUnit, beacon, marking …)
//   • the assembly rig – a ring around the robot that turns around it and travels up and down along it (like a crane),
//     by style.crane: gantry = octagonal ring frame with two ramp arms and hooks · heavyGantry = thick ring, three hydraulic
//     claws, stepped (jerky) motion · plasma = levitating tilted plasma rings, one counter-rotating · tractorBeam = slim
//     ring with orbiting laser emitters that fire converging beams at the robot
//   • light: one merged static mesh per style (buildLods) + emblem decals (1 draw call) + glow layers + a few named
//     animated parts (rig ring[s], fans, orb rings) – about 7–9 draw calls, no per-instance geometry
// `active` = "a mech is being assembled right now" (Structure: complete && powered && queue item). While active the rig
// spins up and sweeps along the robot, fans spin, glow / lasers / beacons wake up; idle it parks low (plasma rings keep
// levitating slowly). Optional: setProgress(p) makes the rig climb with the assembly progress (like the hologram parts).
// Visual only: update() takes the frame delta and nothing here is read by the simulation. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Blinker, smootherstep, steppedEase } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, tank, chimney, plasmaCoil, laserLink, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const BAY_ANIM = {
  powerEase: 1.4,        // 1/s – how fast the bay spins up / down (active ↔ idle)
  sweepPeriod: 9,        // s – one up-and-down sweep of the rig along the robot (÷ style.anim.tempo)
  jerkSteps: 4,          // stepped pushes per travel when style.anim.jerk > 0 (rig lift, like the heavy crane)
  jerkTicks: 12,         // ticks per revolution of the rig when style.anim.jerk > 0
  progressEase: 3,       // 1/s – how fast the rig follows setProgress() jumps
  fanSpeed: 4.0,         // rad/s at work (× style.anim.spin)
  fanIdle: 0.4,
  fanSpeedJitter: 0.25,
  idleGlow: 0.3,         // turntable / plasma / laser glow share while idle
  idleBeacon: 0.4,       // beacon intensity while idle (they blink while active)
  blinkDuty: 0.5,
  phaseStep: 0.43,       // s – pulse phase offset per instance
  counterShare: 0.7,     // the second ring turns against the first at this share of its speed
};

/** Rig behaviour by style.crane (the data picks a kind, code never reads faction names; unknown → gantry) */
const RIG_KINDS = {
  gantry: { speed: 0.55, idleSpin: 0, idleGlow: 0, bob: 0 },
  heavyGantry: { speed: 0.4, idleSpin: 0, idleGlow: 0, bob: 0 },
  plasma: { speed: 0.85, idleSpin: 0.3, idleGlow: 0.3, bob: 0.3 },
  tractorBeam: { speed: 1.7, idleSpin: 0.15, idleGlow: 0, bob: 0.1 },
};
const rigKindOf = (style) => (Object.hasOwn(RIG_KINDS, style.crane) ? style.crane : 'gantry');

/**
 * The robot standing in the bay (model units; ASSUMPTION – MechHologram has no fixed size): the hologram's feet are
 * HOLOGRAM.heightOffset (0.5) above the pad top (2.0). The rig ring clears `radius`, travels over `height`.
 */
const ROBOT = { feetY: 2.5, height: 12, radius: 5 };

/** Shared layout (model units, GLB scale; origin = pad centre on the ground, front = +Z) */
const LAYOUT = {
  half: 15.6,               // pad half size (GLB ±16)
  slabH: 2.0,               // pad top = GLB pad height
  turn: { r: 8.2, h: 0.2, ringInset: 0.4, ringTube: 0.07, glowTube: 0.2, segments: 40, plateR: 2.4, plateH: 0.05, rim: 0.3 },
  emblemFloor: { z: 5.9, size: 3.4, lift: 0.04 },   // emblem on the turntable in front of the robot
  backFront: -10.8,         // front face of every building mass at the back (keeps the rig arms clear)
  neonMin: 0.3,             // style.neon from which bands get a neon line
  apron: { z: 12.5, len: 12, h: 0.8, lift: 0.02 },
  rail: { x: 15.0, h: 1.0, t: 0.12, zFrom: 0, zTo: 14.7, postStep: 3.7 },   // safety rail along the open flanks (hazard style)
  column: { at: 8.1, h: 15 },                       // guide columns at the diagonals, outside the rig arms
};

/** Rig (all kinds): ring radius, park / top height of its centre above the pad top */
const RIG = {
  ringR: 6.8,
  parkY: ROBOT.feetY - LAYOUT.slabH + 0.3,
  topY: ROBOT.feetY - LAYOUT.slabH + ROBOT.height,
};

/** Dimensions of every body by style.silhouette (code knows shapes, the style data picks one; unknown → rounded) */
const DIM = {
  rounded: {
    slab: { edge: 0.6 },
    back: { w: 22, h: 9, d: 4.8, band: { y: 1.4, h: 0.4, t: 0.06 }, neon: { drop: 0.9, h: 0.14 }, win: { x: 7.2, y: 4.6, w: 3.8, h: 1.8, t: 0.06 }, decal: { y: 4.6, size: 4.6 }, vents: [-6.5, 6.5], ventR: 2.0 },
    tower: { x: 13.4, w: 4.4, h: 7, d: 12, z: -8.6, band: { y: 1.4, h: 0.4 }, decal: { y: 4, size: 3.6 }, tank: { r: 1.2, len: 8, rise: 0.4 }, beaconIn: 0.6 },
    column: { kind: 'round', r: 0.45, rBottom: 0.55, band: { h: 0.6, y: 1.2 } },
    parapet: false,
  },
  angular: {
    slab: { skirtH: 1.2, topW: 29.6, capH: 0.8 },
    back: { w: 24, h: 6.4, d: 4.8, capH: 2.6, capTopW: 20, lower: { y: 1.2, w: 21, h: 2, t: 0.06 }, band: { y: 4.4, w: 21, h: 0.5, t: 0.06 }, slit: { y: 5.4, w: 14, h: 0.3, t: 0.06 }, decal: { y: 3.0, size: 4.4 },
      buttress: { xs: [-10, -5.2, 5.2, 10], w: 1.6, h: 5.6, d: 1.2 }, spikes: { xs: [-10.5, -5, 0, 5, 10.5], h: 1.1, r: 0.3 }, vents: [-7, 7], ventR: 1.9 },
    tower: { x: 13.4, w: 4.4, h: 7.5, d: 12, z: -8.6, capH: 1.4, capTopW: 3.2, decal: { y: 3.6, size: 3.6 }, spikeH: 1.3, spikeR: 0.32, chimney: { h: 5, r: 0.8, dz: -3 }, beaconIn: 0.6, lower: { y: 1.2, h: 1.6 } },
    column: { kind: 'square', w: 0.95, band: { h: 0.6, y: 1.2 }, spikeH: 1.2, spikeR: 0.3 },
  },
  round: {
    slab: { segments: 48, ringTube: 0.12, ringInset: 0.4 },
    hall: { sx: 9, sz: 2.4, z: -13.2, drumH: 4.0, segments: 40, neonH: 0.25, neonY: 3.1, domeSy: 0.5, decal: { y: 2.0, size: 3.4 }, ventR: 2.2 },
    pod: { x: 12.5, z: -6, r: 2.4, h: 5, capSy: 0.6, neonY: 3.2, decal: { y: 2.4, size: 3.2 }, ringTube: 0.09 },
    coil: { x: 12.5, z: 7, h: 5, r: 1.4 },
    veins: { count: 10, w: 0.1, h: 3, y: 1.8, out: 0.04 },
  },
  faceted: {
    slab: { r: 15.6 / Math.cos(Math.PI / 8), segments: 8, inlay: 20 },
    back: { w: 20, topW: 12, h: 8, d: 4.8, band: { y: 1.4, h: 0.4, t: 0.06 }, neon: { drop: 0.7, h: 0.1 }, decal: { y: 3.4, size: 4.2 }, lens: { xs: [-7.2, 7.2], y: 5.0, s: 1.7, t: 0.12 }, vents: [-3.4, 3.4], ventR: 2.0, fin: { h: 5, r: 0.7 } },
    pylon: { list: [[-13, -13], [13, -13], [-13, 9], [13, 9]], w: 1.8, topW: 0.6, h: 10, capR: 0.35, capH: 0.4, heights: [3, 6, 9], thickness: 0.05 },
  },
};

const BODIES = {};   // filled below (silhouette → body function)

// ---------------------------------------------------------------- small helpers (construction time only)

/** Guide column of the style kind at [x, z] with a beacon on top (X/Y only) */
function column(c, spec, x, z) {
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const h = L.column.h;
  if (spec.kind === 'square') {
    b.box(spec.w, h, spec.w, S.hullDark, { base: true, x, y: L.slabH, z, ry: Math.PI / 4 });
    spike(b, kit, { x, y: L.slabH + h, z, h: spec.spikeH, r: spec.spikeR });
  } else {
    b.cylinder(spec.r, spec.rBottom, h, 10, S.frame, { x, y: L.slabH + h / 2, z });
    beacon(b, glows.get('beaconA'), kit, [x, L.slabH + h, z]);
  }
  b.cylinder(spec.r ?? spec.w * 0.55, spec.r ?? spec.w * 0.55, spec.band.h, 10, S.accent, { x, y: L.slabH + spec.band.y, z });
}

/** Turntable in the middle of the pad: disc, neon ring (+ glow), team plate and the emblem decal in front of the robot */
function turntable(c) {
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const T = L.turn;
  b.cylinder(T.r, T.r + T.rim, T.h, T.segments, S.frame, { y: L.slabH + T.h / 2 });
  if (kit.style.neon >= L.neonMin) b.torus(T.r - T.ringInset, T.ringTube, 4, T.segments * 2, TAU, S.neon, { rx: HALF_PI, y: L.slabH + T.h + 0.01 });
  glows.get('core').torus(T.r - T.ringInset, T.glowTube, 4, T.segments * 2, TAU, { rx: HALF_PI, y: L.slabH + T.h + 0.05 });
  b.cylinder(T.plateR, T.plateR, T.plateH, 24, S.team, { y: L.slabH + T.h + T.plateH / 2 });
  const E = L.emblemFloor;
  c.decals.push({ position: [0, L.slabH + T.h + E.lift, E.z], normal: [0, 1, 0], size: E.size });
}

/** Front apron marking (hazard stripes / light line, none for styles without) and the hazard side rails */
function safety(c) {
  const { b, S, kit } = c;
  const L = LAYOUT;
  marking(b, kit, L.apron.len, L.apron.h, { rx: -HALF_PI, y: L.slabH + L.apron.lift, z: L.apron.z });
  if (kit.style.markings !== 'hazard') return;
  const R = L.rail;
  const len = R.zTo - R.zFrom;
  for (const s of [-1, 1]) {
    b.box(R.t, R.t, len, S.accent, { x: s * R.x, y: L.slabH + R.h, z: (R.zFrom + R.zTo) / 2 });
    for (let z = R.zFrom; z <= R.zTo + 0.01; z += R.postStep) b.box(R.t, R.h, R.t, S.frame, { base: true, x: s * R.x, y: L.slabH, z });
  }
}

const roofVents = (c, xs, y, z, r) => { for (const x of xs) c.vents.push(ventUnit(c.b, c.glows, c.kit, { x, y, z, r })); };

// ---------------------------------------------------------------- bodies

/** rounded: chamfered slab, back hall with windows / emblem, two towers (tanks, beacons), guarded fans, guide columns */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const y0 = L.slabH;
  styledBox(b, kit, L.half * 2, y0, L.half * 2, S.hullDark, { base: true }, D.slab.edge);
  const B = D.back;
  const bz = L.backFront - B.d / 2;
  const roof = y0 + B.h;
  styledBox(b, kit, B.w, B.h, B.d, S.hull, { base: true, y: y0, z: bz });
  b.box(B.w * 0.9, B.band.h, B.band.t, S.team, { y: y0 + B.band.y, z: L.backFront + B.band.t / 2 });
  if (kit.style.neon >= L.neonMin) neonStrip(b, kit, B.w * 0.9, B.neon.h, B.band.t, { y: roof - B.neon.drop, z: L.backFront + B.band.t / 2 });
  for (const s of [-1, 1]) b.box(B.win.w, B.win.h, B.win.t, S.window, { x: s * B.win.x, y: y0 + B.win.y, z: L.backFront + B.win.t / 2 });
  c.decals.push({ position: [0, y0 + B.decal.y, L.backFront], normal: [0, 0, 1], size: B.decal.size });
  roofVents(c, B.vents, roof, bz, B.ventR);

  const T = D.tower;
  for (const s of [-1, 1]) {
    const x = s * T.x;
    styledBox(b, kit, T.w, T.h, T.d, S.hull, { base: true, x, y: y0, z: T.z }, 1);
    b.box(0.06, T.band.h, T.d * 0.8, S.team, { x: s * (T.x + T.w / 2 + 0.03), y: y0 + T.band.y, z: T.z });
    c.decals.push({ position: [s * (T.x + T.w / 2), y0 + T.decal.y, T.z], normal: [s, 0, 0], size: T.decal.size });
    beacon(b, glows.get('beaconA'), kit, [x - s * (T.w / 2 - T.beaconIn), y0 + T.h, T.z + T.d / 2 - T.beaconIn]);
    tank(b, kit, { x, y: y0 + T.h + T.tank.rise + T.tank.r, z: T.z, r: T.tank.r, len: T.tank.len, ry: HALF_PI, floorY: y0 + T.h });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) column(c, D.column, sx * L.column.at, sz * L.column.at);
  safety(c);
};

/** angular: armoured skirt, buttressed block with a sloped cap and spikes, two slab towers with chimneys, open fans */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const y0 = L.slabH;
  const Sl = D.slab;
  b.box(L.half * 2, Sl.skirtH, L.half * 2, S.hullDark, { base: true });
  b.taperedBox(L.half * 2, Sl.topW, y0 - Sl.skirtH, L.half * 2, S.hull, { y: Sl.skirtH }, Sl.topW);
  const B = D.back;
  const bz = L.backFront - B.d / 2;
  const capY = y0 + B.h;
  const roof = capY + B.capH;
  b.box(B.w, B.h, B.d, S.hull, { base: true, y: y0, z: bz });
  b.taperedBox(B.w, B.capTopW, B.capH, B.d, S.hullDark, { y: capY, z: bz }, B.d - 1);
  b.box(B.lower.w, B.lower.h, B.lower.t, S.lower, { y: y0 + B.lower.y, z: L.backFront + B.lower.t / 2 });
  b.box(B.band.w, B.band.h, B.band.t, S.team, { y: y0 + B.band.y, z: L.backFront + B.band.t / 2 });
  b.box(B.slit.w, B.slit.h, B.slit.t, S.window, { y: y0 + B.slit.y, z: L.backFront + B.slit.t / 2 });
  for (const x of B.buttress.xs) b.box(B.buttress.w, B.buttress.h, B.buttress.d, S.hullDark, { base: true, x, y: y0, z: L.backFront + B.buttress.d / 2 });
  for (const x of B.spikes.xs) spike(b, kit, { x, y: capY, z: L.backFront - 0.4, h: B.spikes.h, r: B.spikes.r });
  c.decals.push({ position: [0, y0 + B.decal.y, L.backFront], normal: [0, 0, 1], size: B.decal.size });
  roofVents(c, B.vents, roof, bz, B.ventR);

  const T = D.tower;
  for (const s of [-1, 1]) {
    const x = s * T.x;
    const top = y0 + T.h;
    b.box(T.w, T.h, T.d, S.hull, { base: true, x, y: y0, z: T.z });
    b.taperedBox(T.w, T.capTopW, T.capH, T.d, S.hullDark, { x, y: top, z: T.z }, T.d - 1.4);
    b.box(0.06, T.lower.h, T.d * 0.8, S.lower, { x: s * (T.x + T.w / 2 + 0.03), y: y0 + T.lower.y, z: T.z });
    c.decals.push({ position: [s * (T.x + T.w / 2), y0 + T.decal.y, T.z], normal: [s, 0, 0], size: T.decal.size });
    for (const e of [-1, 1]) spike(b, kit, { x: x + s * T.w * 0.3, y: top + T.capH * 0.5, z: T.z + e * T.d * 0.4, h: T.spikeH, r: T.spikeR });
    chimney(b, kit, { x, y: top + T.capH, z: T.z + T.chimney.dz, h: T.chimney.h, r: T.chimney.r });
    beacon(b, glows.get('beaconA'), kit, [x - s * (T.w / 2 - T.beaconIn), top, T.z + T.d / 2 - T.beaconIn]);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) column(c, D.column, sx * L.column.at, sz * L.column.at);
  safety(c);
};

/** round: ringed round slab, elliptic domed hall with a plasma orb, plasma pods, two plasma coils at the front flanks */
BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const y0 = L.slabH;
  const Sl = D.slab;
  b.cylinder(L.half, L.half + 0.4, y0, Sl.segments, S.hullDark, { y: y0 / 2 });
  if (kit.style.neon >= L.neonMin) b.torus(L.half - Sl.ringInset, Sl.ringTube, 4, Sl.segments, TAU, S.neon, { rx: HALF_PI, y: y0 + 0.02 });

  // hall: elliptic drum + dome (scaled), neon ring, veins, emblem on the front
  const H = D.hall;
  b.cylinder(1, 1, H.drumH, H.segments, S.hull, { x: 0, y: y0 + H.drumH / 2, z: H.z, sx: H.sx, sz: H.sz });
  b.add(new THREE.SphereGeometry(1, 28, 8, 0, TAU, 0, HALF_PI), S.hull, { y: y0 + H.drumH, z: H.z, sx: H.sx, sy: H.sx * H.domeSy, sz: H.sz });
  b.cylinder(1.01, 1.01, H.neonH, H.segments, S.neon, { y: y0 + H.neonY, z: H.z, sx: H.sx, sz: H.sz }, true);
  if (kit.rich) {
    const V = D.veins;
    for (let i = 0; i < V.count; i++) {
      const x = ((i + 0.5) / V.count - 0.5) * H.sx * 1.7;
      const zf = H.z + H.sz * Math.sqrt(Math.max(0, 1 - (x / H.sx) ** 2));
      neonStrip(b, kit, V.w, V.h, V.w, { x, y: y0 + V.y, z: zf + V.out });
    }
  }
  const frontZ = H.z + H.sz;
  c.decals.push({ position: [0, y0 + H.decal.y, frontZ], normal: [0, 0, 1], size: H.decal.size });
  const peak = y0 + H.drumH + H.sx * H.domeSy;
  c.vents.push(ventUnit(b, glows, kit, { x: 0, y: peak - 0.2, z: H.z, r: H.ventR }));

  // pods (round towers with caps and a neon ring) and plasma coils at the front flanks
  const P = D.pod;
  for (const s of [-1, 1]) {
    const x = s * P.x;
    b.cylinder(P.r, P.r * 1.1, P.h, 20, S.hull, { x, y: y0 + P.h / 2, z: P.z });
    b.add(new THREE.SphereGeometry(P.r, 16, 6, 0, TAU, 0, HALF_PI), S.hullDark, { x, y: y0 + P.h, z: P.z, sy: P.capSy });
    b.torus(P.r * 1.04, P.ringTube, 4, 20, TAU, S.neon, { rx: HALF_PI, x, y: y0 + P.neonY, z: P.z });
    c.decals.push({ position: [s * (P.x + P.r), y0 + P.decal.y, P.z], normal: [s, 0, 0], size: P.decal.size });
    const co = D.coil;
    plasmaCoil(b, glows.get('pulse'), kit, { x: s * co.x, y: y0, z: co.z, h: co.h, r: co.r });
  }
  beacon(b, glows.get('beaconA'), kit, [0, y0 + 0.01, L.apron.z + 2.5]);
  safety(c);
};

/** faceted: octagonal slab with a diamond inlay, slim blade block with radiators / lens plates / a fin, emitter pylons + lasers */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const y0 = L.slabH;
  const laser = glows.get('laser');
  const Sl = D.slab;
  b.cylinder(Sl.r, Sl.r, y0, Sl.segments, S.hullDark, { y: y0 / 2, ry: Math.PI / 8 });
  b.box(Sl.inlay, 0.06, Sl.inlay, S.dark, { y: y0 + 0.03, ry: Math.PI / 4 });
  const B = D.back;
  const bz = L.backFront - B.d / 2;
  const roof = y0 + B.h;
  b.taperedBox(B.w, B.topW, B.h, B.d, S.hull, { y: y0, z: bz }, B.d);
  b.box(B.w * 0.8, B.band.h, B.band.t, S.team, { y: y0 + B.band.y, z: L.backFront + B.band.t / 2 });
  neonStrip(b, kit, B.topW, B.neon.h, B.neon.h, { y: roof + B.neon.h / 2, z: bz });
  for (const x of B.lens.xs) {
    b.box(B.lens.t, B.lens.s, B.lens.s, S.hullDark, { x, y: y0 + B.lens.y, z: L.backFront + B.lens.t / 2, ry: HALF_PI, rx: Math.PI / 4 });
    b.box(B.lens.t * 0.5, B.lens.s * 0.5, B.lens.s * 0.5, S.neon, { x, y: y0 + B.lens.y, z: L.backFront + B.lens.t, ry: HALF_PI, rx: Math.PI / 4 });
  }
  c.decals.push({ position: [0, y0 + B.decal.y, L.backFront], normal: [0, 0, 1], size: B.decal.size });
  roofVents(c, B.vents, roof, bz, B.ventR);
  spike(b, kit, { x: 0, y: roof, z: bz, h: B.fin.h, r: B.fin.r });

  // emitter pylons at the corners; laser barriers join them along the flanks (the front stays open for the mech)
  const P = D.pylon;
  for (const [x, z] of P.list) {
    b.taperedBox(P.w, P.topW, P.h, P.w, S.hullDark, { x, y: y0, z, ry: Math.PI / 4 });
    b.cylinder(P.capR, P.capR * 0.7, P.capH, 8, S.lens, { x, y: y0 + P.h + P.capH / 2, z });
    beacon(b, glows.get('beaconA'), kit, [x, y0 + P.h + P.capH, z]);
  }
  for (const s of [-1, 1]) {
    const back = P.list.find(([x, z]) => Math.sign(x) === s && z < 0);
    const front = P.list.find(([x, z]) => Math.sign(x) === s && z > 0);
    for (const h of P.heights) laser.segment([back[0], y0 + h, back[1]], [front[0], y0 + h, front[1]], P.thickness);
  }
  laserLink(b, laser, kit, [P.list[0][0], y0 + P.h, P.list[0][1]], [-B.topW / 2, roof, bz]);
  laserLink(b, laser, kit, [P.list[1][0], y0 + P.h, P.list[1][1]], [B.topW / 2, roof, bz]);
  safety(c);
};

// ---------------------------------------------------------------- rig geometry (animated; local space: ring centre at the origin)

const RIG_DETAIL = {
  gantry: {
    seg: 8, beamH: 0.5, beamD: 0.9, bandH: 0.18, bandOut: 0.02, neonH: 0.08,
    arm: { len: 2.0, w: 1.0, h: 0.5, markH: 0.8 },
    deck: { len: 1.8, w: 2.8, h: 0.2, drop: 0.35, rail: 0.1, railH: 0.6, overlap: 0.3 },
    hook: { r: 0.12, h: 1.7, block: 0.4 },
  },
  heavyGantry: {
    seg: 8, beamH: 1.0, beamD: 1.3, bandH: 0.25, bandOut: 0.02,
    arms: 3, arm: { len: 3.2, w: 1.5, h: 0.9 },
    claw: { len: 1.0, w: 1.6, h: 1.5 }, piston: { r: 0.26, len: 3.0, y: 0.75 }, spike: { h: 1.4, r: 0.34 }, bolts: 8, boltR: 0.07,
  },
  plasma: {
    rings: [{ r: 6.9, tube: 0.22, tilt: 0.14, y: 0, beads: 4 }, { r: 8.0, tube: 0.16, tilt: -0.2, y: 2.2, beads: 0 }],
    inner: { r: 6.3, tube: 0.18, tilt: 0.1, y: -1.8, trimTube: 0.07 },
    bead: { r: 0.45, halo: 1.05, ringHalo: 0.5 },
  },
  tractorBeam: {
    ringR: 7.3, tube: 0.16, seg: 8, heads: 3, head: { r: 0.7, stretch: 1.5, lensR: 0.14, lensH: 0.3, fin: 0.9 },
    beams: [-2.4, 0, 2.4], reach: 2.1, beamT: 0.06, haloTube: 0.11, rim: 0.4,
    upper: { r: 6.5, y: 3.0, tube: 0.1, nubs: 2, nubR: 0.2 },
  },
};

/** Octagonal ring of boxes at radius R (each box tangent to the ring) */
function ringOfBoxes(b, R, seg, h, d, s, y = 0) {
  const len = 2 * R * Math.tan(Math.PI / seg) + 0.1;
  for (let k = 0; k < seg; k++) {
    const phi = (k * TAU) / seg;
    b.box(len, h, d, s, { x: Math.sin(phi) * R, y, z: Math.cos(phi) * R, ry: phi });
  }
  return len;
}

/** gantry (style.crane 'gantry'): ring frame, team band, neon line, two ramp arms (±Z) with decks, rails and hooks */
function rigGantry(kit) {
  const D = RIG_DETAIL.gantry;
  const { S } = kit;
  const R = RIG.ringR;
  const b = new PartBuilder();
  const len = ringOfBoxes(b, R, D.seg, D.beamH, D.beamD, S.frame);
  for (let k = 0; k < D.seg; k++) {
    const phi = (k * TAU) / D.seg;
    const r = R + D.beamD / 2 + D.bandOut;
    b.box(len * 0.85, D.bandH, 0.05, S.team, { x: Math.sin(phi) * r, y: 0, z: Math.cos(phi) * r, ry: phi });
    if (kit.style.neon >= LAYOUT.neonMin) b.box(len * 0.8, D.neonH, 0.06, S.neon, { x: Math.sin(phi) * (R - D.beamD / 2), y: D.beamH / 2, z: Math.cos(phi) * (R - D.beamD / 2), ry: phi });
  }
  for (const e of [-1, 1]) {
    const zc = e * (R + D.arm.len / 2);
    b.box(D.arm.w, D.arm.h, D.arm.len, S.accent, { z: zc });
    for (const sx of [-1, 1]) marking(b, kit, D.arm.len, D.arm.markH, { ry: sx * HALF_PI, x: sx * (D.arm.w / 2 + 0.01), z: zc });   // faces ±X
    const dz = e * (R + D.arm.len + D.deck.len / 2 - D.deck.overlap);
    b.box(D.deck.w, D.deck.h, D.deck.len, S.hullDark, { y: -D.deck.drop, z: dz });
    for (const sx of [-1, 1]) {
      b.box(D.deck.rail, D.deck.rail, D.deck.len, S.accent, { x: sx * (D.deck.w / 2 - D.deck.rail / 2), y: -D.deck.drop + D.deck.railH, z: dz });
      b.box(D.deck.rail, D.deck.railH, D.deck.rail, S.frame, { base: true, x: sx * (D.deck.w / 2 - D.deck.rail / 2), y: -D.deck.drop, z: dz + e * D.deck.len * 0.4 });
    }
    // hook under the arm tip
    const hz = e * (R + D.arm.len * 0.8);
    b.cylinder(D.hook.r, D.hook.r, D.hook.h, 6, S.frame, { y: -D.arm.h / 2 - D.hook.h / 2, z: hz });
    b.box(D.hook.block, D.hook.block, D.hook.block, S.accent, { y: -D.arm.h / 2 - D.hook.h, z: hz });
  }
  return { a: b.build(), b: null, glow: null };
}

/** heavyGantry: thick ring with bolts, three hydraulic claw arms, pistons and spikes */
function rigHeavy(kit) {
  const D = RIG_DETAIL.heavyGantry;
  const { S } = kit;
  const R = RIG.ringR;
  const b = new PartBuilder();
  const len = ringOfBoxes(b, R, D.seg, D.beamH, D.beamD, S.hullDark);
  for (let k = 0; k < D.seg; k++) {
    const phi = (k * TAU) / D.seg;
    const r = R + D.beamD / 2 + D.bandOut;
    b.box(len * 0.8, D.bandH, 0.05, S.team, { x: Math.sin(phi) * r, y: 0, z: Math.cos(phi) * r, ry: phi });
    for (let i = 0; i < D.bolts / 2; i++) {
      b.cylinder(D.boltR, D.boltR, 0.1, 5, S.trim, { rz: HALF_PI, ry: phi - HALF_PI, x: Math.sin(phi) * (r + 0.04) + Math.cos(phi) * (i - 1.5) * 0.5, y: D.beamH * 0.3, z: Math.cos(phi) * (r + 0.04) - Math.sin(phi) * (i - 1.5) * 0.5 });
    }
  }
  for (let i = 0; i < D.arms; i++) {
    const phi = (i * TAU) / D.arms;
    const sx = Math.sin(phi);
    const cz = Math.cos(phi);
    const ry = phi - HALF_PI;   // box long axis (X) → radial direction
    const at = (r, y = 0) => ({ x: sx * r, y, z: cz * r, ry });
    b.box(D.arm.len, D.arm.h, D.arm.w, S.hullDark, at(R + D.arm.len / 2));
    b.box(D.claw.len, D.claw.h, D.claw.w, S.frame, at(R - D.claw.len / 2 - D.beamD / 2 + 0.2));
    b.cylinder(D.piston.r, D.piston.r, D.piston.len, 8, S.trim, { rz: HALF_PI, ry, x: sx * (R + D.arm.len / 2), y: D.piston.y, z: cz * (R + D.arm.len / 2) });
    spike(b, kit, { x: sx * (R + D.arm.len), y: D.arm.h / 2, z: cz * (R + D.arm.len), h: D.spike.h, r: D.spike.r });
  }
  return { a: b.build(), b: null, glow: null };
}

/** plasma: tilted levitating neon rings with plasma beads (halo → glow) and one inner counter-rotating ring */
function rigPlasma(kit) {
  const D = RIG_DETAIL.plasma;
  const { S } = kit;
  const b = new PartBuilder();
  const glow = new GlowSet().get('rig');
  for (const r of D.rings) {
    b.torus(r.r, r.tube, 6, 40, TAU, S.neon, { rx: HALF_PI + r.tilt, y: r.y });
    glow.torus(r.r, r.tube * 2.2, 4, 40, TAU, { rx: HALF_PI + r.tilt, y: r.y });
    for (let i = 0; i < r.beads; i++) {
      const a = (i / r.beads) * TAU;
      const x = Math.cos(a) * r.r;
      const z = Math.sin(a) * r.r;
      const y = r.y + Math.sin(a) * r.r * Math.sin(-r.tilt);
      b.sphere(D.bead.r, 10, 8, S.plasma, { x, y, z });
      glow.sphere(D.bead.halo, 8, 6, { x, y, z });
    }
  }
  const inner = new PartBuilder();
  const I = D.inner;
  inner.torus(I.r, I.tube, 6, 40, TAU, S.neon, { rx: HALF_PI + I.tilt, y: I.y });
  inner.torus(I.r, I.trimTube, 4, 40, TAU, S.trim, { rx: HALF_PI - I.tilt, y: I.y });
  return { a: b.build(), b: inner.build(), glow: glow.build() };
}

/** tractorBeam: slim ring with orbiting emitter heads; converging laser beams (glow) and a second thin ring above */
function rigLaser(kit) {
  const D = RIG_DETAIL.tractorBeam;
  const { S } = kit;
  const b = new PartBuilder();
  const glow = new GlowSet().get('rig');
  ringOfBoxes(b, D.ringR, D.seg, D.tube * 2, D.tube * 2, S.frame);
  glow.torus(D.ringR, D.haloTube, 4, 40, TAU, { rx: HALF_PI });
  for (let i = 0; i < D.heads; i++) {
    const a = (i * TAU) / D.heads;
    const x = Math.sin(a) * D.ringR;
    const z = Math.cos(a) * D.ringR;
    const g = new THREE.OctahedronGeometry(D.head.r, 0);
    g.scale(1, D.head.stretch, 1);
    b.add(g, S.trim, { x, z });
    const inward = D.ringR - D.head.r - D.head.lensH / 2;
    b.cylinder(D.head.lensR, D.head.lensR * 0.7, D.head.lensH, 8, S.lens, { rz: HALF_PI, ry: a - HALF_PI, x: Math.sin(a) * inward, z: Math.cos(a) * inward });
    spike(b, kit, { x, y: D.head.r * D.head.stretch, z, h: D.head.fin, r: 0.18 });
    for (const dy of D.beams) {
      const k = D.reach / D.ringR;
      glow.segment([Math.sin(a) * inward, 0, Math.cos(a) * inward], [x * k, dy, z * k], D.beamT);
    }
  }
  const upper = new PartBuilder();
  const U = D.upper;
  ringOfBoxes(upper, U.r, D.seg, U.tube * 2, U.tube * 2, S.frame, U.y);
  for (let i = 0; i < U.nubs; i++) {
    const a = (i * TAU) / U.nubs;
    upper.sphere(U.nubR, 8, 6, S.lens, { x: Math.sin(a) * U.r, y: U.y, z: Math.cos(a) * U.r });
  }
  return { a: b.build(), b: upper.build(), glow: glow.build() };
}

const RIG_BUILDERS = { gantry: rigGantry, heavyGantry: rigHeavy, plasma: rigPlasma, tractorBeam: rigLaser };

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const c = { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [] };
  turntable(c);
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbs = c.vents.filter((v) => v.ring);
  const rig = RIG_BUILDERS[rigKindOf(kit.style)](kit);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    rigA: rig.a,
    rigB: rig.b,
    rigGlow: rig.glow ?? null,
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbs.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbs.length ? ringGeometry(kit, orbs[0].ring.r) : null,
  };
}

const BAY_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class RobotAssemblyBayProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: BAY_CACHE, name: 'RobotAssemblyBayProc' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const kit = this.kit;
    const an = kit.style.anim;
    const A = BAY_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;
    const kind = RIG_KINDS[rigKindOf(kit.style)];

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.coreGlow = layer('core', gc.pulse, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);

    // rig: a lift group (height) carrying one or two turning rings; the first ring also carries its glow (lasers / plasma)
    this.lift = new THREE.Group();
    this.lift.position.set(0, LAYOUT.slabH, 0);
    this.add(this.lift);
    this.ringA = this.paintMesh(sh.rigA, this.lift);
    this.ringB = sh.rigB ? this.paintMesh(sh.rigB, this.lift) : null;
    this.rigGlow = sh.rigGlow ? this.glowLayer(sh.rigGlow, kit.style.crane === 'tractorBeam' ? gc.laser : gc.pulse, { parent: this.ringA, visible: false }) : null;
    this.kind = kind;
    this.speed = kind.speed * an.spin;
    this.step = an.jerk > 0 ? TAU / A.jerkTicks : 0;
    this.angle = seq * 0.5;
    this.ringA.rotation.y = this.angle;
    if (this.ringB) this.ringB.rotation.y = -this.angle;
    this.sweepT = 0;          // 0..2 triangle clock of the sweep
    this.progress = null;     // setProgress(): assembly progress 0..1 (null = the rig sweeps on its own)
    this.climb = 0;           // eased progress (rig height share while following setProgress)
    this.liftY = RIG.parkY;

    // fans (guarded / open) and plasma orb rings (style.fan 'none'), like MatterConverterProc
    this.fans = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.fan);
      mesh.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      mesh.rotation.y = (seq * 0.7 + i * 1.3) % TAU;
      this.fans.push({ mesh, speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1) });
    });
    const lev = PROC_MODULES.levitate;
    this.levitators = [];
    sh.orbSpots.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.orbRing);
      mesh.position.set(x, y, z);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });

    this.power = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Optional: assembly progress 0..1 of the mech in the bay (null = unknown / nothing assembled). With a number the rig
   * climbs along the robot as the hologram gets its parts (legs → torso → arms) instead of sweeping up and down by itself.
   * @param {number|null} p
   */
  setProgress(p) {
    this.progress = p == null ? null : Math.min(1, Math.max(0, p));
  }

  /**
   * Per-frame animation (no allocations). `active` = a mech is being assembled right now.
   * Idle: rig parked low around the turntable (plasma rings keep levitating slowly), fans idle, beacons burn steadily.
   * Active: the rig turns around the robot and travels along it, fans spin, glow / plasma / lasers / radiators wake up,
   * beacons blink; the glow pulses at the style's rate.
   * @param {number} delta seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = BAY_ANIM;
    const K = this.kind;
    this.time += delta;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    const p = this.power;

    // rig: turning (stepped when the style is jerky) and travelling along the robot
    this.angle += delta * this.speed * (K.idleSpin + (1 - K.idleSpin) * p);
    const turn = this.step > 0 ? Math.round(this.angle / this.step) * this.step : this.angle;
    this.ringA.rotation.y = turn;
    if (this.ringB) this.ringB.rotation.y = -turn * A.counterShare;
    let w;
    if (this.progress !== null && active) {
      this.climb += (this.progress - this.climb) * Math.min(1, delta * A.progressEase);
      w = this.step > 0 ? steppedEase(this.climb, A.jerkSteps) : smootherstep(this.climb);
    } else {
      if (active) this.sweepT = (this.sweepT + (delta * an.tempo * 2) / A.sweepPeriod) % 2;
      const tri = this.sweepT < 1 ? this.sweepT : 2 - this.sweepT;
      w = this.step > 0 ? steppedEase(tri, A.jerkSteps) : smootherstep(tri);
      this.climb = 0;
    }
    const bob = K.bob > 0 ? Math.sin(TAU * PROC_MODULES.levitate.freq * this.time) * K.bob * an.levitate : 0;
    this.liftY = RIG.parkY + (RIG.topY - RIG.parkY) * w * p;
    this.lift.position.y = LAYOUT.slabH + this.liftY + bob;

    // fans, orb rings
    const fanK = A.fanIdle + (1 - A.fanIdle) * p;
    for (let i = 0; i < this.fans.length; i++) this.fans[i].mesh.rotation.y += delta * this.fans[i].speed * fanK;
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);

    // glow: pulses; the plasma rig keeps a dim glow when idle, lasers only while working
    const pulse = pulseWave(this.time, an.pulse);
    const glow = pulse * (A.idleGlow + (1 - A.idleGlow) * p);
    this.coreGlow?.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.rigGlow?.setIntensity(pulse * (K.idleGlow + (1 - K.idleGlow) * p));
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
