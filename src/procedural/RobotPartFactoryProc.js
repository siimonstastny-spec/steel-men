// Steel Men – procedural robot part factory (night plan: buildings generated in code in 4 faction styles). A drop-in
// alternative to models/3DStructures{race}/RobotPartFactory{race}_Anim.glb built from the style modules (ProcModules.js):
//   • footprint inside the GLBs' ground box (±18 × ±12): pad ±17.6 × ±11.8, front = +Z (open work cell, hall behind it)
//   • a production hall at the back (per style.silhouette: rounded halls · armoured block with buttresses and spikes ·
//     cylinder hall with plasma orb and coils · faceted hall with a diamond crown and laser-linked emitter towers) and an
//     open work cell in front: a work table with a robot torso on it and TWO ROBOT ARMS that weld it
//   • animation (only while `active`): the torso travels along the table and stops three times; at every stop both arms
//     (2-link IK, stepped / ratcheting when style.anim.jerk > 0) reach down and weld – sparks (style.fan guarded / open),
//     plasma weld (none = plasma styles) or a laser beam (radiator styles) flicker at the torch tips; fan spins up /
//     plasma ring floats / radiators heat; idle = arms folded, no weld, beacons dim
//   • one merged static mesh per style (LODs) + emblem decals (1 draw call), the rest are a handful of named parts
// Visual only: update() takes the frame delta, nothing here is read by the simulation. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Blinker, Spinner, TrackMover, GlowBuilder, makeRng, plateau } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, pipeRun, tank, chimney, plasmaCoil, laserLink, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
  teamPanel, teamTrim, teamBanner, roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const PART_FACTORY_ANIM = {
  powerEase: 1.3,         // 1/s – arms / fan / glow spin up and down
  weldEase: 6,            // 1/s – weld fades in / out at a stop
  weldMin: 0.05,          // weld intensity below this → hidden
  tableSpeed: 2.2,        // units/s of the torso on the table (× style.anim.tempo)
  dwell: 3.4,             // s – stop at every welding position
  dwellEdge: 0.18,        // share of the dwell the arms need to lower / lift
  jerkSteps: 3,           // pushes per leg of the torso when style.anim.jerk > 0
  jerkAngle: 0.09,        // rad – arm joints turn in these steps when style.anim.jerk > 0 (ratchet)
  flickerRate: 24,        // Hz – new weld brightness
  flickerMin: 0.4,
  wobble: { amp: 0.9, freq: 2.8 },   // seam travel of the torch along the table
  lift: 2.4,              // arm tip rises this much above the weld height between stops
  rest: { xShare: 0.3, y: 7.0, z: 8.2 },   // folded pose: aim point (x = share of the arm base x)
  fanSpeed: 4.0, fanEase: 1.5, fanJitter: 0.25,
  idleGlow: 0.3, idleBeacon: 0.4, blinkDuty: 0.5, phaseStep: 0.43,
  seed: 7311,
};

/** Shared layout (model units, GLB scale; front = +Z) */
const LAYOUT = {
  pad: { hx: 17.6, hz: 11.8, h: 0.3 },
  hall: { hx: 16, back: -11.2, front: 1.4 },
  plat: { hx: 16.6, z0: 1.2, z1: 11.6, h: 0.6 },     // raised work-cell platform in front of the hall
  table: { z: 6.2, hx: 8.5, d: 3.2, topY: 2.1, stops: [-3, 0, 3] },
  // seamZ = distance of the weld seam in front of the torso centre (part.d / 2 + gap, set below); seamX = spread of the two torches
  arm: { x: 6.5, z: 10, pedH: 3.0, L1: 5.5, L2: 5.5, weldY: 3.6, seamZ: 0, seamGap: 0.15, seamX: 0.7, torchY: -1.0, yokeW: 1.6 },
  part: { w: 2.6, h: 1.7, d: 2.0 },                  // the torso being built
  decalMargin: 0.1,
};

LAYOUT.arm.seamZ = LAYOUT.part.d / 2 + LAYOUT.arm.seamGap;   // torches weld on the front face of the torso, not inside it

/** Small details shared by the styles */
const DETAIL = {
  edgeMarkH: 0.5, markOut: 0.02,
  railH: 1.0, railT: 0.1, railStep: 4, railInset: 0.3, spikeH: 1.0, spikeR: 0.25,
  neonMin: 0.3,           // style.neon from which neon bands appear
  band: { h: 0.5, t: 0.1, share: 0.94 },
  beaconInset: 0.5,
  pedestal: { flange: 3.8, flangeH: 0.5, collarH: 0.3 },
  table: { slabH: 1.0, plateH: 0.2, plateShare: 0.9, discR: 4.6, discH: 1.2, ringTube: 0.12, laserT: 0.06, laserInset: 0.2, nubR: 0.18 },
  weld: {
    spark: { guarded: { n: 5, len: 1.2, r: 0.3 }, open: { n: 8, len: 2.0, r: 0.35 }, thick: 0.06, lift: 0.1 },
    plasma: { ball: 0.5, ring: 0.9, ringTube: 0.06, beam: 1.6, beamT: 0.12, lift: 0.3 },
    laser: { len: 2.4, thick: 0.07, tip: 0.25, cross: 0.5, crossT: 0.05 },
  },
};

