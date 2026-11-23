// Steel Mans – style-aware building modules (roadmap 18, phase A). Every procedural building is composed from these:
//   • styleKit(race)         resolved style (data/buildingStyles.json) + ready surfaces + glow colours
//   • ProcModel              base class of a building model: paint / glow / emblem meshes, setTeamColor, stats, dispose
//   • createSharedCache      per-style cache of the shared geometries of one building type (ref-counted)
//   • static writers         add painted primitives to a PartBuilder (→ the building's one static draw call) and glow
//                            primitives to a GlowSet (→ one draw call per glow layer): styledBox, marking, neonStrip,
//                            beacon, ventUnit (fan / radiator / plasma orb), roofRails, pipeRun, tank, chimney,
//                            plasmaCoil, laserLink, spike
//   • animated parts         GlowLayer (intensity), Levitator, ArcFlicker, CraneRig (gantry / heavyGantry / plasma /
//                            tractorBeam), fan blades and rings as shared geometries
//   • emblem                 faction sign from SVG paths: decal texture + emblemDecalGeometry (1 draw call), emblemShape
//                            (extruded), emblemShapes / emblemPathData for icons and UI
// Code reads style properties only, never faction names. Visual only: nothing here touches the simulation; update()
// methods allocate nothing. See docs/notes/proc-style-kit.md.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  PartBuilder, GlowBuilder, surface, acquirePaintMaterial, releasePaintMaterial, triangleCount, TrackMover, plateau, makeRng,
} from './ProcKit.js';
import { getBuildingStyle, resolveStyleKey } from './BuildingStyle.js';

/** Module tuning (visual only, model units unless noted) */
export const PROC_MODULES = {
  defaultTeamColor: '#3a5ccc',
  // surface parameters of the kit surfaces (colour comes from style.palette)
  surfaces: {
    hullDark: { metal: 0.5, rough: 0.6 }, frame: { metal: 0.8, rough: 0.45 }, lower: { metal: 0.35, rough: 0.8 },
    ground: { metal: 0, rough: 0.95 }, pipe: { metal: 0.6, rough: 0.4 }, accent: { metal: 0.3, rough: 0.55 },
    dark: { metal: 0.2, rough: 0.8 }, rubber: { metal: 0, rough: 0.95 }, team: { metal: 0.3, rough: 0.5 },
    window: { metal: 0, rough: 0.3 }, interior: { metal: 0, rough: 0.9, glow: 0.45 }, lens: { metal: 0, rough: 0.2, glow: 0.5 },
    lamp: { metal: 0, rough: 0.3, glow: 1.3 }, trim: { metal: 0.6, rough: 0.35 }, hole: { metal: 0, rough: 1 },
    plasma: { metal: 0, rough: 0.2, glow: 1.6 }, neon: { metal: 0, rough: 0.3 },
  },
  teamWhite: '#dadada',      // diffuse of team-coloured parts (× team colour)
  neonTeamWhite: '#ffffff',  // neon strips in the team colour
  holeColor: '#0d0d0d',
  neonGlow: [0.4, 1.8],      // emissive of neon strips at style.neon 0 / 1
  windowGlow: [0.7, 1.5],    // emissive of windows at style.neon 0 / 1
  richNeon: 0.7,             // style.neon from which buildings add extra neon veins (kit.rich)
  edgeMinRadius: 0.05,       // styledBox: rounded edges below this radius → plain box
  edgeMaxShare: 0.45,        // rounding radius ≤ share × smallest side
  edgeMinSide: 1.2,          // boxes with a side smaller than this stay sharp (triangle budget)
  lightMarkingShare: 0.3,    // 'light' markings: line height = strip height × share
  lightMarkingDepth: 0.02,
  glow: { opacity: 0.95, cutoff: 0.01, radius: 0.32 },
  pulse: { depth: 0.35, idle: 0.35 },   // glow pulse 1 − depth…1; idle = intensity share when not producing
  beacon: { baseW: 0.35, baseH: 0.2, lensR: 0.2, lensH: 0.32, lampR: 0.17, lampBaseR: 0.15, cageBars: 4, barT: 0.03, lampHalo: 1.2 },
  fan: {
    housingH: 0.6, lip: 0.08, rimT: 0.08, grilleRise: 0.2, barH: 0.06, barT: 0.08, grilleRings: 2, grilleBars: 2,
    bladeLift: 0.1, bladeShare: 0.82, bladeT: 0.04, bladeW: 0.32, pitch: 0.35, hubR: 0.18, hubH: 0.2,
    guardedBlades: 5, openBlades: 6, openSize: 1.15, bolts: 8, boltR: 0.06, boltH: 0.12, segments: 16,
  },
  radiator: { finStep: 0.24, finT: 0.06, baseH: 0.25, frame: 0.12, heightShare: 1.1, glowT: 0.1, glowH: 0.9, glowD: 0.94 },
  orb: { sizeShare: 0.6, baseR: 0.7, baseH: 0.9, lift: 0.55, cradleR: 1.25, cradleT: 0.08, halo: 1.35, ringR: 1.55, ringT: 0.06 },
  coil: { coreShare: 0.45, step: 0.35, tube: 0.07, capShare: 0.6, halo: 0.9, glowTube: 0.03 },
  laser: { thickness: 0.06, nubR: 0.12 },
  spike: { segments: 4 },
  rail: {
    w: 0.5, h: 0.12, line: 0.07, tieStep: 2.0, tieExtra: 0.5, tieD: 0.25, tieH: 0.05,
    heavyW: 0.8, heavyH: 0.2, boltStep: 1.0, boltR: 0.06, channelW: 0.7, grooveW: 0.12,
  },
  pipeSegments: 8,
  tank: { saddleW: 0.25, saddleH: 0.6, saddleD: 1.0, inset: 0.4, segments: 14, bandW: 0.08 },
  chimney: { topShare: 0.85, rimH: 0.2, rimOut: 0.06, segments: 10 },
  arc: { variants: 4, segments: 7, jitter: 0.12, thickness: 0.05, rate: 9, minIntensity: 0.55, idleChance: 0.15 },
  levitate: { amp: 0.18, freq: 0.35, spin: 0.9, idleShare: 0.35 },
  crane: {
    bridgeSpeed: 2.4, trolleySpeed: 1.6, dwell: 3.0, hookEdge: 0.3, hookRetract: 0.4, hookMinDrop: 0.9, hookClearance: 0.2,
    maxJerkSteps: 5, beamPulse: 1.5,
    light: {
      legW: 0.4, legZ: 0.75, footW: 0.6, footH: 0.55, footD: 2.4, footY: 0.4, legY0: 0.95, braceT: 0.18, braceZ: 1.5,
      braceGap: 1.2, crossH: 0.3, crossD: 1.8, crossY: 1.1, girderH: 0.6, girderD: 0.35, girderZ: 0.55, girderOver: 0.4,
      capW: 0.9, capH: 0.25, capD: 2.0, markLen: 2.4, markH: 0.5, markX: 7.9, teamLen: 10, teamH: 0.3,
      cabinW: 1.4, cabinH: 1.1, cabinD: 1.3, cabinX: -7.4, trolleyW: 2.0, trolleyH: 0.45, trolleyD: 1.7, winchW: 0.8, winchH: 0.5,
      cableR: 0.035, cableX: 0.12, blockW: 0.5, blockH: 0.55, blockD: 0.35, hookR: 0.16, hookT: 0.05, hooks: 1,
      rivetStep: 0, spikeH: 0,
    },
    heavy: {
      legW: 0.7, legZ: 0.85, footW: 0.9, footH: 0.7, footD: 2.8, footY: 0.4, legY0: 1.1, braceT: 0.3, braceZ: 1.7,
      braceGap: 1.4, crossH: 0.45, crossD: 2.1, crossY: 1.3, girderH: 0.9, girderD: 0.5, girderZ: 0.65, girderOver: 0.6,
      capW: 1.2, capH: 0.35, capD: 2.4, markLen: 2.4, markH: 0.6, markX: 7.8, teamLen: 9, teamH: 0.35,
      cabinW: 1.8, cabinH: 1.4, cabinD: 1.6, cabinX: -7.0, trolleyW: 2.4, trolleyH: 0.6, trolleyD: 2.0, winchW: 1.0, winchH: 0.7,
      cableR: 0.07, cableX: 0, blockW: 0.8, blockH: 0.75, blockD: 0.5, hookR: 0.24, hookT: 0.08, hooks: 2,
      rivetStep: 0.8, rivetR: 0.06, spikeH: 0.7, spikeR: 0.16,
    },
    plasma: {
      runnerW: 0.38, runnerH: 0.55, runnerD: 2.2, gauge: 0.75, archT: 0.14, collarR: 0.2, collarH: 0.24, nozzleR: 0.13,
      ringR: 0.55, ringT: 0.06, ringLift: 0.85, beamR: 0.09, ballR: 0.16, rest: 0.25, minDrop: 0.5,
    },
    tractor: {
      runnerW: 0.28, runnerH: 1.5, runnerD: 1.6, gauge: 0.85, plateH: 0.22, plateD: 1.4, lensR: 0.16, lensH: 0.18,
      headS: 0.42, beamT: 0.05, cargo: 0.62, cargoH: 0.48, rest: 0.25, minDrop: 0.6, finH: 0.6,
    },
  },
  emblem: {
    textureSize: 256, padding: 0.08, blur: 18, haloPasses: 2, coreWhite: 0.45,
    curveSegments: 10, arcSegments: 16, decalOffset: 0.03, paintRough: 0.7, polygonOffset: -2,
  },
};

