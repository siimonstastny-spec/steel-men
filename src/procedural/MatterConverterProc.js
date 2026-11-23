// Steel Mans – procedural main building MatterConverter (roadmap 18, phase B). A drop-in alternative to
// models/3DStructures{race}/MatterConverter{race}_Anim.glb built in code from the style modules (ProcModules.js) and the
// faction style (data/buildingStyles.json):
//   • footprint inside the GLB's (ground box about ±27.3 × ±27.3, front = +Z where the gate and ramp are); pad ±26.6
//   • body per style.silhouette (rounded: stepped rounded halls · angular: armoured ziggurat with spikes · round: cylinder
//     hall + dome with a floating plasma orb · faceted: detached laser-linked blocks inside a laser barrier); the rest comes
//     from the style: edges, neon, lights, vents (fans / radiators / plasma orbs), industrial parts, markings, texture
//   • the converter: a visible central core (pillar cage + turning rotor + glowing halo + light shaft, or a plasma orb with a
//     gyroscope) that runs faster and brighter while the building is active, rings around it, and the faction emblem as the
//     roof dominant (extruded `emblemShape`) plus emblem decals on the front and on the flanks
//   • one merged static mesh per style + emblem decals (1 draw call) + glow layers + animated parts
// Visual only: update() takes the frame delta, nothing here is read by the simulation.
import * as THREE from 'three';
import { PartBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, pipeRun, tank, chimney, plasmaCoil, laserLink, arcGeometry, ArcFlicker, Levitator, emblemDecalGeometry, emblemShape,
  pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const CONVERTER_ANIM = {
  rotorSpeed: 2.4,        // rad/s of the core rotor at work (× style.anim.spin)
  rotorIdle: 0.16,        // share of the work speed while idle
  jerkTicks: 12,          // ticks per revolution of the rotor when style.anim.jerk > 0 (stepped, piston-like turning)
  fanSpeed: 4.5,          // rad/s at work (× style.anim.spin)
  fanIdle: 0.4,
  fanSpeedJitter: 0.25,
  radarSpeed: 0.7,        // rad/s (always)
  scannerSpeed: 1.4,      // rad/s (always)
  ringSpin: 0.9,          // rad/s of the rings (× style.anim.spin; Levitator slows down when idle)
  powerEase: 1.4,         // 1/s – how fast the building spins up / down
  idleGlow: 0.3,          // core / plasma / laser glow share while idle
  idleBeacon: 0.4,        // beacon intensity while idle (they blink while active)
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
  arcSeed: 4421,
};

/** Shared layout of every body (model units, GLB scale; front = +Z) */
const LAYOUT = {
  padHalf: 26.6, padH: 0.3,
  plinthHalf: 25, plinthH: 1.0, roundSegments: 40,
  padSegments: 64, padRing: { inset: 0.4, tube: 0.1, lift: 0.05, neonMin: 0.3 },   // circular pad (round style)
  rampLen: 1.6, rampW: 10.5,
  gate: {
    halfW: 4.6, h: 5.6, jambW: 1.0, jambD: 1.0, jambSink: 0.1, headerH: 1.2, interiorGap: 0.1, interiorT: 0.1, interiorOut: 0.12,
    markH: 0.5, markOut: 0.02, neonH: 0.12, neonT: 0.06, neonDrop: 0.15, apronH: 0.7, apronLift: 0.02,
    neonMin: 0.3,         // style.neon from which the header gets a neon line
    fillOverlap: 0.3,     // round hall: filler block between the curved wall and the gate (sunk into the wall by this much)
  },
  decalMargin: 0.1,       // bands leave this much free beside an emblem decal
  emblemDepth: 1.0,
  emblemPlate: { h: 0.8, d: 2.2, widthShare: 0.5, strutShare: 0.18, strutT: 0.5 },   // stand-up emblem: base plate + 2 struts
};

/** Small details shared by the heads (radar / scanner) */
const HEAD = { scale: 1.6, mastW: 1.6 };

/**
 * Dimensions of every body by style.silhouette (code knows shapes, the style data picks one; unknown → rounded).
 * Faces are described as walls (see wallOf); `core` is the converter cage, `rotor` the turning part inside, `rings`
 * horizontal neon rings (y relative to `core.y`, or to the orb for the round body), `emblem` the roof dominant.
 */
const DIM = {
  rounded: {
    // regular octagon (apothem = distance to a flat face, faces at k·45°, face 0 = +Z front with the gate)
    hall: { a: 21, h: 6 },
    tier: { a: 14.5, h: 4.2 },
    neonMin: 0.3,
    band: { y: 1.0, h: 0.5, share: 0.92, t: 0.05 },
    neonBand: { y: 4.9, h: 0.14, t: 0.06 },
    win: { y: 3.2, frameW: 3.4, frameH: 2.0, glassW: 3.0, glassH: 1.6, t: 0.06, glassOut: 0.02, faces: [1, 3, 5, 7] },
    tierWin: { y: 2.3, h: 0.9, share: 0.75, t: 0.06, out: 0.02 },
    decal: { faces: [2, 4, 6], size: 3.4, y: 3.1, tierSize: 3.2, tierY: 2.1 },   // flat walls; one more on the tier above the gate
    rail: { a: 20.5, h: 1.0, t: 0.1, postStep: 1 },
    cornerBeacons: { r: 18.6, angles: [45, 135, 225, 315] },                     // degrees
    vents: { r: 17.5, angles: [-146, -34, 34] }, ventR: 2.3,                      // degrees, polar on the hall roof
    head: { kind: 'radar', r: 17.5, angle: 146, mastH: 4.2 },
    tanks: [{ x: -5, len: 8 }, { x: 5, len: 8 }], tankZ: -16, tankR: 1.4, tankRise: 0.6,
    pipes: { x: 10.5, r: 0.3, outX: 9.2 },
    core: {
      r: 6.5, h: 6.5, baseH: 1.2, baseOver: 1.3, baseFlare: 0.5, floorH: 0.1, segments: 24, kind: 'round', pillars: 8, w: 0.45,
      capOver: 0.9, capH: 0.8, neonOut: 0.02, neonTube: 0.1, haloR: 0.82, haloSegments: 16, shaft: 9, shaftR: 0.3,
    },
    rotor: { kind: 'turbine', shaftR: 1.0, discs: 3, discR: 2.6, discH: 0.22, blades: 6, bladeLen: 3.6, bladeT: 0.12, bladeW: 0.6, spike: false },
    rings: [{ r: 5.0, dy: 1.9, tube: 0.16 }, { r: 5.0, dy: 4.5, tube: 0.16 }], ringAmp: 0,
    emblem: { mode: 'stand', size: 10, z: -9.5, lift: 1.8 },
  },
  angular: {
    block: { w: 46, h: 6 },
    slope: { w: 46, topW: 38, h: 3 },
    tier: { w: 29, topW: 21, h: 4.5 },
    neonMin: 0.3,
    buttress: { w: 2.2, h: 5.6, t: 1.4, y: 3.0, footW: 3.0, footH: 0.5, footT: 1.9, footY: 0.25, front: [-18, -12.5, 12.5, 18], side: [-18, -12, -6, 6, 12, 18] },
    lower: { y: 1.6, h: 2.6, w: 44, t: 0.05 },
    band: { y: 4.6, h: 0.5, w: 40, t: 0.06 },
    parapet: { half: 18.75, t: 0.5, h: 0.9, len: 38.5, spikeH: 1.2, spikeR: 0.3, mids: [-9.5, 0, 9.5] },
    slit: { y: 2.4, w: 18, h: 0.3, t: 0.05, out: 0.02, bandY: 0.8, bandH: 0.45, bandW: 26 },
    decal: { frontAlong: 8.2, frontSize: 4.2, sideSize: 6.5, y: 3.0 },
    corners: [[-22.3, -22.3], [22.3, -22.3], [-22.3, 22.3], [22.3, 22.3]], cornerLift: 0.6,   // on the sloped armour at the block roof edge
    vents: [[-16.4, -4], [16.4, 4]], ventR: 1.7,
    chimneys: [[-16.5, -16.5], [16.5, -16.5], [-16.5, 16.5], [16.5, 16.5]], chimneyH: 5.5, chimneyR: 0.9,
    head: { kind: 'radar', x: -16.4, z: 9.5, mastH: 4.0 },
    pipes: { x: 24.6, y: 3.2, z: 18, r: 0.45 },
    core: {
      r: 6.5, h: 6, baseH: 1.2, baseOver: 1.3, baseFlare: 0.6, floorH: 0.1, segments: 20, kind: 'slab', pillars: 6, w: 1.2,
      capOver: 1.0, capH: 0.9, neonOut: 0.02, neonTube: 0.1, haloR: 0.8, haloSegments: 14, shaft: 8, shaftR: 0.35, spikeH: 1.6, spikeR: 0.35,
    },
    rotor: { kind: 'turbine', shaftR: 1.3, discs: 3, discR: 3.0, discH: 0.3, blades: 6, bladeLen: 3.8, bladeT: 0.2, bladeW: 0.8, spike: true },
    rings: [{ r: 5.2, dy: 1.9, tube: 0.2 }, { r: 5.2, dy: 4.2, tube: 0.2 }], ringAmp: 0,
    emblem: { mode: 'stand', size: 11, z: -9, lift: 1.4 },
  },
  round: {
    hall: { r: 21, h: 6.2 }, drum: { r: 15.5, h: 3.8 }, dome: { sy: 0.32, segments: 32, rings: 12 },
    hallSegments: 40, drumSegments: 32,
    neonRing: { y: 4.8, h: 0.3, out: 0.05 },
    veins: { count: 24, w: 0.1, h: 4, y: 3.2, out: 0.04 },
    ribs: { count: 6, out: 0.05, tube: 0.22, radial: 4, tubular: 16 },
    pedestal: { rTop: 2.0, rBottom: 3.0, h: 1.6, segments: 16 },
    orb: { r: 3.6, sink: 0.5, halo: 1.45, shaft: 14, shaftR: 0.4 },
    coil: { r: 18.2, h: 3.2, coilR: 0.9, angles: [Math.PI * 0.2, Math.PI * 0.8] },   // two coils flank the gate (triangle budget)
    vents: { r: 18.2, angles: [0, Math.PI] }, ventR: 2.4,
    beacons: { r: 19, angles: [4.4, 5.0] },
    decal: { frontX: 9, frontSize: 4.5, sideSize: 6.5, y: 3.4 },
    gate: { apronZ: 23.3 },
    rotor: { kind: 'gyro', r: 5.0, tube: 0.16 },
    rings: [{ r: 6.6, dy: 0.4, tube: 0.12 }, { r: 8.2, dy: -2.2, tube: 0.12 }], ringAmp: 0.25,
    emblem: { mode: 'float', size: 9, x: 0, y: 22.5, z: -11.5, amp: 0.35 },
  },
  faceted: {
    stage: { r: 8.5, h: 1.2, segments: 16, neonOut: 0.05, neonTube: 0.08 },
    wing: { cx: 16.5, w: 8, topW: 5.2, h: 8.5, d: 22, neonT: 0.1, lensY: 4.0, lensZ: [-8, 8], lensS: 1.8, lensT: 0.12, neonS: 0.8, vents: [-6, 6], band: 6.2 },
    north: { cz: -15, w: 24, topW: 20, h: 7, d: 7, topD: 3.8, pylonX: -7, pylonW: 1.8, pylonH: 7, lasers: 4, laserR: 0.9, laserTopR: 0.4, headLift: 2.2 },
    ventR: 2.2,
    gate: { x: 6.3, z: 24.5, w: 2.6, topW: 0.9, h: 9, lensR: 0.3, lensH: 0.4, markH: 0.7 },
    posts: {
      half: 24.5, r: 0.22, rBottom: 0.4, h: 5.2, lensR: 0.28, heights: [0.9, 2.4, 3.9], thickness: 0.05,
      list: [[-24.5, -24.5], [0, -24.5], [24.5, -24.5], [-24.5, 0], [24.5, 0], [-24.5, 24.5], [24.5, 24.5]],
      links: [[0, 1], [1, 2], [0, 3], [3, 5], [2, 4], [4, 6]],   // + front: corner → gate pylon (added in code)
    },
    link: { x: 8.0, y: 5.0, z: [-5, 0, 5], pylonH: 5.4, pylonR: 0.25, lensR: 0.3 },
    decal: { wingY: 4.5, wingSize: 6, endY: 4.2, endSize: 5, northY: 3.2, northSize: 5.5 },
    core: {
      r: 5.5, h: 11, baseH: 1.0, baseOver: 1.2, baseFlare: 0.5, floorH: 0.1, segments: 16, kind: 'blade', pillars: 6, w: 3.2, d: 0.5,
      capOver: 0.8, capH: 0.7, neonOut: 0.02, neonTube: 0.08, haloR: 0.75, haloSegments: 12, shaft: 0, shaftR: 0.3,
    },
    rotor: { kind: 'crystal', size: 1.6, stretch: 2.2, discR: 2.6, discH: 0.12, discDy: 2.0, lensR: 0.2 },
    rings: [{ r: 3.4, dy: 2.2, tube: 0.1 }, { r: 3.4, dy: 6.2, tube: 0.1 }], ringAmp: 0.2,
    emblem: { mode: 'held', size: 9, gap: 3.3, beamR: 3.2, beamY: 0.2, thickness: 0.05 },
  },
};

const BODIES = {};   // filled below (silhouette → body function)

// ---------------------------------------------------------------- small helpers (construction time only)

const FACES = [{ nx: 0, nz: 1 }, { nx: 0, nz: -1 }, { nx: 1, nz: 0 }, { nx: -1, nz: 0 }];

/** Wall description: half sizes at the bottom, how much each face leans in over the height (run), centre offset */
const wallOf = (hx, hz, y0, h, runX = 0, runZ = runX, cx = 0, cz = 0) => ({ hx, hz, y0, h, runX, runZ, cx, cz });
const faceRun = (w, f) => (f.nz ? w.runZ : w.runX);
const faceHalf = (w, f, yRel) => (f.nz ? w.hz : w.hx) - (faceRun(w, f) * yRel) / w.h;

/** Flat detail on a wall face (follows the slope): along = position along the face, w × h its size, t thickness, out = standoff */
function faceBox(b, f, w, yRel, along, bw, bh, t, s, out = 0) {
  const tilt = Math.atan2(faceRun(w, f), w.h);
  const half = faceHalf(w, f, yRel) + t / 2 + out;
  const y = w.y0 + yRel;
  const rz = f.nx * tilt;
  const rx = -f.nz * tilt;
  if (f.nz) b.box(bw, bh, t, s, { x: w.cx + along, y, z: w.cz + f.nz * half, rx, rz });
  else b.box(t, bh, bw, s, { x: w.cx + f.nx * half, y, z: w.cz + along, rx, rz });
}

function faceDecal(c, f, w, yRel, along, size) {
  const tilt = Math.atan2(faceRun(w, f), w.h);
  const half = faceHalf(w, f, yRel);
  const y = w.y0 + yRel;
  c.decals.push({
    position: f.nz ? [w.cx + along, y, w.cz + f.nz * half] : [w.cx + f.nx * half, y, w.cz + along],
    normal: [f.nx * Math.cos(tilt), Math.sin(tilt), f.nz * Math.cos(tilt)],
    size,
  });
}

/** Decal on a cylinder wall at angle a (x = cos a, z = sin a), radius r */
function radialDecal(c, a, r, y, size) {
  c.decals.push({ position: [Math.cos(a) * r, y, Math.sin(a) * r], normal: [Math.cos(a), 0, Math.sin(a)], size });
}

// Regular octagon helpers (faces at k·45°, face 0 = +Z front; apothem = distance of a flat face from the axis)
const OCT_FACES = 8;
const OCT_STEP = TAU / OCT_FACES;
const octCircumR = (a) => a / Math.cos(OCT_STEP / 2);
const octFaceWidth = (a) => 2 * a * Math.tan(OCT_STEP / 2);

/** Octagonal prism with flat faces on the axes (origin on the axis, bottom at y0) */
function octPrism(b, a, h, s, y0) {
  const r = octCircumR(a);
  return b.cylinder(r, r, h, OCT_FACES, s, { y: y0 + h / 2, ry: OCT_STEP / 2 });
}

/** Flat detail on face k at height y: along = position along the face, bw × bh its size, t thickness, out = standoff */
function octBox(b, k, a, y, along, bw, bh, t, s, out = 0) {
  const phi = k * OCT_STEP;
  const d = a + t / 2 + out;
  return b.box(bw, bh, t, s, { x: Math.sin(phi) * d + Math.cos(phi) * along, y, z: Math.cos(phi) * d - Math.sin(phi) * along, ry: phi });
}

function octDecal(c, k, a, y, size) {
  const phi = k * OCT_STEP;
  c.decals.push({ position: [Math.sin(phi) * a, y, Math.cos(phi) * a], normal: [Math.sin(phi), 0, Math.cos(phi)], size });
}

/** Hand rail around an octagonal roof edge (safety style): top rail per face + posts at the corners */
function octRailing(c, R, y) {
  const { b, S } = c;
  const post = octCircumR(R.a);
  for (let k = 0; k < OCT_FACES; k++) {
    octBox(b, k, R.a - R.t / 2, y + R.h, 0, octFaceWidth(R.a), R.t, R.t, S.accent);
    const phi = (k + 0.5) * OCT_STEP;
    b.box(R.t, R.h, R.t, S.frame, { base: true, x: Math.sin(phi) * post, y, z: Math.cos(phi) * post, ry: phi });
  }
}

/** Pad, plinth ('box' / 'octagon' / 'round' / 'none') and the front ramp (+Z); round = circular pad with a neon ring */
function foundation(c, kind) {
  const L = LAYOUT;
  const { b, S, kit } = c;
  if (kind === 'round') {
    b.cylinder(L.padHalf, L.padHalf, L.padH, L.padSegments, S.ground, { y: L.padH / 2 });
    if (kit.style.neon >= L.padRing.neonMin) b.torus(L.padHalf - L.padRing.inset, L.padRing.tube, 4, L.padSegments, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + L.padRing.lift });
  } else if (kind === 'octagon') {
    octPrism(b, L.padHalf, L.padH, S.ground, 0);
    octPrism(b, L.plinthHalf, L.plinthH, S.hullDark, L.padH);
  } else {
    b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  }
  if (kind === 'box') b.box(L.plinthHalf * 2, L.plinthH, L.plinthHalf * 2, S.hullDark, { base: true, y: L.padH });
  if (kind === 'round') b.cylinder(L.plinthHalf, L.plinthHalf + 0.4, L.plinthH, L.roundSegments, S.hullDark, { y: L.padH + L.plinthH / 2 });
  if (kind !== 'none') b.wedge(L.rampLen, L.plinthH, L.rampW, S.lower, { y: L.padH, z: L.plinthHalf + L.rampLen / 2, ry: Math.PI / 2 });
}

