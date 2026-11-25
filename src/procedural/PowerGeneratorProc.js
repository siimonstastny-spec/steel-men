// Steel Men – procedural power generator (tier 3 power source), model and animation only. Built in code from the style
// modules (ProcModules.js) and the faction style (data/buildingStyles.json):
//   • footprint: pad ±12 × ±12 around the model origin, front = +Z (control house with the door); tall central reactor
//   • the reactor is chosen by style.silhouette (code knows shapes, the data picks one; unknown → rounded) and glows in
//     style.reactorGlow:
//       rounded = fusion torus (two shells with a plasma gap, clamps, central solenoid, orbiting plasma knot)
//       angular = fission vessel (armoured 8-sided containment, glowing slits, control rods that pump, warning lamp)
//       round   = plasma sphere floating over a pedestal in a spinning gyroscope, coils with arcs, levitating rings
//       faceted = photon crystal levitating between six laser pylons, held emblem, radiators that heat up
//   • one merged static mesh (LODs) + emblem decals + glow layers (reactor, pulse, laser, radiator, beacons) + animated parts
// Visual only: update() takes the frame delta. While `active` (producing power) the reactor runs at full glow and speed.
// Destruction: the owner reads getExplosionOrigin(out) and GENERATOR_EXPLOSION (the blast itself is not part of the model).
// No allocations in update().
import * as THREE from 'three';
import { PROC_TEAM_PAINT } from '../config.js';
import { PartBuilder, Blinker, surface, steppedEase } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, pipeRun, tank, chimney, plasmaCoil, arcGeometry, ArcFlicker, Levitator, emblemDecalGeometry, emblemShape, pulseWave,
  PROC_MODULES, teamTrim, roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/**
 * Team paint (S.teamPaint / S.teamShade = vertices of the static geometry with team = 1: no extra draw call, batching and
 * setTeamColor work as before). The main structural unit of every style is painted, the rest stays neutral metal.
 * detail = coarsest LOD the painted parts still appear in (2 = the far silhouette, the colour must read from the RTS camera).
 */
const TEAM = {
  detail: PROC_TEAM_PAINT.lod.panel,
  ring: { w: 3.2, gap: 0.9, lift: 0.03, seg: 40 },    // flat team ring on a round plinth top: width, gap to the plinth rim (neon line), lift
  frame: { w: 1.6, inset: 1.2, h: 0.06 },             // flat team frame on the armoured plinth top (inset from the corner spikes)
  houseRoof: { wShare: 0.5, dShare: 0.6 },            // roof mark of the control house (shares of its roof)
};

/** Flat ring (annulus) lying on a surface at height y, facing up */
function flatRing(b, s, rIn, rOut, y, segments) {
  return b.add(new THREE.RingGeometry(rIn, rOut, segments).rotateX(-Math.PI / 2), s, { y, detail: TEAM.detail });
}

/** Flat rectangular frame (four slabs) of half size `half`, width w, lying on y */
function flatFrame(b, s, half, w, y, h) {
  for (const e of [-1, 1]) {
    b.box(half * 2, h, w, s, { y: y + h / 2, z: e * (half - w / 2), detail: TEAM.detail });
    b.box(w, h, half * 2 - 2 * w, s, { x: e * (half - w / 2), y: y + h / 2, detail: TEAM.detail });
  }
  return b;
}

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const GENERATOR_ANIM = {
  powerEase: 1.2,         // 1/s – how fast the reactor spins up / down
  idleGlow: 0.45,         // reactor glow share while idle
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
  knotSpeed: 1.6,         // rad/s of the plasma knot / gyroscope / warning lamp at work (× style.anim.spin)
  knotIdle: 0.25,
  gyroSpeed: 1.1,
  lampSpeed: 2.2,
  jerkTicks: 12,          // ticks per revolution when style.anim.jerk > 0 (stepped turning)
  crystalSpin: 0.9,       // rad/s of the floating crystal (Levitator slows it down when idle)
  crystalBob: 0.3,        // m – bobbing amplitude (× style.anim.levitate)
  ringSpin: 0.8,
  fanSpeed: 4.2,
  fanIdle: 0.4,
  fanJitter: 0.25,
  rodPeriod: 7.0,         // s – one up-and-down stroke of the control rods at full power
  rodAmp: 1.6,
  rodSteps: 3,            // pushes per stroke when jerky
  rodIdle: 0.2,           // stroke speed share while idle
  arcPower: 0.6,          // power from which the plasma arcs flash
  arcSeed: 5521,
};

/** What the owner needs for the destruction effect (model units, GLB scale) */
export const GENERATOR_EXPLOSION = {
  radius: 45,             // visual blast radius (the gameplay radius belongs in stats.json)
  fireballRise: 6,        // the fireball climbs this high above the reactor centre
  fallbackGlow: '#ffffff',
};

const REACTOR = { glow: 1.9, metal: 0, rough: 0.2, fallbackColor: '#ffffff' };

