// Steel Mans – procedural advanced research facility (a data relay). A drop-in alternative to
// models/3DStructures{race}/DataRelay{race}_Anim.glb built in code from the style modules (ProcModules.js) and the
// faction style (data/buildingStyles.json). Unlike the research facility (a lab hall + a core tower) this is ONE slim relay
// tower on a small plinth with a signal head, so the two are easy to tell apart at a glance:
//   • footprint: pad ±4.1 × ±4.1 around the model origin (GLB: ±4.1×±4.9 / ±5.5×±4.25 / ±5.75), front = +Z, height ≈ 15
//   • body per style.silhouette (BODIES): rounded = bunker block + round shaft with a railed platform and 2 radar dishes ·
//     angular = armoured bunker + massive tapered tower, spikes, 1 heavy dish · round = disc + 3 stacked pods, plasma orb
//     with levitating rings and 3 relay nodes joined by arcs · faceted = stage + diamond spire, floating crystal held by
//     lasers and 4 mirror pylons beaming at the spire
//   • the relay signal: 3 expanding glow rings run up the tower (one shared geometry, 3 glow layers = 3 draw calls)
//   • animated: dishes / levitating rings / floating crystal (faster while researching), signal rings, pulsing core strip,
//     radiators heat (faceted), arcs (round), beacons blink; slower and dimmer when idle
// Visual only: update() reads nothing from the simulation, no allocations there.
import * as THREE from 'three';
import { PartBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, chimney, laserLink, arcGeometry, ArcFlicker, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; style.anim multiplies speeds) */
export const RELAY_ANIM = {
  fanSpeed: 4.0,          // rad/s (× style.anim.spin)
  fanJitter: 0.25,
  dishSpeed: 0.9,         // rad/s (× style.anim.spin)
  idleShare: 0.35,        // speed share of the moving parts while idle
  idleGlow: 0.4,          // core / laser glow share while idle
  signalRate: 0.35,       // signal ring cycles per second while researching
  signalIdle: 0.4,        // share of the rate / brightness while idle
  signalGrow: 0.4,        // ring radius grows by this share on its way up
  signalCount: 3,
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.41,        // s – phase offset per instance
  arcSeed: 9137,
};

/** Shared layout (model units, GLB scale; front = +Z) */
const LAYOUT = {
  padHalf: 4.1, padH: 0.15,
  neonMin: 0.3,           // style.neon from which neon trim is added
  decalMargin: 0.02,
};

/** Small details (model units) */
const DETAIL = {
  band: { h: 0.25, t: 0.06 },
  door: { jamb: 0.3, jambD: 0.3, headerH: 0.3, interiorT: 0.05, interiorOut: 0.03, markH: 0.4, neonH: 0.08, neonT: 0.04 },
  plate: { pad: 0.15, d: 0.6 },                          // emblem plate on the tower: size × (1 + pad), depth d
  spike: { h: 0.8, r: 0.2 },
  rail: { tube: 0.05, post: 0.06, segments: 20 },
  strip: { w: 0.18, t: 0.05, out: 0.04 },                 // glowing core strip along a tower face / surface
  dish: { stemH: 0.35, tilt: 0.4, depth: 0.35, rod: 0.03 },
  crystal: { stretch: 2.0, halo: 1.3 },
  pylon: { rTop: 0.2, rBottom: 0.35, lensR: 0.26 },
};

