// Steel Mans – procedural research facility (roadmap 18, phase B). Drop-in alternative to
// models/3DStructures{race}/ResearchFacility{race}_Anim.glb, built from the style modules (ProcModules.js) and the
// faction style (data/buildingStyles.json). A lab block (entrance on +Z) joined to a data-core tower behind it:
//   • lab block per style.silhouette (RESEARCH_SHAPES): flat deck / armoured / vault / ridge, windows (blinking while
//     researching), team bands, pilasters, entrance with header and emblem, side emblems
//   • data core tower: open cage around a pulsing glowing column (X, Y), plasma orb with levitating rings (Z) or a
//     floating crystal scanner held by lasers (W); style decides vents (fans / radiators / plasma orbs), pipes /
//     plasma conduit, markings, lights, texture
//   • animated: rotating radar dish / crystal scanner / rings, sweeping scan arm with a beam on the roof, pulsing
//     core, blinking windows and beacons, heating radiators (W), arcs (Z); slower and dimmer when idle
// Footprint: everything stays inside the pad ±9.5 × ±9.5 around the model origin, which is inside the footprint of the
// GLBs of all races (see docs/notes/proc-research.md). Visual only: update() reads nothing from the simulation.
import * as THREE from 'three';
import { PartBuilder, GlowBuilder, Blinker, steppedEase } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  pipeRun, plasmaCoil, laserLink, spike, arcGeometry, ArcFlicker, Levitator, emblemDecalGeometry, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; style.anim multiplies speeds) */
export const RESEARCH_ANIM = {
  fanSpeed: 4.5,         // rad/s (× style.anim.spin)
  radarSpeed: 0.8,       // rad/s – radar dish on the core
  crystalSpeed: 1.4,     // rad/s – floating crystal scanner
  sweepSpeed: 1.6,       // rad/s – scan arm on the roof
  sweepStops: 8,         // stops per revolution of the arm when style.anim.jerk > 0
  jerkSteps: 5,          // pushes per stop = round(jerk × this)
  idleShare: 0.35,       // speed share of rotating parts while idle
  idleGlow: 0.35,        // core / laser glow share while idle
  idleBeam: 0.3,         // scan beam intensity while idle
  idleWindow: 0.3,       // steady window glow while idle
  windowDim: 0.15,       // dark half of the blinking windows
  idleBeacon: 0.35,      // steady beacon glow while idle
  blinkDuty: 0.5,
  phaseStep: 0.37,       // s – phase offset per instance
  arcSeed: 6151,
};

/** Shared layout (model units, GLB scale; front = +Z) */
const LAYOUT = {
  padHalf: 9.5, padH: 0.15,
  hallZ0: -1.0, hallZ1: 8.6,
  roofSlab: 0.3,
  towerZ: -5.6,
  doorHalfW: 1.5, doorH: 3.0, jambX: 1.85, jambW: 0.5, jambD: 0.5, headerH: 0.6,
  pilasterZ: [-0.7, 2.5, 5.7, 8.3],
  emblemBay: 2,                         // bay with the side emblem (no window there)
  emblemFront: 1.2, emblemSide: 2.0,
  frontWinX: 4.4, frontWinY: 2.4,
  sideWinBelow: 2.4,                    // side window centre below the wall top
  apronOut: 0.6, apronH: 0.5,   // apron centre in front of the door; the marking ends inside the floor (padHalf)
  sweepZ: 3.0, sweepLen: 3.0,
  neonBandMin: 0.3,                     // style.neon from which the walls get a neon band
  spikeH: 0.9, spikeR: 0.22,
};

