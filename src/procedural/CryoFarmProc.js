// Steel Mans – procedural CryoFarm (crew housing; roadmap 18, phase B). A drop-in alternative to
// models/3DStructures{race}/CryoFarm{race}_Anim.glb built in code from the style modules (ProcModules.js):
//   • footprint inside the GLB's (about 14.8 × 14.3 → pad ±6.9 × ±6.9, front = +Z where the door and the capsule bay are)
//   • role: a sleeping hall at the back (door, windows, roof vents) and an open cryo bay in front where the crew capsules
//     stand in a row (glowing cryo tubes between frames). Body per style.silhouette (rounded: stepped styled block and
//     canopy · angular: armoured sloped block, spiked canopy · round: domed drum, tubes in a ring under a levitating
//     ring · faceted: slim crystal tower, tubes joined to it by lasers); everything else from the style data
//   • animation: capsules pulse in two alternating waves (a cooling "wave" running along the row, brighter and faster
//     while the building is active, stepped when style.anim.jerk > 0), vent unit (fan / radiator heat / plasma orb ring),
//     levitating ring (round), beacons blink while active
//   • 1 merged static mesh (LODs) + emblem decals (1 draw call) + 2 capsule glow layers + beacons + vent parts
// Visual only: update() takes the frame delta. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Spinner, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, chimney, laserLink, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const CRYO_ANIM = {
  powerEase: 1.2,         // 1/s – how fast the building spins up / down
  idleGlow: 0.35,         // capsule glow share while idle
  waveShift: 0.5,         // phase offset (share of one pulse) between the two capsule layers
  jerkSteps: 3,           // glow levels when style.anim.jerk > 0 (stepped, piston-like)
  fanSpeed: 3.6,          // rad/s (× style.anim.spin)
  fanIdle: 0.4,
  fanSpeedJitter: 0.25,
  fanEase: 1.5,           // 1/s – fan speed damping
  capsuleDepth: 0.7,      // depth of the capsule pulse (0 = constant, 1 = down to zero)
  ringAmpShare: 0.7,      // roof ring float amplitude share of the orb ring's
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.37,        // s – pulse phase offset per instance
  heatIdle: 0.25,         // radiator glow share while idle
};

/** Shared layout (model units, GLB scale; front = +Z, footprint ±7 × ±7) */
const LAYOUT = {
  padHalf: 6.9, padH: 0.25, padSegments: 40,
  floorH: 0.5,                         // bay floor slab
  capsule: { r: 0.7, h: 3.0, baseH: 0.5, capH: 0.35, baseOver: 1.35, capOver: 1.25, segments: 12, barT: 0.12, barOver: 1.15, haloR: 1.5, bars: 2 },
  capsuleXs: [-4.6, -2.5, 2.5, 4.6], capsuleZ: 4.6,
  door: { w: 2.2, h: 3.2, frameW: 2.8, frameH: 3.6, frameD: 0.7, interiorD: 0.1, interiorOut: 0.05, base: 0.5 },
  neonMin: 0.3,                        // style.neon from which bands get a neon line
  band: { h: 0.4, t: 0.05, y: 0.9 },
  neonBand: { h: 0.12, t: 0.05 },
  decalSize: 3.2, decalFront: 2.0,
  vent: { r: 1.2 },
};

