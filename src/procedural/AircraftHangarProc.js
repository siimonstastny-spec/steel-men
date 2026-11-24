// Steel Mans – procedural aircraft hangar (night model batch, docs/night_plan_models.md #4). A drop-in alternative to
// models/3DStructures{race}/AircraftHanger{race}_Anim.glb built in code from the style modules (ProcModules.js):
//   • footprint inside the GLB's (GLB box of the angular / rounded / faceted races: x −20…13.13, z −10.07…5.07, front = +Z;
//     GLB box of the round race: x ±3.5, z −19.4…3.0) – each body keeps inside the box of its own silhouette
//   • hall (rounded: rounded hall · angular: armoured hall with sloped top and buttresses · faceted: chamfered hall with a
//     laser curtain instead of door leaves · round: slim dome tower with a porch and a plasma launch tunnel behind it)
//   • front doors: two sliding leaves (or the laser curtain) open while the hangar is active (producing)
//   • launch deck: roof pad with a lift plate that rises (hall bodies) + a side catapult rail with a sled that shoots along
//     the strip (hall bodies) / a tunnel of plasma arches with a levitating launch ring (round body)
//   • control tower with a turning scanner, vent unit by style.fan, beacons, emblem decals (front flanks, side walls)
//   • light: one merged static mesh per style (buildLods) + emblem decals (1 draw call) + glow layers + a handful of animated parts
// Visual only: update() takes the frame delta and `active`, nothing here is read by the simulation. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Spinner, Blinker, TrackMover, smootherstep } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, plasmaCoil, laserLink, emblemDecalGeometry, Levitator, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const HANGAR_ANIM = {
  doorEase: 0.9,          // 1/s – how fast the doors / curtain open and close
  liftAfter: 0.7,         // door opening from which the roof lift rises
  liftEase: 0.6,          // 1/s – lift plate speed
  liftRise: 2.4,          // units – lift plate travel
  sledSpeed: 10,          // units/s (× style.anim.tempo)
  sledDwell: 0.7,         // s – pause at the end of the strip
  sledJerkSteps: 3,       // pushes per leg when style.anim.jerk > 0
  sledBob: 0.15, sledBobFreq: 0.6,   // levitating ring (round body)
  fanSpeed: 4.0, fanIdle: 0.4, fanSpeedJitter: 0.25,
  scanSpeed: 0.8,         // rad/s of the scanner head (× style.anim.spin)
  ringSpin: 1.2,          // rad/s of the launch ring (× style.anim.spin)
  idleGlow: 0.3,          // rail / pulse glow share while idle
  idleBeacon: 0.4,
  curtainMin: 0.12,       // laser curtain intensity when open
  padIdle: 0.25,          // landing pad glow share while the lift is down
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
};

/** Shared layout (model units, GLB scale; front = +Z). Hall bodies stand in x −20…13.13, z −10.07…5.07 */
const LAYOUT = {
  padH: 0.3, neonMin: 0.3,
  pad: { x0: -19.9, x1: 12.95, z0: -9.95, z1: 4.95 },
  hall: { z0: -9.9, z1: 3.9 },
  door: { halfW: 6.4, jambW: 1.0, jambD: 0.3, headerH: 1.2, leafD: 0.6, leafGap: 0.35, interiorT: 0.1, markH: 0.5, neonH: 0.12, neonT: 0.06, lensR: 0.2 },
  leaf: { ribW: 0.96, ribH: 0.25, ribD: 0.06, markShare: 0.9, markH: 0.8, markY: 0.7, neonY: 0.5, neonH: 0.1, neonT: 0.06 },
  deck: { x: -3, z: -3.4, w: 10, d: 8, holeW: 7.6, holeD: 5.6, frameH: 0.6, markH: 0.4, plateH: 0.5, plateSkirt: 2.4, plateInset: 0.2,
    ringShare: 0.7, ringTube: 0.09, cornerR: 0.15, cornerH: 0.12, stripeW: 1.2, stripeD: 0.4, haloTube: 0.2, haloR: 0.5 },
  tower: { x: 7, z: -6.0, w: 4, d: 3.8, h: 9, topShare: 0.6, winH: 1.2, winY: 1.6, capOver: 0.5, capH: 0.3, mastW: 0.25, mastH: 1.6 },
  band: { y: 1.5, h: 0.5, t: 0.06, inset: 1.5 },
  neonLine: { h: 0.12, t: 0.06, drop: 1.0, flankInset: 0.3, flankEnd: 0.4 },
  window: { zOff: 4.6, d: 2.2, h: 1.1, t: 0.06, yShare: 0.7 },
  decal: { y: 0.5, frontY: 0.55 },
  vent: { x: 4.8, z: -1.0, r: 1.3 },
  cat: {   // side catapult strip (x −19.9…−12.9)
    x: -16.4, z0: -9.6, z1: 4.6, gauge: 0.75, railW: 0.35, railH: 0.3, baseW: 6.4, baseH: 0.12,
    shieldZ: -9.4, shieldW: 5, shieldH: 2.6, shieldD: 0.5, stopZ: 4.4, stopW: 5.4, stopH: 0.6, stopD: 0.4,
    neonW: 0.2, neonH: 0.05, glowW: 0.5, glowH: 0.12, markH: 0.9, markZ: 3.4,
    stops: [2.8, -7.8], beaconX: -19.0, beaconZ: [-9.0, 4.2],
    sled: { w: 1.9, h: 0.45, d: 2.4, topW: 1.5, topH: 0.2, topD: 1.4, stripeW: 1.3, stripeD: 0.5, lens: [0.4, 0.3, 0.2], hook: 0.2 },
  },
  roofSpike: { h: 1.2, r: 0.3, inset: 0.3 },
  buttress: { w: 1.2, h: 7, d: 1.4, footW: 1.8, footH: 0.5, footD: 2.0, zs: [-5.5, 5.5] },
  lowerPlate: { h: 2.4, over: 0.1 },
};