/**
 * Band on a wall face (length centred, along the face) that leaves the emblem decals free: spans = [{ along, size, y }]
 * (decal centres / sizes, y relative to the wall like the band's yRel); only decals the band would cross cut it.
 */
function faceBand(b, f, w, yRel, length, bh, t, s, spans) {
  const gaps = spans.filter((d) => Math.abs(d.y - yRel) < (d.size + bh) / 2)
    .map((d) => [d.along - d.size / 2 - LAYOUT.decalMargin, d.along + d.size / 2 + LAYOUT.decalMargin]).sort((p, q) => p[0] - q[0]);
  let from = -length / 2;
  for (const [a, e] of [...gaps, [length / 2, length / 2]]) {
    if (a > from) faceBox(b, f, w, yRel, (from + a) / 2, a - from, bh, t, s);
    from = Math.max(from, e);
  }
}

/** Decal spans of a face for faceBand: front face = two (frontAlong), the others one (centre) */
const decalSpans = (f, d) => (f.nz === 1
  ? [-1, 1].map((k) => ({ along: k * d.frontAlong, size: d.frontSize, y: d.y }))
  : [{ along: 0, size: d.sideSize, y: d.y }]);

/**
 * Front gate in a wall face at z: interior glow, jambs with markings and beacons, header with a neon line, apron marking.
 * curved = the wall is a cylinder of radius z: a filler block closes the gap between the curve and the gate frame.
 */