/** Dimensions of the bodies by style.silhouette (code knows shapes, the style data picks one; unknown → rounded) */
const SHAPES = {
  rounded: {
    body: { w: 12.6, d: 8.6, h: 6.4, z: -2.5 },
    top: { w: 8.4, d: 5.6, h: 1.4 },
    bay: { w: 12.6, d: 5.0, z: 4.3, roofY: 4.6, roofH: 0.5, post: 0.6 },
    win: { y: 3.2, w: 2.2, h: 1.4, zs: [-5.5, 0.5], t: 0.06, frame: 0.12 },
    vents: [[-2.4, -3.2], [2.4, -3.2]],
    beacons: [[-5.9, -6.4], [5.9, -6.4]], bayBeacons: [[-6.0, 6.5], [6.0, 6.5]],
  },
  angular: {
    body: { w: 13.6, topW: 11.2, d: 8.8, topD: 7.0, h: 6.4, z: -2.4 },
    skirt: { w: 13.8, d: 8.8, h: 0.5 },
    parapet: { w: 11.2, d: 7.0, h: 0.8, t: 0.5, spikeH: 1.1, spikeR: 0.28 },
    bay: { w: 13.6, topW: 12.0, d: 4.9, z: 4.45, roofY: 4.5, roofH: 0.8, post: 1.0, spikeH: 0.8, spikeR: 0.22 },
    win: { y: 2.6, h: 0.5, len: 5.0, t: 0.06, z: -2.4 },
    vents: [[-2.4, -2.4], [2.4, -2.4]], chimney: { x: -4.4, z: -5.0, h: 3.0, r: 0.6 },
    beacons: [[-5.4, -5.4], [5.4, -5.4]], bayBeacons: [[-6.0, 6.7], [6.0, 6.7]],
    capsuleBars: 0.2,
  },
  round: {
    drum: { r: 4.2, h: 5.4, segments: 32 }, dome: { sy: 0.45, segments: 32, rings: 10 },
    ribs: { count: 3, tube: 0.15 },
    neonRing: { y: 4.0, h: 0.25, out: 0.05 },
    veins: { count: 20, w: 0.08, h: 2.4, y: 2.7, out: 0.04, skipFront: 0.45, skipRear: 0.9 },
    decalAngles: [140, 180, 220], decalY: 3.2, decalSize: 3.0, frontDecalY: 4.5, frontDecalSize: 1.6,
    door: { out: 0.05 },
    capsuleRing: { r: 5.7, angles: [-112, -70, -28, 28, 70, 112] },
    ring: { r: 5.7, y: 4.95, tube: 0.22 },
    vent: { r: 1.4 },
    beacons: [[160, 6.4], [200, 6.4]],
  },
  faceted: {
    body: { w: 7.0, topW: 4.2, d: 7.0, topD: 4.2, h: 8.0, z: -2.2 },
    cap: { s: 3.0, h: 1.0, spikeH: 2.6, spikeR: 0.5, neonS: 3.2 },
    wing: { x: 5.2, w: 2.4, topW: 1.2, h: 5.0, d: 5.0, z: -3.0, ventR: 0.55, neonH: 0.12 },
    emitter: { y: 7.2, z: 0.1 }, laserTopLift: 0.4,
    win: { y: 3.0, w: 0.8, h: 2.4, t: 0.06 },
    beacons: [[-6.3, 6.2], [6.3, 6.2]],
    capsuleXs: [-4.8, -2.4, 2.4, 4.8],
  },
};

const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------- static parts

/** One cryo capsule standing on the floor at height y0: base ring, glowing tube, cap, bars; halo to glow layer `halo` */
function capsule(c, x, z, y0, halo, bars = LAYOUT.capsule.barT) {
  const { b, S } = c;
  const C = LAYOUT.capsule;
  const ty = y0 + C.baseH;
  b.cylinder(C.r * C.capOver, C.r * C.baseOver, C.baseH, C.segments, S.hullDark, { x, y: y0 + C.baseH / 2, z });
  b.cylinder(C.r, C.r, C.h, C.segments, S.lens, { x, y: ty + C.h / 2, z });
  b.cylinder(C.r * C.capOver, C.r * C.capOver, C.capH, C.segments, S.frame, { x, y: ty + C.h + C.capH / 2, z });
  for (let i = 0; i < C.bars; i++) {
    const a = (i / C.bars) * TAU + Math.PI / 2;
    b.box(bars, C.h, bars, S.frame, { x: x + Math.cos(a) * C.r * C.barOver, y: ty + C.h / 2, z: z + Math.sin(a) * C.r * C.barOver });
  }
  halo.cylinder(C.r * C.haloR, C.r * C.haloR, C.h, C.segments, { x, y: ty + C.h / 2, z });
  return [x, ty + C.h + C.capH, z];   // top point
}

