// Steel Men – procedural vehicle factory (roadmap 18, first building of the style kit). A drop-in alternative to
// models/3DStructures{race}/VehicleFactory{race}_Anim.glb built in code from the style modules (ProcModules.js) and
// the faction style (data/buildingStyles.json):
//   • same footprint as the GLB (hall ±8.56 × ±14.27, gantry legs to ±9.5, front = +Z where units spawn)
//   • building shape per style.silhouette (FACTORY_SHAPES: rounded / angular / round / faceted); everything else comes
//     from the style: edges, neon, lights, vents (fans / radiators / plasma orbs), crane kind and rails, markings,
//     industrial parts, texture, emblem, animation tempo
//   • one merged static mesh per style (shared by every instance) + emblem decals (1 draw call) + glow layers +
//     animated parts: fans / radar / scanner (always turn), crane, door, beacons, radiator heat, plasma, arcs
// Visual only: update() takes the frame delta, nothing here is read by the simulation.
import * as THREE from 'three';
import { PartBuilder, Spinner, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  roofRails, pipeRun, tank, chimney, plasmaCoil, laserLink, spike, arcGeometry, ArcFlicker, Levitator,
  buildCraneGeometry, CraneRig, emblemDecalGeometry, pulseWave, PROC_MODULES, teamPanel,
} from './ProcModules.js';
import { PROC_TEAM_PAINT } from '../config.js';

/**
 * Team paint of the factory (docs/notes/proc-teampaint-a.md): the main structure is team lacquer, the rest stays neutral metal –
 * the pilasters / ribs / buttresses / fins, the roof deck (the vault for the round style, share `vaultTeam` of its arc as
 * a centre stripe) and the tower body, plus one big panel on the rear wall. `lod` = coarsest LOD they appear in (2 = far silhouette).
 */
const TEAM = {
  lod: PROC_TEAM_PAINT.lod.panel,
  vaultTeam: 0.6,                       // share of the vault arc (centre stripe) in team paint
  bay: { y: 0.85, h: 2.2, margin: 0.9, t: 0.08 },   // right-wall plates between pilasters: bottom, height, narrower than the bay, thickness
  rearPanel: { w: 3.0, h: 3.2, gap: 0.3 },   // rear wall panel: width = hall top width − w, height h, hangs `gap` under the rear band
};

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const FACTORY_ANIM = {
  fanSpeed: 5.5,           // rad/s (× style.anim.spin)
  fanSpeedJitter: 0.25,    // ± share, varies per fan and instance
  radarSpeed: 0.9,         // rad/s
  scannerSpeed: 1.6,       // rad/s – crystal scanner head of the pylon tower
  doorSpeed: 1.6,          // 1/s
  doorMinScale: 0.07,      // rolled-up door height share
  blinkDuty: 0.5,          // share of the beacon period with the lights on (the period itself is style.anim.blink)
  idleGlow: 0.35,          // plasma / laser glow share while not producing
  phaseStep: 0.37,         // s – pulse phase offset per instance
  arcSeed: 7919,
};

/** Shared layout of every shape (model units, GLB scale; front = +Z) */
const LAYOUT = {
  hallZ0: -13.0, hallZ1: 11.0,          // hall rear / front face
  padHalfX: 9.5, padHalfZ: 14.2, padH: 0.15,
  railX: 8.9, railHalfZ: 14.0, groundRailW: 0.3, groundRailH: 0.25,   // ground rails of legged gantries
  legX: 9.15,
  roofSlab: 0.35,                        // roof frame slab on top of the walls
  doorHalfW: 5.05, doorH: 6.3, doorZ: 11.12, slatH: 0.42,
  jambX: 5.5,
  apronZ: 2.4, apronH: 0.6,
  pilasterZ: [-12.8, -8.5, -4.5, -0.5, 3.5, 7.5, 10.8],
  towerX: -5.0, towerZ: -10.8,
  pylonColH: 2.6,                        // faceted tower: column under the floating scanner
  craneRestZ: 1.0,
  craneStopsZ: [7.0, -3.0, -8.5, 2.0],   // bridge Z of the work stops (trolley X comes from the shape rails, alternating)
  railRoofH: 0.12, railRoofZ: -1.0, railRoofLen: 20,
  neonBandMin: 0.3,                      // style.neon from which walls get a neon band
  spikeH: 0.9, spikeR: 0.22,
  emblemFront: 1.0,                      // emblem size on the door header
  emblemSide: 2.0, emblemSideZ: 9.15,    // emblem size / position on the long walls (front bay; keeps ≥ 0.15 off the team-painted pilasters)
  emblemBay: 5,                          // bay (between pilasterZ[i] and [i + 1]) with the side emblem – no window there
};

/**
 * Small details of the factory (model units; "Share" = share of the related size, "out" = distance in front of a face,
 * "below" = distance under the wall top / tower top) – the same for every shape.
 */