/** Dimensions of every body by style.silhouette (unknown → rounded); all inside the pad */
const DIM = {
  rounded: {
    base: { w: 7.4, h: 3.0, d: 7.4, edge: 1 },
    door: { w: 1.4, h: 2.1 },
    window: { y: 1.9, h: 0.5, len: 3.0, t: 0.05 },
    band: { y: 2.7 },
    shaft: { rTop: 1.1, rBottom: 1.7, h: 8.0, seg: 20, rings: [0.35, 0.7] },
    plate: { y: 1.9, size: 1.5 },
    platform: { r: 2.2, h: 0.3, rail: 2.1, railH: 0.9, posts: 8 },
    vents: [[-2.6, 2.6], [2.6, 2.6]], ventR: 0.65,
    dishes: [{ x: -1.1, z: 0.6, r: 0.95, mast: 1.4, speed: 1 }, { x: 1.1, z: -0.6, r: 0.95, mast: 2.0, speed: -1 }],
    antenna: { r: 0.1, h: 3.0 },
    signal: { r: 1.95 },
  },
  angular: {
    block: { w: 7.6, h: 1.0 }, slope: { w: 7.0, topW: 5.2, h: 1.6 },
    door: { w: 1.6, h: 0.8 },
    spikes: { x: 3.55, z: 3.55, h: 0.7, r: 0.2 },
    tower: { w: 3.0, topW: 2.0, h: 9.0 },
    plate: { y: 2.0, size: 1.5 },
    platform: { w: 3.6, h: 0.4 },
    vents: [[-2.05, 2.05], [2.05, 2.05]], ventR: 0.45,
    chimneys: [[-2.05, -2.05], [2.05, -2.05]], chimneyH: 1.8, chimneyR: 0.3,
    dish: { r: 1.8, mast: 1.1 },
    horns: [[-1.2, -1.2, 2.2], [1.2, -1.2, 1.5], [-1.2, 1.2, 1.5], [1.2, 1.2, 2.2]],   // x, z, height of the roof spikes
    signal: { r: 1.9 },
  },
  round: {
    disc: { r: 3.9, h: 0.9 },
    pods: [{ r: 2.4, sy: 0.75, y: 2.0 }, { r: 2.0, sy: 0.8, y: 4.2 }, { r: 1.6, sy: 0.85, y: 6.2 }],
    plate: { y: 2.0, z: 2.4, size: 1.4 },
    seams: [{ r: 2.15, y: 3.1 }, { r: 1.8, y: 5.2 }],
    core: { r: 0.5 },
    nodes: { r: 2.9, y: 8.3, orbR: 0.45, rod: 0.08, angles: [Math.PI / 2, Math.PI * 7 / 6, Math.PI * 11 / 6] },
    orb: { r: 1.0, y: 11.5, halo: 1.5 },
    rings: [{ r: 1.9, dy: 0.4, tube: 0.06 }, { r: 2.4, dy: -0.5, tube: 0.06 }], ringAmp: 0.25,
    vents: [[-2.6, 2.6], [2.6, 2.6]], ventR: 0.6,
    signal: { r: 2.6 },
  },
  faceted: {
    stage: { rTop: 3.9, rBottom: 4.0, h: 0.5, segments: 8, neonTube: 0.06 },
    spire: [{ w: 3.2, topW: 2.5, h: 2.8 }, { w: 2.5, topW: 1.9, h: 3.0 }, { w: 1.9, topW: 1.3, h: 3.2 }, { w: 1.3, topW: 0.9, h: 2.6 }],
    seam: { h: 0.08, over: 0.04 },
    crystal: { size: 0.9, lift: 2.4, laserR: 0.7, laserTop: 0.35, lasers: 4, amp: 0.3 },
    pylons: { x: 3.5, z: 3.5, h: 2.4, hit: 6.0, reach: 1.0 },
    vents: [[-3.2, 0], [3.2, 0]], ventR: 0.5,
    plate: { w: 2.0, topW: 0.8, h: 2.2, d: 0.4, topD: 0.25, z: 3.0, decalY: 0.9 },
    apron: { len: 2.6, h: 0.4, z: 3.65 },
    signal: { r: 1.9 },
  },
};

const BODIES = {};   // silhouette → body function (filled below)

// ---------------------------------------------------------------- shared helpers (construction time only)

/** Pad under every body */
function pad(c) {
  const L = LAYOUT;
  c.b.box(L.padHalf * 2, L.padH, L.padHalf * 2, c.S.ground, { base: true });
}

/** Emblem plate standing on a flat face (centre z of the face line, y, size): box + decal on its front */
function emblemPlate(c, y, z, size) {
  const P = DETAIL.plate;
  c.b.box(size * (1 + P.pad), size * (1 + P.pad), P.d, c.S.hullDark, { y, z: z + P.d / 2 - 0.1 });
  c.decals.push({ position: [0, y, z + P.d - 0.1 + LAYOUT.decalMargin], normal: [0, 0, 1], size });
}

