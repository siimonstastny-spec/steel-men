// Steel Men – procedural deep ore extractor (tier 3, built on an ore deposit), model and animation only. Built in code
// from the style modules (ProcModules.js) and the faction style (data/buildingStyles.json):
//   • footprint: pad ±7.5 × ±7.5 around the model origin (an ore deposit has radius 7), front = +Z; the bore hole is in the centre
//   • a rig over the bore and a drill string hanging from it; while `active` the string spins and feeds down into the bore
//     and back (stepped pushes when style.anim.jerk > 0), four probes (sondes) pump up and down in the corners of the axes
//   • rig / string / probes by style.silhouette (code knows shapes, the data picks one; unknown → rounded):
//       rounded = yellow lattice derrick, rotary drill with a cone bit, steel cable, rod probes, tank, guarded fans
//       angular = heavy riveted derrick, percussion hammer drill (jerky, spiked), piston probes, chimney, open fans
//       round   = three plasma arches over a levitating plasma drill head on a plasma beam, needle probes, plasma orbs
//       faceted = laser tripod, crystal drill head with orbiting lens plates on a laser tether, lance probes, radiators
//   • one merged static mesh (LODs) + emblem decals + glow layers (beacons, pulse, bore, radiator, beam) + animated parts
// Visual only: update() takes the frame delta. No allocations in update().
import * as THREE from 'three';
import { PROC_TEAM_PAINT } from '../config.js';
import { PartBuilder, GlowBuilder, Blinker, steppedEase, smootherstep } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, pipeRun, tank, chimney, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES, teamTrim, roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/**
 * Team paint (S.teamPaint / S.teamShade = vertices with team = 1: no extra draw call, batching and setTeamColor work as
 * before): the rig (derrick legs / arches / tripod legs), the plinth top (ring or frame), the drill string and the probes
 * are painted, the rest stays neutral metal. detail = coarsest LOD the painted parts appear in (2 = far silhouette).
 */