const DETAIL = {
  apronLift: 0.01,
  plinth: { over: 0.3, h: 0.7, overD: 0.15 },          // hall plinth: wider than the hall, front stays flush
  cornerSegments: 12,
  column: { w: 0.45, extraH: 0.1, d: 0.6, out: 0.2 },
  rib: { rTop: 0.26, rBottom: 0.3, out: 0.12, segments: 10 },
  fin: { w: 0.9, hShare: 0.92, t: 0.1, out: 0.45, neonW: 0.04, neonShare: 0.8, neonD: 0.14, neonOut: 0.92, neonY: 0.06 },
  buttress: { hShare: 0.8, w: 0.9, d: 0.7, footW: 1.2, footH: 0.5, footD: 1.1, footOut: 0.45 },
  vein: { w: 0.06, hShare: 0.7, d: 0.1, out: 0.45, yShare: 0.45 },
  band: { below: 1.6, inset: 0.4, h: 0.6, t: 0.06 },
  neonBand: { below: 0.95, h: 0.1, t: 0.05 },
  lower: { y: 1.6, h: 1.1, t: 0.05 },
  window: { below: 2.6, belowButtress: 3.2, frameW: 2.5, frameH: 0.85, t: 0.05, glassW: 2.2, glassH: 0.55, glassOut: 0.02 },
  slotZ: [-6.5, -2.5, 1.5], slotY: 2.6,                 // left wall: louvres / lens plates / plasma slots
  louvre: { w: 2.6, h: 1.6, t: 0.12, slats: 4, slatY0: 2.0, slatStep: 0.38, slatW: 2.3, slatH: 0.12, slatT: 0.1, slatOut: 0.08 },
  lensPlate: { t: 0.12, s: 1.4, out: 0.06, neonT: 0.04, neonS: 0.6, neonOut: 0.14 },
  slot: { r: 0.32, h: 1.8, segments: 12, out: 0.05, neonT: 0.06, neonH: 1.4, neonD: 0.12, neonOut: 0.38 },
  crewDoor: {
    z: 9.2, y: 1.25, w: 1.2, h: 2.2, t: 0.08, lightY: 2.6, lightW: 0.3, lightH: 0.15, lightT: 0.1, lightOut: 0.04,
    markLen: 1.6, markH: 0.4, markY: 0.45, markOut: 0.2,
  },
  front: {
    interiorGap: 0.1, interiorT: 0.05, interiorOut: 0.03, jambW: 0.9, jambExtra: 0.7, jambD: 0.6, jambZ: 0.3,
    jambMarkH: 0.5, jambMarkY: 0.3, jambMarkZ: 0.61, footMarkLen: 1.3, footMarkX: 1.15, footMarkY: 0.35, footMarkZ: 0.02,
    headerH: 1.1, headerD: 0.7, neonH: 0.08, neonT: 0.04, neonY: 0.08, neonZ: 0.67, emblemY: 0.6, emblemZ: 0.65,
  },
  clerestory: {
    slabOver: 0.4, w: 5, h: 1.3, d: 18, winX: 2.52, winT: 0.05, winH: 0.5, winD: 16, winY: 0.75,
    holeW: 2.4, holeT: 0.05, holeD: 3.0, holeY: 1.31, markLen: 2.4, markH: 0.3, markY: 1.32, markZ: 1.65,
  },
  armored: {
    slabOver: 0.5, parapetT: 0.35, parapetH: 0.5, parapetOut: 0.07, humpW: 6.0, humpTopW: 4.4, humpH: 0.9, humpD: 18,
    slopeRun: 0.8, winT: 0.04, winH: 0.14, winD: 14, winX: 2.62, winY: 0.45, holeW: 2.2, holeT: 0.05, holeD: 2.8, holeY: 0.91,
  },
  vault: { segments: 20, ribOut: 0.04, ribT: 0.14, neonW: 1.2, neonH: 0.08, neonInset: 4, holeW: 2.2, holeT: 0.08, holeD: 2.6, holeLift: 0.02 },
  ridge: {
    slabOver: 0.3, inset: 2, neonW: 0.08, neonH: 0.06, neonInset: 0.4, neonLift: 0.01,
    spikeY: 0.5, spikeEnd: 0.4, spikeH: 0.9, spikeR: 1.6, edgeT: 0.05, edgeOut: 0.1, edgeInset: 0.4,   // spike Y / H: × rise, R: × LAYOUT.spikeR
  },
  roundTower: {
    rTop: 1.7, rBottom: 1.8, segments: 16, neonR: 1.73, neonH: 0.5, neonBelow: 0.9, domeR: 1.75, domeFlat: 0.4,
    coilLift: 0.5, coilH: 1.6, coilR: 0.5, arcA: [1.3, 0.35, 0], arcB: [-0.9, 0.4, 1.0], beaconLift: 0.2,   // arc anchors: offsets from (tx, tH, tz)
  },
  pylon: { w: 1.4, neonW: 1.5, neonH: 0.08, neonBelow: 0.3, laserR: 0.5, laserTopR: 0.22, laserBelow: 0.55, lasers: 4 },
  boxTower: {
    w: 3.2, taperW: 3.6, taperTopW: 2.8, winBelow: 0.9, winOut: 0.02, winInset: 0.4, winH: 0.45, winT: 0.05, capOver: 0.3,
    capH: 0.3, mastRTop: 0.12, mastRBottom: 0.16, mastH: 0.8, mastLift: 0.55, radarLift: 0.95, beaconLift: 0.3,
  },
  towerBeacon: 1.2,                                     // tower beacon offset from the tower axis (X and Z)
  cornerBeacon: { vaultOut: 0.15, parapetZ: 0.8, inset: 0.6 },
  vent: { pedestalOut: 0.15, pedestalSink: 0.1, pedestalLift: 0.15, segments: 16 },
  pipes: {
    y: 1.7, front: 10.0, back: -12.3, riseBelow: 0.5, r: 0.2, lowFront: 8.5, lowY: 2.4, lowBack: -11.6, lowR: 0.16,
    bracketZ0: -10, bracketZ1: 7, bracketStep: 3.4, bracketY: 2.05, bracketOver: 0.2, bracketH: 1.2, bracketD: 0.15,
    valveR: 0.3, valveH: 0.5, valveZ: -3, wheelR: 0.25, wheelT: 0.06, wheelOut: 0.35,
  },
  conduit: {
    s: 0.25, out: 0.12, y: 1.2, inset: 2, neonW: 0.06, neonH: 0.08, neonInset: 2.2, neonOut: 0.27,
    podZ: [-10, -4, 2, 8], podR: 0.45, podOut: 0.2, podFlat: 0.6, glowOut: 0.35,
  },
  emitters: { z: [-9, -2, 5], w: 0.6, h: 2.6, d: 1.2, lensRTop: 0.16, lensRBottom: 0.2, lensH: 0.18, lensY: 2.69, linkInset: 0.7, linkY: [1.0, 2.2] },
  rearZ: 0.65,                                          // rear equipment: distance behind the hall
  tanks: [[2.6, 3.4], [-1.2, 2.6]], tankY: 0.95, tankR: 0.55,   // tanks: [x, length]
  generator: {
    w: 5.0, h: 2.2, d: 1.0, x: 1.5, slatW: 4.4, slatH: 0.12, slatT: 0.06, slats: 3, slatY0: 0.8, slatStep: 0.45, slatZ: 0.52,
    chimneyX: [3.4, 4.0], chimneyH: 3.8, chimneyR: 0.26,
  },
  coils: { x: [0.5, 3.0], h: 2.2, r: 0.45 },
  lensBlocks: {
    back: 0.6, x: [-0.5, 3.0], w: 1.3, h: 2.4, d: 0.8, lensRTop: 0.22, lensRBottom: 0.28, lensH: 0.2, lensY: 2.5,
    laserY: 2.7, roofLift: 0.1, roofIn: 0.15, linkA: [0.25, 1.4], linkB: [2.25, 1.4],   // link: [x, y]
  },
};