/** Small details (model units; "below" = under the wall top, "out" = distance in front of a face) */
const DETAIL = {
  segments: 14,
  plinth: { over: 0.4, h: 0.6 },
  column: { w: 0.45, extraH: 0.1, d: 0.6, out: 0.2 },
  rib: { rTop: 0.26, rBottom: 0.3, out: 0.12, segments: 10 },
  fin: { w: 0.9, hShare: 0.92, t: 0.1, out: 0.45, neonW: 0.04, neonShare: 0.8, neonD: 0.14, neonOut: 0.92, neonY: 0.06 },
  buttress: { hShare: 0.8, w: 0.9, d: 0.7, footW: 1.2, footH: 0.5, footD: 1.1, footOut: 0.45 },
  vein: { w: 0.06, hShare: 0.7, d: 0.1, out: 0.45, yShare: 0.45 },
  band: { below: 1.0, inset: 0.4, h: 0.4, t: 0.06 },
  neonBand: { below: 0.55, h: 0.08, t: 0.05 },
  lower: { y: 0.9, h: 0.9, t: 0.05 },
  window: { frameW: 2.0, frameH: 1.1, glassW: 1.7, glassH: 0.8, t: 0.05, glassOut: 0.02, glowOut: 0.04, glowW: 1.5, glowH: 0.6, rFrame: 0.75, rGlass: 0.6, rGlow: 0.5 },
  front: {
    interiorGap: 0.1, interiorT: 0.05, interiorOut: 0.03, jambZ: 0.2, jambMarkH: 0.5, jambMarkZ: 0.51, jambMarkY: 0.3,
    footMarkLen: 1.2, footMarkX: 1.0, footMarkY: 0.35, neonH: 0.08, neonT: 0.04, neonY: 0.08, neonZ: 0.47, emblemZ: 0.45,
    beaconInset: 0.6,
  },
  flatRoof: { slabOver: 0.3, neonH: 0.06, neonT: 0.05 },
  armored: { slabOver: 0.5, parapetT: 0.35, parapetH: 0.5, parapetOut: 0.07 },
  vault: { segments: 20, ribOut: 0.04, ribT: 0.14, neonW: 1.0, neonH: 0.08, neonInset: 2 },
  ridge: { slabOver: 0.3, inset: 1.2, neonW: 0.08, neonH: 0.06, neonInset: 0.3, neonLift: 0.01 },
  connector: { z: -1.7, d: 2.4, w: 2.6, h: 2.6, tubeR: 1.2, laserY: [1.2, 2.4], laserX: 0.8 },
  sweep: { baseR: 0.7, baseFlare: 1.25, baseH: 0.4, armH: 0.12, armT: 0.14, thinT: 0.05, nubR: 0.16, beamT: 0.1, beamLift: 0.05, beamStart: 0.2 },
  cageRound: {
    r: 3.2, baseH: 3.4, baseFlare: 1.05, neonBelow: 0.5, neonH: 0.25, pillars: 6, pillarShare: 0.78, pillarR: 0.3, cageH: 8.5, rings: 3,
    ringTube: 0.09, coreR: 0.55, haloR: 1.0, capShare: 1.1, capH: 0.5, mastR: 0.12, mastH: 1.0, radarLift: 0.5, beaconShare: 0.6,
  },
  cageSquare: {
    r: 3.2, topR: 2.6, baseH: 3.6, pillarW: 1.0, cageH: 8.0, beams: 2, beamT: 0.25, coreW: 0.9, haloW: 1.5, capW: 6.0, capH: 0.6,
    spikeH: 0.9, spikeR: 0.25, mastR: 0.14, mastH: 1.0, radarLift: 0.5,
  },
  orb: {
    pedTop: 2.0, pedBottom: 2.6, pedH: 4.6, neonR: 2.2, neonT: 0.07, orbR: 2.6, orbLift: 0.3, haloShare: 1.25,
    coilH: 2.4, coilR: 0.55, ringR: [3.5, 2.8], ringDy: [0, 2.0], arcX: 2.7, arcDy: 0.4, arcZ: 1.0,
  },
  crystal: {
    colW: 2.2, colH: 9.0, neonW: 2.3, neonH: 0.08, neonBelow: 0.4, laserR: 1.0, laserTopR: 0.45, laserBelow: 1.3, lasers: 4,
    top: 13.0, haloR: 1.9, blockX: 5.4, blockW: 1.4, blockH: 3.2, blockD: 1.4, lensRTop: 0.2, lensRBottom: 0.26, lensH: 0.2,
    linkX0: 0.8, linkY: [1.8, 2.6],
  },
  scanner: { r: 0.8, stretch: 1.6, barW: 1.8, barT: 0.06, lensR: 0.14, lensH: 0.2, lensX: 0.9 },
  radar: { stemW: 0.3, stemH: 0.6, dishR: 1.1, dishRBottom: 0.15, dishH: 0.35, tilt: 0.4, rodR: 0.03, rodH: 1.0, boxW: 0.5, boxH: 0.4 },
  pipes: { y: 1.6, r: 0.2, front: 7.4, back: -0.2, riseBelow: 0.5, lowY: 0.9, lowR: 0.15, bracketStep: 3.0, bracketH: 1.2, bracketD: 0.15, bracketY: 2.0 },
  conduit: { s: 0.25, out: 0.12, y: 1.2, inset: 2, neonW: 0.06, neonH: 0.08, neonInset: 2.2, neonOut: 0.27, podZ: [0.5, 3.5, 6.5], podR: 0.45, podOut: 0.2, podFlat: 0.6, glowOut: 0.35 },
};

/**
 * Shapes by style.silhouette (code knows shapes, the style data picks one; unknown → rounded).
 * roof: deck / armored / vault / ridge; pilaster: column / buttress / rib / fin; core: cageRound / cageSquare / orb / crystal.
 * vents: [x, z] (on the roof, or on the ground beside the hall when ventsOn = 'ground'); side = right wall equipment.
 */