/** Weld kind by style.fan (guarded / open fans: sparks · none = plasma styles: plasma weld · radiator: laser) */
const WELD_BY_FAN = { guarded: 'spark', open: 'spark', none: 'plasma', radiator: 'laser' };

/** Per silhouette dimensions of the hall body (code knows shapes, the style data picks one; unknown → rounded) */
const DIM = {
  rounded: {
    hallH: 7.5, upper: { w: 16, h: 3.2, d: 8, dz: -1.5 },
    band: { y: 1.3 }, win: { x: 9.5, y: 4.6, fw: 4.2, fh: 2.0, gw: 3.8, gh: 1.6, t: 0.1, out: 0.02 },
    neon: { drop: 0.9, h: 0.14, t: 0.06 }, decal: { front: 4.6, side: 5.5, y: 4.2 },
    vent: { x: 11, dz: 3.2, r: 2.3 }, tank: { x: -11.5, dz: -3, r: 1.3, len: 7, rise: 0.6 }, pipe: { x: -6.8, r: 0.3 },
    beacons: { x: 15.5 },
  },
  angular: {
    blockH: 5.8, slope: { h: 2.6, topW: 27, inset: 3 },
    buttress: { w: 1.6, h: 5.0, t: 1.0, footW: 2.2, footH: 0.5, footT: 1.5, front: [-13, -9, 9, 13], side: [-9.6, -0.2] },
    plate: { y: 1.5, h: 2.2, x: 9, w: 12, t: 0.08 }, team: { y: 4.9, h: 0.4 },
    decal: { front: 4.2, side: 5.5, y: 3.2 },
    parapet: { h: 0.8, t: 0.5, spikeH: 1.2, spikeR: 0.3, step: 5 },
    chimneys: [[-12, -8], [-6, -8]], chimneyH: 5, chimneyR: 0.9,
    vent: { x: 10, dz: 0.5, r: 2.0 }, beacons: { x: 15.5, y: 5.8 },
  },
  round: {
    r: 6.2, segments: 40, plate: { size: 5.4, d: 0.8, back: 0.1 },
    ring: { xs: [-11, -6, 6, 11], tube: 0.12, out: 0.05 }, band: { xs: [-14, 14], tube: 0.15 },
    decal: { front: 4.2, end: 6 },
    ridge: { w: 0.1, angle: Math.PI / 4 },
    vent: { x: 9, sink: 0.2, r: 2.4 },
    coil: { x: 15.2, z: 10.9, h: 3.2, r: 0.8 }, beacons: { x: 12.5, z: 11.2 },
  },
  faceted: {
    hallH: 8.5, topW: 26, edgeNeon: 0.1,
    decal: { front: 4.6, side: 5.5, y: 4.5 },
    band: { y: 1.2, share: 0.3, at: 0.6 }, lens: { x: 8, y: 4.5, s: 1.6, t: 0.12, core: 0.7 },
    crown: { x: 7, w: 6, spike: 1.4 },
    vent: { x: -8, r: 2.2 },
    tower: { x: 14.8, z: 10.6, w: 2.4, topW: 0.8, h: 5.6, lensR: 0.3, lensH: 0.4 },
  },
};

/**
 * Team paint layout (docs/notes/proc-teampaint-b.md). The big coloured areas are whole surfaces painted S.teamPaint /
 * S.teamShade (work-cell platform, one main volume per body); kit modules (panels, trim, mark, banner) add the style's look on
 * top – their kinds come from kit.team, the shapes from the silhouette. Everything is static geometry (no draw calls).
 */
const TEAM = {
  rounded: {   // upper hall tier painted; panels flank the front windows and the side emblems, mark on the roof, lip, flag
    front: { x: 9.5, y: 2.4, w: 7, h: 1.5 }, side: { dz: 4.4, y: 3.9, w: 2.4, h: 3.4 },
    mark: { z: -0.5, w: 16, d: 3 }, trimInset: 0.8, banner: { x: -15, z: -9.8, h: 5 },
  },
  angular: {}, // sloped armour crown + lower plates painted (surfaces only)
  round: {     // two wide rings round the lying hall (neon rings stay on top of them)
    rings: [{ x: 13.5, w: 5 }, { x: 4.5, w: 4 }], out: 0.06, banner: { x: -16, z: 3.2, h: 4 },
  },
  faceted: {   // diamond crown and emitter towers painted, mark on the roof, fin banner
    mark: { x: -1.5, w: 7, d: 10 }, banner: { x: -12, z: -9.7, h: 6 },
  },
};

const BODIES = {};   // silhouette → body function (filled below)

// ---------------------------------------------------------------- common parts

const platTop = () => LAYOUT.pad.h + LAYOUT.plat.h;
const shoulderY = () => platTop() + LAYOUT.arm.pedH;

