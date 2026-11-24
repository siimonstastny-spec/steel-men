// Steel Mans – procedural wall post (roadmap 18, walls). Drop-in alternative to
// models/3DStructures{race}/MobileWall{race}_Anim.glb built from the style modules (ProcModules.js):
//   • footprint inside the GLB's (ground box ±5.2, post height 12.65, turret socket on top); built in GLB units, the
//     structure scales it by stats.modelScale (1.5) like the GLB
//   • body per style.silhouette (POST_SHAPES / POST_BUILDERS): rounded = chamfered plinth + round column, angular = armoured
//     skirt + sloped square pillar with spikes, round = disc + smooth lathe column with a bulb collar and a floating ring,
//     faceted = slim 4-sided pylon with square emitter rings (the laser barrier hooks onto them); the vent follows style.fan,
//     lights follow style.lights, markings follow style.markings, texture / edges / neon come from the style
//   • one static mesh (batched like every finished building) + emblem decals (4 plates) + 1–2 glow layers (+ the ring)
//   • `socket_c6e5475c` (POST_SOCKET) = Object3D on the post top: WallPost.turretHeight reads its world height, so the
//     turret stands on the post exactly as with the GLB (stats.turretSocket stays unchanged)
// Also exports the shared wall constants (WALL_SPAN, WALL_LAYOUT, WALL_ANIM, nextWallInstance) the segment, turret and gate
// models use. Visual only: update() takes the frame delta, nothing here is read by the simulation. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, beacon, fanHousing, radiator, spike, ringGeometry,
  emblemDecalGeometry, Levitator, pulseWave, PROC_MODULES,
} from './ProcModules.js';

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
export const QUARTER_PI = Math.PI / 4;

/** Model length of a wall segment / gate (GLB MobileWallWall: x ±16). Walls.js stretches the model along x to the post distance. */
export const WALL_SPAN = 32;

/** Shared layout of the wall models (GLB units, ground = y 0) */
export const WALL_LAYOUT = {
  postTop: 12.65,                  // post height = turret socket height (GLB: 12.65 body, socket at 13)
  segmentHeight: 9,                // GLB wall height
  neonMin: 0.3,                    // style.neon from which neon strips / veins appear
  barrierYs: [2, 4, 6, 8],         // heights of the laser lines (segment) and of the emitter rings on the post (barrier style)
  pickDepth: 1.5,                  // thickness of the invisible pick box of the barrier segment / gate
};

/** One invisible material for every pick box (never drawn; Raycaster ignores `visible`, Structure.pickables finds the mesh) */
const PICK_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });

/** Pick box geometry (shared record, disposed with it): the full wall height, centred on the sheet height */
export function pickBoxGeometry(y, h) {
  return new THREE.BoxGeometry(WALL_SPAN, h, WALL_LAYOUT.pickDepth).translate(0, y, 0);
}

/** Adds the invisible pick mesh to a model (not a paint mesh: the batcher must never show it) */
export function addPickBox(model, geometry) {
  const mesh = new THREE.Mesh(geometry, PICK_MATERIAL);
  mesh.visible = false;
  mesh.castShadow = false;
  model.add(mesh);
  return mesh;
}

/** Name of the turret socket node (stats.json structures.mobileWall.turretSocket – the GLB node name) */
export const POST_SOCKET = 'socket_c6e5475c';

/** Animation tuning (visual only; style.anim multiplies the speeds) */
export const WALL_ANIM = {
  blinkDuty: 0.5,
  phaseStep: 0.43,                 // s – pulse phase offset per instance
  heat: 0.75,                      // radiator glow share (× pulse)
  sheetOpacity: 0.14,              // translucent laser barrier sheet
  haloOpacity: 0.3,                // soft halo round the laser lines
  gateSpeed: 0.55,                 // 1/s – gate travel (1 = fully open / closed in one second)
  levitatePhase: 0.37,             // ring phase offset per instance
};

let instanceCounter = 0;
/** Next instance number (spreads animation phases) */
export const nextWallInstance = () => instanceCounter++;

// ---------------------------------------------------------------- details shared by the posts

