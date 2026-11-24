// Steel Men – procedural CrewTrainingFacility (training centre of a style without its own GLB; roadmap 18, phase B). A drop-in alternative to
// models/3DStructuresX/CrewTrainingFacilityX_Anim.glb (the only GLB; every style gets this model) built in code from the
// style modules (ProcModules.js):
//   • footprint inside the GLB's (about 29.7 × 38.8 → pad ±14 × ±18, front = +Z = the drill yard, the hall is at the back)
//   • role: a training hall at the back (hangar door, windows, roof vents) and an open drill yard in front with an obstacle
//     course (climb wall, hurdles), two turning simulator rigs, a row of pop-up targets and a watch tower / pylon
//   • body per style.silhouette: rounded = styled hall, centrifuge arms, board targets · angular = armoured sloped hall with
//     spikes and buttresses, heavy arms · round = domed ellipse hall, plasma orb gyros, floating spheres, plasma pylon ·
//     faceted = detached laser-linked blocks, crystal rigs, holographic diamonds, laser barrier
//   • animation: simulator rigs turn (fast and brighter while the building is active, stepped when style.anim.jerk > 0),
//     the targets rise, hold and sink in cycles while active, vent unit (fan / radiator heat / plasma orb ring), beacons blink
//   • 1 merged static mesh (LODs) + emblem decals (1 draw call) + glow layers + 2 rigs + 1 target row + vent parts
// Visual only: update() takes the frame delta. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Blinker, Spinner, plateau } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, chimney, laserLink, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
  teamPanel, teamTrim, teamBanner, roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const CREW_ANIM = {
  powerEase: 1.2,         // 1/s – how fast the building spins up / down
  rigSpeed: 1.3,          // rad/s of the simulator rigs at work (× style.anim.spin)
  rigIdle: 0.12,          // share of the work speed while idle
  jerkTicks: 10,          // ticks per revolution when style.anim.jerk > 0 (stepped turning)
  targetCycle: 3.4,       // s – one rise / hold / sink cycle of the targets while active
  targetEdge: 0.22,       // share of the cycle for rising / sinking
  jerkSteps: 4,           // target height levels when style.anim.jerk > 0
  idleGlow: 0.35,         // glow share while idle
  fanSpeed: 3.6,          // rad/s (× style.anim.spin)
  fanSpeedJitter: 0.25,
  fanEase: 1.5,           // 1/s – fan speed damping
  liftEase: 4,            // 1/s – how fast the targets follow their goal height
  rigPhaseStep: 0.5,      // rad – start angle offset of the rigs per instance
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – phase offset per instance
  heatIdle: 0.25,         // radiator glow share while idle
};

/** Shared layout (model units, GLB scale; front = +Z, footprint ±14 × ±18) */
const LAYOUT = {
  padHalfX: 14, padHalfZ: 18, padH: 0.25, padSegments: 48,
  hallZ: -12, hallD: 12, hallHalfW: 12.5,
  neonMin: 0.3,                                  // style.neon from which bands get a neon line
  band: { h: 0.45, t: 0.05, y: 0.9 }, neonBand: { h: 0.12, t: 0.05, y: 5.0 },
  door: { w: 5.6, h: 4.4, frameW: 6.4, frameH: 5.0, frameD: 0.5, interiorD: 0.1, interiorOut: 0.1 },
  decalSize: 3.2, frontDecalSize: 2.6,
  vent: { r: 1.4 },
  rigs: { x: 8.5, z: 4.0, mastH: 2.6, mastR: 0.5, baseR: 2.2, baseH: 0.6 },
  course: { wallZ: -3.0, wallW: 6, wallH: 2.6, wallT: 0.6, hurdleZ: [0.5, 4.0], hurdleW: 5, hurdleH: 0.9, hurdleT: 0.5 },
  targets: { z: 14.5, xs: [-8.75, -5.25, -1.75, 1.75, 5.25, 8.75], stalkH: 1.0, stalkR: 0.12, w: 1.4, h: 2.0, t: 0.15, eye: 0.6, sink: 3.2, stripW: 20, stripD: 1.2, stripH: 0.3 },
  tower: {
    x: 12.2, z: -3.4,
    cab: { poleW: 1.8, poleH: 8, cabW: 3.6, cabH: 2.0, winH: 0.9, winY: 1.0, winOut: 0.01, winT: 0.06, bandH: 0.25, bandY: 0.4, bandOver: 0.2, spikeOff: 1.7, spikeH: 0.9, spikeR: 0.25, beaconY: 10.0 },
    pylon: { rTop: 0.7, rBottom: 1.4, h: 9, segments: 14, ringY: 6, ringR: 1.0, ringTube: 0.1, orbY: 10, orbR: 1.0, haloR: 1.5, beaconY: 11.2 },
    laser: { w: 1.6, topW: 0.6, h: 10, lensS: 1.3, lensY: 10.6, beamDx: -4.5, beamDy: -6.6, beamDz: 4.5, beaconY: 11.2 },
  },
  yardMark: { z: 16.5, len: 24, h: 0.6 },
  corners: [[-13, 17], [13, 17]],
};

