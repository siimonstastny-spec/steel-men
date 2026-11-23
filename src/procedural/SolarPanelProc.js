// Steel Mans – procedural solar panel (roadmap 18, phase B). A drop-in alternative to
// models/3DStructures{race}/SolarPanel{race}_Anim.glb built in code from the style modules (ProcModules.js):
//   • same layout as the GLB (mast at the origin, panel pivot at y = 11.5, rest-pose panel inside ±6.74 × −7.0…6.89)
//   • light: one merged static mesh per style (plinth, mast, inverter with a vent unit, beacons) + emblem decals
//     (1 draw call) + the panel (1 draw call, turns and tilts) + 1–3 glow layers; no per-instance geometry
//   • panel by style.silhouette (SOLAR_SHAPES): rounded = framed cell grid, angular = heavy frame, round = petals,
//     faceted = rhombic lamellae joined by laser lines; the inverter vent follows style.fan (fan / radiator / plasma orb)
//   • sun tracking: the panel yaws (azimuth) and tilts (elevation) after the apparent sun. Without a direction it follows
//     the same shared clock as the GLB idle clip (Structure.#trackSun: every panel shows the same world heading);
//     setSunDirection(vec) points it at a real direction instead (world space, the building yaw is compensated)
// Visual only: update() takes the frame delta and ignores `active` (a solar panel never "produces" in the sense of
// Structure.update – sun tracking and the glow run all the time). No allocations in update().
import * as THREE from 'three';
import { STRUCTURE } from '../config.js';
import { PartBuilder, Spinner, Blinker, withSurface } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, emblemDecalGeometry, Levitator, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation / sun tuning (visual only) */
export const SOLAR_ANIM = {
  clipDuration: 13.3333,   // s – length of the GLB idle clip (one full turn); with STRUCTURE.sunTrackingSpeed it gives the turn period
  elevMid: 1.0,            // rad – apparent sun elevation in the shared-clock mode (middle …
  elevAmp: 0.32,           //   … ± amplitude, one swing per turn)
  tiltMin: 0.12, tiltMax: 0.97,   // rad – panel tilt from the horizontal (keeps the edges clear of the inverter)
  follow: 2.2,             // 1/s – how fast the panel follows a new target (set direction / building yaw change)
  fanSpeed: 4.0,           // rad/s (× style.anim.spin)
  fanSpeedJitter: 0.25,
  blinkDuty: 0.5,
  phaseStep: 0.41,         // s – pulse phase offset per instance
  heatBase: 0.35,          // radiator / plasma glow share at the lowest sun, 1 at the highest
};

/** Shared layout (model units, GLB scale; origin = mast axis on the ground) */
const LAYOUT = {
  pivotY: 11.5,            // panel pivot (GLB node height)
  mastTop: 10.4,           // top of the mast, the joint sits under the pivot
  padHalfX: 5.6, padHalfZ: 4.4, padH: 0.15,
  inverterX: 3.8, inverterZ: -0.8,
  neonBandMin: 0.3,        // style.neon from which the plinth gets a neon band
  emblemSize: 1.5, emblemPlate: 1.9, emblemPlateD: 0.5, emblemPlateOut: 0.07,
};