/** Row of capsules in the bay; layers alternate A / B so a wave can run along the row */
function capsuleRow(c, xs, z, y0, bars) {
  const tops = [];
  xs.forEach((x, i) => tops.push(capsule(c, x, z, y0, c.glows.get(i % 2 ? 'cryoB' : 'cryoA'), bars)));
  return tops;
}

/** Entrance: frame + glowing interior on a wall face at z (the front face of the sleeping hall) */
function door(c, z, y, zOut = 0) {
  const { b, S, kit } = c;
  const D = LAYOUT.door;
  b.box(D.frameW, D.frameH, D.frameD, S.frame, { base: true, y: y + D.base, z: z + zOut });
  b.box(D.w, D.h, D.interiorD, S.interior, { base: true, y: y + D.base, z: z + zOut + D.frameD / 2 + D.interiorOut });
  marking(b, kit, D.frameW, 0.4, { y: y + D.base + D.frameH + 0.25, z: z + zOut + D.frameD / 2 - 0.1 });
}

/** Flat (vertical) wall decal */
const decal = (c, position, normal, size) => c.decals.push({ position, normal, size });

function sideWindows(c, S2, wallX, y0, zList, w, h, t, frame) {
  const { b, S } = c;
  for (const sx of [-1, 1]) {
    for (const z of zList) {
      b.box(t, h + frame, w + frame, S.frame, { x: sx * (wallX + t / 2), y: y0 + S2, z });
      b.box(t, h, w, S.window, { x: sx * (wallX + t), y: y0 + S2, z });
    }
  }
}

function teamBands(c, wallX, wallBack, d, zc, y) {
  const { b, S, kit } = c;
  const L = LAYOUT;
  for (const sx of [-1, 1]) b.box(L.band.t, L.band.h, d * 0.95, S.team, { x: sx * (wallX + L.band.t / 2), y, z: zc });
  b.box(wallX * 2 * 0.98, L.band.h, L.band.t, S.team, { y, z: wallBack - L.band.t / 2 });
  if (kit.style.neon >= L.neonMin) {
    const ny = y + 1.4;
    for (const sx of [-1, 1]) neonStrip(b, kit, L.neonBand.t, L.neonBand.h, d * 0.95, { x: sx * (wallX + L.neonBand.t / 2), y: ny, z: zc });
    neonStrip(b, kit, wallX * 2 * 0.98, L.neonBand.h, L.neonBand.t, { y: ny, z: wallBack - L.neonBand.t / 2 });
  }
}

const BODIES = {};