function gate(c, z, y, apronZ, curved = false) {
  const G = LAYOUT.gate;
  const { b, S, kit, glows } = c;
  const zc = z + G.jambD / 2 - G.jambSink;
  if (curved) {
    const hx = G.halfW + G.jambW;
    const wallZ = Math.sqrt(Math.max(0, z * z - hx * hx)) - G.fillOverlap;
    b.box(hx * 2, G.h + G.headerH, z - wallZ, S.hull, { base: true, y, z: (wallZ + z) / 2 });
  }
  b.box(G.halfW * 2, G.h - G.interiorGap, G.interiorT, S.interior, { base: true, y, z: z + G.interiorOut });
  for (const side of [-1, 1]) {
    const x = side * (G.halfW + G.jambW / 2);
    b.box(G.jambW, G.h + G.headerH, G.jambD, S.frame, { base: true, x, y, z: zc });
    marking(b, kit, G.h, G.markH, { rz: Math.PI / 2, x, y: y + G.h / 2, z: zc + G.jambD / 2 + G.markOut });
    beacon(b, glows.get('beaconA'), kit, [x, y + G.h + G.headerH, zc]);
  }
  b.box(G.halfW * 2 + G.jambW * 2, G.headerH, G.jambD, S.frame, { base: true, y: y + G.h, z: zc });
  if (kit.style.neon >= G.neonMin) neonStrip(b, kit, G.halfW * 2, G.neonH, G.neonT, { y: y + G.h - G.neonDrop, z: zc + G.jambD / 2 - G.neonT });
  if (apronZ !== undefined) marking(b, kit, G.halfW * 2, G.apronH, { rx: -Math.PI / 2, y: y + G.apronLift, z: apronZ });
}