/** Shared layout (model units; front = +Z) */
const LAYOUT = {
  padHalf: 12, padH: 0.3,
  plinthH: 0.9, plinthSegments: 40,
  neonMin: 0.3,           // style.neon from which neon trim is added
  neonTube: 0.1,
  emblemDepth: 0.8,
  emblemPlate: { h: 0.8, d: 2.0, widthShare: 0.5, strutShare: 0.18, strutT: 0.5 },   // stand-up emblem: base plate + 2 struts
};

/** Small details (model units; "Share" = share of the related size) */
const DETAIL = {
  armored: { skirtExtra: 0.1, bandY: 0.4, bandH: 0.4, bandT: 0.06, bandShare: 0.9, spikeH: 1.4, spikeR: 0.35 },
  stage: { lessH: 0.1, grow: 0.2 },
  house: {
    domeSegments: 28, domeRings: 8, domeFlat: 0.5, out: 0.04, winH: 0.5, winY: 0.62, neonH: 0.14, neonY: 0.9,
    doorW: 2.0, doorH: 2.3, doorT: 0.2, doorOut: 0.02, doorX: 0.25, doorAngle: 0.5, frameW: 0.3, markH: 0.45, markOut: 0.04,
    neonW: 0.9, neonT: 0.06, neonDrop: 0.15, neonOut: 0.03, bandW: 0.96, bandH: 0.3, bandT: 0.06, bandDrop: 0.5, bandOut: 0.02,
    beaconInset: 0.5, decalX: 0.2, decalY: 1.35, decalSize: 1.6,
  },
};

/**
 * Dimensions of every body by style.silhouette. `foundation` = pad + plinth, `house` = control house in front,
 * `vents` = [x, z] on the plinth (fan / radiator / plasma orb by style.fan).
 */
const DIM = {
  rounded: {
    foundation: { kind: 'round', r: 10.6 },
    house: { kind: 'box', w: 8, h: 3.4, d: 3.4, z: 7.4 },
    vents: [[-7, 6.0], [7, 6.0]], ventR: 1.0,
    vessel: {
      y: 4.2, R: 5.2, shell: 1.05, gap: 1.15, plasma: 0.95, legs: 6, legW: 0.8, legPhase: 0.26, clamps: 12, clampW: 0.9, clampD: 2.6,
      clampOver: 0.4, segTube: 10, segPlasma: 8, segRing: 36, halo: 1.7, haloTube: 6, knotArc: 0.9, knotScale: 1.12, knotSeg: 14,
    },
    solenoid: { r: 1.3, above: 3.2, capOver: 0.4, capH: 0.6, rings: 3, ringTube: 0.08, ringOver: 0.04, bandTube: 0.1, bandOver: 0.06, segments: 16 },
    tanks: { x: 8.7, len: 5, r: 1.3, rise: 0.4, pipeR: 0.25 },
    emblem: { size: 6.5, z: -9.3, lift: 1.6 },
  },
  angular: {
    foundation: { kind: 'armored', half: 10.7 },
    house: { kind: 'sloped', w: 9, topW: 7.4, h: 3.6, d: 3.8, z: 7.6 },
    vents: [[-7.5, 4.0], [7.5, 4.0]], ventR: 1.2,
    vessel: {
      sides: 8, r: 6.4, h: 6.5, capTop: 4.6, capH: 2.4, buttW: 1.4, buttH: 6.0, buttD: 1.8, buttOut: 0.5,
      slitW: 1.0, slitH: 3.6, slitT: 0.12, slitOut: 0.06, slitY: 3.2, haloW: 1.8, haloH: 4.2, haloD: 0.5, haloOut: 0.2,
      bandW: 4.0, bandH: 0.4, bandT: 0.06, bandY: 5.8, lowerW: 4.2, lowerH: 0.9, lowerT: 0.06, lowerY: 0.8, spikeH: 1.0, spikeR: 0.25,
    },
    rods: { r: 2.4, sleeveH: 1.0, sleeveR: 0.75, len: 4.5, rodR: 0.35, collarR: 0.5, collarH: 0.25, tipH: 0.8, tipR: 0.25, insert: 1.2 },
    lamp: { baseR: 0.5, baseH: 0.5, arm: 1.8, armT: 0.3, lensR: 0.28, lensH: 0.35, rise: 0.75 },
    chimneys: [[-7.4, -6.6], [7.4, -6.6]], chimneyH: 9, chimneyR: 1.9,
    pipes: { y: 4.0, x1: 5.0, z1: -4.4, r: 0.5 },
    corners: 0.8,
    emblem: { size: 7.5, z: -9.6, lift: 2.4 },
  },
  round: {
    foundation: { kind: 'round', r: 10.4 },
    house: { kind: 'dome', r: 3.4, h: 2.4, z: 6.8 },
    vents: [[-6.0, -6.4], [6.0, -6.4]], ventR: 1.6,
    pedestal: { rTop: 1.5, rBottom: 2.8, h: 3.6, segments: 24 },
    orb: { r: 3.1, gap: 0.5, stemR: 0.5, halo: 1.4, beamR: 0.45, beam: 14, wSeg: 24, hSeg: 16 },
    gyro: { r: 4.6, tube: 0.2 },
    coil: { r: 8.6, h: 4.2, coilR: 1.0, angles: [0.35, Math.PI - 0.35] },
    rings: [{ r: 5.8, dy: -0.6, tube: 0.12 }, { r: 7.0, dy: -2.6, tube: 0.12 }], ringAmp: 0.25,
    emblem: { size: 6.5, z: -9.0, lift: 2.0 },
  },
  faceted: {
    foundation: { kind: 'stage', r: 9.6, segments: 8 },
    house: { kind: 'faceted', w: 6, topW: 3.2, h: 3.8, d: 3.0, z: 9.6 },
    vents: [[-8.0, 0], [8.0, 0]], ventR: 1.1,
    pylon: { count: 6, phase: Math.PI / 6, r: 7.2, w: 1.4, topW: 0.6, h: 6.5, lensR: 6.0, lensLift: 0.7, lensSize: 0.7, lensStretch: 1.5, beaconEvery: 2 },
    crystal: { y: 7.4, size: 1.5, stretch: 2.2, discR: 2.6, discH: 0.12, discDy: 1.8, lensR: 0.2, halo: 2.9, beamStop: 1.4 },
    pedestal: { w: 2.8, topW: 1.0, h: 3.2, shaftW: 0.4, shaftH: 0.9 },
    beam: { thickness: 0.09, holdThickness: 0.07, holders: [0, 2, 4] },
    rings: [{ r: 3.0, dy: -1.4, tube: 0.08 }, { r: 3.0, dy: 2.2, tube: 0.08 }], ringAmp: 0.2,
    emblem: { size: 6.5, gap: 1.0 },
  },
};