const TEAM = {
  detail: PROC_TEAM_PAINT.lod.panel,
  ring: { w: 3.0, gap: 0.8, lift: 0.03, seg: 36 },    // flat team ring on a round plinth top: width, gap to the rim, lift
  frame: { w: 1.5, inset: 1.0, h: 0.06 },             // flat team frame on a square plinth top (inset from the rim / spikes)
  cabinetRoof: { wShare: 0.6, dShare: 0.6 },          // roof mark of the equipment cabinet (shares of its roof)
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
export const EXTRACTOR_ANIM = {
  powerEase: 1.0,         // 1/s – how fast the glow / spin run up and down
  feedPeriod: 9.0,        // s – one descent and retraction of the drill string while active
  feedDepth: 3.2,         // m – how far the string sinks into the bore
  feedSteps: 4,           // pushes per descent when jerky
  feedFollow: 8.0,        // 1/s – the string follows its target (smooths the start / stop)
  spinSpeed: 5.0,         // rad/s of the string at full power (× style.anim.spin × string.spin)
  hammerHz: 9.0,          // Hz of the percussion jolt (jerky styles)
  hammerAmp: 0.08,        // m (× style.anim.jerk)
  probePeriod: 3.2,       // s – one stroke of a probe pair at full power
  probeAmp: 1.6,
  probeSteps: 3,
  probeIdle: 0,           // stroke speed share while idle (probes rest)
  fanSpeed: 3.5,
  fanIdle: 0.3,
  fanJitter: 0.25,
  idleGlow: 0.3,
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
};

/** Shared layout (model units; front = +Z) */
const LAYOUT = {
  padHalf: 7.5, padH: 0.3, plinthH: 0.8, plinthSegments: 32,
  neonMin: 0.3,           // style.neon from which neon trim is added
  neonTube: 0.08,
  stringClearance: 0.6,   // the bit tip hangs this high above the bore floor at rest
  bore: { r: 1.5, discH: 0.06, rimTube: 0.15, rimLift: 0.08, neonTube: 0.05, glowScale: 1.15, glowH: 0.05, haloTube: 0.2, segments: 24 },
  emblemSize: 1.3,
};

/** Probes (pump rods in the corners of the axes: two meshes of two probes) */
const PROBE = { r: 4.2, sleeveH: 1.0, sleeveR: 0.6, len: 3.4, insert: 1.6 };

const DETAIL = {
  armored: { skirtExtra: 0.1, bandY: 0.4, bandH: 0.4, bandT: 0.06, bandShare: 0.9, spikeH: 1.0, spikeR: 0.3 },
  stage: { grow: 0.2 },
  front: { markH: 0.5, markLen: 10, markOut: 0.02, markY: 0.4 },   // marking on the front face of the plinth
  cabinet: {
    domeSegments: 20, domeRings: 6, domeFlat: 0.5, doorW: 1.1, doorH: 1.8, doorT: 0.1, doorOut: 0.02, doorX: 0.22, doorAngle: 0.5,
    markH: 0.4, markOut: 0.03, neonH: 0.1, neonT: 0.05, neonDrop: 0.15, neonOut: 0.02, beaconInset: 0.4, decalX: 0.2, decalY: 0.55,
  },
  crown: { sheaveShare: 0.28, sheaveLift: 0.6, spikeH: 0.9, spikeR: 0.22, spikeInset: 0.25 },
};

/**
 * Dimensions by style.silhouette. rig = what stands over the bore (derrick / arches / tripod), string = the drill string
 * (origin at its top, hangs down), tether = cable or beam from the rig to the string, probe = pump probe kind.
 */
const DIM = {
  rounded: {
    foundation: { kind: 'box' },
    cabinet: { kind: 'box', w: 3.2, h: 2.8, d: 3.0, x: 5.0, z: 5.0 },
    vents: [[-5.2, 5.2], [-5.2, -5.2]], ventR: 1.0,
    rig: { kind: 'derrick', base: 3.0, top: 1.1, h: 11.5, legW: 0.45, braceW: 0.22, sections: 3, legS: 'teamPaint', braceS: 'frame', crownW: 2.6, crownH: 0.9, spikes: false },
    string: { kind: 'rotary', spin: 1, swivelH: 0.7, pipeR: 0.38, pipeLen: 7.2, collars: 3, bitR: 0.55, bitLen: 1.1, teeth: 3 },
    tether: { kind: 'cable', r: 0.07 },
    probe: { kind: 'rod', seg: 10 },
    tank: { x: 5.0, z: -5.0, r: 1.1, len: 4, rise: 0.4, pipeR: 0.22 },
  },
  angular: {
    foundation: { kind: 'armored' },
    cabinet: { kind: 'box', w: 3.2, h: 2.8, d: 3.0, x: 5.0, z: 5.0 },
    vents: [[-5.2, 5.2], [-5.2, -5.2]], ventR: 1.1,
    rig: { kind: 'derrick', base: 3.4, top: 1.5, h: 12, legW: 0.9, braceW: 0.4, sections: 3, legS: 'teamPaint', braceS: 'frame', crownW: 3.2, crownH: 1.1, spikes: true },
    string: { kind: 'hammer', spin: 0, swivelH: 0.9, shaft: 0.8, pipeLen: 6.8, flanges: 3, bitR: 0.9, bitLen: 1.5 },
    tether: { kind: 'cable', r: 0.12 },
    probe: { kind: 'piston', seg: 8, w: 0.55, tipH: 0.8, tipR: 0.2 },
    chimney: { x: 5.0, z: -5.0, h: 6, r: 1.0, pipeR: 0.3 },
  },
  round: {
    foundation: { kind: 'round' },
    cabinet: { kind: 'dome', r: 1.9, h: 2.0, x: 5.0, z: 5.0 },
    vents: [[5.2, -5.2]], ventR: 1.4,
    rig: { kind: 'arches', R: 6.0, tube: 0.3, stretch: 1.8, phase: 0.35, crownR: 0.8, ringR: 1.2, ringTube: 0.07, haloR: 1.6, tetherDrop: 0.6 },
    string: { kind: 'plasma', spin: 1, orbR: 0.55, stemR: 0.2, pipeLen: 2.6, coneR: 1.0, coneLen: 3.0, fins: 3, rings: 3 },
    tether: { kind: 'beam', beamR: 0.32, beamCore: 0.13 },
    probe: { kind: 'needle', seg: 16 },
  },
  faceted: {
    foundation: { kind: 'stage', segments: 8 },
    cabinet: { kind: 'faceted', w: 3.0, topW: 1.6, h: 3.2, d: 2.8, x: 5.0, z: 5.0 },
    vents: [[-5.2, 5.2], [5.2, -5.2]], ventR: 1.1,
    rig: { kind: 'tripod', r: 6.0, topR: 0.9, h: 11, legW: 0.35, braceW: 0.12, levels: [0.35, 0.7], phase: 0.52, crownR: 1.2, crownH: 0.35, lensSize: 0.5, lensStretch: 1.6, tetherDrop: 0.2 },
    string: { kind: 'crystal', spin: 1.2, plateW: 0.9, plateH: 0.15, stemR: 0.12, pipeLen: 4.2, size: 0.8, stretch: 2.4, plates: 3, plateR: 1.3 },
    tether: { kind: 'laser', core: 0.07, halo: 0.16 },
    probe: { kind: 'lance', seg: 6 },
  },
};

const BODIES = {};   // silhouette → body function (filled below)

// ---------------------------------------------------------------- static helpers (construction time only)

const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sq = new THREE.Quaternion();
const _sup = new THREE.Vector3(0, 1, 0);

/** Square strut (box) from point p to point q, width w */
function strut(b, p, q, w, s, detail = null) {
  _sa.fromArray(p);
  _sb.fromArray(q);
  const len = _sa.distanceTo(_sb);
  if (len <= 0) return b;
  const g = new THREE.BoxGeometry(w, len, w);
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  const mz = (p[2] + q[2]) / 2;
  _sq.setFromUnitVectors(_sup, _sb.sub(_sa).normalize());
  g.applyQuaternion(_sq);
  g.translate(mx, my, mz);
  return b.add(g, s, { detail });
}

/** Pad + plinth by kind ('box' / 'armored' with spikes / 'round' disc / 'stage' low octagon), front marking, bore. Returns the top y. */
function foundation(c, F) {
  const L = LAYOUT;
  const { b, S, kit } = c;
  const y = L.padH;
  const neon = kit.style.neon >= L.neonMin;
  const half = L.padHalf;
  b.box(half * 2, L.padH, half * 2, S.ground, { base: true });
  let top = y + L.plinthH;
  if (F.kind === 'round') {
    b.cylinder(half - 0.2, half - 0.2 + 0.3, L.plinthH, L.plinthSegments, S.hullDark, { y: y + L.plinthH / 2 });
    if (neon) b.torus(half - 0.6, L.neonTube, 4, L.plinthSegments * 2, TAU, S.neon, { rx: Math.PI / 2, y: top + 0.02 });
    const rOut = half - 0.2 - TEAM.ring.gap;
    flatRing(b, S.teamShade, rOut - TEAM.ring.w, rOut, top + TEAM.ring.lift, TEAM.ring.seg);   // team ring on the plinth top
  } else if (F.kind === 'stage') {
    b.cylinder(half - 0.2, half - 0.2 + DETAIL.stage.grow, L.plinthH, F.segments, S.hullDark, { y: y + L.plinthH / 2 });
    if (neon) b.torus(half - 0.2, L.neonTube, 4, F.segments * 2, TAU, S.neon, { rx: Math.PI / 2, y: top });
    const rOut = (half - 0.2) * Math.cos(Math.PI / F.segments) - TEAM.ring.gap;   // inside the octagon
    flatRing(b, S.teamShade, rOut - TEAM.ring.w, rOut, top + TEAM.ring.lift, TEAM.ring.seg);
  } else if (F.kind === 'armored') {
    const A = DETAIL.armored;
    const h = L.plinthH + A.skirtExtra;
    const w = (half - 0.3) * 2;
    b.box(w, h, w, S.hullDark, { base: true, y });
    for (const e of [-1, 1]) b.box(w * A.bandShare, A.bandH, A.bandT, S.lower, { y: y + A.bandY, z: e * (half - 0.3 + A.bandT / 2) });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: sx * (half - 0.3), y: y + h, z: sz * (half - 0.3), h: A.spikeH, r: A.spikeR });
    top = y + h;
    flatFrame(b, S.teamShade, half - 0.3 - TEAM.frame.inset, TEAM.frame.w, top, TEAM.frame.h);
    teamTrim(b, kit, { y: top, w, d: w });
  } else {
    styledBox(b, kit, (half - 0.3) * 2, L.plinthH, (half - 0.3) * 2, S.hullDark, { base: true, y });
    const F2 = DETAIL.front;
    marking(b, kit, F2.markLen, F2.markH, { y: y + F2.markY, z: half - 0.3 + F2.markOut });
    flatFrame(b, S.teamShade, half - 0.3 - TEAM.frame.inset, TEAM.frame.w, top, TEAM.frame.h);
    teamTrim(b, kit, { y: top, w: (half - 0.3) * 2, d: (half - 0.3) * 2 });
  }
  const B = L.bore;
  b.cylinder(B.r, B.r, B.discH, B.segments, S.hole, { y: top + B.discH / 2 });
  b.torus(B.r + 0.1, B.rimTube, 5, B.segments, TAU, S.frame, { rx: Math.PI / 2, y: top + B.rimLift });
  if (neon) b.torus(B.r - 0.1, B.neonTube, 4, B.segments, TAU, S.neon, { rx: Math.PI / 2, y: top + B.discH + 0.02 });
  c.glows.get('bore').cylinder(B.r * B.glowScale, B.r * B.glowScale, B.glowH, B.segments, { y: top + B.rimLift + 0.02 }, false);
  c.glows.get('bore').torus(B.r + 0.1, B.haloTube, 4, B.segments, TAU, { rx: Math.PI / 2, y: top + B.rimLift });
  return top;
}