/** Round body (slim tower + launch tunnel; x ±3.5, z −19.4…3.0 in the GLB) */
const TOWER = {
  pad: { x: 0, z0: -19.3, z1: 2.9, w: 6.8 },
  hallZ: -1.0, hallR: 3.2, plinthR: 3.4, plinthH: 0.8, hallH: 8.2, segments: 32,
  dome: { sy: 0.55, segments: 24, rings: 8 },
  neonRings: { tube: 0.1, out: 0.04, lowY: 4.0, topDrop: 0.5 },
  band: { y: 1.2, tube: 0.12, out: 0.04 },
  veins: { count: 16, w: 0.1, h: 3.4, y: 3.2, out: 0.04, skipArc: 0.5 },
  porch: { w: 6.4, h: 7.0, d: 2.6, frontZ: 2.2, interiorT: 0.1 },
  door: { halfW: 1.6, h: 5.6, leafW: 1.6, leafD: 0.5, leafZ: 2.5, open: 2.4 },
  beaconX: 2.6,
  decal: { side: 3.0, sideY: 4.2, front: 1.3, frontY: 6.3 },
  coil: { x: 2.4, z: -6.5, h: 3.6, r: 0.75 },
  tunnel: { z0: -7.8, step: 1.8, count: 7, r: 1.5, tube: 0.1, neonR: 1.38, neonTube: 0.05, haloTube: 0.14, floorLen: 12, floorZ: -13, floorW: 0.3, floorH: 0.05,
    stopZ: -19.0, stopW: 3.4, stopH: 3.0, stopD: 0.5 },
  sled: { r: 0.75, tube: 0.09, core: 0.28, halo: 0.7, haloTube: 0.2, y: 0.95, stops: [-17.5, -6.0] },
  orbR: 1.5,
};

/** Hall bodies by style.silhouette (code knows shapes, the style data picks one; unknown → rounded) */
const SHAPES = {
  rounded: { kind: 'hall', body: 'rounded', halfW: 12.9, straightH: 14, taperH: 0, topW: 0, topD: 0, doorH: 10, leaf: { surface: 'hull', ribs: 3 },
    tower: 'rounded', sideDecal: 5.5, frontDecal: 3.8, windows: true },
  angular: { kind: 'hall', body: 'armored', halfW: 11.8, straightH: 9.5, taperH: 4.5, topW: 21.4, topD: 11.8, doorH: 8.2, leaf: { surface: 'hullDark', ribs: 4 },
    tower: 'armored', sideDecal: 5.0, frontDecal: 3.2, windows: false },
  faceted: { kind: 'hall', body: 'faceted', halfW: 12.4, straightH: 9.5, taperH: 3.5, topW: 19, topD: 10.6, doorH: 8.2, leaf: null, curtain: true,
    tower: 'faceted', sideDecal: 5.0, frontDecal: 3.4, windows: true },
  round: { kind: 'tower' },
};

