// Steel Men – procedural Recon Tower (stealth detection: sonar / radar scanner on a tower; new building shared by all
// styles, data added by the coordinator). Built in code from the style modules (ProcModules.js):
//   • small footprint like a solar panel up to a tower: pad ±5.2 × ±5.2 (front = +Z), height about 20–25 units
//   • tower by style.silhouette (rounded: cabinet + column with a railed platform and a radar dish · angular: armoured
//     pillar with buttresses, spikes and a jerky lattice antenna · round: a stem with saucers, plasma orb + coils with
//     arcs and a floating gyroscope scanner · faceted: a blade mast with laser-linked outriggers and a floating crystal
//     scanner sweeping a laser beam); edges, neon, lights, vents, industrial parts, markings, texture, emblem come from
//     the style
//   • sonar: two expanding glow rings ("pings", thin horizontal tori scaled up and faded) leave the scanner head – slowly
//     while idle, faster and brighter while the building is active
//   • static body = one merged mesh (LODs) + emblem decals (1 draw call) + glow layers + a few animated parts (head, vent)
// Visual only: update() takes the frame delta, nothing here is read by the simulation. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, GlowBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, pipeRun, chimney, plasmaCoil, laserLink, arcGeometry, ArcFlicker, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
  teamTrim, roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const RECON_ANIM = {
  powerEase: 1.4,         // 1/s – how fast the tower spins up / down
  idleHead: 0.5,          // share of the head speed while idle
  jerkTicks: 14,          // ticks per revolution of the head when style.anim.jerk > 0 (stepped turning)
  fanSpeed: 4.2,          // rad/s at work (× style.anim.spin)
  fanIdle: 0.4,
  idleGlow: 0.45,         // core / beam / plasma glow share while idle
  idleBeacon: 0.4,        // beacon intensity while idle (they blink while active)
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
  arcSeed: 3317,
  ping: {
    period: 3.2,          // s per expansion (idle: × idleRate)
    idleRate: 0.55,
    exp: 1.6,             // brightness falls as (1 − t)^exp over the expansion
    idleLevel: 0.5,       // brightness share while idle
    tube: 0.05, segments: 64,
    min: [1.5, 2.5],      // start radius of ping A (at the head) / ping B (lower deck)
    max: [9, 12],         // end radius
  },
};

/** Shared layout (model units; origin = tower axis on the ground, front = +Z) */
const LAYOUT = {
  padHalf: 5.2, padH: 0.3, padSegments: 32, padRing: { inset: 0.35, tube: 0.06, lift: 0.04 },
  neonMin: 0.3,           // style.neon from which neon rings / strips are added
};

/**
 * Team paint (large surfaces, docs/notes/proc-teampaint-d.md; S.teamPaint / S.teamShade = team = 1 vertices, detail 2 = kept
 * in LOD2): rounded = belt round the cabinet + team lower column + lip + roof mark, angular = team tapered base, round = two
 * team saucers + pad lip, faceted = team base + shaded outriggers. Heads (they turn): team plate / bar / rings / discs.
 */
const TEAM = {
  detail: 2,
  rounded: { beltH: 0.8, beltOut: 0.02, lipInset: 0.15, mark: { z: 2.6, w: 2.6, d: 1.4 }, columnShare: 0.35 },
  round: { teamSaucers: [0, 1, 2], lipInset: 0.12, stemShare: 0.72 },   // stemShare: lower part of the stem is team paint
  dishPlate: [0.9, 0.6, 0.05],   // × head scale: back plate of the dish (was a thin neutral plate)
  latticeBar: 0.45,              // lattice head: share of the bar length that is team paint (centre section)
};

/** Dish geometry (radar head; sizes × head.scale) */
const DISH = { tilt: Math.PI / 2 - 0.4, base: [0.35, 0.2], mast: [0.3, 0.6], dish: [1.0, 0.15, 0.35], dishY: 0.9, dishZ: 0.15, rod: [0.03, 1.0], back: [0.5, 0.4, 0.3], plate: [0.2, 0.1, 0.05] };

