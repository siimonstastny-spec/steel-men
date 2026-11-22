// Steel Mans – procedural vehicle factory (prototype N3). A drop-in alternative to
// models/3DStructures{race}/VehicleFactory{race}_Anim.glb built entirely in code (ProcKit):
//   • same footprint as the GLB (hall ±8.56 × ±14.27, gantry legs to ±9.5, front = +Z where units spawn)
//   • one merged static mesh per faction (shared by every instance) + animated parts: roof fans (always spinning),
//     radar (always turning), gantry crane bridge + trolley and roll-up door (move while producing),
//     warning beacons (blink while producing)
//   • faction variants from FACTORY_SPECS (X Earth: steel hall with clerestory, Y Mars: armoured sloped walls,
//     Z Venus: vaulted sealed hall); team colour via the shared paint shader (setTeamColor)
// Visual only: update() takes the frame delta, nothing here is read by the simulation.
import * as THREE from 'three';
import {
  PartBuilder, surface, acquirePaintMaterial, releasePaintMaterial, acquireGlowMaterial, releaseGlowMaterial,
  glowGeometry, triangleCount, TrackMover, Blinker, plateau,
} from './ProcKit.js';

/** Animation tuning (visual only) */
export const FACTORY_ANIM = {
  fanSpeed: 5.5,           // rad/s
  fanSpeedJitter: 0.25,    // ± share, varies per fan and instance
  radarSpeed: 0.9,         // rad/s
  bridgeSpeed: 2.4,        // model units/s, mean speed of the gantry bridge (Z) between stops
  trolleySpeed: 1.6,       // model units/s, mean speed of the trolley (X)
  craneDwell: 3.0,         // s the gantry stays above a work stop (hook goes down and up)
  hookEdge: 0.3,           // share of the dwell for lowering and for raising the hook
  hookRetract: 0.4,        // cable length with the hook up (model units)
  hookMinDrop: 0.9,        // minimum extra cable when the hook is down (model units)
  hookClearance: 0.2,      // gap between the hook block and the guide rail when down
  doorSpeed: 1.6,          // 1/s
  doorMinScale: 0.07,      // rolled-up door height share
  blinkPeriod: 0.9,        // s
  blinkDuty: 0.5,
};

/** Shared layout of every variant (model units, GLB scale; front = +Z) */
const LAYOUT = {
  hallZ0: -13.0, hallZ1: 11.0,          // hall rear / front face
  padHalfX: 9.5, padHalfZ: 14.2, padH: 0.15,
  railX: 8.9, railHalfZ: 14.0,
  legX: 9.15,
  doorHalfW: 5.05, doorH: 6.3, doorZ: 11.12, slatH: 0.42,
  jambX: 5.5,
  pilasterZ: [-12.8, -8.5, -4.5, -0.5, 3.5, 7.5, 10.8],
  towerX: -5.0, towerZ: -10.8,
  craneRestZ: 1.0,
  craneStopsZ: [7.0, -3.0, -8.5, 2.0],   // bridge Z of the work stops (trolley X comes from the spec rails, alternating)
  railRoofW: 0.5, railRoofH: 0.12, railRoofLine: 0.07, railRoofZ: -1.0, railRoofLen: 20, railRoofTieStep: 2.0,
  glowRadius: 0.32,
};