/** Entrance in a front face at z (floor y0): interior glow, jambs with markings, header, beacons */
function door(c, z, y0, w, h) {
  const { b, S, kit, glows } = c;
  const Dd = DETAIL.door;
  b.box(w, h, Dd.interiorT, S.interior, { base: true, y: y0, z: z + Dd.interiorOut });
  for (const s of [-1, 1]) {
    b.box(Dd.jamb, h, Dd.jambD, S.frame, { base: true, x: s * (w / 2 + Dd.jamb / 2), y: y0, z: z + Dd.jambD / 2 - 0.05 });
    beacon(b, glows.get('beaconA'), kit, [s * (w / 2 + Dd.jamb / 2), y0 + h, z + Dd.jambD / 2 - 0.05]);
  }
  b.box(w + Dd.jamb * 2, Dd.headerH, Dd.jambD, S.frame, { base: true, y: y0 + h, z: z + Dd.jambD / 2 - 0.05 });
  marking(b, kit, w, Dd.markH, { y: y0 + Dd.markH, z: z + Dd.jambD + 0.02 - 0.05 });
  if (kit.style.neon >= LAYOUT.neonMin) neonStrip(b, kit, w + Dd.jamb * 2, Dd.neonH, Dd.neonT, { y: y0 + h + Dd.headerH + Dd.neonH / 2, z: z + Dd.jambD / 2 - 0.05 });
}

/** Neon ring around a tower / pod at height y */
function neonRing(c, r, y, tube = 0.06) {
  if (c.kit.style.neon < LAYOUT.neonMin) return;
  c.b.torus(r, tube, 4, 24, TAU, c.S.neon, { rx: Math.PI / 2, y });
}

/** Pole of the signal: y range and ring radius, used by the animated rings */
const setSignal = (c, y0, y1, r) => { c.signal = { y0, y1, r }; };

// ---------------------------------------------------------------- bodies

/** rounded: bunker block, tapering round shaft with neon bands, railed platform, radar dishes, antenna, guarded vents */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  pad(c);
  const Bs = D.base;
  styledBox(b, kit, Bs.w, Bs.h, Bs.d, S.hull, { base: true, y: L.padH }, Bs.edge);
  const y1 = L.padH + Bs.h;
  const front = Bs.d / 2;
  door(c, front, L.padH, D.door.w, D.door.h);
  b.box(Bs.w * 0.96, DETAIL.band.h, DETAIL.band.t, S.team, { y: L.padH + D.band.y, z: front + DETAIL.band.t / 2 });
  for (const s of [-1, 1]) b.box(D.window.t, D.window.h, D.window.len, S.window, { x: s * (Bs.w / 2 + D.window.t / 2), y: L.padH + D.window.y, z: 0 });
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: y1, z, r: D.ventR }));

  // shaft
  const Sh = D.shaft;
  b.cylinder(Sh.rTop, Sh.rBottom, Sh.h, Sh.seg, S.hullDark, { y: y1 + Sh.h / 2 });
  const rAt = (k) => Sh.rBottom + (Sh.rTop - Sh.rBottom) * k;
  for (const k of Sh.rings) neonRing(c, rAt(k) + 0.03, y1 + Sh.h * k);
  glows.get('pulse').segment([0, y1, Sh.rBottom + DETAIL.strip.out], [0, y1 + Sh.h, Sh.rTop + DETAIL.strip.out], DETAIL.strip.t);
  emblemPlate(c, y1 + D.plate.y, rAt(D.plate.y / Sh.h) - 0.1, D.plate.size);

  // platform with a guard rail (safety styles), antenna and the dishes
  const top = y1 + Sh.h;
  const P = D.platform;
  b.cylinder(P.r, P.r, P.h, Sh.seg, S.frame, { y: top + P.h / 2 });
  if (kit.style.markings === 'hazard') {
    b.torus(P.rail, DETAIL.rail.tube, 4, DETAIL.rail.segments, TAU, S.accent, { rx: Math.PI / 2, y: top + P.h + P.railH });
    for (let i = 0; i < P.posts; i++) {
      const a = (i / P.posts) * TAU;
      b.box(DETAIL.rail.post, P.railH, DETAIL.rail.post, S.frame, { base: true, x: Math.cos(a) * P.rail, y: top + P.h, z: Math.sin(a) * P.rail });
    }
  }
  const pt = top + P.h;
  b.cylinder(D.antenna.r, D.antenna.r, D.antenna.h, 8, S.frame, { y: pt + D.antenna.h / 2 });
  beacon(b, glows.get('beaconA'), kit, [0, pt + D.antenna.h, 0]);
  for (const d of D.dishes) {
    b.cylinder(0.12, 0.12, d.mast, 8, S.frame, { x: d.x, y: pt + d.mast / 2, z: d.z });
    c.parts.push({ kind: 'dish', x: d.x, y: pt + d.mast, z: d.z, r: d.r, speed: d.speed });
  }
  setSignal(c, y1, pt + D.antenna.h, D.signal.r);
};

