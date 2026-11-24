// Steel Mans – procedural Outpost (future teleport, stats.json → structures.outpost, buildable: false). A drop-in
// alternative to models/3DStructures{race}/Outpost{race}_Anim.glb built in code from the style modules (ProcModules.js):
//   • footprint inside the GLB's ground box (±12.8 × ±12.8): pad ±12.6, front = +Z where the arrival platform lies
//   • a gate / portal standing in the XY plane at z = 0: a disc (or diamond) of pulsing energy with a spinning swirl and two
//     counter-rotating rune rings; it glows dimly while idle and flares up while the building is active (teleporting)
//   • frame by style.silhouette (rounded: pylons + lintel with guarded fans and safety markings · angular: armoured
//     buttressed pylons with a spiked lintel, open fans, chimneys · round: a floating-look ring on a pedestal with plasma
//     orbs and coils with arcs · faceted: a diamond frame of thin blades with laser-linked emitter blocks and radiators);
//     the rest (edges, neon, lights, vents, industrial parts, markings, texture, emblem) comes from the style
//   • static body = one merged mesh (LODs) + emblem decals (1 draw call) + glow layers (portal, swirl, beacons, …)
//     + a few animated parts (2 rune rings, ≤ 2 fans, orb rings)
// Visual only: update() takes the frame delta, nothing here is read by the simulation. No allocations in update().
import { PartBuilder, GlowBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, pipeRun, chimney, plasmaCoil, laserLink, arcGeometry, ArcFlicker, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const OUTPOST_ANIM = {
  ringSpeed: 0.9,         // rad/s of the rune rings at work (× style.anim.spin, opposite directions)
  ringIdle: 0.25,         // share of the work speed while idle
  jerkTicks: 16,          // ticks per revolution of the rings when style.anim.jerk > 0 (stepped turning)
  swirlSpeed: 1.8,        // rad/s of the energy swirl at work (× style.anim.spin)
  swirlIdle: 0.3,
  fanSpeed: 4.2,          // rad/s at work (× style.anim.spin)
  fanIdle: 0.4,
  fanSpeedJitter: 0.25,
  powerEase: 1.2,         // 1/s – how fast the gate spins up / down
  idlePortal: 0.35,       // portal / swirl / plasma glow share while idle
  idleBeacon: 0.4,        // beacon intensity while idle (they blink while active)
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
  arcSeed: 7123,
};

/** Shared layout (model units, GLB scale; front = +Z) */
const LAYOUT = {
  padHalf: 12.6, padH: 0.3, padRing: { inset: 0.5, tube: 0.1, lift: 0.05 },
  neonMin: 0.3,                                   // style.neon from which neon lines are added
  arrival: { w: 12, d: 6.5, z: 8, h: 0.12, markH: 0.6, decal: 4.2 },   // platform in front of the gate where teleported units appear
  portal: { thick: 0.12, segments: 40, coreShare: 0.55, coreSegments: 20, coreFlat: 0.12 },
  swirl: { arms: 4, steps: 6, inner: 0.15, outer: 0.92, twist: 2.4, thickness: 0.14 },
  ring: { share: 0.9, lugs: 12, tube: 0.12, segments: 40, lugW: 0.5, lugH: 0.6, lugD: 0.4, zOff: 0.35, countStep: 2, radial: 4, spikeSegments: 4, spikeLen: 1.6, spikeTip: 0.5, sphereSegments: [8, 6], diamondLen: 1.4 },
};

/**
 * Dimensions by style.silhouette (code knows shapes, the style data picks one; unknown → rounded). `portal.y` is
 * relative to the top of the foundation (y0) except where noted, `lug` the shape of the rune ring lugs.
 */
const DIM = {
  rounded: {
    plinth: { w: 24, h: 1.0, d: 10 },
    pylon: { x: 7.5, w: 3, h: 16, d: 3.6 },
    lintel: { w: 18, h: 2.6, d: 3.6 },
    portal: { y: 6.8, r: 5.8 },
    neon: { t: 0.1, share: 0.8, dShare: 0.6 },
    band: { y: 1.2, h: 0.4, t: 0.06, w: 0.9 },
    mark: { len: 5, h: 0.8, y: 4.5, out: 0.02 },
    vents: { x: 5, r: 1.2 },
    beacons: { lintelX: 8.2, plinthX: 11, plinthZ: 4 },
    pipes: { r: 0.25, out: 0.35, z: -1.6 },
    decal: { lintel: 2.2, pylon: 2.4, pylonY: 0.55 },
    lug: 'box',
  },
  angular: {
    plinth: { w: 24.4, h: 1.6, d: 11, baseH: 0.8, topW: 21, topD: 9.4, skirt: 0.8 },
    pylon: { x: 8.4, w: 4.6, topW: 3.4, h: 17, d: 5.4, topD: 4.2 },
    buttress: { w: 2, topW: 1, h: 11, d: 3.4, topD: 1.6, dx: 0.9, dz: 1.1 },
    lintel: { w: 21.2, h: 3.2, d: 5.8 },
    portal: { y: 7.2, r: 5.8 },
    lower: { y: 2.2, h: 4, t: 0.08, w: 0.9 },
    slit: { w: 14, h: 0.35, t: 0.1, out: 0.02 },
    band: { h: 0.5, t: 0.1, w: 16, drop: 0.45 },
    spikes: { h: 1.4, r: 0.35, list: [[-9.6, -2.4], [-9.6, 2.4], [9.6, -2.4], [9.6, 2.4], [0, -2.4], [0, 2.4]] },
    vents: { x: 4.8, r: 1.2 },
    chimneys: { x: 11.3, z: -3, h: 6, r: 0.8 },
    beacons: { lintelX: 10.2, plinthX: 11.4, plinthZ: 4.2 },
    decal: { lintel: 2.6, pylon: 2.8, pylonY: 0.5 },
    lug: 'spike',
  },
  round: {
    plinth: { rTop: 8.8, rBottom: 9.2, h: 0.8, segments: 48 },
    ring: { R: 7.2, tube: 0.85, radial: 10, tubular: 56, y: 9.6, innerTube: 0.14, teamTube: 0.25, teamZ: 0.7 },
    pedestal: { rTop: 2.4, rBottom: 3.4, h: 1.9, segments: 16 },
    portal: { r: 6.0 },
    orbs: { x: 10.3, z: 2, r: 2.0 },
    coils: { x: 9.5, z: -4.2, h: 5.5, r: 0.9 },
    arcAngle: -0.55,                                // rad – where on the ring the coil arcs land (below the horizontal)
    beacons: { top: true, x: 5.2, z: 6.5 },
    lug: 'sphere',
  },
  faceted: {
    pad: { segments: 8, neonR: 11.6, neonTube: 0.08 },
    stage: { r: 7, h: 1.0, segments: 8 },
    diamond: { half: 9.2, t: 1.0, depth: 1.3, lift: 1.2, lensBox: 1.6, lensDepth: 1.8, foot: { w: 1.4, d: 1.8 }, neonT: 0.12, spireH: 3, spireR: 0.5 },
    outrigger: { x: 11, z: 3, w: 1.6, topW: 0.7, h: 7, linkY: 5.5, beaconY: 7 },
    vents: { x: 4.5, z: -3.2, r: 1.1 },
    portal: { half: 6.1 },
    lug: 'diamond',
  },
};

const BODIES = {};   // filled below (silhouette → frame builder)

// ---------------------------------------------------------------- small helpers (construction time only)

/** Foundation: pad ('box' / 'round' / 'octagon') + arrival platform in front of the gate */
function foundation(c, kind) {
  const L = LAYOUT;
  const { b, S, kit } = c;
  if (kind === 'round') {
    b.cylinder(L.padHalf, L.padHalf, L.padH, 48, S.ground, { y: L.padH / 2 });
    if (kit.style.neon >= L.neonMin) b.torus(L.padHalf - L.padRing.inset, L.padRing.tube, 4, 48, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + L.padRing.lift });
  } else if (kind === 'octagon') {
    const D = DIM.faceted;
    const r = L.padHalf / Math.cos(Math.PI / D.pad.segments);
    b.cylinder(r, r, L.padH, D.pad.segments, S.ground, { y: L.padH / 2, ry: Math.PI / D.pad.segments });
    if (kit.style.neon >= L.neonMin) b.torus(D.pad.neonR, D.pad.neonTube, 4, 48, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + L.padRing.lift });
  } else {
    b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  }
  const A = L.arrival;
  b.box(A.w, A.h, A.d, S.lower, { base: true, y: L.padH, z: A.z });
  marking(b, kit, A.w - 0.4, A.markH, { rx: -Math.PI / 2, y: L.padH + A.h + 0.01, z: A.z - A.d / 2 + A.markH });
  c.decals.push({ position: [0, L.padH + A.h, A.z + A.markH / 2], normal: [0, 1, 0], size: A.decal });
}