const M = PROC_MODULES;
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

/** Glow pulse 1 − depth … 1 (sine, `hz` per second) */
export const pulseWave = (time, hz, depth = M.pulse.depth) => 1 - depth * (0.5 + 0.5 * Math.sin(TAU * hz * time));

// ---------------------------------------------------------------- style kit

function styleSurfaces(st) {
  const p = st.palette;
  const P = M.surfaces;
  const s = (color, params, extra = {}) => surface(color, { ...params, ...extra });
  return {
    hull: s(p.base, st.surface),
    hullDark: s(p.secondary, P.hullDark),
    frame: s(p.metal, P.frame),
    lower: s(p.lower, P.lower),
    ground: s(p.ground, P.ground),
    pipe: s(p.pipe, P.pipe),
    accent: s(p.accent, P.accent),
    dark: s(p.dark, P.dark),
    rubber: s(p.dark, P.rubber),
    team: s(M.teamWhite, P.team, { team: 1 }),
    neon: s(st.neonTeam ? M.neonTeamWhite : p.neon, P.neon, { team: st.neonTeam ? 1 : 0, glow: lerp(M.neonGlow[0], M.neonGlow[1], st.neon) }),
    window: s(p.window, P.window, { glow: lerp(M.windowGlow[0], M.windowGlow[1], st.neon) }),
    interior: s(p.interior, P.interior),
    lens: s(p.beacon, P.lens),
    lamp: s(p.lamp, P.lamp),
    trim: s(p.trim, P.trim),
    hole: s(M.holeColor, P.hole),
    plasma: s(p.neon, P.plasma),
  };
}

const kitCache = new Map();   // style key -> kit

/**
 * Style kit of a race: { key, style, S (surfaces), rich (lots of neon), glowColors } – shared, read-only.
 * Needs loadBuildingStyles() done. Unknown race → first style in the data.
 */
export function styleKit(race) {
  const key = resolveStyleKey(race);
  let kit = kitCache.get(key);
  if (!kit) {
    const style = getBuildingStyle(key);
    const p = style.palette;
    const light = style.lights === 'lamp' ? p.lamp : p.beacon;
    kit = Object.freeze({
      key,
      style,
      S: styleSurfaces(style),
      rich: style.neon >= M.richNeon,
      glowColors: Object.freeze({ beacon: light, pulse: p.neon, radiator: p.neon, laser: p.neon, arc: p.neon, beam: p.neon, reactor: style.reactorGlow }),
    });
    kitCache.set(key, kit);
  }
  return kit;
}

// ---------------------------------------------------------------- glow layers

// Glow halos never cast shadows, even when the caller sets castShadow on every mesh (Structure.load does)
const noShadow = (mesh) => Object.defineProperty(mesh, 'castShadow', { get: () => false, set: () => {} });

/**
 * Additive glow mesh with its own material (same shader program for all instances – only the opacity differs).
 * setIntensity(0..1) fades it; at 0 the mesh is hidden (no draw call).
 */
export class GlowLayer {
  constructor(geometry, color, { opacity = M.glow.opacity, visible = true } = {}) {
    this.base = opacity;
    this.material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    noShadow(this.mesh);
    this.intensity = -1;
    this.setIntensity(visible ? 1 : 0);
  }

  setIntensity(v) {
    if (v === this.intensity) return;
    this.intensity = v;
    this.material.opacity = this.base * v;
    this.mesh.visible = v > M.glow.cutoff;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.material.dispose();
  }
}

/** Named GlowBuilders of one building (e.g. 'beaconA', 'pulse', 'radiator', 'laser'); build() → { name: geometry } */
export class GlowSet {
  constructor() { this.layers = {}; }
  get(name) { return (this.layers[name] ??= new GlowBuilder()); }
  build() {
    const out = {};
    for (const [name, g] of Object.entries(this.layers)) {
      const geo = g.build();
      if (geo) out[name] = geo;
    }
    return out;
  }
}

// ---------------------------------------------------------------- shared cache + model base class

function disposeGeometries(value) {
  if (!value || typeof value !== 'object') return;
  if (value.isBufferGeometry) { value.dispose(); return; }
  if (Array.isArray(value)) { for (const v of value) disposeGeometries(v); return; }
  if (Object.getPrototypeOf(value) !== Object.prototype) return;   // only plain data objects are walked
  for (const v of Object.values(value)) disposeGeometries(v);
}

/**
 * Per-style cache of the shared data of one building type. `build(kit)` returns a plain object (geometries, arrays,
 * numbers); every BufferGeometry in it is disposed when the last model of that style is disposed.
 */