/** Lattice antenna (angular head, absolute sizes) */
const LATTICE = { turn: [1.0, 1.2, 0.6], mast: [0.9, 2.4, 0.9], barY: 3.0, bar: [9, 0.6, 1.0], armX: 4.2, arm: [0.5, 3.0, 0.5], brace: 0.25, braceY: 1.6, plate: [8.4, 2.0, 0.2], plateZ: 0.6, spike: { y: 4.5, h: 1.4, r: 0.28 } };

/**
 * Dimensions by style.silhouette (code knows shapes, the style data picks one; unknown → rounded). `head` = the scanner:
 * kind, turn speed (rad/s × style.anim.spin), `lift` above the mount, `levitate` amplitude (0 = turns on the spot).
 */
const DIM = {
  rounded: {
    cabinet: { w: 7.2, h: 2.6 },
    band: { y: 0.3, h: 0.2, t: 0.06, w: 0.92 },
    mark: { len: 4.6, h: 0.5, y: 0.95, out: 0.02 },
    decal: { size: 1.5, y: 1.6 },
    column: { rTop: 1.25, rBottom: 1.75, h: 14, seg: 16 },
    neonRings: { ys: [0.4, 0.75], over: 0.04, tube: 0.06 },
    platform: { r: 3.0, h: 0.5, skirtH: 1.0, skirtR: 1.3 },
    rail: { r: 2.9, h: 0.95, tube: 0.07, posts: 8, post: 0.1 },
    pipe: { r: 0.18, points: [[-2.6, 0, -2.6], [-2.6, 2.6, -2.6], [-1.4, 2.6, -1.4]] },
    vent: { x: 2.5, z: 2.5, r: 0.8 },
    beacons: { x: 2.7 },
    head: { kind: 'dish', scale: 2.4, speed: 0.8, lift: 0.1, centre: 1.8, levitate: 0 },
    deck: 0.6,                                      // ping B height as a share of the tower height
    lug: 0,
  },
  angular: {
    skirt: { w: 9.6, h: 0.6, bandT: 0.06, bandH: 0.2 },
    base: { w: 9, topW: 7, h: 3.3 },
    pillar: { w: 4.4, topW: 2.8, h: 13 },
    buttress: { w: 1.6, topW: 0.8, h: 6.5, d: 2.2, topD: 1.1, at: 2.5 },
    platform: { w: 6.4, h: 0.9 },
    spikes: { at: 3, h: 1.3, r: 0.32 },
    decal: { size: 2.2, y: 3 },
    vent: { x: 2.85, r: 0.5 },
    chimney: { x: -2.85, h: 3.5, r: 0.45 },
    beacons: { z: 2.8 },
    head: { kind: 'lattice', speed: 0.55, lift: 0, centre: 3.0, levitate: 0 },
    deck: 0.6,
  },
  round: {
    base: { rTop: 2.6, rBottom: 3.8, h: 1.6, seg: 28 },
    stem: { rTop: 0.8, rBottom: 1.4, h: 14, seg: 20 },
    saucers: { ys: [4.5, 8.5, 12], r: 1.9, flat: 0.28, neonTube: 0.07 },
    cradle: { rTop: 1.6, rBottom: 0.9, h: 1.0, seg: 20 },
    decal: { size: 1.5, angles: [0, Math.PI / 2, Math.PI, Math.PI * 1.5] },
    vent: { x: 2.15, r: 0.8 },
    coils: { x: 3.9, z: -3, h: 4, r: 0.7 },
    beacons: { x: 4.4, z: 2.8 },
    head: { kind: 'gyro', r: 2.2, tube: 0.12, core: 1.1, halo: 2.0, speed: 1.4, lift: 2.4, centre: 2.4, levitate: 0.4 },
    deck: 0.6,
  },
  faceted: {
    pad: { neonR: 4.7, neonTube: 0.06 },
    base: { w: 6.4, h: 1.2 },
    mast: { w: 2.2, topW: 0.8, h: 19 },
    blades: { r: 1.5, w: 0.3, topW: 0.1, h: 11, d: 2.4, topD: 0.8, strip: 0.08, stripH: 10.5, stripR: 2.7 },
    decal: { size: 1.2, y: 4.5 },
    outrigger: { x: 4, z: 4, w: 0.9, topW: 0.4, h: 5.5, linkYs: [3, 4.8], target: 0.67 },
    vent: { at: 2.3, r: 0.7 },                      // on the base roof corner (clear of the blades on the axes)
    beacons: {},
    head: { kind: 'crystal', size: 1.0, stretch: 2, discR: 2.4, discH: 0.12, discDy: 1.6, lensR: 0.2, beamLen: 12, beamT: 0.14, speed: 2.2, lift: 2.8, centre: 2.8, levitate: 0, lasers: 4, laserR: 0.7, laserTopR: 0.25, laserLift: 0.4 },
    deck: 0.6,
  },
};