/** Pad, raised work-cell platform, edge marking, guard rail / spikes at the platform front */
function foundation(c) {
  const { b, S, kit } = c;
  const P = LAYOUT.plat;
  const G = LAYOUT.pad;
  const D = DETAIL;
  b.box(G.hx * 2, G.h, G.hz * 2, S.ground, { base: true });
  const pz = (P.z0 + P.z1) / 2;
  b.box(P.hx * 2, P.h, P.z1 - P.z0, S.teamShade, { base: true, y: G.h, z: pz, detail: 2 });   // the whole work-cell floor is team paint
  marking(b, kit, P.hx * 2 - 2, D.edgeMarkH, { y: G.h + P.h / 2, z: P.z1 + D.markOut });
  const top = platTop();
  const zr = P.z1 - D.railInset;
  if (kit.style.markings === 'hazard') {   // safety rail (guarded style)
    b.box(P.hx * 2 - 1, D.railT, D.railT, S.accent, { y: top + D.railH, z: zr });
    for (let x = -P.hx + 0.5; x <= P.hx - 0.4; x += D.railStep) b.box(D.railT, D.railH, D.railT, S.frame, { base: true, x, y: top, z: zr });
  } else if (kit.style.fan === 'open') {   // bare spikes, no protection
    for (let x = -P.hx + 1; x <= P.hx - 0.9; x += D.railStep) spike(b, kit, { x, y: top, z: zr, h: D.spikeH, r: D.spikeR });
  }
}

/** Pedestal under one robot arm (top = shoulder pivot) by silhouette */
function pedestal(c, sil, x, z) {
  const { b, S, kit } = c;
  const A = LAYOUT.arm;
  const P = DETAIL.pedestal;
  const y0 = platTop();
  if (sil === 'angular') {
    b.box(P.flange, P.flangeH, P.flange, S.hullDark, { base: true, x, y: y0, z });
    b.taperedBox(3.2, 2.2, A.pedH - P.flangeH, 3.2, S.hull, { x, y: y0 + P.flangeH, z }, 2.2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: x + sx * 1.7, y: y0 + P.flangeH, z: z + sz * 1.7, h: 0.8, r: 0.2 });
  } else if (sil === 'round') {
    b.cylinder(0.9, 1.5, A.pedH * 0.8, 20, S.hull, { x, y: y0 + A.pedH * 0.4, z });
    b.sphere(1.3, 14, 10, S.hull, { x, y: y0 + A.pedH - 0.9, z });
    b.torus(1.2, 0.07, 4, 20, TAU, S.neon, { rx: Math.PI / 2, x, y: y0 + A.pedH * 0.45, z });
  } else if (sil === 'faceted') {
    b.taperedBox(2.6, 0.8, A.pedH, 2.6, S.hullDark, { x, y: y0, z, ry: Math.PI / 4 }, 0.8);
    b.box(0.5, 0.5, 0.5, S.lens, { x, y: y0 + A.pedH + 0.1, z, rx: Math.PI / 4, rz: Math.PI / 4 });
  } else {
    b.cylinder(1.25, 1.5, A.pedH, 20, S.hull, { x, y: y0 + A.pedH / 2, z });
    b.cylinder(1.55, 1.55, P.collarH, 20, S.frame, { x, y: y0 + A.pedH - P.collarH / 2, z });
    b.torus(1.45, 0.08, 4, 24, TAU, S.team, { rx: Math.PI / 2, x, y: y0 + A.pedH * 0.35, z });
  }
}

/** Work table (top at table.topY) by silhouette; the torso travels over it */
function table(c, sil) {
  const { b, S, kit, glows } = c;
  const T = LAYOUT.table;
  const D = DETAIL.table;
  const y0 = platTop();
  const len = T.hx * 2;
  const neon = kit.style.neon >= DETAIL.neonMin;
  if (sil === 'round') {   // levitating disc with a neon rim
    b.cylinder(D.discR, D.discR * 1.1, D.discH, 40, S.hull, { x: 0, y: y0 + D.discH / 2, z: T.z });
    b.torus(D.discR, D.ringTube, 4, 48, TAU, S.neon, { rx: Math.PI / 2, y: y0 + D.discH, z: T.z });
    return;
  }
  if (sil === 'faceted') {   // slim faceted slab, laser rails on its edges
    b.taperedBox(len, len * 0.9, T.topY - y0, T.d, S.hullDark, { y: y0, z: T.z }, T.d);
    const laser = glows.get('laser');
    for (const e of [-1, 1]) {
      const a = [-T.hx + D.laserInset, T.topY + 0.05, T.z + e * (T.d / 2 - D.laserInset)];
      const z = [T.hx - D.laserInset, T.topY + 0.05, T.z + e * (T.d / 2 - D.laserInset)];
      laserLink(b, laser, kit, a, z);
    }
    return;
  }
  if (sil === 'angular') {   // heavy slab with clamps
    b.box(len, D.slabH, T.d, S.hullDark, { base: true, y: y0, z: T.z });
    b.box(len * D.plateShare, D.plateH, T.d * D.plateShare, S.dark, { y: y0 + D.slabH + D.plateH / 2, z: T.z });
    for (const e of [-1, 1]) b.box(0.6, 0.8, T.d * 1.05, S.frame, { x: e * (T.hx - 1), y: T.topY + 0.4, z: T.z });
    b.box(len, 0.5, 0.06, S.lower, { y: y0 + 0.5, z: T.z + T.d / 2 + 0.03 });
    return;
  }
  styledBox(b, kit, len, D.slabH, T.d, S.hull, { base: true, y: y0, z: T.z });
  b.box(len * D.plateShare, D.plateH, T.d * D.plateShare, S.frame, { y: y0 + D.slabH + D.plateH / 2, z: T.z });
  marking(b, kit, len * D.plateShare, DETAIL.edgeMarkH, { y: y0 + D.slabH / 2, z: T.z + T.d / 2 + DETAIL.markOut });
  if (neon) neonStrip(b, kit, len * D.plateShare, 0.08, 0.06, { y: T.topY - 0.1, z: T.z + T.d / 2 + 0.03 });
}

