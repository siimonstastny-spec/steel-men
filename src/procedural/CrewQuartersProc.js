// Steel Men – procedural CrewQuarters (crew housing building; roadmap 19 Mercury, docs/BUILDING-STYLE.md). Built in code from the
// style modules (ProcModules.js); today only registered for the faceted (laser) style, but every style gets a model:
//   • footprint inside the CryoFarm GLB's (pad ±6.9 × ±6.9, front = +Z where the entrance gate is)
//   • role: a slim central spire of sleeping decks (door at the front, cabin windows, emblem plates) surrounded by four detached
//     sleeping pods (windows glow in alternating waves while crew is produced), an entrance gate, radiators / vents on the
//     back pods and a rotating scanner crown. Silhouette is a tower + four satellites – a different outline than CryoFarm
//   • per style.silhouette: faceted = tapered crystal spire, pods tied to the spire by lasers, laser gate · rounded = styled
//     stepped tower, strut bridges, radar · angular = armoured sloped tower with spikes, struts · round = drum tower with a
//     levitating ring, free-floating cylinder pods
//   • animation: pod windows pulse in two waves (stepped when style.anim.jerk > 0, brighter and faster while active), scanner
//     crown turns, vents spin / radiators heat up, beacons blink, lasers pulse, levitating ring bobs (round)
//   • 1 merged static mesh (LODs) + emblem decals (1 draw call) + glow layers + scanner + vent parts
// Visual only: update() takes the frame delta. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Spinner, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, laserLink, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
  teamStripe, teamTrim, teamBanner, roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;
const QUARTER_TURN = Math.PI / 4;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const QUARTERS_ANIM = {
  powerEase: 1.2,         // 1/s – how fast the building spins up / down
  idleGlow: 0.3,          // pod window glow share while idle (a slow "breathing")
  waveShift: 0.5,         // phase offset (share of one pulse) between the two pod layers
  jerkSteps: 3,           // glow levels when style.anim.jerk > 0 (stepped, piston-like)
  podDepth: 0.7,          // depth of the pod pulse (0 = constant, 1 = down to zero)
  scannerSpeed: 1.6,      // rad/s of the scanner crown (× style.anim.spin)
  scannerEase: 1.2,       // 1/s – scanner speed damping
  fanSpeed: 3.6,          // rad/s (× style.anim.spin)
  fanSpeedJitter: 0.25,
  fanEase: 1.5,
  ringAmpShare: 0.8,      // crown ring float amplitude share of the orb ring's
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.41,        // s – pulse phase offset per instance
  heatIdle: 0.25,         // radiator glow share while idle
  haloIdle: 0.35,         // crown halo share while idle
  scannerPhaseStep: 0.9,  // rad – scanner phase offset per instance
  fanPhaseSeq: 0.7,       // rad – vent fan phase offset per instance
  fanPhaseIdx: 1.3,       // rad – vent fan phase offset per fan
  fanJitterSeq: 3,        // instance multiplier of the fan speed jitter pattern
  fanJitterIdx: 5,        // fan multiplier of the fan speed jitter pattern
  fanJitterMod: 7,        // pattern length (jitter = (k % mod) / (mod - 1) mapped to ±1)
  orbPhaseSeq: 0.37,      // rad – orb ring phase offset per instance
  orbPhaseIdx: 0.5,       // rad – orb ring phase offset per ring
  ringPhaseSeq: 0.21,     // rad – crown ring phase offset per instance
};