/** Centre of the GLB box (x, z; model units, unscaled) per body kind: the hall bodies' box x −20…13.13, z −10.07…5.07; the tower's z −19.4…3.0 */
const HANGAR_GLB_CENTRE = { hall: { x: -3.435, z: -2.5 }, tower: { x: 0, z: -8.2 } };

const shapeOf = (style) => SHAPES[style.silhouette] ?? SHAPES.rounded;

// ---------------------------------------------------------------- static parts (construction time only)

/** Door leaf (shared by both leaves): a plate with ribs, a marking along the foot and a neon line */
function leafGeometry(kit, w, h, d, spec) {
  const L = LAYOUT.leaf;
  const S = kit.S;
  const b = new PartBuilder();
  b.box(w, h, d, S[spec.surface], { base: true });
  for (let k = 1; k <= spec.ribs; k++) b.box(w * L.ribW, L.ribH, L.ribD, S.frame, { y: (h * k) / (spec.ribs + 1), z: d / 2 + L.ribD / 2 });
  marking(b, kit, w * L.markShare, L.markH, { y: L.markY, z: d / 2 + 0.02 });
  if (kit.style.neon >= LAYOUT.neonMin) neonStrip(b, kit, w * L.markShare, L.neonH, L.neonT, { y: h - L.neonY, z: d / 2 + 0.02 });
  return b.build();
}

/** Front door frame: jambs with markings, header with a neon line, interior glow, beacons; faceted: laser curtain + emitters */
function doorFrame(c, sh) {
  const D = LAYOUT.door;
  const H = LAYOUT.hall;
  const y0 = LAYOUT.padH;
  const { b, S, kit, glows } = c;
  b.box(D.halfW * 2, sh.doorH, D.interiorT, S.interior, { base: true, y: y0, z: H.z1 + D.interiorT / 2 });
  for (const s of [-1, 1]) {
    const x = s * (D.halfW + D.jambW / 2);
    b.box(D.jambW, sh.doorH + D.headerH, D.jambD, S.frame, { base: true, x, y: y0, z: H.z1 + D.jambD / 2 });
    marking(b, kit, sh.doorH, D.markH, { rz: Math.PI / 2, x, y: y0 + sh.doorH / 2, z: H.z1 + D.jambD + 0.02 });
    beacon(b, glows.get('beaconA'), kit, [x, y0 + sh.doorH + D.headerH, H.z1 + D.jambD / 2]);
  }
  b.box((D.halfW + D.jambW) * 2, D.headerH, D.jambD, S.frame, { base: true, y: y0 + sh.doorH, z: H.z1 + D.jambD / 2 });
  if (kit.style.neon >= LAYOUT.neonMin) neonStrip(b, kit, D.halfW * 2, D.neonH, D.neonT, { y: y0 + sh.doorH + D.headerH / 2, z: H.z1 + D.jambD + D.neonT / 2 });
  if (sh.curtain) {
    const z = H.z1 + D.leafGap + D.leafD;
    glows.get('curtain').box(D.halfW * 2, sh.doorH, D.neonT, { y: y0 + sh.doorH / 2, z });
    for (const s of [-1, 1]) for (const y of [y0 + 0.2, y0 + sh.doorH]) b.sphere(D.lensR, 8, 6, S.lens, { x: s * D.halfW, y, z });
  }
}