/** Equipment cabinet in the corner (door, marking, neon line, beacon, emblem decals); kind: box · faceted · dome */
function cabinet(c, K, baseY) {
  const { b, S, kit, glows } = c;
  const G = DETAIL.cabinet;
  const neon = kit.style.neon >= LAYOUT.neonMin;
  const beaconA = glows.get('beaconA');
  const size = LAYOUT.emblemSize;
  if (K.kind === 'dome') {
    b.cylinder(K.r, K.r, K.h, G.domeSegments, S.hull, { x: K.x, y: baseY + K.h / 2, z: K.z });
    b.add(new THREE.SphereGeometry(K.r, G.domeSegments, G.domeRings, 0, TAU, 0, Math.PI / 2), S.teamPaint, { x: K.x, y: baseY + K.h, z: K.z, sy: G.domeFlat, detail: TEAM.detail });   // team dome
    if (neon) b.cylinder(K.r + 0.04, K.r + 0.04, G.neonH, G.domeSegments, S.neon, { x: K.x, y: baseY + K.h * 0.85, z: K.z }, true);
    b.box(G.doorW, G.doorH, G.doorT, S.interior, {
      base: true, x: K.x - Math.sin(G.doorAngle) * K.r, y: baseY, z: K.z + Math.cos(G.doorAngle) * K.r, ry: -G.doorAngle,
    });
    c.decals.push({
      position: [K.x + Math.sin(G.doorAngle) * K.r, baseY + K.h * G.decalY, K.z + Math.cos(G.doorAngle) * K.r],
      normal: [Math.sin(G.doorAngle), 0, Math.cos(G.doorAngle)], size,
    });
    beacon(b, beaconA, kit, [K.x, baseY + K.h + K.r * G.domeFlat, K.z]);
    return;
  }
  const front = K.z + K.d / 2;
  if (K.kind === 'box') styledBox(b, kit, K.w, K.h, K.d, S.hull, { base: true, x: K.x, y: baseY, z: K.z });
  else b.taperedBox(K.w, K.topW, K.h, K.d, S.hull, { x: K.x, y: baseY, z: K.z }, K.d);
  const dx = K.x - K.w * G.doorX;
  b.box(G.doorW, G.doorH, G.doorT, S.interior, { base: true, x: dx, y: baseY, z: front + G.doorOut });
  marking(b, kit, G.doorW + 0.2, G.markH, { x: dx, y: baseY + G.doorH + 0.1 + G.markH / 2, z: front + G.markOut });
  if (neon) neonStrip(b, kit, K.w * 0.85, G.neonH, G.neonT, { x: K.x, y: baseY + K.h - G.neonDrop, z: front + G.neonOut });
  const bx = (K.topW ?? K.w) / 2 - G.beaconInset;
  beacon(b, beaconA, kit, [K.x + bx, baseY + K.h, K.z + K.d / 2 - G.beaconInset]);
  const roofW = K.topW ?? K.w;   // team lip + mark on the cabinet roof
  teamTrim(b, kit, { x: K.x, y: baseY + K.h, z: K.z, w: roofW, d: K.d });
  roofMark(b, kit, { x: K.x, y: baseY + K.h, z: K.z, w: roofW * TEAM.cabinetRoof.wShare, d: K.d * TEAM.cabinetRoof.dShare });
  c.decals.push({ position: [K.x + K.w * G.decalX, baseY + K.h * G.decalY, front], normal: [0, 0, 1], size });
  if (K.kind === 'box') c.decals.push({ position: [K.x + K.w / 2, baseY + K.h * G.decalY, K.z], normal: [1, 0, 0], size });
}