/** Both arm pedestals and the beacons of the cell */
function cell(c, sil) {
  for (const s of [-1, 1]) pedestal(c, sil, s * LAYOUT.arm.x, LAYOUT.arm.z);
  table(c, sil);
}

// ---------------------------------------------------------------- bodies

/** Wall-mounted flat details */
const frontDecal = (c, x, y, size) => c.decals.push({ position: [x, y, LAYOUT.hall.front], normal: [0, 0, 1], size });
const sideDecal = (c, sx, y, z, size) => c.decals.push({ position: [sx * LAYOUT.hall.hx, y, z], normal: [sx, 0, 0], size });

/** rounded: rounded halls with a stepped roof, windows, neon band, guarded fan, tank and pipes */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit, glows } = c;
  const H = LAYOUT.hall;
  const B = DETAIL.band;
  const y0 = LAYOUT.pad.h;
  const zc = (H.back + H.front) / 2;
  const depth = H.front - H.back;
  const roofY = y0 + D.hallH;
  styledBox(b, kit, H.hx * 2, D.hallH, depth, S.hull, { base: true, y: y0, z: zc });
  styledBox(b, kit, D.upper.w, D.upper.h, D.upper.d, S.teamPaint, { base: true, y: roofY, z: zc + D.upper.dz, detail: 2 });   // team-painted upper tier
  b.box(H.hx * 2 * B.share, B.h, B.t, S.team, { y: y0 + D.band.y, z: H.front + B.t / 2 });
  const Tm = TEAM.rounded;
  for (const sx of [-1, 1]) {
    teamPanel(b, kit, Tm.front.w, Tm.front.h, { x: sx * Tm.front.x, y: y0 + Tm.front.y, z: H.front });
    for (const e of [-1, 1]) teamPanel(b, kit, Tm.side.w, Tm.side.h, { x: sx * H.hx, y: y0 + Tm.side.y, z: zc + e * Tm.side.dz, ry: sx * Math.PI / 2 });
  }
  roofMark(b, kit, { x: 0, y: roofY, z: Tm.mark.z, w: Tm.mark.w, d: Tm.mark.d });
  teamTrim(b, kit, { x: 0, y: roofY, z: zc, w: H.hx * 2 - 2 * Tm.trimInset, d: depth - 2 * Tm.trimInset });
  teamBanner(b, kit, { x: Tm.banner.x, y: roofY, z: Tm.banner.z, h: Tm.banner.h });
  for (const sx of [-1, 1]) {
    const W = D.win;
    b.box(W.fw, W.fh, W.t, S.frame, { x: sx * W.x, y: y0 + W.y, z: H.front + W.t / 2 });
    b.box(W.gw, W.gh, W.t, S.window, { x: sx * W.x, y: y0 + W.y, z: H.front + W.t / 2 + W.out });
  }
  if (kit.style.neon >= DETAIL.neonMin) neonStrip(b, kit, H.hx * 2 * 0.9, D.neon.h, D.neon.t, { y: roofY - D.neon.drop, z: H.front + D.neon.t / 2 });
  frontDecal(c, 0, y0 + D.decal.y, D.decal.front);
  sideDecal(c, -1, y0 + D.decal.y, zc, D.decal.side);
  sideDecal(c, 1, y0 + D.decal.y, zc, D.decal.side);
  c.vent = ventUnit(b, glows, kit, { x: D.vent.x, y: roofY, z: zc + D.vent.dz, r: D.vent.r });
  const T = D.tank;
  tank(b, kit, { x: T.x, y: roofY + T.rise + T.r, z: zc + T.dz, r: T.r, len: T.len, floorY: roofY });
  pipeRun(b, kit, [[D.pipe.x, roofY + T.rise + T.r, zc + T.dz], [D.pipe.x, roofY, zc + T.dz]], D.pipe.r);
  for (const s of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [s * D.beacons.x, roofY, H.front - DETAIL.beaconInset]);
};