/** Hall body, bands, neon lines, windows, emblem decals. Returns the roof height. */
function hallBody(c, sh) {
  const L = LAYOUT;
  const H = L.hall;
  const y0 = L.padH;
  const { b, S, kit } = c;
  const d = H.z1 - H.z0;
  const cz = (H.z1 + H.z0) / 2;
  const w = sh.halfW * 2;
  const roof = y0 + sh.straightH + sh.taperH;
  const neon = kit.style.neon >= L.neonMin;
  switch (sh.body) {
    case 'armored': {   // block + sloped top, rusty lower plates, buttresses and spikes
      b.box(w, sh.straightH, d, S.hull, { base: true, y: y0, z: cz });
      b.taperedBox(w, sh.topW, sh.taperH, d, S.hull, { y: y0 + sh.straightH, z: cz }, sh.topD);
      b.box(w + L.lowerPlate.over, L.lowerPlate.h, d + L.lowerPlate.over, S.lower, { base: true, y: y0, z: cz });
      const B = L.buttress;
      for (const s of [-1, 1]) {
        for (const p of B.zs) {
          b.box(B.w, B.h, B.d, S.hullDark, { base: true, x: s * (sh.halfW + B.w / 2), y: y0, z: cz + p });
          b.box(B.footW, B.footH, B.footD, S.frame, { base: true, x: s * (sh.halfW + B.footW / 2 - 0.6), y: y0, z: cz + p });
        }
        for (const e of [-1, 1]) spike(b, kit, { x: s * (sh.topW / 2 - L.roofSpike.inset), y: roof, z: cz + e * (sh.topD / 2 - L.roofSpike.inset), h: L.roofSpike.h, r: L.roofSpike.r });
      }
      break;
    }
    case 'faceted': {   // chamfered block under a sloped top with spikes joined by a laser line
      styledBox(b, kit, w, sh.straightH, d, S.hull, { base: true, y: y0, z: cz });
      b.taperedBox(w, sh.topW, sh.taperH, d, S.hull, { y: y0 + sh.straightH, z: cz }, sh.topD);
      const sz = cz + sh.topD / 2 - L.roofSpike.inset;
      const ex = sh.topW / 2 - L.roofSpike.inset;
      for (const s of [-1, 1]) spike(b, kit, { x: s * ex, y: roof, z: sz, h: L.roofSpike.h, r: L.roofSpike.r });
      spike(b, kit, { x: 0, y: roof, z: sz, h: L.roofSpike.h, r: L.roofSpike.r });
      c.glows.get('laser').segment([-ex, roof + L.roofSpike.h * 0.5, sz], [ex, roof + L.roofSpike.h * 0.5, sz], PROC_MODULES.laser.thickness);
      break;
    }
    default: styledBox(b, kit, w, sh.straightH, d, S.hull, { base: true, y: y0, z: cz });
  }

  // team band and neon lines on the side walls; neon lines on the front flanks
  const N = L.neonLine;
  const ny = y0 + sh.straightH - N.drop;
  const flankA = L.door.halfW + L.door.jambW + N.flankInset;
  const flankLen = sh.halfW - N.flankEnd - flankA;
  for (const s of [-1, 1]) {
    b.box(L.band.t, L.band.h, d - L.band.inset, S.team, { x: s * (sh.halfW + L.band.t / 2), y: y0 + L.band.y, z: cz });
    if (neon) {
      neonStrip(b, kit, N.t, N.h, d - 1, { x: s * (sh.halfW + N.t / 2), y: ny, z: cz });
      neonStrip(b, kit, flankLen, N.h, N.t, { x: s * (flankA + flankLen / 2), y: ny, z: H.z1 + N.t / 2 });
    }
    if (sh.windows) {
      for (const e of [-1, 1]) b.box(L.window.t, L.window.h, L.window.d, S.window, { x: s * (sh.halfW + L.window.t / 2), y: y0 + sh.straightH * L.window.yShare, z: cz + e * L.window.zOff });
    }
    c.emblems.push({ position: [s * sh.halfW, y0 + sh.straightH * L.decal.y, cz], normal: [s, 0, 0], size: sh.sideDecal });
    c.emblems.push({ position: [s * ((flankA - N.flankInset + sh.halfW) / 2), y0 + sh.straightH * L.decal.frontY, H.z1], normal: [0, 0, 1], size: sh.frontDecal });
  }
  doorFrame(c, sh);
  return roof;
}

/** Roof launch deck: frame round a shaft; returns { plate, plateGlow, plateAt } for the lift plate */
function roofDeck(c, sh, roof) {
  const P = LAYOUT.deck;
  const { b, S, kit } = c;
  const sideD = (P.d - P.holeD) / 2;
  const sideW = (P.w - P.holeW) / 2;
  for (const e of [-1, 1]) {
    b.box(P.w, P.frameH, sideD, S.frame, { base: true, x: P.x, y: roof, z: P.z + e * (P.d / 2 - sideD / 2) });
    b.box(sideW, P.frameH, P.holeD, S.frame, { base: true, x: P.x + e * (P.w / 2 - sideW / 2), y: roof, z: P.z });
  }
  b.box(P.holeW, 0.05, P.holeD, S.hole, { base: true, x: P.x, y: roof, z: P.z });
  marking(b, kit, P.w - 0.4, P.markH, { x: P.x, y: roof + P.frameH / 2, z: P.z + P.d / 2 + 0.01 });
  for (const s of [-1, 1]) beacon(b, c.glows.get('beaconA'), kit, [P.x + s * (P.w / 2 - 0.3), roof + P.frameH, P.z + P.d / 2 - 0.3]);

  const plate = new PartBuilder();   // origin at the plate top
  const pw = P.holeW - 2 * P.plateInset;
  const pd = P.holeD - 2 * P.plateInset;
  plate.box(pw, P.plateH, pd, S.hull, { y: -P.plateH / 2 });
  plate.box(pw - 0.8, P.plateSkirt, pd - 0.8, S.hullDark, { y: -P.plateH - P.plateSkirt / 2 });
  plate.torus((Math.min(pw, pd) / 2) * P.ringShare, P.ringTube, 4, 32, TAU, S.neon, { rx: Math.PI / 2, y: 0.05 });
  const pg = new GlowSet();
  pg.get('pad').torus((Math.min(pw, pd) / 2) * P.ringShare, P.haloTube, 4, 32, TAU, { rx: Math.PI / 2, y: 0.1 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (pw / 2 - 0.4);
      const z = sz * (pd / 2 - 0.4);
      plate.cylinder(P.cornerR, P.cornerR, P.cornerH, 8, S.lens, { x, y: P.cornerH / 2, z });
      pg.get('pad').point([x, P.cornerH, z], P.haloR);
    }
    plate.box(P.stripeW, 0.06, P.stripeD, S.team, { x: sx * (pw / 2 - 1.4), y: 0.03, z: pd / 2 - 0.9 });
  }
  return { plate: plate.build(), plateGlow: pg.build().pad ?? null, plateAt: [P.x, roof + 0.05, P.z] };
}