/** Small details (model units; "Share" = share of the related size) */
const DETAIL = {
  jointR: 1.0, jointBox: 1.7,
  band: { h: 0.22, t: 0.06, inset: 0.97 },
  neonBand: { h: 0.08, t: 0.05, yShare: 0.8 },
  mastRing: { tube: 0.05, ys: [0.35, 0.7], over: 0.04 },
  corner: { spikeH: 0.6, spikeR: 0.15, ribW: 0.5 },
  inverter: { markLen: 0.8, markH: 0.4, markY: 0.9, markOut: 0.02, lowerH: 0.5, lowerT: 0.05, lowerY: 0.6 },
  laser: { nub: 0.2, fromInset: 0.2, hubDrop: 1.0 },
  cell: { base: '#101c40', tint: 0.12, metal: 0.6, rough: 0.18, h: 0.06 },     // tint = share of the style's neon colour
  frameH: 0.14, hubR: 1.0, hubH: 0.6,
  grid: { cornerR: 0.62, cornerH: 1.6, neonLift: 0.02, neonH: 0.04, neonShare: 0.3, bandShare: 0.7, bandH: 0.12, markShare: 0.6, markH: 0.3, spineW: 0.5 },
  petal: { gap: 0.12, topShare: 0.9, topH: 0.06, segments: 10, domeFlat: 0.35, domeSeg: 16, rimR: 0.97, rimTube: 0.07, haloTube: 0.18, tipR: 0.22, tipHalo: 0.55, tipShare: 0.9, tipLift: 0.1 },
  lamella: { topShare: 0.82, topH: 0.05, neonW: 0.06, neonH: 0.03, neonShare: 1.7, sparW: 0.12, sparH: 0.1, sparZShare: 0.45, sparDrop: 0.1, laserT: 0.05, tipBox: 0.2 },
};

/** Building shapes by style.silhouette (code knows shapes, the style data picks one; unknown → rounded) */
export const SOLAR_SHAPES = {
  rounded: { // clean cabinet, slim round mast, framed cell grid with team-coloured corners
    plinth: { kind: 'box', w: 4.4, h: 1.6, d: 4.4, edge: 1 }, mast: { seg: 16, rTop: 0.5, rBottom: 0.7 }, joint: 'sphere',
    inverter: { kind: 'box', w: 2.2, h: 2.0, d: 2.4, edge: 1 }, ventR: 0.85, beaconAt: [1.7, 1.7],
    panel: { kind: 'grid', half: 5.9, thick: 0.4, frame: 0.4, cols: 3, rows: 3, back: 'hull', corners: 'cap' },
  },
  angular: { // low armoured plinth with ribs, square pillar, heavy frame with spikes
    plinth: { kind: 'armored', w: 5.0, h: 1.9, d: 5.0, baseH: 0.8, topW: 3.8 }, mast: { seg: 4, rTop: 0.65, rBottom: 0.95 }, joint: 'box',
    inverter: { kind: 'plated', w: 2.4, h: 2.4, d: 2.6, edge: 0 }, ventR: 0.9, beaconAt: [2.1, 2.1],
    panel: { kind: 'grid', half: 6.1, thick: 0.7, frame: 0.65, cols: 2, rows: 3, back: 'hullDark', corners: 'spike', ribs: 3 },
  },
  round: { // stacked discs, smooth mast with neon rings, petal panel with plasma tips, plasma pod
    plinth: { kind: 'disc', w: 4.8, h: 1.5, d: 4.8 }, mast: { seg: 24, rTop: 0.6, rBottom: 1.0 }, joint: 'sphere',
    inverter: { kind: 'pod', w: 2.4, h: 2.0, d: 2.4 }, ventR: 0.9, beaconAt: [1.3, 1.4],
    panel: { kind: 'petals', radius: 6.3, petals: 6, thick: 0.3, dome: 1.4 },
  },
  faceted: { // slim chamfered pylon, thin mast, rhombic lamellae linked by lasers, glowing radiator
    plinth: { kind: 'faceted', w: 3.4, h: 2.0, d: 3.4, edge: 1 }, mast: { seg: 4, rTop: 0.3, rBottom: 0.45 }, joint: 'box',
    inverter: { kind: 'box', w: 1.9, h: 2.6, d: 1.9, edge: 1 }, ventR: 0.7, beaconAt: [1.4, 1.4],
    panel: { kind: 'lamellae', count: 5, pitch: 2.35, halfLen: 6.4, halfWid: 1.15, thick: 0.14 },
  },
};

const shapeOf = (style) => SOLAR_SHAPES[style.silhouette] ?? SOLAR_SHAPES.rounded;

// ---------------------------------------------------------------- static part (one mesh per style)