export function createSharedCache(build) {
  const entries = new Map();   // style key -> { users, data }
  return {
    acquire(kit) {
      let e = entries.get(kit.key);
      if (!e) {
        e = { users: 0, data: build(kit) };
        entries.set(kit.key, e);
      }
      e.users++;
      return e.data;
    },
    release(kit) {
      const e = entries.get(kit.key);
      if (!e || --e.users > 0) return;
      disposeGeometries(e.data);
      entries.delete(kit.key);
    },
  };
}

/**
 * Base class of a procedural building model (THREE.Group). Subclasses build their meshes in the constructor with
 * paintMesh / glowLayer / emblem and override update(delta, active).
 */
export class ProcModel extends THREE.Group {
  /**
   * @param {object} o
   * @param {string} o.race       race key (unknown → first style)
   * @param {THREE.ColorRepresentation} [o.teamColor]
   * @param {object} o.cache      createSharedCache(...) of the building type
   * @param {string} [o.name]
   */
  constructor({ race, teamColor = M.defaultTeamColor, cache, name = 'ProcModel' }) {
    super();
    this.kit = styleKit(race);
    this.race = race;
    this.name = `${name}${this.kit.key}`;
    this.userData.procedural = true;
    this.cache = cache;
    this.shared = cache.acquire(this.kit);
    this.paint = acquirePaintMaterial(teamColor, this.kit.style.texture);
    this.paintMeshes = [];
    this.glowLayers = [];       // (not `layers` – that is Object3D's render-layer mask)
    this.ownGeometries = [];
    this.emblemMaterial = null;
  }

  /** Mesh with the shared paint material (casts / receives shadows) */
  paintMesh(geometry, parent = this) {
    const mesh = new THREE.Mesh(geometry, this.paint);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.paintMeshes.push(mesh);
    return mesh;
  }

  /** Glow layer (own material, disposed with the model) */
  glowLayer(geometry, color, { parent = this, opacity, visible = true } = {}) {
    const layer = new GlowLayer(geometry, color, { opacity, visible });
    parent.add(layer.mesh);
    this.glowLayers.push(layer);
    return layer;
  }

  /** Emblem decal mesh (shared emblem material of the style); null geometry → null */
  emblem(geometry, parent = this) {
    if (!geometry) return null;
    this.emblemMaterial ??= acquireEmblemMaterial(this.kit);
    const mesh = new THREE.Mesh(geometry, this.emblemMaterial);
    noShadow(mesh);
    mesh.receiveShadow = this.kit.style.emblem.render !== 'neon';
    parent.add(mesh);
    return mesh;
  }

  /** Per-instance geometry sharing the attributes of a shared one (own draw range, e.g. arcs); disposed with the model */
  instanceGeometry(shared) {
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(shared.attributes)) g.setAttribute(name, attr);
    if (shared.index) g.setIndex(shared.index);
    g.boundingSphere = shared.boundingSphere?.clone() ?? null;
    g.boundingBox = shared.boundingBox?.clone() ?? null;
    this.ownGeometries.push(g);
    return g;
  }

  /** Team colour (shared paint material per colour + texture) */
  setTeamColor(color) {
    const next = acquirePaintMaterial(color, this.kit.style.texture);
    const prev = this.paint;
    this.paint = next;
    for (const mesh of this.paintMeshes) mesh.material = next;
    releasePaintMaterial(prev);
  }

  /** Per-frame animation – override (no allocations) */
  update() {}

  /** { triangles, drawCalls, visibleDrawCalls } of this instance (main pass; shadows add the paint meshes again) */
  stats() {
    let triangles = 0;
    let drawCalls = 0;
    let visibleDrawCalls = 0;
    this.traverse((o) => {
      if (!o.isMesh) return;
      triangles += triangleCount(o.geometry);
      drawCalls++;
      if (o.visible) visibleDrawCalls++;
    });
    return { triangles, drawCalls, visibleDrawCalls };
  }

  /** Removes the model from the scene and releases everything it holds (shared data is ref-counted) */
  dispose() {
    if (!this.shared) return;
    this.removeFromParent();
    for (const layer of this.glowLayers) layer.dispose();
    this.clear();
    releasePaintMaterial(this.paint);
    if (this.emblemMaterial) releaseEmblemMaterial(this.kit);
    for (const g of this.ownGeometries) g.dispose();
    this.cache.release(this.kit);
    this.shared = null;
    this.paintMeshes.length = 0;
    this.glowLayers.length = 0;
    this.ownGeometries.length = 0;
    this.emblemMaterial = null;
  }
}

// ---------------------------------------------------------------- static writers (construction time only)

/** Box with the style's edges (rounded / chamfered / sharp); same arguments as PartBuilder.box. Small boxes stay sharp. */
export function styledBox(b, kit, w, h, d, s, t = {}, edgeScale = 1) {
  const e = kit.style.edges;
  const minSide = Math.min(w, h, d);
  const r = Math.min(e.radius * edgeScale, minSide * M.edgeMaxShare);
  if (e.segments < 1 || r < M.edgeMinRadius || minSide < M.edgeMinSide) return b.box(w, h, d, s, t);
  return b.roundedBox(w, h, d, r, e.segments, s, t);
}

/**
 * Danger marking on a flat strip (length along X, height along Y, facing +Z, centred): style.markings 'hazard' =
 * yellow/black stripes, 'light' = thin neon line, 'none' = nothing.
 */
export function marking(b, kit, length, height, t = {}) {
  const m = kit.style.markings;
  if (m === 'hazard') b.hazardStrip(length, height, height, kit.S.accent, kit.S.dark, t);
  else if (m === 'light') b.box(length, height * M.lightMarkingShare, M.lightMarkingDepth, kit.S.neon, t);
  return b;
}

/** Neon strip (glow by style.neon, team colour when style.neonTeam) */
export const neonStrip = (b, kit, w, h, d, t = {}) => b.box(w, h, d, kit.S.neon, t);

/** Warning / position light with its base at [x, y, z]: caged warm lamp (style.lights 'lamp') or neon lens; halo → glow */
export function beacon(b, glow, kit, [x, y, z]) {
  const S = kit.S;
  const B = M.beacon;
  if (kit.style.lights === 'lamp') {
    const cy = y + B.baseH + B.lampR;
    b.cylinder(B.lampBaseR, B.lampBaseR * 1.2, B.baseH, 8, S.dark, { x, y: y + B.baseH / 2, z });
    b.sphere(B.lampR, 8, 6, S.lamp, { x, y: cy, z });
    for (let i = 0; i < B.cageBars; i++) {
      const a = (i / B.cageBars) * TAU;
      b.box(B.barT, B.lampR * 2.4, B.barT, S.frame, { x: x + Math.cos(a) * B.lampR * 1.15, y: cy, z: z + Math.sin(a) * B.lampR * 1.15 });
    }
    b.torus(B.lampR * 1.15, B.barT * 0.6, 3, 10, TAU, S.frame, { rx: Math.PI / 2, x, y: cy + B.lampR * 1.2, z });
    glow?.point([x, cy, z], M.glow.radius * B.lampHalo);
  } else {
    b.box(B.baseW, B.baseH, B.baseW, S.dark, { base: true, x, y, z });
    const cy = y + B.baseH + B.lensH / 2;
    b.cylinder(B.lensR, B.lensR, B.lensH, 10, S.lens, { x, y: cy, z });
    glow?.point([x, cy, z], M.glow.radius);
  }
  return b;
}