/** Hand rail around a square roof (safety style) */
function railing(c, half, y, R) {
  const { b, S } = c;
  const len = half * 2;
  for (const s of [-1, 1]) {
    b.box(R.t, R.t, len, S.accent, { x: s * half, y: y + R.h });
    b.box(len, R.t, R.t, S.accent, { y: y + R.h, z: s * half });
    for (let i = -half; i <= half + 0.01; i += R.step) {
      b.box(R.t, R.h, R.t, S.frame, { base: true, x: s * half, y, z: i });
      b.box(R.t, R.h, R.t, S.frame, { base: true, x: i, y, z: s * half });
    }
  }
}

/** Vent units at [x, z] on roofs of height y (fans / radiators / plasma orbs by style) */
function vents(c, list, y, r) {
  for (const [x, z, yy] of list) c.vents.push(ventUnit(c.b, c.glows, c.kit, { x, y: yy ?? y, z, r }));
}

/** Mast with a turning head (radar / scanner) standing at [x, y, z] */
function headMast(c, { kind, x, z, mastH }, y) {
  const { b, S } = c;
  b.box(HEAD.mastW, mastH, HEAD.mastW, S.hullDark, { base: true, x, y, z });
  c.head = { kind, x, y: y + mastH, z };
}

/** The converter: base ring, pillar cage, cap with a neon ring, glow halo and light shaft. Sets c.rotorAt / c.pillarH. */
function core(c, D, coreY) {
  const { b, S, kit, glows } = c;
  const C = D.core;
  const top = coreY + C.h;
  const base = coreY + C.baseH;
  const ph = C.h - C.baseH - C.capH;
  b.cylinder(C.r + C.baseOver, C.r + C.baseOver + C.baseFlare, C.baseH, C.segments, S.hullDark, { y: coreY + C.baseH / 2 });
  b.cylinder(C.r - 0.4, C.r - 0.4, C.floorH, C.segments, S.plasma, { y: base + C.floorH / 2 });
  for (let i = 0; i < C.pillars; i++) {
    const a = (i / C.pillars) * TAU;
    const x = Math.cos(a) * C.r;
    const z = Math.sin(a) * C.r;
    if (C.kind === 'slab') {
      b.box(C.w, ph, C.w * 1.8, S.hullDark, { base: true, x, y: base, z, ry: -a });
      spike(b, kit, { x, y: base + ph, z, h: C.spikeH, r: C.spikeR });
    } else if (C.kind === 'blade') {
      b.taperedBox(C.w, C.w * 0.15, ph, C.d, S.hullDark, { x, y: base, z, ry: -a });
    } else {
      b.cylinder(C.w, C.w, ph, 10, S.frame, { x, y: base + ph / 2, z });
    }
  }
  b.cylinder(C.r + C.capOver, C.r + C.capOver, C.capH, C.segments, S.frame, { y: top - C.capH / 2 });
  b.torus(C.r + C.capOver + C.neonOut, C.neonTube, 4, C.segments * 2, TAU, S.neon, { rx: Math.PI / 2, y: top - C.capH });
  glows.get('core').cylinder(C.r * C.haloR, C.r * C.haloR, ph, C.haloSegments, { y: base + ph / 2 });
  if (C.shaft) glows.get('core').cylinder(C.shaftR, C.shaftR, C.shaft, 8, { y: top + C.shaft / 2 });
  c.rotorAt = [0, base + ph / 2, 0];
  c.pillarH = ph;
}

/** Stand-up / held emblem as an extruded roof dominant (static, team colour); float → separate mesh data */
function emblemPiece(c, E, surfaceY) {
  const L = LAYOUT;
  const { b, S, kit } = c;
  if (E.mode === 'float') {
    const eb = new PartBuilder();
    eb.add(emblemShape(kit.key, L.emblemDepth, E.size), S.team);
    c.floatEmblem = { geometry: eb.build(), x: E.x, y: E.y, z: E.z, amp: E.amp };
    return;
  }
  if (E.mode === 'held') {
    const cy = surfaceY + E.gap + E.size / 2;
    b.add(emblemShape(kit.key, L.emblemDepth, E.size), S.team, { y: cy });
    c.emblemCenter = cy;
    return;
  }
  const P = L.emblemPlate;
  const cy = surfaceY + E.lift + E.size / 2;
  b.box(E.size * P.widthShare, P.h, P.d, S.hullDark, { base: true, y: surfaceY, z: E.z });
  for (const s of [-1, 1]) b.box(P.strutT, E.lift - P.h + 0.2, P.strutT, S.frame, { base: true, x: s * E.size * P.strutShare, y: surfaceY + P.h, z: E.z });
  b.add(emblemShape(kit.key, L.emblemDepth, E.size), S.team, { y: cy, z: E.z });
  c.emblemCenter = cy;
}