function buildStatic(kit, shape) {
  const L = LAYOUT;
  const D = DETAIL;
  const S = kit.S;
  const st = kit.style;
  const b = new PartBuilder();
  const glows = new GlowSet();
  const emblems = [];
  const pl = shape.plinth;
  const py = L.padH + pl.h;               // plinth top
  const neonBand = st.neon >= L.neonBandMin;
  const lampLayer = glows.get(st.lights === 'lamp' ? 'beacon' : 'pulse');

  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.ground, { base: true });

  // plinth by kind; frontZ = distance of its front face from the axis (emblem plate, band)
  let frontZ = pl.d / 2;
  switch (pl.kind) {
    case 'armored': { // wide skirt + sloped body, rusty plates and spikes at the corners
      b.box(pl.w + 0.6, pl.baseH, pl.d + 0.6, S.hullDark, { base: true, y: L.padH });
      b.taperedBox(pl.w, pl.topW, pl.h - pl.baseH, pl.d, S.hull, { y: L.padH + pl.baseH }, pl.topW);
      b.box(pl.w + 0.6, D.corner.ribW * 0.4, 0.06, S.lower, { y: L.padH + pl.baseH / 2, z: (pl.d + 0.6) / 2 + 0.03 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: sx * (pl.w / 2 + 0.15), y: L.padH + pl.baseH, z: sz * (pl.d / 2 + 0.15), h: D.corner.spikeH, r: D.corner.spikeR });
      frontZ = (pl.d + 0.6) / 2;
      break;
    }
    case 'disc': { // two stacked round tiers
      const r = pl.w / 2;
      b.cylinder(r, r * 1.08, pl.h * 0.55, 32, S.hull, { y: L.padH + pl.h * 0.275 });
      b.cylinder(r * 0.78, r * 0.9, pl.h * 0.45, 32, S.hullDark, { y: L.padH + pl.h * 0.775 });
      frontZ = r;
      break;
    }
    case 'faceted': { // chamfered block under a thin diamond cap
      styledBox(b, kit, pl.w, pl.h, pl.d, S.hull, { base: true, y: L.padH }, pl.edge);
      b.box(pl.w * 1.2, 0.12, pl.d * 1.2, S.hullDark, { y: py + 0.06, ry: Math.PI / 4 });
      break;
    }
    default: styledBox(b, kit, pl.w, pl.h, pl.d, S.hull, { base: true, y: L.padH }, pl.edge);
  }

  // team band + neon band around the plinth (box kinds: the four faces, disc: rings)
  const bandY = L.padH + pl.h * 0.45;
  if (pl.kind === 'disc') {
    b.torus(pl.w / 2 * 1.04, D.band.h / 2, 4, 40, TAU, S.team, { rx: Math.PI / 2, y: bandY });
    if (neonBand) b.torus(pl.w / 2 * 0.8, D.neonBand.h / 2, 4, 40, TAU, S.neon, { rx: Math.PI / 2, y: L.padH + pl.h * 0.9 });
  } else {
    const out = pl.kind === 'armored' ? -D.band.t / 2 : D.band.t / 2;   // the sloped body is hit by the band's inner half
    for (const e of [-1, 1]) {
      b.box(pl.w * D.band.inset, D.band.h, D.band.t, S.team, { y: bandY, z: e * (pl.d / 2 + out) });
      b.box(D.band.t, D.band.h, pl.d * D.band.inset, S.team, { x: e * (pl.w / 2 + out), y: bandY });
    }
    if (neonBand) neonStrip(b, kit, pl.w * D.band.inset, D.neonBand.h, D.neonBand.t, { y: L.padH + pl.h * D.neonBand.yShare, z: pl.d / 2 + out });
  }

  // emblem plates (front and back) – a flat plate also sticks out of curved / sloped faces
  for (const e of [1, -1]) {
    const z = e * (frontZ + L.emblemPlateOut - L.emblemPlateD / 2);
    b.box(L.emblemPlate, L.emblemPlate, L.emblemPlateD, S.hullDark, { y: L.padH + pl.h * 0.5, z });
    emblems.push({ position: [0, L.padH + pl.h * 0.5, e * (frontZ + L.emblemPlateOut)], normal: [0, 0, e], size: L.emblemSize });
  }

  // mast with a joint under the pivot; neon rings for the neon-rich styles
  const mh = L.mastTop - py;
  const m = shape.mast;
  b.cylinder(m.rTop, m.rBottom, mh, m.seg, S.frame, { y: py + mh / 2, ry: m.seg === 4 ? Math.PI / 4 : 0 });
  if (kit.rich) {
    for (const k of D.mastRing.ys) {
      const rr = m.rBottom + (m.rTop - m.rBottom) * k + D.mastRing.over;
      b.torus(rr, D.mastRing.tube, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: py + mh * k });
    }
  }
  if (shape.joint === 'sphere') b.sphere(D.jointR, 14, 8, S.hullDark, { y: L.pivotY - D.jointR });
  else b.box(D.jointBox, D.jointBox * 0.6, D.jointBox, S.hullDark, { y: L.pivotY - D.jointBox * 0.4, ry: Math.PI / 4 });
  if (pl.kind === 'armored') {   // pillar ribs
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      b.box(D.corner.ribW, mh * 0.45, D.corner.ribW * 0.7, S.hullDark, { base: true, x: Math.cos(a) * (m.rBottom + 0.1), y: py, z: Math.sin(a) * (m.rBottom + 0.1), ry: -a });
    }
  }

  // inverter cabinet beside the mast with the vent unit of the style (fan / radiator / plasma orb)
  const iv = shape.inverter;
  const ix = L.inverterX;
  const iz = L.inverterZ;
  const top = L.padH + iv.h;
  if (iv.kind === 'pod') {
    b.cylinder(iv.w / 2, iv.w / 2 * 1.12, iv.h, 24, S.hull, { x: ix, y: L.padH + iv.h / 2, z: iz });
  } else {
    styledBox(b, kit, iv.w, iv.h, iv.d, iv.kind === 'plated' ? S.hullDark : S.hull, { base: true, x: ix, y: L.padH, z: iz }, iv.edge);
    marking(b, kit, iv.w * D.inverter.markLen, D.inverter.markH, { x: ix, y: L.padH + D.inverter.markY, z: iz + iv.d / 2 + D.inverter.markOut });
    if (iv.kind === 'plated') b.box(iv.w * 0.9, D.inverter.lowerH, D.inverter.lowerT, S.lower, { x: ix, y: L.padH + D.inverter.lowerY, z: iz - iv.d / 2 - D.inverter.lowerT / 2 });
  }
  const vent = ventUnit(b, glows, kit, { x: ix, y: top, z: iz, r: shape.ventR });

  // beacons: front plinth corners, rear corner of the inverter
  const [bx, bz] = shape.beaconAt;
  for (const sx of [-1, 1]) beacon(b, lampLayer, kit, [sx * bx, py, bz]);
  beacon(b, lampLayer, kit, [ix + iv.w / 2 - 0.3, top, iz - iv.d / 2 + 0.3]);

  // laser feed from the inverter to the panel hub (styles with laser lines)
  if (st.markings === 'light' && st.fan === 'radiator') {
    const a = [ix - iv.w / 2 + D.laser.fromInset, top, iz];
    const hub = [0, L.pivotY - D.laser.hubDrop, 0];
    b.box(D.laser.nub, D.laser.nub, D.laser.nub, S.lens, { x: a[0], y: a[1], z: a[2] });
    glows.get('pulse').segment(a, hub, PROC_MODULES.laser.thickness);
  }

  return { geometry: b.buildLods(), glows, vent, emblems };
}