/** Lattice derrick over the bore: four tapering legs, ring and cross braces per section, crown block with a sheave */
function derrick(c, Dr, y0) {
  const { b, S, kit, glows } = c;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const half = (t) => Dr.base + (Dr.top - Dr.base) * t;
  const pt = (sx, sz, t) => [sx * half(t), y0 + Dr.h * t, sz * half(t)];
  for (const [sx, sz] of corners) strut(b, pt(sx, sz, 0), pt(sx, sz, 1), Dr.legW, S[Dr.legS], TEAM.detail);   // legs = team paint (see DIM)
  for (let i = 0; i <= Dr.sections; i++) {
    const t0 = (i - 1) / Dr.sections;
    const t1 = i / Dr.sections;
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k];
      const [bx, bz] = corners[(k + 1) % 4];
      strut(b, pt(ax, az, t1), pt(bx, bz, t1), Dr.braceW, S[Dr.braceS]);
      if (i === 0) continue;
      strut(b, pt(ax, az, t0), pt(bx, bz, t1), Dr.braceW, S[Dr.braceS]);
      strut(b, pt(bx, bz, t0), pt(ax, az, t1), Dr.braceW, S[Dr.braceS]);
    }
  }
  const yTop = y0 + Dr.h;
  const Cr = DETAIL.crown;
  styledBox(b, kit, Dr.crownW, Dr.crownH, Dr.crownW, S.teamShade, { base: true, y: yTop, detail: TEAM.detail });
  b.cylinder(Dr.crownW * Cr.sheaveShare, Dr.crownW * Cr.sheaveShare, Dr.crownW * 0.8, 12, S.frame, { y: yTop + Dr.crownH + Dr.crownW * Cr.sheaveShare * Cr.sheaveLift, rz: Math.PI / 2 });
  beacon(b, glows.get('beaconA'), kit, [0, yTop + Dr.crownH, 0]);
  if (Dr.spikes) {
    const o = Dr.crownW / 2 - Cr.spikeInset;
    for (const [sx, sz] of corners) spike(b, kit, { x: sx * o, y: yTop + Dr.crownH, z: sz * o, h: Cr.spikeH, r: Cr.spikeR });
  }
  return { tetherY: yTop };
}