/** Fan housing on a roof at surface height y ('guarded' with grille, 'open' bare). Returns { fan: [x,y,z], r, blades }. */
export function fanHousing(b, kit, { x, y, z, r }) {
  const S = kit.S;
  const F = M.fan;
  const open = kit.style.fan === 'open';
  const R = open ? r * F.openSize : r;
  const h = F.housingH;
  b.cylinder(R, R + F.lip, h, F.segments, S.hullDark, { x, y: y + h / 2, z });
  b.cylinder(R - F.lip, R - F.lip, 0.02, F.segments, S.hole, { x, y: y + h + 0.01, z });
  if (open) {
    b.torus(R, F.rimT, 4, F.segments, TAU, S.frame, { rx: Math.PI / 2, x, y: y + h, z });
    for (let i = 0; i < F.bolts; i++) {
      const a = (i / F.bolts) * TAU;
      b.cylinder(F.boltR, F.boltR, F.boltH, 5, S.trim, { x: x + Math.cos(a) * R, y: y + h + F.boltH / 2, z: z + Math.sin(a) * R });
    }
  } else {
    const gy = y + h + F.grilleRise;
    for (let k = 1; k <= F.grilleRings; k++) b.torus((R * k) / F.grilleRings, F.rimT, 4, F.segments, TAU, S.frame, { rx: Math.PI / 2, x, y: gy, z });
    for (let i = 0; i < F.grilleBars; i++) b.box(R * 2, F.barH, F.barT, S.frame, { x, y: gy, z, ry: (i / F.grilleBars) * Math.PI });
  }
  return { fan: [x, y + h + F.bladeLift, z], r: R, blades: open ? F.openBlades : F.guardedBlades };
}

/** Shared fan rotor geometry (hub + pitched blades), origin at the hub */
export function fanBladesGeometry(kit, r, blades) {
  const F = M.fan;
  const s = kit.style.fan === 'open' ? kit.S.trim : kit.S.hullDark;
  const b = new PartBuilder();
  b.cylinder(F.hubR, F.hubR, F.hubH, 10, kit.S.frame);
  const len = r * F.bladeShare;
  for (let i = 0; i < blades; i++) {
    const g = new THREE.BoxGeometry(len, F.bladeT, F.bladeW);
    g.rotateX(F.pitch);
    g.translate(len / 2 + F.hubR / 2, 0, 0);
    g.rotateY((i / blades) * TAU);
    b.add(g, s);
  }
  return b.build();
}

/** Radiator block (fins) at surface height y; glowing fin edges go to `glow` (heat up while producing) */
export function radiator(b, glow, kit, { x, y, z, w, d, h }) {
  const S = kit.S;
  const R = M.radiator;
  b.box(w + R.frame * 2, R.baseH, d + R.frame * 2, S.hullDark, { base: true, x, y, z });
  const top = y + R.baseH;
  const n = Math.max(2, Math.floor(w / R.finStep));
  for (let i = 0; i < n; i++) {
    const fx = x - w / 2 + (i + 0.5) * (w / n);
    b.box(R.finT, h, d, S.frame, { base: true, x: fx, y: top, z });
    glow?.box(R.glowT, h * R.glowH, d * R.glowD, { x: fx, y: top + h / 2, z });
  }
  for (const e of [-1, 1]) b.box(w + R.frame * 2, h, R.frame, S.hullDark, { base: true, x, y: top, z: z + e * (d / 2 + R.frame / 2) });
  return b;
}

/** Plasma orb on a pedestal at surface height y (core paint glows, halo → glow). Returns the ring spot { x, y, z, r }. */
export function plasmaOrb(b, glow, kit, { x, y, z, r }) {
  const S = kit.S;
  const P = M.orb;
  b.cylinder(r * P.baseR, r * P.baseR * 1.25, r * P.baseH, 16, S.hullDark, { x, y: y + (r * P.baseH) / 2, z });
  const cy = y + r * P.baseH + r * P.lift;
  b.sphere(r, 16, 10, S.plasma, { x, y: cy, z });
  b.torus(r * P.cradleR, r * P.cradleT, 4, 16, Math.PI, S.trim, { x, y: cy, z, rz: Math.PI });
  glow?.sphere(r * P.halo, 12, 8, { x, y: cy, z });
  return { x, y: cy, z, r: r * P.ringR };
}

/** Shared levitating ring geometry (horizontal neon torus), origin at its centre */
export function ringGeometry(kit, r, tube = M.orb.ringT) {
  const b = new PartBuilder();
  b.torus(r, tube, 6, 32, TAU, kit.S.neon, { rx: Math.PI / 2 });
  return b.build();
}

/** Ventilation slot by style.fan: fan housing ('guarded' / 'open'), radiator, or plasma orb ('none'). */
export function ventUnit(b, glows, kit, { x, y, z, r }) {
  switch (kit.style.fan) {
    case 'guarded':
    case 'open':
      return fanHousing(b, kit, { x, y, z, r });
    case 'radiator':
      radiator(b, glows.get('radiator'), kit, { x, y, z, w: r * 2, d: r * 2, h: r * M.radiator.heightShare });
      return { radiator: true };
    default:
      return { ring: plasmaOrb(b, glows.get('pulse'), kit, { x, y, z, r: r * M.orb.sizeShare }) };
  }
}

/** Tesla-like plasma coil standing at [x, y, z] (height h, winding radius r). Returns its top point (arc anchor). */
export function plasmaCoil(b, glow, kit, { x, y, z, h, r }) {
  const S = kit.S;
  const C = M.coil;
  b.cylinder(r * C.coreShare, r * C.coreShare * 1.2, h, 12, S.hullDark, { x, y: y + h / 2, z });
  const n = Math.max(2, Math.floor(h / C.step));
  for (let i = 1; i < n; i++) {
    const wy = y + (i / n) * h;
    b.torus(r * (1 - (i / n) * 0.3), C.tube, 4, 14, TAU, S.trim, { rx: Math.PI / 2, x, y: wy, z });
    glow?.torus(r * (1 - (i / n) * 0.3) * 0.85, C.glowTube, 3, 14, TAU, { rx: Math.PI / 2, x, y: wy + C.step / 2, z });
  }
  const top = y + h + r * C.capShare;
  b.sphere(r * C.capShare, 14, 8, S.plasma, { x, y: top, z });
  glow?.sphere(r * C.halo, 10, 6, { x, y: top, z });
  return [x, top, z];
}

/** Laser link between two points: emitter nubs (paint) at both ends, the beam in `glow` */
export function laserLink(b, glow, kit, a, c) {
  for (const p of [a, c]) b.sphere(M.laser.nubR, 8, 6, kit.S.lens, { x: p[0], y: p[1], z: p[2] });
  glow?.segment(a, c, M.laser.thickness);
  return b;
}

/** Four-sided spike standing at [x, y, z] */
export function spike(b, kit, { x, y, z, h, r, s = kit.S.frame }) {
  return b.cylinder(0, r, h, M.spike.segments, s, { x, y: y + h / 2, z, ry: Math.PI / 4 });
}