/** Shared layout (model units, GLB scale; front = +Z, footprint ±6.9 × ±6.9) */
const LAYOUT = {
  padHalf: 6.9, padH: 0.25, padSegments: 40,
  coreZ: -1.2,                                   // centre of the spire
  neonMin: 0.3,                                  // style.neon from which tier edges get a neon line
  pods: [[-4.6, -4.5], [4.6, -4.5], [-4.7, 3.3], [4.7, 3.3]],   // pod centres; the first two (back) carry the vents
  ventPods: 2, ventR: 0.8,
  door: { w: 2.2, h: 3.2, frameW: 2.8, frameH: 3.6, frameD: 0.7, interiorD: 0.1, interiorOut: 0.05, base: 0.5, zOut: 0.1 },
  decal: { frontY: 5.2, frontSize: 1.9, sideY: 3.6, sideSize: 2.4 },
  coreWin: { rows: [1.8, 5.5], zs: [-1.4, 0, 1.4], w: 0.9, h: 0.5, t: 0.06 },
  coreStripe: { y: 0.7, h: 0.9, inset: 0.4 },
  neonEdge: { h: 0.12, out: 0.03 },
  strut: { y: 1.5, w: 0.5, h: 0.45, podGap: 1.4, coreGap: 0.2 },
  gate: { x: 1.7, z: 3.2, postH: 3.0, postR: 0.14, postRBottom: 0.22, lensR: 0.25, ys: [0.9, 1.8, 2.7], barY: 1.0, barT: 0.14 },
  beacons: [[6.3, 6.3], [-6.3, -6.4], [6.3, -6.4]],
  banner: { x: -6.3, z: 6.3, h: 4 },
  mark: { z: 5.3, w: 3.6, d: 2.4 },
  scanner: { hubR: 0.3, hubH: 0.25, blades: 3, len: 1.6, w: 0.3, t: 0.08, tip: 0.22 },
  haloR: 0.6,
  emitterLift: 0.0,                              // laser emitter height above the top of tier 1
  podTopLift: 0.2,                               // laser end nub above the pod cap
  segments: 32, podSegments: 24,
  podSpike: { h: 0.7, r: 0.8 },                  // pod cap spike size as a share of the style's spike
  crownLift: 0.7,                                // scanner height on the mast (share of mastH)
  gatePostSegments: 6, lensSegments: [8, 6],     // gate post / lens tessellation
  scannerHubSegments: 10,
  haloSegments: [10, 8], pulseSegments: [12, 8], // crown halo (scanner) / lens glow (ring)
};

/** Dimensions of the bodies by style.silhouette (code knows shapes, the style data picks one; unknown → rounded) */
const SHAPES = {
  rounded: {
    tiers: [
      { kind: 'box', styled: true, w: 5.2, d: 5.0, h: 6.4, s: 'hull' },
      { kind: 'box', styled: true, w: 4.0, d: 3.8, h: 1.6, s: 'teamPaint', neon: true },
      { kind: 'box', styled: true, w: 2.4, d: 2.4, h: 1.0, s: 'hull' },
    ],
    pod: { kind: 'box', styled: true, w: 2.8, d: 3.6, h: 2.6, plinthH: 0.3, plinthOver: 0.5, capH: 0.6, capOver: 0.3, win: { y: 1.3, len: 1.6, h: 0.7, t: 0.06 } },
    crown: 'scanner', mastH: 2.2, mastR: 0.3, connector: 'strut', spikes: false,
    inlay: { kind: 'rect', w: 8.4, d: 8.4 },
  },
  angular: {
    tiers: [
      { kind: 'taper', w: 5.4, topW: 4.4, d: 5.2, topD: 4.2, h: 6.4, s: 'hull' },
      { kind: 'taper', w: 4.4, topW: 3.6, d: 4.2, topD: 3.4, h: 1.0, s: 'teamPaint' },
      { kind: 'box', w: 2.2, d: 2.2, h: 1.0, s: 'hullDark' },
    ],
    pod: { kind: 'taper', w: 3.0, topW: 2.4, d: 3.8, topD: 3.0, h: 2.6, plinthH: 0.3, plinthOver: 0.5, capH: 0.7, capOver: 0.3, win: { y: 1.3, len: 1.6, h: 0.5, t: 0.06 } },
    crown: 'scanner', mastH: 2.0, mastR: 0.4, connector: 'strut', spikes: true, spikeH: 1.0, spikeR: 0.25,
    inlay: { kind: 'rect', w: 8.4, d: 8.4 },
  },
  round: {
    tiers: [
      { kind: 'cyl', r: 2.8, topR: 2.6, h: 6.4, s: 'hull' },
      { kind: 'cyl', r: 2.6, topR: 2.3, h: 1.4, s: 'teamPaint', neon: true },
      { kind: 'cyl', r: 1.3, topR: 1.1, h: 0.9, s: 'hullDark' },
    ],
    pod: { kind: 'cyl', r: 1.3, topR: 1.2, h: 2.6, plinthH: 0.3, plinthOver: 0.2, capH: 0.6, capOver: 0.3, win: { y: 1.3, len: 1.1, h: 0.7, t: 0.06 } },
    crown: 'ring', ringR: 3.6, ringTube: 0.2, ringLift: 1.0, lensR: 0.45, connector: 'none', spikes: false,
    inlay: { kind: 'ellipse', w: 8.8, d: 8.8, segments: 40 },
    // everything stands inside the round pad (r 6.9): pod plinth reach <= 6.6, trim ring r 6.75 outside it
    pods: [[-3.6, -3.6], [3.6, -3.6], [-4.0, 2.6], [4.0, 2.6]],
    beacons: [[6.0, 0], [-6.0, 0], [0, -6.0]],
    banner: { x: -2.8, z: 4.8, h: 4 },   // r 5.6 (orb reaches ~6.0 < pad 6.9), clear of the left front pod plinth (r 1.5 at -4.0, 2.6) and the roof mark (x ≥ -1.8)
    trimR: 6.75,
  },
  faceted: {
    tiers: [
      { kind: 'taper', w: 4.6, topW: 3.4, d: 4.6, topD: 3.4, h: 6.4, s: 'hull' },
      { kind: 'taper', w: 3.4, topW: 2.6, d: 3.4, topD: 2.6, h: 1.6, s: 'teamPaint', ry: QUARTER_TURN, neon: true },
      { kind: 'box', w: 1.9, d: 1.9, h: 1.1, s: 'hullDark', ry: QUARTER_TURN },
    ],
    pod: { kind: 'taper', w: 2.6, topW: 1.7, d: 3.6, topD: 2.6, h: 2.6, plinthH: 0.3, plinthOver: 0.5, capH: 0.7, capOver: 0.3, win: { y: 1.3, len: 1.6, h: 0.6, t: 0.06 } },
    crown: 'scanner', mastH: 2.4, mastR: 0.35, connector: 'laser', spikes: false,
    inlay: { kind: 'rhombus', w: 9, d: 9 },
  },
};

