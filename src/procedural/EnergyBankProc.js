// Steel Men – procedural energy bank (accumulator). A drop-in alternative to
// models/3DStructures{race}/EnergyBank{race}_Anim.glb built in code from the style modules (ProcModules.js) and the
// faction style (data/buildingStyles.json):
//   • footprint: pad ±6.9 × ±6.9 around the model origin (GLB: ±8 / ±8 / ±6.98 for the three races), front = +Z
//   • a bank of cell stacks: every column is a stack of N slices with a dark core and a gap between the slices; the gaps
//     light up from the bottom as the bank charges (ONE glow layer, `setDrawRange` over level-major vertices → 1 draw call)
//     – the visible charge level. Colour = style.reactorGlow (blue / red / violet / orange)
//   • body per style.silhouette (BODIES): rounded = 3 round cell tanks on a plinth with guarded vents · angular = 4 slab
//     cells on an armoured base with spikes, open fans, chimneys · round = 3 pancake stacks around a plasma orb with arcs and
//     levitating rings · faceted = 3 crystal columns, laser links to emitter posts and a floating crystal, radiators
//   • animated: fans / plasma-orb rings / floating crystal / levitating rings (faster with power), pulsing charge glow,
//     radiators heat up with the charge (faceted), arcs flash when nearly full (round), beacons blink while charging
// Charge: setCharge(0..1) from outside (Structure/Economy, visual only); without a call the model shows a slow demo cycle
// (breathing charge level) so it is visible in the preview. update() reads nothing from the simulation. No allocations there.
import * as THREE from 'three';
import { PartBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, pipeRun, chimney, laserLink, arcGeometry, ArcFlicker, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
  teamTrim, roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; style.anim multiplies speeds) */
export const BANK_ANIM = {
  fanSpeed: 4.0,          // rad/s at full power (× style.anim.spin)
  fanJitter: 0.25,
  idleShare: 0.4,         // speed share of the moving parts at zero charge
  idleGlow: 0.55,         // charge glow share at zero power
  chargeEase: 1.2,        // 1/s – how fast the shown level follows the target charge
  demoPeriod: 26,         // s – one breathing cycle of the demo charge (until setCharge is called)
  demoMin: 0.2,
  demoMax: 0.95,
  demoPhase: 3.1,         // s – demo phase offset per instance
  busyEps: 0.015,         // |target − shown| above which the bank counts as charging / discharging (beacons blink)
  arcCharge: 0.9,         // charge from which the plasma arcs flash
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
  arcSeed: 7213,
};

/** Shared layout (model units, GLB scale; front = +Z) */
const LAYOUT = {
  padHalf: 6.9, padH: 0.15,
  levels: 8,              // glow levels of every column (= steps of the charge display)
  neonMin: 0.3,           // style.neon from which neon trim is added
  coreShare: 0.8,         // dark core of a column, share of the slice size
  glowShare: 0.94,        // glow in the gap, share of the slice size
  decalMargin: 0.02,
};

/** Small details (model units) */
const DETAIL = {
  band: { h: 0.25, t: 0.06 },
  control: { neonH: 0.08, neonT: 0.05, markH: 0.4, markLen: 0.9, markOut: 0.02, decalLift: 0.6 },
  cap: { neonTube: 0.07, neonOut: 0.02, torusSeg: 24 },
  bus: { neonH: 0.06, neonT: 0.06, beaconInset: 0.3 },
  spike: { h: 0.8, r: 0.22, inset: 0.28 },
  crystal: { stretch: 2.4, tipLift: 1.25, halo: 1.1 },
};

/**
 * Team paint (large surfaces, visible from the RTS camera down to LOD2; docs/notes/proc-teampaint-c.md): the platform top / stage,
 * collars, caps and the bus bar are team paint (S.teamPaint / S.teamShade), plus a lip round the base and a roof mark by silhouette.
 */