/** Wall decal; `tilt` leans the normal upwards (sloped walls) */
function wallDecal(c, position, nx, nz, size, tilt = 0) {
  c.decals.push({ position, normal: [nx * Math.cos(tilt), Math.sin(tilt), nz * Math.cos(tilt)], size });
}

/** Four beacons (lights by style) at the given [x, y, z] list */
function beacons(c, list) {
  for (const p of list) beacon(c.b, c.glows.get('beaconA'), c.kit, p);
}

// ---------------------------------------------------------------- frames (one per silhouette)

/** rounded: two pylons + a lintel, guarded fans on top, hazard markings, neon on the opening, pipes, team bands */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit } = c;
  const L = LAYOUT;
  foundation(c, 'box');
  const y0 = L.padH + D.plinth.h;
  const pyTop = y0 + D.pylon.h;
  const inner = D.pylon.x - D.pylon.w / 2;
  const outer = D.pylon.x + D.pylon.w / 2;
  styledBox(b, kit, D.plinth.w, D.plinth.h, D.plinth.d, S.hullDark, { base: true, y: L.padH });
  for (const s of [-1, 1]) {
    styledBox(b, kit, D.pylon.w, D.pylon.h, D.pylon.d, S.hull, { base: true, x: s * D.pylon.x, y: y0 });
    for (const e of [-1, 1]) {
      b.box(D.pylon.w * D.band.w, D.band.h, D.band.t, S.team, { x: s * D.pylon.x, y: y0 + D.band.y, z: e * (D.pylon.d / 2 + D.band.t / 2) });
    }
    marking(b, kit, D.mark.len, D.mark.h, { rz: Math.PI / 2, x: s * D.pylon.x, y: y0 + D.mark.y, z: D.pylon.d / 2 + D.mark.out });
    wallDecal(c, [s * outer, y0 + D.pylon.h * D.decal.pylonY, 0], s, 0, D.decal.pylon);
    pipeRun(b, kit, [[s * (outer + D.pipes.out), y0, D.pipes.z], [s * (outer + D.pipes.out), pyTop, D.pipes.z]], D.pipes.r);
    c.vents.push(ventUnit(b, c.glows, kit, { x: s * D.vents.x, y: pyTop + D.lintel.h, z: 0, r: D.vents.r }));
  }
  styledBox(b, kit, D.lintel.w, D.lintel.h, D.lintel.d, S.hull, { base: true, y: pyTop });
  wallDecal(c, [0, pyTop + D.lintel.h / 2, D.lintel.d / 2], 0, 1, D.decal.lintel);
  wallDecal(c, [0, pyTop + D.lintel.h / 2, -D.lintel.d / 2], 0, -1, D.decal.lintel);
  if (kit.style.neon >= L.neonMin) {
    for (const s of [-1, 1]) neonStrip(b, kit, D.neon.t, D.pylon.h * D.neon.share, D.pylon.d * D.neon.dShare, { x: s * (inner - D.neon.t / 2), y: y0 + D.pylon.h / 2 });
    neonStrip(b, kit, inner * 2, D.neon.t, D.lintel.d * D.neon.dShare, { y: pyTop - D.neon.t / 2 });
  }
  const B = D.beacons;
  beacons(c, [[-B.lintelX, pyTop + D.lintel.h, 0], [B.lintelX, pyTop + D.lintel.h, 0],
    [-B.plinthX, y0, B.plinthZ], [B.plinthX, y0, B.plinthZ]]);
  c.portal = { y: y0 + D.portal.y, r: D.portal.r, kind: 'disc' };
};