/** Team paint extras (the big coloured areas are the painted tier, pod caps and the pad inlay; see docs/notes/proc-teamcolor-kit.md) */
const TEAM = {
  inlayH: 0.05,           // thickness of the pad inlay (stands on the pad top)
  trim: { w: 13.8, d: 13.8 },   // outer edge = pad edge (6.9); inner edge stays outside the pod plinths (reach <= 6.7)
  roundTrimR: 0.15,       // team ring round the drum base (round tower has no flat walls for stripes)
  roundTrimY: 0.2,
};

const decal = (c, position, normal, size) => c.decals.push({ position, normal, size });

// ---------------------------------------------------------------- static parts

/** Half extents of a tier / pod body at height y above its base (taper and cylinder lean inward) */
function halfAt(T, y) {
  const k = Math.min(1, Math.max(0, y / T.h));
  if (T.kind === 'cyl') {
    const r = T.r + (T.topR - T.r) * k;
    return { hx: r, hz: r };
  }
  const topW = T.topW ?? T.w;
  const topD = T.topD ?? T.d;
  return { hx: (T.w + (topW - T.w) * k) / 2, hz: (T.d + (topD - T.d) * k) / 2 };
}

/** Wall tilt (rad) of a tier / pod body about Z (side walls, axis 'x') or X (front / back walls, axis 'z') */
function tiltOf(T, axis) {
  if (T.kind === 'cyl') return Math.atan2(T.r - T.topR, T.h);
  return axis === 'x' ? Math.atan2((T.w - (T.topW ?? T.w)) / 2, T.h) : Math.atan2((T.d - (T.topD ?? T.d)) / 2, T.h);
}

/** One tier of the spire standing on y (centre z) */
function addTier(c, T, y, z) {
  const { b, kit, S } = c;
  const s = S[T.s];
  const t = { base: true, y, z, ry: T.ry ?? 0, detail: 2 };
  if (T.kind === 'cyl') b.cylinder(T.topR, T.r, T.h, LAYOUT.segments, s, { y: y + T.h / 2, z, detail: 2 });
  else if (T.kind === 'taper') b.taperedBox(T.w, T.topW, T.h, T.d, s, t, T.topD);
  else if (T.styled) styledBox(b, kit, T.w, T.h, T.d, s, t);
  else b.box(T.w, T.h, T.d, s, t);
  if (T.neon && kit.style.neon >= LAYOUT.neonMin) {
    const N = LAYOUT.neonEdge;
    const topY = y + T.h - N.h / 2;
    if (T.kind === 'cyl') b.cylinder(T.topR + N.out, T.topR + N.out, N.h, LAYOUT.segments, S.neon, { y: topY, z }, true);
    else neonStrip(b, kit, (T.topW ?? T.w) + N.out * 2, N.h, (T.topD ?? T.d) + N.out * 2, { y: topY, z, ry: T.ry ?? 0 });
  }
}