// ---------------------------------------------------------------- bodies
/** rounded: octagonal stepped halls, windows, octagonal guard rail, tanks and pipes, fan roof, radar, stand-up emblem */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit, glows } = c;
  const y1 = LAYOUT.padH + LAYOUT.plinthH;
  foundation(c, 'octagon');
  const y2 = y1 + D.hall.h;
  const y3 = y2 + D.tier.h;
  octPrism(b, D.hall.a, D.hall.h, S.hull, y1);
  octPrism(b, D.tier.a, D.tier.h, S.hull, y2);
  const neonBands = kit.style.neon >= D.neonMin;
  const Wn = D.win;
  for (let k = 0; k < OCT_FACES; k++) {
    const hallW = octFaceWidth(D.hall.a);
    octBox(b, k, D.hall.a, y1 + D.band.y, 0, hallW * D.band.share, D.band.h, D.band.t, S.team);
    if (neonBands) octBox(b, k, D.hall.a, y1 + D.neonBand.y, 0, hallW * D.band.share, D.neonBand.h, D.neonBand.t, S.neon);
    if (Wn.faces.includes(k)) {
      octBox(b, k, D.hall.a, y1 + Wn.y, 0, Wn.frameW, Wn.frameH, Wn.t, S.frame);
      octBox(b, k, D.hall.a, y1 + Wn.y, 0, Wn.glassW, Wn.glassH, Wn.t, S.window, Wn.glassOut);
    }
    if (k !== 0) octBox(b, k, D.tier.a, y2 + D.tierWin.y, 0, octFaceWidth(D.tier.a) * D.tierWin.share, D.tierWin.h, D.tierWin.t, S.window, D.tierWin.out);
    if (D.decal.faces.includes(k)) octDecal(c, k, D.hall.a, y1 + D.decal.y, D.decal.size);
  }
  octDecal(c, 0, D.tier.a, y2 + D.decal.tierY, D.decal.tierSize);   // flat tier wall above the gate
  if (kit.style.markings === 'hazard') octRailing(c, D.rail, y2);
  for (const deg of D.cornerBeacons.angles) {
    const a = (deg * Math.PI) / 180;
    beacon(b, glows.get('beaconA'), kit, [Math.sin(a) * D.cornerBeacons.r, y2, Math.cos(a) * D.cornerBeacons.r]);
  }
  gate(c, D.hall.a, y1, D.hall.a + LAYOUT.gate.jambD + 0.9);

  const polar = (r, deg) => [Math.sin((deg * Math.PI) / 180) * r, Math.cos((deg * Math.PI) / 180) * r];
  for (const deg of D.vents.angles) { const [x, z] = polar(D.vents.r, deg); c.vents.push(ventUnit(b, c.glows, kit, { x, y: y2, z, r: D.ventR })); }
  const [hx, hz] = polar(D.head.r, D.head.angle);
  headMast(c, { kind: D.head.kind, x: hx, z: hz, mastH: D.head.mastH }, y2);
  const tankY = y2 + D.tankRise + D.tankR;
  for (const t of D.tanks) tank(b, kit, { x: t.x, y: tankY, z: D.tankZ, r: D.tankR, len: t.len, floorY: y2 });
  for (const s of [-1, 1]) {
    pipeRun(b, kit, [[s * D.pipes.outX, tankY, D.tankZ], [s * D.pipes.x, tankY, D.tankZ], [s * D.pipes.x, y2, D.tankZ]], D.pipes.r);
  }

  core(c, D, y3);
  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, y: y3 + r.dy, amp: D.ringAmp });
  emblemPiece(c, D.emblem, y3);
};

/** angular: armoured ziggurat – buttressed block, sloped armour, spiked parapet, slit tier, chimneys, open fans */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit, glows } = c;
  const y1 = LAYOUT.padH + LAYOUT.plinthH;
  foundation(c, 'box');
  const bh = D.block.w / 2;
  const y2 = y1 + D.block.h;
  const y3 = y2 + D.slope.h;
  const y4 = y3 + D.tier.h;
  b.box(D.block.w, D.block.h, D.block.w, S.hull, { base: true, y: y1 });
  b.taperedBox(D.slope.w, D.slope.topW, D.slope.h, D.slope.w, S.hull, { y: y2 }, D.slope.topW);
  b.taperedBox(D.tier.w, D.tier.topW, D.tier.h, D.tier.w, S.hull, { y: y3 }, D.tier.topW);
  const wb = wallOf(bh, bh, y1, D.block.h);
  const w2 = wallOf(D.tier.w / 2, D.tier.w / 2, y3, D.tier.h, (D.tier.w - D.tier.topW) / 2);
  const Bt = D.buttress;
  for (const f of FACES) {
    const spans = decalSpans(f, D.decal);
    faceBand(b, f, wb, D.lower.y, D.lower.w, D.lower.h, D.lower.t, S.lower, spans);
    for (const along of (f.nz === 1 ? Bt.front : Bt.side)) {
      faceBox(b, f, wb, Bt.y, along, Bt.w, Bt.h, Bt.t, S.hullDark);
      faceBox(b, f, wb, Bt.footY, along, Bt.footW, Bt.footH, Bt.footT, S.frame);
    }
    faceBand(b, f, wb, D.band.y, D.band.w, D.band.h, D.band.t, S.team, spans);
    faceBox(b, f, w2, D.slit.y, 0, D.slit.w, D.slit.h, D.slit.t, S.window, D.slit.out);
    faceBox(b, f, w2, D.slit.bandY, 0, D.slit.bandW, D.slit.bandH, D.slit.t, S.team);
    if (f.nz === 1) for (const s of [-1, 1]) faceDecal(c, f, wb, D.decal.y, s * D.decal.frontAlong, D.decal.frontSize);
    else faceDecal(c, f, wb, D.decal.y, 0, D.decal.sideSize);
  }
  const Pp = D.parapet;
  for (const s of [-1, 1]) {
    b.box(Pp.t, Pp.h, Pp.len, S.hullDark, { base: true, x: s * Pp.half, y: y3 });
    b.box(Pp.len, Pp.h, Pp.t, S.hullDark, { base: true, y: y3, z: s * Pp.half });
    for (const e of [-1, 1]) spike(b, kit, { x: s * Pp.half, y: y3 + Pp.h, z: e * Pp.half, h: Pp.spikeH, r: Pp.spikeR });
    for (const m of Pp.mids) {
      spike(b, kit, { x: s * Pp.half, y: y3 + Pp.h, z: m, h: Pp.spikeH * 0.7, r: Pp.spikeR });
      spike(b, kit, { x: m, y: y3 + Pp.h, z: s * Pp.half, h: Pp.spikeH * 0.7, r: Pp.spikeR });
    }
  }
  for (const [x, z] of D.corners) beacon(b, glows.get('beaconA'), kit, [x, y2 + D.cornerLift, z]);
  gate(c, bh, y1, LAYOUT.plinthHalf - 0.5);

  vents(c, D.vents, y3, D.ventR);
  for (const [x, z] of D.chimneys) chimney(b, kit, { x, y: y3, z, h: D.chimneyH, r: D.chimneyR });
  headMast(c, D.head, y3);
  for (const s of [-1, 1]) pipeRun(b, kit, [[s * D.pipes.x, D.pipes.y, -D.pipes.z], [s * D.pipes.x, D.pipes.y, D.pipes.z]], D.pipes.r);

  core(c, D, y4);
  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, y: y4 + r.dy, amp: D.ringAmp });
  emblemPiece(c, D.emblem, y4);
};