/** Faction variants – shapes and palette (sRGB). Code never names factions: unknown races fall back to X. */
export const FACTORY_SPECS = {
  X: { // Earth – light steel industrial hall with a clerestory and a yellow gantry
    wallH: 8.1, hallHalf: 7.2, hallHalfTop: 7.2, roof: 'clerestory', roofTop: 9.75,
    pilaster: 'column', tower: 'box', towerTop: 9.9, rear: 'tanks', beamY: 11.0,
    fans: [[4.7, -7], [4.7, -1], [4.7, 5]], fanR: 0.95, fanBlades: 5, pipeX: 7.85,
    rails: [{ x: -3.3, y: 8.45 }, { x: 3.3, y: 8.45 }],   // two guide rails on the flat deck beside the clerestory
    pal: {
      hull: '#a7abb1', hullDark: '#61656c', frame: '#3b3e44', concrete: '#7e7c77', pipe: '#56675a',
      accent: '#d9a21b', black: '#1c1c1c', light: '#cdeaff', interior: '#7a6040', beacon: '#ff9418',
      dish: '#c9ccd0', team: '#dadada', lower: '#8d9198',
    },
    hullMetal: 0.35, hullRough: 0.6,
  },
  Y: { // Mars – armoured, sloped walls with buttresses, oxide-red lower plates, amber lights
    wallH: 9.0, hallHalf: 7.4, hallHalfTop: 6.6, roof: 'armored', roofTop: 10.25,
    pilaster: 'buttress', tower: 'box', towerTop: 10.3, rear: 'generator', beamY: 11.0,
    fans: [[4.6, -6], [4.6, 3]], fanR: 1.25, fanBlades: 6, pipeX: 8.35,
    rails: [{ x: -4.6, y: 9.35 }],   // one guide rail on the deck left of the armoured hump (fans are on the right)
    pal: {
      hull: '#7c736b', hullDark: '#4b4541', frame: '#2f2c2a', concrete: '#8a6a58', pipe: '#7b4a33',
      accent: '#c9661f', black: '#1d1a18', light: '#ffb35a', interior: '#7a4a2a', beacon: '#ff4a1a',
      dish: '#a49a90', team: '#d0d0d0', lower: '#8a3f22',
    },
    hullMetal: 0.45, hullRough: 0.72,
  },
  Z: { // Venus – sealed bone-white vaulted hall with ribs, round tower, green-cyan lights
    wallH: 7.1, hallHalf: 7.2, hallHalfTop: 7.2, roof: 'vault', vaultRise: 3.6, roofTop: 10.7,
    pilaster: 'rib', tower: 'round', towerTop: 10.6, rear: 'spheres', beamY: 11.3,
    fans: [[5.4, -6], [5.4, 4]], fanR: 0.9, fanBlades: 4, pipeX: 7.85,   // low on the vault flank: under the gantry
    rails: [{ x: 0, y: 10.7 }],   // one guide rail along the vault crown (over the skylight strip)
    pal: {
      hull: '#d7d9c8', hullDark: '#a2a694', frame: '#5d6158', concrete: '#9a9a86', pipe: '#e6e8dc',
      accent: '#c4cf2e', black: '#20221e', light: '#7dffc8', interior: '#3f6a58', beacon: '#30ffb0',
      dish: '#eef0e4', team: '#dadada', lower: '#bfc2b0',
    },
    hullMetal: 0.2, hullRough: 0.45,
  },
};

const specOf = (race) => FACTORY_SPECS[race] ?? FACTORY_SPECS.X;

// ---------------------------------------------------------------- surfaces of a variant

function surfacesOf(spec) {
  const p = spec.pal;
  return {
    hull: surface(p.hull, { metal: spec.hullMetal, rough: spec.hullRough }),
    hullDark: surface(p.hullDark, { metal: 0.5, rough: 0.6 }),
    frame: surface(p.frame, { metal: 0.8, rough: 0.45 }),
    lower: surface(p.lower, { metal: 0.35, rough: 0.8 }),
    concrete: surface(p.concrete, { metal: 0, rough: 0.95 }),
    pipe: surface(p.pipe, { metal: 0.6, rough: 0.4 }),
    accent: surface(p.accent, { metal: 0.3, rough: 0.55 }),
    black: surface(p.black, { metal: 0.2, rough: 0.8 }),
    rubber: surface(p.black, { metal: 0, rough: 0.95 }),
    team: surface(p.team, { team: 1, metal: 0.3, rough: 0.5 }),
    light: surface(p.light, { metal: 0, rough: 0.3, glow: 1.4 }),
    interior: surface(p.interior, { metal: 0, rough: 0.9, glow: 0.45 }),
    lens: surface(p.beacon, { metal: 0, rough: 0.2, glow: 0.5 }),
    dish: surface(p.dish, { metal: 0.6, rough: 0.35 }),
    hole: surface('#0d0d0d', { metal: 0, rough: 1 }),
  };
}

// ---------------------------------------------------------------- static part (one mesh per faction)