/** angular: armoured bunker with spikes, massive tapered tower, spiked platform, one heavy dish, open fans, chimneys */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  pad(c);
  const bh = D.block.w / 2;
  b.box(D.block.w, D.block.h, D.block.w, S.lower, { base: true, y: L.padH });
  b.taperedBox(D.slope.w, D.slope.topW, D.slope.h, D.slope.w, S.hull, { y: L.padH + D.block.h }, D.slope.topW);
  const y1 = L.padH + D.block.h + D.slope.h;
  door(c, bh, L.padH, D.door.w, D.door.h);
  for (const s of [-1, 1]) b.box(DETAIL.band.t, DETAIL.band.h, D.block.w * 0.95, S.team, { x: s * (bh + DETAIL.band.t / 2), y: L.padH + D.block.h * 0.6 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: sx * D.spikes.x, y: L.padH + D.block.h, z: sz * D.spikes.z, h: D.spikes.h, r: D.spikes.r });
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: y1, z, r: D.ventR }));
  for (const [x, z] of D.chimneys) chimney(b, kit, { x, y: y1, z, h: D.chimneyH, r: D.chimneyR });

  // tower: a massive tapered block with rust-coloured ribs on the front corners
  const T = D.tower;
  b.taperedBox(T.w, T.topW, T.h, T.w, S.hullDark, { y: y1 }, T.topW);
  const halfAt = (yRel) => (T.w - (T.w - T.topW) * (yRel / T.h)) / 2;
  b.box(halfAt(0) * 1.6, DETAIL.band.h, DETAIL.band.t, S.team, { y: y1 + T.h * 0.5, z: halfAt(T.h * 0.5) + DETAIL.band.t / 2 });
  emblemPlate(c, y1 + D.plate.y, halfAt(D.plate.y) - 0.1, D.plate.size);
  const top = y1 + T.h;
  b.box(D.platform.w, D.platform.h, D.platform.w, S.frame, { base: true, y: top });
  const pt = top + D.platform.h;
  for (const [x, z, h] of D.horns) spike(b, kit, { x, y: pt, z, h, r: D.spikes.r });
  for (const s of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [s * (D.platform.w / 2 - 0.2), pt, D.platform.w / 2 - 0.2]);
  b.cylinder(0.25, 0.3, D.dish.mast, 8, S.dark, { y: pt + D.dish.mast / 2 });
  c.parts.push({ kind: 'dish', x: 0, y: pt + D.dish.mast, z: 0, r: D.dish.r, speed: 1 });
  setSignal(c, y1, pt + D.horns[0][2], D.signal.r);
};