const MARK_OUT = 0.01;                                                    // markings stand this far off a wall
const PLATE = { size: 2.2, d: 0.6, out: 0.08, emblem: 2.0 };              // emblem plate (flat box) + decal size
const RING = { radial: 4, segments: 20, neonRadial: 3, neonTube: 0.07 };  // team / neon rings on round columns
const VENT = {
  bladeW: 0.3, bladeT: 0.05, bladeShare: 0.82,                            // static blade cross of an open fan
  orbBase: [0.7, 0.9, 0.6], orbR: 0.8, orbLift: 0.7, orbHalo: 1.9, orbSeg: [10, 6], baseSeg: 10,   // small plasma orb
};

/** Radius of a (truncated) column c = { rTop, rBottom, y0, h } at height y */
export const radiusAt = (c, y) => c.rBottom + (c.rTop - c.rBottom) * ((y - c.y0) / c.h);

/** Column along Y (a 4-sided one is turned so that its faces look along the axes) */
const column = (b, c, s, t = {}) => b.cylinder(c.rTop, c.rBottom, c.h, c.seg, s, { y: c.y0 + c.h / 2, ry: c.seg === 4 ? QUARTER_PI : 0, ...t });

/** Horizontal team ring round a round column */
const teamRing = (b, kit, r, y, tube) => b.torus(r, tube, RING.radial, RING.segments, TAU, kit.S.team, { rx: HALF_PI, y });

/** Markings (hazard stripes / light line) on the four faces of a square plinth of half size R: m = { len, h, y } */
function faceMarkings(b, kit, R, m) {
  for (let k = 0; k < 4; k++) {
    const a = k * HALF_PI;
    marking(b, kit, m.len, m.h, { x: Math.sin(a) * (R + MARK_OUT), y: m.y, z: Math.cos(a) * (R + MARK_OUT), ry: a });
  }
}

/** Team-coloured strips round the four faces of a square plinth: s = { len, h, t, y } */
function faceStrips(b, kit, R, s) {
  for (let k = 0; k < 4; k++) {
    const a = k * HALF_PI;
    const d = R + s.t / 2;
    b.box(s.len, s.h, s.t, kit.S.team, { x: Math.sin(a) * d, y: s.y, z: Math.cos(a) * d, ry: a });
  }
}

/** Four emblem plates on the faces of a post: `dist` = distance of the face from the axis at the plate, `y` = plate centre */
function emblemPlates(b, kit, dist, y, placements) {
  const front = dist + PLATE.out;
  for (let k = 0; k < 4; k++) {
    const a = k * HALF_PI;
    const nx = Math.sin(a);
    const nz = Math.cos(a);
    b.box(PLATE.size, PLATE.size, PLATE.d, kit.S.hullDark, { x: nx * (front - PLATE.d / 2), y, z: nz * (front - PLATE.d / 2), ry: a });
    placements.push({ position: [nx * front, y, nz * front], normal: [nx, 0, nz], size: PLATE.emblem });
  }
}

/** Two position lights at (at, y, at) and (−at, y, −at): caged lamps or neon lenses (halo layer by style.lights) */
function postLights(b, glows, kit, y, at) {
  const lamp = glows.get(kit.style.lights === 'lamp' ? 'beacon' : 'pulse');
  for (const e of [-1, 1]) beacon(b, lamp, kit, [e * at, y, e * at]);
}

/** Vent unit by style.fan, standing on a surface at v = { x, y, z, r } (no animated blades: a static detail) */
function postVent(b, glows, kit, v) {
  const S = kit.S;
  const F = PROC_MODULES.fan;
  switch (kit.style.fan) {
    case 'guarded':
      fanHousing(b, kit, v);
      break;
    case 'open': {
      const h = fanHousing(b, kit, v);
      const y = v.y + F.housingH + F.bladeLift;
      for (let k = 0; k < 2; k++) b.box(h.r * 2 * VENT.bladeShare, VENT.bladeT, VENT.bladeW, S.trim, { x: v.x, y, z: v.z, ry: k * HALF_PI });
      break;
    }
    case 'radiator':
      radiator(b, glows.get('radiator'), kit, { x: v.x, y: v.y, z: v.z, w: v.r * 2, d: v.r * 2, h: v.r * PROC_MODULES.radiator.heightShare });
      break;
    default: {   // plasma orb
      const [rt, rb, hh] = VENT.orbBase;
      const cy = v.y + v.r * hh + v.r * VENT.orbLift;
      b.cylinder(v.r * rt, v.r * rb, v.r * hh, VENT.baseSeg, S.hullDark, { x: v.x, y: v.y + (v.r * hh) / 2, z: v.z });
      b.sphere(v.r * VENT.orbR, VENT.orbSeg[0], VENT.orbSeg[1], S.plasma, { x: v.x, y: cy, z: v.z });
      glows.get('pulse').sphere(v.r * VENT.orbHalo, 8, 5, { x: v.x, y: cy, z: v.z });
    }
  }
}