function buildStatic(spec, S) {
  const L = LAYOUT;
  const b = new PartBuilder();
  const H = spec.wallH;
  const hb = spec.hallHalf;
  const ht = spec.hallHalfTop;
  const hallD = L.hallZ1 - L.hallZ0;
  const hallCz = (L.hallZ0 + L.hallZ1) / 2;
  const tilt = Math.atan2(hb - ht, H);
  const wallXAt = (y) => hb - (hb - ht) * (y / H);
  // a flat detail on the long walls: side ±1, local box (thickness along X), follows the slope of the wall
  const onWall = (side, y, z, w, h, d, s, out = 0) => b.box(d, h, w, s,
    { x: side * (wallXAt(y) + d / 2 + out), y, z, rz: side * tilt });

  // ground: pad, rails, apron hazard chevrons
  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.concrete, { base: true });
  for (const side of [-1, 1]) b.box(0.3, 0.25, L.railHalfZ * 2, S.frame, { base: true, x: side * L.railX, y: L.padH });
  b.hazardStrip(L.doorHalfW * 2, 0.6, 0.6, S.accent, S.black, { rx: -Math.PI / 2, y: L.padH + 0.01, z: L.hallZ1 + 2.4 });

  // hall body
  b.box(hb * 2 + 0.3, 0.7, hallD + 0.15, S.hullDark, { base: true, z: hallCz - 0.075 });   // front stays flush (door)
  if (hb === ht) b.box(hb * 2, H, hallD, S.hull, { base: true, z: hallCz });
  else b.taperedBox(hb * 2, ht * 2, H, hallD, S.hull, { z: hallCz });

  // long walls: pilasters / buttresses / ribs, colour bands, windows, lower plates
  for (const side of [-1, 1]) {
    for (const z of L.pilasterZ) {
      if (spec.pilaster === 'column') b.box(0.45, H + 0.1, 0.6, S.frame, { base: true, x: side * (hb + 0.2), z });
      else if (spec.pilaster === 'rib') b.box(0.35, H, 0.5, S.hullDark, { base: true, x: side * (hb + 0.15), z });
      else {
        const bh = H * 0.8;
        onWall(side, bh / 2, z, 0.9, bh, 0.7, S.hullDark);
        b.box(1.2, 0.5, 1.1, S.frame, { base: true, x: side * (hb + 0.45), z });
      }
    }
    onWall(side, H - 1.6, hallCz, hallD - 0.4, 0.6, 0.06, S.team);
    if (spec.pilaster === 'buttress') onWall(side, 1.6, hallCz, hallD - 0.4, 1.1, 0.05, S.lower);
    const winY = H - (spec.pilaster === 'buttress' ? 3.2 : 2.6);
    for (let i = 0; i < L.pilasterZ.length - 1; i++) {
      const z = (L.pilasterZ[i] + L.pilasterZ[i + 1]) / 2;
      onWall(side, winY, z, 2.5, 0.85, 0.05, S.frame);
      onWall(side, winY, z, 2.2, 0.55, 0.05, S.light, 0.02);
    }
  }
  // rear colour band
  b.box(ht * 2 - 0.4, 0.6, 0.06, S.team, { y: H - 1.6, z: L.hallZ0 - 0.03 });

  // left wall: louvre vents and a personnel door
  for (const z of [-6.5, -2.5, 1.5]) {
    onWall(-1, 2.6, z, 2.6, 1.6, 0.12, S.frame);
    for (let k = 0; k < 4; k++) onWall(-1, 2.0 + k * 0.38, z, 2.3, 0.12, 0.1, S.black, 0.08);
  }
  onWall(-1, 1.25, 9.2, 1.2, 2.2, 0.08, S.hullDark);
  onWall(-1, 2.6, 9.2, 0.3, 0.15, 0.1, S.light, 0.04);
  b.hazardStrip(1.6, 0.4, 0.4, S.accent, S.black, { ry: -Math.PI / 2, x: -(wallXAt(0.45) + 0.2), y: 0.45, z: 9.2 });

  // front: door frame, header, sign, hazard jambs, interior glow behind the door, beacon lenses
  const zf = L.hallZ1;
  b.box(L.doorHalfW * 2, L.doorH - 0.1, 0.05, S.interior, { base: true, y: L.padH, z: zf + 0.03 });
  for (const side of [-1, 1]) {
    b.box(0.9, L.doorH + 0.7, 0.6, S.frame, { base: true, x: side * L.jambX, z: zf + 0.3 });
    b.hazardStrip(L.doorH, 0.5, 0.5, S.accent, S.black, { rz: Math.PI / 2, x: side * L.jambX, y: L.doorH / 2 + 0.3, z: zf + 0.61 });
    b.hazardStrip(1.3, 0.5, 0.5, S.accent, S.black, { x: side * (L.jambX + 1.15), y: 0.35, z: zf + 0.02 });
  }
  b.box(L.jambX * 2 + 0.9, 1.1, 0.7, S.frame, { base: true, y: L.doorH, z: zf + 0.3 });
  b.box(3.2, 0.6, 0.05, S.team, { y: L.doorH + 0.55, z: zf + 0.67 });
  const glowStatic = [];
  for (const side of [-1, 1]) {
    const p = [side * L.jambX, L.doorH + 1.5, zf + 0.3];
    b.box(0.35, 0.2, 0.35, S.black, { base: true, x: p[0], y: L.doorH + 1.1, z: p[2] });
    b.cylinder(0.2, 0.2, 0.32, 10, S.lens, { x: p[0], y: L.doorH + 1.46, z: p[2] });
    glowStatic.push(p);
  }

  // roof
  if (spec.roof === 'clerestory') {
    b.box(hb * 2 + 0.4, 0.35, hallD + 0.4, S.frame, { base: true, y: H, z: hallCz });
    const cy = H + 0.35;
    b.box(5, 1.3, 18, S.hull, { base: true, y: cy, z: hallCz });
    for (const side of [-1, 1]) b.box(0.05, 0.5, 16, S.light, { x: side * 2.52, y: cy + 0.75, z: hallCz });
    b.box(2.4, 0.05, 3.0, S.hole, { y: cy + 1.31, z: hallCz });
    for (const e of [-1, 1]) b.hazardStrip(2.4, 0.3, 0.3, S.accent, S.black, { rx: -Math.PI / 2, y: cy + 1.32, z: hallCz + e * 1.65 });
  } else if (spec.roof === 'armored') {
    b.box(ht * 2 + 0.5, 0.35, hallD + 0.5, S.frame, { base: true, y: H, z: hallCz });
    const py = H + 0.35;
    for (const side of [-1, 1]) {
      b.box(0.35, 0.5, hallD + 0.5, S.hullDark, { base: true, x: side * (ht + 0.07), y: py, z: hallCz });
      b.box(ht * 2 + 0.5, 0.5, 0.35, S.hullDark, { base: true, y: py, z: hallCz + side * (hallD / 2 + 0.07) });
    }
    b.taperedBox(6.0, 4.4, 0.9, 18, S.hull, { y: py, z: hallCz });
    const a = Math.atan2(0.8, 0.9);
    for (const side of [-1, 1]) b.box(0.04, 0.14, 14, S.light, { x: side * 2.62, y: py + 0.45, z: hallCz, rz: side * a });
    b.box(2.2, 0.05, 2.8, S.hole, { y: py + 0.91, z: hallCz });
  } else {
    const r = hb;
    const k = spec.vaultRise / r;
    b.cylinder(r, r, hallD, 20, S.hull, { rx: Math.PI / 2, sz: k, y: H, z: hallCz }, false, Math.PI / 2, Math.PI);
    for (const z of L.pilasterZ) b.torus(r + 0.04, 0.14, 4, 16, Math.PI, S.hullDark, { sy: k, y: H, z });
    b.box(1.2, 0.08, hallD - 4, S.light, { y: H + spec.vaultRise, z: hallCz });
    b.box(2.2, 0.08, 2.6, S.hole, { y: H + spec.vaultRise + 0.02, z: hallCz });
  }

  // crane guide rails on the roof: the trolley / hook travels along them (spec.rails = [{ x, y }], y = surface under the rail)
  for (const { x, y } of spec.rails) {
    b.box(L.railRoofW, L.railRoofH, L.railRoofLen, S.frame, { x, y: y + L.railRoofH / 2, z: L.railRoofZ });
    for (const e of [-1, 1]) {
      b.box(L.railRoofLine, L.railRoofH + 0.03, L.railRoofLen, S.accent, { x: x + e * (L.railRoofW / 2 - L.railRoofLine / 2), y: y + (L.railRoofH + 0.03) / 2, z: L.railRoofZ });
    }
    for (let z = L.railRoofZ - L.railRoofLen / 2 + 0.5; z < L.railRoofZ + L.railRoofLen / 2; z += L.railRoofTieStep) {
      b.box(L.railRoofW + 0.5, 0.05, 0.25, S.black, { x, y: y + 0.025, z });
    }
  }

  // radar tower (rear left)
  const tx = L.towerX;
  const tz = L.towerZ;
  const tH = spec.towerTop;
  if (spec.tower === 'round') {
    b.cylinder(1.7, 1.8, tH, 16, S.hull, { x: tx, y: tH / 2, z: tz });
    b.cylinder(1.73, 1.73, 0.5, 16, S.light, { x: tx, y: tH - 0.9, z: tz }, true);
    b.cylinder(1.9, 1.9, 0.25, 16, S.hullDark, { x: tx, y: tH + 0.12, z: tz });
  } else {
    const bw = spec.pilaster === 'buttress' ? 3.6 : 3.2;
    const tw = spec.pilaster === 'buttress' ? 2.8 : 3.2;
    if (bw === tw) b.box(bw, tH, bw, S.hull, { base: true, x: tx, z: tz });
    else b.taperedBox(bw, tw, tH, bw, S.hull, { x: tx, z: tz }, tw);
    const wy = tH - 0.9;
    const half = bw / 2 - ((bw - tw) / 2) * (wy / tH) + 0.02;
    for (const side of [-1, 1]) {
      b.box(tw - 0.4, 0.45, 0.05, S.light, { x: tx, y: wy, z: tz + side * half });
      b.box(0.05, 0.45, tw - 0.4, S.light, { x: tx + side * half, y: wy, z: tz });
    }
    b.box(tw + 0.3, 0.3, tw + 0.3, S.frame, { base: true, x: tx, y: tH, z: tz });
  }
  b.cylinder(0.12, 0.16, 0.8, 8, S.frame, { x: tx, y: tH + 0.55, z: tz });
  // tower corner beacon
  const tb = [tx + 1.2, tH + 0.65, tz + 1.2];
  b.cylinder(0.18, 0.18, 0.3, 10, S.lens, { x: tb[0], y: tb[1] - 0.15, z: tb[2] });
  glowStatic.push(tb);
  // rear right roof corner beacon
  // (vault: on top of the rear corner rib – the vault covers the roof edge)
  const rb = spec.roof === 'vault' ? [hb + 0.15, H + 0.5, L.pilasterZ[0]] : [ht - 0.6, H + 0.85, L.hallZ0 + 0.6];
  b.box(0.3, 0.3, 0.3, S.black, { base: true, x: rb[0], y: rb[1] - 0.5, z: rb[2] });
  b.cylinder(0.18, 0.18, 0.3, 10, S.lens, { x: rb[0], y: rb[1] - 0.05, z: rb[2] });
  glowStatic.push([rb[0], rb[1] + 0.05, rb[2]]);

  // fan housings (blades are separate meshes)
  const fanBases = [];
  for (const [fx, fz] of spec.fans) {
    let y = H + 0.35;
    if (spec.roof === 'vault') {
      const r = hb;
      const vh = (x) => H + spec.vaultRise * Math.sqrt(Math.max(0, 1 - (x / r) ** 2));
      const base = vh(fx + spec.fanR + 0.15) - 0.1;
      const top = vh(fx - spec.fanR - 0.15) + 0.15;
      b.box(spec.fanR * 2 + 0.3, top - base, spec.fanR * 2 + 0.3, S.hullDark, { base: true, x: fx, y: base, z: fz });
      y = top;
    }
    const h = 0.6;
    b.cylinder(spec.fanR, spec.fanR + 0.08, h, 16, S.hullDark, { x: fx, y: y + h / 2, z: fz });
    b.cylinder(spec.fanR - 0.08, spec.fanR - 0.08, 0.02, 16, S.hole, { x: fx, y: y + h + 0.01, z: fz });
    b.torus(spec.fanR, 0.08, 4, 16, Math.PI * 2, S.frame, { rx: Math.PI / 2, x: fx, y: y + h + 0.2, z: fz });
    b.box(spec.fanR * 2, 0.06, 0.08, S.frame, { x: fx, y: y + h + 0.32, z: fz });
    b.box(0.08, 0.06, spec.fanR * 2, S.frame, { x: fx, y: y + h + 0.32, z: fz });
    fanBases.push([fx, y + h + 0.1, fz]);
  }

  // pipes along the right wall (on brackets)
  const px = spec.pipeX;
  b.pipe([[px, 1.7, 10.0], [px, 1.7, -12.3], [px, H - 0.5, -12.3]], 0.2, 8, S.pipe);
  b.pipe([[px, L.padH, 8.5], [px, 2.4, 8.5], [px, 2.4, -11.6], [px, L.padH, -11.6]], 0.16, 8, S.pipe);
  for (let z = -10; z <= 7; z += 3.4) {
    const wx = wallXAt(2.05);
    b.box(px - wx + 0.2, 1.2, 0.15, S.frame, { x: (px + wx) / 2, y: 2.05, z });
  }
  b.cylinder(0.3, 0.3, 0.5, 8, S.hullDark, { x: px, y: 2.4, z: -3 });   // valve housing
  b.cylinder(0.25, 0.25, 0.06, 10, S.accent, { rz: Math.PI / 2, x: px + 0.35, y: 2.4, z: -3 });

  // rear equipment
  const rz = L.hallZ0 - 0.65;
  if (spec.rear === 'tanks') {
    for (const [cx, len] of [[2.6, 3.4], [-1.2, 2.6]]) {
      b.cylinder(0.55, 0.55, len, 14, S.dish, { rz: Math.PI / 2, x: cx, y: 0.95, z: rz });
      for (const e of [-1, 1]) b.box(0.25, 0.6, 1.0, S.frame, { base: true, x: cx + e * (len / 2 - 0.4), y: L.padH, z: rz });
      b.box(0.08, 1.12, 0.08, S.team, { x: cx, y: 0.95, z: rz - 0.55 });
    }
  } else if (spec.rear === 'generator') {
    b.box(5.0, 2.2, 1.0, S.hullDark, { base: true, x: 1.5, z: rz });
    for (let k = 0; k < 3; k++) b.box(4.4, 0.12, 0.06, S.lower, { x: 1.5, y: 0.8 + k * 0.45, z: rz - 0.52 });
    for (const sx of [3.4, 4.0]) b.cylinder(0.22, 0.26, 3.8, 10, S.frame, { x: sx, y: 1.9, z: rz });
  } else {
    for (const cx of [0.5, 3.0]) {
      b.sphere(0.62, 14, 8, S.dish, { x: cx, y: 1.25, z: rz });
      for (const e of [-1, 1]) b.cylinder(0.06, 0.06, 0.8, 6, S.frame, { x: cx + e * 0.4, y: 0.5, z: rz });
    }
    b.pipe([[0.5, 1.25, rz], [0.5, 2.2, rz], [3.0, 2.2, rz], [3.0, 1.25, rz]], 0.1, 6, S.pipe);
  }

  return { geometry: b.build(), glowStatic, fanBases };
}