/** angular: armoured plinth, tapered pylons with buttresses, spiked lintel, open fans, chimneys, rusty plates */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit } = c;
  const L = LAYOUT;
  foundation(c, 'box');
  const P = D.plinth;
  const y0 = L.padH + P.h;
  b.box(P.w + P.skirt, P.baseH, P.d + P.skirt, S.hullDark, { base: true, y: L.padH });
  b.taperedBox(P.w, P.topW, P.h - P.baseH, P.d, S.hull, { y: L.padH + P.baseH }, P.topD);
  const Y = D.pylon;
  const tilt = Math.atan2((Y.w - Y.topW) / 2, Y.h);
  const decalHalf = (yRel) => Y.w / 2 - ((Y.w - Y.topW) / 2) * (yRel / Y.h);
  for (const s of [-1, 1]) {
    const x = s * Y.x;
    b.taperedBox(Y.w, Y.topW, Y.h, Y.d, S.hull, { x, y: y0 }, Y.topD);
    b.box(Y.w * D.lower.w, D.lower.h, D.lower.t, S.lower, { x, y: y0 + D.lower.y, z: Y.d / 2 + D.lower.t / 2 });
    const Bt = D.buttress;
    b.taperedBox(Bt.w, Bt.topW, Bt.h, Bt.d, S.hullDark, { x: s * (Y.x + Bt.dx), y: y0, z: -(Y.d / 2 + Bt.dz) }, Bt.topD);
    // decal on the outer sloped face (the face leans in by `tilt`)
    wallDecal(c, [x + s * decalHalf(Y.h * D.decal.pylonY), y0 + Y.h * D.decal.pylonY, 0], s, 0, D.decal.pylon, tilt);
  }
  const T = D.lintel;
  const lTop = y0 + Y.h + T.h;
  b.box(T.w, T.h, T.d, S.hull, { base: true, y: y0 + Y.h });
  b.box(D.slit.w, D.slit.h, D.slit.t, S.window, { y: y0 + Y.h + T.h / 2, z: T.d / 2 + D.slit.out });
  b.box(D.band.w, D.band.h, D.band.t, S.team, { y: y0 + Y.h + D.band.drop, z: T.d / 2 + D.band.t / 2 });
  wallDecal(c, [0, y0 + Y.h + T.h * 0.62, -T.d / 2], 0, -1, D.decal.lintel);
  for (const [x, z] of D.spikes.list) spike(b, kit, { x, y: lTop, z, h: D.spikes.h, r: D.spikes.r });
  for (const s of [-1, 1]) {
    c.vents.push(ventUnit(b, c.glows, kit, { x: s * D.vents.x, y: lTop, z: 0, r: D.vents.r }));
    chimney(b, kit, { x: s * D.chimneys.x, y: y0, z: D.chimneys.z, h: D.chimneys.h, r: D.chimneys.r });
  }
  const B = D.beacons;
  beacons(c, [[-B.lintelX, lTop, 0], [B.lintelX, lTop, 0], [-B.plinthX, y0, B.plinthZ], [B.plinthX, y0, B.plinthZ]]);
  c.portal = { y: y0 + D.portal.y, r: D.portal.r, kind: 'disc' };
};