// ---------------------------------------------------------------- post shapes (by style.silhouette; unknown → rounded)

export const POST_SHAPES = {
  rounded: {
    R: 5.0, baseH: 1.4, lightAt: 4.0, vent: { x: 4.0, z: -4.0, r: 0.7 },
    mark: { len: 8.2, h: 0.9, y: 0.7 },
    column: { seg: 20, rTop: 3.3, rBottom: 3.9, y0: 1.4, h: 9.6 },
    flange: { r: 4.4, h: 0.5 }, capR: 4.2,
    team: { y: 3.0, tube: 0.25 }, neonTube: 0.07, plateY: 6.5,
  },
  angular: {
    R: 5.1, skirtH: 1.0, vent: { x: 4.45, z: -4.45, r: 0.45 }, spikeAt: 4.6, crownLightAt: 3.1, crownSpikeAt: 3.1,
    body: { w: 7.6, topW: 5.4, y0: 1.0, h: 10.35 }, crown: { w: 7.4, h: 1.3 },
    spikeSkirt: { h: 1.0, r: 0.22 }, spikeCrown: { h: 0.9, r: 0.2 },
    team: { len: 8.6, h: 0.45, t: 0.1, y: 0.4 }, rust: { len: 8.8, h: 0.3, t: 0.06, y: 0.85 },
    plateY: 6.0,
  },
  round: {
    R: 4.0, baseH: 1.2, base: { rTop: 3.6, rBottom: 4.0, seg: 24 }, lightAt: 2.4, vent: { x: 2.33, z: -2.33, r: 0.4 },
    column: { seg: 20, rTop: 2.0, rBottom: 2.9, y0: 1.2, h: 8.6 },
    collar: { r: 3.3, flat: 0.45, y: 10.2, seg: 24, rows: 10 }, seat: { rTop: 2.5, rBottom: 2.9, y0: 10.6 },
    team: { r: 3.85, tube: 0.25 }, veinYs: [4.2, 7.0], veinTube: 0.1, plateY: 6.0,
    ring: { r: 3.6, tube: 0.1, y: 5.6 },
  },
  faceted: {
    R: 4.4, baseH: 1.4, lightAt: 3.4, vent: { x: 3.2, z: -3.2, r: 0.6 },
    mark: { len: 7.4, h: 0.8, y: 0.7 }, team: { len: 8.0, h: 0.3, t: 0.08, y: 0.25 },
    column: { seg: 4, rTop: 1.7, rBottom: 2.6, y0: 1.4, h: 9.4 },
    crown: { rTop: 3.4, h: 1.35 }, seat: { w: 4.6, h: 0.5 },
    emitter: { gap: 0.3, tube: 0.1, haloTube: 0.28 }, plateY: 6.0,
  },
};

const shapeOf = (style) => POST_SHAPES[style.silhouette] ?? POST_SHAPES.rounded;