/** Control tower with a scanner mast (sets c.head), a vent unit on the roof and beacons */
function towerAndRoof(c, sh, roof) {
  const T = LAYOUT.tower;
  const { b, S, kit } = c;
  switch (sh.tower) {
    case 'armored': b.taperedBox(T.w, T.w * 0.8, T.h, T.d, S.hull, { x: T.x, y: roof, z: T.z }, T.d * 0.8); break;
    case 'faceted': b.taperedBox(T.w, T.w * T.topShare, T.h, T.d, S.hullDark, { x: T.x, y: roof, z: T.z }, T.d * T.topShare); break;
    default: styledBox(b, kit, T.w, T.h, T.d, S.hull, { base: true, x: T.x, y: roof, z: T.z });
  }
  b.box(T.w + 0.08, T.winH, T.d + 0.08, S.window, { x: T.x, y: roof + T.h - T.winY, z: T.z });
  b.box(T.w + T.capOver, T.capH, T.d + T.capOver, S.frame, { base: true, x: T.x, y: roof + T.h, z: T.z });
  b.box(T.mastW, T.mastH, T.mastW, S.frame, { base: true, x: T.x, y: roof + T.h + T.capH, z: T.z });
  c.head = { x: T.x, y: roof + T.h + T.capH + T.mastH, z: T.z };
  beacon(c.b, c.glows.get('beaconA'), kit, [T.x + T.w / 2, roof + T.h + T.capH, T.z + T.d / 2]);
  const V = LAYOUT.vent;
  c.vents.push(ventUnit(b, c.glows, kit, { x: V.x, y: roof, z: V.z, r: V.r }));
}

/** Side catapult strip with rails, a blast shield and a stop; returns the sled geometry */
function catapult(c, sh) {
  const K = LAYOUT.cat;
  const y0 = LAYOUT.padH;
  const { b, S, kit, glows } = c;
  const len = K.z1 - K.z0;
  const cz = (K.z1 + K.z0) / 2;
  const top = y0 + K.baseH;
  b.box(K.baseW, K.baseH, len, S.lower, { base: true, x: K.x, y: y0, z: cz });
  for (const s of [-1, 1]) b.box(K.railW, K.railH, len - 0.4, S.frame, { base: true, x: K.x + s * K.gauge, y: top, z: cz });
  neonStrip(b, kit, K.neonW, K.neonH, len - 1, { x: K.x, y: top + K.neonH / 2, z: cz });
  glows.get('rail').box(K.glowW, K.glowH, len - 1, { x: K.x, y: top + K.glowH, z: cz });
  b.box(K.shieldW, K.shieldH, K.shieldD, S.hullDark, { base: true, x: K.x, y: y0, z: K.shieldZ });
  b.box(K.stopW, K.stopH, K.stopD, S.hullDark, { base: true, x: K.x, y: y0, z: K.stopZ });
  marking(b, kit, K.stopW, K.markH, { rx: -Math.PI / 2, x: K.x, y: top + 0.02, z: K.markZ });
  for (const z of K.beaconZ) beacon(b, glows.get('beaconA'), kit, [K.beaconX, top, z]);
  if (kit.style.markings === 'light') {   // laser line from the blast shield to the hall wall
    const wallX = -sh.halfW;
    laserLink(b, glows.get('laser'), kit, [K.x + K.shieldW / 2, y0 + K.shieldH * 0.8, K.shieldZ], [wallX, y0 + K.shieldH * 0.8, K.shieldZ]);
  }

  const M = K.sled;
  const sled = new PartBuilder();   // origin at the sled bottom, front = +Z
  sled.box(M.w, M.h, M.d, S.hull, { base: true });
  sled.box(M.topW, M.topH, M.topD, S.hullDark, { base: true, y: M.h });
  sled.box(M.stripeW, 0.06, M.stripeD, S.team, { y: M.h + M.topH + 0.03 });
  sled.box(M.lens[0], M.lens[1], M.lens[2], S.lens, { y: M.h / 2, z: M.d / 2 });
  sled.box(M.hook, M.h, M.hook, S.frame, { base: true, y: M.h + M.topH, z: -M.d / 4 });
  return { sled: sled.build(), sledAt: [K.x, top + K.railH, 0], sledStops: K.stops, sledRing: false };
}