/** round: cylinder hall, drum and ribbed dome with a floating plasma orb and a gyroscope, plasma coils with arcs */
BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const y1 = LAYOUT.padH + LAYOUT.plinthH;
  foundation(c, 'round');
  const R = D.hall.r;
  const y2 = y1 + D.hall.h;
  const y3 = y2 + D.drum.h;
  b.cylinder(R, R, D.hall.h, D.hallSegments, S.hull, { y: y1 + D.hall.h / 2 });
  b.cylinder(D.drum.r, D.drum.r, D.drum.h, D.drumSegments, S.hull, { y: y2 + D.drum.h / 2 });
  b.add(new THREE.SphereGeometry(D.drum.r, D.dome.segments, D.dome.rings, 0, TAU, 0, Math.PI / 2), S.hull, { y: y3, sy: D.dome.sy });
  const k = D.dome.sy;
  const peak = y3 + D.drum.r * k;
  const K = D.ribs;
  for (let i = 0; i < K.count; i++) {
    b.torus(D.drum.r + K.out, K.tube, K.radial, K.tubular, Math.PI, S.hullDark, { ry: (i / K.count) * Math.PI, sy: k, y: y3 });
  }
  const N = D.neonRing;
  b.cylinder(R + N.out, R + N.out, N.h, D.hallSegments, S.neon, { y: y1 + N.y }, true);
  b.cylinder(D.drum.r + N.out, D.drum.r + N.out, N.h, D.drumSegments, S.neon, { y: y2 + D.drum.h / 2 }, true);
  if (kit.rich) {
    const V = D.veins;
    for (let i = 0; i < V.count; i++) {
      const a = (i / V.count) * TAU;
      neonStrip(b, kit, V.w, V.h, V.w, { x: Math.cos(a) * (R + V.out), y: y1 + V.y, z: Math.sin(a) * (R + V.out), ry: -a });
    }
  }
  const fa = Math.acos(D.decal.frontX / R);
  radialDecal(c, fa, R, y1 + D.decal.y, D.decal.frontSize);
  radialDecal(c, Math.PI - fa, R, y1 + D.decal.y, D.decal.frontSize);
  radialDecal(c, 0, R, y1 + D.decal.y, D.decal.sideSize);
  radialDecal(c, Math.PI, R, y1 + D.decal.y, D.decal.sideSize);
  radialDecal(c, -Math.PI / 2, R, y1 + D.decal.y, D.decal.sideSize);
  gate(c, R, y1, D.gate.apronZ, true);
  for (const a of D.beacons.angles) beacon(b, glows.get('beaconA'), kit, [Math.cos(a) * D.beacons.r, y2, Math.sin(a) * D.beacons.r]);

  // plasma orb on the dome (the converter core), cradle pedestal, halo and a light shaft
  const P = D.pedestal;
  b.cylinder(P.rTop, P.rBottom, P.h, P.segments, S.hullDark, { y: peak + P.h / 2 });
  const O = D.orb;
  const oy = peak + P.h + O.r - O.sink;
  b.sphere(O.r, 20, 14, S.plasma, { y: oy });
  glows.get('core').sphere(O.r * O.halo, 16, 10, { y: oy });
  glows.get('core').cylinder(O.shaftR, O.shaftR, O.shaft, 8, { y: oy + O.r + O.shaft / 2 });
  c.rotorAt = [0, oy, 0];

  // coils on the hall roof ring with arcs to the orb, orbs on rings between them
  const C = D.coil;
  for (const a of C.angles) {
    const top = plasmaCoil(b, glows.get('pulse'), kit, { x: Math.cos(a) * C.r, y: y2, z: Math.sin(a) * C.r, h: C.h, r: C.coilR });
    const dx = top[0];
    const dy = top[1] - oy;
    const dz = top[2];
    const len = Math.hypot(dx, dy, dz);
    c.arcPairs.push([top, [(dx / len) * O.r, oy + (dy / len) * O.r, (dz / len) * O.r]]);
  }
  c.vents.push(...D.vents.angles.map((a) => ventUnit(b, c.glows, kit, { x: Math.cos(a) * D.vents.r, y: y2, z: Math.sin(a) * D.vents.r, r: D.ventR })));

  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, y: oy + r.dy, amp: D.ringAmp });
  emblemPiece(c, D.emblem, 0);
};