/** round: disc, three stacked pods around a glow core, plasma orb on top with levitating rings, 3 relay nodes joined by arcs */
BODIES.round = (c) => {
  const D = DIM.round;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  b.cylinder(D.disc.r, D.disc.r, D.disc.h, 40, S.hull, { y: L.padH + D.disc.h / 2 });
  b.torus(D.disc.r, DETAIL.band.h * 0.4, 4, 40, TAU, S.team, { rx: Math.PI / 2, y: L.padH + D.disc.h * 0.5 });
  neonRing(c, D.disc.r - 0.4, L.padH + D.disc.h, 0.08);
  const y0 = L.padH + D.disc.h;
  for (const p of D.pods) b.sphere(p.r, 20, 12, S.hull, { y: y0 + p.y - D.disc.h, sy: p.sy });
  for (const s of D.seams) neonRing(c, s.r, y0 + s.y - D.disc.h, 0.07);
  if (kit.rich) {   // glowing veins up the lowest pod
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      glows.get('pulse').segment([Math.cos(a) * D.pods[0].r * 0.95, y0 + 0.2, Math.sin(a) * D.pods[0].r * 0.95], [Math.cos(a) * D.pods[1].r * 0.9, y0 + D.pods[1].y - D.disc.h, Math.sin(a) * D.pods[1].r * 0.9], DETAIL.strip.t);
    }
  }
  emblemPlate(c, y0 + D.plate.y - D.disc.h, D.plate.z - 0.1, D.plate.size);
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: y0, z, r: D.ventR }));

  // core pylon up to the orb, three relay nodes on rods, arcs from the orb to the nodes
  const Co = D.core;
  const oy = y0 + D.orb.y - D.disc.h;
  b.cylinder(Co.r, Co.r, oy - y0, 12, S.trim, { y: y0 + (oy - y0) / 2 });
  b.sphere(D.orb.r, 20, 14, S.plasma, { y: oy });
  glows.get('pulse').sphere(D.orb.r * D.orb.halo, 14, 9, { y: oy });
  const N = D.nodes;
  const ny = y0 + N.y - D.disc.h;
  for (const a of N.angles) {
    const x = Math.cos(a) * N.r;
    const z = Math.sin(a) * N.r;
    b.cylinder(N.rod, N.rod, N.r, 6, S.frame, { x: x / 2, y: ny, z: z / 2, rz: Math.PI / 2, ry: -a });
    b.sphere(N.orbR, 12, 8, S.plasma, { x, y: ny, z });
    glows.get('pulse').sphere(N.orbR * 1.4, 8, 6, { x, y: ny, z });
    c.arcPairs.push([[Math.cos(a) * D.orb.r * 0.9, oy, Math.sin(a) * D.orb.r * 0.9], [x, ny + N.orbR, z]]);
  }
  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, x: 0, y: oy + r.dy, z: 0, amp: D.ringAmp });
  beacon(b, glows.get('beaconA'), kit, [0, oy + D.orb.r, 0]);
  setSignal(c, y0, oy + D.orb.r, D.signal.r);
};

/** faceted: stage, diamond spire in tapering sections with seams, floating crystal held by lasers, mirror pylons, radiators */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const laser = glows.get('laser');
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  const St = D.stage;
  b.cylinder(St.rTop, St.rBottom, St.h, St.segments, S.hullDark, { y: L.padH + St.h / 2, ry: Math.PI / St.segments });
  neonRing(c, St.rTop, L.padH + St.h, St.neonTube);
  const y0 = L.padH + St.h;
  let y = y0;
  const sections = [];
  for (const s of D.spire) {
    b.taperedBox(s.w, s.topW, s.h, s.w, S.hull, { y, ry: Math.PI / 4 }, s.topW);
    if (sections.length) neonStrip(b, kit, s.w + D.seam.over * 2, D.seam.h, s.w + D.seam.over * 2,{ y: y + D.seam.h / 2, ry: Math.PI / 4 });
    sections.push({ y, w: s.w, topW: s.topW, h: s.h });
    y += s.h;
  }
  const spireTop = y;
  const faceHalfAt = (yy) => {   // distance of a diagonal face of the (45° turned) spire from the axis
    const s = sections.find((q) => yy >= q.y && yy <= q.y + q.h) ?? sections[sections.length - 1];
    return (s.w - (s.w - s.topW) * ((yy - s.y) / s.h)) / 2;
  };
  glows.get('pulse').segment([0, y0 + 0.2, 0], [0, spireTop, 0], DETAIL.strip.t);

  // floating crystal over the spire held by four lasers
  const C = D.crystal;
  const cy = spireTop + C.lift;
  c.crystal = { x: 0, y: cy, z: 0, size: C.size, stretch: DETAIL.crystal.stretch, amp: C.amp };
  for (let i = 0; i < C.lasers; i++) {
    const a = (i * TAU) / C.lasers + Math.PI / 4;
    laserLink(b, laser, kit, [Math.cos(a) * C.laserR, spireTop, Math.sin(a) * C.laserR], [Math.cos(a) * C.laserTop, cy - C.size, Math.sin(a) * C.laserTop]);
  }
  beacon(b, glows.get('beaconA'), kit, [0, spireTop, 0]);

  // four mirror pylons on the pad corners beam at the spire (relay links)
  const Py = D.pylons;
  const hitY = Py.hit;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * Py.x;
      const z = sz * Py.z;
      b.cylinder(DETAIL.pylon.rTop, DETAIL.pylon.rBottom, Py.h, 6, S.hullDark, { x, y: L.padH + Py.h / 2, z });
      b.sphere(DETAIL.pylon.lensR, 8, 6, S.lens, { x, y: L.padH + Py.h, z });
      const k = faceHalfAt(hitY) / Math.SQRT2;
      laserLink(b, laser, kit, [x, L.padH + Py.h, z], [sx * k, hitY, sz * k]);
    }
  }
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: y0, z, r: D.ventR }));

  const Pl = D.plate;
  b.taperedBox(Pl.w, Pl.topW, Pl.h, Pl.d, S.hullDark, { y: y0, z: Pl.z }, Pl.topD);
  c.decals.push({ position: [0, y0 + Pl.decalY, Pl.z + Pl.d / 2 - LAYOUT.decalMargin], normal: [0, 0, 1], size: Pl.w * 0.6 });
  marking(b, kit, D.apron.len, D.apron.h, { rx: -Math.PI / 2, y: y0 + 0.01, z: D.apron.z });
  setSignal(c, y0, cy + C.size, D.signal.r);
};