function buildHall(c, sh) {
  const roof = hallBody(c, sh);
  const L = LAYOUT;
  const P = L.pad;
  c.b.box(P.x1 - P.x0, L.padH, P.z1 - P.z0, c.S.ground, { base: true, x: (P.x0 + P.x1) / 2, z: (P.z0 + P.z1) / 2 });
  const deck = roofDeck(c, sh, roof);
  towerAndRoof(c, sh, roof);
  const cat = catapult(c, sh);
  const D = L.door;
  const leafZ = L.hall.z1 + D.leafGap + D.leafD / 2;
  return {
    ...deck, ...cat,
    leaf: sh.leaf ? leafGeometry(c.kit, D.halfW, sh.doorH, D.leafD, sh.leaf) : null,
    leafSpec: { y: L.padH, z: leafZ, closed: D.halfW / 2, open: D.halfW * 1.5 },
  };
}

/** Round body: dome tower with a porch, plasma coils and a tunnel of arches with a levitating launch ring */
function buildTower(c) {
  const T = TOWER;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const y0 = L.padH;
  const yb = y0 + T.plinthH;
  const y1 = yb + T.hallH;
  const zc = T.hallZ;
  const R = T.hallR;
  b.box(T.pad.w, L.padH, T.pad.z1 - T.pad.z0, S.ground, { base: true, x: T.pad.x, z: (T.pad.z0 + T.pad.z1) / 2 });
  b.cylinder(T.plinthR, T.plinthR, T.plinthH, T.segments, S.hullDark, { y: y0 + T.plinthH / 2, z: zc });
  b.cylinder(R, R, T.hallH, T.segments, S.hull, { y: yb + T.hallH / 2, z: zc });
  b.add(new THREE.SphereGeometry(R, T.dome.segments, T.dome.rings, 0, TAU, 0, Math.PI / 2), S.hull, { y: y1, z: zc, sy: T.dome.sy });
  const peak = y1 + R * T.dome.sy;
  const N = T.neonRings;
  b.torus(R + N.out, N.tube, 4, T.segments, TAU, S.neon, { rx: Math.PI / 2, y: y1 - N.topDrop, z: zc });
  b.torus(R + N.out, N.tube, 4, T.segments, TAU, S.neon, { rx: Math.PI / 2, y: yb + N.lowY, z: zc });
  b.torus(R + T.band.out, T.band.tube, 4, T.segments, TAU, S.team, { rx: Math.PI / 2, y: yb + T.band.y, z: zc });
  if (kit.rich) {
    const V = T.veins;
    for (let i = 0; i < V.count; i++) {
      const a = ((i + 0.5) / V.count) * TAU;
      const sin = Math.sin(a);
      if (sin > 0.6 || Math.abs(sin) < V.skipArc * 0.5) continue;   // keep the porch and the side decals free
      neonStrip(b, kit, V.w, V.h, V.w, { x: Math.cos(a) * (R + V.out), y: yb + V.y, z: zc + sin * (R + V.out), ry: -a });
    }
  }
  // porch with the door (the leaves slide in front of it)
  const Pc = T.porch;
  styledBox(b, kit, Pc.w, Pc.h, Pc.d, S.hull, { base: true, y: yb, z: Pc.frontZ - Pc.d / 2 });
  b.box(T.door.halfW * 2, T.door.h, Pc.interiorT, S.interior, { base: true, y: yb, z: Pc.frontZ + Pc.interiorT / 2 });
  for (const s of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [s * T.beaconX, yb + Pc.h, Pc.frontZ - Pc.d / 2]);
  marking(b, kit, T.door.halfW * 2, 0.5, { y: yb + T.door.h + 0.25, z: Pc.frontZ + 0.02 });
  c.emblems.push({ position: [0, yb + T.decal.frontY, Pc.frontZ], normal: [0, 0, 1], size: T.decal.front });
  for (const s of [-1, 1]) c.emblems.push({ position: [s * R, yb + T.decal.sideY, zc], normal: [s, 0, 0], size: T.decal.side });

  // dome vent (plasma orb / fan / radiator by style) and plasma coils at the tunnel mouth
  c.vents.push(ventUnit(b, c.glows, kit, { x: 0, y: peak, z: zc, r: T.orbR }));
  for (const s of [-1, 1]) plasmaCoil(b, glows.get('pulse'), kit, { x: s * T.coil.x, y: y0, z: T.coil.z, h: T.coil.h, r: T.coil.r });

  // launch tunnel: arches over a neon floor line, levitating launch ring
  const U = T.tunnel;
  for (let i = 0; i < U.count; i++) {
    const z = U.z0 - i * U.step;
    b.torus(U.r, U.tube, 4, 16, Math.PI, S.frame, { y: y0 + 0.1, z });
    b.torus(U.neonR, U.neonTube, 4, 16, Math.PI, S.neon, { y: y0 + 0.1, z });
    glows.get('rail').torus(U.neonR, U.haloTube, 4, 16, Math.PI, { y: y0 + 0.1, z });
  }
  neonStrip(b, kit, U.floorW, U.floorH, U.floorLen, { y: y0 + U.floorH / 2, z: U.floorZ });
  glows.get('rail').box(U.floorW * 2, U.floorH * 2, U.floorLen, { y: y0 + U.floorH, z: U.floorZ });
  b.box(U.stopW, U.stopH, U.stopD, S.hullDark, { base: true, y: y0, z: U.stopZ });

  const Sd = T.sled;
  const sled = new PartBuilder();
  sled.torus(Sd.r, Sd.tube, 6, 24, TAU, S.neon, {});
  sled.sphere(Sd.core, 10, 8, S.plasma, {});
  const sg = new GlowSet();
  sg.get('sled').sphere(Sd.halo, 8, 6, {});
  sg.get('sled').torus(Sd.r, Sd.haloTube, 4, 24, TAU, {});
  return {
    plate: null, plateGlow: null, plateAt: null,
    sled: sled.build(), sledGlow: sg.build().sled ?? null, sledAt: [0, y0 + Sd.y, 0], sledStops: Sd.stops, sledRing: true,
    leaf: leafGeometry(kit, T.door.leafW, T.door.h, T.door.leafD, { surface: 'hull', ribs: 0 }),
    leafSpec: { y: yb, z: T.door.leafZ, closed: T.door.leafW / 2, open: T.door.open },
  };
}