/** Three plasma arches rising from the pad and meeting above the bore, crown orb with a ring and halo */
function arches(c, A, y0) {
  const { b, S, glows } = c;
  for (let k = 0; k < 3; k++) b.torus(A.R, A.tube, 6, 24, Math.PI / 2, S.teamPaint, { ry: A.phase + (k * TAU) / 3, sy: A.stretch, y: y0, detail: TEAM.detail });   // team arches
  const top = y0 + A.R * A.stretch;
  b.sphere(A.crownR, 16, 10, S.plasma, { y: top });
  b.torus(A.ringR, A.ringTube, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: top });
  glows.get('pulse').sphere(A.haloR, 12, 8, { y: top });
  return { tetherY: top - A.tetherDrop };
}

/** Laser tripod: three slim legs leaning in, light braces, emitter crown with a lens */
function tripod(c, T, y0) {
  const { b, S, glows } = c;
  const yTop = y0 + T.h;
  const at = (a, t) => {
    const r = T.r + (T.topR - T.r) * t;
    return [Math.cos(a) * r, y0 + T.h * t, Math.sin(a) * r];
  };
  const angles = [0, 1, 2].map((i) => T.phase + (i * TAU) / 3);
  for (const a of angles) strut(b, at(a, 0), at(a, 1), T.legW, S.teamPaint, TEAM.detail);   // team legs
  for (const t of T.levels) for (let i = 0; i < 3; i++) strut(b, at(angles[i], t), at(angles[(i + 1) % 3], t), T.braceW, S.frame);
  b.cylinder(T.crownR, T.crownR * 0.8, T.crownH, 6, S.teamShade, { y: yTop + T.crownH / 2, detail: TEAM.detail });
  const g = new THREE.OctahedronGeometry(T.lensSize, 0);
  g.scale(1, T.lensStretch, 1);
  b.add(g, S.lens, { y: yTop - T.lensSize * 0.4 });
  glows.get('pulse').point([0, yTop - T.lensSize * 0.4, 0], PROC_MODULES.glow.radius * 1.4);
  beacon(b, glows.get('beaconA'), c.kit, [0, yTop + T.crownH, 0]);
  return { tetherY: yTop - T.tetherDrop };
}

const RIGS = { derrick, arches, tripod };