// ---------------------------------------------------------------- animated parts

function buildFanBlades(spec, S) {
  const b = new PartBuilder();
  b.cylinder(0.18, 0.18, 0.2, 10, S.frame);
  const len = spec.fanR * 0.82;
  for (let i = 0; i < spec.fanBlades; i++) {
    const g = new THREE.BoxGeometry(len, 0.04, 0.32);
    g.rotateX(0.35);
    g.translate(len / 2 + 0.1, 0, 0);
    g.rotateY((i / spec.fanBlades) * Math.PI * 2);
    b.add(g, S.hullDark);
  }
  return b.build();
}

function buildRadarHead(S) {
  const b = new PartBuilder();
  const tiltX = Math.PI / 2 - 0.4;
  b.cylinder(0.35, 0.35, 0.2, 12, S.frame, { y: 0.1 });
  b.box(0.3, 0.6, 0.3, S.hullDark, { y: 0.5 });
  b.cylinder(1.0, 0.15, 0.35, 16, S.dish, { rx: tiltX, y: 0.9, z: 0.15 });
  b.cylinder(0.03, 0.03, 1.0, 6, S.frame, { rx: tiltX, y: 0.9 + Math.cos(tiltX) * 0.5, z: 0.15 + Math.sin(tiltX) * 0.5 });
  b.box(0.5, 0.4, 0.3, S.hullDark, { y: 0.85, z: -0.5 });
  b.box(0.2, 0.1, 0.05, S.team, { y: 1.0, z: -0.66 });
  return b.build();
}