/** Dimensions of the bodies by style.silhouette (code knows shapes, the style data picks one; unknown → rounded) */
const SHAPES = {
  rounded: {
    hall: { w: 25, h: 7, d: 12 }, top: { w: 16, h: 2, d: 7, z: -13.5 },
    win: { y: 3.2, w: 2.4, h: 1.4, xs: [-10, -6, 6, 10], frame: 0.12, t: 0.06 },
    decals: { frontX: 8, frontY: 5.4, sideY: 3.6 },
    vents: [[-10.5, -12], [10.5, -12]],
    rig: 'arm', target: 'board', idleLift: 0, tower: 'cab',
  },
  angular: {
    hall: { w: 25, topW: 21, h: 7.5, d: 12, topD: 9.5 },
    buttress: { w: 1.4, h: 6, d: 1.4, xs: [-11.2, -6.9, 6.9, 11.2] },
    parapet: { t: 0.5, h: 0.9, spikeH: 1.2, spikeR: 0.3, mids: [-6, 0, 6] },
    decals: { frontX: 9.0, frontY: 4.6, sideY: 4.0 },
    vents: [[-8, -11], [8, -11]], chimneys: [[-9.5, -15], [9.5, -15]], chimney: { h: 5, r: 0.8 },
    rig: 'arm', target: 'board', idleLift: 0, tower: 'cab',
  },
  round: {
    hall: { a: 12.5, b: 6, drumH: 4.0, domeH: 3.4, segments: 48, rings: 12 },
    neonRing: { y: 3.0, h: 0.3, out: 0.05 },
    door: { zOut: 0.25 },
    veins: { count: 24, skipFront: 20, skipDecal: 14, w: 0.08, h: 2.2, t: 0.06, y: 2.2, out: 0.04 },   // degrees
    decals: { angles: [-90, -35, 35, 90, 180], y: 2.6, size: 3.0 },
    vents: [[-8, -12], [8, -12]],
    rig: 'orbit', target: 'sphere', idleLift: 0.4, tower: 'pylon',
  },
  faceted: {
    center: { w: 9, topW: 5, h: 8, d: 10, topD: 7 },
    wing: { x: 9.5, w: 6, topW: 3, h: 5.5, d: 9, topD: 5, ventR: 1.1, neonH: 0.12 },
    lasers: { y: [2.0, 4.0], thickness: 0.06 },
    posts: { r: 0.22, rBottom: 0.4, h: 4.4, lensR: 0.28, ys: [0.9, 2.4, 3.9], list: [[-13.5, 17.5], [0, 17.5], [13.5, 17.5], [-13.5, 8], [13.5, 8]], links: [[0, 1], [1, 2], [0, 3], [2, 4]] },
    decals: { frontY: 5.8, sideY: 4.2 },
    rig: 'crystal', target: 'diamond', idleLift: 0.4, tower: 'laser',
  },
};

/**
 * Team paint layout (docs/notes/proc-teampaint-b.md). Big coloured areas are whole surfaces painted S.teamPaint / S.teamShade
 * (one main volume per body + a drill-yard inlay whose outline follows the silhouette); kit modules (panels, trim, mark,
 * banner) add the style's look. Static geometry only (no draw calls).
 */
const TEAM = {
  inlayH: 0.05,   // thickness of the yard inlay (stands on the pad top)
  inlay: {        // outline by silhouette: rectangle · ellipse · rhombus (angular: the painted hall is enough)
    rounded: { kind: 'rect', z: 3, w: 23.6, d: 18 },
    round: { kind: 'ellipse', z: 3.5, w: 24, d: 16, segments: 40 },
    faceted: { kind: 'rhombus', z: 5, w: 28, d: 22 },
  },
  rounded: { side: { dz: 3.8, y: 3.5, w: 2.4, h: 3.2 }, mark: { z: -8, w: 16, d: 3 }, trimInset: 0.8, banner: { x: -11, z: -16.5, h: 4 } },
  angular: { banner: { x: 0, z: -12, h: 4 } },
  round: { banner: { x: -11, z: 10, h: 4 } },
  faceted: { banner: { x: -12.2, z: -3.4, h: 5 } },
};

/** Moving parts (shared geometry per style): rig = turning simulator, targets = pop-up row */
const PARTS = {
  arm: { len: 7, w: 0.5, d: 0.8, hubR: 0.7, hubH: 1.6, cab: 1.4, weight: 1.6 },
  orbit: { r: 2.2, tube: 0.16, orbR: 0.9, cabR: 0.5 },
  crystal: { size: 1.1, stretch: 2.0, blades: 4, bladeLen: 3.6, bladeW: 0.6, bladeT: 0.12, tipR: 0.2 },
};

const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const decal = (c, position, normal, size) => c.decals.push({ position, normal, size });

// ---------------------------------------------------------------- static parts

