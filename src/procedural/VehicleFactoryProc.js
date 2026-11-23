// Steel Mans – procedural vehicle factory (roadmap 18, first building of the style kit). A drop-in alternative to
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
  buildCraneGeometry, CraneRig, emblemDecalGeometry, pulseWave, PROC_MODULES,
} from './ProcModules.js';

/** Animation tuning (visual only; the style's anim block multiplies speeds) */
export const FACTORY_ANIM = {
  fanSpeed: 5.5,           // rad/s (× style.anim.spin)
  fanSpeedJitter: 0.25,    // ± share, varies per fan and instance
  radarSpeed: 0.9,         // rad/s
  scannerSpeed: 1.6,       // rad/s – crystal scanner head of the pylon tower
  doorSpeed: 1.6,          // 1/s
  doorMinScale: 0.07,      // rolled-up door height share
  blinkDuty: 0.5,          // beacon period = style.anim.blink
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
  emblemSide: 2.2, emblemSideZ: 9.15,    // emblem size / position on the long walls (front bay)
  emblemBay: 5,                          // bay (between pilasterZ[i] and [i + 1]) with the side emblem – no window there
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

const shapeOf = (style) => FACTORY_SHAPES[style.silhouette] ?? FACTORY_SHAPES.rounded;
const railsOf = (kit, shape) => shape.rails.slice(0, Math.max(1, kit.style.roofRails));

// ---------------------------------------------------------------- static part (one mesh per style)

function buildStatic(kit, shape) {
  const L = LAYOUT;
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
  const onWall = (side, y, z, w, h, d, s, out = 0) => b.box(d, h, w, s,
    { x: side * (wallXAt(y) + d / 2 + out), y, z, rz: side * tilt });
  const roofY = H + L.roofSlab;
  const legged = st.crane === 'gantry' || st.crane === 'heavyGantry';
  const neonBands = st.neon >= L.neonBandMin;
  const emblems = [];
  const arcPairs = [];

  // ground: pad, gantry rails, apron marking
  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.ground, { base: true });
  if (legged) for (const side of [-1, 1]) b.box(L.groundRailW, L.groundRailH, L.railHalfZ * 2, S.frame, { base: true, x: side * L.railX, y: L.padH });
  marking(b, kit, L.doorHalfW * 2, L.apronH, { rx: -Math.PI / 2, y: L.padH + 0.01, z: L.hallZ1 + L.apronZ });

  // hall body
  b.box(hb * 2 + 0.3, 0.7, hallD + 0.15, S.hullDark, { base: true, z: hallCz - 0.075 });   // front stays flush (door)
  if (hb !== ht) b.taperedBox(hb * 2, ht * 2, H, hallD, S.hull, { z: hallCz });
  else styledBox(b, kit, hb * 2, H, hallD, S.hull, { base: true, z: hallCz }, shape.hallEdge);
  if (shape.cornerR) {
    for (const sx of [-1, 1]) for (const z of [L.hallZ0, L.hallZ1]) b.cylinder(shape.cornerR, shape.cornerR, H, 12, S.hull, { x: sx * hb, y: H / 2, z });
  }

  // long walls: pilasters / buttresses / ribs / fins, bands, windows, lower plates, side emblem in the front bay
  for (const side of [-1, 1]) {
    for (const z of L.pilasterZ) {
      switch (shape.pilaster) {
        case 'column': b.box(0.45, H + 0.1, 0.6, S.frame, { base: true, x: side * (hb + 0.2), z }); break;
        case 'rib': b.cylinder(0.26, 0.3, H, 10, S.hullDark, { x: side * (hb + 0.12), y: H / 2, z }); break;
        case 'fin':
          b.box(0.9, H * 0.92, 0.1, S.frame, { base: true, x: side * (hb + 0.45), z });
          neonStrip(b, kit, 0.04, H * 0.8, 0.14, { base: true, x: side * (hb + 0.92), y: H * 0.06, z });
          break;
        default: { // buttress
          const bh = H * 0.8;
          onWall(side, bh / 2, z, 0.9, bh, 0.7, S.hullDark);
          b.box(1.2, 0.5, 1.1, S.frame, { base: true, x: side * (hb + 0.45), z });
        }
      }
      if (kit.rich && shape.pilaster !== 'fin') neonStrip(b, kit, 0.06, H * 0.7, 0.1, { x: side * (hb + 0.45), y: H * 0.45, z });
    }
    onWall(side, H - 1.6, hallCz, hallD - 0.4, 0.6, 0.06, S.team);
    if (neonBands) onWall(side, H - 0.95, hallCz, hallD - 0.4, 0.1, 0.05, S.neon);
    if (shape.pilaster === 'buttress') onWall(side, 1.6, hallCz, hallD - 0.4, 1.1, 0.05, S.lower);
    const winY = H - (shape.pilaster === 'buttress' ? 3.2 : 2.6);
    for (let i = 0; i < L.pilasterZ.length - 1; i++) {
      if (i === L.emblemBay) continue;
      const z = (L.pilasterZ[i] + L.pilasterZ[i + 1]) / 2;
      onWall(side, winY, z, 2.5, 0.85, 0.05, S.frame);
      onWall(side, winY, z, 2.2, 0.55, 0.05, S.window, 0.02);
    }
    const ey = shape.emblemY;
    emblems.push({ position: [side * wallXAt(ey), ey, L.emblemSideZ], normal: [side * Math.cos(tilt), Math.sin(tilt), 0], size: L.emblemSide });
  }
  // rear colour band
  b.box(ht * 2 - 0.4, 0.6, 0.06, S.team, { y: H - 1.6, z: L.hallZ0 - 0.03 });

  // left wall: louvres (industrial) / diamond lens plates (fins) / plasma slots; personnel door
  for (const z of [-6.5, -2.5, 1.5]) {
    if (st.industrial) {
      onWall(-1, 2.6, z, 2.6, 1.6, 0.12, S.frame);
      for (let k = 0; k < 4; k++) onWall(-1, 2.0 + k * 0.38, z, 2.3, 0.12, 0.1, S.dark, 0.08);
    } else if (shape.pilaster === 'fin') {
      b.box(0.12, 1.4, 1.4, S.hullDark, { x: -(hb + 0.06), y: 2.6, z, rx: Math.PI / 4 });
      b.box(0.04, 0.6, 0.6, S.neon, { x: -(hb + 0.14), y: 2.6, z, rx: Math.PI / 4 });
    } else {
      b.cylinder(0.32, 0.32, 1.8, 12, S.hullDark, { x: -(hb + 0.05), y: 2.6, z });
      b.box(0.06, 1.4, 0.12, S.neon, { x: -(hb + 0.38), y: 2.6, z });
    }
  }
  onWall(-1, 1.25, 9.2, 1.2, 2.2, 0.08, S.hullDark);
  onWall(-1, 2.6, 9.2, 0.3, 0.15, 0.1, st.lights === 'lamp' ? S.lamp : S.window, 0.04);
  marking(b, kit, 1.6, 0.4, { ry: -Math.PI / 2, x: -(wallXAt(0.45) + 0.2), y: 0.45, z: 9.2 });

  // front: interior glow behind the door, jambs with markings, header with the emblem, beacons
  const zf = L.hallZ1;
  b.box(L.doorHalfW * 2, L.doorH - 0.1, 0.05, S.interior, { base: true, y: L.padH, z: zf + 0.03 });
  for (const side of [-1, 1]) {
    b.box(0.9, L.doorH + 0.7, 0.6, S.frame, { base: true, x: side * L.jambX, z: zf + 0.3 });
    marking(b, kit, L.doorH, 0.5, { rz: Math.PI / 2, x: side * L.jambX, y: L.doorH / 2 + 0.3, z: zf + 0.61 });
    marking(b, kit, 1.3, 0.5, { x: side * (L.jambX + 1.15), y: 0.35, z: zf + 0.02 });
    beacon(b, glows.get('beaconA'), kit, [side * L.jambX, L.doorH + 1.1, zf + 0.3]);
  }
  b.box(L.jambX * 2 + 0.9, 1.1, 0.7, S.frame, { base: true, y: L.doorH, z: zf + 0.3 });
  if (neonBands) neonStrip(b, kit, L.jambX * 2 + 0.9, 0.08, 0.04, { y: L.doorH + 0.08, z: zf + 0.67 });
  emblems.push({ position: [0, L.doorH + 0.6, zf + 0.65], normal: [0, 0, 1], size: L.emblemFront });

  // roof
  if (shape.roof === 'clerestory') {
    b.box(hb * 2 + 0.4, L.roofSlab, hallD + 0.4, S.frame, { base: true, y: H, z: hallCz });
    styledBox(b, kit, 5, 1.3, 18, S.hull, { base: true, y: roofY, z: hallCz });
    for (const side of [-1, 1]) b.box(0.05, 0.5, 16, S.window, { x: side * 2.52, y: roofY + 0.75, z: hallCz });
    b.box(2.4, 0.05, 3.0, S.hole, { y: roofY + 1.31, z: hallCz });
    for (const e of [-1, 1]) marking(b, kit, 2.4, 0.3, { rx: -Math.PI / 2, y: roofY + 1.32, z: hallCz + e * 1.65 });
  } else if (shape.roof === 'armored') {
    b.box(ht * 2 + 0.5, L.roofSlab, hallD + 0.5, S.frame, { base: true, y: H, z: hallCz });
    for (const side of [-1, 1]) {
      b.box(0.35, 0.5, hallD + 0.5, S.hullDark, { base: true, x: side * (ht + 0.07), y: roofY, z: hallCz });
      b.box(ht * 2 + 0.5, 0.5, 0.35, S.hullDark, { base: true, y: roofY, z: hallCz + side * (hallD / 2 + 0.07) });
      for (const e of [-1, 1]) {
        spike(b, kit, { x: side * (ht + 0.07), y: roofY + 0.5, z: hallCz + e * (hallD / 2 + 0.07), h: L.spikeH, r: L.spikeR });
      }
    }
    b.taperedBox(6.0, 4.4, 0.9, 18, S.hull, { y: roofY, z: hallCz });
    const a = Math.atan2(0.8, 0.9);
    for (const side of [-1, 1]) b.box(0.04, 0.14, 14, S.window, { x: side * 2.62, y: roofY + 0.45, z: hallCz, rz: side * a });
    b.box(2.2, 0.05, 2.8, S.hole, { y: roofY + 0.91, z: hallCz });
  } else if (shape.roof === 'vault') {
    const r = hb;
    const k = shape.vaultRise / r;
    b.cylinder(r, r, hallD, 20, S.hull, { rx: Math.PI / 2, sz: k, y: H, z: hallCz }, false, Math.PI / 2, Math.PI);
    for (const z of L.pilasterZ) b.torus(r + 0.04, 0.14, 4, 16, Math.PI, S.hullDark, { sy: k, y: H, z });
    neonStrip(b, kit, 1.2, 0.08, hallD - 4, { y: H + shape.vaultRise, z: hallCz });
    b.box(2.2, 0.08, 2.6, S.hole, { y: H + shape.vaultRise + 0.02, z: hallCz });
  } else { // ridge: diamond prism along the hall, light lines on the deck edges, spikes at the ridge ends
    b.box(hb * 2 + 0.3, L.roofSlab, hallD + 0.3, S.frame, { base: true, y: H, z: hallCz });
    const ridgeLen = hallD - 2;
    const g = new THREE.BoxGeometry(1, 1, ridgeLen);
    g.rotateZ(Math.PI / 4);
    g.scale(shape.ridgeW / Math.SQRT2, shape.ridgeRise * Math.SQRT2, 1);
    b.add(g, S.hull, { y: roofY, z: hallCz });
    neonStrip(b, kit, 0.08, 0.06, ridgeLen - 0.4, { y: roofY + shape.ridgeRise + 0.01, z: hallCz });
    for (const e of [-1, 1]) {
      spike(b, kit, { x: 0, y: roofY + shape.ridgeRise * 0.5, z: hallCz + e * (ridgeLen / 2 - 0.4), h: shape.ridgeRise * 0.9, r: L.spikeR * 1.6, s: S.trim });
      neonStrip(b, kit, 0.05, 0.05, hallD - 0.4, { x: e * (hb + 0.1), y: roofY + 0.025, z: hallCz });
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
    b.cylinder(1.7, 1.8, tH, 16, S.hull, { x: tx, y: tH / 2, z: tz });
    b.cylinder(1.73, 1.73, 0.5, 16, S.neon, { x: tx, y: tH - 0.9, z: tz }, true);
    b.sphere(1.75, 16, 8, S.hull, { x: tx, y: tH, z: tz, sy: 0.4 });
    const top = plasmaCoil(b, glows.get('pulse'), kit, { x: tx, y: tH + 0.5, z: tz, h: 1.6, r: 0.5 });
    arcPairs.push([top, [tx + 1.3, tH + 0.35, tz]], [top, [tx - 0.9, tH + 0.4, tz + 1.0]]);
    towerBeaconY = tH + 0.2;
  } else if (shape.tower === 'pylon') {
    const colTop = roofY + L.pylonColH;
    styledBox(b, kit, 1.4, L.pylonColH, 1.4, S.hullDark, { base: true, x: tx, y: roofY, z: tz, ry: Math.PI / 4 });
    b.box(1.5, 0.08, 1.5, S.neon, { x: tx, y: colTop - 0.3, z: tz, ry: Math.PI / 4 });
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      laserLink(b, glows.get('laser'), kit, [tx + Math.cos(a) * 0.5, colTop, tz + Math.sin(a) * 0.5],
        [tx + Math.cos(a) * 0.22, tH - 0.55, tz + Math.sin(a) * 0.22]);
    }
    head = { kind: 'scanner', x: tx, y: tH, z: tz };
  } else {
    const tapered = shape.tower === 'tapered';
    const bw = tapered ? 3.6 : 3.2;
    const tw = tapered ? 2.8 : 3.2;
    if (tapered) b.taperedBox(bw, tw, tH, bw, S.hull, { x: tx, z: tz }, tw);
    else styledBox(b, kit, bw, tH, bw, S.hull, { base: true, x: tx, z: tz });
    const wy = tH - 0.9;
    const half = bw / 2 - ((bw - tw) / 2) * (wy / tH) + 0.02;
    for (const side of [-1, 1]) {
      b.box(tw - 0.4, 0.45, 0.05, S.window, { x: tx, y: wy, z: tz + side * half });
      b.box(0.05, 0.45, tw - 0.4, S.window, { x: tx + side * half, y: wy, z: tz });
    }
    b.box(tw + 0.3, 0.3, tw + 0.3, S.frame, { base: true, x: tx, y: tH, z: tz });
    b.cylinder(0.12, 0.16, 0.8, 8, S.frame, { x: tx, y: tH + 0.55, z: tz });
    if (st.industrial) head = { kind: 'radar', x: tx, y: tH + 0.95, z: tz };
    towerBeaconY = tH + 0.3;
  }
  if (towerBeaconY !== null) beacon(b, glows.get('beaconA'), kit, [tx + 1.2, towerBeaconY, tz + 1.2]);
  // rear right roof corner beacon (vault: on the rear corner rib; armoured: on the parapet)
  const rb = shape.roof === 'vault' ? [hb + 0.15, H, L.pilasterZ[0]]
    : shape.roof === 'armored' ? [ht + 0.07, roofY + 0.5, L.hallZ0 + 0.8] : [ht - 0.6, roofY, L.hallZ0 + 0.6];
  beacon(b, glows.get('beaconA'), kit, rb);

  // roof vents: fans / radiators / plasma orbs (vault: on a pedestal following the vault)
  const vents = [];
  for (const [fx, fz] of shape.vents) {
    let y = roofY;
    if (shape.roof === 'vault') {
      const r = hb;
      const R = shape.ventR + 0.15;
      const vh = (x) => H + shape.vaultRise * Math.sqrt(Math.max(0, 1 - (x / r) ** 2));
      const base = vh(fx + R) - 0.1;
      const top = vh(fx - R) + 0.15;
      b.cylinder(R, R, top - base, 16, S.hullDark, { x: fx, y: (base + top) / 2, z: fz });
      y = top;
    }
    vents.push(ventUnit(b, glows, kit, { x: fx, y, z: fz, r: shape.ventR }));
  }

  // right wall equipment: pipes on brackets (industrial) / plasma conduit / laser-linked emitter blocks
  const px = shape.sideX;
  if (shape.side === 'pipes' && pipeRun(b, kit, [[px, 1.7, 10.0], [px, 1.7, -12.3], [px, H - 0.5, -12.3]], 0.2)) {
    pipeRun(b, kit, [[px, L.padH, 8.5], [px, 2.4, 8.5], [px, 2.4, -11.6], [px, L.padH, -11.6]], 0.16);
    for (let z = -10; z <= 7; z += 3.4) {
      const wx = wallXAt(2.05);
      b.box(px - wx + 0.2, 1.2, 0.15, S.frame, { x: (px + wx) / 2, y: 2.05, z });
    }
    b.cylinder(0.3, 0.3, 0.5, 8, S.hullDark, { x: px, y: 2.4, z: -3 });   // valve housing
    b.cylinder(0.25, 0.25, 0.06, 10, S.accent, { rz: Math.PI / 2, x: px + 0.35, y: 2.4, z: -3 });
  } else if (shape.side === 'conduit') {
    b.box(0.25, 0.25, hallD - 2, S.hullDark, { x: hb + 0.12, y: 1.2, z: hallCz });
    neonStrip(b, kit, 0.06, 0.08, hallD - 2.2, { x: hb + 0.27, y: 1.2, z: hallCz });
    for (const z of [-10, -4, 2, 8]) {
      b.sphere(0.45, 12, 8, S.trim, { x: hb + 0.2, y: 1.2, z, sx: 0.6 });
      glows.get('pulse').point([hb + 0.35, 1.2, z], PROC_MODULES.glow.radius);
    }
  } else if (shape.side === 'lasers') {
    const zs = [-9, -2, 5];
    for (const z of zs) {
      styledBox(b, kit, 0.6, 2.6, 1.2, S.hullDark, { base: true, x: px, y: L.padH, z });
      b.cylinder(0.16, 0.2, 0.18, 10, S.lens, { x: px, y: L.padH + 2.69, z });
    }
    for (let i = 0; i < zs.length - 1; i++) {
      for (const y of [1.0, 2.2]) laserLink(b, glows.get('laser'), kit, [px, y, zs[i] + 0.7], [px, y, zs[i + 1] - 0.7]);
    }
  }

  // rear equipment
  const rz = L.hallZ0 - 0.65;
  if (shape.rear === 'tanks') {
    for (const [cx, len] of [[2.6, 3.4], [-1.2, 2.6]]) tank(b, kit, { x: cx, y: 0.95, z: rz, r: 0.55, len, floorY: L.padH });
  } else if (shape.rear === 'generator') {
    b.box(5.0, 2.2, 1.0, S.hullDark, { base: true, x: 1.5, z: rz });
    for (let k = 0; k < 3; k++) b.box(4.4, 0.12, 0.06, S.lower, { x: 1.5, y: 0.8 + k * 0.45, z: rz - 0.52 });
    for (const sx of [3.4, 4.0]) chimney(b, kit, { x: sx, y: 0, z: rz, h: 3.8, r: 0.26 });
  } else if (shape.rear === 'coils') {
    const tops = [0.5, 3.0].map((cx) => plasmaCoil(b, glows.get('pulse'), kit, { x: cx, y: L.padH, z: rz, h: 2.2, r: 0.45 }));
    arcPairs.push([tops[0], tops[1]]);
  } else if (shape.rear === 'lens') {
    const bz = L.hallZ0 - 0.6;
    for (const cx of [-0.5, 3.0]) {
      styledBox(b, kit, 1.3, 2.4, 0.8, S.hullDark, { base: true, x: cx, y: L.padH, z: bz });
      b.cylinder(0.22, 0.28, 0.2, 10, S.lens, { x: cx, y: L.padH + 2.5, z: bz });
      laserLink(b, glows.get('laser'), kit, [cx, L.padH + 2.7, bz], [cx, roofY + 0.1, L.hallZ0 + 0.15]);
    }
    laserLink(b, glows.get('laser'), kit, [0.25, 1.4, bz], [2.25, 1.4, bz]);
  }

  return { geometry: b.build(), glows: glows.build(), vents, head, arcPairs, emblems };
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
    const sh = this.shared;
    const kit = this.kit;
    const an = kit.style.anim;
    const A = FACTORY_ANIM;
    const gc = kit.glowColors;
    const seq = instanceCounter++;

    this.paintMesh(sh.static);
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