const BODIES = {};   // filled below (silhouette → tower builder)

// ---------------------------------------------------------------- small helpers (construction time only)

/** Pad: 'box' / 'round' / 'octagon' (flat faces on the axes) */
function foundation(c, kind) {
  const L = LAYOUT;
  const { b, S, kit } = c;
  const ring = kit.style.neon >= L.neonMin;
  if (kind === 'round') {
    b.cylinder(L.padHalf, L.padHalf, L.padH, L.padSegments, S.ground, { y: L.padH / 2 });
    if (ring) b.torus(L.padHalf - L.padRing.inset, L.padRing.tube, 4, L.padSegments * 2, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + L.padRing.lift });
  } else if (kind === 'octagon') {
    const D = DIM.faceted;
    const r = L.padHalf / Math.cos(Math.PI / 8);
    b.cylinder(r, r, L.padH, 8, S.ground, { y: L.padH / 2, ry: Math.PI / 8 });
    if (ring) b.torus(D.pad.neonR, D.pad.neonTube, 4, L.padSegments * 2, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + L.padRing.lift });
  } else {
    b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  }
}

/** Wall decal; `tilt` leans the normal upwards (sloped walls) */
function wallDecal(c, position, nx, nz, size, tilt = 0) {
  c.decals.push({ position, normal: [nx * Math.cos(tilt), Math.sin(tilt), nz * Math.cos(tilt)], size });
}

function beacons(c, list) {
  for (const p of list) beacon(c.b, c.glows.get('beaconA'), c.kit, p);
}

/** Records the scanner head: mount point, height of ping A / B */
function setHead(c, D, mountY, towerTop) {
  c.head = { ...D.head, x: 0, y: mountY + D.head.lift, z: 0 };
  c.pingY = [mountY + D.head.centre, towerTop * D.deck];
}

// ---------------------------------------------------------------- towers (one per silhouette)