/** Drill string by kind; origin at its top, hangs down. Returns { geometry, length } */
function buildString(kit, K) {
  const S = kit.S;
  const b = new PartBuilder();
  let length = 0;
  if (K.kind === 'rotary') {
    const top = -K.swivelH;
    b.box(K.pipeR * 2.5, K.swivelH, K.pipeR * 2.5, S.hullDark, { y: -K.swivelH / 2 });
    b.cylinder(K.pipeR, K.pipeR, K.pipeLen, 10, S.teamPaint, { y: top - K.pipeLen / 2 });   // the drill pipe is team paint
    for (let i = 1; i <= K.collars; i++) b.cylinder(K.pipeR * 1.35, K.pipeR * 1.35, 0.22, 10, S.frame, { y: top - (K.pipeLen * i) / (K.collars + 1) });
    b.box(K.pipeR * 1.4, 0.8, 0.15, S.accent, { x: K.pipeR * 1.2, y: top - K.pipeLen * 0.55 });
    b.cylinder(K.pipeR * 1.1, K.pipeR * 1.1, 0.5, 10, S.teamShade, { y: top - K.pipeLen * 0.25 });
    const y1 = top - K.pipeLen;
    b.cylinder(K.bitR, 0.12, K.bitLen, 10, S.frame, { y: y1 - K.bitLen / 2 });
    for (let k = 0; k < K.teeth; k++) {
      const a = (k / K.teeth) * TAU;
      b.box(0.2, 0.45, 0.2, S.trim, { x: Math.cos(a) * K.bitR * 0.85, y: y1 - 0.2, z: Math.sin(a) * K.bitR * 0.85 });
    }
    length = K.swivelH + K.pipeLen + K.bitLen;
  } else if (K.kind === 'hammer') {
    const top = -K.swivelH;
    b.box(K.shaft * 1.5, K.swivelH, K.shaft * 1.5, S.hullDark, { y: -K.swivelH / 2 });
    b.box(K.shaft, K.pipeLen, K.shaft, S.teamPaint, { y: top - K.pipeLen / 2 });
    for (let i = 1; i <= K.flanges; i++) b.box(K.shaft * 1.7, 0.25, K.shaft * 1.7, S.frame, { y: top - (K.pipeLen * i) / (K.flanges + 1) });
    b.box(K.shaft * 1.05, 0.5, K.shaft * 1.05, S.teamShade, { y: top - K.pipeLen * 0.25 });
    const y1 = top - K.pipeLen;
    b.cylinder(K.bitR, 0.05, K.bitLen, 4, S.frame, { y: y1 - K.bitLen / 2, ry: Math.PI / 4 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: sx * K.bitR * 0.6, y: y1, z: sz * K.bitR * 0.6, h: 0.7, r: 0.16 });
    length = K.swivelH + K.pipeLen + K.bitLen;
  } else if (K.kind === 'plasma') {
    b.sphere(K.orbR, 14, 10, S.plasma, { y: -K.orbR });
    const top = -K.orbR * 2;
    b.cylinder(K.stemR, K.stemR, K.pipeLen, 10, S.trim, { y: top - K.pipeLen / 2 });
    const y1 = top - K.pipeLen;
    b.cylinder(K.coneR, 0.06, K.coneLen, 14, S.teamPaint, { y: y1 - K.coneLen / 2 });
    for (let k = 0; k < K.fins; k++) {
      const a = (k / K.fins) * TAU;
      b.box(0.08, K.coneLen * 0.8, 0.55, S.trim, { x: Math.cos(a) * K.coneR * 0.45, y: y1 - K.coneLen * 0.45, z: Math.sin(a) * K.coneR * 0.45, ry: -a });
    }
    for (let i = 1; i <= K.rings; i++) {
      const t = i / (K.rings + 1);
      b.torus(K.coneR * (1 - t) + 0.05, 0.05, 4, 20, TAU, S.neon, { rx: Math.PI / 2, y: y1 - K.coneLen * t });
    }
    b.sphere(0.2, 8, 6, S.plasma, { y: y1 - K.coneLen });
    length = K.orbR * 2 + K.pipeLen + K.coneLen;
  } else {
    b.box(K.plateW, K.plateH, K.plateW, S.teamPaint, { y: -K.plateH / 2, ry: Math.PI / 4 });
    const top = -K.plateH;
    b.cylinder(K.stemR, K.stemR, K.pipeLen, 6, S.teamPaint, { y: top - K.pipeLen / 2 });
    const y1 = top - K.pipeLen;
    const g = new THREE.OctahedronGeometry(K.size, 0);
    g.scale(1, K.stretch, 1);
    b.add(g, S.lens, { y: y1 - K.size * K.stretch });
    for (let k = 0; k < K.plates; k++) {
      const a = (k / K.plates) * TAU;
      b.box(0.5, 0.05, 0.9, S.teamPaint, { x: Math.cos(a) * K.plateR, y: y1 - K.size * K.stretch, z: Math.sin(a) * K.plateR, ry: -a });
    }
    length = K.plateH + K.pipeLen + K.size * K.stretch * 2;
  }
  return { geometry: b.build(), length };
}

/** Tether from the rig down to the string (unit length, origin at the top, scaled in Y). glow = additive layer instead of paint */
function buildTether(kit, T) {
  if (T.kind === 'cable') {
    const b = new PartBuilder();
    b.cylinder(T.r, T.r, 1, 5, kit.S.dark, { y: -0.5 });
    return { geometry: b.build(), glow: false };
  }
  const g = new GlowBuilder();
  if (T.kind === 'beam') {
    g.cylinder(T.beamR, T.beamR, 1, 12, { y: -0.5 });
    g.cylinder(T.beamCore, T.beamCore, 1, 8, { y: -0.5 });
  } else {
    g.box(T.core, 1, T.core, { y: -0.5 });
    g.box(T.halo, 1, T.halo, { y: -0.5 });
  }
  return { geometry: g.build(), glow: true };
}