// ---------------------------------------------------------------- panel (rotating part, local space: plate in XZ, normal +Y)

function cellSurface(kit) {
  const c = DETAIL.cell;
  const color = new THREE.Color(c.base).lerp(new THREE.Color(kit.style.palette.neon), c.tint);
  return withSurface(kit.S.dark, { color, metal: c.metal, rough: c.rough });
}

function hubUnder(b, kit, thick) {
  b.cylinder(DETAIL.hubR, DETAIL.hubR * 1.15, DETAIL.hubH, 14, kit.S.hullDark, { y: -thick / 2 - DETAIL.hubH / 2 });
}

function gridPanel(b, glow, kit, cell, P) {
  const S = kit.S;
  const D = DETAIL;
  const G = D.grid;
  const W = P.half * 2;
  const top = P.thick / 2;
  const fh = D.frameH;
  const fy = top + fh / 2;
  b.box(W, P.thick, W, S[P.back]);
  const px = (W - P.frame) / P.cols;
  const pz = (W - P.frame) / P.rows;
  for (let i = 0; i < P.cols; i++) {
    for (let j = 0; j < P.rows; j++) {
      b.box(px - P.frame, D.cell.h, pz - P.frame, cell, { x: -P.half + P.frame / 2 + (i + 0.5) * px, y: top + D.cell.h / 2, z: -P.half + P.frame / 2 + (j + 0.5) * pz });
    }
  }
  for (const e of [-1, 1]) {   // outer frame
    b.box(W, fh, P.frame, S.frame, { y: fy, z: e * (P.half - P.frame / 2) });
    b.box(P.frame, fh, W - 2 * P.frame, S.frame, { x: e * (P.half - P.frame / 2), y: fy });
  }
  for (let i = 1; i < P.cols; i++) b.box(P.frame, fh, W - 2 * P.frame, S.frame, { x: -P.half + P.frame / 2 + i * px, y: fy });
  for (let j = 1; j < P.rows; j++) b.box(W - 2 * P.frame, fh, P.frame, S.frame, { y: fy, z: -P.half + P.frame / 2 + j * pz });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (P.half - P.frame / 2);
      const z = sz * (P.half - P.frame / 2);
      if (P.corners === 'cap') b.cylinder(P.frame * G.cornerR, P.frame * G.cornerR, fh * G.cornerH, 10, S.team, { x, y: top + (fh * G.cornerH) / 2 - fh / 2, z });
      else spike(b, kit, { x, y: top + fh, z, h: D.corner.spikeH, r: D.corner.spikeR });
    }
  }
  if (kit.style.neon >= LAYOUT.neonBandMin) {   // neon line on the front and back frame bars
    for (const e of [-1, 1]) neonStrip(b, kit, W - 2 * P.frame, G.neonH, P.frame * G.neonShare, { y: top + fh + G.neonLift, z: e * (P.half - P.frame / 2) });
  }
  b.box(W * G.bandShare, G.bandH, 0.05, S.team, { z: -P.half - 0.02 });   // team band on the rear edge
  marking(b, kit, W * G.markShare, G.markH, { z: P.half + 0.01 });         // hazard stripes / light line on the front edge
  for (let k = 0; k < (P.ribs ?? 0); k++) {                                // heavy back ribs
    b.box(G.spineW, 0.5, W - 0.6, S.hullDark, { x: (k - (P.ribs - 1) / 2) * (W / P.ribs), y: -P.thick / 2 - 0.25 });
  }
  hubUnder(b, kit, P.thick);
}