/** rounded: cabinet with a guarded fan, round column with neon rings, railed platform (hazard style), radar dish */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit } = c;
  const L = LAYOUT;
  foundation(c, 'box');
  const C = D.cabinet;
  const y1 = L.padH + C.h;
  styledBox(b, kit, C.w, C.h, C.w, S.hull, { base: true, y: L.padH });
  const Tm = TEAM.rounded;
  b.box(C.w + 2 * Tm.beltOut, Tm.beltH, C.w + 2 * Tm.beltOut, S.teamPaint, { y: L.padH + Tm.beltH / 2, detail: TEAM.detail });   // belt below the emblem decals
  teamTrim(b, kit, { y: y1, w: C.w - Tm.lipInset, d: C.w - Tm.lipInset }, { detail: TEAM.detail });
  roofMark(b, kit, { y: y1, z: Tm.mark.z, w: Tm.mark.w, d: Tm.mark.d }, { detail: TEAM.detail });
  for (const e of [-1, 1]) {
    wallDecal(c, [0, L.padH + D.decal.y, e * C.w / 2], 0, e, D.decal.size);
    wallDecal(c, [e * C.w / 2, L.padH + D.decal.y, 0], e, 0, D.decal.size);
  }
  marking(b, kit, D.mark.len, D.mark.h, { y: L.padH + D.mark.y, z: C.w / 2 + D.mark.out });
  const K = D.column;
  const y2 = y1 + K.h;
  const kt = Tm.columnShare;   // lower part of the column = team paint
  const rSplit = K.rBottom + (K.rTop - K.rBottom) * kt;
  b.cylinder(rSplit, K.rBottom, K.h * kt, K.seg, S.teamPaint, { y: y1 + (K.h * kt) / 2, detail: TEAM.detail });
  b.cylinder(K.rTop, rSplit, K.h * (1 - kt), K.seg, S.hull, { y: y1 + K.h * kt + (K.h * (1 - kt)) / 2 });
  if (kit.style.neon >= L.neonMin) {
    for (const k of D.neonRings.ys) {
      const r = K.rBottom + (K.rTop - K.rBottom) * k + D.neonRings.over;
      b.torus(r, D.neonRings.tube, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: y1 + K.h * k });
    }
  }
  const P = D.platform;
  b.cylinder(P.r, P.skirtR, P.skirtH, 16, S.hullDark, { y: y2 - P.skirtH / 2 });
  b.cylinder(P.r, P.r, P.h, 24, S.frame, { y: y2 + P.h / 2 });
  const y3 = y2 + P.h;
  if (kit.style.markings === 'hazard') {
    const R = D.rail;
    b.torus(R.r, R.tube, 4, 32, TAU, S.accent, { rx: Math.PI / 2, y: y3 + R.h });
    for (let i = 0; i < R.posts; i++) {
      const a = (i / R.posts) * TAU;
      b.box(R.post, R.h, R.post, S.frame, { base: true, x: Math.cos(a) * R.r, y: y3, z: Math.sin(a) * R.r });
    }
  }
  const V = D.vent;
  c.vents.push(ventUnit(b, c.glows, kit, { x: V.x, y: y1, z: V.z, r: V.r }));
  pipeRun(b, kit, D.pipe.points.map(([x, y, z]) => [x, y1 + y, z]), D.pipe.r);
  beacons(c, [[-D.beacons.x, y3, 0], [D.beacons.x, y3, 0]]);
  setHead(c, D, y3, y3);
};

/** angular: armoured plinth + tapered pillar with buttresses, spiked platform, open fan, chimney, lattice antenna */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit } = c;
  const L = LAYOUT;
  foundation(c, 'box');
  const Sk = D.skirt;
  const y0 = L.padH + Sk.h;
  b.box(Sk.w, Sk.h, Sk.w, S.hullDark, { base: true, y: L.padH });
  const Ba = D.base;
  b.taperedBox(Ba.w, Ba.topW, Ba.h, Ba.w, S.teamPaint, { y: y0, detail: TEAM.detail }, Ba.topW);   // armoured base = team paint
  const y1 = y0 + Ba.h;
  const Pi = D.pillar;
  b.taperedBox(Pi.w, Pi.topW, Pi.h, Pi.w, S.hull, { y: y1 }, Pi.topW);
  const y2 = y1 + Pi.h;
  const tilt = Math.atan2((Pi.w - Pi.topW) / 2, Pi.h);
  const half = Pi.w / 2 - ((Pi.w - Pi.topW) / 2) * (D.decal.y / Pi.h);
  for (const e of [-1, 1]) {
    wallDecal(c, [0, y1 + D.decal.y, e * half], 0, e, D.decal.size, tilt);
    wallDecal(c, [e * half, y1 + D.decal.y, 0], e, 0, D.decal.size, tilt);
  }
  const Bt = D.buttress;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.taperedBox(Bt.w, Bt.topW, Bt.h, Bt.d, S.hullDark, { x: sx * Bt.at, y: y1, z: sz * Bt.at, ry: Math.atan2(sx, sz) }, Bt.topD);
      spike(b, kit, { x: sx * D.spikes.at, y: y2 + D.platform.h, z: sz * D.spikes.at, h: D.spikes.h, r: D.spikes.r });
    }
  }
  b.box(D.platform.w, D.platform.h, D.platform.w, S.hullDark, { base: true, y: y2 });
  const y3 = y2 + D.platform.h;
  c.vents.push(ventUnit(b, c.glows, kit, { x: D.vent.x, y: y1, z: 0, r: D.vent.r }));
  chimney(b, kit, { x: D.chimney.x, y: y1, z: 0, h: D.chimney.h, r: D.chimney.r });
  beacons(c, [[0, y3, D.beacons.z], [0, y3, -D.beacons.z]]);
  setHead(c, D, y3, y3);
};