/**
 * Building shapes by style.silhouette (code knows shapes, the style data picks one; unknown → rounded).
 * vents = [x, z] roof slots for fans / radiators / plasma orbs, rails = roof guide rails [{ x, y }] (style.roofRails
 * of them are used), side = equipment along the right wall, emblemY = height of the side emblems.
 */
export const FACTORY_SHAPES = {
  rounded: { // clean hall with a clerestory, columns, box tower with radar, tanks
    wallH: 8.1, hallHalf: 7.2, hallHalfTop: 7.2, hallEdge: 1, roof: 'clerestory', pilaster: 'column', tower: 'box',
    towerTop: 9.9, rear: 'tanks', beamY: 11.0, vents: [[4.7, -7], [4.7, -1], [4.7, 5]], ventR: 0.95, sideX: 7.85,
    side: 'pipes', door: 'rollup', rails: [{ x: -3.3, y: 8.45 }, { x: 3.3, y: 8.45 }], emblemY: 4.3,
  },
  angular: { // armoured sloped walls, buttresses, spiked parapet, tapered tower, generator with chimneys
    wallH: 9.0, hallHalf: 7.4, hallHalfTop: 6.6, hallEdge: 0, roof: 'armored', pilaster: 'buttress', tower: 'tapered',
    towerTop: 10.3, rear: 'generator', beamY: 11.0, vents: [[4.6, -6], [4.6, 3]], ventR: 1.1, sideX: 8.35,
    side: 'pipes', door: 'rollup', rails: [{ x: -4.6, y: 9.35 }], emblemY: 4.6,
  },
  round: { // vaulted hall, round ribs and corners, round tower with a plasma coil, rear coils with arcs
    wallH: 7.1, hallHalf: 7.2, hallHalfTop: 7.2, hallEdge: 0, cornerR: 0.55, roof: 'vault', vaultRise: 3.6,
    pilaster: 'rib', tower: 'round', towerTop: 10.6, rear: 'coils', beamY: 11.3, vents: [[5.4, -6], [5.4, 4]],
    ventR: 0.9, sideX: 7.85, side: 'conduit', door: 'panel', rails: [{ x: 0, y: 10.7 }], emblemY: 3.9,
  },
  faceted: { // slim chamfered hall, diamond ridge, fins, pylon with a floating scanner, laser-linked blocks
    wallH: 7.6, hallHalf: 6.4, hallHalfTop: 6.4, hallEdge: 1, roof: 'ridge', ridgeW: 5.0, ridgeRise: 2.2,
    pilaster: 'fin', tower: 'pylon', towerX: 4.4, towerTop: 12.2, rear: 'lens', beamY: 11.0,
    vents: [[4.1, -6.5], [4.1, -1.5], [4.1, 3.5]], ventR: 0.85, sideX: 7.3, side: 'lasers', door: 'panel',
    rails: [{ x: -4.0, y: 7.95 }], emblemY: 4.1,
  },
};

/**
 * Box without its top and bottom faces (a hollow collar, origin like PartBuilder.box). The caps of a plinth are hidden under the
 * building anyway; leaving them out keeps the surface (and the measured team share) honest. BoxGeometry order: +x −x +y −y +z −z.
 */
function collarBox(b, w, h, d, s, t = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  const all = Array.from(g.index.array);
  g.setIndex(all.slice(0, COLLAR_SIDES_A).concat(all.slice(COLLAR_SIDES_B)));
  if (t.base) g.translate(0, h / 2, 0);
  return b.add(g, s, t);
}
const COLLAR_SIDES_A = 12;   // indices of the two X faces (6 each)
const COLLAR_SIDES_B = 24;   // first index of the two Z faces