const TEAM = {
  detail: 2,              // coarsest LOD the team surfaces still appear in
  slab: { t: 0.05, lift: 0.03, inset: 0.6 },   // rounded: team slab on the plinth top, neutral rim kept round it
  trimH: 0.6,             // lip height (× style.teamPaint.trim)
  trimOut: 0.6,           // angular: lip round the base, outside the base footprint
  ringOut: 0.05,          // round: lip ring radius beyond the disc
  mark: { z: -3.6, w: 7, d: 3.2 },   // faceted: roof mark on the stage behind the columns
};

/** Cell column kinds: how one slice looks (code knows shapes, the style data picks one through the body) */
const SLICE_SEGMENTS = 20;

/**
 * Dimensions of every body by style.silhouette (unknown → rounded). `col` = the cell stacks: kind cyl / slab / pancake /
 * diamond, r = half size (diamond: half diagonal), slice / gap = slice thickness / glow gap.
 */
const DIM = {
  rounded: {
    base: { w: 12.8, h: 1.0, d: 12.4, edge: 1 },
    col: { kind: 'cyl', r: 1.5, slice: 0.62, gap: 0.22, cols: [[-4, -1], [0, -1], [4, -1]] },
    collar: { h: 0.3, over: 0.3 },
    cap: { h: 0.45, over: 0.25 },
    bus: { w: 9.2, h: 0.4, d: 0.7, lift: 0.25, z: -1, x: [-4.6, 4.6] },
    control: { w: 3.0, h: 2.6, d: 1.4, z: 4.6 },
    cabinet: { w: 2.4, h: 1.8, d: 1.6, x: 4.6, z: 4.6 }, ventR: 0.8,
    pipe: { x: 4.6, y: 0.6, z0: 3.8, z1: 0.3, r: 0.22 },
    decalSide: { y: 0.5, size: 0.6 },
  },
  angular: {
    base: { w: 13.0, h: 0.8, d: 12.8, taperW: 12.2, taperTop: 10.6, taperH: 0.9 },
    col: { kind: 'slab', r: 1.3, slice: 0.62, gap: 0.24, cols: [[-3.0, -3.0], [3.0, -3.0], [-3.0, 0.9], [3.0, 0.9]] },
    collar: { h: 0.35, over: 0.4 },
    cap: { h: 0.5, over: 0.4 },
    bus: { w: 6.0, h: 0.5, d: 0.9, lift: 0.5, z: 0.9 },
    control: { w: 4.0, h: 2.4, d: 1.6, z: 4.2 },
    vents: [[-3.9, 4.0], [3.9, 4.0]], ventR: 1.0,
    chimneys: [[-4.7, -4.7], [4.7, -4.7]], chimneyH: 3.2, chimneyR: 0.5,
    pipe: { x: 3.9, y: 0.6, z0: 2.9, x1: 3.0, z1: 1.4, r: 0.3 },
    bandY: 0.55,
  },
  round: {
    disc: { r: 6.6, h: 0.7 }, tier: { r: 5.7, h: 0.5 }, ring: { r: 6.45, tube: 0.09, seg: 48 },
    col: { kind: 'pancake', r: 1.2, slice: 0.6, gap: 0.24, cols: [[0, -2.9], [-2.5, 1.45], [2.5, 1.45]] },
    cap: { r: 1.05, sy: 0.4, lift: 0.3 },
    pylon: { r: 0.35, over: 0.8 },
    orb: { r: 1.1, lift: 1.5, halo: 1.45, capRise: 0.6 },
    rings: [{ r: 2.3, dy: 0.5, tube: 0.06 }, { r: 2.9, dy: -0.4, tube: 0.06 }], ringAmp: 0.25,
    vents: [[-3.6, 3.6], [3.6, 3.6]], ventR: 0.8,
    pod: { r: 1.3, h: 2.2, z: 4.2, neonT: 0.06, domeSy: 0.5 },
  },
  faceted: {
    stage: { rTop: 6.2, rBottom: 6.4, h: 0.6, segments: 8, neonTube: 0.06 },
    col: { kind: 'diamond', r: 1.0, slice: 0.6, gap: 0.22, cols: [[-3.4, -0.5], [0, -0.5], [3.4, -0.5]] },
    collar: { w: 1.9, h: 0.3 },
    cap: { w: 1.7, h: 0.3 },
    crystal: { size: 0.9, floatLift: 1.5, floatAmp: 0.3 },
    post: { x: 6.0, z: -0.5, h: 3.2, rTop: 0.22, rBottom: 0.4, lensR: 0.28 },
    vents: [[-4.0, 3.6], [4.0, 3.6]], ventR: 0.9,
    plate: { w: 2.8, topW: 1.2, h: 3.0, d: 0.5, topD: 0.3, z: 5.2, decalY: 0.9 },
    apron: { len: 3.6, h: 0.4, z: 5.9 },
  },
};