/** faceted: detached wings and a pylon wing linked to the exposed core by lasers, laser barrier, held emblem */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const laser = glows.get('laser');
  foundation(c, 'none');
  const y0 = L.padH;
  const St = D.stage;
  b.cylinder(St.r, St.r, St.h, St.segments, S.hullDark, { y: y0 + St.h / 2 });
  b.torus(St.r + St.neonOut, St.neonTube, 4, St.segments * 2, TAU, S.neon, { rx: Math.PI / 2, y: y0 + St.h });

  // east / west wings (radiators on top, diamond lens plates on the outer face)
  const Wg = D.wing;
  for (const side of [-1, 1]) {
    const cx = side * Wg.cx;
    b.taperedBox(Wg.w, Wg.topW, Wg.h, Wg.d, S.hull, { x: cx, y: y0 }, Wg.d);
    const wall = wallOf(Wg.w / 2, Wg.d / 2, y0, Wg.h, (Wg.w - Wg.topW) / 2, 0, cx, 0);
    const out = FACES.find((f) => f.nx === side);
    faceBand(b, out, wall, Wg.band, Wg.d - 2, 0.5, 0.05, S.team, [{ along: 0, size: D.decal.wingSize, y: D.decal.wingY }]);
    for (const z of Wg.lensZ) {
      const lx = cx + side * (faceHalf(wall, out, Wg.lensY) + Wg.lensT / 2);
      b.box(Wg.lensT, Wg.lensS, Wg.lensS, S.hullDark, { x: lx, y: y0 + Wg.lensY, z, rx: Math.PI / 4 });
      b.box(Wg.lensT * 0.5, Wg.neonS, Wg.neonS, S.neon, { x: lx + side * Wg.lensT * 0.75, y: y0 + Wg.lensY, z, rx: Math.PI / 4 });
    }
    for (const e of [-1, 1]) neonStrip(b, kit, Wg.neonT, Wg.neonT, Wg.d, { x: cx + e * Wg.topW / 2, y: y0 + Wg.h + Wg.neonT / 2 });
    vents(c, Wg.vents.map((z) => [cx, z]), y0 + Wg.h, D.ventR);
    faceDecal(c, out, wall, D.decal.wingY, 0, D.decal.wingSize);
    faceDecal(c, FACES[0], wall, D.decal.endY, 0, D.decal.endSize);
  }

  // north wing with a pylon and the scanner head (held by lasers)
  const N = D.north;
  b.taperedBox(N.w, N.topW, N.h, N.d, S.hull, { z: N.cz, y: y0 }, N.topD);
  const wn = wallOf(N.w / 2, N.d / 2, y0, N.h, (N.w - N.topW) / 2, (N.d - N.topD) / 2, 0, N.cz);
  faceDecal(c, FACES[1], wn, D.decal.northY, 0, D.decal.northSize);
  faceBand(b, FACES[1], wn, N.h - 1.2, N.w - 2, 0.5, 0.05, S.team, [{ along: 0, size: D.decal.northSize, y: D.decal.northY }]);
  neonStrip(b, kit, N.topW, Wg.neonT, Wg.neonT, { y: y0 + N.h + Wg.neonT / 2, z: N.cz + N.topD / 2 });
  const pTop = y0 + N.h + N.pylonH;
  styledBox(b, kit, N.pylonW, N.pylonH, N.pylonW, S.hullDark, { base: true, x: N.pylonX, y: y0 + N.h, z: N.cz, ry: Math.PI / 4 });
  const headY = pTop + N.headLift;
  for (let i = 0; i < N.lasers; i++) {
    const a = (i * TAU) / N.lasers;
    laserLink(b, laser, kit, [N.pylonX + Math.cos(a) * N.laserR, pTop, N.cz + Math.sin(a) * N.laserR],
      [N.pylonX + Math.cos(a) * N.laserTopR, headY - N.headLift * 0.5, N.cz + Math.sin(a) * N.laserTopR]);
  }
  c.head = { kind: 'scanner', x: N.pylonX, y: headY, z: N.cz };

  // laser links between the stage emitters and the wings
  const Ln = D.link;
  for (const side of [-1, 1]) {
    for (const z of Ln.z) {
      b.cylinder(Ln.pylonR, Ln.pylonR * 1.5, Ln.pylonH, 6, S.hullDark, { x: side * Ln.x, y: y0 + Ln.pylonH / 2, z });
      const wallX = Wg.cx - (Wg.w / 2 - ((Wg.w - Wg.topW) / 2) * ((Ln.y - y0) / Wg.h));
      laserLink(b, laser, kit, [side * Ln.x, Ln.y, z], [side * wallX, Ln.y, z]);
    }
  }

  // front gate pylons (the barrier opens here) and the laser barrier around the pad
  const G = D.gate;
  for (const side of [-1, 1]) {
    const x = side * G.x;
    b.taperedBox(G.w, G.topW, G.h, G.w, S.hullDark, { x, y: y0, z: G.z });
    b.cylinder(G.lensR, G.lensR * 0.7, G.lensH, 10, S.lens, { x, y: y0 + G.h + G.lensH / 2, z: G.z });
    beacon(b, glows.get('beaconA'), kit, [x, y0 + G.h + G.lensH, G.z]);
  }
  marking(b, kit, G.x * 2 - G.w, G.markH, { rx: -Math.PI / 2, y: y0 + L.gate.apronLift, z: G.z });
  const Po = D.posts;
  const pts = [...Po.list];
  for (const p of pts) {
    b.cylinder(Po.r, Po.rBottom, Po.h, 6, S.hullDark, { x: p[0], y: y0 + Po.h / 2, z: p[1] });
    b.sphere(Po.lensR, 8, 6, S.lens, { x: p[0], y: y0 + Po.h, z: p[1] });
  }
  const links = [...Po.links.map(([i, j]) => [pts[i], pts[j]]), [pts[5], [-G.x, G.z]], [pts[6], [G.x, G.z]]];
  for (const [p, q] of links) {
    for (const y of Po.heights) laser.segment([p[0], y0 + y, p[1]], [q[0], y0 + y, q[1]], Po.thickness);
  }

  // the converter: exposed blade cage on the stage with a crystal rotor; the emblem is held above it by four beams
  const coreY = y0 + St.h;
  core(c, D, coreY);
  const top = coreY + D.core.h;
  emblemPiece(c, D.emblem, top);
  const E = D.emblem;
  const bottom = c.emblemCenter - E.size / 2;
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + Math.PI / 4;
    laser.segment([Math.cos(a) * E.beamR, top + E.beamY, Math.sin(a) * E.beamR], [0, bottom + E.size * 0.04, 0], E.thickness);
  }
  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, y: coreY + r.dy, amp: D.ringAmp });
};

// ---------------------------------------------------------------- animated parts

/** Core rotor (shared geometry, origin at its centre) */
function buildRotor(kit, D, ph) {
  const S = kit.S;
  const R = D.rotor;
  const b = new PartBuilder();
  if (R.kind === 'gyro') {
    b.torus(R.r, R.tube, 6, 28, TAU, S.trim, { rx: Math.PI / 2 });
    b.torus(R.r, R.tube, 6, 28, TAU, S.trim, {});
    b.torus(R.r, R.tube, 6, 28, TAU, S.trim, { ry: Math.PI / 2 });
  } else if (R.kind === 'crystal') {
    const g = new THREE.OctahedronGeometry(R.size, 0);
    g.scale(1, R.stretch, 1);
    b.add(g, S.plasma);
    for (const s of [-1, 1]) b.box(R.discR * 2, R.discH, R.discR * 2, S.trim, { y: s * R.discDy, ry: Math.PI / 4 });
    b.cylinder(R.lensR, R.lensR, R.lensR * 2, 8, S.lens, { x: R.discR + R.lensR, rz: Math.PI / 2 });
  } else {
    b.cylinder(R.shaftR, R.shaftR, ph * 0.92, 10, S.plasma);
    const step = R.discs > 1 ? (ph * 0.7) / (R.discs - 1) : 0;
    for (let i = 0; i < R.discs; i++) {
      const y = (i - (R.discs - 1) / 2) * step;
      b.cylinder(R.discR, R.discR, R.discH, 16, S.trim, { y });
      for (let k = 0; k < R.blades; k++) {
        const a = (k / R.blades) * TAU + i * 0.4;
        const cx = Math.cos(a);
        const cz = Math.sin(a);
        b.box(R.bladeLen, R.bladeT, R.bladeW, S.hullDark, { x: (cx * R.bladeLen) / 2, y, z: (cz * R.bladeLen) / 2, ry: -a });
        if (R.spike) spike(b, kit, { x: cx * R.bladeLen, y: y + R.bladeT / 2, z: cz * R.bladeLen, h: 0.9, r: 0.3 });
      }
    }
  }
  return b.build();
}