/** Emblem plate on the lowest tier at angle `ang` (0 = front, π/2 = +X, π = back, −π/2 = −X) and height yd above its base */
function coreDecal(c, T, y0, ang, yd, size) {
  const sa = Math.sin(ang);
  const ca = Math.cos(ang);
  const { hx, hz } = halfAt(T, yd);
  const tilt = tiltOf(T, Math.abs(sa) > 0.5 ? 'x' : 'z');
  const px = T.kind === 'cyl' ? sa * hx : Math.round(sa) * hx;
  const pz = T.kind === 'cyl' ? ca * hz : Math.round(ca) * hz;
  decal(c, [px, y0 + yd, LAYOUT.coreZ + pz], [sa * Math.cos(tilt), Math.sin(tilt), ca * Math.cos(tilt)], size);
}

/** Entrance: frame + glowing interior on the front of the lowest tier */
function door(c, T, y0) {
  const { b, S, kit } = c;
  const D = LAYOUT.door;
  const z = LAYOUT.coreZ + halfAt(T, 0).hz + D.zOut;
  const y = y0 - D.base;
  b.box(D.frameW, D.frameH, D.frameD, S.frame, { base: true, y: y + D.base, z });
  b.box(D.w, D.h, D.interiorD, S.interior, { base: true, y: y + D.base, z: z + D.frameD / 2 + D.interiorOut });
  marking(b, kit, D.frameW, 0.4, { y: y + D.base + D.frameH + 0.25, z: z + D.frameD / 2 - 0.1 });
}

/** Cabin windows (rows × positions) on both side walls of a box / taper tier 0, following the wall lean */
function coreWindows(c, T, y0) {
  const { b, S } = c;
  const W = LAYOUT.coreWin;
  const tilt = tiltOf(T, 'x');
  for (const row of W.rows) {
    const hx = halfAt(T, row).hx;
    for (const sx of [-1, 1]) {
      for (const z of W.zs) b.box(W.t, W.h, W.w, S.window, { x: sx * (hx + W.t / 2), y: y0 + row, z: LAYOUT.coreZ + z, rz: sx * tilt });
    }
  }
}

/** Team stripes on the side and back walls of a box / taper tier 0 (front is the door; emblem plates sit higher) */
function coreStripes(c, T, y0) {
  const { b, kit } = c;
  const K = LAYOUT.coreStripe;
  const y = y0 + K.y;
  const { hx, hz } = halfAt(T, K.y);
  for (const sx of [-1, 1]) teamStripe(b, kit, T.d - 2 * K.inset, K.h, { x: sx * hx, y, z: LAYOUT.coreZ, ry: sx * Math.PI / 2 });
  teamStripe(b, kit, T.w - 2 * K.inset, K.h, { y, z: LAYOUT.coreZ - hz, ry: Math.PI });
}