/** Crane guide rails on a roof, styled by style.crane; rails = [{ x, y }] (y = surface under the rail) */
export function roofRails(b, kit, rails, { z, length }) {
  const S = kit.S;
  const R = M.rail;
  const kind = kit.style.crane;
  for (const { x, y } of rails) {
    if (kind === 'heavyGantry') {
      b.box(R.heavyW, R.heavyH, length, S.dark, { x, y: y + R.heavyH / 2, z });
      for (let k = z - length / 2 + R.boltStep / 2; k < z + length / 2; k += R.boltStep) {
        for (const e of [-1, 1]) b.cylinder(R.boltR, R.boltR, R.heavyH + 0.04, 5, S.trim, { x: x + e * (R.heavyW / 2 - R.boltR * 2), y: y + R.heavyH / 2, z: k });
      }
    } else if (kind === 'plasma' || kind === 'tractorBeam') {
      b.box(R.channelW, R.h, length, kind === 'plasma' ? S.trim : S.hullDark, { x, y: y + R.h / 2, z });
      neonStrip(b, kit, R.grooveW, 0.02, length - 0.2, { x, y: y + R.h + 0.01, z });
    } else {
      b.box(R.w, R.h, length, S.frame, { x, y: y + R.h / 2, z });
      for (const e of [-1, 1]) b.box(R.line, R.h + 0.03, length, S.accent, { x: x + e * (R.w / 2 - R.line / 2), y: y + (R.h + 0.03) / 2, z });
      for (let k = z - length / 2 + 0.5; k < z + length / 2; k += R.tieStep) b.box(R.w + R.tieExtra, R.tieH, R.tieD, S.dark, { x, y: y + R.tieH / 2, z: k });
    }
  }
  return b;
}

/** Pipe run along a polyline (industrial styles only). Returns false when the style has no industry. */
export function pipeRun(b, kit, points, r) {
  if (!kit.style.industrial) return false;
  b.pipe(points, r, M.pipeSegments, kit.S.pipe);
  return true;
}

/** Horizontal tank on saddles (industrial only), centre [x, y, z], along X turned by ry */
export function tank(b, kit, { x, y, z, r, len, ry = 0, floorY = 0 }) {
  if (!kit.style.industrial) return false;
  const T = M.tank;
  const S = kit.S;
  b.cylinder(r, r, len, T.segments, S.trim, { rz: Math.PI / 2, ry, x, y, z });
  const c = Math.cos(ry);
  const sn = Math.sin(ry);
  for (const e of [-1, 1]) {
    const o = e * (len / 2 - T.inset);
    b.box(T.saddleW, y - floorY, T.saddleD, S.frame, { base: true, x: x + o * c, y: floorY, z: z - o * sn, ry });
  }
  b.box(T.bandW, r * 2.04, r * 2.04, S.team, { x, y, z, ry });
  return true;
}

/** Chimney standing at [x, y, z] (industrial only). Returns the top point (smoke anchor) or null. */
export function chimney(b, kit, { x, y, z, h, r }) {
  if (!kit.style.industrial) return null;
  const C = M.chimney;
  b.cylinder(r * C.topShare, r, h, C.segments, kit.S.frame, { x, y: y + h / 2, z });
  b.cylinder(r * C.topShare + C.rimOut, r * C.topShare + C.rimOut, C.rimH, C.segments, kit.S.dark, { x, y: y + h - C.rimH / 2, z });
  return [x, y + h, z];
}

// ---------------------------------------------------------------- electric arcs

/**
 * Electric arcs between pairs of points ([[a, c], …]) as glow geometry with `variants` jagged versions; every variant
 * holds all pairs. Returns { geometry, ranges: [[start, count], …] } – show one range at a time (ArcFlicker).
 */
export function arcGeometry(pairs, seed, o = M.arc) {
  const rng = makeRng(seed);
  const g = new GlowBuilder();
  const ranges = [];
  for (let v = 0; v < o.variants; v++) {
    const start = g.vertices;
    for (const [a, c] of pairs) {
      const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      let prev = a;
      for (let i = 1; i <= o.segments; i++) {
        const t = i / o.segments;
        const p = [lerp(a[0], c[0], t), lerp(a[1], c[1], t), lerp(a[2], c[2], t)];
        if (i < o.segments) for (let k = 0; k < 3; k++) p[k] += (rng() - 0.5) * 2 * o.jitter * len;
        g.segment(prev, p, o.thickness);
        prev = p;
      }
    }
    ranges.push([start, g.vertices - start]);
  }
  return { geometry: g.build(), ranges };
}

/** Switches between arc variants (layer.mesh.geometry must be a per-instance geometry – ProcModel.instanceGeometry) */
export class ArcFlicker {
  constructor(layer, ranges, { rate = M.arc.rate, seed = 1 } = {}) {
    this.layer = layer;
    this.ranges = ranges;
    this.period = 1 / rate;
    this.rng = makeRng(seed);
    this.clock = 0;
    this.level = 0;
    this.#pick(true);
  }

  #pick(active) {
    const [start, count] = this.ranges[Math.floor(this.rng() * this.ranges.length)];
    this.layer.mesh.geometry.setDrawRange(start, count);
    const show = active || this.rng() < M.arc.idleChance;
    this.level = show ? M.arc.minIntensity + (1 - M.arc.minIntensity) * this.rng() : 0;
  }

  update(delta, active) {
    this.clock += delta;
    if (this.clock >= this.period) {
      this.clock %= this.period;
      this.#pick(active);
    }
    this.layer.setIntensity(this.level);
  }
}

// ---------------------------------------------------------------- levitation

/** Floating part: bobs in Y around its start height and spins (slower when idle) */
export class Levitator {
  constructor(object, { amp = M.levitate.amp, freq = M.levitate.freq, spin = M.levitate.spin, phase = 0 } = {}) {
    this.object = object;
    this.baseY = object.position.y;
    this.amp = amp; this.freq = freq; this.spin = spin;
    this.time = phase;
  }

  update(delta, active = true) {
    const k = active ? 1 : M.levitate.idleShare;
    this.time += delta * k;
    this.object.position.y = this.baseY + Math.sin(TAU * this.freq * this.time) * this.amp;
    this.object.rotation.y += delta * this.spin * k;
  }
}

// ---------------------------------------------------------------- cranes / manipulators