function buildRoundedPost(b, glows, kit, P, out) {
  const S = kit.S;
  const c = P.column;
  styledBox(b, kit, P.R * 2, P.baseH, P.R * 2, S.hull, { base: true }, 1);
  faceMarkings(b, kit, P.R, P.mark);
  column(b, c, S.hull);
  const flangeY = c.y0 + c.h + P.flange.h / 2;
  b.cylinder(P.flange.r, P.flange.r, P.flange.h, c.seg, S.hullDark, { y: flangeY });
  const capY = c.y0 + c.h + P.flange.h;
  const capH = WALL_LAYOUT.postTop - capY;
  b.cylinder(P.capR, P.capR, capH, c.seg, S.hullDark, { y: capY + capH / 2 });
  teamRing(b, kit, radiusAt(c, P.team.y) + P.team.tube / 2, P.team.y, P.team.tube);
  if (kit.style.neon >= WALL_LAYOUT.neonMin) b.torus(P.capR + PLATE.out / 2, P.neonTube, RING.neonRadial, RING.segments, TAU, S.neon, { rx: HALF_PI, y: capY + capH / 2 });
  emblemPlates(b, kit, radiusAt(c, P.plateY - PLATE.size / 2), P.plateY, out.emblems);
  postLights(b, glows, kit, P.baseH, P.lightAt);
  postVent(b, glows, kit, { x: P.vent.x, y: P.baseH, z: P.vent.z, r: P.vent.r });
}

function buildAngularPost(b, glows, kit, P, out) {
  const S = kit.S;
  const bd = P.body;
  const faceAt = (y) => bd.w / 2 + ((bd.topW - bd.w) / 2) * ((y - bd.y0) / bd.h);
  b.box(P.R * 2, P.skirtH, P.R * 2, S.hullDark, { base: true });
  b.taperedBox(bd.w, bd.topW, bd.h, bd.w, S.hull, { y: bd.y0 }, bd.topW);
  const crownY = bd.y0 + bd.h;
  b.box(P.crown.w, P.crown.h, P.crown.w, S.hullDark, { base: true, y: crownY });
  faceStrips(b, kit, P.R, P.team);
  for (let k = 0; k < 4; k++) {   // rusty plate on the skirt, flush with the faces
    const a = k * HALF_PI;
    b.box(P.rust.len, P.rust.h, P.rust.t, S.lower, { x: Math.sin(a) * (P.R + P.rust.t / 2), y: P.rust.y, z: Math.cos(a) * (P.R + P.rust.t / 2), ry: a });
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      if (sx > 0 && sz < 0) continue;   // the vent stands in this corner
      spike(b, kit, { x: sx * P.spikeAt, y: P.skirtH, z: sz * P.spikeAt, h: P.spikeSkirt.h, r: P.spikeSkirt.r });
    }
  }
  const top = WALL_LAYOUT.postTop;
  for (const e of [-1, 1]) spike(b, kit, { x: e * P.crownSpikeAt, y: top, z: -e * P.crownSpikeAt, h: P.spikeCrown.h, r: P.spikeCrown.r });
  postLights(b, glows, kit, top, P.crownLightAt);
  emblemPlates(b, kit, faceAt(P.plateY - PLATE.size / 2), P.plateY, out.emblems);
  postVent(b, glows, kit, { x: P.vent.x, y: P.skirtH, z: P.vent.z, r: P.vent.r });
}

function buildRoundPost(b, glows, kit, P, out) {
  const S = kit.S;
  const c = P.column;
  b.cylinder(P.base.rTop, P.base.rBottom, P.baseH, P.base.seg, S.hull, { y: P.baseH / 2 });
  teamRing(b, kit, P.team.r, P.baseH / 2, P.team.tube);
  column(b, c, S.hull);
  b.sphere(P.collar.r, P.collar.seg, P.collar.rows, S.hull, { y: P.collar.y, sy: P.collar.flat });
  const sy0 = P.seat.y0;
  const seatH = WALL_LAYOUT.postTop - sy0;
  b.cylinder(P.seat.rTop, P.seat.rBottom, seatH, c.seg, S.hullDark, { y: sy0 + seatH / 2 });
  if (kit.rich) {
    for (const y of P.veinYs) b.torus(radiusAt(c, y) + P.veinTube / 2, P.veinTube, RING.neonRadial, RING.segments, TAU, S.neon, { rx: HALF_PI, y });
  }
  emblemPlates(b, kit, radiusAt(c, P.plateY - PLATE.size / 2), P.plateY, out.emblems);
  postLights(b, glows, kit, P.baseH, P.lightAt);
  postVent(b, glows, kit, { x: P.vent.x, y: P.baseH, z: P.vent.z, r: P.vent.r });
  out.ring = P.ring;
}