const BODIES = {};   // silhouette → body function (filled below)

// ---------------------------------------------------------------- static helpers (construction time only)

/** Pad + plinth by kind ('round' disc with neon ring / 'armored' box with spikes / 'stage' low octagon). Returns the top y. */
function foundation(c, F) {
  const L = LAYOUT;
  const { b, S, kit } = c;
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  const y = L.padH;
  if (F.kind === 'round') {
    b.cylinder(F.r, F.r + 0.4, L.plinthH, L.plinthSegments, S.hullDark, { y: y + L.plinthH / 2 });
    if (kit.style.neon >= L.neonMin) b.torus(F.r - 0.4, L.neonTube, 4, L.plinthSegments * 2, TAU, S.neon, { rx: Math.PI / 2, y: y + L.plinthH + 0.02 });
    const rOut = F.r - TEAM.ring.gap;
    flatRing(b, S.teamShade, rOut - TEAM.ring.w, rOut, y + L.plinthH + TEAM.ring.lift, TEAM.ring.seg);   // big team ring on the plinth top
    return y + L.plinthH;
  }
  if (F.kind === 'armored') {
    const A = DETAIL.armored;
    const h = L.plinthH + A.skirtExtra;
    const w = F.half * 2;
    b.box(w, h, w, S.hullDark, { base: true, y });
    for (const e of [-1, 1]) b.box(w * A.bandShare, A.bandH, A.bandT, S.lower, { y: y + A.bandY, z: e * (F.half + A.bandT / 2) });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: sx * F.half, y: y + h, z: sz * F.half, h: A.spikeH, r: A.spikeR });
    flatFrame(b, S.teamShade, F.half - TEAM.frame.inset, TEAM.frame.w, y + h, TEAM.frame.h);   // team frame on the plinth top
    teamTrim(b, kit, { y: y + h, w, d: w });                                                   // low lip on the plinth rim
    return y + h;
  }
  const St = DETAIL.stage;
  const h = L.plinthH - St.lessH;
  b.cylinder(F.r, F.r + St.grow, h, F.segments, S.hullDark, { y: y + h / 2 });
  if (kit.style.neon >= L.neonMin) b.torus(F.r + St.grow, L.neonTube, 4, F.segments * 2, TAU, S.neon, { rx: Math.PI / 2, y: y + h });
  const rOut = F.r * Math.cos(Math.PI / F.segments) - TEAM.ring.gap;   // inside the octagon
  flatRing(b, S.teamShade, rOut - TEAM.ring.w, rOut, y + h + TEAM.ring.lift, TEAM.ring.seg);
  return y + h;
}

/**
 * Control house in front (door, hazard / light marking, neon line, team band, beacons, emblem decals).
 * kind: box (styled edges) · sloped / faceted (narrower top) · dome (cylinder + flat dome).
 */