const BODIES = {};   // silhouette → body function (filled below)

// ---------------------------------------------------------------- shared helpers (construction time only)

/** Decal facing +Z on a flat front */
const frontDecal = (c, x, y, z, size) => c.decals.push({ position: [x, y, z], normal: [0, 0, 1], size });

/** Pad under every body */
function pad(c) {
  const L = LAYOUT;
  c.b.box(L.padHalf * 2, L.padH, L.padHalf * 2, c.S.ground, { base: true });
}

/**
 * The cell stacks. Level-major order: for every level the slices of all columns, then their gap glows – so the glow vertices
 * of level k are the range [0, levelEnds[k]) of the 'charge' layer. Returns the top of the stacks.
 */
function columns(c, y0, spec) {
  const { b, S, glows } = c;
  const L = LAYOUT;
  const glow = glows.get('charge');
  const pitch = spec.slice + spec.gap;
  const h = L.levels * pitch;
  const r = spec.r;
  const side = r * Math.SQRT2;   // diamond: half diagonal r → side
  for (const [x, z] of spec.cols) {   // dark core through the whole stack
    const cy = y0 + h / 2;
    if (spec.kind === 'slab') b.box(r * 2 * L.coreShare, h, r * 2 * L.coreShare, S.dark, { x, y: cy, z });
    else if (spec.kind === 'diamond') b.box(side * L.coreShare, h, side * L.coreShare, S.dark, { x, y: cy, z, ry: Math.PI / 4 });
    else b.cylinder(r * L.coreShare, r * L.coreShare, h, SLICE_SEGMENTS, S.dark, { x, y: cy, z });
  }
  for (let lvl = 0; lvl < L.levels; lvl++) {
    const ys = y0 + lvl * pitch;
    const gy = ys + spec.slice + spec.gap / 2;
    for (const [x, z] of spec.cols) {
      switch (spec.kind) {
        case 'slab':
          b.box(r * 2, spec.slice, r * 2, S.hull, { x, y: ys + spec.slice / 2, z });
          glow.box(r * 2 * L.glowShare, spec.gap, r * 2 * L.glowShare, { x, y: gy, z });
          break;
        case 'diamond':
          b.box(side, spec.slice, side, S.hull, { x, y: ys + spec.slice / 2, z, ry: Math.PI / 4 });
          glow.box(side * L.glowShare, spec.gap, side * L.glowShare, { x, y: gy, z, ry: Math.PI / 4 });
          break;
        case 'pancake':   // flat lens: a sphere squashed to the slice thickness
          b.sphere(r, 14, 6, S.hull, { x, y: ys + spec.slice / 2, z, sy: spec.slice / (2 * r) });
          glow.cylinder(r * L.glowShare * L.coreShare, r * L.glowShare * L.coreShare, spec.gap, 16, { x, y: gy, z });
          break;
        default:
          b.cylinder(r, r, spec.slice, SLICE_SEGMENTS, S.hull, { x, y: ys + spec.slice / 2, z });
          glow.cylinder(r * L.glowShare, r * L.glowShare, spec.gap, SLICE_SEGMENTS, { x, y: gy, z });
      }
    }
    c.levelEnds.push(glow.vertices);
  }
  return y0 + h;
}

/** Neon ring around a cylinder top (when the style has neon) */
function neonRing(c, r, y) {
  if (c.kit.style.neon < LAYOUT.neonMin) return;
  const D = DETAIL.cap;
  c.b.torus(r + D.neonOut, D.neonTube, 4, D.torusSeg, TAU, c.S.neon, { rx: Math.PI / 2, y });
}