export const RESEARCH_SHAPES = {
  rounded: {
    wallH: 5.6, hallHalf: 7.0, hallHalfTop: 7.0, hallEdge: 1, roof: 'deck', pilaster: 'column', core: 'cageRound', side: 'pipes',
    ventsOn: 'roof', vents: [[-5.0, 3.0], [5.0, 3.0]], ventR: 0.9, emblemY: 3.0,
  },
  angular: {
    wallH: 6.0, hallHalf: 7.4, hallHalfTop: 6.6, hallEdge: 0, roof: 'armored', pilaster: 'buttress', core: 'cageSquare', side: 'pipes',
    ventsOn: 'roof', vents: [[-4.6, 3.0], [4.6, 3.0]], ventR: 1.0, emblemY: 3.2,
  },
  round: {
    wallH: 5.2, hallHalf: 6.6, hallHalfTop: 6.6, hallEdge: 0.9, roof: 'vault', vaultRise: 2.4, pilaster: 'rib', core: 'orb', side: 'conduit',
    portholes: true, ventsOn: 'ground', vents: [[-8.1, 3.5], [8.1, 3.5]], ventR: 1.0, emblemY: 2.8,
  },
  faceted: {
    wallH: 5.4, hallHalf: 6.2, hallHalfTop: 6.2, hallEdge: 1, roof: 'ridge', ridgeW: 4.4, ridgeRise: 1.6, pilaster: 'fin', core: 'crystal', side: 'none',
    ventsOn: 'ground', vents: [[-8.3, 3.5], [8.3, 3.5]], ventR: 0.85, emblemY: 2.9,
  },
};

const shapeOf = (style) => RESEARCH_SHAPES[style.silhouette] ?? RESEARCH_SHAPES.rounded;

// ---------------------------------------------------------------- static part (one mesh per style)