/** angular: armoured block, sloped armour, buttresses, spiked parapet, chimneys and a bare fan */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit, glows } = c;
  const H = LAYOUT.hall;
  const y0 = LAYOUT.pad.h;
  const zc = (H.back + H.front) / 2;
  const depth = H.front - H.back;
  const y1 = y0 + D.blockH;
  const roofY = y1 + D.slope.h;
  b.box(H.hx * 2, D.blockH, depth, S.hull, { base: true, y: y0, z: zc });
  b.taperedBox(H.hx * 2, D.slope.topW, D.slope.h, depth, S.teamPaint, { y: y1, z: zc, detail: 2 }, depth - D.slope.inset);   // team-painted armour crown
  const Bt = D.buttress;
  for (const x of Bt.front) {
    b.box(Bt.w, Bt.h, Bt.t, S.hullDark, { base: true, x, y: y0, z: H.front + Bt.t / 2 });
    b.box(Bt.footW, Bt.footH, Bt.footT, S.frame, { base: true, x, y: y0, z: H.front + Bt.footT / 2 });
  }
  for (const sx of [-1, 1]) for (const z of Bt.side) {
    b.box(Bt.t, Bt.h, Bt.w, S.hullDark, { base: true, x: sx * (H.hx + Bt.t / 2), y: y0, z });
    b.box(Bt.footT, Bt.footH, Bt.footW, S.frame, { base: true, x: sx * (H.hx + Bt.footT / 2), y: y0, z });
  }
  const Pl = D.plate;
  for (const sx of [-1, 1]) {   // plate / team bands leave the front emblem free
    b.box(Pl.w, Pl.h, Pl.t, S.teamShade, { x: sx * Pl.x, y: y0 + Pl.y, z: H.front + Pl.t / 2, detail: 2 });
    b.box(Pl.w, D.team.h, Pl.t, S.team, { x: sx * Pl.x, y: y0 + D.team.y, z: H.front + Pl.t / 2 });
  }
  frontDecal(c, 0, y0 + D.decal.y, D.decal.front);
  sideDecal(c, -1, y0 + D.decal.y, zc, D.decal.side);
  sideDecal(c, 1, y0 + D.decal.y, zc, D.decal.side);
  const Pp = D.parapet;
  const pz = H.front - D.slope.inset / 2 - Pp.t / 2;
  b.box(D.slope.topW, Pp.h, Pp.t, S.hullDark, { base: true, y: roofY, z: pz });
  for (let x = -D.slope.topW / 2 + 1; x <= D.slope.topW / 2 - 0.9; x += Pp.step) spike(b, kit, { x, y: roofY + Pp.h, z: pz, h: Pp.spikeH, r: Pp.spikeR });
  for (const [x, z] of D.chimneys) chimney(b, kit, { x, y: roofY, z, h: D.chimneyH, r: D.chimneyR });
  c.vent = ventUnit(b, glows, kit, { x: D.vent.x, y: roofY, z: zc + D.vent.dz, r: D.vent.r });
  for (const s of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [s * D.beacons.x, D.beacons.y, H.front + 0.4]);
};

/** round: lying cylinder hall with flat emblem ends, neon rings, a plasma orb on top and plasma coils in the cell */
BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const H = LAYOUT.hall;
  const y0 = LAYOUT.pad.h;
  const zc = (H.back + H.front) / 2;
  const cy = y0 + D.r;
  const len = H.hx * 2;
  b.cylinder(D.r, D.r, len, D.segments, S.hull, { rz: Math.PI / 2, y: cy, z: zc });
  const front = zc + D.r;
  b.box(D.plate.size, D.plate.size, D.plate.d, S.hull, { y: cy, z: front - D.plate.back });
  c.decals.push({ position: [0, cy, front - D.plate.back + D.plate.d / 2], normal: [0, 0, 1], size: D.decal.front });
  for (const sx of [-1, 1]) c.decals.push({ position: [sx * H.hx, cy, zc], normal: [sx, 0, 0], size: D.decal.end });
  if (kit.style.neon >= DETAIL.neonMin) {
    for (const x of D.ring.xs) b.torus(D.r + D.ring.out, D.ring.tube, 4, 48, TAU, S.neon, { ry: Math.PI / 2, x, y: cy, z: zc });
  }
  const Tm = TEAM.round;
  for (const x of D.band.xs) b.torus(D.r + D.ring.out, D.band.tube, 4, 48, TAU, S.team, { ry: Math.PI / 2, x, y: cy, z: zc });
  for (const sx of [-1, 1]) {   // wide team rings (open cylinders) round the hall
    for (const r of Tm.rings) b.cylinder(D.r + Tm.out, D.r + Tm.out, r.w, D.segments, S.teamPaint, { rz: Math.PI / 2, x: sx * r.x, y: cy, z: zc, detail: 2 }, true);
  }
  teamBanner(b, kit, { x: Tm.banner.x, y: platTop(), z: Tm.banner.z, h: Tm.banner.h });
  if (kit.rich) {   // neon veins along the hall
    neonStrip(b, kit, len - 2, D.ridge.w, D.ridge.w, { y: cy + D.r + 0.02, z: zc });
    for (const e of [-1, 1]) neonStrip(b, kit, len - 2, D.ridge.w, D.ridge.w, { y: cy + D.r * Math.sin(D.ridge.angle), z: zc + e * D.r * Math.cos(D.ridge.angle) });
  }
  c.vent = ventUnit(b, glows, kit, { x: D.vent.x, y: cy + D.r - D.vent.sink, z: zc, r: D.vent.r });
  const K = D.coil;
  for (const s of [-1, 1]) {
    plasmaCoil(b, glows.get('pulse'), kit, { x: s * K.x, y: platTop(), z: K.z, h: K.h, r: K.r });
    beacon(b, glows.get('beaconA'), kit, [s * D.beacons.x, platTop(), D.beacons.z]);
  }
};