// ---------------------------------------------------------------- bodies

/** rounded: three round cell tanks on a plinth, bus bar on top, control block with the emblem, guarded vents, pipes */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const neon = kit.style.neon >= L.neonMin;
  pad(c);
  styledBox(b, kit, D.base.w, D.base.h, D.base.d, S.hullDark, { base: true, y: L.padH }, D.base.edge);
  const y1 = L.padH + D.base.h;
  const Tm = TEAM.slab;   // team slab over the plinth top (the neutral rim stays round it)
  b.box(D.base.w - 2 * Tm.inset, Tm.t, D.base.d - 2 * Tm.inset, S.teamPaint, { y: y1 + Tm.lift + Tm.t / 2, detail: TEAM.detail });
  for (const [x, z] of D.col.cols) b.cylinder(D.col.r + D.collar.over, D.col.r + D.collar.over, D.collar.h, SLICE_SEGMENTS, S.teamShade, { x, y: y1 + D.collar.h / 2, z, detail: TEAM.detail });
  const top = columns(c, y1 + D.collar.h, D.col);
  for (const [x, z] of D.col.cols) {
    b.cylinder(D.col.r + D.cap.over, D.col.r + D.cap.over, D.cap.h, SLICE_SEGMENTS, S.teamPaint, { x, y: top + D.cap.h / 2, z, detail: TEAM.detail });
    neonRing(c, D.col.r + D.cap.over, top + D.cap.h * 0.2);
  }
  const by = top + D.cap.h + D.bus.lift;
  b.box(D.bus.w, D.bus.h, D.bus.d, S.teamPaint, { y: by, z: D.bus.z, detail: TEAM.detail });
  if (neon) neonStrip(b, kit, D.bus.w, DETAIL.bus.neonH, DETAIL.bus.neonT, { y: by + D.bus.h / 2 + DETAIL.bus.neonH / 2, z: D.bus.z });
  for (const x of D.bus.x) beacon(b, glows.get('beaconA'), kit, [x, by + D.bus.h / 2, D.bus.z]);

  // control block with the emblem + hazard marking, a vent cabinet on each side
  const Ct = D.control;
  const Cd = DETAIL.control;
  styledBox(b, kit, Ct.w, Ct.h, Ct.d, S.hull, { base: true, y: y1, z: Ct.z }, 1);
  const front = Ct.z + Ct.d / 2;
  marking(b, kit, Ct.w * Cd.markLen, Cd.markH, { y: y1 + Cd.markH, z: front + Cd.markOut });
  if (neon) neonStrip(b, kit, Ct.w * Cd.markLen, Cd.neonH, Cd.neonT, { y: y1 + Ct.h - Cd.neonH * 2, z: front + Cd.neonT / 2 });
  frontDecal(c, 0, y1 + Cd.decalLift + Ct.h * 0.45, front, Ct.h * 0.6);
  const Cb = D.cabinet;
  for (const s of [-1, 1]) {
    styledBox(b, kit, Cb.w, Cb.h, Cb.d, S.hull, { base: true, x: s * Cb.x, y: y1, z: Cb.z }, 1);
    c.vents.push(ventUnit(b, glows, kit, { x: s * Cb.x, y: y1 + Cb.h, z: Cb.z, r: D.ventR }));
    pipeRun(b, kit, [[s * D.pipe.x, y1 + D.pipe.y, D.pipe.z0], [s * D.pipe.x, y1 + D.pipe.y, D.pipe.z1]], D.pipe.r);
    c.decals.push({ position: [s * (D.base.w / 2), L.padH + D.decalSide.y, 0], normal: [s, 0, 0], size: D.decalSide.size });
  }
};