function house(c, H, baseY) {
  const { b, S, kit, glows } = c;
  const G = DETAIL.house;
  const beaconA = glows.get('beaconA');
  const neon = kit.style.neon >= LAYOUT.neonMin;
  const top = baseY + H.h;
  if (H.kind === 'dome') {
    b.cylinder(H.r, H.r, H.h, G.domeSegments, S.hull, { y: baseY + H.h / 2, z: H.z });
    b.add(new THREE.SphereGeometry(H.r, G.domeSegments, G.domeRings, 0, TAU, 0, Math.PI / 2), S.teamPaint, { y: top, z: H.z, sy: G.domeFlat, detail: TEAM.detail });   // the dome is team paint
    b.cylinder(H.r + G.out, H.r + G.out, G.winH, G.domeSegments, S.window, { y: baseY + H.h * G.winY, z: H.z }, true);
    if (neon) b.cylinder(H.r + G.out * 1.5, H.r + G.out * 1.5, G.neonH, G.domeSegments, S.neon, { y: baseY + H.h * G.neonY, z: H.z }, true);
    const rr = H.r - G.out;
    b.box(G.doorW, G.doorH, G.doorT, S.interior, { base: true, y: baseY, x: -Math.sin(G.doorAngle) * rr, z: H.z + Math.cos(G.doorAngle) * rr, ry: -G.doorAngle });
    c.decals.push({
      position: [Math.sin(G.doorAngle) * H.r, baseY + G.decalY, H.z + Math.cos(G.doorAngle) * H.r],
      normal: [Math.sin(G.doorAngle), 0, Math.cos(G.doorAngle)], size: G.decalSize,
    });
    beacon(b, beaconA, kit, [0, top + H.r * G.domeFlat, H.z]);
    return;
  }
  const front = H.z + H.d / 2;
  if (H.kind === 'box') styledBox(b, kit, H.w, H.h, H.d, S.hull, { base: true, y: baseY, z: H.z });
  else b.taperedBox(H.w, H.topW, H.h, H.d, S.hull, { y: baseY, z: H.z }, H.d);
  const doorX = -H.w * G.doorX;
  const doorZ = front + G.doorOut;
  b.box(G.doorW, G.doorH, G.doorT, S.interior, { base: true, x: doorX, y: baseY, z: doorZ });
  for (const side of [-1, 1]) b.box(G.frameW, G.doorH + G.frameW, G.doorT * 1.5, S.frame, { base: true, x: doorX + side * (G.doorW / 2 + G.frameW / 2), y: baseY, z: doorZ });
  b.box(G.doorW + G.frameW * 2, G.frameW, G.doorT * 1.5, S.frame, { y: baseY + G.doorH + G.frameW / 2, x: doorX, z: doorZ });
  marking(b, kit, G.doorW + G.frameW * 2, G.markH, { y: baseY + G.doorH + G.frameW + G.markH / 2, x: doorX, z: front + G.markOut });
  if (neon) neonStrip(b, kit, H.w * G.neonW, G.neonH, G.neonT, { y: top - G.neonDrop, z: front + G.neonOut });
  b.box(H.w * G.bandW, G.bandH, G.bandT, S.teamPaint, { y: top - G.bandDrop, z: front + G.bandOut, detail: TEAM.detail });
  const roofW = H.topW ?? H.w;   // team lip + mark on the roof (seen from the RTS camera)
  teamTrim(b, kit, { y: top, z: H.z, w: roofW, d: H.d });
  roofMark(b, kit, { y: top, z: H.z, w: roofW * TEAM.houseRoof.wShare, d: H.d * TEAM.houseRoof.dShare });
  const bx = (H.topW ?? H.w) / 2 - G.beaconInset;
  for (const s of [-1, 1]) beacon(b, beaconA, kit, [s * bx, top, front - G.beaconInset]);
  c.decals.push({ position: [H.w * G.decalX, baseY + G.decalY, front], normal: [0, 0, 1], size: G.decalSize });
  if (H.kind === 'box') for (const s of [-1, 1]) c.decals.push({ position: [s * H.w / 2, baseY + G.decalY, H.z], normal: [s, 0, 0], size: G.decalSize });
}

/** Stand-up emblem as an extruded dominant (team colour): base plate, two struts, emblemShape. */
function emblemStand(c, E, surfaceY) {
  const L = LAYOUT;
  const P = L.emblemPlate;
  const { b, S, kit } = c;
  const cy = surfaceY + E.lift + E.size / 2;
  b.box(E.size * P.widthShare, P.h, P.d, S.hullDark, { base: true, y: surfaceY, z: E.z });
  for (const s of [-1, 1]) b.box(P.strutT, E.lift - P.h + 0.2, P.strutT, S.frame, { base: true, x: s * E.size * P.strutShare, y: surfaceY + P.h, z: E.z });
  b.add(emblemShape(kit.key, L.emblemDepth, E.size), S.team, { y: cy, z: E.z });
}

const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();