/** Sleeping pod at (x, z): plinth, body, team cap, two glowing windows (layer A / B by index), laser / vent anchors */
function addPod(c, P, x, z, idx) {
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const y0 = L.padH;
  const cyl = P.kind === 'cyl';
  const base = y0 + P.plinthH;
  const sh = c.shape;
  if (cyl) {
    b.cylinder(P.r + P.plinthOver, P.r + P.plinthOver, P.plinthH, L.podSegments, S.hullDark, { x, y: y0 + P.plinthH / 2, z, detail: 2 });
    b.cylinder(P.topR, P.r, P.h, L.podSegments, S.hull, { x, y: base + P.h / 2, z, detail: 2 });
    b.cylinder(P.topR + P.capOver / 2, P.topR + P.capOver / 2, P.capH, L.podSegments, S.teamPaint, { x, y: base + P.h + P.capH / 2, z, detail: 2 });
  } else {
    b.box(P.w + 2 * P.plinthOver, P.plinthH, P.d + 2 * P.plinthOver, S.hullDark, { base: true, x, y: y0, z, detail: 2 });
    if (P.kind === 'taper') b.taperedBox(P.w, P.topW, P.h, P.d, S.hull, { x, y: base, z, detail: 2 }, P.topD);
    else styledBox(b, kit, P.w, P.h, P.d, S.hull, { base: true, x, y: base, z, detail: 2 });
    b.box((P.topW ?? P.w) + P.capOver, P.capH, (P.topD ?? P.d) + P.capOver, S.teamPaint, { base: true, x, y: base + P.h, z, detail: 2 });
  }
  const top = base + P.h + P.capH;
  // glowing cabin windows on both side walls
  const Wn = P.win;
  const hx = halfAt(P, Wn.y).hx;
  const tilt = tiltOf(P, 'x');
  const halo = glows.get(idx % 2 ? 'podB' : 'podA');
  for (const sx of [-1, 1]) {
    b.box(Wn.t, Wn.h, Wn.len, S.window, { x: x + sx * (hx + Wn.t / 2), y: base + Wn.y, z, rz: sx * tilt });
    halo.box(Wn.t * 2, Wn.h * c.haloScale.h, Wn.len * c.haloScale.len, { x: x + sx * (hx + Wn.t + c.haloScale.out), y: base + Wn.y, z, rz: sx * tilt });
  }
  if (sh.spikes) {
    for (const sz of [-1, 1]) spike(b, kit, { x: x + Math.sign(x) * ((P.topW ?? P.w) / 2 + P.capOver / 2), y: top, z: z + sz * ((P.topD ?? P.d) / 2), h: sh.spikeH * L.podSpike.h, r: sh.spikeR * L.podSpike.r });
  }
  if (idx < L.ventPods) c.vents.push(ventUnit(b, glows, kit, { x, y: top, z, r: L.ventR }));
  return top;
}

/** Strut between the spire and a pod (centre-to-centre direction, in the plane), for styles without lasers */
function strut(c, T, x, z) {
  const { b, S } = c;
  const K = LAYOUT.strut;
  const dx = x;
  const dz = z - LAYOUT.coreZ;
  const dist = Math.hypot(dx, dz);
  const from = halfAt(T, K.y).hx - K.coreGap;
  const to = dist - K.podGap;
  const len = to - from;
  if (len <= 0) return;
  const mid = (from + to) / 2;
  b.box(K.w, K.h, len, S.frame, { x: (dx / dist) * mid, y: LAYOUT.padH + K.y, z: LAYOUT.coreZ + (dz / dist) * mid, ry: Math.atan2(dx, dz) });
}

/** Entrance gate in front of the door: two posts with lenses, laser barrier (laser) or a bar (strut), nothing (none) */
function gate(c, connector) {
  const { b, S, glows } = c;
  const G = LAYOUT.gate;
  const y0 = LAYOUT.padH;
  for (const sx of [-1, 1]) {
    b.cylinder(G.postR, G.postRBottom, G.postH, LAYOUT.gatePostSegments, S.hullDark, { x: sx * G.x, y: y0 + G.postH / 2, z: G.z });
    b.sphere(G.lensR, LAYOUT.lensSegments[0], LAYOUT.lensSegments[1], S.lens, { x: sx * G.x, y: y0 + G.postH, z: G.z });
  }
  if (connector === 'laser') {
    for (const y of G.ys) glows.get('laser').segment([-G.x, y0 + y, G.z], [G.x, y0 + y, G.z], PROC_MODULES.laser.thickness);
  } else if (connector === 'strut') {
    b.box(G.x * 2, G.barT, G.barT, S.frame, { y: y0 + G.barY, z: G.z });
  }
}

/** Pad, plus the team-painted inlay whose outline follows the silhouette */
function addPad(c, sil) {
  const { b, S } = c;
  const L = LAYOUT;
  const I = c.shape.inlay;
  const iy = L.padH + TEAM.inlayH / 2;
  if (sil === 'round') b.cylinder(L.padHalf, L.padHalf, L.padH, L.padSegments, S.ground, { y: L.padH / 2, detail: 2 });
  else b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true, detail: 2 });
  if (I.kind === 'ellipse') b.cylinder(1, 1, TEAM.inlayH, I.segments, S.teamShade, { y: iy, sx: I.w / 2, sz: I.d / 2, detail: 2 });
  else if (I.kind === 'rhombus') {
    const g = new THREE.BoxGeometry(1, TEAM.inlayH, 1);
    g.rotateY(QUARTER_TURN);
    g.scale(I.w / Math.SQRT2, 1, I.d / Math.SQRT2);
    b.add(g, S.teamShade, { y: iy, detail: 2 });
  } else b.box(I.w, TEAM.inlayH, I.d, S.teamShade, { y: iy, detail: 2 });
}