/** angular: armoured base with rusty plates, four slab cells with spikes, heavy bus, open fans, chimneys, bunker */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  pad(c);
  const Bs = D.base;
  b.box(Bs.w, Bs.h, Bs.d, S.lower, { base: true, y: L.padH });
  b.taperedBox(Bs.taperW, Bs.taperTop, Bs.taperH, Bs.taperW, S.teamPaint, { y: L.padH + Bs.h, detail: TEAM.detail }, Bs.taperTop);   // sloped plinth top = team paint
  const y1 = L.padH + Bs.h + Bs.taperH;
  teamTrim(b, kit, { y: L.padH, w: Bs.w + TEAM.trimOut, d: Bs.d + TEAM.trimOut, h: TEAM.trimH });
  for (const [x, z] of D.col.cols) {
    b.box(D.col.r * 2 + D.collar.over, D.collar.h, D.col.r * 2 + D.collar.over, S.teamShade, { base: true, x, y: y1, z, detail: TEAM.detail });
  }
  const top = columns(c, y1 + D.collar.h, D.col);
  const cw = D.col.r * 2 + D.cap.over;
  const sp = DETAIL.spike;
  for (const [x, z] of D.col.cols) {
    b.box(cw, D.cap.h, cw, S.teamPaint, { base: true, x, y: top, z, detail: TEAM.detail });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: x + sx * (cw / 2 - sp.inset), y: top + D.cap.h, z: z + sz * (cw / 2 - sp.inset), h: sp.h, r: sp.r });
    beacon(b, glows.get('beaconA'), kit, [x, top + D.cap.h, z]);
  }
  b.box(D.bus.w, D.bus.h, D.bus.d, S.dark, { y: top + D.cap.h + D.bus.lift, z: D.bus.z });

  const Ct = D.control;
  b.taperedBox(Ct.w, Ct.w * 0.85, Ct.h, Ct.d, S.hullDark, { x: 0, y: y1, z: Ct.z }, Ct.d * 0.85);
  frontDecal(c, 0, y1 + Ct.h * 0.5, Ct.z + Ct.d / 2, Ct.h * 0.75);
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: y1, z, r: D.ventR }));
  for (const [x, z] of D.chimneys) chimney(b, kit, { x, y: y1, z, h: D.chimneyH, r: D.chimneyR });
  for (const s of [-1, 1]) {
    pipeRun(b, kit, [[s * D.pipe.x, y1 + D.pipe.y, D.pipe.z0], [s * D.pipe.x1, y1 + D.pipe.y, D.pipe.z1]], D.pipe.r);
  }
};

/** round: disc plinth, three pancake stacks around a plasma orb on a pylon, arcs, levitating rings, plasma vents, emblem pod */
BODIES.round = (c) => {
  const D = DIM.round;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const neon = kit.style.neon >= L.neonMin;
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  b.cylinder(D.disc.r, D.disc.r, D.disc.h, 48, S.teamShade, { y: L.padH + D.disc.h / 2, detail: TEAM.detail });
  b.cylinder(D.tier.r, D.tier.r, D.tier.h, 40, S.teamPaint, { y: L.padH + D.disc.h + D.tier.h / 2, detail: TEAM.detail });
  teamTrim(b, kit, { y: L.padH, r: D.disc.r + TEAM.ringOut, h: TEAM.trimH });
  if (neon) b.torus(D.ring.r, D.ring.tube, 4, D.ring.seg, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + D.disc.h });
  const y1 = L.padH + D.disc.h + D.tier.h;
  const top = columns(c, y1, D.col);
  const capTop = top + D.cap.lift + D.col.r * D.cap.sy;
  for (const [x, z] of D.col.cols) b.sphere(D.cap.r, 14, 6, S.hullDark, { x, y: top + D.cap.lift, z, sy: D.cap.sy });

  // plasma orb on a slim pylon in the middle, arcs from it to the stack tops
  const oy = top + D.orb.lift;
  b.cylinder(D.pylon.r, D.pylon.r, oy - y1 + D.pylon.over, 10, S.trim, { y: y1 + (oy - y1 + D.pylon.over) / 2 });
  b.sphere(D.orb.r, 20, 14, S.plasma, { y: oy });
  glows.get('pulse').sphere(D.orb.r * D.orb.halo, 14, 9, { y: oy });
  for (const [x, z] of D.col.cols) {
    const len = Math.hypot(x, z);
    c.arcPairs.push([[(x / len) * D.orb.r, oy, (z / len) * D.orb.r], [x, capTop, z]]);
  }
  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, x: 0, y: oy + r.dy, z: 0, amp: D.ringAmp });

  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: y1, z, r: D.ventR }));
  // front pod with the emblem
  const P = D.pod;
  b.cylinder(P.r, P.r * 1.12, P.h, 24, S.hull, { y: y1 + P.h / 2, z: P.z });
  b.sphere(P.r, 16, 8, S.hull, { y: y1 + P.h, z: P.z, sy: P.domeSy });
  if (neon) b.torus(P.r * 1.02, P.neonT, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: y1 + P.h * 0.85, z: P.z });
  frontDecal(c, 0, y1 + P.h * 0.5, P.z + P.r, P.h * 0.75);
  beacon(b, glows.get('beaconA'), kit, [0, y1 + P.h + P.r * P.domeSy, P.z]);
};