/** Unit direction a → b scaled so that the point lies `back` before b (beam end just outside a target) */
function beamEnd(a, b, back) {
  _sa.fromArray(a);
  _sb.fromArray(b).sub(_sa);
  const len = _sb.length();
  _sb.multiplyScalar(Math.max(0, len - back) / len).add(_sa);
  return _sb.toArray();
}

// ---------------------------------------------------------------- bodies

/** rounded: fusion torus – two hull shells around a plasma gap, clamps, central solenoid, tanks, orbiting plasma knot */
BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit, glows } = c;
  const y0 = foundation(c, D.foundation);
  house(c, D.house, y0);
  const V = D.vessel;
  const cy = y0 + V.y;
  const edge = V.gap + V.shell;
  for (let i = 0; i < V.legs; i++) {
    const a = (i / V.legs) * TAU + V.legPhase;
    b.box(V.legW, cy - edge - y0, V.legW, S.frame, { base: true, x: Math.cos(a) * V.R, y: y0, z: Math.sin(a) * V.R });
  }
  for (const s of [-1, 1]) b.torus(V.R, V.shell, V.segTube, V.segRing, TAU, s > 0 ? S.teamPaint : S.teamShade, { rx: Math.PI / 2, y: cy + s * V.gap, detail: TEAM.detail });   // both shells are team paint
  b.torus(V.R, V.plasma, V.segPlasma, V.segRing, TAU, c.R, { rx: Math.PI / 2, y: cy });
  for (let i = 0; i < V.clamps; i++) {
    const a = (i / V.clamps) * TAU;
    b.box(V.clampD, edge * 2 + V.clampOver, V.clampW, S.frame, { x: Math.cos(a) * V.R, y: cy, z: Math.sin(a) * V.R, ry: -a });
  }
  glows.get('reactor').torus(V.R, V.plasma * V.halo, V.haloTube, V.segRing, TAU, { rx: Math.PI / 2, y: cy });

  const So = D.solenoid;
  const sh = cy - y0 + So.above;
  b.cylinder(So.r, So.r, sh, So.segments, S.frame, { y: y0 + sh / 2 });
  b.cylinder(So.r + So.capOver, So.r + So.capOver, So.capH, So.segments, S.hullDark, { y: y0 + sh - So.capH / 2 });
  if (kit.style.neon >= LAYOUT.neonMin) {
    for (let k = 1; k <= So.rings; k++) b.torus(So.r + So.ringOver, So.ringTube, 4, 20, TAU, S.neon, { rx: Math.PI / 2, y: y0 + (sh * k) / (So.rings + 1) });
  }
  b.torus(So.r + So.bandOver, So.bandTube, 4, 20, TAU, c.R, { rx: Math.PI / 2, y: cy });

  const T = D.tanks;
  const tankY = y0 + T.r + T.rise;
  for (const s of [-1, 1]) {
    tank(b, kit, { x: s * T.x, y: tankY, z: 0, r: T.r, len: T.len, ry: Math.PI / 2, floorY: y0 });
    pipeRun(b, kit, [[s * T.x, tankY + T.r, 0], [s * T.x, cy - edge, 0], [s * (V.R + V.shell * 0.5), cy - edge, 0]], T.pipeR);
  }
  c.vents.push(...D.vents.map(([x, z]) => ventUnit(b, glows, kit, { x, y: y0, z, r: D.ventR })));

  const kb = new PartBuilder();
  kb.torus(V.R, V.plasma * V.knotScale, V.segPlasma, V.knotSeg, V.knotArc, c.R, { rx: Math.PI / 2 });
  c.core = { geometry: kb.build(), at: [0, cy, 0], mode: 'turn', speed: GENERATOR_ANIM.knotSpeed };
  c.explosionAt = [0, cy, 0];
  emblemStand(c, D.emblem, y0);
};