// ---------------------------------------------------------------- animated part geometry

/** Radar dish (turns around Y), origin at the mast top */
function buildDish(kit, R) {
  const S = kit.S;
  const Dd = DETAIL.dish;
  const b = new PartBuilder();
  const tiltX = Math.PI / 2 - Dd.tilt;
  b.cylinder(R * 0.25, R * 0.25, Dd.stemH, 10, S.frame, { y: Dd.stemH / 2 });
  b.cylinder(R, R * 0.15, Dd.depth * R, 16, S.trim, { rx: tiltX, y: R * 0.9, z: R * 0.15 });
  b.cylinder(Dd.rod, Dd.rod, R, 6, S.frame, { rx: tiltX, y: R * 0.9 + (Math.cos(tiltX) * R) / 2, z: R * 0.15 + (Math.sin(tiltX) * R) / 2 });
  b.box(R * 0.5, R * 0.4, R * 0.3, S.hullDark, { y: R * 0.85, z: -R * 0.5 });
  b.box(R * 0.2, R * 0.1, 0.05, S.team, { y: R, z: -R * 0.66 });
  return b.build();
}

/** Floating crystal (origin at its centre) */
function buildCrystal(kit, C) {
  const b = new PartBuilder();
  const g = new THREE.OctahedronGeometry(C.size, 0);
  g.scale(1, C.stretch, 1);
  b.add(g, kit.S.plasma);
  return b.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const c = {
    kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [], rings: [], arcPairs: [], parts: [],
    crystal: null, signal: { y0: 0, y1: 1, r: 1 },
  };
  BODIES[sil](c);
  // the signal ring: a horizontal glow torus at the origin (moved up the tower by the model)
  c.glows.get('signal').torus(c.signal.r, DETAIL.strip.t, 4, 28, TAU, { rx: Math.PI / 2 });
  const fans = c.vents.filter((v) => v.fan);
  const orbs = c.vents.filter((v) => v.ring);
  const dishGeos = new Map();   // radius → geometry
  for (const p of c.parts) if (p.kind === 'dish' && !dishGeos.has(p.r)) dishGeos.set(p.r, buildDish(kit, p.r));
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbs.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbs.length ? ringGeometry(kit, orbs[0].ring.r) : null,
    dishes: c.parts.filter((p) => p.kind === 'dish').map((p) => ({ x: p.x, y: p.y, z: p.z, speed: p.speed, geometry: dishGeos.get(p.r) })),
    rings: c.rings.map((r) => ({ geometry: ringGeometry(kit, r.r, r.tube), x: r.x, y: r.y, z: r.z, amp: r.amp })),
    crystal: c.crystal ? { ...c.crystal, geometry: buildCrystal(kit, c.crystal) } : null,
    arcs: c.arcPairs.length ? arcGeometry(c.arcPairs, RELAY_ANIM.arcSeed) : null,
    signal: c.signal,
  };
}