/** faceted: octagonal stage, three crystal columns with tips, lasers to emitter posts and a floating crystal, radiators, plate */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const laser = glows.get('laser');
  const neon = kit.style.neon >= L.neonMin;
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  const St = D.stage;
  b.cylinder(St.rTop, St.rBottom, St.h, St.segments, S.teamPaint, { y: L.padH + St.h / 2, ry: Math.PI / St.segments, detail: TEAM.detail });
  if (neon) b.torus(St.rTop, St.neonTube, 4, St.segments * 2, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + St.h });
  const y1 = L.padH + St.h;
  roofMark(b, kit, { y: y1, z: TEAM.mark.z, w: TEAM.mark.w, d: TEAM.mark.d });
  for (const [x, z] of D.col.cols) b.box(D.collar.w, D.collar.h, D.collar.w, S.teamShade, { x, y: y1 + D.collar.h / 2, z, ry: Math.PI / 4, detail: TEAM.detail });
  const top = columns(c, y1 + D.collar.h, D.col);
  const tips = [];
  const Cr = D.crystal;
  const Dc = DETAIL.crystal;
  D.col.cols.forEach(([x, z], i) => {
    b.box(D.cap.w, D.cap.h, D.cap.w, S.teamPaint, { x, y: top + D.cap.h / 2, z, ry: Math.PI / 4, detail: TEAM.detail });
    const ty = top + D.cap.h + Dc.tipLift;
    if (i === 1) {   // the middle one floats (animated part)
      c.crystal = { x, y: ty + Cr.floatLift, z, size: Cr.size, stretch: Dc.stretch, amp: Cr.floatAmp };
      tips.push([x, ty + Cr.floatLift, z]);
    } else {
      const g = new THREE.OctahedronGeometry(Cr.size, 0);
      g.scale(1, Dc.stretch, 1);
      b.add(g, S.plasma, { x, y: ty, z });
      glows.get('pulse').sphere(Cr.size * Dc.halo, 10, 6, { x, y: ty, z });
      tips.push([x, ty, z]);
    }
  });
  laserLink(b, laser, kit, tips[0], tips[1]);
  laserLink(b, laser, kit, tips[1], tips[2]);

  // emitter posts on both sides link to the outer columns; barrier-style beacons on their tips
  const Po = D.post;
  for (const s of [-1, 1]) {
    const x = s * Po.x;
    b.cylinder(Po.rTop, Po.rBottom, Po.h, 6, S.teamPaint, { x, y: y1 + Po.h / 2, z: Po.z, detail: TEAM.detail });
    b.sphere(Po.lensR, 8, 6, S.lens, { x, y: y1 + Po.h, z: Po.z });
    beacon(b, glows.get('beaconA'), kit, [x, y1 + Po.h + Po.lensR, Po.z]);
    const col = D.col.cols[s < 0 ? 0 : 2];
    laserLink(b, laser, kit, [x, y1 + Po.h, Po.z], [col[0] + s * D.col.r, y1 + Po.h, col[1]]);
  }
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: y1, z, r: D.ventR }));

  const Pl = D.plate;
  b.taperedBox(Pl.w, Pl.topW, Pl.h, Pl.d, S.hullDark, { y: y1, z: Pl.z }, Pl.topD);
  frontDecal(c, 0, y1 + Pl.decalY, Pl.z + Pl.d / 2 - L.decalMargin, Pl.w * 0.55);
  marking(b, kit, D.apron.len, D.apron.h, { rx: -Math.PI / 2, y: y1 + 0.01, z: D.apron.z });
};