function petalPanel(b, glow, kit, cell, P) {
  const S = kit.S;
  const D = DETAIL;
  const Pt = D.petal;
  const top = P.thick / 2;
  const step = TAU / P.petals;
  b.sphere(P.dome, Pt.domeSeg, 8, S.hull, { y: top, sy: Pt.domeFlat });
  for (let k = 0; k < P.petals; k++) {
    const a0 = k * step + Pt.gap / 2;
    const len = step - Pt.gap;
    b.cylinder(P.radius, P.radius, P.thick, Pt.segments, S.hull, {}, false, a0, len);
    b.cylinder(P.radius * Pt.topShare, P.radius * Pt.topShare, Pt.topH, Pt.segments, cell, { y: top + Pt.topH / 2 }, false, a0, len);
    const am = a0 + len / 2;
    const tx = Math.sin(am) * P.radius * Pt.tipShare;
    const tz = Math.cos(am) * P.radius * Pt.tipShare;
    b.sphere(Pt.tipR, 8, 6, S.plasma, { x: tx, y: top + Pt.tipLift, z: tz });
    glow.sphere(Pt.tipHalo, 8, 5, { x: tx, y: top + Pt.tipLift, z: tz });
  }
  b.torus(P.radius * Pt.rimR, Pt.rimTube, 4, 40, TAU, S.neon, { rx: Math.PI / 2, y: top });
  glow.torus(P.radius * Pt.rimR, Pt.haloTube, 4, 40, TAU, { rx: Math.PI / 2, y: top });
  hubUnder(b, kit, P.thick);
}