/** angular: fission vessel – armoured 8-sided containment, glowing slits, control rods, chimneys, open fans */
BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit, glows } = c;
  const y0 = foundation(c, D.foundation);
  house(c, D.house, y0);
  const K = D.vessel;
  const top = y0 + K.h;
  const capY = top + K.capH;
  b.cylinder(K.r, K.r, K.h, K.sides, S.teamPaint, { y: y0 + K.h / 2, detail: TEAM.detail });             // the whole containment is team paint
  b.cylinder(K.capTop, K.r, K.capH, K.sides, S.teamShade, { y: top + K.capH / 2, detail: TEAM.detail });
  const ap = K.r * Math.cos(Math.PI / K.sides);
  for (let k = 0; k < K.sides; k++) {
    const v = (k / K.sides) * TAU;                 // vertex angle (x = sin, z = cos, like CylinderGeometry)
    const f = v + Math.PI / K.sides;               // face centre angle
    const sf = Math.sin(f);
    const cf = Math.cos(f);
    b.box(K.buttW, K.buttH, K.buttD, S.hullDark, { base: true, x: Math.sin(v) * (K.r + K.buttOut), y: y0, z: Math.cos(v) * (K.r + K.buttOut), ry: v });
    b.box(K.slitW, K.slitH, K.slitT, c.R, { x: sf * (ap + K.slitOut), y: y0 + K.slitY, z: cf * (ap + K.slitOut), ry: f });
    glows.get('reactor').box(K.haloW, K.haloH, K.haloD, { x: sf * (ap + K.haloOut), y: y0 + K.slitY, z: cf * (ap + K.haloOut), ry: f });
    b.box(K.lowerW, K.lowerH, K.lowerT, S.lower, { x: sf * (ap + K.lowerT / 2), y: y0 + K.lowerY, z: cf * (ap + K.lowerT / 2), ry: f });
    spike(b, kit, { x: Math.sin(v) * K.capTop, y: capY, z: Math.cos(v) * K.capTop, h: K.spikeH, r: K.spikeR });
  }

  const R = D.rods;
  for (const [x, z] of [[R.r, 0], [-R.r, 0], [0, R.r], [0, -R.r]]) b.cylinder(R.sleeveR, R.sleeveR * 1.15, R.sleeveH, 10, S.hullDark, { x, y: capY + R.sleeveH / 2, z });
  const rb = new PartBuilder();   // two rods on the X axis (the second mesh is turned by 90°), origin at the rod foot
  for (const e of [-1, 1]) {
    rb.cylinder(R.rodR, R.rodR, R.len, 8, S.trim, { x: e * R.r, y: R.len / 2 });
    rb.cylinder(R.collarR, R.collarR, R.collarH, 8, S.frame, { x: e * R.r, y: R.len * 0.5 });
    spike(rb, kit, { x: e * R.r, y: R.len, z: 0, h: R.tipH, r: R.tipR });
  }
  c.rods = { geometry: rb.build(), y: capY + R.sleeveH - R.insert };

  const L = D.lamp;
  const lb = new PartBuilder();   // rotating warning lamp (centre of the cap)
  lb.cylinder(L.baseR, L.baseR * 1.2, L.baseH, 8, S.hullDark, { y: L.baseH / 2 });
  lb.box(L.arm * 2, L.armT, L.armT, S.frame, { y: L.rise });
  for (const e of [-1, 1]) lb.cylinder(L.lensR, L.lensR, L.lensH, 8, c.R, { x: e * L.arm, y: L.rise, rz: Math.PI / 2 });
  c.core = { geometry: lb.build(), at: [0, capY, 0], mode: 'turn', speed: GENERATOR_ANIM.lampSpeed };

  for (const [x, z] of D.chimneys) {
    chimney(b, kit, { x, y: y0, z, h: D.chimneyH, r: D.chimneyR });
    pipeRun(b, kit, [[x, D.pipes.y, z], [Math.sign(x) * D.pipes.x1, D.pipes.y, D.pipes.z1]], D.pipes.r);
  }
  c.vents.push(...D.vents.map(([x, z]) => ventUnit(b, glows, kit, { x, y: y0, z, r: D.ventR })));
  const cr = D.foundation.half - D.corners;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [sx * cr, y0, sz * cr]);
  c.explosionAt = [0, y0 + K.h * 0.5, 0];
  emblemStand(c, D.emblem, y0);
};

/** round: plasma sphere floating over a pedestal in a spinning gyroscope, coils with arcs, levitating rings, orb vents */
BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const y0 = foundation(c, D.foundation);
  house(c, D.house, y0);
  const P = D.pedestal;
  const O = D.orb;
  const cy = y0 + P.h + O.gap + O.r;
  b.cylinder(P.rTop, P.rBottom, P.h, P.segments, S.teamPaint, { y: y0 + P.h / 2, detail: TEAM.detail });   // team pedestal under the plasma sphere
  b.cylinder(O.stemR, O.stemR, O.gap + 0.4, 10, c.R, { y: y0 + P.h + O.gap / 2 });
  b.sphere(O.r, O.wSeg, O.hSeg, c.R, { y: cy });
  glows.get('reactor').sphere(O.r * O.halo, 16, 10, { y: cy });
  glows.get('reactor').cylinder(O.beamR, O.beamR, O.beam, 8, { y: cy + O.r + O.beam / 2 });

  const C = D.coil;
  for (const a of C.angles) {
    const t = plasmaCoil(b, glows.get('pulse'), kit, { x: Math.cos(a) * C.r, y: y0, z: Math.sin(a) * C.r, h: C.h, r: C.coilR });
    const dx = t[0];
    const dy = t[1] - cy;
    const dz = t[2];
    const len = Math.hypot(dx, dy, dz);
    c.arcPairs.push([t, [(dx / len) * O.r, cy + (dy / len) * O.r, (dz / len) * O.r]]);
  }
  c.vents.push(...D.vents.map(([x, z]) => ventUnit(b, glows, kit, { x, y: y0, z, r: D.ventR })));
  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, y: cy + r.dy, amp: D.ringAmp });

  const gb = new PartBuilder();   // gyroscope: three orthogonal rings around the sphere
  const G = D.gyro;
  gb.torus(G.r, G.tube, 6, 28, TAU, S.teamPaint, { rx: Math.PI / 2 });   // the spinning gyroscope rings are team paint
  gb.torus(G.r, G.tube, 6, 28, TAU, S.teamShade, {});
  gb.torus(G.r, G.tube, 6, 28, TAU, S.teamPaint, { ry: Math.PI / 2 });
  c.core = { geometry: gb.build(), at: [0, cy, 0], mode: 'turn', speed: GENERATOR_ANIM.gyroSpeed };
  c.explosionAt = [0, cy, 0];
  emblemStand(c, D.emblem, y0);
};