function gantryGeometry(kit, d, G) {
  const C = M.crane;
  const S = kit.S;
  const heavy = G.hooks > 1;
  const b = new PartBuilder();
  const glow = new GlowBuilder();
  const by = d.beamY;
  const legH = by - G.legY0;
  const legS = heavy ? S.hullDark : S.accent;
  const bandZ = G.girderZ + G.girderD / 2;
  for (const side of [-1, 1]) {
    const x = side * d.legX;
    b.box(G.footW, G.footH, G.footD, S.hullDark, { base: true, x, y: G.footY });
    for (const z of [-G.legZ, G.legZ]) b.box(G.legW, legH, G.legW, legS, { base: true, x, y: G.legY0, z });
    b.box(G.crossH, G.crossH, G.crossD, legS, { x, y: G.crossY });
    const bh = legH - G.braceGap;
    const a = Math.atan2(G.braceZ, bh);
    for (const sg of [-1, 1]) b.box(G.braceT, Math.hypot(G.braceZ, bh), G.braceT, S.frame, { x, y: G.crossY + bh / 2, rx: sg * a });
    const capY = by + G.girderH;
    b.box(G.capW, G.capH, G.capD, S.hullDark, { base: true, x, y: capY });
    beacon(b, glow, kit, [x, capY + G.capH, 0]);
    if (G.spikeH > 0) for (const e of [-1, 1]) spike(b, kit, { x, y: capY + G.capH, z: e * G.capD * 0.4, h: G.spikeH, r: G.spikeR });
    for (const zs of [-1, 1]) {
      marking(b, kit, G.markLen, G.markH, { ry: zs > 0 ? 0 : Math.PI, x: side * G.markX, y: by + G.girderH / 2, z: zs * (bandZ + 0.01) });
    }
  }
  for (const z of [-G.girderZ, G.girderZ]) b.box(d.legX * 2 + G.girderOver, G.girderH, G.girderD, S.accent, { base: true, y: by, z });
  for (const zs of [-1, 1]) b.box(G.teamLen, G.teamH, 0.04, S.team, { y: by + G.girderH / 2, z: zs * (bandZ + 0.02) });
  if (G.rivetStep > 0) {
    for (let x = -d.legX; x <= d.legX; x += G.rivetStep) {
      if (Math.abs(x) < G.teamLen / 2 + G.rivetR) continue;
      for (const zs of [-1, 1]) {
        for (const ry of [G.girderH * 0.25, G.girderH * 0.75]) {
          b.cylinder(G.rivetR, G.rivetR, 0.05, 5, S.trim, { rx: Math.PI / 2, x, y: by + ry, z: zs * (bandZ + 0.02) });
        }
      }
    }
  }
  b.box(G.cabinW, G.cabinH, G.cabinD, S.hullDark, { base: true, x: G.cabinX, y: by - G.cabinH });
  b.box(G.cabinW * 0.8, G.cabinH * 0.45, 0.05, S.window, { x: G.cabinX, y: by - G.cabinH * 0.4, z: G.cabinD / 2 + 0.02 });

  const tb = new PartBuilder();
  tb.box(G.trolleyW, G.trolleyH, G.trolleyD, S.hullDark, { base: true });
  tb.box(G.winchW, G.winchH, G.winchW, S.frame, { base: true, x: -G.winchW / 2, y: G.trolleyH });
  tb.box(G.trolleyW * 0.3, 0.06, 0.06, S.accent, { x: G.trolleyW / 4, y: G.trolleyH * 0.5, z: G.trolleyD / 2 + 0.02 });

  const cb = new PartBuilder();   // unit length, hanging down from the trolley (scaled in Y)
  if (heavy) cb.box(G.cableR * 2, 1, G.cableR, S.dark, { y: -0.5 });
  else for (const x of [-G.cableX, G.cableX]) cb.cylinder(G.cableR, G.cableR, 1, 5, S.frame, { x, y: -0.5 });

  const bb = new PartBuilder();
  bb.box(G.blockW, G.blockH, G.blockD, heavy ? S.hullDark : S.accent, { y: -G.blockH / 2 });
  for (let i = 0; i < G.hooks; i++) {
    const hx = G.hooks > 1 ? (i - (G.hooks - 1) / 2) * G.blockW * 0.5 : 0;
    bb.torus(G.hookR, G.hookT, 4, 8, Math.PI * 1.4, S.frame, { x: hx, y: -G.blockH - G.hookR * 0.75, rz: Math.PI * 0.8 });
  }

  const trolleyY = by + G.girderH;
  const railTop = d.rails[0].y + d.railH;
  return {
    bridge: b.build(), bridgeGlow: glow.build(), trolley: tb.build(), cable: cb.build(), cableGlow: false, block: bb.build(),
    ring: null, ringY: 0, trolleyY, beamMode: 'none',
    hookRest: C.hookRetract,
    hookFull: Math.max(C.hookRetract + C.hookMinDrop, trolleyY - railTop - G.blockH - C.hookClearance),
  };
}

function plasmaGeometry(kit, d) {
  const C = M.crane;
  const P = C.plasma;
  const S = kit.S;
  const rail = d.rails[0];
  const y0 = rail.y;
  const b = new PartBuilder();
  const glow = new GlowBuilder();
  for (const side of [-1, 1]) {
    const x = rail.x + side * P.gauge;
    styledBox(b, kit, P.runnerW, P.runnerH, P.runnerD, S.hullDark, { base: true, x, y: y0 });
    neonStrip(b, kit, 0.03, P.runnerH * 0.5, P.runnerD * 0.8, { x: x + side * (P.runnerW / 2 + 0.01), y: y0 + P.runnerH * 0.5 });
    glow.point([x, y0 + P.runnerH + 0.05, P.runnerD / 2 - 0.15], M.glow.radius * 0.7);
  }
  b.torus(P.gauge, P.archT, 6, 16, Math.PI, S.trim, { x: rail.x, y: y0 + P.runnerH });
  const trolleyY = y0 + P.runnerH + P.gauge - P.archT;

  const tb = new PartBuilder();
  tb.cylinder(P.collarR, P.collarR * 0.8, P.collarH, 12, S.trim, { y: -P.collarH / 2 });
  tb.sphere(P.nozzleR, 10, 6, S.plasma, { y: -P.collarH - P.nozzleR * 0.5 });

  const beam = new GlowBuilder();
  beam.cylinder(P.beamR, P.beamR, 1, 8, { y: -0.5 });
  const bb = new PartBuilder();
  bb.sphere(P.ballR, 10, 6, S.plasma, { y: -P.ballR });

  const railTop = y0 + d.railH;
  return {
    bridge: b.build(), bridgeGlow: glow.build(), trolley: tb.build(), cable: beam.build(), cableGlow: true, block: bb.build(),
    ring: ringGeometry(kit, P.ringR, P.ringT), ringY: P.ringLift, trolleyY, beamMode: 'dwell',
    hookRest: P.rest,
    hookFull: Math.max(P.rest + P.minDrop * 0.5, trolleyY - railTop - P.ballR * 2 - C.hookClearance),
  };
}