const shapeOf = (style) => FACTORY_SHAPES[style.silhouette] ?? FACTORY_SHAPES.rounded;
const railsOf = (kit, shape) => shape.rails.slice(0, Math.max(1, kit.style.roofRails));

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
  const tilt = Math.atan2(hb - ht, H);
  const wallXAt = (y) => hb - (hb - ht) * (y / H);
  // a flat detail on the long walls: side ±1, local box (thickness along X), follows the slope of the wall
  const onWall = (side, y, z, w, h, d, s, out = 0, detail) => b.box(d, h, w, s,
    { x: side * (wallXAt(y) + d / 2 + out), y, z, rz: side * tilt, detail });
  const skel = S.teamPaint;               // structural skeleton / roof deck / tower body: team lacquer
  const roofY = H + L.roofSlab;
  const legged = st.crane === 'gantry' || st.crane === 'heavyGantry';
  const neonBands = st.neon >= L.neonBandMin;
  const emblems = [];
  const arcPairs = [];

  // ground: pad, gantry rails, apron marking
  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.ground, { base: true });
  if (legged) for (const side of [-1, 1]) b.box(L.groundRailW, L.groundRailH, L.railHalfZ * 2, S.frame, { base: true, x: side * L.railX, y: L.padH });
  marking(b, kit, L.doorHalfW * 2, L.apronH, { rx: -Math.PI / 2, y: L.padH + D.apronLift, z: L.hallZ1 + L.apronZ });

  // hall body
  const P = D.plinth;
  collarBox(b, hb * 2 + P.over, P.h, hallD + P.overD, skel, { base: true, z: hallCz - P.overD / 2, detail: TEAM.lod });   // team plinth; front stays flush (door)
  if (hb !== ht) b.taperedBox(hb * 2, ht * 2, H, hallD, S.hull, { z: hallCz });
  else styledBox(b, kit, hb * 2, H, hallD, S.hull, { base: true, z: hallCz }, shape.hallEdge);
  if (shape.cornerR) {
    for (const sx of [-1, 1]) {
      for (const z of [L.hallZ0, L.hallZ1]) b.cylinder(shape.cornerR, shape.cornerR, H, D.cornerSegments, S.hull, { x: sx * hb, y: H / 2, z });
    }
  }

  // long walls: pilasters / buttresses / ribs / fins, bands, windows, lower plates, side emblem in the front bay
  const Wn = D.window;
  for (const side of [-1, 1]) {
    for (const z of L.pilasterZ) {
      switch (shape.pilaster) {
        case 'column': {
          const c = D.column;
          b.box(c.w, H + c.extraH, c.d, skel, { base: true, x: side * (hb + c.out), z, detail: TEAM.lod });
          break;
        }
        case 'rib': {
          const r = D.rib;
          b.cylinder(r.rTop, r.rBottom, H, r.segments, skel, { x: side * (hb + r.out), y: H / 2, z, detail: TEAM.lod });
          break;
        }
        case 'fin': {
          const f = D.fin;
          b.box(f.w, H * f.hShare, f.t, skel, { base: true, x: side * (hb + f.out), z, detail: TEAM.lod });
          neonStrip(b, kit, f.neonW, H * f.neonShare, f.neonD, { base: true, x: side * (hb + f.neonOut), y: H * f.neonY, z });
          break;
        }
        default: { // buttress
          const t = D.buttress;
          const bh = H * t.hShare;
          onWall(side, bh / 2, z, t.w, bh, t.d, skel, 0, TEAM.lod);
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
    const winY = H - (shape.pilaster === 'buttress' ? Wn.belowButtress : Wn.below);
    for (let i = 0; i < L.pilasterZ.length - 1; i++) {
      if (i === L.emblemBay) continue;
      const z = (L.pilasterZ[i] + L.pilasterZ[i + 1]) / 2;
      onWall(side, winY, z, Wn.frameW, Wn.frameH, Wn.t, S.frame);
      onWall(side, winY, z, Wn.glassW, Wn.glassH, Wn.t, S.window, Wn.glassOut);
    }
    if (side === 1 && shape.pilaster !== 'buttress') {   // wall plates between the pilasters (the left wall has doors / slots, the armoured one its lower plates)
      const Bp = TEAM.bay;
      for (let i = 0; i < L.pilasterZ.length - 1; i++) {
        if (i === L.emblemBay) continue;   // the emblem decal keeps its wall free of team paint
        const z0 = L.pilasterZ[i];
        const z1 = L.pilasterZ[i + 1];
        onWall(side, Bp.y + Bp.h / 2, (z0 + z1) / 2, z1 - z0 - Bp.margin, Bp.h, Bp.t, skel, 0, TEAM.lod);
      }
    }
    const ey = shape.emblemY;
    emblems.push({ position: [side * wallXAt(ey), ey, L.emblemSideZ], normal: [side * Math.cos(tilt), Math.sin(tilt), 0], size: L.emblemSide });
  }
  // rear colour band
  b.box(ht * 2 - D.band.inset, D.band.h, D.band.t, S.team, { y: H - D.band.below, z: L.hallZ0 - D.band.t / 2 });
  // big team panel on the rear wall (the origin of teamPanel is on the wall, ry = π turns it toward −Z)
  const RP = TEAM.rearPanel;
  teamPanel(b, kit, ht * 2 - RP.w, RP.h, { y: H - D.band.below - D.band.h / 2 - RP.gap - RP.h / 2, z: L.hallZ0, ry: Math.PI });

  // left wall: louvres (industrial) / diamond lens plates (fins) / plasma slots; personnel door
  for (const z of D.slotZ) {
    const sy = D.slotY;
    if (st.industrial) {
      const l = D.louvre;
      onWall(-1, sy, z, l.w, l.h, l.t, S.frame);
      for (let k = 0; k < l.slats; k++) onWall(-1, l.slatY0 + k * l.slatStep, z, l.slatW, l.slatH, l.slatT, S.dark, l.slatOut);
    } else if (shape.pilaster === 'fin') {
      const p = D.lensPlate;
      b.box(p.t, p.s, p.s, S.hullDark, { x: -(hb + p.out), y: sy, z, rx: Math.PI / 4 });
      b.box(p.neonT, p.neonS, p.neonS, S.neon, { x: -(hb + p.neonOut), y: sy, z, rx: Math.PI / 4 });
    } else {
      const s = D.slot;
      b.cylinder(s.r, s.r, s.h, s.segments, S.hullDark, { x: -(hb + s.out), y: sy, z });
      b.box(s.neonT, s.neonH, s.neonD, S.neon, { x: -(hb + s.neonOut), y: sy, z });
    }
  }
  const cd = D.crewDoor;
  onWall(-1, cd.y, cd.z, cd.w, cd.h, cd.t, S.hullDark);
  onWall(-1, cd.lightY, cd.z, cd.lightW, cd.lightH, cd.lightT, st.lights === 'lamp' ? S.lamp : S.window, cd.lightOut);
  marking(b, kit, cd.markLen, cd.markH, { ry: -Math.PI / 2, x: -(wallXAt(cd.markY) + cd.markOut), y: cd.markY, z: cd.z });

  // front: interior glow behind the door, jambs with markings, header with the emblem, beacons
  const F = D.front;
  const zf = L.hallZ1;
  b.box(L.doorHalfW * 2, L.doorH - F.interiorGap, F.interiorT, S.interior, { base: true, y: L.padH, z: zf + F.interiorOut });
  for (const side of [-1, 1]) {
    b.box(F.jambW, L.doorH + F.jambExtra, F.jambD, skel, { base: true, x: side * L.jambX, z: zf + F.jambZ, detail: TEAM.lod });
    marking(b, kit, L.doorH, F.jambMarkH, { rz: Math.PI / 2, x: side * L.jambX, y: L.doorH / 2 + F.jambMarkY, z: zf + F.jambMarkZ });
    marking(b, kit, F.footMarkLen, F.jambMarkH, { x: side * (L.jambX + F.footMarkX), y: F.footMarkY, z: zf + F.footMarkZ });
    beacon(b, glows.get('beaconA'), kit, [side * L.jambX, L.doorH + F.headerH, zf + F.jambZ]);
  }
  b.box(L.jambX * 2 + F.jambW, F.headerH, F.headerD, S.frame, { base: true, y: L.doorH, z: zf + F.jambZ });
  if (neonBands) neonStrip(b, kit, L.jambX * 2 + F.jambW, F.neonH, F.neonT, { y: L.doorH + F.neonY, z: zf + F.neonZ });
  emblems.push({ position: [0, L.doorH + F.emblemY, zf + F.emblemZ], normal: [0, 0, 1], size: L.emblemFront });

  // roof
  if (shape.roof === 'clerestory') {
    const c = D.clerestory;
    b.box(hb * 2 + c.slabOver, L.roofSlab, hallD + c.slabOver, skel, { base: true, y: H, z: hallCz, detail: TEAM.lod });
    styledBox(b, kit, c.w, c.h, c.d, S.hull, { base: true, y: roofY, z: hallCz });
    for (const side of [-1, 1]) b.box(c.winT, c.winH, c.winD, S.window, { x: side * c.winX, y: roofY + c.winY, z: hallCz });
    b.box(c.holeW, c.holeT, c.holeD, S.hole, { y: roofY + c.holeY, z: hallCz });
    for (const e of [-1, 1]) marking(b, kit, c.markLen, c.markH, { rx: -Math.PI / 2, y: roofY + c.markY, z: hallCz + e * c.markZ });
  } else if (shape.roof === 'armored') {
    const A = D.armored;
    b.box(ht * 2 + A.slabOver, L.roofSlab, hallD + A.slabOver, skel, { base: true, y: H, z: hallCz, detail: TEAM.lod });
    for (const side of [-1, 1]) {
      b.box(A.parapetT, A.parapetH, hallD + A.slabOver, S.hullDark, { base: true, x: side * (ht + A.parapetOut), y: roofY, z: hallCz });
      b.box(ht * 2 + A.slabOver, A.parapetH, A.parapetT, S.hullDark, { base: true, y: roofY, z: hallCz + side * (hallD / 2 + A.parapetOut) });
      for (const e of [-1, 1]) {
        spike(b, kit, { x: side * (ht + A.parapetOut), y: roofY + A.parapetH, z: hallCz + e * (hallD / 2 + A.parapetOut), h: L.spikeH, r: L.spikeR });
      }
    }
    b.taperedBox(A.humpW, A.humpTopW, A.humpH, A.humpD, S.hull, { y: roofY, z: hallCz });
    const a = Math.atan2(A.slopeRun, A.humpH);
    for (const side of [-1, 1]) b.box(A.winT, A.winH, A.winD, S.window, { x: side * A.winX, y: roofY + A.winY, z: hallCz, rz: side * a });
    b.box(A.holeW, A.holeT, A.holeD, S.hole, { y: roofY + A.holeY, z: hallCz });
  } else if (shape.roof === 'vault') {
    const V = D.vault;
    const r = hb;
    const k = shape.vaultRise / r;
    // the vault is cut into three arcs: neutral flanks and a team-lacquer centre stripe (share TEAM.vaultTeam of the arc)
    const flank = (1 - TEAM.vaultTeam) / 2;
    const arcs = [[0, flank, S.hull], [flank, TEAM.vaultTeam, S.teamPaint], [flank + TEAM.vaultTeam, flank, S.hull]];
    for (const [from, share, s] of arcs) {
      b.cylinder(r, r, hallD, Math.max(2, Math.round(V.segments * share)), s, { rx: Math.PI / 2, sz: k, y: H, z: hallCz, detail: s === S.hull ? undefined : TEAM.lod },
        false, Math.PI / 2 + Math.PI * from, Math.PI * share);
    }
    for (const z of L.pilasterZ) b.torus(r + V.ribOut, V.ribT, 4, 16, Math.PI, skel, { sy: k, y: H, z, detail: TEAM.lod });
    neonStrip(b, kit, V.neonW, V.neonH, hallD - V.neonInset, { y: H + shape.vaultRise, z: hallCz });
    b.box(V.holeW, V.holeT, V.holeD, S.hole, { y: H + shape.vaultRise + V.holeLift, z: hallCz });
  } else { // ridge: diamond prism along the hall, light lines on the deck edges, spikes at the ridge ends
    const R = D.ridge;
    b.box(hb * 2 + R.slabOver, L.roofSlab, hallD + R.slabOver, skel, { base: true, y: H, z: hallCz, detail: TEAM.lod });
    const ridgeLen = hallD - R.inset;
    const g = new THREE.BoxGeometry(1, 1, ridgeLen);
    g.rotateZ(Math.PI / 4);
    g.scale(shape.ridgeW / Math.SQRT2, shape.ridgeRise * Math.SQRT2, 1);
    b.add(g, S.hull, { y: roofY, z: hallCz });
    neonStrip(b, kit, R.neonW, R.neonH, ridgeLen - R.neonInset, { y: roofY + shape.ridgeRise + R.neonLift, z: hallCz });
    for (const e of [-1, 1]) {
      spike(b, kit, {
        x: 0, y: roofY + shape.ridgeRise * R.spikeY, z: hallCz + e * (ridgeLen / 2 - R.spikeEnd), h: shape.ridgeRise * R.spikeH, r: L.spikeR * R.spikeR, s: S.trim,
      });
      neonStrip(b, kit, R.edgeT, R.edgeT, hallD - R.edgeInset, { x: e * (hb + R.edgeOut), y: roofY + R.edgeT / 2, z: hallCz });
    }
  }
  const rails = railsOf(kit, shape);
  roofRails(b, kit, rails, { z: L.railRoofZ, length: L.railRoofLen });

  // tower (rear): box / tapered with radar, round with a plasma coil, pylon with a floating scanner held by lasers
  const tx = shape.towerX ?? L.towerX;
  const tz = L.towerZ;
  const tH = shape.towerTop;
  let head = null;
  let towerBeaconY = null;
  if (shape.tower === 'round') {
    const T = D.roundTower;
    b.cylinder(T.rTop, T.rBottom, tH, T.segments, skel, { x: tx, y: tH / 2, z: tz, detail: TEAM.lod });
    b.cylinder(T.neonR, T.neonR, T.neonH, T.segments, S.neon, { x: tx, y: tH - T.neonBelow, z: tz }, true);
    b.sphere(T.domeR, T.segments, 8, S.hull, { x: tx, y: tH, z: tz, sy: T.domeFlat });
    const top = plasmaCoil(b, glows.get('pulse'), kit, { x: tx, y: tH + T.coilLift, z: tz, h: T.coilH, r: T.coilR });
    arcPairs.push([top, [tx + T.arcA[0], tH + T.arcA[1], tz + T.arcA[2]]], [top, [tx + T.arcB[0], tH + T.arcB[1], tz + T.arcB[2]]]);
    towerBeaconY = tH + T.beaconLift;
  } else if (shape.tower === 'pylon') {
    const Y = D.pylon;
    const colTop = roofY + L.pylonColH;
    styledBox(b, kit, Y.w, L.pylonColH, Y.w, skel, { base: true, x: tx, y: roofY, z: tz, ry: Math.PI / 4, detail: TEAM.lod });
    b.box(Y.neonW, Y.neonH, Y.neonW, S.neon, { x: tx, y: colTop - Y.neonBelow, z: tz, ry: Math.PI / 4 });
    for (let k = 0; k < Y.lasers; k++) {
      const a = (k * Math.PI) / 2;
      laserLink(b, glows.get('laser'), kit, [tx + Math.cos(a) * Y.laserR, colTop, tz + Math.sin(a) * Y.laserR],
        [tx + Math.cos(a) * Y.laserTopR, tH - Y.laserBelow, tz + Math.sin(a) * Y.laserTopR]);
    }
    head = { kind: 'scanner', x: tx, y: tH, z: tz };
  } else {
    const T = D.boxTower;
    const tapered = shape.tower === 'tapered';
    const bw = tapered ? T.taperW : T.w;
    const tw = tapered ? T.taperTopW : T.w;
    if (tapered) b.taperedBox(bw, tw, tH, bw, skel, { x: tx, z: tz, detail: TEAM.lod }, tw);
    else styledBox(b, kit, bw, tH, bw, skel, { base: true, x: tx, z: tz, detail: TEAM.lod });
    const wy = tH - T.winBelow;
    const half = bw / 2 - ((bw - tw) / 2) * (wy / tH) + T.winOut;
    for (const side of [-1, 1]) {
      b.box(tw - T.winInset, T.winH, T.winT, S.window, { x: tx, y: wy, z: tz + side * half });
      b.box(T.winT, T.winH, tw - T.winInset, S.window, { x: tx + side * half, y: wy, z: tz });
    }
    b.box(tw + T.capOver, T.capH, tw + T.capOver, S.frame, { base: true, x: tx, y: tH, z: tz });
    b.cylinder(T.mastRTop, T.mastRBottom, T.mastH, 8, S.frame, { x: tx, y: tH + T.mastLift, z: tz });
    if (st.industrial) head = { kind: 'radar', x: tx, y: tH + T.radarLift, z: tz };
    towerBeaconY = tH + T.beaconLift;
  }
  if (towerBeaconY !== null) beacon(b, glows.get('beaconA'), kit, [tx + D.towerBeacon, towerBeaconY, tz + D.towerBeacon]);
  // rear right roof corner beacon (vault: on the rear corner rib; armoured: on the parapet)
  const cb = D.cornerBeacon;
  const rb = shape.roof === 'vault' ? [hb + cb.vaultOut, H, L.pilasterZ[0]]
    : shape.roof === 'armored' ? [ht + D.armored.parapetOut, roofY + D.armored.parapetH, L.hallZ0 + cb.parapetZ]
      : [ht - cb.inset, roofY, L.hallZ0 + cb.inset];
  beacon(b, glows.get('beaconA'), kit, rb);

  // roof vents: fans / radiators / plasma orbs (vault: on a pedestal following the vault)
  const vents = [];
  for (const [fx, fz] of shape.vents) {
    let y = roofY;
    if (shape.roof === 'vault') {
      const Vt = D.vent;
      const r = hb;
      const R = shape.ventR + Vt.pedestalOut;
      const vh = (x) => H + shape.vaultRise * Math.sqrt(Math.max(0, 1 - (x / r) ** 2));
      const base = vh(fx + R) - Vt.pedestalSink;
      const top = vh(fx - R) + Vt.pedestalLift;
      b.cylinder(R, R, top - base, Vt.segments, S.hullDark, { x: fx, y: (base + top) / 2, z: fz });
      y = top;
    }
    vents.push(ventUnit(b, glows, kit, { x: fx, y, z: fz, r: shape.ventR }));
  }

  // right wall equipment: pipes on brackets (industrial) / plasma conduit / laser-linked emitter blocks
  const px = shape.sideX;
  const Pp = D.pipes;
  if (shape.side === 'pipes' && pipeRun(b, kit, [[px, Pp.y, Pp.front], [px, Pp.y, Pp.back], [px, H - Pp.riseBelow, Pp.back]], Pp.r)) {
    pipeRun(b, kit, [[px, L.padH, Pp.lowFront], [px, Pp.lowY, Pp.lowFront], [px, Pp.lowY, Pp.lowBack], [px, L.padH, Pp.lowBack]], Pp.lowR);
    for (let z = Pp.bracketZ0; z <= Pp.bracketZ1; z += Pp.bracketStep) {
      const wx = wallXAt(Pp.bracketY);
      b.box(px - wx + Pp.bracketOver, Pp.bracketH, Pp.bracketD, S.frame, { x: (px + wx) / 2, y: Pp.bracketY, z });
    }
    b.cylinder(Pp.valveR, Pp.valveR, Pp.valveH, 8, S.hullDark, { x: px, y: Pp.lowY, z: Pp.valveZ });   // valve housing
    b.cylinder(Pp.wheelR, Pp.wheelR, Pp.wheelT, 10, S.accent, { rz: Math.PI / 2, x: px + Pp.wheelOut, y: Pp.lowY, z: Pp.valveZ });
  } else if (shape.side === 'conduit') {
    const C = D.conduit;
    b.box(C.s, C.s, hallD - C.inset, S.hullDark, { x: hb + C.out, y: C.y, z: hallCz });
    neonStrip(b, kit, C.neonW, C.neonH, hallD - C.neonInset, { x: hb + C.neonOut, y: C.y, z: hallCz });
    for (const z of C.podZ) {
      b.sphere(C.podR, 12, 8, S.trim, { x: hb + C.podOut, y: C.y, z, sx: C.podFlat });
      glows.get('pulse').point([hb + C.glowOut, C.y, z], PROC_MODULES.glow.radius);
    }
  } else if (shape.side === 'lasers') {
    const E = D.emitters;
    const zs = E.z;
    for (const z of zs) {
      styledBox(b, kit, E.w, E.h, E.d, S.hullDark, { base: true, x: px, y: L.padH, z });
      b.cylinder(E.lensRTop, E.lensRBottom, E.lensH, 10, S.lens, { x: px, y: L.padH + E.lensY, z });
    }
    for (let i = 0; i < zs.length - 1; i++) {
      for (const y of E.linkY) laserLink(b, glows.get('laser'), kit, [px, y, zs[i] + E.linkInset], [px, y, zs[i + 1] - E.linkInset]);
    }
  }

  // rear equipment
  const rz = L.hallZ0 - D.rearZ;
  if (shape.rear === 'tanks') {
    for (const [cx, len] of D.tanks) tank(b, kit, { x: cx, y: D.tankY, z: rz, r: D.tankR, len, floorY: L.padH });
  } else if (shape.rear === 'generator') {
    const G = D.generator;
    b.box(G.w, G.h, G.d, S.hullDark, { base: true, x: G.x, z: rz });
    for (let k = 0; k < G.slats; k++) b.box(G.slatW, G.slatH, G.slatT, S.lower, { x: G.x, y: G.slatY0 + k * G.slatStep, z: rz - G.slatZ });
    for (const sx of G.chimneyX) chimney(b, kit, { x: sx, y: 0, z: rz, h: G.chimneyH, r: G.chimneyR });
  } else if (shape.rear === 'coils') {
    const C = D.coils;
    const tops = C.x.map((cx) => plasmaCoil(b, glows.get('pulse'), kit, { x: cx, y: L.padH, z: rz, h: C.h, r: C.r }));
    arcPairs.push([tops[0], tops[1]]);
  } else if (shape.rear === 'lens') {
    const Lb = D.lensBlocks;
    const bz = L.hallZ0 - Lb.back;
    for (const cx of Lb.x) {
      styledBox(b, kit, Lb.w, Lb.h, Lb.d, S.hullDark, { base: true, x: cx, y: L.padH, z: bz });
      b.cylinder(Lb.lensRTop, Lb.lensRBottom, Lb.lensH, 10, S.lens, { x: cx, y: L.padH + Lb.lensY, z: bz });
      laserLink(b, glows.get('laser'), kit, [cx, L.padH + Lb.laserY, bz], [cx, roofY + Lb.roofLift, L.hallZ0 + Lb.roofIn]);
    }
    laserLink(b, glows.get('laser'), kit, [Lb.linkA[0], Lb.linkA[1], bz], [Lb.linkB[0], Lb.linkB[1], bz]);
  }

  return { geometry: b.buildLods(), glows: glows.build(), vents, head, arcPairs, emblems };
}

// ---------------------------------------------------------------- animated parts

function buildRadarHead(S) {
  const b = new PartBuilder();
  const tiltX = Math.PI / 2 - 0.4;
  b.cylinder(0.35, 0.35, 0.2, 12, S.frame, { y: 0.1 });
  b.box(0.3, 0.6, 0.3, S.hullDark, { y: 0.5 });
  b.cylinder(1.0, 0.15, 0.35, 16, S.trim, { rx: tiltX, y: 0.9, z: 0.15 });
  b.cylinder(0.03, 0.03, 1.0, 6, S.frame, { rx: tiltX, y: 0.9 + Math.cos(tiltX) * 0.5, z: 0.15 + Math.sin(tiltX) * 0.5 });
  b.box(0.5, 0.4, 0.3, S.hullDark, { y: 0.85, z: -0.5 });
  b.box(0.2, 0.1, 0.05, S.team, { y: 1.0, z: -0.66 });
  return b.build();
}

/** Floating crystal scanner of the pylon tower (turns; a neon scan line and a lens on its side) */
function buildScannerHead(S) {
  const b = new PartBuilder();
  const g = new THREE.OctahedronGeometry(0.55, 0);
  g.scale(1, 1.6, 1);
  b.add(g, S.trim);
  b.box(1.4, 0.06, 0.06, S.neon);
  b.cylinder(0.12, 0.12, 0.2, 8, S.lens, { x: 0.75, rz: Math.PI / 2 });
  return b.build();
}

function buildDoor(kit, shape) {
  const L = LAYOUT;
  const S = kit.S;
  const b = new PartBuilder();
  if (shape.door === 'panel') {   // one smooth panel with light seams
    b.box(L.doorHalfW * 2, L.doorH, 0.12, S.hull, { y: -L.doorH / 2 });
    for (let k = 1; k <= 3; k++) neonStrip(b, kit, L.doorHalfW * 2 - 0.4, 0.04, 0.03, { y: (-L.doorH * k) / 4, z: 0.07 });
  } else {                        // roll-up slats
    const n = Math.ceil(L.doorH / L.slatH);
    const h = L.doorH / n;
    for (let i = 0; i < n; i++) b.box(L.doorHalfW * 2, h * 0.92, 0.12, i % 2 ? S.hullDark : S.hull, { y: -(i + 0.5) * h });
    b.box(L.doorHalfW * 2, 0.25, 0.16, S.frame, { y: -L.doorH + 0.125 });
  }
  b.box(1.6, 0.35, 0.05, S.team, { y: -1.2, z: 0.07 });
  return b.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const shape = shapeOf(kit.style);
  const st = buildStatic(kit, shape);
  const fans = st.vents.filter((v) => v.fan);
  const rings = st.vents.filter((v) => v.ring);
  return {
    shape,
    static: st.geometry,
    glow: st.glows,
    emblem: emblemDecalGeometry(st.emblems),
    fanBases: fans.map((v) => v.fan),
    fan: fans.length ? fanBladesGeometry(kit, fans[0].r, fans[0].blades) : null,
    ringSpots: rings.map((v) => [v.ring.x, v.ring.y, v.ring.z]),
    ring: rings.length ? ringGeometry(kit, rings[0].ring.r) : null,
    head: st.head ? { ...st.head, geometry: st.head.kind === 'radar' ? buildRadarHead(kit.S) : buildScannerHead(kit.S) } : null,
    arcs: st.arcPairs.length ? arcGeometry(st.arcPairs, FACTORY_ANIM.arcSeed) : null,
    crane: buildCraneGeometry(kit, { legX: LAYOUT.legX, beamY: shape.beamY, rails: railsOf(kit, shape), railH: LAYOUT.railRoofH }),
    door: buildDoor(kit, shape),
  };
}

const FACTORY_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class VehicleFactoryProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: FACTORY_CACHE, name: 'VehicleFactoryProc' });
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
    const A = FACTORY_ANIM;
    const gc = kit.glowColors;
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

    // always turning: fans, radar / scanner
    this.spinners = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(x, y, z);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * A.fanSpeedJitter;
      this.spinners.push(new Spinner(fan, {
        speed: A.fanSpeed * an.spin * (1 + jitter) * (i % 2 ? -1 : 1), phase: (seq * 0.7 + i * 1.3) % (Math.PI * 2),
      }));
    });
    if (sh.head) {
      const head = this.paintMesh(sh.head.geometry);
      head.position.set(sh.head.x, sh.head.y, sh.head.z);
      this.spinners.push(new Spinner(head, { speed: (sh.head.kind === 'radar' ? A.radarSpeed : A.scannerSpeed) * an.spin, phase: seq * 0.9 }));
    }
    // levitating rings over plasma orbs
    const lev = PROC_MODULES.levitate;
    this.levitators = sh.ringSpots.map(([x, y, z], i) => {
      const ring = this.paintMesh(sh.ring);
      ring.position.set(x, y, z);
      return new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin * (i % 2 ? -1 : 1), phase: seq * 0.37 + i * 0.5 });
    });

    this.crane = new CraneRig(this, sh.crane, kit, { rails: railsOf(kit, sh.shape), restZ: LAYOUT.craneRestZ, stopsZ: LAYOUT.craneStopsZ });

    this.door = this.paintMesh(sh.door);
    this.door.position.set(0, LAYOUT.padH + LAYOUT.doorH, LAYOUT.doorZ);
    this.doorOpen = 0;
    this.heat = 0;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). Fans / radar / scanner always turn, plasma and lasers pulse (dimmer when
   * idle); while producing the crane works, the door opens, beacons blink, radiators heat up, arcs flash, rings float
   * faster. Parts ease back to rest when production stops.
   * @param {number} delta         seconds
   * @param {boolean} isProducing
   */
  update(delta, isProducing = false) {
    const an = this.kit.style.anim;
    const A = FACTORY_ANIM;
    this.time += delta;
    for (let i = 0; i < this.spinners.length; i++) this.spinners[i].update(delta, true);
    for (let i = 0; i < this.levitators.length; i++) this.levitators[i].update(delta, isProducing);
    const glow = pulseWave(this.time, an.pulse) * (isProducing ? 1 : A.idleGlow);
    this.pulseGlow?.setIntensity(glow);
    this.laserGlow?.setIntensity(glow);
    this.heat += ((isProducing ? 1 : 0) - this.heat) * Math.min(1, delta * an.glowRamp);
    this.heatGlow?.setIntensity(this.heat);
    this.arcs?.update(delta, isProducing);
    this.blink.update(delta, isProducing);
    this.beacons?.setIntensity(this.blink.on ? 1 : 0);
    this.crane.update(delta, isProducing, this.blink);
    this.doorOpen += ((isProducing ? 1 : 0) - this.doorOpen) * Math.min(1, delta * A.doorSpeed);
    this.door.scale.y = 1 - this.doorOpen * (1 - A.doorMinScale);
  }
}