/** faceted: photon crystal levitating between six laser pylons, held emblem above, radiators */
BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const photon = glows.get('reactor');
  const laser = glows.get('laser');
  const y0 = foundation(c, D.foundation);
  house(c, D.house, LAYOUT.padH);
  const K = D.crystal;
  const cy = y0 + K.y;
  const Pd = D.pedestal;
  b.taperedBox(Pd.w, Pd.topW, Pd.h, Pd.w, S.teamShade, { y: y0, ry: Math.PI / 4, detail: TEAM.detail });
  photon.box(Pd.shaftW, Pd.shaftH, Pd.shaftW, { y: y0 + Pd.h + Pd.shaftH / 2 });
  photon.sphere(K.halo, 14, 10, { y: cy });

  const P = D.pylon;
  const lenses = [];
  for (let i = 0; i < P.count; i++) {
    const a = (i / P.count) * TAU + P.phase;
    const x = Math.cos(a) * P.r;
    const z = Math.sin(a) * P.r;
    b.taperedBox(P.w, P.topW, P.h, P.w, S.teamPaint, { x, y: y0, z, ry: Math.PI / 4 - a, detail: TEAM.detail });   // the six laser pylons are team paint
    const lens = [Math.cos(a) * P.lensR, y0 + P.h + P.lensLift, Math.sin(a) * P.lensR];
    const g = new THREE.OctahedronGeometry(P.lensSize, 0);
    g.scale(1, P.lensStretch, 1);
    b.add(g, S.lens, { x: lens[0], y: lens[1], z: lens[2] });
    photon.segment(lens, beamEnd(lens, [0, cy, 0], K.beamStop), D.beam.thickness);
    lenses.push(lens);
    if (i % P.beaconEvery === 0) beacon(b, glows.get('beaconA'), kit, [x, y0 + P.h, z]);
  }

  const E = D.emblem;
  const top = cy + K.size * K.stretch;
  const ey = top + E.gap + E.size / 2;
  b.add(emblemShape(kit.key, LAYOUT.emblemDepth, E.size), S.team, { y: ey });
  for (const i of D.beam.holders) laser.segment(lenses[i], [0, ey - E.size / 2 + E.size * 0.04, 0], D.beam.holdThickness);

  c.vents.push(...D.vents.map(([x, z]) => ventUnit(b, glows, kit, { x, y: y0, z, r: D.ventR })));
  for (const r of D.rings) c.rings.push({ r: r.r, tube: r.tube, y: cy + r.dy, amp: D.ringAmp });

  const cb = new PartBuilder();   // the crystal with two discs and a side lens, origin at its centre
  const g = new THREE.OctahedronGeometry(K.size, 0);
  g.scale(1, K.stretch, 1);
  cb.add(g, c.R);
  for (const s of [-1, 1]) cb.box(K.discR * 2, K.discH, K.discR * 2, S.teamPaint, { y: s * K.discDy, ry: Math.PI / 4 });
  cb.cylinder(K.lensR, K.lensR, K.lensR * 2, 8, S.lens, { x: K.discR + K.lensR, rz: Math.PI / 2 });
  c.core = { geometry: cb.build(), at: [0, cy, 0], mode: 'float' };
  c.explosionAt = [0, cy, 0];
};

// ---------------------------------------------------------------- animated helpers (no allocation in update)

/** Part turning around Y; the speed rises with the reactor power (idle share → full), optionally in stepped ticks */
class Turner {
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

/** Part sliding up and down (control rods), eased or in stepped pushes; stroke speed follows the power */
class Slider {
  constructor(object, { baseY, amp, period, idle, steps = 0, phase = 0 }) {
    this.object = object;
    this.baseY = baseY;
    this.amp = amp;
    this.period = period;
    this.idle = idle;
    this.steps = steps;
    this.clock = phase * period;
  }