/** Hangar door: frame (front face at zFront, depth `depth` – deeper where the wall leans) + glowing interior + marking above */
function hangarDoor(c, y, zFront, depth = LAYOUT.door.frameD) {
  const { b, S, kit } = c;
  const D = LAYOUT.door;
  b.box(D.frameW, D.frameH, depth, S.frame, { base: true, y, z: zFront - depth / 2 });
  b.box(D.w, D.h, D.interiorD, S.interior, { base: true, y, z: zFront + D.interiorD / 2 });
  marking(b, kit, D.frameW, 0.5, { y: y + D.frameH + 0.3, z: zFront - 0.1 });
}

function bands(c, hw, backZ, zc, d, y) {
  const { b, S, kit } = c;
  const L = LAYOUT;
  for (const sx of [-1, 1]) b.box(L.band.t, L.band.h, d * 0.95, S.team, { x: sx * (hw + L.band.t / 2), y, z: zc });
  b.box(hw * 2 * 0.98, L.band.h, L.band.t, S.team, { y, z: backZ - L.band.t / 2 });
  if (kit.style.neon >= L.neonMin) {
    const ny = y + L.neonBand.y - L.band.y;
    for (const sx of [-1, 1]) neonStrip(b, kit, L.neonBand.t, L.neonBand.h, d * 0.95, { x: sx * (hw + L.neonBand.t / 2), y: ny, z: zc });
    neonStrip(b, kit, hw * 2 * 0.98, L.neonBand.h, L.neonBand.t, { y: ny, z: backZ - L.neonBand.t / 2 });
  }
}

/** Obstacle course (centre of the yard): climb wall with a team stripe + hurdles with markings */
function obstacleCourse(c, y0) {
  const { b, S, kit } = c;
  const K = LAYOUT.course;
  const heavy = kit.style.silhouette === 'angular';
  const s = heavy ? S.hullDark : S.frame;
  b.box(K.wallW, K.wallH, K.wallT, s, { base: true, y: y0, z: K.wallZ });
  b.box(K.wallW * 0.9, 0.3, K.wallT + 0.04, S.team, { y: y0 + K.wallH * 0.55, z: K.wallZ });
  marking(b, kit, K.wallW * 0.9, 0.4, { y: y0 + K.wallH * 0.2, z: K.wallZ + K.wallT / 2 + 0.02 });
  for (const z of K.hurdleZ) {
    b.box(K.hurdleW, K.hurdleH, K.hurdleT, s, { base: true, y: y0, z });
    b.box(K.hurdleW * 0.96, 0.15, K.hurdleT + 0.04, S.team, { y: y0 + K.hurdleH * 0.8, z });
    marking(b, kit, K.hurdleW * 0.8, 0.3, { y: y0 + K.hurdleH * 0.35, z: z + K.hurdleT / 2 + 0.02 });
  }
}

/** Mast + base ring of the two simulator rigs, strip under the pop-up targets, hazard edge of the yard */
function yardFixtures(c, y0) {
  const { b, S, kit } = c;
  const R = LAYOUT.rigs;
  const T = LAYOUT.targets;
  for (const sx of [-1, 1]) {
    b.cylinder(R.baseR, R.baseR * 1.1, R.baseH, 24, S.hullDark, { x: sx * R.x, y: y0 + R.baseH / 2, z: R.z });
    b.cylinder(R.mastR, R.mastR * 1.3, R.mastH - R.baseH, 10, S.frame, { x: sx * R.x, y: y0 + R.baseH + (R.mastH - R.baseH) / 2, z: R.z });
    if (kit.style.neon >= LAYOUT.neonMin) b.torus(R.baseR * 0.85, 0.08, 4, 24, TAU, S.neon, { rx: Math.PI / 2, x: sx * R.x, y: y0 + R.baseH + 0.02, z: R.z });
  }
  b.box(T.stripW, T.stripH, T.stripD, S.hullDark, { base: true, y: y0, z: T.z });
  marking(b, kit, T.stripW, T.stripH * 0.9, { y: y0 + T.stripH / 2, z: T.z + T.stripD / 2 + 0.02 });
  marking(b, kit, LAYOUT.yardMark.len, LAYOUT.yardMark.h, { rx: -Math.PI / 2, y: y0 + 0.02, z: LAYOUT.yardMark.z });
}