function buildStatic(kit, shape) {
  const L = LAYOUT;
  const D = DETAIL;
  const S = kit.S;
  const st = kit.style;
  const b = new PartBuilder();
  const glows = new GlowSet();
  const H = shape.wallH;
  const hb = shape.hallHalf;
  const ht = shape.hallHalfTop;
  const hallD = L.hallZ1 - L.hallZ0;
  const hallCz = (L.hallZ0 + L.hallZ1) / 2;
  const zf = L.hallZ1;
  const tilt = Math.atan2(hb - ht, H);
  const wallXAt = (y) => hb - (hb - ht) * (y / H);
  const onWall = (side, y, z, w, h, d, s, out = 0) => b.box(d, h, w, s, { x: side * (wallXAt(y) + d / 2 + out), y, z, rz: side * tilt });
  const roofY = H + L.roofSlab;
  const vault = shape.roof === 'vault';
  const topY = vault ? H : roofY;                 // surface for corner beacons
  const neonBands = st.neon >= L.neonBandMin;
  const emblems = [];
  const arcPairs = [];
  const W = D.window;
  const bays = L.pilasterZ.length - 1;

  // ground: pad, apron marking
  b.box(L.padHalf * 2, L.padH, L.padHalf * 2, S.ground, { base: true });
  marking(b, kit, L.doorHalfW * 2 + L.jambW * 2, L.apronH, { rx: -Math.PI / 2, y: L.padH + 0.01, z: zf + L.apronOut });

  // hall body
  b.box(hb * 2 + D.plinth.over, D.plinth.h, hallD, S.hullDark, { base: true, z: hallCz });
  if (hb !== ht) b.taperedBox(hb * 2, ht * 2, H, hallD, S.hull, { z: hallCz });
  else styledBox(b, kit, hb * 2, H, hallD, S.hull, { base: true, z: hallCz }, shape.hallEdge);

  // long walls: pilasters, bands, windows, side emblem
  for (const side of [-1, 1]) {
    for (const z of L.pilasterZ) {
      switch (shape.pilaster) {
        case 'column': {
          const c = D.column;
          b.box(c.w, H + c.extraH, c.d, S.frame, { base: true, x: side * (hb + c.out), z });
          break;
        }
        case 'rib': {
          const r = D.rib;
          b.cylinder(r.rTop, r.rBottom, H, r.segments, S.hullDark, { x: side * (hb + r.out), y: H / 2, z });
          break;
        }
        case 'fin': {
          const f = D.fin;
          b.box(f.w, H * f.hShare, f.t, S.frame, { base: true, x: side * (hb + f.out), z });
          neonStrip(b, kit, f.neonW, H * f.neonShare, f.neonD, { base: true, x: side * (hb + f.neonOut), y: H * f.neonY, z });
          break;
        }
        default: {
          const t = D.buttress;
          const bh = H * t.hShare;
          onWall(side, bh / 2, z, t.w, bh, t.d, S.hullDark);
          b.box(t.footW, t.footH, t.footD, S.frame, { base: true, x: side * (hb + t.footOut), z });
        }
      }
      if (kit.rich && shape.pilaster !== 'fin') {
        const v = D.vein;
        neonStrip(b, kit, v.w, H * v.hShare, v.d, { x: side * (hb + v.out), y: H * v.yShare, z });
      }
    }
    onWall(side, H - D.band.below, hallCz, hallD - D.band.inset, D.band.h, D.band.t, S.team);
    if (neonBands) onWall(side, H - D.neonBand.below, hallCz, hallD - D.band.inset, D.neonBand.h, D.neonBand.t, S.neon);
    if (shape.pilaster === 'buttress') onWall(side, D.lower.y, hallCz, hallD - D.band.inset, D.lower.h, D.lower.t, S.lower);
    const winY = H - L.sideWinBelow;
    for (let i = 0; i < bays; i++) {
      if (i === L.emblemBay) continue;
      const z = (L.pilasterZ[i] + L.pilasterZ[i + 1]) / 2;
      const layer = glows.get(i % 2 ? 'winA' : 'winB');
      if (shape.portholes) {
        const x = side * (hb + W.t / 2);
        b.cylinder(W.rFrame, W.rFrame, W.t, 14, S.frame, { rz: Math.PI / 2, x, y: winY, z });
        b.cylinder(W.rGlass, W.rGlass, W.t, 14, S.window, { rz: Math.PI / 2, x: x + side * W.glassOut, y: winY, z });
        layer.cylinder(W.rGlow, W.rGlow, W.t, 14, { rz: Math.PI / 2, x: x + side * W.glowOut, y: winY, z }, false);
      } else {
        onWall(side, winY, z, W.frameW, W.frameH, W.t, S.frame);
        onWall(side, winY, z, W.glassW, W.glassH, W.t, S.window, W.glassOut);
        layer.box(W.t, W.glowH, W.glowW, {
          x: side * (wallXAt(winY) + W.t / 2 + W.glowOut), y: winY, z, rz: side * tilt,
        });
      }
    }
    const ey = shape.emblemY;
    const ez = (L.pilasterZ[L.emblemBay] + L.pilasterZ[L.emblemBay + 1]) / 2;
    emblems.push({ position: [side * wallXAt(ey), ey, ez], normal: [side * Math.cos(tilt), Math.sin(tilt), 0], size: L.emblemSide });
  }
  // rear colour band
  b.box(ht * 2 - D.band.inset, D.band.h, D.band.t, S.team, { y: H - D.band.below, z: L.hallZ0 - D.band.t / 2 });

  // front: windows either side of the entrance, entrance with interior glow, jambs, header, emblem, beacons
  for (const [k, side] of [[0, -1], [1, 1]]) {
    const x = side * L.frontWinX;
    const y = L.frontWinY;
    const layer = glows.get(k ? 'winA' : 'winB');
    if (shape.portholes) {
      b.cylinder(W.rFrame, W.rFrame, W.t, 14, S.frame, { rx: Math.PI / 2, x, y, z: zf + W.t / 2 });
      b.cylinder(W.rGlass, W.rGlass, W.t, 14, S.window, { rx: Math.PI / 2, x, y, z: zf + W.t / 2 + W.glassOut });
      layer.cylinder(W.rGlow, W.rGlow, W.t, 14, { rx: Math.PI / 2, x, y, z: zf + W.t / 2 + W.glowOut }, false);
    } else {
      b.box(W.frameW, W.frameH, W.t, S.frame, { x, y, z: zf + W.t / 2 });
      b.box(W.glassW, W.glassH, W.t, S.window, { x, y, z: zf + W.t / 2 + W.glassOut });
      layer.box(W.glowW, W.glowH, W.t, { x, y, z: zf + W.t / 2 + W.glowOut });
    }
  }
  const F = D.front;
  b.box(L.doorHalfW * 2, L.doorH - F.interiorGap, F.interiorT, S.interior, { base: true, y: L.padH, z: zf + F.interiorOut });
  for (const side of [-1, 1]) {
    b.box(L.jambW, L.doorH, L.jambD, S.frame, { base: true, x: side * L.jambX, z: zf + F.jambZ });
    marking(b, kit, L.doorH, F.jambMarkH, { rz: Math.PI / 2, x: side * L.jambX, y: L.doorH / 2 + F.jambMarkY, z: zf + F.jambMarkZ });
    marking(b, kit, F.footMarkLen, F.jambMarkH, { x: side * (L.jambX + F.footMarkX), y: F.footMarkY, z: zf + 0.02 });
    beacon(b, glows.get('beaconA'), kit, [side * (ht - F.beaconInset), topY, zf - F.beaconInset]);
  }
  b.box(L.jambX * 2 + L.jambW, L.headerH, L.jambD, S.frame, { base: true, y: L.doorH, z: zf + F.jambZ });
  if (neonBands) neonStrip(b, kit, L.jambX * 2 + L.jambW, F.neonH, F.neonT, { y: L.doorH + F.neonY, z: zf + F.neonZ });
  const aboveDoor = L.doorH + L.headerH;   // emblem centred in the wall strip above the header
  emblems.push({ position: [0, aboveDoor + (H - aboveDoor) / 2, zf], normal: [0, 0, 1], size: L.emblemFront });

  // roof
  if (shape.roof === 'deck') {
    const R = D.flatRoof;
    b.box(hb * 2 + R.slabOver, L.roofSlab, hallD + R.slabOver, S.frame, { base: true, y: H, z: hallCz });
    neonStrip(b, kit, hb * 2, R.neonH, R.neonT, { y: roofY + R.neonH / 2, z: zf + R.slabOver / 2 });
  } else if (shape.roof === 'armored') {
    const A = D.armored;
    b.box(ht * 2 + A.slabOver, L.roofSlab, hallD + A.slabOver, S.frame, { base: true, y: H, z: hallCz });
    for (const side of [-1, 1]) {
      b.box(A.parapetT, A.parapetH, hallD + A.slabOver, S.hullDark, { base: true, x: side * (ht + A.parapetOut), y: roofY, z: hallCz });
      b.box(ht * 2 + A.slabOver, A.parapetH, A.parapetT, S.hullDark, { base: true, y: roofY, z: hallCz + side * (hallD / 2 + A.parapetOut) });
      for (const e of [-1, 1]) {
        spike(b, kit, { x: side * (ht + A.parapetOut), y: roofY + A.parapetH, z: hallCz + e * (hallD / 2 + A.parapetOut), h: L.spikeH, r: L.spikeR });
      }
    }
  } else if (vault) {
    const V = D.vault;
    const k = shape.vaultRise / hb;
    b.cylinder(hb, hb, hallD, V.segments, S.hull, { rx: Math.PI / 2, sz: k, y: H, z: hallCz }, false, Math.PI / 2, Math.PI);
    for (const z of L.pilasterZ) b.torus(hb + V.ribOut, V.ribT, 4, 16, Math.PI, S.hullDark, { sy: k, y: H, z });
    neonStrip(b, kit, V.neonW, V.neonH, hallD - V.neonInset, { y: H + shape.vaultRise, z: hallCz });
  } else {
    const R = D.ridge;
    b.box(hb * 2 + R.slabOver, L.roofSlab, hallD + R.slabOver, S.frame, { base: true, y: H, z: hallCz });
    const ridgeLen = hallD - R.inset;
    const g = new THREE.BoxGeometry(1, 1, ridgeLen);
    g.rotateZ(Math.PI / 4);
    g.scale(shape.ridgeW / Math.SQRT2, shape.ridgeRise * Math.SQRT2, 1);
    b.add(g, S.hull, { y: roofY, z: hallCz });
    neonStrip(b, kit, R.neonW, R.neonH, ridgeLen - R.neonInset, { y: roofY + shape.ridgeRise + R.neonLift, z: hallCz });
  }

  // scan arm turntable on the roof (the arm itself turns: shared.sweep)
  const SW = D.sweep;
  const sweepY = vault ? H + shape.vaultRise : shape.roof === 'ridge' ? roofY + shape.ridgeRise - SW.baseH / 2 : roofY;
  b.cylinder(SW.baseR, SW.baseR * SW.baseFlare, SW.baseH, 12, S.hullDark, { y: sweepY + SW.baseH / 2, z: L.sweepZ });
  const sweepPos = [0, sweepY + SW.baseH, L.sweepZ];

  // connector between hall and core: corridor / tube / laser links (separate blocks)
  const C = D.connector;
  const tz = L.towerZ;
  if (shape.core === 'crystal') {
    for (const y of C.laserY) laserLink(b, glows.get('laser'), kit, [-C.laserX, y, C.z - C.d / 2], [-C.laserX, y, C.z + C.d / 2]);
    for (const y of C.laserY) laserLink(b, glows.get('laser'), kit, [C.laserX, y, C.z - C.d / 2], [C.laserX, y, C.z + C.d / 2]);
  } else if (shape.core === 'orb') {
    b.cylinder(C.tubeR, C.tubeR, C.d + 1, 14, S.hull, { rx: Math.PI / 2, y: C.tubeR + L.padH, z: C.z });
  } else {
    styledBox(b, kit, C.w, C.h, C.d + 1, S.hullDark, { base: true, y: L.padH, z: C.z }, 0.5);
  }

  // core tower
  let head = null;
  const CB = D[shape.core];
  const pulse = glows.get('pulse');
  if (shape.core === 'cageRound') {
    const baseR = CB.r * CB.baseFlare;
    b.cylinder(CB.r, baseR, CB.baseH, 20, S.hull, { y: CB.baseH / 2, z: tz });
    b.cylinder(CB.r + 0.03, CB.r + 0.03, CB.neonH, 20, S.neon, { y: CB.baseH - CB.neonBelow, z: tz }, true);
    const pr = CB.r * CB.pillarShare;
    const top = CB.baseH + CB.cageH;
    for (let i = 0; i < CB.pillars; i++) {
      const a = (i / CB.pillars) * TAU;
      b.cylinder(CB.pillarR, CB.pillarR, CB.cageH, 8, S.frame, { x: Math.cos(a) * pr, y: CB.baseH + CB.cageH / 2, z: tz + Math.sin(a) * pr });
    }
    for (let k = 1; k <= CB.rings; k++) b.torus(pr, CB.ringTube, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: CB.baseH + (CB.cageH * k) / (CB.rings + 1), z: tz });
    b.cylinder(CB.coreR, CB.coreR, CB.cageH, 12, S.plasma, { y: CB.baseH + CB.cageH / 2, z: tz });
    pulse.cylinder(CB.haloR, CB.haloR, CB.cageH, 12, { y: CB.baseH + CB.cageH / 2, z: tz });
    b.cylinder(CB.r * CB.capShare, CB.r * CB.capShare, CB.capH, 20, S.frame, { y: top + CB.capH / 2, z: tz });
    b.cylinder(CB.mastR, CB.mastR, CB.mastH, 8, S.frame, { y: top + CB.capH + CB.mastH / 2, z: tz });
    for (const e of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [e * CB.r * CB.beaconShare, top + CB.capH, tz]);
    if (st.industrial) head = { kind: 'radar', x: 0, y: top + CB.capH + CB.mastH + CB.radarLift, z: tz };
  } else if (shape.core === 'cageSquare') {
    b.taperedBox(CB.r * 2, CB.topR * 2, CB.baseH, CB.r * 2, S.hull, { z: tz }, CB.topR * 2);
    const top = CB.baseH + CB.cageH;
    const pc = CB.topR - CB.pillarW / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) b.box(CB.pillarW, CB.cageH, CB.pillarW, S.frame, { base: true, x: sx * pc, y: CB.baseH, z: tz + sz * pc });
    }
    for (let k = 1; k <= CB.beams; k++) {
      const y = CB.baseH + (CB.cageH * k) / (CB.beams + 1);
      for (const e of [-1, 1]) {
        b.box(CB.topR * 2, CB.beamT, CB.beamT, S.frame, { y, z: tz + e * pc });
        b.box(CB.beamT, CB.beamT, CB.topR * 2, S.frame, { x: e * pc, y, z: tz });
      }
    }
    b.box(CB.coreW, CB.cageH, CB.coreW, S.plasma, { base: true, y: CB.baseH, z: tz });
    pulse.box(CB.haloW, CB.cageH, CB.haloW, { y: CB.baseH + CB.cageH / 2, z: tz });
    b.box(CB.capW, CB.capH, CB.capW, S.frame, { base: true, y: top, z: tz });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) spike(b, kit, { x: sx * (CB.capW / 2 - CB.spikeR), y: top + CB.capH, z: tz + sz * (CB.capW / 2 - CB.spikeR), h: CB.spikeH, r: CB.spikeR });
    }
    b.cylinder(CB.mastR, CB.mastR, CB.mastH, 8, S.frame, { y: top + CB.capH + CB.mastH / 2, z: tz });
    beacon(b, glows.get('beaconA'), kit, [CB.capW / 2 - CB.spikeR * 3, top + CB.capH, tz]);
    beacon(b, glows.get('beaconA'), kit, [-(CB.capW / 2 - CB.spikeR * 3), top + CB.capH, tz]);
    if (st.industrial) head = { kind: 'radar', x: 0, y: top + CB.capH + CB.mastH + CB.radarLift, z: tz };
  } else if (shape.core === 'orb') {
    b.cylinder(CB.pedTop, CB.pedBottom, CB.pedH, 20, S.hull, { y: CB.pedH / 2, z: tz });
    b.torus(CB.neonR, CB.neonT, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: CB.pedH * 0.5, z: tz });
    const cy = CB.pedH + CB.orbR * (1 - CB.orbLift);
    b.sphere(CB.orbR, 20, 12, S.plasma, { y: cy, z: tz });
    pulse.sphere(CB.orbR * CB.haloShare, 14, 9, { y: cy, z: tz });
    const topPt = plasmaCoil(b, pulse, kit, { x: 0, y: cy + CB.orbR, z: tz, h: CB.coilH, r: CB.coilR });
    arcPairs.push([topPt, [CB.arcX, cy + CB.arcDy, tz]], [topPt, [-CB.arcX * 0.7, cy + CB.arcDy, tz + CB.arcZ]]);
    beacon(b, glows.get('beaconA'), kit, [0, topPt[1] + CB.coilR * PROC_MODULES.coil.capShare, tz]);
    head = { kind: 'rings', y: cy, z: tz };
  } else {
    const colTop = L.padH + CB.colH;
    styledBox(b, kit, CB.colW, CB.colH, CB.colW, S.hullDark, { base: true, y: L.padH, z: tz, ry: Math.PI / 4 });
    b.box(CB.neonW, CB.neonH, CB.neonW, S.neon, { y: colTop - CB.neonBelow, z: tz, ry: Math.PI / 4 });
    for (let k = 0; k < CB.lasers; k++) {
      const a = (k * TAU) / CB.lasers;
      laserLink(b, glows.get('laser'), kit, [Math.cos(a) * CB.laserR, colTop, tz + Math.sin(a) * CB.laserR],
        [Math.cos(a) * CB.laserTopR, CB.top - CB.laserBelow, tz + Math.sin(a) * CB.laserTopR]);
    }
    pulse.sphere(CB.haloR, 12, 8, { y: CB.top, z: tz });
    for (const e of [-1, 1]) {
      styledBox(b, kit, CB.blockW, CB.blockH, CB.blockD, S.hullDark, { base: true, x: e * CB.blockX, y: L.padH, z: tz }, 0.5);
      b.cylinder(CB.lensRTop, CB.lensRBottom, CB.lensH, 10, S.lens, { x: e * CB.blockX, y: L.padH + CB.blockH + CB.lensH / 2, z: tz });
      for (const y of CB.linkY) laserLink(b, glows.get('laser'), kit, [e * (CB.blockX - CB.blockW / 2), y, tz], [e * CB.linkX0, y, tz]);
    }
    beacon(b, glows.get('beaconA'), kit, [0, colTop, tz + CB.colW / 2 - 0.3]);
    head = { kind: 'crystal', x: 0, y: CB.top, z: tz };
  }

  // roof / ground vents: fans / radiators / plasma orbs
  const vents = [];
  const vy = shape.ventsOn === 'roof' ? roofY : L.padH;
  for (const [fx, fz] of shape.vents) vents.push(ventUnit(b, glows, kit, { x: fx, y: vy, z: fz, r: shape.ventR }));

  // right wall equipment
  const Pp = D.pipes;
  const px = hb + 0.7;
  if (shape.side === 'pipes' && pipeRun(b, kit, [[px, Pp.y, Pp.front], [px, Pp.y, Pp.back], [px, H - Pp.riseBelow, Pp.back]], Pp.r)) {
    pipeRun(b, kit, [[px, L.padH, Pp.front - 1], [px, Pp.lowY, Pp.front - 1], [px, Pp.lowY, Pp.back + 1], [px, L.padH, Pp.back + 1]], Pp.lowR);
    for (let z = Pp.back + 1; z <= Pp.front - 1; z += Pp.bracketStep) {
      const wx = wallXAt(Pp.bracketY);
      b.box(px - wx + 0.2, Pp.bracketH, Pp.bracketD, S.frame, { x: (px + wx) / 2, y: Pp.bracketY, z });
    }
  } else if (shape.side === 'conduit') {
    const Cd = D.conduit;
    b.box(Cd.s, Cd.s, hallD - Cd.inset, S.hullDark, { x: hb + Cd.out, y: Cd.y, z: hallCz });
    neonStrip(b, kit, Cd.neonW, Cd.neonH, hallD - Cd.neonInset, { x: hb + Cd.neonOut, y: Cd.y, z: hallCz });
    for (const z of Cd.podZ) {
      b.sphere(Cd.podR, 12, 8, S.trim, { x: hb + Cd.podOut, y: Cd.y, z, sx: Cd.podFlat });
      pulse.point([hb + Cd.glowOut, Cd.y, z], PROC_MODULES.glow.radius);
    }
  }

  return { geometry: b.buildLods(), glows: glows.build(), vents, head, arcPairs, emblems, sweepPos };
}