/** round: base dome, stem with saucers and neon rings, plasma orb, coils with arcs, gyroscope scanner above a cradle */
BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  foundation(c, 'round');
  teamTrim(b, kit, { y: L.padH, r: L.padHalf - TEAM.round.lipInset }, { detail: TEAM.detail });
  const Ba = D.base;
  const y1 = L.padH + Ba.h;
  b.cylinder(Ba.rTop, Ba.rBottom, Ba.h, Ba.seg, S.hull, { y: L.padH + Ba.h / 2 });
  const slope = Ba.rBottom - Ba.rTop;
  const nl = Math.hypot(Ba.h, slope);
  const rMid = (Ba.rTop + Ba.rBottom) / 2;
  for (const a of D.decal.angles) {
    c.decals.push({ position: [Math.cos(a) * rMid, L.padH + Ba.h / 2, Math.sin(a) * rMid], normal: [(Ba.h / nl) * Math.cos(a), slope / nl, (Ba.h / nl) * Math.sin(a)], size: D.decal.size });
  }
  const St = D.stem;
  const y2 = y1 + St.h;
  const stemShare = TEAM.round.stemShare;
  const stemSplit = St.rBottom + (St.rTop - St.rBottom) * stemShare;
  b.cylinder(stemSplit, St.rBottom, St.h * stemShare, St.seg, S.teamPaint, { y: y1 + (St.h * stemShare) / 2, detail: TEAM.detail });
  b.cylinder(St.rTop, stemSplit, St.h * (1 - stemShare), St.seg, S.hull, { y: y1 + St.h * stemShare + (St.h * (1 - stemShare)) / 2 });
  const Sa = D.saucers;
  for (const y of Sa.ys) {
    const teamed = TEAM.round.teamSaucers.includes(Sa.ys.indexOf(y));
    b.sphere(Sa.r, 20, 10, teamed ? S.teamPaint : S.hullDark, { y: y1 + y, sy: Sa.flat, ...(teamed ? { detail: TEAM.detail } : {}) });
    if (kit.rich) b.torus(Sa.r, Sa.neonTube, 4, 28, TAU, S.neon, { rx: Math.PI / 2, y: y1 + y });
  }
  const Cr = D.cradle;
  b.cylinder(Cr.rTop, Cr.rBottom, Cr.h, Cr.seg, S.hullDark, { y: y2 + Cr.h / 2 });
  const y3 = y2 + Cr.h;
  c.vents.push(ventUnit(b, glows, kit, { x: D.vent.x, y: y1, z: 0, r: D.vent.r }));
  const K = D.coils;
  const tops = [];
  for (const s of [-1, 1]) tops.push(plasmaCoil(b, glows.get('pulse'), kit, { x: s * K.x, y: L.padH, z: K.z, h: K.h, r: K.r }));
  c.arcPairs.push([tops[0], tops[1]]);
  beacons(c, [[-D.beacons.x, L.padH, D.beacons.z], [D.beacons.x, L.padH, D.beacons.z]]);
  setHead(c, D, y3, y3 + D.head.lift);
  glows.get('core').sphere(D.head.halo, 16, 10, { y: c.head.y });
};