/** Radar dish / floating crystal scanner (turn around Y), origin at the mast top */
function buildHead(kit, kind) {
  const S = kit.S;
  const k = HEAD.scale;
  const b = new PartBuilder();
  if (kind === 'radar') {
    const tiltX = Math.PI / 2 - 0.4;
    b.cylinder(0.35 * k, 0.35 * k, 0.2 * k, 12, S.frame, { y: 0.1 * k });
    b.box(0.3 * k, 0.6 * k, 0.3 * k, S.hullDark, { y: 0.5 * k });
    b.cylinder(1.0 * k, 0.15 * k, 0.35 * k, 16, S.trim, { rx: tiltX, y: 0.9 * k, z: 0.15 * k });
    b.cylinder(0.03 * k, 0.03 * k, 1.0 * k, 6, S.frame, { rx: tiltX, y: (0.9 + Math.cos(tiltX) * 0.5) * k, z: (0.15 + Math.sin(tiltX) * 0.5) * k });
    b.box(0.5 * k, 0.4 * k, 0.3 * k, S.hullDark, { y: 0.85 * k, z: -0.5 * k });
    b.box(0.2 * k, 0.1 * k, 0.05 * k, S.team, { y: 1.0 * k, z: -0.66 * k });
  } else {
    const g = new THREE.OctahedronGeometry(0.55 * k, 0);
    g.scale(1, 1.6, 1);
    b.add(g, S.trim);
    b.box(1.4 * k, 0.06 * k, 0.06 * k, S.neon);
    b.cylinder(0.12 * k, 0.12 * k, 0.2 * k, 8, S.lens, { x: 0.75 * k, rz: Math.PI / 2 });
  }
  return b.build();
}

/** Turning part that speeds up with the building's power (idle share → full), optionally in stepped ticks (jerk) */
class RotorDrive {
  constructor(object, { speed, idle, step = 0, phase = 0 }) {
    this.object = object;
    this.speed = speed;
    this.idle = idle;
    this.step = step;
    this.angle = phase;
    object.rotation.y = phase;
  }

  update(delta, power) {
    this.angle += delta * this.speed * (this.idle + (1 - this.idle) * power);
    this.object.rotation.y = this.step > 0 ? Math.round(this.angle / this.step) * this.step : this.angle;
  }
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const D = DIM[sil];
  const c = {
    kit, S: kit.S, st: kit.style, b: new PartBuilder(), glows: new GlowSet(),
    decals: [], vents: [], arcPairs: [], rings: [], head: null, rotorAt: [0, 0, 0], pillarH: 1, floatEmblem: null, emblemCenter: 0,
  };
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbRings = c.vents.filter((v) => v.ring);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    rotor: buildRotor(kit, D, c.pillarH),
    rotorAt: c.rotorAt,
    rings: c.rings.map((r) => ({ geometry: ringGeometry(kit, r.r, r.tube), y: r.y, amp: r.amp })),
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbRings.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbRings.length ? ringGeometry(kit, orbRings[0].ring.r) : null,
    head: c.head ? { ...c.head, geometry: buildHead(kit, c.head.kind) } : null,
    arcs: c.arcPairs.length ? arcGeometry(c.arcPairs, CONVERTER_ANIM.arcSeed) : null,
    floatEmblem: c.floatEmblem,
  };
}

const CONVERTER_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class MatterConverterProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CONVERTER_CACHE, name: 'MatterConverterProc' });
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
    const A = CONVERTER_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.coreGlow = layer('core', gc.pulse, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);
    this.arcs = null;
    if (sh.arcs) {
      const arcLayer = this.glowLayer(this.instanceGeometry(sh.arcs.geometry), gc.arc, { visible: false });
      this.arcs = new ArcFlicker(arcLayer, sh.arcs.ranges, { seed: A.arcSeed + seq });
    }

    this.drives = [];
    // core rotor (stepped ticks when the style is jerky)
    const rotor = this.paintMesh(sh.rotor);
    rotor.position.set(sh.rotorAt[0], sh.rotorAt[1], sh.rotorAt[2]);
    const step = an.jerk > 0 ? TAU / A.jerkTicks : 0;
    this.drives.push(new RotorDrive(rotor, { speed: A.rotorSpeed * an.spin, idle: A.rotorIdle, step, phase: seq * 0.5 }));
    // fans
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      this.drives.push(new RotorDrive(fan, {
        speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), idle: A.fanIdle, phase: (seq * 0.7 + i * 1.3) % TAU,
      }));
    });
    // radar / scanner head (always the same speed)
    if (sh.head) {
      const head = this.paintMesh(sh.head.geometry);
      head.position.set(sh.head.x, sh.head.y, sh.head.z);
      this.drives.push(new RotorDrive(head, {
        speed: (sh.head.kind === 'radar' ? A.radarSpeed : A.scannerSpeed) * an.spin, idle: 1, phase: seq * 0.9,
      }));
    }
    // rings around the core (fixed height, spinning – or floating) and rings over plasma orbs
    const lev = PROC_MODULES.levitate;
    this.levitators = [];
    sh.rings.forEach((r, i) => {
      const mesh = this.paintMesh(r.geometry);
      mesh.position.set(sh.rotorAt[0], r.y, sh.rotorAt[2]);
      this.levitators.push(new Levitator(mesh, { amp: r.amp * an.levitate, spin: A.ringSpin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });
    sh.orbSpots.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.orbRing);
      mesh.position.set(x, y, z);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });
    // floating emblem (no spin: it faces the front)
    if (sh.floatEmblem) {
      const e = sh.floatEmblem;
      const mesh = this.paintMesh(e.geometry);
      mesh.position.set(e.x, e.y, e.z);
      this.levitators.push(new Levitator(mesh, { amp: e.amp * an.levitate, spin: 0, phase: seq * 0.6 }));
    }

    this.power = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). Always: radar / scanner turn, rings and rotor idle slowly, glow and lasers
   * pulse dimly, beacons burn steadily. While active (built and powered): the converter rotor and fans spin up, core halo
   * and plasma / lasers glow fully, radiators heat up, arcs flash, beacons blink, rings float faster.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    const an = this.kit.style.anim;
    const A = CONVERTER_ANIM;
    this.time += delta;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    for (let i = 0; i < this.drives.length; i++) this.drives[i].update(delta, this.power);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);
    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * this.power);
    this.coreGlow?.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(delta, active);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