/** faceted: slim chamfered hall with a diamond crown, lens plates, radiators and laser-linked emitter towers */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const H = LAYOUT.hall;
  const y0 = LAYOUT.pad.h;
  const zc = (H.back + H.front) / 2;
  const depth = H.front - H.back;
  const roofY = y0 + D.hallH;
  const laser = glows.get('laser');
  b.taperedBox(H.hx * 2, D.topW, D.hallH, depth, S.hull, { y: y0, z: zc }, depth);
  const run = (H.hx * 2 - D.topW) / 2;
  for (const sx of [-1, 1]) {   // side emblems on the sloped wall
    const yRel = D.decal.y;
    const tilt = Math.atan2(run, D.hallH);
    c.decals.push({ position: [sx * (H.hx - (run * yRel) / D.hallH), y0 + yRel, zc], normal: [sx * Math.cos(tilt), Math.sin(tilt), 0], size: D.decal.side });
  }
  frontDecal(c, 0, y0 + D.decal.y, D.decal.front);
  const Bd = DETAIL.band;
  for (const sx of [-1, 1]) {
    b.box(H.hx * 2 * D.band.share, Bd.h, Bd.t, S.team, { x: sx * H.hx * D.band.at, y: y0 + D.band.y, z: H.front + Bd.t / 2 });
    const L = D.lens;
    b.box(L.s, L.s, L.t, S.hullDark, { x: sx * L.x, y: y0 + L.y, z: H.front + L.t / 2, rz: Math.PI / 4 });
    b.box(L.core, L.core, L.t, S.neon, { x: sx * L.x, y: y0 + L.y, z: H.front + L.t, rz: Math.PI / 4 });
    neonStrip(b, kit, D.edgeNeon, D.edgeNeon, depth, { x: sx * D.topW / 2, y: roofY });
  }
  const Cr = D.crown;
  b.box(Cr.w, Cr.w, depth - 1, S.teamPaint, { x: Cr.x, y: roofY, z: zc, rz: Math.PI / 4, detail: 2 });   // team-painted diamond crown
  const Tm = TEAM.faceted;
  roofMark(b, kit, { x: Tm.mark.x, y: roofY, z: zc, w: Tm.mark.w, d: Tm.mark.d });
  teamBanner(b, kit, { x: Tm.banner.x, y: roofY, z: Tm.banner.z, h: Tm.banner.h });
  const peak = roofY + (Cr.w * Math.SQRT2) / 2;
  spike(b, kit, { x: Cr.x, y: peak, z: H.front - 1, h: Cr.spike, r: 0.3 });
  laser.segment([Cr.x, peak, H.back + 0.5], [Cr.x, peak, H.front - 0.5], PROC_MODULES.laser.thickness);
  c.vent = ventUnit(b, glows, kit, { x: D.vent.x, y: roofY, z: zc, r: D.vent.r });
  const T = D.tower;
  const A = LAYOUT.arm;
  for (const sx of [-1, 1]) {   // emitter towers linked to the arm pedestals by lasers
    b.taperedBox(T.w, T.topW, T.h, T.w, S.teamPaint, { x: sx * T.x, y: platTop(), z: T.z, ry: Math.PI / 4, detail: 2 }, T.topW);
    const top = platTop() + T.h;
    b.cylinder(T.lensR, T.lensR * 0.7, T.lensH, 10, S.lens, { x: sx * T.x, y: top + T.lensH / 2, z: T.z });
    beacon(b, glows.get('beaconA'), kit, [sx * T.x, top + T.lensH, T.z]);
    laserLink(b, laser, kit, [sx * T.x, top, T.z], [sx * A.x, shoulderY() + 0.4, A.z]);
  }
};

// ---------------------------------------------------------------- animated parts (shared geometry per style)

/** Upper arm and forearm; local +X is the arm direction, origin at the joint (shoulder / elbow) */
function buildArm(kit, sil) {
  const S = kit.S;
  const { L1, L2, yokeW, torchY } = LAYOUT.arm;
  const up = new PartBuilder();
  const fo = new PartBuilder();
  const beamX = (len, from) => ({ x: from + (len - from) / 2 });
  if (sil === 'angular') {
    up.box(1.6, 1.6, yokeW + 0.3, S.hullDark);
    up.box(L1 - 1.2, 1.2, 1.2, S.hull, beamX(L1 - 0.6, 0.6));
    for (let i = 0; i < 3; i++) up.box(0.25, 1.5, 1.5, S.frame, { x: 1.6 + i * 1.4 });
    up.box(1.2, 1.4, 1.5, S.hullDark, { x: L1 });
    fo.box(L2 - 1, 0.9, 0.9, S.hull, beamX(L2 - 0.5, 0.5));
    fo.box(0.9, 1.0, 1.0, S.hullDark, { x: L2 - 0.3 });
  } else if (sil === 'round') {
    up.sphere(0.95, 14, 10, S.hull);
    up.cylinder(0.55, 0.45, L1 - 1.2, 14, S.hull, { rz: -Math.PI / 2, x: 0.6 + (L1 - 1.2) / 2 });
    up.torus(0.55, 0.06, 4, 16, TAU, S.neon, { ry: Math.PI / 2, x: L1 * 0.5 });
    up.sphere(0.7, 12, 8, S.hull, { x: L1 });
    fo.cylinder(0.42, 0.3, L2 - 0.8, 12, S.hull, { rz: -Math.PI / 2, x: 0.4 + (L2 - 0.8) / 2 });
    fo.torus(0.4, 0.05, 4, 14, TAU, S.neon, { ry: Math.PI / 2, x: L2 * 0.45 });
  } else if (sil === 'faceted') {
    up.box(1.3, 1.3, yokeW, S.hullDark, { rx: 0, rz: Math.PI / 4 });
    up.box(L1 - 1.2, 0.8, 0.8, S.hullDark, { ...beamX(L1 - 0.6, 0.6), rx: Math.PI / 4 });
    up.box(L1 - 1.6, 0.05, 0.05, S.neon, { ...beamX(L1 - 0.8, 0.8), y: 0.6 });
    up.box(0.6, 0.6, 0.6, S.lens, { x: L1, rx: Math.PI / 4, rz: Math.PI / 4 });
    fo.box(L2 - 0.8, 0.55, 0.55, S.hullDark, { ...beamX(L2 - 0.4, 0.4), rx: Math.PI / 4 });
    fo.box(L2 - 1.2, 0.04, 0.04, S.neon, { ...beamX(L2 - 0.6, 0.6), y: 0.4 });
  } else {
    up.cylinder(0.85, 0.85, yokeW, 16, S.frame, { rx: Math.PI / 2 });
    up.box(L1 - 1.0, 0.8, 0.8, S.hull, beamX(L1 - 0.4, 0.6));
    up.box(0.5, 0.9, 0.9, S.team, { x: L1 * 0.55 });
    up.cylinder(0.7, 0.7, 1.2, 16, S.frame, { rx: Math.PI / 2, x: L1 });
    fo.box(L2 - 0.8, 0.6, 0.6, S.hull, beamX(L2 - 0.4, 0.5));
    fo.box(0.4, 0.7, 0.7, S.team, { x: L2 * 0.5 });
  }
  fo.cylinder(0.12, 0.3, -torchY, 8, S.trim, { x: L2, y: torchY / 2 });    // torch (nozzle at the bottom)
  fo.box(0.7, 0.5, 0.5, S.frame, { x: L2 - 0.1 });
  fo.sphere(0.13, 8, 6, S.lens, { x: L2, y: torchY });
  return { upper: up.build(), fore: fo.build() };
}