/** round: a ring (torus) on a pedestal, a neon inner ring, plasma orbs with floating rings, coils with arcs */
BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  foundation(c, 'round');
  const y0 = L.padH + D.plinth.h;
  b.cylinder(D.plinth.rTop, D.plinth.rBottom, D.plinth.h, D.plinth.segments, S.hullDark, { y: L.padH + D.plinth.h / 2 });
  const R = D.ring;
  const cy = y0 + R.y;
  const Pd = D.pedestal;
  b.cylinder(Pd.rTop, Pd.rBottom, Pd.h, Pd.segments, S.hullDark, { y: y0 + Pd.h / 2 });
  b.torus(R.R, R.tube, R.radial, R.tubular, TAU, S.hull, { y: cy });
  b.torus(R.R - R.tube, R.innerTube, 4, R.tubular, TAU, S.neon, { y: cy });
  for (const e of [-1, 1]) b.torus(R.R, R.teamTube, 4, R.tubular, TAU, S.team, { y: cy, z: e * R.teamZ });
  const O = D.orbs;
  for (const s of [-1, 1]) {
    c.vents.push(ventUnit(b, glows, kit, { x: s * O.x, y: L.padH, z: O.z, r: O.r }));
    const C = D.coils;
    const top = plasmaCoil(b, glows.get('pulse'), kit, { x: s * C.x, y: L.padH, z: C.z, h: C.h, r: C.r });
    c.arcPairs.push([top, [s * R.R * Math.cos(D.arcAngle), cy + R.R * Math.sin(D.arcAngle), 0]]);
  }
  const bs = D.beacons;
  beacons(c, [[0, cy + R.R + R.tube, 0], [-bs.x, L.padH, bs.z], [bs.x, L.padH, bs.z]]);
  c.portal = { y: cy, r: D.portal.r, kind: 'disc' };
};