/** faceted: slim blade mast on a chamfered base, laser-linked outriggers, radiator, a crystal scanner held by lasers */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const laser = glows.get('laser');
  foundation(c, 'octagon');
  const Ba = D.base;
  const y1 = L.padH + Ba.h;
  styledBox(b, kit, Ba.w, Ba.h, Ba.w, S.teamPaint, { base: true, y: L.padH, detail: TEAM.detail });   // base = team paint
  const M = D.mast;
  const y2 = y1 + M.h;
  b.taperedBox(M.w, M.topW, M.h, M.w, S.hullDark, { y: y1, ry: Math.PI / 4 }, M.topW);
  const run = (M.w - M.topW) / 2;
  const tilt = Math.atan2(run, M.h);
  const apothem = M.w / 2 - run * (D.decal.y / M.h);
  const diag = Math.SQRT1_2;
  const Bl = D.blades;
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2;
    const sx = Math.round(Math.sin(ry));
    const sz = Math.round(Math.cos(ry));
    b.taperedBox(Bl.w, Bl.topW, Bl.h, Bl.d, S.hull, { x: sx * Bl.r, y: y1, z: sz * Bl.r, ry }, Bl.topD);
    if (kit.rich) neonStrip(b, kit, Bl.strip, Bl.stripH, Bl.strip, { x: sx * Bl.stripR, y: y1 + Bl.stripH / 2, z: sz * Bl.stripR });
    const dx = k < 2 ? 1 : -1;
    const dz = k % 3 === 0 ? 1 : -1;
    wallDecal(c, [dx * apothem * diag, y1 + D.decal.y, dz * apothem * diag], dx * diag, dz * diag, D.decal.size, tilt);
  }
  const O = D.outrigger;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * O.x;
      const z = sz * O.z;
      b.taperedBox(O.w, O.topW, O.h, O.w, S.teamShade, { x, y: L.padH, detail: TEAM.detail });
      for (const ly of O.linkYs) laserLink(b, laser, kit, [x, L.padH + ly, z], [sx * O.target, L.padH + ly, sz * O.target]);
    }
  }
  c.vents.push(ventUnit(b, c.glows, kit, { x: D.vent.at, y: y1, z: D.vent.at, r: D.vent.r }));
  beacon(b, glows.get('beaconA'), kit, [0, y2, 0]);
  setHead(c, D, y2, y2);
  const H = D.head;
  const bottom = c.head.y - H.size * H.stretch * 0.9;
  for (let i = 0; i < H.lasers; i++) {
    const a = (i * TAU) / H.lasers + Math.PI / 4;
    laserLink(b, laser, kit, [Math.cos(a) * H.laserR, y2 + H.laserLift, Math.sin(a) * H.laserR], [Math.cos(a) * H.laserTopR, bottom, Math.sin(a) * H.laserTopR]);
  }
};

// ---------------------------------------------------------------- scanner heads (shared, origin at the head centre)

function dishHead(kit, H) {
  const S = kit.S;
  const k = H.scale;
  const b = new PartBuilder();
  const D = DISH;
  b.cylinder(D.base[0] * k, D.base[0] * k, D.base[1] * k, 12, S.frame, { y: (D.base[1] / 2) * k });
  b.box(D.mast[0] * k, D.mast[1] * k, D.mast[0] * k, S.hullDark, { y: (D.base[1] + D.mast[1] / 2) * k });
  b.cylinder(D.dish[0] * k, D.dish[1] * k, D.dish[2] * k, 16, S.trim, { rx: D.tilt, y: D.dishY * k, z: D.dishZ * k });
  b.cylinder(D.rod[0] * k, D.rod[0] * k, D.rod[1] * k, 6, S.frame, {
    rx: D.tilt, y: (D.dishY + Math.cos(D.tilt) * D.rod[1] / 2) * k, z: (D.dishZ + Math.sin(D.tilt) * D.rod[1] / 2) * k,
  });
  b.box(D.back[0] * k, D.back[1] * k, D.back[2] * k, S.teamPaint, { y: (D.dishY - 0.05) * k, z: -D.back[0] * k });
  b.box(TEAM.dishPlate[0] * k, TEAM.dishPlate[1] * k, TEAM.dishPlate[2] * k, S.teamShade, { y: (D.dishY - 0.05) * k, z: -(D.back[0] + D.back[2] / 2 + TEAM.dishPlate[2] / 2) * k });
  return b.build();
}