/** The torso being built (origin at its bottom centre) */
function buildPart(kit) {
  const S = kit.S;
  const P = LAYOUT.part;
  const b = new PartBuilder();
  b.box(P.w, P.h, P.d, S.hullDark, { base: true });
  b.box(P.w * 0.75, 0.6, P.d * 0.8, S.hull, { base: true, y: P.h });
  b.box(P.w * 0.5, 0.35, P.d * 0.5, S.frame, { base: true, y: P.h + 0.6 });
  b.box(P.w * 0.55, 0.7, 0.1, S.team, { y: P.h * 0.5, z: P.d / 2 + 0.05 });
  for (const s of [-1, 1]) b.box(0.4, 0.8, 0.8, S.frame, { x: s * (P.w / 2 + 0.2), y: P.h * 0.8 });
  return b.build();
}

/** Weld glow in the torch frame (origin = torch tip, pointing −Y), by style.fan */
function buildWeld(kit) {
  const g = new GlowBuilder();
  const kind = WELD_BY_FAN[kit.style.fan] ?? 'spark';
  const W = DETAIL.weld;
  if (kind === 'laser') {
    const L = W.laser;
    g.segment([0, 0, 0], [0, -L.len, 0], L.thick);
    g.point([0, -L.len, 0], L.tip);
    g.box(L.cross, L.crossT, L.crossT, { y: -L.len });
    g.box(L.crossT, L.crossT, L.cross, { y: -L.len });
  } else if (kind === 'plasma') {
    const P = W.plasma;
    g.sphere(P.ball, 10, 6, { y: -P.lift });
    g.torus(P.ring, P.ringTube, 4, 20, TAU, { rx: Math.PI / 2, y: -P.lift });
    g.segment([0, 0, 0], [0, -P.beam, 0], P.beamT);
  } else {
    const S = W.spark[kit.style.fan] ?? W.spark.guarded;
    g.point([0, -W.spark.lift, 0], S.r);
    for (let i = 0; i < S.n; i++) {
      const a = (i / S.n) * TAU;
      g.segment([0, -W.spark.lift, 0], [Math.cos(a) * S.len * 0.6, -S.len, Math.sin(a) * S.len * 0.6], W.spark.thick);
    }
  }
  return g.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const c = { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vent: null };
  foundation(c);
  cell(c, sil);
  BODIES[sil](c);
  const vent = c.vent ?? {};
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    arm: buildArm(kit, sil),
    part: buildPart(kit),
    weld: buildWeld(kit),
    fanBase: vent.fan ?? null,
    fan: vent.fan ? fanBladesGeometry(kit, vent.r, vent.blades) : null,
    ringSpot: vent.ring ? [vent.ring.x, vent.ring.y, vent.ring.z] : null,
    ring: vent.ring ? ringGeometry(kit, vent.ring.r) : null,
  };
}

const PART_FACTORY_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

const quantize = (v, step) => (step > 0 ? Math.round(v / step) * step : v);

// ---------------------------------------------------------------- the model