function lamellaPanel(b, glow, kit, cell, P) {
  const S = kit.S;
  const D = DETAIL;
  const Lm = D.lamella;
  const top = P.thick / 2;
  const rhombus = (halfW, halfL, h) => {
    const g = new THREE.BoxGeometry(1, h, 1);
    g.rotateY(Math.PI / 4);
    g.scale(halfW * Math.SQRT2, 1, halfL * Math.SQRT2);
    return g;
  };
  const xs = [];
  for (let i = 0; i < P.count; i++) xs.push((i - (P.count - 1) / 2) * P.pitch);
  for (const x of xs) {
    b.add(rhombus(P.halfWid, P.halfLen, P.thick), S.hullDark, { x });
    b.add(rhombus(P.halfWid * Lm.topShare, P.halfLen * Lm.topShare, Lm.topH), cell, { x, y: top + Lm.topH / 2 });
    b.box(Lm.neonW, Lm.neonH, P.halfLen * Lm.neonShare, S.neon, { x, y: top + Lm.topH + Lm.neonH / 2 });
    for (const e of [-1, 1]) b.box(Lm.tipBox, Lm.tipBox, Lm.tipBox, S.lens, { x, y: 0, z: e * P.halfLen });
  }
  for (let i = 0; i < xs.length - 1; i++) {   // laser lines between the lamella tips
    for (const e of [-1, 1]) glow.segment([xs[i], 0, e * P.halfLen], [xs[i + 1], 0, e * P.halfLen], Lm.laserT);
  }
  for (const e of [-1, 1]) b.box(xs[xs.length - 1] - xs[0] + P.halfWid, Lm.sparH, Lm.sparW, S.frame, { y: -top - Lm.sparDrop, z: e * P.halfLen * Lm.sparZShare });
  hubUnder(b, kit, P.thick);
}

const PANEL_BUILDERS = { grid: gridPanel, petals: petalPanel, lamellae: lamellaPanel };

function buildPanel(kit, shape) {
  const b = new PartBuilder();
  const glow = new GlowSet().get('panel');
  (PANEL_BUILDERS[shape.panel.kind] ?? gridPanel)(b, glow, kit, cellSurface(kit), shape.panel);
  return { paint: b.build(), glow: glow.build() };
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const shape = shapeOf(kit.style);
  const st = buildStatic(kit, shape);
  const panel = buildPanel(kit, shape);
  const vent = st.vent;
  return {
    static: st.geometry,
    glow: st.glows.build(),
    emblem: emblemDecalGeometry(st.emblems),
    panel: panel.paint,
    panelGlow: panel.glow,
    fanBase: vent.fan ?? null,
    fan: vent.fan ? fanBladesGeometry(kit, vent.r, vent.blades) : null,
    ringSpot: vent.ring ? [vent.ring.x, vent.ring.y, vent.ring.z] : null,
    ring: vent.ring ? ringGeometry(kit, vent.ring.r) : null,
    heat: Boolean(vent.radiator),
  };
}

const SOLAR_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

/** Shortest signed angle difference wrapped to −π…π */
const wrapAngle = (d) => d - TAU * Math.round(d / TAU);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- the model