function latticeHead(kit) {
  const S = kit.S;
  const Lt = LATTICE;
  const b = new PartBuilder();
  b.cylinder(Lt.turn[0], Lt.turn[1], Lt.turn[2], 8, S.hullDark, { y: Lt.turn[2] / 2 });
  b.box(Lt.mast[0], Lt.mast[1], Lt.mast[2], S.frame, { y: Lt.turn[2] + Lt.mast[1] / 2 });
  b.box(Lt.bar[0], Lt.bar[1], Lt.bar[2], S.hullDark, { y: Lt.barY });
  b.box(Lt.bar[0] * TEAM.latticeBar, Lt.bar[1] * 1.1, Lt.bar[2] * 1.1, S.teamPaint, { y: Lt.barY });   // team centre section of the bar
  b.box(Lt.plate[0], Lt.plate[1], Lt.plate[2], S.dark, { y: Lt.barY, z: Lt.plateZ });
  const dx = Lt.armX;
  const dy = Lt.barY - Lt.braceY;
  const len = Math.hypot(dx, dy);
  for (const s of [-1, 1]) {
    b.box(Lt.arm[0], Lt.arm[1], Lt.arm[2], S.frame, { x: s * dx, y: Lt.barY });
    b.box(len, Lt.brace, Lt.brace, S.frame, { x: (s * dx) / 2, y: Lt.barY - dy / 2, rz: -s * Math.atan2(dy, dx) });
    spike(b, kit, { x: s * dx, y: Lt.spike.y, z: 0, h: Lt.spike.h, r: Lt.spike.r });
  }
  return b.build();
}

function gyroHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.sphere(H.core, 16, 10, S.plasma, {});
  b.torus(H.r, H.tube, 6, 28, TAU, S.trim, { rx: Math.PI / 2 });
  b.torus(H.r, H.tube, 6, 28, TAU, S.teamPaint, {});
  b.torus(H.r, H.tube, 6, 28, TAU, S.trim, { ry: Math.PI / 2 });
  return b.build();
}

function crystalHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  const g = new THREE.OctahedronGeometry(H.size, 0);
  g.scale(1, H.stretch, 1);
  b.add(g, S.plasma);
  for (const s of [-1, 1]) b.box(H.discR * 2, H.discH, H.discR * 2, S.teamPaint, { y: s * H.discDy, ry: Math.PI / 4 });
  b.cylinder(H.lensR, H.lensR, H.lensR * 2, 8, S.lens, { x: H.discR + H.lensR, rz: Math.PI / 2 });
  return b.build();
}

const HEAD_BUILDERS = { dish: dishHead, lattice: latticeHead, gyro: gyroHead, crystal: crystalHead };

/** Sweeping laser beam of the crystal scanner (local to the head, along +X) */
function beamGeometry(H) {
  const g = new GlowBuilder();
  g.segment([H.discR + H.lensR * 2, 0, 0], [H.beamLen, 0, 0], H.beamT);
  g.point([H.beamLen, 0, 0], H.beamT * 5);
  return g.build();
}

/** Thin horizontal ring of radius 1 (scaled up by update() to make a sonar ping) */
function pingGeometry() {
  const P = RECON_ANIM.ping;
  const g = new GlowBuilder();
  g.torus(1, P.tube, 4, P.segments, TAU, { rx: Math.PI / 2 });
  return g.build();
}