function tractorGeometry(kit, d) {
  const C = M.crane;
  const T = C.tractor;
  const S = kit.S;
  const rail = d.rails[0];
  const y0 = rail.y;
  const b = new PartBuilder();
  const glow = new GlowBuilder();
  for (const side of [-1, 1]) {
    const x = rail.x + side * T.gauge;
    styledBox(b, kit, T.runnerW, T.runnerH, T.runnerD, S.hullDark, { base: true, x, y: y0 });
    spike(b, kit, { x, y: y0 + T.runnerH + T.plateH, z: 0, h: T.finH, r: T.runnerW * 0.6, s: S.trim });
  }
  const top = y0 + T.runnerH;
  styledBox(b, kit, T.gauge * 2 + T.runnerW, T.plateH, T.plateD, S.hull, { base: true, x: rail.x, y: top });
  for (const e of [-1, 1]) neonStrip(b, kit, T.gauge * 2, 0.04, 0.03, { x: rail.x, y: top + T.plateH / 2, z: e * (T.plateD / 2 + 0.015) });
  for (const e of [-1, 1]) glow.point([rail.x + e * T.gauge, top + T.plateH + 0.05, T.plateD / 2 - 0.1], M.glow.radius * 0.6);

  const tb = new PartBuilder();   // emitter head under the plate
  const head = new THREE.BoxGeometry(T.headS, T.headS, T.headS);
  head.rotateY(Math.PI / 4);
  head.scale(1, 0.6, 1);
  tb.add(head, S.trim, { y: -T.headS * 0.3 });
  tb.cylinder(T.lensR, T.lensR * 0.7, T.lensH, 10, S.lens, { y: -T.headS * 0.6 - T.lensH / 2 });

  const beam = new GlowBuilder();
  beam.box(T.beamT, 1, T.beamT, { y: -0.5 });
  const bb = new PartBuilder();   // cargo carried by the beam (its top at the beam end)
  styledBox(bb, kit, T.cargo, T.cargoH, T.cargo, S.trim, { base: true, y: -T.cargoH });
  for (const e of [-1, 1]) neonStrip(bb, kit, T.cargo + 0.02, 0.03, 0.03, { y: -T.cargoH * 0.5, z: e * (T.cargo / 2 + 0.01) });

  const trolleyY = top;
  const railTop = y0 + d.railH;
  return {
    bridge: b.build(), bridgeGlow: glow.build(), trolley: tb.build(), cable: beam.build(), cableGlow: true, block: bb.build(),
    ring: null, ringY: 0, trolleyY, beamMode: 'carry',
    hookRest: T.rest + T.headS * 0.6 + T.lensH,
    hookFull: Math.max(T.rest + T.minDrop, trolleyY - railTop - T.cargoH - C.hookClearance),
  };
}

/**
 * Shared crane / manipulator geometry by style.crane. dims: { legX, beamY, rails: [{x, y}], railH }
 * (gantries span the building on legs; plasma / tractorBeam carriages ride the first roof rail).
 */
export function buildCraneGeometry(kit, dims) {
  switch (kit.style.crane) {
    case 'heavyGantry': return gantryGeometry(kit, dims, M.crane.heavy);
    case 'plasma': return plasmaGeometry(kit, dims);
    case 'tractorBeam': return tractorGeometry(kit, dims);
    default: return gantryGeometry(kit, dims, M.crane.light);
  }
}

/**
 * Animated crane of one model: bridge / carriage travels along Z, trolley along X between the rails, the hook / beam /
 * cargo goes down at every stop (TrackMover; style.anim tempo and jerk). dims: { rails, restZ, stopsZ }.
 */
export class CraneRig {
  constructor(model, g, kit, dims) {
    const C = M.crane;
    const an = kit.style.anim;
    this.g = g;
    const railXs = dims.rails.map((r) => r.x);
    this.bridge = model.paintMesh(g.bridge);
    this.bridge.position.z = dims.restZ;
    this.bridgeGlow = g.bridgeGlow ? model.glowLayer(g.bridgeGlow, kit.glowColors.beacon, { parent: this.bridge, visible: false }) : null;
    this.trolley = model.paintMesh(g.trolley, this.bridge);
    this.trolley.position.set(railXs[0], g.trolleyY, 0);
    if (g.cableGlow) {
      this.beam = model.glowLayer(g.cable, kit.glowColors.beam, { parent: this.trolley, visible: false });
      this.cable = this.beam.mesh;
    } else {
      this.beam = null;
      this.cable = model.paintMesh(g.cable, this.trolley);
    }
    this.block = model.paintMesh(g.block, this.trolley);
    this.levitator = null;
    if (g.ring) {
      const ring = model.paintMesh(g.ring, this.trolley);
      ring.position.y = g.ringY;
      this.levitator = new Levitator(ring, { amp: M.levitate.amp * an.levitate, spin: M.levitate.spin * an.spin });
    }
    this.pulseHz = an.pulse * C.beamPulse;
    this.mover = new TrackMover({
      rest: [dims.restZ, railXs[0]],
      stops: dims.stopsZ.map((z, i) => [z, railXs[i % railXs.length]]),
      speed: [C.bridgeSpeed * an.tempo, C.trolleySpeed * an.tempo],
      dwell: C.dwell / an.tempo,
      steps: Math.round(an.jerk * C.maxJerkSteps),
    });
    this.length = g.hookRest;
    this.time = 0;
    this.#apply();
  }

  #apply() {
    this.cable.scale.y = this.length;
    this.block.position.y = -this.length;
  }

  /**
   * @param {number} delta
   * @param {boolean} active  producing
   * @param {{off:boolean}} [blink]  Blinker of the building: the bridge lights are on in its `off` phase
   */
  update(delta, active, blink) {
    const g = this.g;
    const m = this.mover;
    m.update(delta, active);
    this.bridge.position.z = m.value[0];
    this.trolley.position.x = m.value[1];
    const down = plateau(m.dwellT, M.crane.hookEdge);
    this.length = g.hookRest + (g.hookFull - g.hookRest) * down;
    this.#apply();
    this.time += delta;
    if (this.beam) {
      const on = g.beamMode === 'dwell' ? down : (active || m.phase !== 'rest' ? 1 : 0);
      this.beam.setIntensity(on * pulseWave(this.time, this.pulseHz));
    }
    this.levitator?.update(delta, active);
    this.bridgeGlow?.setIntensity(blink?.off ? 1 : 0);
  }
}

// ---------------------------------------------------------------- emblem (faction sign)

/** SVG path strings of a race's emblem (viewBox 0 0 100 100, y down, fill-rule evenodd) */
export const emblemPaths = (race) => getBuildingStyle(resolveStyleKey(race)).emblem?.paths ?? [];

/** All emblem subpaths as one SVG `d` string – e.g. `new Path2D(emblemPathData(race))`, fill 'evenodd' */
export const emblemPathData = (race) => emblemPaths(race).join(' ');

/** Emblem colour (sRGB hex string) of a race */
export const emblemColor = (race) => getBuildingStyle(resolveStyleKey(race)).emblem?.color ?? '#ffffff';