function buildBridge(spec, S) {
  const L = LAYOUT;
  const b = new PartBuilder();
  const by = spec.beamY;
  const legH = by - 0.95;
  for (const side of [-1, 1]) {
    const x = side * L.legX;
    b.box(0.6, 0.55, 2.4, S.hullDark, { base: true, x, y: 0.4 });
    for (const z of [-0.75, 0.75]) b.box(0.4, legH, 0.4, S.accent, { base: true, x, y: 0.95, z });
    b.box(0.3, 0.3, 1.8, S.accent, { x, y: 1.1 });
    const bh = legH - 1.2;
    const a = Math.atan2(1.5, bh);
    b.box(0.18, Math.hypot(1.5, bh), 0.18, S.frame, { x, y: 1.1 + bh / 2, rx: a });
    b.box(0.18, Math.hypot(1.5, bh), 0.18, S.frame, { x, y: 1.1 + bh / 2, rx: -a });
    b.box(0.9, 0.25, 2.0, S.hullDark, { base: true, x, y: by + 0.6 });
    b.cylinder(0.18, 0.18, 0.3, 10, S.lens, { x, y: by + 1.0 });
    for (const zs of [-1, 1]) {
      b.hazardStrip(2.4, 0.5, 0.5, S.accent, S.black, { ry: zs > 0 ? 0 : Math.PI, x: side * 7.9, y: by + 0.3, z: zs * 0.74 });
    }
  }
  for (const z of [-0.55, 0.55]) b.box(L.legX * 2 + 0.4, 0.6, 0.35, S.accent, { base: true, y: by, z });
  for (const zs of [-1, 1]) b.box(10, 0.3, 0.04, S.team, { y: by + 0.3, z: zs * 0.75 });
  // operator cabin under the beam
  b.box(1.4, 1.1, 1.3, S.hullDark, { base: true, x: -7.4, y: by - 1.1 });
  b.box(1.1, 0.5, 0.05, S.light, { x: -7.4, y: by - 0.45, z: 0.67 });
  return {
    geometry: b.build(),
    glow: [[-L.legX, by + 1.05, 0], [L.legX, by + 1.05, 0]],
  };
}