/** rounded: styled stepped block, open pavilion bay with glowing capsules */
BODIES.rounded = (c) => {
  const D = SHAPES.rounded;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const y0 = L.padH;
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  const B = D.body;
  const hw = B.w / 2;
  const front = B.z + B.d / 2;
  styledBox(b, kit, B.w, B.h, B.d, S.hull, { base: true, y: y0, z: B.z });
  styledBox(b, kit, D.top.w, D.top.h, D.top.d, S.hull, { base: true, y: y0 + B.h, z: B.z });
  const roofTop = y0 + B.h + D.top.h;
  teamBands(c, hw, B.z - B.d / 2, B.d, B.z, y0 + L.band.y);
  sideWindows(c, D.win.y, hw, y0, D.win.zs, D.win.w, D.win.h, D.win.t, D.win.frame);
  for (const sx of [-1, 1]) decal(c, [sx * hw, y0 + 3.4, B.z], [sx, 0, 0], L.decalSize);
  decal(c, [0, y0 + 3.4, B.z - B.d / 2], [0, 0, -1], L.decalSize);
  decal(c, [0, y0 + 5.3, front], [0, 0, 1], L.decalFront);
  door(c, front, y0 + L.floorH - L.door.base);
  // bay: floor, roof canopy on four posts, hazard marking on the canopy edge
  const Y = D.bay;
  b.box(Y.w, L.floorH, Y.d, S.hullDark, { base: true, y: y0, z: Y.z });
  styledBox(b, kit, Y.w, Y.roofH, Y.d, S.hull, { base: true, y: y0 + Y.roofY, z: Y.z });
  const bayFront = Y.z + Y.d / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(Y.post, Y.roofY - L.floorH, Y.post, S.frame, { base: true, x: sx * (Y.w / 2 - Y.post / 2), y: y0 + L.floorH, z: Y.z + sz * (Y.d / 2 - Y.post / 2) });
  }
  marking(b, kit, Y.w - 0.4, Y.roofH * 0.8, { y: y0 + Y.roofY + Y.roofH / 2, z: bayFront + 0.02 });
  b.box(Y.w * 0.95, 0.2, 0.05, S.team, { y: y0 + Y.roofY - 0.15, z: bayFront - 0.2 });
  if (kit.style.neon >= L.neonMin) neonStrip(b, kit, Y.w * 0.9, 0.1, 0.06, { y: y0 + Y.roofY - 0.05, z: bayFront - 0.1 });
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: roofTop, z, r: L.vent.r }));
  for (const [x, z] of D.beacons) beacon(b, glows.get('beaconA'), kit, [x, y0 + B.h, z]);
  for (const [x, z] of D.bayBeacons) beacon(b, glows.get('beaconA'), kit, [x, y0 + Y.roofY + Y.roofH, z]);
  capsuleRow(c, L.capsuleXs, L.capsuleZ, y0 + L.floorH);
};