export class RobotPartFactoryProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: PART_FACTORY_CACHE, name: 'RobotPartFactoryProc' });
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
    const A = PART_FACTORY_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;
    const Arm = LAYOUT.arm;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);

    // robot arms: yaw group → upper arm (shoulder pitch) → forearm (elbow pitch) → torch tip with the weld glow
    const weldColor = WELD_BY_FAN[kit.style.fan] === 'laser' ? gc.laser : gc.arc;
    this.arms = [-1, 1].map((side) => {
      const yaw = new THREE.Group();
      yaw.position.set(side * Arm.x, shoulderY(), Arm.z);
      this.add(yaw);
      const shoulder = this.paintMesh(sh.arm.upper, yaw);
      const elbow = new THREE.Group();
      elbow.position.x = Arm.L1;
      shoulder.add(elbow);
      this.paintMesh(sh.arm.fore, elbow);
      const tip = new THREE.Group();
      tip.position.set(Arm.L2, Arm.torchY, 0);
      elbow.add(tip);
      const weld = this.glowLayer(sh.weld, weldColor, { parent: tip, visible: false });
      return { x: side * Arm.x, seamX: side * Arm.seamX, yaw, shoulder, elbow, tip, weld, flick: 1, phi: 0 };
    });

    // the torso on the table: stops at every welding position (jerky when the style is)
    this.partMesh = this.paintMesh(sh.part);
    this.partMesh.position.set(0, LAYOUT.table.topY, LAYOUT.table.z);
    this.mover = new TrackMover({
      rest: [0], stops: LAYOUT.table.stops.map((x) => [x]), speed: [A.tableSpeed * an.tempo], dwell: A.dwell,
      steps: an.jerk > 0 ? A.jerkSteps : 0,
    });

    // roof vent part: fan turns, plasma ring floats (radiator styles heat up instead)
    this.spinner = null;
    this.levitator = null;
    if (sh.fan) {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(sh.fanBase[0], sh.fanBase[1], sh.fanBase[2]);
      const jitter = (((seq * 3) % 7) / 6 - 0.5) * 2 * A.fanJitter;
      this.spinner = new Spinner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter), ease: A.fanEase, phase: (seq * 0.7) % TAU });
    }
    if (sh.ring) {
      const ring = this.paintMesh(sh.ring);
      ring.position.set(sh.ringSpot[0], sh.ringSpot[1], sh.ringSpot[2]);
      const lev = PROC_MODULES.levitate;
      this.levitator = new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin, phase: seq * 0.37 });
    }

    this.rng = makeRng(A.seed + seq);
    this.flickClock = 0;
    this.power = 0;
    this.weldShare = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). Idle: arms folded, no weld, beacons dim. Active (producing): the torso moves
   * along the table and stops three times, the arms lower and weld (sparks / plasma / laser), fan spins up, plasma ring
   * floats, radiators heat up, beacons blink.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const A = PART_FACTORY_ANIM;
    const an = this.kit.style.anim;
    const Arm = LAYOUT.arm;
    this.time += delta;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);

    this.mover.update(delta, active);
    const px = this.mover.value[0];
    this.partMesh.position.x = px;
    const dwelling = active && this.mover.phase === 'dwell';
    const target = dwelling ? plateau(this.mover.dwellT, A.dwellEdge) : 0;
    this.weldShare += (target - this.weldShare) * Math.min(1, delta * A.weldEase);

    this.flickClock += delta;
    const reflick = this.flickClock >= 1 / A.flickerRate;
    if (reflick) this.flickClock %= 1 / A.flickerRate;
    const wob = Math.sin(this.time * A.wobble.freq) * A.wobble.amp * this.weldShare;
    const step = an.jerk > 0 ? A.jerkAngle : 0;
    const R = A.rest;
    const T = LAYOUT.table;
    const p = this.power;
    const w = this.weldShare;
    const sy = shoulderY();
    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      // aim point: folded (idle) → above the torso (working) → down at the weld seam (stopped)
      const ax = R.xShare * arm.x + (px + wob + arm.seamX - R.xShare * arm.x) * p;
      const ay = R.y + (Arm.weldY + (1 - w) * A.lift - R.y) * p;
      const az = R.z + (T.z + Arm.seamZ - R.z) * p;
      const dx = ax - arm.x;
      const dz = az - Arm.z;
      // the aim point is the torch TIP: the IK solves for the wrist = tip minus the torch offset (rotated by last frame's forearm angle)
      const d = Math.hypot(dx, dz) + Arm.torchY * Math.sin(arm.phi);
      const ty = ay - sy - Arm.torchY * Math.cos(arm.phi);
      let c = (d * d + ty * ty - Arm.L1 * Arm.L1 - Arm.L2 * Arm.L2) / (2 * Arm.L1 * Arm.L2);
      c = c < -1 ? -1 : c > 1 ? 1 : c;
      const el = -Math.acos(c);
      const sh = Math.atan2(ty, d) - Math.atan2(Arm.L2 * Math.sin(el), Arm.L1 + Arm.L2 * Math.cos(el));
      const qs = quantize(sh, step);
      const qe = quantize(el, step);
      arm.yaw.rotation.y = quantize(Math.atan2(-dz, dx), step);
      arm.shoulder.rotation.z = qs;
      arm.elbow.rotation.z = qe;
      arm.phi = qs + qe;
      arm.tip.rotation.z = -arm.phi;         // torch glow stays vertical
      if (reflick) arm.flick = A.flickerMin + (1 - A.flickerMin) * this.rng();
      arm.weld.setIntensity(w > A.weldMin ? w * arm.flick : 0);
    }

    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * p);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
    this.spinner?.update(delta, active);
    this.levitator?.update(delta, active);
  }
}