const NUMBER_OR_COMMAND = /[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g;

// SVG endpoint arc (circle; rotation ignored) appended as line segments
function svgArc(path, x1, y1, x2, y2, r, large, sweep, segments) {
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const d2 = dx2 * dx2 + dy2 * dy2;
  if (d2 === 0) return;
  let rr = Math.max(r, Math.sqrt(d2));
  const sign = large === sweep ? -1 : 1;
  const coef = sign * Math.sqrt(Math.max(0, (rr * rr - d2) / d2));
  const cx = coef * dy2 + (x1 + x2) / 2;
  const cy = -coef * dx2 + (y1 + y2) / 2;
  rr = Math.hypot(x1 - cx, y1 - cy);
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let da = Math.atan2(y2 - cy, x2 - cx) - a1;
  if (sweep && da < 0) da += TAU;
  if (!sweep && da > 0) da -= TAU;
  const n = Math.max(2, Math.ceil((Math.abs(da) / TAU) * segments * 4));
  for (let i = 1; i <= n; i++) {
    const a = a1 + (da * i) / n;
    path.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
}

/** Minimal SVG path parser (M L H V Q C A Z, absolute and relative) → THREE.Shape subpaths in viewBox units */
function parseSvgPath(d, arcSegments) {
  const tokens = d.match(NUMBER_OR_COMMAND) ?? [];
  const isCmd = (tok) => /^[a-zA-Z]$/.test(tok);
  const out = [];
  let i = 0;
  let cmd = '';
  let x = 0; let y = 0; let sx = 0; let sy = 0;
  let path = null;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd || cmd === 'Z' || cmd === 'z') throw new Error(`[ProcModules] bad emblem path near token ${i}: ${d}`);
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num(); y = oy + num();
        path = new THREE.Shape();
        path.moveTo(x, y);
        out.push(path);
        sx = x; sy = y;
        cmd = rel ? 'l' : 'L';
        break;
      case 'L': x = ox + num(); y = oy + num(); path.lineTo(x, y); break;
      case 'H': x = ox + num(); path.lineTo(x, y); break;
      case 'V': y = oy + num(); path.lineTo(x, y); break;
      case 'Q': {
        const cx = ox + num(); const cy = oy + num();
        x = ox + num(); y = oy + num();
        path.quadraticCurveTo(cx, cy, x, y);
        break;
      }
      case 'C': {
        const c1x = ox + num(); const c1y = oy + num(); const c2x = ox + num(); const c2y = oy + num();
        x = ox + num(); y = oy + num();
        path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
        break;
      }
      case 'A': {
        const rx = num(); const ry = num(); num();
        const large = num(); const sweep = num();
        const nx = ox + num(); const ny = oy + num();
        svgArc(path, x, y, nx, ny, (rx + ry) / 2, large, sweep, arcSegments);
        x = nx; y = ny;
        break;
      }
      case 'Z':
        path.closePath();
        x = sx; y = sy;
        break;
      default: throw new Error(`[ProcModules] unsupported emblem path command ${cmd}`);
    }
  }
  return out;
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Emblem as THREE.Shape list in viewBox units (y down): even-odd nesting → subpaths inside another become its holes.
 * For extrusion / custom geometry; emblemShape() gives a ready mesh geometry.
 */
export function emblemShapes(race) {
  const E = M.emblem;
  const subpaths = parseSvgPath(emblemPathData(race), E.arcSegments);
  const polys = subpaths.map((s) => s.getPoints(E.curveSegments));
  const area = (poly) => Math.abs(THREE.ShapeUtils.area(poly));
  const containers = subpaths.map((_, i) => subpaths.map((__, j) => j).filter((j) => j !== i && pointInPolygon(polys[i][0], polys[j])));
  const shapes = [];
  subpaths.forEach((s, i) => {
    if (containers[i].length % 2 === 0) { shapes.push(s); return; }
    const parent = containers[i].filter((j) => containers[j].length % 2 === 0).sort((a, b) => area(polys[a]) - area(polys[b]))[0];
    if (parent !== undefined) subpaths[parent].holes.push(s);
  });
  return shapes;
}

/**
 * Extruded emblem geometry (caller owns it): `size` model units across the viewBox, `depth` thick, centred at the
 * origin, facing +Z, y up. For buildings shaped by the sign (HQ, reactor, towers).
 */
export function emblemShape(race, depth = 1, size = 1, { curveSegments = M.emblem.curveSegments } = {}) {
  const g = new THREE.ExtrudeGeometry(emblemShapes(race), { depth, bevelEnabled: false, curveSegments });
  const s = size / 100;
  g.translate(-50, -50, 0);
  g.scale(s, -s, -1);            // y up; z mirrored too so the winding (determinant) stays positive
  g.translate(0, 0, depth / 2);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const _dn = new THREE.Vector3();
const _du = new THREE.Vector3();
const _dz = new THREE.Vector3();
const _dm = new THREE.Matrix4();

/**
 * Emblem decal quads (merged, position + normal + uv) for ProcModel.emblem → one draw call per building.
 * placements: [{ position: [x,y,z], normal: [x,y,z], size, up?: [x,y,z] }] (quad lifted M.emblem.decalOffset off the wall)
 */
export function emblemDecalGeometry(placements) {
  if (!placements.length) return null;
  const parts = placements.map(({ position, normal, size, up }) => {
    const g = new THREE.PlaneGeometry(size, size);
    _dn.fromArray(normal).normalize();
    if (up) _du.fromArray(up); else _du.set(0, Math.abs(_dn.y) > 0.99 ? 0 : 1, Math.abs(_dn.y) > 0.99 ? -1 : 0);
    _dm.identity().lookAt(_dn, _dz.set(0, 0, 0), _du);   // local +Z → normal
    _dm.setPosition(position[0] + _dn.x * M.emblem.decalOffset, position[1] + _dn.y * M.emblem.decalOffset, position[2] + _dn.z * M.emblem.decalOffset);
    g.applyMatrix4(_dm);
    return g;
  });
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

const WHITE = new THREE.Color(1, 1, 1);

function createEmblemTexture(style) {
  const E = M.emblem;
  const e = style.emblem;
  const size = E.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const path = new Path2D(e.paths.join(' '));
  const scale = (size * (1 - 2 * E.padding)) / 100;
  ctx.setTransform(scale, 0, 0, scale, size * E.padding, size * E.padding);
  const color = new THREE.Color(e.color);
  const hex = `#${color.getHexString()}`;
  if (e.render === 'neon') {
    ctx.shadowColor = hex;
    ctx.shadowBlur = E.blur;
    ctx.fillStyle = hex;
    for (let k = 0; k < E.haloPasses; k++) ctx.fill(path, 'evenodd');
    ctx.shadowBlur = 0;
    ctx.fillStyle = `#${color.clone().lerp(WHITE, E.coreWhite).getHexString()}`;
  } else {
    ctx.fillStyle = hex;
  }
  ctx.fill(path, 'evenodd');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const emblemCache = new Map();   // style key -> { material, texture, users }

/** Shared decal material of a style (neon: unlit glowing sign; paint: lit paint with a faint backlight), ref-counted */
export function acquireEmblemMaterial(kit) {
  let entry = emblemCache.get(kit.key);
  if (!entry) {
    const E = M.emblem;
    const e = kit.style.emblem;
    const texture = createEmblemTexture(kit.style);
    const common = {
      map: texture, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: E.polygonOffset, polygonOffsetUnits: E.polygonOffset,
    };
    const material = e.render === 'neon'
      ? new THREE.MeshBasicMaterial({ ...common, toneMapped: false })
      : new THREE.MeshStandardMaterial({
        ...common, roughness: E.paintRough, metalness: 0, emissive: WHITE, emissiveMap: texture, emissiveIntensity: e.backlight ?? 0,
      });
    entry = { material, texture, users: 0 };
    emblemCache.set(kit.key, entry);
  }
  entry.users++;
  return entry.material;
}

export function releaseEmblemMaterial(kit) {
  const entry = emblemCache.get(kit.key);
  if (!entry || --entry.users > 0) return;
  entry.material.dispose();
  entry.texture.dispose();
  emblemCache.delete(kit.key);
}