/** angular: armoured sloped block with a spiked parapet, heavy bay roof, capsules in thick frames */
BODIES.angular = (c) => {
  const D = SHAPES.angular;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const y0 = L.padH;
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  const B = D.body;
  const front = B.z + B.d / 2;
  const back = B.z - B.d / 2;
  b.box(D.skirt.w, D.skirt.h, D.skirt.d, S.lower, { base: true, y: y0, z: B.z });
  b.taperedBox(B.w, B.topW, B.h, B.d, S.hull, { y: y0, z: B.z }, B.topD);
  const roofY = y0 + B.h;
  const P = D.parapet;
  for (const s of [-1, 1]) {
    b.box(P.t, P.h, P.d, S.hullDark, { base: true, x: s * (P.w / 2 - P.t / 2), y: roofY, z: B.z });
    b.box(P.w, P.h, P.t, S.hullDark, { base: true, y: roofY, z: B.z + s * (P.d / 2 - P.t / 2) });
    for (const e of [-1, 1]) spike(b, kit, { x: s * P.w / 2, y: roofY + P.h, z: B.z + e * P.d / 2, h: P.spikeH, r: P.spikeR });
  }
  // sloped side windows, decals and bands follow the wall lean
  const leanX = (B.w - B.topW) / 2;
  const leanZ = (B.d - B.topD) / 2;
  const tiltX = Math.atan2(leanX, B.h);
  const tiltZ = Math.atan2(leanZ, B.h);
  const wallX = (y) => B.w / 2 - (leanX * y) / B.h;
  const wallFront = (y) => front - (leanZ * y) / B.h;
  const wallBack = (y) => back + (leanZ * y) / B.h;
  const W = D.win;
  for (const sx of [-1, 1]) {
    b.box(W.t, W.h, W.len, S.window, { x: sx * (wallX(W.y) + W.t / 2), y: y0 + W.y, z: W.z, rz: sx * tiltX });
    b.box(W.t, W.h * 0.5, W.len * 0.9, S.team, { x: sx * (wallX(1.2) + W.t / 2), y: y0 + 1.2, z: B.z, rz: sx * tiltX });
    decal(c, [sx * wallX(4.6), y0 + 4.6, B.z + 1.2], [sx * Math.cos(tiltX), Math.sin(tiltX), 0], L.decalSize);
  }
  decal(c, [0, y0 + 3.6, wallBack(3.6)], [0, Math.sin(tiltZ), -Math.cos(tiltZ)], L.decalSize);
  decal(c, [0, y0 + 5.2, wallFront(5.2)], [0, Math.sin(tiltZ), Math.cos(tiltZ)], L.decalFront);
  door(c, front, y0 + L.floorH - L.door.base, 0.1);
  // bay: heavy floor, sloped armour roof on slab posts with spikes
  const Y = D.bay;
  b.box(Y.w, L.floorH, Y.d, S.hullDark, { base: true, y: y0, z: Y.z });
  b.taperedBox(Y.w, Y.topW, Y.roofH, Y.d, S.hull, { y: y0 + Y.roofY, z: Y.z }, Y.d - 0.4);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * (Y.w / 2 - Y.post / 2);
    const pz = Y.z + sz * (Y.d / 2 - Y.post / 2);
    b.box(Y.post, Y.roofY - L.floorH, Y.post, S.hullDark, { base: true, x: px, y: y0 + L.floorH, z: pz });
    spike(b, kit, { x: px, y: y0 + Y.roofY + Y.roofH, z: pz, h: Y.spikeH, r: Y.spikeR });
  }
  for (const [x, z] of D.beacons) beacon(b, glows.get('beaconA'), kit, [x, roofY + P.h, z]);
  for (const [x, z] of D.bayBeacons) beacon(b, glows.get('beaconA'), kit, [x, y0 + Y.roofY + Y.roofH, z]);
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: roofY, z, r: L.vent.r }));
  chimney(b, kit, { x: D.chimney.x, y: roofY, z: D.chimney.z, h: D.chimney.h, r: D.chimney.r });
  capsuleRow(c, L.capsuleXs, L.capsuleZ, y0 + L.floorH, D.capsuleBars);
};

/** round: domed drum with a plasma orb, capsules in a ring under a levitating ring, smooth pad */
BODIES.round = (c) => {
  const D = SHAPES.round;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const y0 = L.padH;
  b.cylinder(L.padHalf, L.padHalf, L.padH, L.padSegments, S.ground, { y: L.padH / 2 });
  const R = D.drum.r;
  b.cylinder(R, R, D.drum.h, D.drum.segments, S.hull, { y: y0 + D.drum.h / 2 });
  const dy = y0 + D.drum.h;
  b.add(new THREE.SphereGeometry(R, D.dome.segments, D.dome.rings, 0, TAU, 0, Math.PI / 2), S.hull, { y: dy, sy: D.dome.sy });
  const peak = dy + R * D.dome.sy;
  for (let i = 0; i < D.ribs.count; i++) {
    b.torus(R + 0.05, D.ribs.tube, 4, 14, Math.PI, S.hullDark, { ry: (i / D.ribs.count) * Math.PI, sy: D.dome.sy, y: dy });
  }
  b.cylinder(R + D.neonRing.out, R + D.neonRing.out, D.neonRing.h, D.drum.segments, S.neon, { y: y0 + D.neonRing.y }, true);
  if (kit.rich) {
    const V = D.veins;
    for (let i = 0; i < V.count; i++) {
      const a = (i / V.count) * TAU;
      const deg = wrapDeg((a * 180) / Math.PI);
      if (Math.abs(deg) < (V.skipFront * 180) / Math.PI || 180 - Math.abs(deg) < (V.skipRear * 180) / Math.PI) continue;
      neonStrip(b, kit, V.w, V.h, V.w, { x: Math.sin(a) * (R + V.out), y: y0 + V.y, z: Math.cos(a) * (R + V.out), ry: a });
    }
  }
  for (const deg of D.decalAngles) {
    const a = (deg * Math.PI) / 180;
    decal(c, [Math.sin(a) * R, y0 + D.decalY, Math.cos(a) * R], [Math.sin(a), 0, Math.cos(a)], D.decalSize);
  }
  decal(c, [0, y0 + D.frontDecalY, R], [0, 0, 1], D.frontDecalSize);
  door(c, R, y0 - L.door.base, D.door.out);
  // plasma orb on the dome (style.fan 'none' gives the orb; other styles a vent there)
  c.vents.push(ventUnit(b, glows, kit, { x: 0, y: peak, z: 0, r: D.vent.r }));
  for (const [deg, r] of D.beacons) {
    const a = (deg * Math.PI) / 180;
    beacon(b, glows.get('beaconA'), kit, [Math.sin(a) * r, y0, Math.cos(a) * r]);
  }
  const K = D.capsuleRing;
  K.angles.forEach((deg, i) => {
    const a = (deg * Math.PI) / 180;
    capsule(c, Math.sin(a) * K.r, Math.cos(a) * K.r, y0, glows.get(i % 2 ? 'cryoB' : 'cryoA'));
  });
  c.ring = { r: D.ring.r, tube: D.ring.tube, y: y0 + D.ring.y };
};