// ---------------------------------------------------------------- animated part geometry

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
    kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [], rings: [], arcPairs: [], levelEnds: [], crystal: null,
  };
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbs = c.vents.filter((v) => v.ring);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    levelEnds: c.levelEnds,
    emblem: emblemDecalGeometry(c.decals),
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbs.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbs.length ? ringGeometry(kit, orbs[0].ring.r) : null,
    rings: c.rings.map((r) => ({ geometry: ringGeometry(kit, r.r, r.tube), x: r.x, y: r.y, z: r.z, amp: r.amp })),
    crystal: c.crystal ? { ...c.crystal, geometry: buildCrystal(kit, c.crystal) } : null,
    arcs: c.arcPairs.length ? arcGeometry(c.arcPairs, BANK_ANIM.arcSeed) : null,
  };
}

const BANK_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class EnergyBankProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: BANK_CACHE, name: 'EnergyBankProc' });
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
    const A = BANK_ANIM;
    const gc = this.kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, false);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);
    // the charge display: a per-instance geometry (own draw range) over the shared level-major vertices, reactor colour
    this.chargeLayer = sh.glow.charge ? this.glowLayer(this.instanceGeometry(sh.glow.charge), gc.reactor, { visible: false }) : null;
    this.levelEnds = sh.levelEnds;
    this.levelsShown = -1;
    this.arcs = null;
    if (sh.arcs) {
      const arcLayer = this.glowLayer(this.instanceGeometry(sh.arcs.geometry), gc.arc, { visible: false });
      this.arcs = new ArcFlicker(arcLayer, sh.arcs.ranges, { seed: A.arcSeed + seq });
    }

    // fans (speed follows the power) and plasma-orb rings over the vent orbs
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

    this.chargeTarget = null;   // null = demo cycle; setCharge(0..1) sets a real level
    this.charge = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.demoClock = seq * A.demoPhase;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Charge level to show (0 = empty … 1 = full; the bank lights its cell gaps from the bottom in steps of 1/8).
   * `null` returns to the demo cycle. Visual only – the real storage lives in Economy.
   * @param {number|null} fraction
   */
  setCharge(fraction) {
    this.chargeTarget = fraction === null ? null : Math.min(1, Math.max(0, fraction));
  }

  /**
   * Per-frame animation (no allocations). Moving parts and glow follow the power (= the charge, or full while `active`);
   * the charge display eases to the target level; beacons blink while the level is changing (or while `active`).
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = BANK_ANIM;
    this.time += delta;
    this.demoClock += delta;
    const target = this.chargeTarget ?? (A.demoMin + (A.demoMax - A.demoMin) * (0.5 - 0.5 * Math.cos((TAU * this.demoClock) / A.demoPeriod)));
    this.charge += (target - this.charge) * Math.min(1, delta * A.chargeEase);
    const power = active ? 1 : this.charge;
    const k = A.idleShare + (1 - A.idleShare) * power;

    for (let i = 0; i < this.fans.length; i++) this.fans[i].rotation.y += delta * this.fanSpeeds[i] * k;
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, power > 0.5);

    const shown = Math.round(this.charge * this.levelEnds.length);
    if (shown !== this.levelsShown) {
      this.levelsShown = shown;
      this.chargeLayer?.mesh.geometry.setDrawRange(0, shown > 0 ? this.levelEnds[shown - 1] : 0);
    }
    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * power);
    this.chargeLayer?.setIntensity(shown > 0 ? glow : 0);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += (power - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(delta, active || this.charge > A.arcCharge);
    const busy = active || Math.abs(target - this.charge) > A.busyEps;
    this.blink.update(delta, busy);
    this.beacons?.setIntensity(busy ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