/** Rotating scanner crown (origin at the hub): hub + blades with lens tips; shared per style */
function buildScanner(kit) {
  const S = kit.S;
  const K = LAYOUT.scanner;
  const b = new PartBuilder();
  b.cylinder(K.hubR, K.hubR, K.hubH, LAYOUT.scannerHubSegments, S.frame);
  for (let i = 0; i < K.blades; i++) {
    const a = (i / K.blades) * TAU;
    b.box(K.len, K.t, K.w, S.hullDark, { x: Math.cos(a) * K.len / 2, z: Math.sin(a) * K.len / 2, ry: -a });
    b.box(K.tip, K.tip, K.tip, S.lens, { x: Math.cos(a) * K.len, z: Math.sin(a) * K.len, ry: -a + QUARTER_TURN });
  }
  return b.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(SHAPES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const shape = SHAPES[sil];
  const L = LAYOUT;
  const y0 = L.padH;
  const c = {
    kit, S: kit.S, shape, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [],
    haloScale: { h: 1.45, len: 1.2, out: 0.04 },   // pod window halo size vs. the window
  };
  const { b, S, glows } = c;
  addPad(c, sil);

  // spire: stacked tiers, remember the tops of tier 1 (laser emitter) and the last tier (crown)
  let y = y0;
  let emitterY = y0;
  shape.tiers.forEach((T, i) => {
    addTier(c, T, y, L.coreZ);
    y += T.h;
    if (i === 1) emitterY = y + L.emitterLift;
  });
  const crownTop = y;
  const T0 = shape.tiers[0];
  const flat = T0.kind !== 'cyl';
  door(c, T0, y0);
  if (flat) {
    coreWindows(c, T0, y0);
    coreStripes(c, T0, y0);
  } else teamTrim(b, kit, { r: T0.r + TEAM.roundTrimR, y: y0 + TEAM.roundTrimY });
  const D = L.decal;
  coreDecal(c, T0, y0, 0, D.frontY, D.frontSize);
  for (const ang of [Math.PI / 2, -Math.PI / 2, Math.PI]) coreDecal(c, T0, y0, ang, D.sideY, D.sideSize);
  if (shape.spikes) {
    const T1 = shape.tiers[1];
    const t1Top = y0 + T0.h + T1.h;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      spike(b, kit, { x: sx * (T1.topW ?? T1.w) / 2, y: t1Top, z: L.coreZ + sz * (T1.topD ?? T1.d) / 2, h: shape.spikeH, r: shape.spikeR });
    }
  }

  // crown: scanner on a mast (turns) or a levitating ring round a lens
  const crown = { x: 0, y: crownTop, z: L.coreZ };
  let ring = null;
  let scanner = null;
  if (shape.crown === 'ring') {
    b.sphere(shape.lensR, 12, 8, S.lens, { y: crownTop + shape.lensR, z: L.coreZ });
    glows.get('pulse').sphere(shape.lensR * 1.8, L.pulseSegments[0], L.pulseSegments[1], { y: crownTop + shape.lensR, z: L.coreZ });
    ring = { geometry: ringGeometry(kit, shape.ringR, shape.ringTube), y: crownTop + shape.ringLift };
  } else {
    spike(b, kit, { x: 0, y: crownTop, z: L.coreZ, h: shape.mastH, r: shape.mastR });
    crown.y = crownTop + shape.mastH * L.crownLift;
    glows.get('pulse').sphere(L.haloR, L.haloSegments[0], L.haloSegments[1], { y: crown.y, z: L.coreZ });
    scanner = buildScanner(kit);
  }

  // pods, links to the spire, gate
  const laser = glows.get('laser');
  const pods = shape.pods ?? L.pods;
  const tops = pods.map(([x, z], i) => addPod(c, shape.pod, x, z, i));
  pods.forEach(([x, z], i) => {
    if (shape.connector === 'laser') laserLink(b, laser, kit, [0, emitterY, L.coreZ], [x, tops[i] + L.podTopLift, z]);
    else if (shape.connector === 'strut') strut(c, T0, x, z);
  });
  gate(c, shape.connector);

  // team paint extras, beacons
  const banner = shape.banner ?? L.banner;
  if (shape.trimR) teamTrim(b, kit, { r: shape.trimR, y: y0 });
  else teamTrim(b, kit, { y: y0, w: TEAM.trim.w, d: TEAM.trim.d });
  teamBanner(b, kit, { x: banner.x, y: y0, z: banner.z, h: banner.h });
  roofMark(b, kit, { x: 0, y: y0, z: L.mark.z, w: L.mark.w, d: L.mark.d });
  for (const [x, z] of shape.beacons ?? L.beacons) beacon(b, glows.get('beaconA'), kit, [x, y0, z]);

  const fans = c.vents.filter((v) => v.fan);
  const orbs = c.vents.filter((v) => v.ring);
  return {
    sil,
    static: b.buildLods(),
    glow: glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    crown, scanner, ring,
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbs.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbs.length ? ringGeometry(kit, orbs[0].ring.r) : null,
  };
}