function buildTrolley(spec, S) {
  const b = new PartBuilder();
  b.box(2.0, 0.45, 1.7, S.hullDark, { base: true });
  b.box(0.8, 0.5, 0.8, S.frame, { base: true, x: -0.4, y: 0.45 });
  b.box(0.6, 0.06, 0.06, S.accent, { x: 0.5, y: 0.47, z: 0.86 });
  return b.build();
}

/** Hook gear under the trolley: unit-length cable pair (scaled in Y per frame) and the hook block (moved in Y). */
function buildHook(spec, S) {
  const cableB = new PartBuilder();
  for (const x of [-0.12, 0.12]) cableB.cylinder(0.035, 0.035, 1, 5, S.frame, { x, y: -0.5 });
  const blockB = new PartBuilder();
  const blockH = 0.55;
  blockB.box(0.5, blockH, 0.35, S.accent, { y: -blockH / 2 });
  blockB.torus(0.16, 0.05, 4, 8, Math.PI * 1.4, S.frame, { y: -blockH - 0.12, rz: Math.PI * 0.8 });
  const top = spec.beamY + 0.6;
  // cable length with the hook down: block bottom just above the guide rail, but always a clearly visible drop
  // below the retracted length (vault / armoured roofs reach almost to the beam: the hook then dips into the skylight)
  const railTop = spec.rails[0].y + LAYOUT.railRoofH;
  const full = Math.max(FACTORY_ANIM.hookRetract + FACTORY_ANIM.hookMinDrop, top - railTop - blockH - FACTORY_ANIM.hookClearance);
  return { cable: cableB.build(), block: blockB.build(), full };
}