/** faceted: a diamond frame of thin blades with lens emitters at its vertices, laser-linked outrigger blocks, radiators */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const laser = glows.get('laser');
  foundation(c, 'octagon');
  const y0 = L.padH + D.stage.h;
  b.cylinder(D.stage.r, D.stage.r, D.stage.h, D.stage.segments, S.hullDark, { y: L.padH + D.stage.h / 2, ry: Math.PI / D.stage.segments });
  const M = D.diamond;
  const cy = y0 + M.lift + M.half;
  const side = M.half * Math.SQRT2;
  const inward = (M.t / 2) / Math.SQRT2;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const rz = sx * sy > 0 ? -Math.PI / 4 : Math.PI / 4;
      const x = (sx * M.half) / 2;
      const y = cy + (sy * M.half) / 2;
      b.box(side + M.t, M.t, M.depth, S.hullDark, { x, y, rz });
      b.box(side, M.t * 0.3, M.depth * 1.15, S.frame, { x, y, rz });
      neonStrip(b, kit, side, M.neonT, M.neonT, { x: x - sx * inward, y: y - sy * inward, rz });
    }
  }
  for (const [x, y] of [[-M.half, 0], [M.half, 0], [0, M.half], [0, -M.half]]) {   // lens emitters at the four vertices
    b.box(M.lensBox, M.lensBox, M.lensDepth, S.lens, { x, y: cy + y, rz: Math.PI / 4 });
  }
  b.box(M.foot.w, cy - M.half - y0, M.foot.d, S.hullDark, { base: true, y: y0 });
  spike(b, kit, { x: 0, y: cy + M.half + M.lensBox / 2, z: 0, h: M.spireH, r: M.spireR });
  const Og = D.outrigger;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * Og.x;
      const z = sz * Og.z;
      b.taperedBox(Og.w, Og.topW, Og.h, Og.w, S.hullDark, { x, y: y0 });
      laserLink(b, laser, kit, [x, y0 + Og.linkY, z], [sx * M.half, cy, 0]);
      beacon(b, glows.get('beaconA'), kit, [x, y0 + Og.beaconY, z]);
    }
    c.vents.push(ventUnit(b, glows, kit, { x: sx * D.vents.x, y: y0, z: D.vents.z, r: D.vents.r }));
  }
  c.portal = { y: cy, r: D.portal.half, kind: 'diamond' };
};

// ---------------------------------------------------------------- portal, swirl and rune rings (shared geometries)

/** Portal fill + bright core as one additive glow geometry (disc, or diamond plate), centred at [0, y, 0] */
function portalGlow(c) {
  const P = LAYOUT.portal;
  const g = new GlowBuilder();
  const { y, r, kind } = c.portal;
  if (kind === 'diamond') {
    g.box(r * 2, r * 2, P.thick, { y, rz: Math.PI / 4 });
    g.box(r * 2 * P.coreShare, r * 2 * P.coreShare, P.thick, { y, rz: Math.PI / 4 });
  } else {
    g.cylinder(r, r, P.thick, P.segments, { y, rx: Math.PI / 2 }, false);
    g.sphere(r * P.coreShare, P.coreSegments, P.coreSegments / 2, { y, sz: P.coreFlat });
  }
  return g.build();
}

/** Swirl arms (spirals of thin beams in the XY plane, origin at the portal centre) – turned as a whole by update() */
function swirlGeometry(radius) {
  const W = LAYOUT.swirl;
  const g = new GlowBuilder();
  for (let arm = 0; arm < W.arms; arm++) {
    let prev = null;
    for (let i = 0; i <= W.steps; i++) {
      const t = i / W.steps;
      const r = radius * (W.inner + (W.outer - W.inner) * t);
      const a = (arm * TAU) / W.arms + t * W.twist;
      const p = [Math.cos(a) * r, Math.sin(a) * r, 0];
      if (prev) g.segment(prev, p, W.thickness);
      prev = p;
    }
  }
  return g.build();
}

/** Rune ring: thin torus with lugs around it (origin at the centre, in the XY plane, turned about Z) */
function runeRing(kit, radius, kind, lugs) {
  const R = LAYOUT.ring;
  const S = kit.S;
  const b = new PartBuilder();
  b.torus(radius, R.tube, R.radial, R.segments, TAU, S.trim, {});
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * TAU;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    if (kind === 'spike') b.cylinder(0, R.lugW * R.spikeTip, R.lugH * R.spikeLen, R.spikeSegments, S.frame, { x, y, rz: a - Math.PI / 2 });
    else if (kind === 'sphere') b.sphere(R.lugW * R.spikeTip, R.sphereSegments[0], R.sphereSegments[1], S.plasma, { x, y });
    else if (kind === 'diamond') b.box(R.lugH * R.diamondLen, R.lugW, R.lugD, S.neon, { x, y, rz: a + Math.PI / 4 });
    else b.box(R.lugH, R.lugW, R.lugD, S.team, { x, y, rz: a });
  }
  return b.build();
}