  update(delta, power) {
    this.clock += delta * (this.idle + (1 - this.idle) * power);
    const ph = (this.clock / this.period) % 1;
    const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
    const k = this.steps > 0 ? steppedEase(tri, this.steps) : 0.5 - 0.5 * Math.cos(Math.PI * tri);
    this.object.position.y = this.baseY + this.amp * k;
  }
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const c = {
    kit, S: kit.S,
    R: surface(kit.style.reactorGlow ?? REACTOR.fallbackColor, { metal: REACTOR.metal, rough: REACTOR.rough, glow: REACTOR.glow }),
    b: new PartBuilder(), glows: new GlowSet(),
    decals: [], vents: [], rings: [], arcPairs: [], core: null, rods: null, explosionAt: [0, 0, 0],
  };
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbRings = c.vents.filter((v) => v.ring);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    core: c.core,
    rings: c.rings.map((r) => ({ geometry: ringGeometry(kit, r.r, r.tube), y: r.y, amp: r.amp })),
    rods: c.rods,
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbRings.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbRings.length ? ringGeometry(kit, orbRings[0].ring.r) : null,
    arcs: c.arcPairs.length ? arcGeometry(c.arcPairs, GENERATOR_ANIM.arcSeed) : null,
    explosionAt: c.explosionAt,
  };
}

const GENERATOR_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class PowerGeneratorProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: GENERATOR_CACHE, name: 'PowerGeneratorProc' });
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
    const A = GENERATOR_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.reactorGlow = layer('reactor', gc.reactor ?? GENERATOR_EXPLOSION.fallbackGlow, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.laserGlow = layer('laser', gc.laser, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.arcs = null;
    if (sh.arcs) {
      const arcLayer = this.glowLayer(this.instanceGeometry(sh.arcs.geometry), gc.arc, { visible: false });
      this.arcs = new ArcFlicker(arcLayer, sh.arcs.ranges, { seed: A.arcSeed + seq });
    }

    this.drives = [];
    this.levitators = [];
    this.sliders = [];
    if (sh.core) {   // plasma knot / warning lamp / gyroscope turn, the crystal floats
      const mesh = this.paintMesh(sh.core.geometry);
      mesh.position.set(sh.core.at[0], sh.core.at[1], sh.core.at[2]);
      if (sh.core.mode === 'float') {
        this.levitators.push(new Levitator(mesh, { amp: A.crystalBob * an.levitate, spin: A.crystalSpin * an.spin, phase: seq * 0.5 }));
      } else {
        const step = an.jerk > 0 ? TAU / A.jerkTicks : 0;
        this.drives.push(new Turner(mesh, { speed: sh.core.speed * an.spin, idle: A.knotIdle, step, phase: seq * 0.5 }));
      }
    }
    if (sh.rods) {   // two meshes (second one turned by 90°) pump against each other
      const steps = an.jerk > 0 ? A.rodSteps : 0;
      for (let i = 0; i < 2; i++) {
        const mesh = this.paintMesh(sh.rods.geometry);
        mesh.position.y = sh.rods.y;
        mesh.rotation.y = (i * Math.PI) / 2;
        this.sliders.push(new Slider(mesh, { baseY: sh.rods.y, amp: A.rodAmp, period: A.rodPeriod, idle: A.rodIdle, steps, phase: i * 0.5 + seq * 0.13 }));
      }
    }
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanJitter;
      this.drives.push(new Turner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), idle: A.fanIdle, phase: (seq * 0.7 + i * 1.3) % TAU }));
    });
    sh.rings.forEach((r, i) => {
      const mesh = this.paintMesh(r.geometry);
      mesh.position.set(sh.core ? sh.core.at[0] : 0, r.y, sh.core ? sh.core.at[2] : 0);
      this.levitators.push(new Levitator(mesh, { amp: r.amp * an.levitate, spin: A.ringSpin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });
    const lev = PROC_MODULES.levitate;
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
   * Centre of the reactor in world space (where the destruction explosion starts). No allocation: writes into `out`.
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3}
   */
  getExplosionOrigin(out) {
    if (!this.shared) return out;
    const e = this.shared.explosionAt;
    this.updateWorldMatrix(true, false);
    return out.set(e[0], e[1], e[2]).applyMatrix4(this.matrixWorld);
  }

  /**
   * Per-frame animation (no allocations). Idle: the reactor glows dimly, parts turn slowly, beacons burn steadily.
   * Active (producing power): reactor glow and pulse at full, plasma knot / gyroscope / lamp / fans spin up, control rods
   * pump, radiators heat up, arcs flash, beacons blink, floating parts move faster.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = GENERATOR_ANIM;
    const dt = delta;   // already scaled by animScale in tick(); no grid power:every motion stands still (the generator itself is never unpowered)
    this.time += dt;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    for (let i = 0; i < this.drives.length; i++) this.drives[i].update(dt, this.power);
    for (let i = 0; i < this.sliders.length; i++) this.sliders[i].update(dt, this.power);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(dt, active);
    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * this.power);
    this.reactorGlow?.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(dt, this.power > A.arcPower);
    this.blink.update(dt, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