function buildDoor(spec, S) {
  const L = LAYOUT;
  const b = new PartBuilder();
  const n = Math.ceil(L.doorH / L.slatH);
  const h = L.doorH / n;
  for (let i = 0; i < n; i++) {
    b.box(L.doorHalfW * 2, h * 0.92, 0.12, i % 2 ? S.hullDark : S.hull, { y: -(i + 0.5) * h });
  }
  b.box(L.doorHalfW * 2, 0.25, 0.16, S.frame, { y: -L.doorH + 0.125 });
  b.box(1.6, 0.35, 0.05, S.team, { y: -1.2, z: 0.07 });
  return b.build();
}

// ---------------------------------------------------------------- shared per-faction cache

const sharedCache = new Map();   // race -> { users, geometries…, layout }

function acquireShared(race) {
  let entry = sharedCache.get(race);
  if (!entry) {
    const spec = specOf(race);
    const S = surfacesOf(spec);
    const st = buildStatic(spec, S);
    const bridge = buildBridge(spec, S);
    const hook = buildHook(spec, S);
    entry = {
      users: 0,
      spec,
      hookCable: hook.cable,
      hookBlock: hook.block,
      hookFull: hook.full,
      static: st.geometry,
      fanBases: st.fanBases,
      fan: buildFanBlades(spec, S),
      radar: buildRadarHead(S),
      bridge: bridge.geometry,
      trolley: buildTrolley(spec, S),
      door: buildDoor(spec, S),
      glowStatic: glowGeometry(st.glowStatic, LAYOUT.glowRadius),
      glowBridge: glowGeometry(bridge.glow, LAYOUT.glowRadius),
    };
    sharedCache.set(race, entry);
  }
  entry.users++;
  return entry;
}

const SHARED_GEOMETRY_KEYS = ['static', 'fan', 'radar', 'bridge', 'trolley', 'hookCable', 'hookBlock', 'door', 'glowStatic', 'glowBridge'];

function releaseShared(race) {
  const entry = sharedCache.get(race);
  if (!entry || --entry.users > 0) return;
  for (const key of SHARED_GEOMETRY_KEYS) entry[key].dispose();
  sharedCache.delete(race);
}