/** Probe pair (two probes on the X axis, origin at the foot; the second mesh is turned by 90°) */
function buildProbes(kit, P) {
  const S = kit.S;
  const b = new PartBuilder();
  const len = PROBE.len;
  for (const e of [-1, 1]) {
    const x = e * PROBE.r;
    if (P.kind === 'piston') {
      b.box(P.w, len, P.w, S.teamPaint, { base: true, x });
      b.box(P.w * 1.6, 0.3, P.w * 1.6, S.frame, { x, y: len * 0.55 });
      spike(b, kit, { x, y: len, z: 0, h: P.tipH, r: P.tipR });
    } else if (P.kind === 'needle') {
      b.cylinder(0.05, 0.2, len, P.seg, S.teamPaint, { x, y: len / 2 });
      b.sphere(0.35, 10, 8, S.plasma, { x, y: len + 0.2 });
      b.torus(0.5, 0.05, 4, 16, TAU, S.neon, { rx: Math.PI / 2, x, y: len * 0.6 });
    } else if (P.kind === 'lance') {
      const g = new THREE.OctahedronGeometry(0.45, 0);
      g.scale(1, 3.4, 1);
      b.add(g, S.lens, { x, y: len * 0.5 + 0.5 });
      b.cylinder(0.06, 0.06, len * 0.6, P.seg, S.teamPaint, { x, y: len * 0.3 });
    } else {
      b.cylinder(0.22, 0.22, len, P.seg, S.teamPaint, { x, y: len / 2 });
      b.cylinder(0.4, 0.4, 0.35, P.seg, S.frame, { x, y: len });
      spike(b, kit, { x, y: len + 0.175, z: 0, h: 0.8, r: 0.18 });
    }
  }
  return b.build();
}

/** Static guide sleeves of the probes, at the four axis positions */
function probeSleeves(c, P, y0) {
  const { b, S } = c;
  for (const [x, z] of [[PROBE.r, 0], [-PROBE.r, 0], [0, PROBE.r], [0, -PROBE.r]]) {
    b.cylinder(PROBE.sleeveR, PROBE.sleeveR * 1.15, PROBE.sleeveH, P.seg, S.teamShade, { x, y: y0 + PROBE.sleeveH / 2, z, detail: TEAM.detail });
  }
}

// ---------------------------------------------------------------- bodies

/** One body for every style: the dimension table decides foundation, rig, extras; only a few style extras differ */
function body(c, D) {
  const { b, kit, glows } = c;
  const y0 = foundation(c, D.foundation);
  cabinet(c, D.cabinet, y0);
  probeSleeves(c, D.probe, y0);
  c.vents.push(...D.vents.map(([x, z]) => ventUnit(b, glows, kit, { x, y: y0, z, r: D.ventR })));
  if (D.tank) {   // industrial styles only (tank / pipeRun return false otherwise)
    const T = D.tank;
    const ty = y0 + T.r + T.rise;
    tank(b, kit, { x: T.x, y: ty, z: T.z, r: T.r, len: T.len, ry: Math.PI / 2, floorY: y0 });
    pipeRun(b, kit, [[T.x - T.r - 0.2, ty, T.z], [LAYOUT.bore.r + 1.2, ty, T.z], [LAYOUT.bore.r + 0.4, y0 + 0.5, -LAYOUT.bore.r]], T.pipeR);
  }
  if (D.chimney) {
    const C = D.chimney;
    chimney(b, kit, { x: C.x, y: y0, z: C.z, h: C.h, r: C.r });
    pipeRun(b, kit, [[C.x - C.r, y0 + C.h * 0.4, C.z], [LAYOUT.bore.r + 1.0, y0 + C.h * 0.4, C.z], [LAYOUT.bore.r + 0.4, y0 + 0.5, -LAYOUT.bore.r]], C.pipeR);
  }
  const rig = RIGS[D.rig.kind](c, D.rig, y0);
  const str = buildString(kit, D.string);
  c.rig = { tetherY: rig.tetherY, restY: y0 + str.length + LAYOUT.stringClearance, string: str, y0 };
}

BODIES.rounded = (c) => body(c, DIM.rounded);
BODIES.angular = (c) => body(c, DIM.angular);
BODIES.round = (c) => body(c, DIM.round);
BODIES.faceted = (c) => body(c, DIM.faceted);

// ---------------------------------------------------------------- animated helpers (no allocation in update)

/** Part sliding up and down (probes), eased or in stepped pushes; the stroke speed follows the power */
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

/** Fan (or any part) turning around Y, faster with the power */
class Turner {
  constructor(object, { speed, idle, phase = 0 }) {
    this.object = object;
    this.speed = speed;
    this.idle = idle;
    this.angle = phase;
    object.rotation.y = phase;
  }