/** Watch tower (cab) / plasma pylon / laser pylon at the right edge of the yard */
function tower(c, kind, y0) {
  const { b, S, kit, glows } = c;
  const { x, z } = LAYOUT.tower;
  const T = LAYOUT.tower[kind] ?? LAYOUT.tower.cab;
  if (kind === 'pylon') {
    b.cylinder(T.rTop, T.rBottom, T.h, T.segments, S.hull, { x, y: y0 + T.h / 2, z });
    b.torus(T.ringR, T.ringTube, 4, 20, TAU, S.neon, { rx: Math.PI / 2, x, y: y0 + T.ringY, z });
    b.sphere(T.orbR, 16, 10, S.plasma, { x, y: y0 + T.orbY, z });
    glows.get('pulse').sphere(T.haloR, 12, 8, { x, y: y0 + T.orbY, z });
  } else if (kind === 'laser') {
    b.taperedBox(T.w, T.topW, T.h, T.w, S.hullDark, { x, y: y0, z, ry: Math.PI / 4 });
    b.box(T.lensS, T.lensS, T.lensS, S.lens, { x, y: y0 + T.lensY, z, ry: Math.PI / 4, rx: Math.PI / 4 });
    glows.get('laser').segment([x, y0 + T.lensY, z], [x + T.beamDx, y0 + T.lensY + T.beamDy, z + T.beamDz], PROC_MODULES.laser.thickness);
  } else {
    const heavy = kit.style.silhouette === 'angular';
    const half = T.cabW / 2;
    b.box(T.poleW, T.poleH, T.poleW, heavy ? S.hullDark : S.frame, { base: true, x, y: y0, z });
    styledBox(b, kit, T.cabW, T.cabH, T.cabW, S.hull, { base: true, x, y: y0 + T.poleH, z });
    b.box(T.cabW - 0.1, T.winH, T.winT, S.window, { x, y: y0 + T.poleH + T.winY, z: z + half + T.winOut });
    b.box(T.cabW - 0.1, T.winH, T.winT, S.window, { x: x - half - T.winOut, y: y0 + T.poleH + T.winY, z, ry: Math.PI / 2 });
    b.box(T.cabW + T.bandOver, T.bandH, T.cabW + T.bandOver, S.team, { x, y: y0 + T.poleH + T.bandY, z });
    if (heavy) for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: x + sx * T.spikeOff, y: y0 + T.beaconY, z: z + sz * T.spikeOff, h: T.spikeH, r: T.spikeR });
  }
  beacon(b, glows.get('beaconA'), kit, [x, y0 + T.beaconY, z]);
}

/** Team-painted drill-yard floor (shape by silhouette; none for a silhouette without an entry) */
function yardInlay(c, sil, y0) {
  const I = TEAM.inlay[sil];
  if (!I) return;
  const { b, S } = c;
  const t = { y: y0 + TEAM.inlayH / 2, z: I.z, detail: 2 };
  if (I.kind === 'ellipse') b.cylinder(1, 1, TEAM.inlayH, I.segments, S.teamShade, { ...t, sx: I.w / 2, sz: I.d / 2 });
  else if (I.kind === 'rhombus') {
    const g = new THREE.BoxGeometry(1, TEAM.inlayH, 1);
    g.rotateY(Math.PI / 4);
    g.scale(I.w / Math.SQRT2, 1, I.d / Math.SQRT2);
    b.add(g, S.teamShade, t);
  } else b.box(I.w, TEAM.inlayH, I.d, S.teamShade, t);
}

const BODIES = {};

/** rounded: styled hall with a stepped top, windows, hangar door and roof fans */
BODIES.rounded = (c) => {
  const D = SHAPES.rounded;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const y0 = L.padH;
  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.ground, { base: true });
  const H = D.hall;
  const front = L.hallZ + H.d / 2;
  styledBox(b, kit, H.w, H.h, H.d, S.hull, { base: true, y: y0, z: L.hallZ });
  styledBox(b, kit, D.top.w, D.top.h, D.top.d, S.teamPaint, { base: true, y: y0 + H.h, z: D.top.z, detail: 2 });   // team-painted upper block
  const roof = y0 + H.h;
  bands(c, H.w / 2, L.hallZ - H.d / 2, L.hallZ, H.d, y0 + L.band.y);
  const Tm = TEAM.rounded;
  for (const sx of [-1, 1]) {
    for (const e of [-1, 1]) teamPanel(b, kit, Tm.side.w, Tm.side.h, { x: sx * H.w / 2, y: y0 + Tm.side.y, z: L.hallZ + e * Tm.side.dz, ry: sx * Math.PI / 2 });
  }
  roofMark(b, kit, { x: 0, y: roof, z: Tm.mark.z, w: Tm.mark.w, d: Tm.mark.d });
  teamTrim(b, kit, { x: 0, y: roof, z: L.hallZ, w: H.w - 2 * Tm.trimInset, d: H.d - 2 * Tm.trimInset });
  teamBanner(b, kit, { x: Tm.banner.x, y: roof, z: Tm.banner.z, h: Tm.banner.h });
  const W = D.win;
  for (const x of W.xs) {
    b.box(W.w + W.frame, W.h + W.frame, W.t, S.frame, { x, y: y0 + W.y, z: front + W.t / 2 });
    b.box(W.w, W.h, W.t, S.window, { x, y: y0 + W.y, z: front + W.t });
  }
  hangarDoor(c, y0, front + 0.3);
  for (const sx of [-1, 1]) {
    decal(c, [sx * D.decals.frontX, y0 + D.decals.frontY, front], [0, 0, 1], L.frontDecalSize);
    decal(c, [sx * H.w / 2, y0 + D.decals.sideY, L.hallZ], [sx, 0, 0], L.decalSize);
  }
  decal(c, [0, y0 + D.decals.sideY, L.hallZ - H.d / 2], [0, 0, -1], L.decalSize);
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: roof, z, r: L.vent.r }));
  for (const sx of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [sx * (H.w / 2 - 0.6), roof, front - 0.6]);
};