const QUARTERS_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class CrewQuartersProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: QUARTERS_CACHE, name: 'CrewQuartersProc' });
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
    const A = QUARTERS_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.podA = layer('podA', gc.pulse, true);
    this.podB = layer('podB', gc.pulse, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);

    this.spinners = [];
    if (sh.scanner) {
      const mesh = this.paintMesh(sh.scanner);
      mesh.position.set(sh.crown.x, sh.crown.y, sh.crown.z);
      this.spinners.push(new Spinner(mesh, { speed: A.scannerSpeed * an.spin, ease: A.scannerEase, phase: (seq * A.scannerPhaseStep) % TAU }));
    }
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * A.fanJitterSeq + i * A.fanJitterIdx) % A.fanJitterMod) / (A.fanJitterMod - 1) - 0.5) * 2 * A.fanSpeedJitter;
      this.spinners.push(new Spinner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), ease: A.fanEase, phase: (seq * A.fanPhaseSeq + i * A.fanPhaseIdx) % TAU }));
    });
    const lev = PROC_MODULES.levitate;
    this.levitators = [];
    sh.orbSpots.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.orbRing);
      mesh.position.set(x, y, z);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * A.orbPhaseSeq + i * A.orbPhaseIdx }));
    });
    if (sh.ring) {
      const mesh = this.paintMesh(sh.ring.geometry);
      mesh.position.set(0, sh.ring.y, sh.crown.z);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * A.ringAmpShare * an.levitate, spin: lev.spin * an.spin, phase: seq * A.ringPhaseSeq }));
    }

    this.power = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty, phase: (seq * A.phaseStep) % 1 });
  }

  /** Glow level of one pod layer: pulse wave (stepped when the style is jerky), idle share → full with the power */
  #level(offset) {
    const an = this.kit.style.anim;
    const A = QUARTERS_ANIM;
    let w = pulseWave(this.time + offset, an.pulse, A.podDepth);
    if (an.jerk > 0) w = Math.round(w * A.jerkSteps) / A.jerkSteps;
    return w * (A.idleGlow + (1 - A.idleGlow) * this.power);
  }

  /**
   * Per-frame animation (no allocations). Idle: pod windows breathe dimly, scanner and vents stand still, beacons burn steadily. Active
   * (crew is being produced): the two pod waves run brighter and faster alternating, scanner / vents spin up, radiators
   * heat, lasers and crown halo pulse, beacons blink.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = QUARTERS_ANIM;
    const dt = delta;   // already scaled by animScale in tick(); no power:scanner, vents, levitators and pod waves stand still
    this.time += dt * (1 + this.power);
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    const shift = A.waveShift / Math.max(0.01, an.pulse);
    this.podA?.setIntensity(this.#level(0));
    this.podB?.setIntensity(this.#level(shift));
    const glow = pulseWave(this.time, an.pulse) * (A.haloIdle + (1 - A.haloIdle) * this.power);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : A.heatIdle) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    for (let i = 0; i < this.spinners.length; i++) this.spinners[i].update(dt, active);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(dt, active);
    this.blink.update(dt, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