export class SolarPanelProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: SOLAR_CACHE, name: 'SolarPanelProc' });
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
    const A = SOLAR_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beaconGlow = layer('beacon', gc.beacon, false);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);

    // panel: yaw (azimuth) → tilt (elevation) → plate; the plate's glow turns with it
    this.yawNode = new THREE.Group();
    this.tiltNode = new THREE.Group();
    this.yawNode.position.y = LAYOUT.pivotY;
    this.yawNode.add(this.tiltNode);
    this.add(this.yawNode);
    this.paintMesh(sh.panel, this.tiltNode, { far: true });   // far LOD: drawn instanced, frozen in its last pose
    this.panelGlow = sh.panelGlow ? this.glowLayer(sh.panelGlow, gc.pulse, { parent: this.tiltNode }) : null;

    // vent parts: fan turns, plasma ring floats (both style-driven, absent for radiator styles)
    this.spinner = null;
    this.levitator = null;
    if (sh.fan) {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(sh.fanBase[0], sh.fanBase[1], sh.fanBase[2]);
      const jitter = (((seq * 3) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      this.spinner = new Spinner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter), phase: (seq * 0.7) % TAU });
    }
    if (sh.ring) {
      const ring = this.paintMesh(sh.ring);
      ring.position.set(sh.ringSpot[0], sh.ringSpot[1], sh.ringSpot[2]);
      const lev = PROC_MODULES.levitate;
      this.levitator = new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin, phase: seq * 0.37 });
    }

    this.sunSet = false;     // true after setSunDirection(vec)
    this.sunAz = 0;          // world azimuth of the set direction (atan2(x, z))
    this.sunElev = A.elevMid; // elevation of the set direction (rad)
    this.yaw = 0;            // current local yaw / tilt of the panel (eased)
    this.tilt = A.tiltMax;
    this.snap = true;        // the first update jumps to the target
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty, phase: (seq * A.phaseStep) % 1 });
  }

  /**
   * Points the panel at a real sun direction (world space; need not be normalised). `null` goes back to the shared
   * clock (same heading on every panel, like the GLB idle clip). The building yaw is compensated automatically.
   * @param {{x:number, y:number, z:number}|null} dir
   */
  setSunDirection(dir) {
    if (!dir) { this.sunSet = false; return; }
    this.sunSet = true;
    this.sunAz = Math.atan2(dir.x, dir.z);
    this.sunElev = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
  }

  /**
   * Per-frame animation (no allocations). `active` is ignored: a solar panel tracks the sun and glows all the time.
   * @param {number} delta seconds
   * @param {boolean} [active]  unused
   * @param {number} [sunClock] shared sun clock = seconds × STRUCTURE.sunTrackingSpeed (Structure supplies it; the model
   *   reads no real time itself); without it (preview) the shared-clock mode keeps the model's own clock `this.time`
   */
  update(delta, active, sunClock) {
    if (!this.shared) return;
    const A = SOLAR_ANIM;
    const an = this.kit.style.anim;
    this.time += delta;

    // sun: azimuth / elevation (set direction or shared clock), turned into the local yaw by the building yaw
    let az = this.sunAz;
    let elev = this.sunElev;
    if (!this.sunSet) {
      const clock = sunClock ?? this.time * STRUCTURE.sunTrackingSpeed;
      const phase = (clock % A.clipDuration) / A.clipDuration;
      az = TAU * phase;
      elev = A.elevMid + A.elevAmp * Math.sin(TAU * phase);
    }
    if (this.snap) this.updateWorldMatrix(true, false);   // first update: the world matrix may be older than the building yaw
    const e = this.matrixWorld.elements;
    const worldYaw = Math.atan2(-e[2], e[0]);
    const targetYaw = az - worldYaw;
    const targetTilt = clamp(Math.PI / 2 - elev, A.tiltMin, A.tiltMax);
    const k = this.snap ? 1 : Math.min(1, delta * A.follow);
    this.snap = false;
    this.yaw += wrapAngle(targetYaw - this.yaw) * k;
    this.tilt += (targetTilt - this.tilt) * k;
    this.yawNode.rotation.y = this.yaw;
    this.tiltNode.rotation.x = this.tilt;

    // glow: pulses, radiator / plasma heat follows how high the sun stands
    const sun = clamp(Math.sin(elev), 0, 1);
    const glow = pulseWave(this.time, an.pulse);
    this.pulseGlow?.setIntensity(glow);
    this.panelGlow?.setIntensity(glow);
    this.heat += ((A.heatBase + (1 - A.heatBase) * sun) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.blink.update(delta, true);
    this.beaconGlow?.setIntensity(this.blink.on ? 1 : 0);
    this.spinner?.update(delta, true);
    this.levitator?.update(delta, true);
  }
}