// ---------------------------------------------------------------- animated parts

function buildRadarHead(S) {
  const R = DETAIL.radar;
  const b = new PartBuilder();
  const tiltX = Math.PI / 2 - R.tilt;
  b.cylinder(R.stemW, R.stemW, R.stemH * 0.4, 12, S.frame, { y: 0.1 });
  b.box(R.stemW, R.stemH, R.stemW, S.hullDark, { y: 0.5 });
  b.cylinder(R.dishR, R.dishRBottom, R.dishH, 16, S.trim, { rx: tiltX, y: 0.9, z: 0.15 });
  b.cylinder(R.rodR, R.rodR, R.rodH, 6, S.frame, { rx: tiltX, y: 0.9 + Math.cos(tiltX) * R.rodH / 2, z: 0.15 + Math.sin(tiltX) * R.rodH / 2 });
  b.box(R.boxW, R.boxH, R.stemW, S.hullDark, { y: 0.85, z: -0.5 });
  b.box(0.2, 0.1, 0.05, S.team, { y: 1.0, z: -0.66 });
  return b.build();
}

/** Floating crystal scanner (turns; a neon scan line and a lens on its side) */
function buildScannerHead(S) {
  const C = DETAIL.scanner;
  const b = new PartBuilder();
  const g = new THREE.OctahedronGeometry(C.r, 0);
  g.scale(1, C.stretch, 1);
  b.add(g, S.trim);
  b.box(C.barW, C.barT, C.barT, S.neon);
  b.cylinder(C.lensR, C.lensR, C.lensH, 8, S.lens, { x: C.lensX, rz: Math.PI / 2 });
  return b.build();
}