// Glow halos never cast shadows, even when the caller sets castShadow on every mesh (Structure.load does)
const noShadow = (mesh) => Object.defineProperty(mesh, 'castShadow', { get: () => false, set: () => {} });

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class VehicleFactoryProc extends THREE.Group {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       faction key of FACTORY_SPECS (unknown → X)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race = 'X', teamColor = '#3a5ccc' } = {}) {
    super();
    this.name = `VehicleFactoryProc${race}`;
    this.race = race;
    this.userData.procedural = true;
    this.shared = acquireShared(race);
    const sh = this.shared;
    const spec = sh.spec;
    this.paint = acquirePaintMaterial(teamColor);
    this.glowMat = acquireGlowMaterial(spec.pal.beacon);
    this.paintMeshes = [];

    const paintMesh = (geometry, parent = this) => {
      const mesh = new THREE.Mesh(geometry, this.paint);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      this.paintMeshes.push(mesh);
      return mesh;
    };
    const glowMesh = (geometry, parent) => {
      const mesh = new THREE.Mesh(geometry, this.glowMat);
      noShadow(mesh);
      mesh.visible = false;
      parent.add(mesh);
      return mesh;
    };

    paintMesh(sh.static);
    this.glowStatic = glowMesh(sh.glowStatic, this);

    const seq = instanceCounter++;
    const a = FACTORY_ANIM;
    this.fans = [];
    this.fanSpeeds = [];
    sh.fanBases.forEach(([x, y, z], i) => {
      const fan = paintMesh(sh.fan);
      fan.position.set(x, y, z);
      fan.rotation.y = (seq * 0.7 + i * 1.3) % (Math.PI * 2);
      this.fans.push(fan);
      const jitter = (((seq * 3 + i * 5) % 7) / 6 - 0.5) * 2 * a.fanSpeedJitter;
      this.fanSpeeds.push(a.fanSpeed * (1 + jitter) * (i % 2 ? -1 : 1));
    });

    this.radar = paintMesh(sh.radar);
    this.radar.position.set(LAYOUT.towerX, spec.towerTop + 0.95, LAYOUT.towerZ);
    this.radar.rotation.y = seq * 0.9;

    this.bridge = paintMesh(sh.bridge);
    this.bridge.position.z = LAYOUT.craneRestZ;
    this.glowBridge = glowMesh(sh.glowBridge, this.bridge);
    this.trolley = paintMesh(sh.trolley, this.bridge);
    this.trolley.position.y = spec.beamY + 0.6;
    this.hookCable = paintMesh(sh.hookCable, this.trolley);
    this.hookBlock = paintMesh(sh.hookBlock, this.trolley);
    this.hookLength = FACTORY_ANIM.hookRetract;
    this.#applyHook();

    this.door = paintMesh(sh.door);
    this.door.position.set(0, LAYOUT.padH + LAYOUT.doorH, LAYOUT.doorZ);

    // Gantry route: bridge travels along Z, trolley along X, the hook goes down at every stop
    const railXs = spec.rails.map((r) => r.x);   // trolley X per stop: alternates between the rails of the faction
    this.mover = new TrackMover({
      rest: [LAYOUT.craneRestZ, railXs[0]],
      stops: LAYOUT.craneStopsZ.map((z, i) => [z, railXs[i % railXs.length]]),
      speed: [a.bridgeSpeed, a.trolleySpeed],
      dwell: a.craneDwell,
    });
    this.doorOpen = 0;
    this.blinkA = new Blinker({ period: a.blinkPeriod, duty: a.blinkDuty });
  }

  #applyHook() {
    this.hookCable.scale.y = this.hookLength;
    this.hookBlock.position.y = -this.hookLength;
  }

  /** Team colour (shared paint material per colour) */
  setTeamColor(color) {
    const next = acquirePaintMaterial(color);
    const prev = this.paint;
    this.paint = next;
    for (const mesh of this.paintMeshes) mesh.material = next;
    releasePaintMaterial(prev);
  }

  /**
   * Per-frame animation (no allocations). Fans and radar always turn; while producing the gantry travels,
   * the door rolls up and the beacons blink. Parts ease back to rest when production stops.
   * @param {number} delta         seconds
   * @param {boolean} isProducing
   */
  update(delta, isProducing = false) {
    const a = FACTORY_ANIM;
    for (let i = 0; i < this.fans.length; i++) this.fans[i].rotation.y += delta * this.fanSpeeds[i];
    this.radar.rotation.y += delta * a.radarSpeed;

    const m = this.mover;
    m.update(delta, isProducing);
    this.bridge.position.z = m.value[0];
    this.trolley.position.x = m.value[1];
    // hook: down and up around every dwell at a stop, retracted while travelling / at rest
    const down = plateau(m.dwellT, a.hookEdge);
    this.hookLength = a.hookRetract + (this.shared.hookFull - a.hookRetract) * down;
    this.#applyHook();

    this.doorOpen += ((isProducing ? 1 : 0) - this.doorOpen) * Math.min(1, delta * a.doorSpeed);
    this.door.scale.y = 1 - this.doorOpen * (1 - a.doorMinScale);

    this.blinkA.update(delta, isProducing);
    this.glowStatic.visible = this.blinkA.on;
    this.glowBridge.visible = this.blinkA.off;
  }

  /** { triangles, drawCalls } of this instance (main pass; shadow pass adds the paint meshes again) */
  stats() {
    let triangles = 0;
    let drawCalls = 0;
    this.traverse((o) => {
      if (!o.isMesh) return;
      triangles += triangleCount(o.geometry);
      drawCalls++;
    });
    return { triangles, drawCalls };
  }

  /** Removes the model from the scene and releases the shared geometries / materials it holds */
  dispose() {
    if (!this.shared) return;
    this.removeFromParent();
    this.clear();
    releasePaintMaterial(this.paint);
    releaseGlowMaterial(this.glowMat);
    releaseShared(this.race);
    this.shared = null;
    this.paintMeshes.length = 0;
    this.fans.length = 0;
  }
}

// ---------------------------------------------------------------- registry for Structure.js

const PROCEDURAL_STRUCTURES = { vehicleFactory: VehicleFactoryProc };

/** Has this structure id a procedural model? */
export const hasProceduralModel = (id) => id in PROCEDURAL_STRUCTURES;

/** New procedural model for a structure id, or null when there is none */
export function createProceduralStructure(id, race, teamColor) {
  const Model = PROCEDURAL_STRUCTURES[id];
  return Model ? new Model({ race, teamColor }) : null;
}