/** Turning part that speeds up with the building's power (idle share → full), optionally in stepped ticks (jerk) */
class TurnDrive {
  constructor(object, { axis = 'y', speed, idle, step = 0, phase = 0 }) {
    this.object = object;
    this.axis = axis;
    this.speed = speed;
    this.idle = idle;
    this.step = step;
    this.angle = phase;
    object.rotation[axis] = phase;
  }

  update(delta, power) {
    this.angle += delta * this.speed * (this.idle + (1 - this.idle) * power);
    this.object.rotation[this.axis] = this.step > 0 ? Math.round(this.angle / this.step) * this.step : this.angle;
  }
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const D = DIM[sil];
  const c = {
    kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [], arcPairs: [], portal: null,
  };
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbRings = c.vents.filter((v) => v.ring);
  const R = LAYOUT.ring;
  const ringR = c.portal.r * R.share;
  const glow = c.glows.build();
  glow.portal = portalGlow(c);
  return {
    sil,
    static: c.b.buildLods(),
    glow,
    emblem: emblemDecalGeometry(c.decals),
    portalY: c.portal.y,
    swirl: swirlGeometry(c.portal.r),
    rings: [runeRing(kit, ringR, D.lug, R.lugs), runeRing(kit, ringR, D.lug, R.lugs + R.countStep)],
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbRings.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbRings.length ? ringGeometry(kit, orbRings[0].ring.r) : null,
    arcs: c.arcPairs.length ? arcGeometry(c.arcPairs, OUTPOST_ANIM.arcSeed) : null,
  };
}

const OUTPOST_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class OutpostProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: OUTPOST_CACHE, name: 'OutpostProc' });
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
    const A = OUTPOST_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.portalLayer = layer('portal', gc.pulse, true);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);
    this.swirlLayer = this.glowLayer(sh.swirl, gc.pulse, { visible: true });
    this.swirlLayer.mesh.position.set(0, sh.portalY, 0);
    this.arcs = null;
    if (sh.arcs) {
      const arcLayer = this.glowLayer(this.instanceGeometry(sh.arcs.geometry), gc.arc, { visible: false });
      this.arcs = new ArcFlicker(arcLayer, sh.arcs.ranges, { seed: A.arcSeed + seq });
    }

    this.drives = [];
    // two counter-rotating rune rings just in front of / behind the portal plane (stepped ticks when the style is jerky)
    const step = an.jerk > 0 ? TAU / A.jerkTicks : 0;
    sh.rings.forEach((geo, i) => {
      const mesh = this.paintMesh(geo, this, { far: true });   // far LOD: drawn instanced, frozen in its last pose
      mesh.position.set(0, sh.portalY, (i ? -1 : 1) * LAYOUT.ring.zOff);
      this.drives.push(new TurnDrive(mesh, { axis: 'z', speed: A.ringSpeed * an.spin * (i ? 1 : -1), idle: A.ringIdle, step, phase: seq * 0.5 + i }));
    });
    // fans
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      this.drives.push(new TurnDrive(fan, { axis: 'y', speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), idle: A.fanIdle, phase: (seq * 0.7 + i * 1.3) % TAU }));
    });
    // plasma rings over the orbs
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
   * Per-frame animation (no allocations). Always: the portal glows dimly and pulses, rings and swirl idle slowly, beacons
   * burn steadily. While active (teleporting): rings, swirl and fans spin up, the portal and plasma / lasers glow fully,
   * radiators heat up, arcs flash, beacons blink.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = OUTPOST_ANIM;
    this.time += delta;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    for (let i = 0; i < this.drives.length; i++) this.drives[i].update(delta, this.power);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);
    this.swirlLayer.mesh.rotation.z += delta * A.swirlSpeed * an.spin * (A.swirlIdle + (1 - A.swirlIdle) * this.power);
    const glow = pulseWave(this.time, an.pulse) * (A.idlePortal + (1 - A.idlePortal) * this.power);
    this.portalLayer?.setIntensity(glow);
    this.swirlLayer.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(delta, active);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