/** angular: armoured sloped hall, buttresses, spiked parapet, chimneys */
BODIES.angular = (c) => {
  const D = SHAPES.angular;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const y0 = L.padH;
  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.ground, { base: true });
  const H = D.hall;
  const front = L.hallZ + H.d / 2;
  const back = L.hallZ - H.d / 2;
  b.taperedBox(H.w, H.topW, H.h, H.d, S.teamPaint, { y: y0, z: L.hallZ, detail: 2 }, H.topD);   // the whole armoured hall is team paint
  b.box(H.w, 0.6, H.d, S.lower, { base: true, y: y0, z: L.hallZ });
  const roof = y0 + H.h;
  teamBanner(b, kit, { x: TEAM.angular.banner.x, y: roof, z: TEAM.angular.banner.z, h: TEAM.angular.banner.h });
  const leanX = (H.w - H.topW) / 2;
  const leanZ = (H.d - H.topD) / 2;
  const tiltX = Math.atan2(leanX, H.h);
  const tiltZ = Math.atan2(leanZ, H.h);
  const wallX = (y) => H.w / 2 - (leanX * y) / H.h;
  const wallFront = (y) => front - (leanZ * y) / H.h;
  const wallBack = (y) => back + (leanZ * y) / H.h;
  for (const sx of [-1, 1]) {
    b.box(0.06, 0.5, 8, S.window, { x: sx * (wallX(3.0) + 0.03), y: y0 + 3.0, z: L.hallZ, rz: sx * tiltX });
    b.box(0.06, 0.45, 9, S.team, { x: sx * (wallX(1.3) + 0.03), y: y0 + 1.3, z: L.hallZ, rz: sx * tiltX });
    decal(c, [sx * wallX(D.decals.sideY + 1.0), y0 + D.decals.sideY + 1.0, L.hallZ + 3.5], [sx * Math.cos(tiltX), Math.sin(tiltX), 0], L.decalSize);
    decal(c, [sx * D.decals.frontX, y0 + D.decals.frontY, wallFront(D.decals.frontY)], [0, Math.sin(tiltZ), Math.cos(tiltZ)], L.frontDecalSize);
  }
  decal(c, [0, y0 + D.decals.sideY, wallBack(D.decals.sideY)], [0, Math.sin(tiltZ), -Math.cos(tiltZ)], L.decalSize);
  b.box(H.w * 0.9, 0.45, 0.06, S.team, { y: y0 + 1.3, z: wallFront(1.3) + 0.03 });
  hangarDoor(c, y0, front + 0.1, 1.4);
  const Bt = D.buttress;
  for (const x of Bt.xs) {
    b.box(Bt.w, Bt.h, Bt.d, S.hullDark, { base: true, x, y: y0, z: front - Bt.d / 2 + 0.2 });
    b.box(Bt.w * 1.5, 0.4, Bt.d * 1.5, S.frame, { base: true, x, y: y0, z: front - Bt.d / 2 + 0.2 });
  }
  const P = D.parapet;
  const pw = H.topW;
  const pd = H.topD;
  for (const s of [-1, 1]) {
    b.box(P.t, P.h, pd, S.hullDark, { base: true, x: s * (pw / 2 - P.t / 2), y: roof, z: L.hallZ });
    b.box(pw, P.h, P.t, S.hullDark, { base: true, y: roof, z: L.hallZ + s * (pd / 2 - P.t / 2) });
    for (const e of [-1, 1]) spike(b, kit, { x: s * pw / 2, y: roof + P.h, z: L.hallZ + e * pd / 2, h: P.spikeH, r: P.spikeR });
    for (const m of P.mids) spike(b, kit, { x: m, y: roof + P.h, z: L.hallZ + s * pd / 2, h: P.spikeH * 0.7, r: P.spikeR });
  }
  for (const [x, z] of D.vents) c.vents.push(ventUnit(b, glows, kit, { x, y: roof, z, r: L.vent.r }));
  for (const [x, z] of D.chimneys) chimney(b, kit, { x, y: roof, z, h: D.chimney.h, r: D.chimney.r });
  for (const sx of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [sx * (pw / 2 - 1.0), roof + P.h, L.hallZ + pd / 2 - 1.0]);
};