/** faceted: slim crystal tower, radiator wings, capsules on lamella plates tied to the tower by lasers */
BODIES.faceted = (c) => {
  const D = SHAPES.faceted;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const laser = glows.get('laser');
  const y0 = L.padH;
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  const B = D.body;
  const front = B.z + B.d / 2;
  b.taperedBox(B.w, B.topW, B.h, B.d, S.hull, { y: y0, z: B.z }, B.topD);
  const top = y0 + B.h;
  const Cp = D.cap;
  b.box(Cp.s, Cp.h, Cp.s, S.hullDark, { y: top + Cp.h / 2, z: B.z, ry: Math.PI / 4 });
  neonStrip(b, kit, Cp.neonS, 0.12, Cp.neonS, { y: top + Cp.h + 0.06, z: B.z, ry: Math.PI / 4 });
  spike(b, kit, { x: 0, y: top + Cp.h, z: B.z, h: Cp.spikeH, r: Cp.spikeR });
  const leanX = (B.w - B.topW) / 2;
  const leanZ = (B.d - B.topD) / 2;
  const tiltX = Math.atan2(leanX, B.h);
  const tiltZ = Math.atan2(leanZ, B.h);
  const wallX = (y) => B.w / 2 - (leanX * y) / B.h;
  const wallFront = (y) => front - (leanZ * y) / B.h;
  const W = D.win;
  for (const sx of [-1, 1]) {
    b.box(W.t, W.h, W.w, S.window, { x: sx * (wallX(W.y) + W.t / 2), y: y0 + W.y, z: B.z, rz: sx * tiltX });
    decal(c, [sx * wallX(5.0), y0 + 5.0, B.z], [sx * Math.cos(tiltX), Math.sin(tiltX), 0], L.decalSize * 0.75);
  }
  decal(c, [0, y0 + 5.4, wallFront(5.4)], [0, Math.sin(tiltZ), Math.cos(tiltZ)], L.decalFront * 0.9);
  decal(c, [0, y0 + 5.0, B.z - B.d / 2 + (leanZ * 5.0) / B.h], [0, Math.sin(tiltZ), -Math.cos(tiltZ)], L.decalSize * 0.75);
  door(c, front, y0 - L.door.base, 0.1);
  // radiator wings
  const Wg = D.wing;
  for (const sx of [-1, 1]) {
    b.taperedBox(Wg.w, Wg.topW, Wg.h, Wg.d, S.hull, { x: sx * Wg.x, y: y0, z: Wg.z }, Wg.d * 0.7);
    neonStrip(b, kit, Wg.neonH, Wg.neonH, Wg.d * 0.7, { x: sx * Wg.x, y: y0 + Wg.h + Wg.neonH / 2, z: Wg.z });
    c.vents.push(ventUnit(b, glows, kit, { x: sx * Wg.x, y: y0 + Wg.h, z: Wg.z, r: Wg.ventR }));
  }
  for (const [x, z] of D.beacons) beacon(b, glows.get('beaconA'), kit, [x, y0, z]);
  // capsule floor plates and the capsules, each tied to the tower emitter by a laser
  const emitter = [0, y0 + D.emitter.y, D.emitter.z];
  b.add(new THREE.BoxGeometry(1, 1, 1), S.lens, { y: emitter[1], z: emitter[2], sx: 0.3, sy: 0.3, sz: 0.3, ry: Math.PI / 4 });
  D.capsuleXs.forEach((x, i) => {
    b.box(2.4, L.floorH, 2.4, S.hullDark, { base: true, x, y: y0, z: L.capsuleZ, ry: Math.PI / 4 });
    const t = capsule(c, x, L.capsuleZ, y0 + L.floorH, glows.get(i % 2 ? 'cryoB' : 'cryoA'));
    laserLink(b, laser, kit, emitter, [t[0], t[1] + D.laserTopLift, t[2]]);
  });
};

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const c = { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [], ring: null };
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbs = c.vents.filter((v) => v.ring);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbs.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbs.length ? ringGeometry(kit, orbs[0].ring.r) : null,
    heat: c.vents.some((v) => v.radiator),
    roofRing: c.ring ? { geometry: ringGeometry(kit, c.ring.r, c.ring.tube), y: c.ring.y } : null,
  };
}