/** Turning scan arm (paint) and its beam (glow), both in the local frame of the turntable (arm along +X) */
function buildSweep(kit) {
  const SW = DETAIL.sweep;
  const S = kit.S;
  const arm = new PartBuilder();
  const t = kit.style.industrial ? SW.armT : SW.thinT;
  arm.box(LAYOUT.sweepLen, SW.armH, t, kit.style.industrial ? S.frame : S.trim, { x: LAYOUT.sweepLen / 2, y: SW.armH / 2 });
  arm.sphere(SW.nubR, 8, 6, S.lens, { x: LAYOUT.sweepLen, y: SW.armH / 2 });
  const beam = new GlowBuilder();
  const y = SW.armH / 2 + SW.beamLift;
  beam.segment([SW.beamStart, y, 0], [LAYOUT.sweepLen + SW.nubR, y, 0], SW.beamT);
  return { arm: arm.build(), beam: beam.build() };
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const shape = shapeOf(kit.style);
  const st = buildStatic(kit, shape);
  const fans = st.vents.filter((v) => v.fan);
  const rings = st.vents.filter((v) => v.ring);
  const orb = DETAIL.orb;
  return {
    shape,
    static: st.geometry,
    glow: st.glows,
    emblem: emblemDecalGeometry(st.emblems),
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    ringSpots: rings.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    ring: rings.length ? ringGeometry(kit, rings[0].ring.r) : null,
    head: st.head && st.head.kind !== 'rings'
      ? { ...st.head, geometry: st.head.kind === 'radar' ? buildRadarHead(kit.S) : buildScannerHead(kit.S) } : null,
    coreRings: st.head?.kind === 'rings'
      ? orb.ringR.map((r, i) => ({ y: st.head.y + orb.ringDy[i], z: st.head.z, geometry: ringGeometry(kit, r) })) : [],
    arcs: st.arcPairs.length ? arcGeometry(st.arcPairs, RESEARCH_ANIM.arcSeed) : null,
    sweepPos: st.sweepPos,
    sweep: buildSweep(kit),
  };
}