/** round: elliptical drum and dome, neon ring, plasma orbs on the roof, plasma pylon */
BODIES.round = (c) => {
  const D = SHAPES.round;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const y0 = L.padH;
  b.cylinder(1, 1, L.padH, L.padSegments, S.ground, { y: L.padH / 2, sx: L.padHalfX, sz: L.padHalfZ });
  const H = D.hall;
  const cz = L.hallZ;
  b.cylinder(1, 1, H.drumH, H.segments, S.hull, { y: y0 + H.drumH / 2, z: cz, sx: H.a, sz: H.b });
  b.add(new THREE.SphereGeometry(1, H.segments, H.rings, 0, TAU, 0, Math.PI / 2), S.teamPaint, { y: y0 + H.drumH, z: cz, sx: H.a, sy: H.domeH, sz: H.b, detail: 2 });   // team-painted dome
  teamBanner(b, kit, { x: TEAM.round.banner.x, y: y0, z: TEAM.round.banner.z, h: TEAM.round.banner.h });
  const N = D.neonRing;
  b.cylinder(1, 1, N.h, H.segments, S.neon, { y: y0 + N.y, z: cz, sx: H.a + N.out, sz: H.b + N.out }, true);
  const peak = y0 + H.drumH + H.domeH;
  // hangar door at the front of the ellipse
  const front = cz + H.b;
  hangarDoor(c, y0, front + D.door.zOut);
  for (const deg of D.decals.angles) {
    const t = (deg * Math.PI) / 180;
    const nx = Math.sin(t) / H.a;
    const nz = Math.cos(t) / H.b;
    const len = Math.hypot(nx, nz);
    decal(c, [H.a * Math.sin(t), y0 + D.decals.y, cz + H.b * Math.cos(t)], [nx / len, 0, nz / len], D.decals.size);
  }
  if (kit.rich) {
    const V = D.veins;
    for (let i = 0; i < V.count; i++) {
      const t = (i / V.count) * TAU;
      const deg = wrapDeg((t * 180) / Math.PI);
      if (Math.abs(deg) < V.skipFront || D.decals.angles.some((a) => Math.abs(wrapDeg(deg - a)) < V.skipDecal)) continue;
      neonStrip(b, kit, V.w, V.h, V.t, { x: (H.a + V.out) * Math.sin(t), y: y0 + V.y, z: cz + (H.b + V.out) * Math.cos(t), ry: t });
    }
  }
  for (const [x, z] of D.vents) {   // orbs / vents sit on the dome surface at their spot
    const k = Math.sqrt(Math.max(0, 1 - (x / H.a) ** 2 - ((z - cz) / H.b) ** 2));
    c.vents.push(ventUnit(b, glows, kit, { x, y: y0 + H.drumH + H.domeH * k, z, r: L.vent.r }));
  }
  for (const sx of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [sx * (H.a - 1.5), y0, cz + H.b + 0.5]);
};

/** faceted: detached blocks tied by lasers, radiator wings, laser barrier posts around the yard */
BODIES.faceted = (c) => {
  const D = SHAPES.faceted;
  const L = LAYOUT;
  const { b, S, kit, glows } = c;
  const laser = glows.get('laser');
  const y0 = L.padH;
  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.ground, { base: true });
  const C = D.center;
  const front = L.hallZ + C.d / 2;
  b.taperedBox(C.w, C.topW, C.h, C.d, S.hull, { y: y0, z: L.hallZ }, C.topD);
  const top = y0 + C.h;
  teamBanner(b, kit, { x: TEAM.faceted.banner.x, y: y0, z: TEAM.faceted.banner.z, h: TEAM.faceted.banner.h });
  b.box(3.2, 1.0, 3.2, S.hullDark, { y: top + 0.5, z: L.hallZ, ry: Math.PI / 4 });
  neonStrip(b, kit, 3.4, 0.12, 3.4, { y: top + 1.06, z: L.hallZ, ry: Math.PI / 4 });
  spike(b, kit, { x: 0, y: top + 1.0, z: L.hallZ, h: 3.0, r: 0.5 });
  const leanX = (C.w - C.topW) / 2;
  const leanZ = (C.d - C.topD) / 2;
  const tiltX = Math.atan2(leanX, C.h);
  const tiltZ = Math.atan2(leanZ, C.h);
  const wallFront = (y) => front - (leanZ * y) / C.h;
  const wallBack = (y) => L.hallZ - C.d / 2 + (leanZ * y) / C.h;
  hangarDoor(c, y0, front + 0.1, 1.8);
  decal(c, [0, y0 + D.decals.frontY, wallFront(D.decals.frontY)], [0, Math.sin(tiltZ), Math.cos(tiltZ)], L.frontDecalSize);
  decal(c, [0, y0 + D.decals.sideY, wallBack(D.decals.sideY)], [0, Math.sin(tiltZ), -Math.cos(tiltZ)], L.decalSize);
  const Wg = D.wing;
  for (const sx of [-1, 1]) {
    b.taperedBox(Wg.w, Wg.topW, Wg.h, Wg.d, S.teamPaint, { x: sx * Wg.x, y: y0, z: L.hallZ, detail: 2 }, Wg.topD);   // team-painted wings
    neonStrip(b, kit, Wg.neonH, Wg.neonH, Wg.topD, { x: sx * Wg.x, y: y0 + Wg.h + Wg.neonH / 2, z: L.hallZ });
    c.vents.push(ventUnit(b, glows, kit, { x: sx * Wg.x, y: y0 + Wg.h, z: L.hallZ, r: Wg.ventR }));
    const outer = Wg.x + Wg.w / 2 - ((Wg.w - Wg.topW) / 2) * (D.decals.sideY / Wg.h);
    const wt = Math.atan2((Wg.w - Wg.topW) / 2, Wg.h);
    decal(c, [sx * outer, y0 + D.decals.sideY, L.hallZ], [sx * Math.cos(wt), Math.sin(wt), 0], L.decalSize);
    // lasers tying the wing to the centre block
    for (const y of D.lasers.y) {
      const blockX = C.w / 2 - (leanX * y) / C.h;
      const inner = Wg.x - Wg.w / 2 + (((Wg.w - Wg.topW) / 2) * y) / Wg.h;
      for (const z of [-2.5, 2.5]) laserLink(b, laser, kit, [sx * (blockX + 0.1), y0 + y, L.hallZ + z], [sx * (inner - 0.1), y0 + y, L.hallZ + z]);
    }
  }
  // laser barrier around the yard
  const Po = D.posts;
  for (const [x, z] of Po.list) {
    b.cylinder(Po.r, Po.rBottom, Po.h, 6, S.hullDark, { x, y: y0 + Po.h / 2, z });
    b.sphere(Po.lensR, 8, 6, S.lens, { x, y: y0 + Po.h, z });
  }
  for (const [i, j] of Po.links) {
    for (const y of Po.ys) laser.segment([Po.list[i][0], y0 + y, Po.list[i][1]], [Po.list[j][0], y0 + y, Po.list[j][1]], D.lasers.thickness);
  }
  for (const sx of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [sx * (Wg.x + 1.0), y0, front + 0.5]);
};