function buildFacetedPost(b, glows, kit, P, out) {
  const S = kit.S;
  const c = P.column;
  styledBox(b, kit, P.R * 2, P.baseH, P.R * 2, S.hull, { base: true }, 1);
  faceMarkings(b, kit, P.R, P.mark);
  faceStrips(b, kit, P.R, P.team);
  column(b, c, S.hullDark);
  const crownY = c.y0 + c.h;
  b.cylinder(P.crown.rTop, c.rTop, P.crown.h, c.seg, S.hull, { y: crownY + P.crown.h / 2, ry: QUARTER_PI });
  b.box(P.seat.w, P.seat.h, P.seat.w, S.hullDark, { base: true, y: crownY + P.crown.h, ry: QUARTER_PI });
  // square emitter rings round the pylon at the heights of the barrier lines (halo layer + paint)
  const E = P.emitter;
  for (const y of WALL_LAYOUT.barrierYs) {
    const r = radiusAt(c, y) + E.gap;
    b.torus(r, E.tube, 4, 4, TAU, S.plasma, { rx: HALF_PI, rz: QUARTER_PI, y });
    glows.get('pulse').torus(r, E.haloTube, 4, 4, TAU, { rx: HALF_PI, rz: QUARTER_PI, y });
  }
  emblemPlates(b, kit, radiusAt(c, P.plateY - PLATE.size / 2) / Math.SQRT2, P.plateY, out.emblems);
  postLights(b, glows, kit, P.baseH, P.lightAt);
  postVent(b, glows, kit, { x: P.vent.x, y: P.baseH, z: P.vent.z, r: P.vent.r });
}

const POST_BUILDERS = { rounded: buildRoundedPost, angular: buildAngularPost, round: buildRoundPost, faceted: buildFacetedPost };

/** Shared record of the post of one style: { static (LODs), glow, emblem, ring?, ringAt? } */
function buildShared(kit) {
  const key = Object.hasOwn(POST_BUILDERS, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const b = new PartBuilder();
  const glows = new GlowSet();
  const out = { emblems: [], ring: null };
  POST_BUILDERS[key](b, glows, kit, shapeOf(kit.style), out);
  return {
    static: b.buildLods(),
    glow: glows.build(),
    emblem: emblemDecalGeometry(out.emblems),
    ring: out.ring ? ringGeometry(kit, out.ring.r, out.ring.tube) : null,
    ringAt: out.ring ? [0, out.ring.y, 0] : null,
  };
}

const POST_CACHE = createSharedCache(buildShared);

// ---------------------------------------------------------------- the model

export class MobileWallProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: POST_CACHE, name: 'MobileWallProc' });
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
    const gc = this.kit.glowColors;
    const seq = nextWallInstance();
    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beaconGlow = layer('beacon', gc.beacon, false);
    this.pulseGlow = layer('pulse', gc.pulse, true);
    this.heatGlow = layer('radiator', gc.radiator, false);

    // turret socket on the post top (WallPost.turretHeight reads its world height)
    this.socket = new THREE.Object3D();
    this.socket.name = POST_SOCKET;
    this.socket.position.y = WALL_LAYOUT.postTop;
    this.add(this.socket);

    this.levitator = null;
    if (sh.ring) {
      const ring = this.paintMesh(sh.ring, this, { far: true });   // far LOD: frozen instance, the silhouette keeps its ring
      ring.position.set(sh.ringAt[0], sh.ringAt[1], sh.ringAt[2]);
      const lev = PROC_MODULES.levitate;
      this.levitator = new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin, phase: seq * WALL_ANIM.levitatePhase });
    }
    this.time = seq * WALL_ANIM.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: WALL_ANIM.blinkDuty, phase: (seq * WALL_ANIM.phaseStep) % 1 });
  }

  /** Per-frame animation (numbers only, no allocations); `active` is unused – a post has no production */
  update(delta) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    this.time += delta;
    const glow = pulseWave(this.time, an.pulse);
    this.pulseGlow?.setIntensity(glow);
    this.heatGlow?.setIntensity(WALL_ANIM.heat * glow);
    this.blink.update(delta, true);
    this.beaconGlow?.setIntensity(this.blink.on ? 1 : 0);
    this.levitator?.update(delta, true);
  }
}