const RELAY_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class AdvancedResearchFacilityProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: RELAY_CACHE, name: 'AdvancedResearchFacilityProc' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const an = this.kit.style.anim;
    const A = RELAY_ANIM;
    const gc = this.kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, false);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);
    this.arcs = null;
    if (sh.arcs) {
      const arcLayer = this.glowLayer(this.instanceGeometry(sh.arcs.geometry), gc.arc, { visible: false });
      this.arcs = new ArcFlicker(arcLayer, sh.arcs.ranges, { seed: A.arcSeed + seq });
    }

    // signal rings (one shared glow geometry, one layer each so every ring fades on its own)
    this.signalLayers = [];
    for (let i = 0; i < A.signalCount; i++) this.signalLayers.push(this.glowLayer(sh.glow.signal, gc.beam, { visible: false }));
    this.signalY0 = sh.signal.y0;
    this.signalSpan = sh.signal.y1 - sh.signal.y0;
    this.signal = seq * 0.29;

    // fans, dishes (turn), plasma-orb rings, levitating rings, floating crystal
    this.fans = [];
    this.fanSpeeds = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      fan.rotation.y = (seq * 0.7 + i * 1.3) % TAU;
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanJitter;
      this.fans.push(fan);
      this.fanSpeeds.push(A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1));
    });
    this.dishes = [];
    this.dishSpeeds = [];
    sh.dishes.forEach((d, i) => {
      const dish = this.paintMesh(d.geometry);
      dish.position.set(d.x, d.y, d.z);
      dish.rotation.y = seq * 0.9 + i * 2.1;
      this.dishes.push(dish);
      this.dishSpeeds.push(A.dishSpeed * an.spin * d.speed);
    });
    const lev = PROC_MODULES.levitate;
    this.levitators = [];
    sh.orbSpots.forEach(([x, y, z], i) => {
      const ring = this.paintMesh(sh.orbRing);
      ring.position.set(x, y, z);
      this.levitators.push(new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });
    sh.rings.forEach((r, i) => {
      const ring = this.paintMesh(r.geometry);
      ring.position.set(r.x, r.y, r.z);
      this.levitators.push(new Levitator(ring, { amp: r.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1) * 1.5, phase: seq * 0.37 + i * 1.1 }));
    });
    if (sh.crystal) {
      const k = sh.crystal;
      const mesh = this.paintMesh(k.geometry);
      mesh.position.set(k.x, k.y, k.z);
      this.levitators.push(new Levitator(mesh, { amp: k.amp * an.levitate, spin: lev.spin * an.spin * 1.5, phase: seq * 0.6 }));
    }

    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). While researching: dishes / crystal / rings turn at full speed, the core strip and
   * lasers pulse brightly, signal rings run up the tower quickly, radiators heat, arcs flash, beacons blink; idle = slower, dimmer.
   * @param {number} delta   seconds
   * @param {boolean} active building complete, powered and researching
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = RELAY_ANIM;
    const k = active ? 1 : A.idleShare;
    this.time += delta;
    for (let i = 0; i < this.fans.length; i++) this.fans[i].rotation.y += delta * this.fanSpeeds[i] * k;
    for (let i = 0; i < this.dishes.length; i++) this.dishes[i].rotation.y += delta * this.dishSpeeds[i] * k;
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);

    const glow = pulseWave(this.time, an.pulse) * (active ? 1 : A.idleGlow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    const sig = active ? 1 : A.signalIdle;
    this.signal += delta * A.signalRate * sig;
    const n = this.signalLayers.length;
    for (let i = 0; i < n; i++) {
      const t = (this.signal + i / n) % 1;
      const mesh = this.signalLayers[i].mesh;
      mesh.position.y = this.signalY0 + this.signalSpan * t;
      mesh.scale.setScalar(1 + A.signalGrow * t);
      this.signalLayers[i].setIntensity(Math.sin(Math.PI * t) * sig);
    }
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(delta, active);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