// ---------------------------------------------------------------- moving parts

/** Simulator rig (turns around Y, origin at the pivot) by shape.rig */
function buildRig(kit, kind) {
  const S = kit.S;
  const b = new PartBuilder();
  if (kind === 'orbit') {
    const P = PARTS.orbit;
    b.sphere(P.orbR, 14, 10, S.plasma);
    b.torus(P.r, P.tube, 6, 28, TAU, S.trim, {});
    b.torus(P.r, P.tube, 6, 28, TAU, S.trim, { ry: Math.PI / 2 });
    b.sphere(P.cabR, 10, 8, S.lens, { x: P.r });
  } else if (kind === 'crystal') {
    const P = PARTS.crystal;
    const g = new THREE.OctahedronGeometry(P.size, 0);
    g.scale(1, P.stretch, 1);
    b.add(g, S.plasma);
    for (let i = 0; i < P.blades; i++) {
      const a = (i / P.blades) * TAU;
      b.box(P.bladeLen, P.bladeT, P.bladeW, S.hullDark, { x: Math.cos(a) * P.bladeLen / 2, z: Math.sin(a) * P.bladeLen / 2, ry: -a });
      b.box(P.tipR * 2, P.tipR * 2, P.tipR * 2, S.lens, { x: Math.cos(a) * P.bladeLen, z: Math.sin(a) * P.bladeLen, ry: -a + Math.PI / 4 });
    }
  } else {
    const P = PARTS.arm;
    const heavy = kit.style.silhouette === 'angular';
    b.cylinder(P.hubR, P.hubR * 1.15, P.hubH, 12, S.frame);
    b.box(P.len, P.w * (heavy ? 1.5 : 1), P.d, heavy ? S.hullDark : S.accent, { y: 0.1 });
    b.box(P.cab, P.cab * 0.85, P.cab, S.hull, { x: P.len / 2, y: -0.1 });
    b.box(P.cab * 0.9, P.cab * 0.4, 0.06, S.window, { x: P.len / 2, y: 0, z: P.cab / 2 + 0.03 });
    b.box(P.weight, P.weight, P.weight, S.hullDark, { x: -P.len / 2 + P.weight / 2 });
    b.box(P.cab * 0.5, 0.2, P.cab * 1.05, S.team, { x: P.len / 2, y: P.cab * 0.5 });
    if (heavy) spike(b, kit, { x: P.len / 2 + P.cab / 2, y: 0.2, z: 0, h: 0.9, r: 0.25 });
  }
  return b.build();
}