/** Turning head that speeds up with the building's power (idle share → full), optionally in stepped ticks (jerk) */
class TurnDrive {
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
    kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [], arcPairs: [], head: null, pingY: [0, 0],
  };
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbRings = c.vents.filter((v) => v.ring);
  const H = c.head;
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    head: { kind: H.kind, x: H.x, y: H.y, z: H.z, speed: H.speed, levitate: H.levitate, geometry: HEAD_BUILDERS[H.kind](kit, H) },
    beam: H.kind === 'crystal' ? beamGeometry(H) : null,
    ping: pingGeometry(),
    pingY: c.pingY,
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbRings.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbRings.length ? ringGeometry(kit, orbRings[0].ring.r) : null,
    arcs: c.arcPairs.length ? arcGeometry(c.arcPairs, RECON_ANIM.arcSeed) : null,
  };
}

const RECON_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class ReconTowerProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: RECON_CACHE, name: 'ReconTowerProc' });
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
    const A = RECON_ANIM;
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

    // scanner head: turns (stepped ticks when the style is jerky) or floats; the sweep beam is its child
    const head = this.paintMesh(sh.head.geometry, this, { far: true });   // far LOD: drawn instanced, frozen in its last pose
    head.position.set(sh.head.x, sh.head.y, sh.head.z);
    this.drive = null;
    this.levitator = null;
    if (sh.head.levitate > 0) {
      const lev = PROC_MODULES.levitate;
      this.levitator = new Levitator(head, { amp: sh.head.levitate * an.levitate, spin: sh.head.speed * an.spin, freq: lev.freq, phase: seq * 0.37 });
    } else {
      const step = an.jerk > 0 ? TAU / A.jerkTicks : 0;
      this.drive = new TurnDrive(head, { speed: sh.head.speed * an.spin, idle: A.idleHead, step, phase: seq * 0.9 });
    }
    this.beamGlow = sh.beam ? this.glowLayer(sh.beam, gc.beam, { parent: head }) : null;

    // vent parts: fan turns, plasma ring floats (style-driven; radiator styles have neither)
    this.fans = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      this.fans.push(new TurnDrive(fan, { speed: A.fanSpeed * an.spin * (i % 2 ? -1 : 1), idle: A.fanIdle, phase: (seq * 0.7 + i * 1.3) % TAU }));
    });
    const lev = PROC_MODULES.levitate;
    this.rings = [];
    sh.orbSpots.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.orbRing);
      mesh.position.set(x, y, z);
      this.rings.push(new Levitator(mesh, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });

    // sonar pings: two expanding rings, half a period apart
    this.pings = [0, 1].map((i) => {
      const l = this.glowLayer(sh.ping, gc.pulse, { visible: false });
      l.mesh.position.y = sh.pingY[i];
      return l;
    });
    this.pingClock = (seq * A.phaseStep) % 1;

    this.power = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). Always: the scanner turns slowly, sonar pings leave it slowly, glow pulses
   * dimly, beacons burn steadily. While active: the head and fans spin up, pings come faster and brighter, glow / beam /
   * plasma shine fully, radiators heat up, arcs flash, beacons blink.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = RECON_ANIM;
    const P = A.ping;
    this.time += delta;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    this.drive?.update(delta, this.power);
    this.levitator?.update(delta, active);
    for (let i = 0; i < this.fans.length; i++) this.fans[i].update(delta, this.power);
    for (let i = 0; i < this.rings.length; i++) this.rings[i].update(delta, active);

    const level = P.idleLevel + (1 - P.idleLevel) * this.power;
    this.pingClock = (this.pingClock + (delta * (P.idleRate + (1 - P.idleRate) * this.power)) / P.period) % 1;
    for (let i = 0; i < this.pings.length; i++) {
      const t = (this.pingClock + i * 0.5) % 1;
      const s = P.min[i] + (P.max[i] - P.min[i]) * t;
      this.pings[i].mesh.scale.set(s, 1, s);
      this.pings[i].setIntensity(Math.pow(1 - t, P.exp) * level);
    }

    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * this.power);
    this.coreGlow?.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.beamGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(delta, active);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