  update(delta, power) {
    this.angle += delta * this.speed * (this.idle + (1 - this.idle) * power);
    this.object.rotation.y = this.angle;
  }
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const D = DIM[sil];
  const c = { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [], rig: null };
  BODIES[sil](c);
  const fans = c.vents.filter((v) => v.fan);
  const orbRings = c.vents.filter((v) => v.ring);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    string: c.rig.string.geometry,
    stringRestY: c.rig.restY,
    tetherY: c.rig.tetherY,
    tether: buildTether(kit, D.tether),
    probes: buildProbes(kit, D.probe),
    probeY: c.rig.y0 + PROBE.sleeveH - PROBE.insert,
    spin: D.string.spin,
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbRings.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbRings.length ? ringGeometry(kit, orbRings[0].ring.r) : null,
  };
}

const EXTRACTOR_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class OreDeepExtractorProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: EXTRACTOR_CACHE, name: 'OreDeepExtractorProc' });
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
    const A = EXTRACTOR_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.boreGlow = layer('bore', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);

    // drill string (spins, feeds into the bore) and its tether (cable / beam / laser, stretched between rig and string)
    this.stringMesh = this.paintMesh(sh.string, this, { far: true });   // far LOD: drawn instanced, frozen in its last pose
    this.stringMesh.position.y = sh.stringRestY;
    this.tetherLayer = null;
    if (sh.tether.glow) {
      this.tetherLayer = this.glowLayer(sh.tether.geometry, gc.beam, { visible: false });
      this.tetherMesh = this.tetherLayer.mesh;
    } else {
      this.tetherMesh = this.paintMesh(sh.tether.geometry);
    }
    this.tetherMesh.position.y = sh.tetherY;
    this.tetherMesh.scale.y = Math.max(sh.tetherY - sh.stringRestY, 0.01);
    this.restY = sh.stringRestY;
    this.tetherY = sh.tetherY;
    this.spinSpeed = A.spinSpeed * an.spin * sh.spin;
    this.feedSteps = an.jerk > 0 ? A.feedSteps : 0;
    this.angle = seq * 0.7;
    this.cycle = 0;       // 0..1 progress of the descent and retraction
    this.depth = 0;       // 0..1 share of A.feedDepth

    // probes: two meshes (second one turned by 90°) pump against each other
    this.sliders = [];
    const steps = an.jerk > 0 ? A.probeSteps : 0;
    for (let i = 0; i < 2; i++) {
      const mesh = this.paintMesh(sh.probes);
      mesh.position.y = sh.probeY;
      mesh.rotation.y = (i * Math.PI) / 2;
      this.sliders.push(new Slider(mesh, { baseY: sh.probeY, amp: A.probeAmp, period: A.probePeriod, idle: A.probeIdle, steps, phase: i * 0.5 + seq * 0.17 }));
    }

    this.turners = [];
    this.levitators = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanJitter;
      this.turners.push(new Turner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), idle: A.fanIdle, phase: (seq * 0.7 + i * 1.3) % TAU }));
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
   * Per-frame animation (no allocations). Idle: the string rests above the bore, probes stand still, glow dim, beacons burn.
   * Active (mining): the string spins and sinks into the bore and back (stepped pushes when jerky, plus a percussion
   * jolt), the tether stretches with it, probes pump, bore / rig glow at full, fans and radiators run up, beacons blink.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = EXTRACTOR_ANIM;
    const dt = delta;   // already scaled by animScale in tick(); no power:everything stands still (the string keeps its pose)
    this.time += dt;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);

    if (active) this.cycle = (this.cycle + dt / A.feedPeriod) % 1;
    const tri = this.cycle < 0.5 ? this.cycle * 2 : 2 - this.cycle * 2;
    const wave = this.feedSteps > 0 ? steppedEase(tri, this.feedSteps) : smootherstep(tri);
    this.depth += ((active ? wave : 0) - this.depth) * Math.min(1, delta * A.feedFollow);
    const jolt = an.jerk > 0 ? Math.sin(this.time * TAU * A.hammerHz) * A.hammerAmp * an.jerk * this.power : 0;
    const y = this.restY - this.depth * A.feedDepth + jolt;
    this.stringMesh.position.y = y;
    this.angle += dt * this.spinSpeed * this.power;
    this.stringMesh.rotation.y = this.angle;
    this.tetherMesh.scale.y = Math.max(this.tetherY - y, 0.01);

    for (let i = 0; i < this.sliders.length; i++) this.sliders[i].update(dt, this.power);
    for (let i = 0; i < this.turners.length; i++) this.turners[i].update(dt, this.power);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(dt, active);

    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * this.power);
    this.pulseGlow?.setIntensity(glow);
    this.boreGlow?.setIntensity(glow * this.power);
    this.tetherLayer?.setIntensity(this.power * pulseWave(this.time, an.pulse));
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.blink.update(dt, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