/** Scanner head on the tower mast (shared geometry, origin at the mast top) */
function scannerGeometry(kit) {
  const S = kit.S;
  const tilt = Math.PI / 2 - 0.4;
  const b = new PartBuilder();
  b.box(0.3, 0.5, 0.3, S.hullDark, { y: 0.25 });
  b.cylinder(1.3, 0.2, 0.3, 14, S.trim, { rx: tilt, y: 0.8, z: 0.2 });
  b.box(0.5, 0.35, 0.3, S.hullDark, { y: 0.75, z: -0.55 });
  b.box(0.2, 0.1, 0.05, S.team, { y: 0.9, z: -0.72 });
  return b.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sh = shapeOf(kit.style);
  const c = { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), emblems: [], vents: [], head: null };
  const parts = sh.kind === 'tower' ? buildTower(c) : buildHall(c, sh);
  const fans = c.vents.filter((v) => v.fan);
  const orbs = c.vents.filter((v) => v.ring);
  return {
    ...parts,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.emblems),
    head: c.head ? { ...c.head, geometry: scannerGeometry(kit) } : null,
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbs.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbs.length ? ringGeometry(kit, orbs[0].ring.r) : null,
  };
}

const HANGAR_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class AircraftHangarProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: HANGAR_CACHE, name: 'AircraftHangarProc' });
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
    const A = HANGAR_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;
    // This model is built in GLB coordinates, not around the origin: Structure centres it on the footprint with this
    this.glbCentre = HANGAR_GLB_CENTRE[shapeOf(kit.style).kind];

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.railGlow = layer('rail', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);
    this.curtainGlow = layer('curtain', gc.laser, true);

    // door leaves (slide sideways)
    this.leaves = null;
    if (sh.leaf) {
      const sp = sh.leafSpec;
      this.leafSpec = sp;
      this.leaves = [-1, 1].map((s) => {
        const mesh = this.paintMesh(sh.leaf, this, { far: true });   // far LOD: drawn frozen in its last pose
        mesh.position.set(s * sp.closed, sp.y, sp.z);
        return mesh;
      });
    }

    // roof lift plate (hall bodies)
    this.plate = null;
    if (sh.plate) {
      this.plate = this.paintMesh(sh.plate, this, { far: true });
      this.plate.position.set(sh.plateAt[0], sh.plateAt[1], sh.plateAt[2]);
      this.plateBaseY = sh.plateAt[1];
      this.padGlow = sh.plateGlow ? this.glowLayer(sh.plateGlow, gc.pulse, { parent: this.plate, visible: false }) : null;
    }

    // launch sled / ring along its strip
    this.sled = this.paintMesh(sh.sled);
    this.sled.position.set(sh.sledAt[0], sh.sledAt[1], sh.sledStops[1]);
    this.sledBaseY = sh.sledAt[1];
    this.sledGlow = sh.sledGlow ? this.glowLayer(sh.sledGlow, gc.pulse, { parent: this.sled, visible: false }) : null;
    this.sledMover = new TrackMover({
      rest: [sh.sledStops[1]], stops: [[sh.sledStops[0]], [sh.sledStops[1]]], speed: [A.sledSpeed * an.tempo],
      dwell: A.sledDwell, steps: an.jerk > 0 ? A.sledJerkSteps : 0,
    });
    this.ringSpin = sh.sledRing ? new Spinner(this.sled, { speed: A.ringSpin * an.spin, axis: 'z', ease: 1 }) : null;

    // fans, plasma-orb rings, scanner head
    this.drives = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      this.drives.push(new Spinner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), ease: 1, phase: (seq * 0.7 + i * 1.3) % TAU }));
    });
    this.fanDrives = this.drives.length;
    if (sh.head) {
      const head = this.paintMesh(sh.head.geometry);
      head.position.set(sh.head.x, sh.head.y, sh.head.z);
      this.head = new Spinner(head, { speed: A.scanSpeed * an.spin, phase: seq * 0.9 });
    } else this.head = null;
    this.levitators = [];
    const lev = PROC_MODULES.levitate;
    sh.orbSpots.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.orbRing);
      mesh.position.set(x, y, z);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });

    this.door = 0;       // 0 closed … 1 open (eased)
    this.lift = 0;
    this.power = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). Always: scanner turns, rail / plasma glow pulses dimly, beacons burn steadily.
   * While active (producing): the doors slide open (laser curtain fades), the roof lift plate rises, the sled shoots along
   * its strip, fans spin up, radiators / plasma / lasers glow fully, beacons blink.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const A = HANGAR_ANIM;
    const an = this.kit.style.anim;
    this.time += delta;
    this.door += ((active ? 1 : 0) - this.door) * Math.min(1, delta * A.doorEase);
    const open = smootherstep(this.door);
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.doorEase);

    if (this.leaves) {
      const sp = this.leafSpec;
      const x = sp.closed + (sp.open - sp.closed) * open;
      this.leaves[0].position.x = -x;
      this.leaves[1].position.x = x;
    }
    this.curtainGlow?.setIntensity(A.curtainMin + (1 - A.curtainMin) * (1 - open));

    if (this.plate) {
      this.lift += ((active && this.door > A.liftAfter ? 1 : 0) - this.lift) * Math.min(1, delta * A.liftEase);
      this.plate.position.y = this.plateBaseY + A.liftRise * smootherstep(this.lift);
      this.padGlow?.setIntensity(A.padIdle + (1 - A.padIdle) * this.lift);
    }

    this.sledMover.update(delta, active);
    this.sled.position.z = this.sledMover.value[0];
    if (this.ringSpin) {
      this.sled.position.y = this.sledBaseY + Math.sin(TAU * A.sledBobFreq * this.time) * A.sledBob * an.levitate;
      this.ringSpin.update(delta, active);
    }
    this.sledGlow?.setIntensity(active ? 1 : A.padIdle);

    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * this.power);
    this.pulseGlow?.setIntensity(glow);
    this.railGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);

    for (let i = 0; i < this.fanDrives; i++) this.drives[i].update(delta, active || this.power > 0.05);
    this.head?.update(delta, true);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);
  }
}