const RESEARCH_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class ResearchFacilityProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: RESEARCH_CACHE, name: 'ResearchFacilityProc' });
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
    const A = RESEARCH_ANIM;
    const gc = this.kit.glowColors;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, false);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);
    this.laserGlow = layer('laser', gc.laser, true);
    this.windowsA = layer('winA', gc.pulse, true);
    this.windowsB = layer('winB', gc.pulse, true);
    this.arcs = null;
    if (sh.arcs) {
      const arcLayer = this.glowLayer(this.instanceGeometry(sh.arcs.geometry), gc.arc, { visible: false });
      this.arcs = new ArcFlicker(arcLayer, sh.arcs.ranges, { seed: A.arcSeed + seq });
    }

    // fans (always turn, faster while researching)
    this.fans = [];
    this.fanSpeeds = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      fan.rotation.y = (seq * 0.7 + i * 1.3) % TAU;
      this.fans.push(fan);
      this.fanSpeeds.push(A.fanSpeed * an.spin * (i % 2 ? -1 : 1));
    });
    // radar dish / crystal scanner on the core
    this.head = null;
    this.headSpeed = 0;
    if (sh.head) {
      this.head = this.paintMesh(sh.head.geometry);
      this.head.position.set(sh.head.x, sh.head.y, sh.head.z);
      this.head.rotation.y = seq * 0.9;
      this.headSpeed = (sh.head.kind === 'radar' ? A.radarSpeed : A.crystalSpeed) * an.spin;
    }
    // levitating rings: over the vent orbs and around the core orb
    const lev = PROC_MODULES.levitate;
    this.levitators = [];
    sh.ringSpots.forEach(([x, y, z], i) => {
      const ring = this.paintMesh(sh.ring);
      ring.position.set(x, y, z);
      this.levitators.push(new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 }));
    });
    sh.coreRings.forEach((r, i) => {
      const ring = this.paintMesh(r.geometry);
      ring.position.set(0, r.y, r.z);
      this.levitators.push(new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1) * 1.5, phase: seq * 0.37 + i * 1.1 }));
    });

    // scan arm with a beam on the roof
    this.sweep = new THREE.Group();
    this.sweep.position.set(sh.sweepPos[0], sh.sweepPos[1], sh.sweepPos[2]);
    this.add(this.sweep);
    this.paintMesh(sh.sweep.arm, this.sweep);
    this.beam = this.glowLayer(sh.sweep.beam, gc.beam, { parent: this.sweep, visible: true });
    this.sweepSpeed = A.sweepSpeed * an.spin;
    this.sweepPhase = seq * 0.9;
    this.sweepSteps = an.jerk > 0 ? Math.max(1, Math.round(an.jerk * A.jerkSteps)) : 0;

    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). While researching: fans / radar / crystal / scan arm turn at full speed, the
   * core pulses brightly, windows and beacons blink, radiators heat up, arcs flash, rings float faster; when idle
   * everything is slower and dimmer.
   * @param {number} delta   seconds
   * @param {boolean} active building complete, powered and researching
   */
  update(delta, active = false) {
    const an = this.kit.style.anim;
    const A = RESEARCH_ANIM;
    const k = active ? 1 : A.idleShare;
    this.time += delta;
    for (let i = 0; i < this.fans.length; i++) this.fans[i].rotation.y += delta * this.fanSpeeds[i] * k;
    if (this.head) this.head.rotation.y += delta * this.headSpeed * k;
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, active);

    this.sweepPhase += delta * this.sweepSpeed * k;
    if (this.sweepSteps > 0) {
      const p = (this.sweepPhase / TAU) * A.sweepStops;
      const f = Math.floor(p);
      this.sweep.rotation.y = ((f + steppedEase(p - f, this.sweepSteps)) / A.sweepStops) * TAU;
    } else {
      this.sweep.rotation.y = this.sweepPhase;
    }

    const glow = pulseWave(this.time, an.pulse) * (active ? 1 : A.idleGlow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.beam.setIntensity(active ? glow : A.idleBeam);
    this.heat += ((active ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(delta, active);
    this.blink.update(delta, active);
    this.windowsA?.setIntensity(active ? (this.blink.on ? 1 : A.windowDim) : A.idleWindow);
    this.windowsB?.setIntensity(active ? (this.blink.off ? 1 : A.windowDim) : A.idleWindow);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