/** Pop-up target row (centred at x = 0, base of the stalks at y = 0) by shape.target */
function buildTargets(kit, kind) {
  const S = kit.S;
  const T = LAYOUT.targets;
  const b = new PartBuilder();
  for (const x of T.xs) {
    if (kind === 'sphere') {
      b.cylinder(T.stalkR * 0.7, T.stalkR, T.stalkH + T.h * 0.4, 8, S.frame, { x, y: (T.stalkH + T.h * 0.4) / 2 });
      b.sphere(T.w * 0.55, 14, 10, S.plasma, { x, y: T.stalkH + T.h / 2 });
      b.torus(T.w * 0.75, 0.05, 4, 20, TAU, S.neon, { rx: Math.PI / 2, x, y: T.stalkH + T.h / 2 });
    } else if (kind === 'diamond') {
      b.cylinder(T.stalkR * 0.5, T.stalkR * 0.8, T.stalkH, 6, S.hullDark, { x, y: T.stalkH / 2 });
      b.box(T.w, T.w, T.t, S.lens, { x, y: T.stalkH + T.h / 2, rz: Math.PI / 4 });
      b.box(T.w * 0.5, T.w * 0.5, T.t + 0.04, S.neon, { x, y: T.stalkH + T.h / 2, rz: Math.PI / 4 });
    } else {
      b.cylinder(T.stalkR, T.stalkR, T.stalkH, 8, S.frame, { x, y: T.stalkH / 2 });
      b.box(T.w, T.h, T.t, S.team, { x, y: T.stalkH + T.h / 2 });
      b.box(T.eye, T.eye, T.t + 0.04, S.accent, { x, y: T.stalkH + T.h / 2 });
      b.box(T.eye * 0.4, T.eye * 0.4, T.t + 0.08, S.dark, { x, y: T.stalkH + T.h / 2 });
    }
  }
  return b.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const D = SHAPES[sil];
  const y0 = LAYOUT.padH;
  const c = { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], vents: [] };
  BODIES[sil](c);
  yardInlay(c, sil, y0);
  yardFixtures(c, y0);
  obstacleCourse(c, y0);
  tower(c, D.tower, y0);
  for (const [x, z] of LAYOUT.corners) beacon(c.b, c.glows.get('beaconA'), kit, [x, y0, z]);
  const fans = c.vents.filter((v) => v.fan);
  const orbs = c.vents.filter((v) => v.ring);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    rig: buildRig(kit, D.rig),
    targets: buildTargets(kit, D.target),
    idleLift: D.idleLift,
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    orbSpots: orbs.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    orbRing: orbs.length ? ringGeometry(kit, orbs[0].ring.r) : null,
  };
}

const CREW_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class CrewTrainingFacilityProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CREW_CACHE, name: 'CrewTrainingFacilityProc' });
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
    const A = CREW_ANIM;
    const L = LAYOUT;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);

    // simulator rigs (counter-rotating), pop-up targets
    this.rigs = [];
    this.rigAngles = [seq * A.rigPhaseStep, seq * A.rigPhaseStep + Math.PI];
    for (const sx of [-1, 1]) {
      const mesh = this.paintMesh(sh.rig);
      mesh.position.set(sx * L.rigs.x, L.padH + L.rigs.mastH + 0.2, L.rigs.z);
      this.rigs.push(mesh);
    }
    this.targets = this.paintMesh(sh.targets);
    this.targetBase = L.padH;
    this.targets.position.set(0, this.targetBase - L.targets.sink, L.targets.z);

    this.spinners = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      this.spinners.push(new Spinner(fan, { speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), ease: A.fanEase, phase: (seq * 0.7 + i * 1.3) % TAU }));
    });
    const lev = PROC_MODULES.levitate;
    this.levitators = [];
    sh.orbSpots.forEach(([x, y, z], i) => {
      const mesh = this.paintMesh(sh.orbRing);
      mesh.position.set(x, y, z);
      this.levitators.push(new Levitator(mesh, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });

    this.power = 0;
    this.heat = 0;
    this.lift = 0;
    this.time = seq * A.phaseStep;
    this.cycle = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty, phase: (seq * A.phaseStep) % 1 });
  }

  /**
   * Per-frame animation (no allocations). Idle: rigs turn slowly, targets stay down (floating styles: hover low), glow
   * dim, beacons steady. Active (crew is being trained): rigs spin up, targets rise / hold / sink in cycles, vents and
   * radiators work, beacons blink, glow pulses fully.
   * @param {number} delta   seconds
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = CREW_ANIM;
    this.time += delta;
    this.power += ((active ? 1 : 0) - this.power) * Math.min(1, delta * A.powerEase);
    const speed = A.rigSpeed * an.spin * (A.rigIdle + (1 - A.rigIdle) * this.power);
    const step = an.jerk > 0 ? TAU / A.jerkTicks : 0;
    for (let i = 0; i < this.rigs.length; i++) {
      this.rigAngles[i] += delta * speed * (i ? -1 : 1);
      this.rigs[i].rotation.y = step > 0 ? Math.round(this.rigAngles[i] / step) * step : this.rigAngles[i];
    }
    // targets: rise / hold / sink while active; idle share keeps floating styles hovering low
    if (active) this.cycle += delta;
    let up = plateau((this.cycle % A.targetCycle) / A.targetCycle, A.targetEdge);
    if (an.jerk > 0) up = Math.round(up * A.jerkSteps) / A.jerkSteps;
    const idle = this.shared.idleLift;
    const goal = active ? Math.max(up, idle) : idle;
    this.lift += (goal - this.lift) * Math.min(1, delta * A.liftEase);
    this.targets.position.y = this.targetBase - LAYOUT.targets.sink * (1 - this.lift);
    const glow = pulseWave(this.time, an.pulse) * (A.idleGlow + (1 - A.idleGlow) * this.power);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((active ? 1 : A.heatIdle) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    for (let i = 0; i < this.spinners.length; i++) this.spinners[i].update(delta, active);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