const CRYO_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class CryoFarmProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CRYO_CACHE, name: 'CryoFarmProc' });
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
    const A = CRYO_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.cryoA = layer('cryoA', gc.pulse, true);
    this.cryoB = layer('cryoB', gc.pulse, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);

    this.spinners = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      this.spinners.push(new Spinner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), ease: A.fanEase, phase: (seq * 0.7 + i * 1.3) % TAU }));
    });
    const lev = PROC_MODULES.levitate;
    this.levitators = [];
    sh.orbSpots.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.orbRing);
      mesh.position.set(x, y, z);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });
    if (sh.roofRing) {
      const mesh = this.paintMesh(sh.roofRing.geometry);
      mesh.position.set(0, sh.roofRing.y, 0);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * A.ringAmpShare * an.levitate, spin: lev.spin * an.spin, phase: seq * 0.21 }));
    }

    this.power = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty, phase: (seq * A.phaseStep) % 1 });
  }

  /** Glow level of one capsule layer: pulse wave (stepped when the style is jerky), idle share → full with the power */
  #level(offset) {
    const an = this.kit.style.anim;
    const A = CRYO_ANIM;
    let w = pulseWave(this.time + offset, an.pulse, A.capsuleDepth);
    if (an.jerk > 0) w = Math.round(w * A.jerkSteps) / A.jerkSteps;
    return w * (A.idleGlow + (1 - A.idleGlow) * this.power);
  }

  /**
   * Per-frame animation (no allocations). Idle: capsules glow dimly in a slow wave, beacons burn steadily. Active
   * (crew is being produced): the two capsule waves run brighter and faster alternating, vents spin / heat up, beacons blink.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = CRYO_ANIM;
    this.time += delta * (1 + this.power);
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    const shift = A.waveShift / Math.max(0.01, an.pulse);
    this.cryoA?.setIntensity(this.#level(0));
    this.cryoB?.setIntensity(this.#level(shift));
    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * this.power);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : A.heatIdle) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    for (let i = 0; i < this.spinners.length; i++) this.spinners[i].update(delta, active);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
