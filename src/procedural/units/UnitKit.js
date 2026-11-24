// Steel Mans – procedural unit kit (roadmap U0): base of vehicles and aircraft generated in code, the unit analogue of
// ProcModules.ProcModel. A unit = ONE rigid "skeleton" (THREE.Bone per moving part: hull, turret, barrel, recoil,
// sprockets, track cleats, wheels, exhaust flames, muzzle flash…) and at most three skinned meshes sharing it:
//   • paint   – every painted part of the unit (ProcKit paint shader, vertex colour + aSurface), 1 draw call + shadow
//   • glow    – additive glow parts (exhaust, hover pads, lenses, arcs, flash, status lamp): vertex colours, 1 draw call
//   • emblem  – faction sign decals in the team colour (ProcModules emblem material), 1 draw call
// Every vertex is weighted 1.0 to exactly one bone and authored in that bone's local space (bind matrix and bone
// inverses = identity), so animating a part = setting a bone's position / rotation / scale – no per-part meshes, no
// allocations. Geometry is built once per (style, variant) and shared (createUnitCache, ref-counted).
// Far units (LOD1 / LOD2) are drawn by UnitBatcher as InstancedMesh per (unit type, style, far group, LOD): the body
// and the turret are separate far groups (the turret keeps its yaw), instance matrices are rewritten every rendered
// frame (units move), team colour + hover highlight go to the aInst attribute (ProcKit instanced paint material).
// Picking goes through an invisible proxy mesh (coarsest body LOD); the skinned meshes are never raycast.
// Code reads style properties only (data/buildingStyles.json, optional block `unit`), never faction names. Visual only:
// nothing here touches the simulation, tick() allocates nothing, no Math.random / performance.now.
// See docs/notes/proc-unit-kit.md (model convention, template, integration).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  PartBuilder, place, acquirePaintMaterial, releasePaintMaterial, acquireInstancedPaintMaterial,
  releaseInstancedPaintMaterial, triangleCount, smootherstep,
} from '../ProcKit.js';
import { styleKit, noRaycast, acquireEmblemMaterial, releaseEmblemMaterial, emblemDecalGeometry } from '../ProcModules.js';
import { HIGHLIGHT, BUILDING_LOD } from '../../config.js';
import { getBuildingQuality, onBuildingQualityChange } from '../../core/Graphics.js';

const TAU = Math.PI * 2;

/** Kit tuning (visual only; model units, seconds, radians) */
export const UNIT_KIT = {
  defaultTeamColor: '#3a5ccc',
  phaseStep: 2.399963,       // rad – golden angle between the animation phases of consecutive instances
  hiddenScale: 1e-4,         // bone scale of a hidden glow part (0 would be a degenerate matrix)
  glow: { opacity: 0.95, boundsScale: 1.6, pointDetail: 0 },   // boundsScale: culling sphere × this (flames stick out); point halo = octahedron of this detail (0 = 8 triangles)
  motion: {
    ease: 6,                 // 1/s – smoothing of speed / turn / acceleration
    refSpeed: 20,            // units/s – speed of full automatic throttle (setThrottle never called)
    steerGain: 0.6, maxSteer: 0.5,        // front wheel steering = turn rate × gain (clamped)
    pitchGain: 0.004, maxPitch: 0.06,     // hull nose up / down from acceleration
    rollGain: 0.0015, maxRoll: 0.05,      // ground hull leans out of a turn (turn × speed × gain)
    bankGain: 0.35, maxBank: 0.5,         // hover / aircraft hull banks into a turn (turn × gain)
  },
  flash: { time: 0.09, color: '#ffd28a', core: '#ffffff' },   // muzzle flash of guns (energy weapons: weapon glow)
  recoil: { time: 0.35, kick: 0.18 },    // kick = share of the time spent moving back
  spin: { ease: 4, linger: 0.8 },        // gatling barrels: 1/s spin-up, s spinning after the last shot
  lens: { idle: 0.6, depth: 0.25, boost: 1.7, boostTime: 0.3 },   // lens / plasma core pulse, flare on firing
  arc: { rate: 14, idleChance: 0.1, fireTime: 0.45, fireChance: 0.85 },   // lightning flicker (steps/s, chances)
  status: {
    // marker colours by state (semantic, not faction): null = lamp off
    colors: { idle: '#4cff7a', move: '#4cff7a', attack: '#ff3a2a', deployed: '#ffb020', cloaked: '#6a8cff', disabled: '#ffffff', none: null },
    blink: { disabled: 0.5, attack: 0.3 },   // s period of blinking states
  },
  cloak: { minOpacity: 0.16, shadowCutoff: 0.35, emblemCutoff: 0.5, depthCutoff: 0.5, tint: 0.35 },
  exhaust: {
    flickerRate: 23,         // rad/s of the main flicker wave (a second wave runs at × flickerHarmonic)
    flickerHarmonic: 2.3,
    // flame kinds; core = outer colour mixed towards coreTint by coreMix; length / width multiply the module size
    kinds: {
      ion: { coreTint: '#ffffff', coreMix: 0.6, length: 1.0, width: 1.0, flicker: 0.08, idle: 0.25 },
      rocket: { coreTint: '#ff8060', coreMix: 0.4, length: 1.6, width: 1.25, flicker: 0.2, idle: 0.3 },   // red, hot pinkish core (not orange)
      plasma: { coreTint: '#7fa0ff', coreMix: 0.55, length: 0.9, width: 1.1, flicker: 0.3, idle: 0.3 },
      beam: { coreTint: '#ffffff', coreMix: 0.65, length: 1.3, width: 0.6, flicker: 0.04, idle: 0.35 },
    },
    // fallback flame kind by style.silhouette when style.unit.exhaust.kind is missing
    bySilhouette: { rounded: 'ion', angular: 'rocket', round: 'plasma', faceted: 'beam' },
    defaultKind: 'ion',
  },
};

/** Far LOD of units (UnitBatcher); distances camera → unit in world units, by the building quality level */
export const UNIT_LOD = {
  enabled: true,             // false = every unit keeps its own skinned meshes (window.steelMans.unitBatching = false too)
  quality: {
    high: { full: 170, mid: 380 },
    medium: { full: 120, mid: 280 },
    low: { full: 70, mid: 200 },
  },
  // part kept in LOD n when its largest side ≥ share × largest side of the whole unit (explicit `detail` wins);
  // coarser than buildings (BUILDING_LOD.partMinShare) – far units are small on screen and many
  partMinShare: [0, 0.05, 0.18],
  hysteresis: 0.12,          // a unit leaves its LOD only after passing the limit by this share
  maxFull: 48,               // at most this many units at LOD0 (the nearest; cloaked ones always)
  fullRankSlack: 4,
  updateFrames: 6,           // LOD decision every N rendered frames (matrices are written every frame)
  initialCapacity: 32,
  idleFrames: 240,           // an empty instance group is released after this many frames
};

const STATUS_COLORS = Object.fromEntries(
  Object.entries(UNIT_KIT.status.colors).map(([k, v]) => [k, v === null ? null : new THREE.Color(v)]),
);

// ---------------------------------------------------------------- unit style (data + fallbacks)

const unitStyleCache = new Map();   // style key -> resolved unit style

/**
 * Unit visual properties of a style kit: style.unit from data/buildingStyles.json when present, else fallbacks derived
 * from the building style (reactorGlow → exhaust, palette.neon → weapon glow, silhouette → flame kind).
 * { exhaust { kind, outer, core, length, width, flicker, idle }, hoverGlow, weaponGlow, plasma, cloakMin, cloakTint }
 */
export function unitStyle(kit) {
  let u = unitStyleCache.get(kit.key);
  if (u) return u;
  const st = kit.style;
  const d = st.unit ?? {};
  const ex = d.exhaust ?? {};
  const E = UNIT_KIT.exhaust;
  const kindName = Object.hasOwn(E.kinds, ex.kind) ? ex.kind : (E.bySilhouette[st.silhouette] ?? E.defaultKind);
  const kind = E.kinds[kindName];
  const outer = new THREE.Color(ex.outer ?? st.reactorGlow);
  const core = ex.core ? new THREE.Color(ex.core) : outer.clone().lerp(new THREE.Color(kind.coreTint), kind.coreMix);
  u = Object.freeze({
    exhaust: Object.freeze({
      kind: kindName, outer, core,
      length: ex.length ?? kind.length, width: ex.width ?? kind.width, flicker: ex.flicker ?? kind.flicker, idle: ex.idle ?? kind.idle,
    }),
    hoverGlow: new THREE.Color(d.hoverGlow ?? outer),
    weaponGlow: new THREE.Color(d.weaponGlow ?? st.palette.neon),
    plasma: new THREE.Color(d.plasma ?? st.reactorGlow),
    cloakMin: d.cloak?.minOpacity ?? UNIT_KIT.cloak.minOpacity,
    cloakTint: new THREE.Color(d.cloak?.tint ?? st.palette.neon),
  });
  unitStyleCache.set(kit.key, u);
  return u;
}

// ---------------------------------------------------------------- glow painter (additive, vertex colours)

/**
 * Collects additive glow primitives of one bone: position + colour (× intensity) + aGlowKind (0 fixed colour,
 * 1 = status colour uniform). Non-indexed, merged by build(). Construction time only.
 */
export class GlowPainter {
  constructor() { this.parts = []; }

  /** Adds a geometry (placement t, plus t.intensity) in colour `color`; kind 1 = tinted by the status colour */
  add(geo, color, t = {}, kind = 0) {
    place(geo, t);
    let g = geo;
    if (g.index) { g = geo.toNonIndexed(); geo.dispose(); }
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    const n = g.attributes.position.count;
    const c = new THREE.Color(color).multiplyScalar(t.intensity ?? 1);
    const col = new Float32Array(n * 3);
    const knd = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; knd[i] = kind; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aGlowKind', new THREE.BufferAttribute(knd, 1));
    this.parts.push(g);
    return this;
  }

  point([x, y, z], r, color, t = {}, kind = 0) {
    return this.add(new THREE.OctahedronGeometry(r, UNIT_KIT.glow.pointDetail), color, { ...t, x, y, z }, kind);
  }
  box(w, h, d, color, t) { return this.add(new THREE.BoxGeometry(w, h, d), color, t); }
  sphere(r, wSeg, hSeg, color, t) { return this.add(new THREE.SphereGeometry(r, wSeg, hSeg), color, t); }
  torus(r, tube, radial, tubular, color, t) { return this.add(new THREE.TorusGeometry(r, tube, radial, tubular), color, t); }
  cylinder(rTop, rBottom, h, seg, color, t, open = true) {
    return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open), color, t);
  }

  /** Flat disc (radius r) in the XZ plane (seen from above and below – the glow material is double-sided) */
  disc(r, seg, color, t = {}) { return this.add(new THREE.CircleGeometry(r, seg), color, { rx: -Math.PI / 2, ...t }); }

  /**
   * Cone / tube from z = 0 back to z = −len (exhaust direction): near radius at z = 0, far radius at z = −len.
   * Extra placement t is applied after (x, y, z offsets of the start point).
   */
  flame(nearR, farR, len, seg, color, t = {}, open = true) {
    const g = new THREE.CylinderGeometry(farR, nearR, len, seg, 1, open);
    g.translate(0, len / 2, 0);   // y 0..len, far end at +y
    g.rotateX(-Math.PI / 2);      // +y → −z
    return this.add(g, color, t);
  }

  /** Thin square beam from point a to point b ([x, y, z]) */
  segment(a, b, thickness, color) {
    const va = new THREE.Vector3().fromArray(a);
    const vb = new THREE.Vector3().fromArray(b);
    const len = va.distanceTo(vb);
    if (len <= 0) return this;
    const g = new THREE.BoxGeometry(thickness, len, thickness);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize()));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    return this.add(g, color);
  }

  build() {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return merged;
  }
}

// ---------------------------------------------------------------- unit builder (shared data of one unit type + style)

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const IDENTITY = new THREE.Matrix4();
const POSITION_PROPS = { x: 'x', y: 'y', z: 'z' };
const ROTATION_PROPS = { rx: 'x', ry: 'y', rz: 'z' };

// Every vertex belongs fully to one bone (rigid skinning)
function skinTo(geo, boneIndex) {
  const n = geo.attributes.position.count;
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { idx[i * 4] = boneIndex; w[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  return geo;
}

function mergeAndFree(parts) {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[UnitBuilder] merge failed (attribute mismatch)');
  return merged;
}

/**
 * Builds the shared data of a unit model: bones (rest pose), paint / glow / emblem geometries skinned to them, far LOD
 * geometries per far group, sockets, deploy channels and the animation meta the ProcUnit drivers read.
 * Modules (UnitModules.js) write into it; a model's build function returns builder.build().
 */
export class UnitBuilder {
  constructor(kit) {
    this.kit = kit;
    this.style = unitStyle(kit);
    this.boneDefs = [];        // { name, parent (index, -1 = model root), position, rotation, far }
    this.index = new Map();    // bone name -> index
    this.paints = new Map();   // bone index -> PartBuilder (bone-local space)
    this.glows = new Map();    // bone index -> GlowPainter
    this.decals = [];          // { bone, placements } emblem decals (ProcModules.emblemDecalGeometry placements)
    this.socketDefs = [];      // { name, bone, position, rotation }
    this.channelDefs = [];     // deploy channels { bone, prop, from, to }
    // animation meta read by the ProcUnit drivers (bone names, numbers – plain data)
    this.meta = {
      tracks: [], wheels: [], exhausts: [], flashes: [], recoils: [], spinners: [], lenses: [], arcs: [],
      hull: null, hoverGlow: null, status: null, turret: null, barrel: null, pitch: [0, 0],
      fire: {},                // socket name -> { flashes, recoils, spinners, lenses, arcs } (indices into the lists above)
      refSpeed: UNIT_KIT.motion.refSpeed,
    };
    this.bone('root', null);
  }

  /**
   * Adds a bone. far = the bone starts its own far LOD group (e.g. the turret: its far instance follows its yaw);
   * other bones are frozen in their rest pose into the far group of their nearest far ancestor (the root is one).
   */
  bone(name, parent = 'root', position = [0, 0, 0], { rotation = [0, 0, 0], far = false } = {}) {
    if (this.index.has(name)) throw new Error(`[UnitBuilder] bone "${name}" exists`);
    const p = parent === null ? -1 : this.boneIndex(parent);
    this.index.set(name, this.boneDefs.length);
    this.boneDefs.push({ name, parent: p, position: position.slice(), rotation: rotation.slice(), far: far || p < 0 });
    return name;
  }

  has(name) { return this.index.has(name); }

  boneIndex(name) {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`[UnitBuilder] unknown bone "${name}"`);
    return i;
  }

  /** PartBuilder of a bone (geometry in the bone's local space) */
  paint(bone = 'root') {
    const i = this.boneIndex(bone);
    let b = this.paints.get(i);
    if (!b) { b = new PartBuilder(); this.paints.set(i, b); }
    return b;
  }

  /** GlowPainter of a bone */
  glow(bone = 'root') {
    const i = this.boneIndex(bone);
    let g = this.glows.get(i);
    if (!g) { g = new GlowPainter(); this.glows.set(i, g); }
    return g;
  }

  /** Named attachment point (THREE.Object3D child of the bone at runtime) */
  socket(name, bone, position = [0, 0, 0], rotation = [0, 0, 0]) {
    this.boneIndex(bone);
    this.socketDefs.push({ name, bone, position: position.slice(), rotation: rotation.slice() });
    return name;
  }

  /** Emblem decals on a bone: [{ position, normal, size, up? }] in the bone's space */
  emblem(bone, placements) {
    this.boneIndex(bone);
    if (placements.length) this.decals.push({ bone, placements });
  }

  /** Deploy channel: setDeployed(1) moves bone[prop] (x | y | z | rx | ry | rz) from its rest value to `to` */
  deploy(bone, prop, to) {
    const d = this.boneDefs[this.boneIndex(bone)];
    let from;
    if (prop in POSITION_PROPS) from = d.position['xyz'.indexOf(POSITION_PROPS[prop])];
    else if (prop in ROTATION_PROPS) from = d.rotation['xyz'.indexOf(ROTATION_PROPS[prop])];
    else throw new Error(`[UnitBuilder] deploy prop "${prop}"`);
    this.channelDefs.push({ bone, prop, from, to });
  }

  /** Registers what fire(socket) triggers: indices into meta.flashes / recoils / spinners / lenses / arcs */
  onFire(socket, { flashes = [], recoils = [], spinners = [], lenses = [], arcs = [] }) {
    const f = (this.meta.fire[socket] ??= { flashes: [], recoils: [], spinners: [], lenses: [], arcs: [] });
    f.flashes.push(...flashes); f.recoils.push(...recoils); f.spinners.push(...spinners); f.lenses.push(...lenses); f.arcs.push(...arcs);
  }

  build() {
    const defs = this.boneDefs;
    const n = defs.length;
    const levels = BUILDING_LOD.levels;
    // rest matrices (model space) and far group of every bone
    const rest = [];
    const farOf = [];
    for (let i = 0; i < n; i++) {
      const d = defs[i];
      _e.set(d.rotation[0], d.rotation[1], d.rotation[2]);
      _q.setFromEuler(_e);
      _p.fromArray(d.position);
      const m = new THREE.Matrix4().compose(_p, _q, _one);
      if (d.parent >= 0) m.premultiply(rest[d.parent]);
      rest.push(m);
      farOf.push(d.far ? i : farOf[d.parent]);
    }
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    // LOD level of every part by its share of the WHOLE unit (PartBuilder.buildLods alone would measure each bone, so
    // sprockets, wheels, barrels… would survive into the far LODs): parts without an explicit `detail` get one here
    const ext = new THREE.Box3();
    for (const [i, b] of this.paints) for (const p of b.parts) ext.union(tmp.copy(p.geo.boundingBox).applyMatrix4(rest[i]));
    const extSize = ext.getSize(new THREE.Vector3());
    const extent = Math.max(extSize.x, extSize.y, extSize.z);
    for (const b of this.paints.values()) {
      for (const p of b.parts) {
        if (p.detail !== null) continue;
        let level = 0;
        for (let l = 1; l < levels; l++) if (p.size >= extent * UNIT_LOD.partMinShare[l]) level = l;
        p.detail = level;
      }
    }
    const skinParts = [];
    const farParts = new Map();   // far root -> [lod] -> geometries
    for (const [i, b] of this.paints) {
      if (!b.parts.length) continue;
      let maxLevel = 0;
      for (const p of b.parts) maxLevel = Math.max(maxLevel, p.detail);
      const lods = b.buildLods();
      tmp.copy(lods[0].boundingBox).applyMatrix4(rest[i]);
      box.union(tmp);
      skinParts.push(skinTo(lods[0], i));
      const root = farOf[i];
      const rel = new THREE.Matrix4().copy(rest[root]).invert().multiply(rest[i]);
      let slot = farParts.get(root);
      if (!slot) { slot = []; for (let l = 0; l < levels; l++) slot.push([]); farParts.set(root, slot); }
      for (let l = 1; l < levels; l++) {
        // a bone with no part at this level: drop it (buildLods would keep its largest part as a fallback)
        if (l > maxLevel) lods[l].dispose();
        else slot[l].push(lods[l].applyMatrix4(rel));
      }
    }
    const paint = mergeAndFree(skinParts);
    if (!paint) throw new Error('[UnitBuilder] a unit needs painted parts');
    const far = [];
    for (const [root, slot] of farParts) {
      const lods = [null];
      for (let l = 1; l < levels; l++) {
        const g = mergeAndFree(slot[l]);
        g?.computeBoundingSphere();
        lods.push(g);
      }
      far.push({ bone: root, name: defs[root].name, lods });
    }
    const glowParts = [];
    for (const [i, g] of this.glows) {
      const geo = g.build();
      if (geo) glowParts.push(skinTo(geo, i));
    }
    const glow = mergeAndFree(glowParts);
    const emblemParts = [];
    for (const d of this.decals) {
      const geo = emblemDecalGeometry(d.placements);
      if (geo) emblemParts.push(skinTo(geo, this.boneIndex(d.bone)));
    }
    const emblem = mergeAndFree(emblemParts);
    // rest-pose bounds in model space: culling of the skinned meshes (their vertices are bone-local)
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    for (const g of [paint, emblem]) {
      if (!g) continue;
      g.boundingBox = box.clone();
      g.boundingSphere = sphere.clone();
    }
    if (glow) {
      glow.boundingBox = box.clone();   // Box3.setFromObject (owner sizing) sees only the body; culling uses the sphere
      glow.boundingSphere = new THREE.Sphere(sphere.center.clone(), sphere.radius * UNIT_KIT.glow.boundsScale);
    }
    const rootFar = far.find((f) => f.bone === 0);
    const proxy = rootFar ? rootFar.lods[levels - 1] ?? rootFar.lods.find(Boolean) : null;
    const size = box.getSize(new THREE.Vector3());
    return {
      bones: defs.map((d) => ({ name: d.name, parent: d.parent, position: d.position, rotation: d.rotation })),
      paint, glow, emblem, far, proxy,
      sockets: this.socketDefs,
      channels: this.channelDefs,
      meta: this.meta,
      bounds: { box, sphere },
      dims: { length: size.z, width: size.x, height: size.y, minY: box.min.y },
      triangles: triangleCount(paint) + (glow ? triangleCount(glow) : 0) + (emblem ? triangleCount(emblem) : 0),
    };
  }
}

function disposeShared(sh) {
  sh.paint?.dispose();
  sh.glow?.dispose();
  sh.emblem?.dispose();
  for (const f of sh.far) for (const g of f.lods) g?.dispose();
  // sh.proxy is one of the far geometries
}

/**
 * Per (style, variant) cache of one unit type's shared data. build(kit, variant) → UnitBuilder.build(). The data is
 * disposed with the last model of that style + variant. variant = free string (chassis / weapon override, '' default).
 */
export function createUnitCache(build) {
  const entries = new Map();   // "style|variant" -> { users, data }
  return {
    acquire(kit, variant = '') {
      const key = `${kit.key}|${variant}`;
      let e = entries.get(key);
      if (!e) { e = { users: 0, data: build(kit, variant) }; entries.set(key, e); }
      e.users++;
      return e.data;
    },
    release(kit, variant = '') {
      const key = `${kit.key}|${variant}`;
      const e = entries.get(key);
      if (!e || --e.users > 0) return;
      disposeShared(e.data);
      entries.delete(key);
    },
  };
}

// ---------------------------------------------------------------- materials

// Glow: additive, double-sided, vertex colours; aGlowKind 1 = multiplied by the per-unit status colour.
// Regular function (three calls it with `this` = material); one program for all units.
function glowOnBeforeCompile(shader) {
  shader.uniforms.uStatus = this.userData.uStatus;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aGlowKind;\nvarying float vGlowKind;')
    .replace('#include <color_vertex>', '#include <color_vertex>\nvGlowKind = aGlowKind;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uStatus;\nvarying float vGlowKind;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(1.0), uStatus, vGlowKind);');
}
const glowProgramKey = () => 'steelMansUnitGlow';

function createGlowMaterial() {
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: UNIT_KIT.glow.opacity, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  m.userData.uStatus = { value: new THREE.Color(1, 1, 1) };
  m.onBeforeCompile = glowOnBeforeCompile;
  m.customProgramCacheKey = glowProgramKey;
  return m;
}

// Private paint of one unit (cloak / hover highlight): same shader as the shared ProcKit paint material (its
// onBeforeCompile and program key are reused), own team colour uniform, transparency and emissive.
function createPrivatePaint(shared, teamColor) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, bumpMap: shared.bumpMap, bumpScale: shared.bumpScale });
  m.userData.uTeamColor = { value: new THREE.Color(teamColor) };
  m.userData.uDetail = shared.userData.uDetail;
  m.userData.procedural = true;
  m.onBeforeCompile = shared.onBeforeCompile;
  m.customProgramCacheKey = shared.customProgramCacheKey;
  return m;
}

const _highlight = new THREE.Color(HIGHLIGHT.color).multiplyScalar(HIGHLIGHT.intensity);

// Glow halos / decals never cast shadows, even when the owner sets castShadow on every mesh (Vehicle.load does)
const noShadow = (mesh) => Object.defineProperty(mesh, 'castShadow', { get: () => false, set: () => {} });

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const clampAbs = (v, max) => (v > max ? max : v < -max ? -max : v);
const wrap = (a) => (a > TAU || a < -TAU ? a % TAU : a);

let instanceCounter = 0;   // animation phase variety only (visual)

// ---------------------------------------------------------------- ProcUnit

/**
 * Base class of a procedural unit model (THREE.Group, forward = +Z, up = +Y, origin on the ground at the footprint
 * centre). Subclasses only pass their cache (createUnitCache) – the generic drivers animate everything the modules
 * registered in the builder meta. Owner API (all visual):
 *   setMotion(speed, turn)  units/s (signed), yaw rate rad/s (+ = rotation.y grows)
 *   setThrottle(0..1)       engine flames (default: automatic from speed / meta.refSpeed)
 *   setTurretYaw(rad), setBarrelPitch(rad), fire(socket = 'muzzle')
 *   setCloaked(0..1), setDeployed(0..1), setStatus(name), setTeamColor(c), setHighlighted(on)
 *   getSocket(name), getBone(name), tick(dt), enableBatching(), stats(), dispose()
 */
export class ProcUnit extends THREE.Group {
  /**
   * @param {object} o
   * @param {string} o.race                 race / style key (unknown → first style)
   * @param {THREE.ColorRepresentation} [o.teamColor]
   * @param {object} o.cache                createUnitCache(...) of the unit type
   * @param {string} [o.variant]            cache variant ('' = default)
   * @param {string} [o.type]               unit type key (batch groups); default = name
   * @param {string} [o.name]
   */
  constructor({ race, teamColor = UNIT_KIT.defaultTeamColor, cache, variant = '', type, name = 'ProcUnit' }) {
    super();
    this.isProcUnit = true;
    this.kit = styleKit(race);
    this.race = race;
    this.unitStyle = unitStyle(this.kit);
    this.name = `${name}${this.kit.key}`;
    this.unitType = `${type ?? name}|${variant}`;
    this.userData.procedural = true;
    this.cache = cache;
    this.variant = variant;
    this.teamColor = teamColor;
    this.shared = cache.acquire(this.kit, variant);
    this.paint = acquirePaintMaterial(teamColor, this.kit.style.texture);
    this.privatePaint = null;
    this.glowMaterial = null;
    this.emblemMaterial = null;
    this.skeleton = null;
    this.batch = null;
    this.highlighted = false;
    this.phase = (instanceCounter++ * UNIT_KIT.phaseStep) % TAU;
    this.time = 0;
    // driven state
    this.speed = 0; this.turn = 0;
    this.speedSmooth = 0; this.turnSmooth = 0; this.accel = 0;
    this.throttle = 0; this.throttleSet = false;
    this.cloak = 0; this.deployed = 0;
    this.status = 'idle'; this.statusOn = true; this.statusBlink = 0;
    this.turretYaw = 0; this.barrelPitch = 0;
    try {
      this.#assemble();
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  #assemble() {
    const sh = this.shared;
    this.bones = sh.bones.map((d) => {
      const b = new THREE.Bone();
      b.name = d.name;
      b.position.fromArray(d.position);
      b.rotation.set(d.rotation[0], d.rotation[1], d.rotation[2]);
      return b;
    });
    sh.bones.forEach((d, i) => (d.parent < 0 ? this : this.bones[d.parent]).add(this.bones[i]));
    this.boneByName = new Map(this.bones.map((b) => [b.name, b]));
    this.skeleton = new THREE.Skeleton(this.bones, this.bones.map(() => new THREE.Matrix4()));

    this.paintMesh = this.#skinned(sh.paint, this.paint);
    this.paintMesh.castShadow = true;
    this.paintMesh.receiveShadow = true;
    this.glowMaterial = createGlowMaterial();
    this.glowMesh = sh.glow ? this.#skinned(sh.glow, this.glowMaterial) : null;
    if (this.glowMesh) noShadow(this.glowMesh);
    if (sh.emblem) {
      this.emblemMaterial = acquireEmblemMaterial(this.kit, this.teamColor);
      this.emblemMesh = this.#skinned(sh.emblem, this.emblemMaterial);
      noShadow(this.emblemMesh);
      this.emblemMesh.receiveShadow = this.kit.style.emblem.render !== 'neon';
    } else {
      this.emblemMesh = null;
    }
    // picking proxy: coarse body, never drawn (Raycaster ignores `visible`)
    this.proxy = sh.proxy ? new THREE.Mesh(sh.proxy, this.paint) : null;
    if (this.proxy) { this.proxy.visible = false; this.proxy.name = 'pickProxy'; this.add(this.proxy); }

    this.sockets = new Map();
    for (const s of sh.sockets) {
      const o = new THREE.Object3D();
      o.name = s.name;
      o.position.fromArray(s.position);
      o.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
      this.boneByName.get(s.bone).add(o);
      this.sockets.set(s.name, o);
    }
    this.#createDrivers(sh.meta, sh.channels);
    this.setStatus(this.status);
    this.updateMatrixWorld(true);
    this.skeleton.update();
  }

  #skinned(geometry, material) {
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.bind(this.skeleton, IDENTITY);   // vertices are bone-local: bind matrix and bone inverses are identity
    mesh.boundingBox = geometry.boundingBox.clone();
    mesh.boundingSphere = geometry.boundingSphere.clone();
    mesh.raycast = noRaycast;             // picking goes through the proxy
    this.add(mesh);
    return mesh;
  }

  #createDrivers(m, channels) {
    const bone = (name) => {
      const b = this.boneByName.get(name);
      if (!b) throw new Error(`[ProcUnit] meta names unknown bone "${name}"`);
      return b;
    };
    const hidden = UNIT_KIT.hiddenScale;
    this.tracks = m.tracks.map((t) => {
      const top = bone(t.top);
      const bottom = bone(t.bottom);
      return {
        side: t.side, halfGauge: t.halfGauge, pitch: t.pitch, radius: t.radius, travel: 0,
        top, bottom, topZ: top.position.z, bottomZ: bottom.position.z, sprockets: t.sprockets.map(bone),
      };
    });
    this.wheels = m.wheels.map((w) => ({
      spin: bone(w.spin), steer: w.steer ? bone(w.steer) : null, radius: w.radius, side: w.side, halfGauge: w.halfGauge,
      steerSign: w.steerSign ?? 1,
    }));
    this.hull = m.hull ? { ...m.hull, bone: bone(m.hull.bone), y: bone(m.hull.bone).position.y } : null;
    this.hoverGlow = m.hoverGlow ? bone(m.hoverGlow) : null;
    this.exhausts = m.exhausts.map((e, i) => ({ bone: bone(e.bone), idle: e.idle, flicker: e.flicker, seed: i * UNIT_KIT.phaseStep }));
    this.flashes = m.flashes.map((f) => {
      const b = bone(f.bone);
      b.scale.setScalar(hidden);
      return { bone: b, timer: 0, time: f.time ?? UNIT_KIT.flash.time };
    });
    this.recoils = m.recoils.map((r) => ({ bone: bone(r.bone), restZ: bone(r.bone).position.z, dist: r.dist, timer: 0 }));
    this.spinners = m.spinners.map((s) => ({ bone: bone(s.bone), axis: s.axis, speed: s.speed, current: 0, linger: 0 }));
    this.lenses = m.lenses.map((l) => ({ bone: bone(l.bone), boost: 0 }));
    this.arcs = m.arcs.map((a, i) => ({ bone: bone(a.bone), timer: 0, seed: i + 1 }));
    for (const a of this.arcs) a.bone.scale.setScalar(hidden);
    this.statusBone = m.status ? bone(m.status) : null;
    this.turretBone = m.turret ? bone(m.turret) : null;
    this.barrelBone = m.barrel ? bone(m.barrel) : null;
    this.pitchLimits = m.pitch;
    this.refSpeed = m.refSpeed;
    this.channels = channels.map((c) => ({ bone: bone(c.bone), prop: c.prop, from: c.from, to: c.to }));
    this.fireMap = new Map(Object.entries(m.fire));
    this.defaultFire = this.fireMap.get('muzzle') ?? this.fireMap.values().next().value ?? null;
  }

  // ---------- owner API ----------

  /** Named socket (THREE.Object3D) or null – e.g. 'muzzle', 'launch_1', 'exhaust_1', 'turret', 'aim', 'cargo', 'smoke' */
  getSocket(name) { return this.sockets?.get(name) ?? null; }

  /** Socket names of this model (convention: docs/notes/proc-unit-kit.md) */
  get socketNames() { return [...(this.sockets?.keys() ?? [])]; }

  /** Bone by name (e.g. 'turret' – its rotation.y is the turret yaw, as CombatVehicle.turret expects) */
  getBone(name) { return this.boneByName?.get(name) ?? null; }

  /** Rest-pose size in model units { length (Z), width (X), height (Y), minY } */
  get dims() { return this.shared?.dims ?? null; }

  /** Motion of the owner: speed units/s (negative = reverse), turn = yaw rate rad/s (+ = rotation.y increases) */
  setMotion(speed, turn = 0) { this.speed = speed; this.turn = turn; }

  /** Engine throttle 0..1 (flame length); once called, the automatic throttle from speed is off */
  setThrottle(t) { this.throttle = clamp01(t); this.throttleSet = true; }

  /** Turret yaw relative to the hull (rad, same convention as rotation.y) */
  setTurretYaw(yaw) {
    this.turretYaw = yaw;
    if (this.turretBone) this.turretBone.rotation.y = yaw;
  }

  /** Barrel elevation (rad, + = up), clamped to the model's limits */
  setBarrelPitch(pitch) {
    const [lo, hi] = this.pitchLimits ?? [0, 0];
    this.barrelPitch = pitch < lo ? lo : pitch > hi ? hi : pitch;
    if (this.barrelBone) this.barrelBone.rotation.x = -this.barrelPitch;
  }

  /** A shot leaves `socket`: muzzle flash, recoil, gatling spin, lens flare, arcs (whatever the weapon registered) */
  fire(socket = 'muzzle') {
    const f = this.fireMap?.get(socket) ?? this.defaultFire;
    if (!f) return;
    // index loops: fire() runs from the game loop, no iterators
    for (let k = 0; k < f.flashes.length; k++) this.flashes[f.flashes[k]].timer = this.flashes[f.flashes[k]].time;
    for (let k = 0; k < f.recoils.length; k++) this.recoils[f.recoils[k]].timer = UNIT_KIT.recoil.time;
    for (let k = 0; k < f.spinners.length; k++) this.spinners[f.spinners[k]].linger = UNIT_KIT.spin.linger;
    for (let k = 0; k < f.lenses.length; k++) this.lenses[f.lenses[k]].boost = UNIT_KIT.lens.boostTime;
    for (let k = 0; k < f.arcs.length; k++) this.arcs[f.arcs[k]].timer = UNIT_KIT.arc.fireTime;
  }

  /** Deploy progress 0..1 (artillery anchoring): moves every deploy channel (eased) */
  setDeployed(v) {
    this.deployed = clamp01(v);
    const e = smootherstep(this.deployed);
    const ch = this.channels;
    if (!ch) return;
    for (let i = 0; i < ch.length; i++) {   // called every tick: index loop, no iterator
      const c = ch[i];
      const value = c.from + (c.to - c.from) * e;
      switch (c.prop) {
        case 'x': c.bone.position.x = value; break;
        case 'y': c.bone.position.y = value; break;
        case 'z': c.bone.position.z = value; break;
        case 'rx': c.bone.rotation.x = value; break;
        case 'ry': c.bone.rotation.y = value; break;
        default: c.bone.rotation.z = value;
      }
    }
  }

  /** Cloak 0..1: the hull fades to style.unit.cloak.minOpacity, glow and emblem fade out, no shadow when cloaked */
  setCloaked(v) {
    const c = clamp01(v);
    if (c === this.cloak) return;
    this.cloak = c;
    this.#refreshPaint();
    this.glowMaterial.opacity = UNIT_KIT.glow.opacity * (1 - c);
    this.paintMesh.castShadow = c < UNIT_KIT.cloak.shadowCutoff;
    this.applyBatchLod(this.batch?.registered ? this.batch.lod : 0);
  }

  /** State marker lamp: 'idle' | 'move' | 'attack' | 'deployed' | 'cloaked' | 'disabled' | 'none' (UNIT_KIT.status) */
  setStatus(name) {
    const color = STATUS_COLORS[name];
    this.status = name;
    this.statusOn = Boolean(color);
    this.statusBlink = UNIT_KIT.status.blink[name] ?? 0;
    if (color) this.glowMaterial.userData.uStatus.value.copy(color);
  }

  /** Team colour: shared paint per colour + texture, emblem material per style + colour, instance attribute */
  setTeamColor(color) {
    this.teamColor = color;
    const next = acquirePaintMaterial(color, this.kit.style.texture);
    const prev = this.paint;
    this.paint = next;
    if (this.proxy) this.proxy.material = next;
    releasePaintMaterial(prev);
    if (this.privatePaint) this.privatePaint.userData.uTeamColor.value.set(color);
    this.#refreshPaint();
    if (this.batch) { this.batch.team.set(color); this.batch.batcher?.refreshInst(this); }
    if (!this.emblemMaterial) return;
    const nextEmblem = acquireEmblemMaterial(this.kit, color);
    releaseEmblemMaterial(this.emblemMaterial);
    this.emblemMaterial = nextEmblem;
    this.emblemMesh.material = nextEmblem;
  }

  /** Hover highlight (own meshes: private paint emissive; far instances: aInst.w) */
  setHighlighted(on) {
    if (this.highlighted === on) return;
    this.highlighted = on;
    this.#refreshPaint();
    if (this.batch) { this.batch.highlight = on ? 1 : 0; this.batch.batcher?.refreshInst(this); }
  }

  #refreshPaint() {
    if (!this.paintMesh) return;
    if (this.cloak <= 0 && !this.highlighted) { this.paintMesh.material = this.paint; return; }
    const m = (this.privatePaint ??= createPrivatePaint(this.paint, this.teamColor));
    const transparent = this.cloak > 0;
    if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
    m.opacity = 1 - (1 - this.unitStyle.cloakMin) * this.cloak;
    m.depthWrite = this.cloak < UNIT_KIT.cloak.depthCutoff;
    if (this.highlighted) m.emissive.copy(_highlight);
    else m.emissive.copy(this.unitStyle.cloakTint).multiplyScalar(UNIT_KIT.cloak.tint * this.cloak);
    this.paintMesh.material = m;
  }

  /** Per-model extra animation – override if needed (no allocations); called after the generic drivers */
  update() {}

  // ---------- per tick ----------

  /**
   * Called by the owner once per (simulation or render) step with the step length in seconds. Registers with the unit
   * batcher when enabled, follows fog-of-war visibility and animates – only while visible and at LOD0.
   */
  tick(dt) {
    if (!this.shared) return;
    const b = this.batch;
    const visible = this.#chainVisible();
    if (b) {
      if (!b.registered) this.#registerBatch(visible);
      else if (visible !== b.visible) b.batcher.setVisible(this, visible);
    }
    if (!visible) return;
    this.time += dt;
    if (b?.registered && b.lod > 0) { this.#decay(dt); return; }
    this.#animate(dt);
    this.update(dt);
  }

  #chainVisible() {
    for (let o = this; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  // Far LOD: only the event timers run down (nothing is drawn per part)
  #decay(dt) {
    for (let i = 0; i < this.flashes.length; i++) this.flashes[i].timer = Math.max(0, this.flashes[i].timer - dt);
    for (let i = 0; i < this.recoils.length; i++) this.recoils[i].timer = Math.max(0, this.recoils[i].timer - dt);
    for (let i = 0; i < this.arcs.length; i++) this.arcs[i].timer = Math.max(0, this.arcs[i].timer - dt);
  }

  #animate(dt) {
    const K = UNIT_KIT.motion;
    const a = Math.min(1, dt * K.ease);
    const prevSpeed = this.speedSmooth;
    this.speedSmooth += (this.speed - this.speedSmooth) * a;
    this.turnSmooth += (this.turn - this.turnSmooth) * a;
    if (dt > 0) this.accel += ((this.speedSmooth - prevSpeed) / dt - this.accel) * a;
    const v0 = this.speedSmooth;
    const w = this.turnSmooth;
    const t = this.time;
    const hidden = UNIT_KIT.hiddenScale;

    for (let i = 0; i < this.tracks.length; i++) {
      const tr = this.tracks[i];
      const v = v0 - w * tr.halfGauge * tr.side;   // side +1 = left (+X): slower in a left turn
      tr.travel = (tr.travel + v * dt) % tr.pitch;
      const off = tr.travel < 0 ? tr.travel + tr.pitch : tr.travel;
      tr.top.position.z = tr.topZ + off;          // upper run moves forward, lower run backward (ground contact)
      tr.bottom.position.z = tr.bottomZ - off;
      const spin = (v / tr.radius) * dt;
      for (let k = 0; k < tr.sprockets.length; k++) tr.sprockets[k].rotation.x = wrap(tr.sprockets[k].rotation.x + spin);
    }
    for (let i = 0; i < this.wheels.length; i++) {
      const wh = this.wheels[i];
      const v = v0 - w * wh.halfGauge * wh.side;
      wh.spin.rotation.x = wrap(wh.spin.rotation.x + (v / wh.radius) * dt);
      if (wh.steer) wh.steer.rotation.y = clampAbs(w * K.steerGain, K.maxSteer) * wh.steerSign;
    }
    const h = this.hull;
    if (h) {
      h.bone.rotation.x = clampAbs(-this.accel * K.pitchGain, K.maxPitch);
      h.bone.rotation.z = h.bank ? clampAbs(-w * K.bankGain, K.maxBank) : clampAbs(w * v0 * K.rollGain, K.maxRoll);
      if (h.bobAmp) {
        h.bone.position.y = h.y + h.bobAmp * this.kit.style.anim.levitate * Math.sin(TAU * h.bobFreq * t + this.phase);
      }
    }
    if (this.hoverGlow) {
      const p = 1 - UNIT_KIT.lens.depth * (0.5 + 0.5 * Math.sin(TAU * this.kit.style.anim.pulse * t + this.phase));
      this.hoverGlow.scale.set(1, p, 1);
    }
    const throttle = this.throttleSet ? this.throttle : Math.min(1, Math.abs(v0) / this.refSpeed);
    const E = UNIT_KIT.exhaust;
    for (let i = 0; i < this.exhausts.length; i++) {
      const ex = this.exhausts[i];
      const s = ex.idle + (1 - ex.idle) * throttle;
      const fl = 1 + ex.flicker * (0.6 * Math.sin(E.flickerRate * t + ex.seed + this.phase)
        + 0.4 * Math.sin(E.flickerRate * E.flickerHarmonic * t + ex.seed * 2));
      ex.bone.scale.set(1, 1, Math.max(hidden, s * fl));
    }
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      f.timer = Math.max(0, f.timer - dt);
      f.bone.scale.setScalar(f.timer > 0 ? f.timer / f.time : hidden);
    }
    const R = UNIT_KIT.recoil;
    for (let i = 0; i < this.recoils.length; i++) {
      const r = this.recoils[i];
      r.timer = Math.max(0, r.timer - dt);
      const k = 1 - r.timer / R.time;   // 0 at the shot … 1 back home
      const e = r.timer <= 0 ? 0 : k < R.kick ? k / R.kick : 1 - smootherstep((k - R.kick) / (1 - R.kick));
      r.bone.position.z = r.restZ - r.dist * e;
    }
    for (let i = 0; i < this.spinners.length; i++) {
      const s = this.spinners[i];
      s.linger = Math.max(0, s.linger - dt);
      s.current += ((s.linger > 0 ? s.speed : 0) - s.current) * Math.min(1, dt * UNIT_KIT.spin.ease);
      s.bone.rotation[s.axis] = wrap(s.bone.rotation[s.axis] + s.current * dt);
    }
    const L = UNIT_KIT.lens;
    const pulse = L.idle + L.depth * Math.sin(TAU * this.kit.style.anim.pulse * t + this.phase);
    for (let i = 0; i < this.lenses.length; i++) {
      const l = this.lenses[i];
      l.boost = Math.max(0, l.boost - dt);
      l.bone.scale.setScalar(pulse + (L.boost - pulse) * (l.boost / L.boostTime));
    }
    const A = UNIT_KIT.arc;
    const step = Math.floor(t * A.rate);
    for (let i = 0; i < this.arcs.length; i++) {
      const arc = this.arcs[i];
      arc.timer = Math.max(0, arc.timer - dt);
      const n = Math.sin((step + arc.seed * 7.31) * 12.9898 + this.phase) * 43758.5453;
      const chance = arc.timer > 0 ? A.fireChance : A.idleChance;
      arc.bone.scale.setScalar(n - Math.floor(n) < chance ? 1 : hidden);
    }
    if (this.statusBone) {
      const on = this.statusOn && (this.statusBlink <= 0 || (t + this.phase) % this.statusBlink < this.statusBlink / 2);
      this.statusBone.scale.setScalar(on ? 1 : hidden);
    }
  }

  // ---------- far LOD batching (UnitBatcher) ----------

  /** From now on tick() may hand the unit to the scene's UnitBatcher for far LODs (needs the model inside a scene) */
  enableBatching() {
    const on = UNIT_LOD.enabled && globalThis.window?.steelMans?.unitBatching !== false;
    if (this.batch || !on || !this.shared?.far.length) return;
    this.batch = {
      registered: false, batcher: null, items: null, lod: -1, visible: true, dist2: 0, rank: 0,
      team: new THREE.Color(this.teamColor), highlight: this.highlighted ? 1 : 0,
    };
  }

  /** True while the unit is registered with the batcher */
  get batched() { return !!this.batch?.registered; }

  #registerBatch(visible) {
    let root = this;
    while (root.parent) root = root.parent;
    if (!root.isScene) return;
    const b = this.batch;
    const texture = this.kit.style.texture;
    b.items = this.shared.far.map((f) => ({
      source: this.bones[f.bone], geos: f.lods, key: `${this.unitType}|${this.kit.key}|${f.name}`, texture,
      group: null, slot: -1, keys: [],
    }));
    b.visible = visible;
    b.batcher = unitBatcherFor(root);
    b.registered = true;
    b.batcher.register(this);
  }

  /** Called by the batcher on a LOD change: own meshes only at LOD0 */
  applyBatchLod(lod) {
    if (!this.paintMesh) return;
    const near = lod <= 0;
    this.paintMesh.visible = near;
    if (this.glowMesh) this.glowMesh.visible = near && this.cloak < 1;
    if (this.emblemMesh) this.emblemMesh.visible = near && this.cloak < UNIT_KIT.cloak.emblemCutoff;
  }

  /** { triangles, drawCalls, visibleDrawCalls } of the own meshes (main pass; the proxy is not drawn) */
  stats() {
    let triangles = 0;
    let drawCalls = 0;
    let visibleDrawCalls = 0;
    for (const mesh of [this.paintMesh, this.glowMesh, this.emblemMesh]) {
      if (!mesh) continue;
      triangles += triangleCount(mesh.geometry);
      drawCalls++;
      if (mesh.visible) visibleDrawCalls++;
    }
    return { triangles, drawCalls, visibleDrawCalls, bones: this.bones?.length ?? 0 };
  }

  /** Removes the unit and releases everything it holds (shared data is ref-counted) */
  dispose() {
    if (!this.shared) return;
    this.batch?.batcher?.unregister(this);
    this.batch = null;
    this.removeFromParent();
    this.skeleton?.dispose();
    this.glowMaterial?.dispose();
    this.privatePaint?.dispose();
    releasePaintMaterial(this.paint);
    if (this.emblemMaterial) releaseEmblemMaterial(this.emblemMaterial);
    this.clear();
    this.cache.release(this.kit, this.variant);
    this.shared = null;
    this.sockets?.clear();
    this.boneByName?.clear();
    this.paintMesh = this.glowMesh = this.emblemMesh = this.proxy = null;
    this.privatePaint = this.glowMaterial = this.emblemMaterial = this.skeleton = null;
  }
}

// ---------------------------------------------------------------- unit batcher (far LOD instancing)

const MATRIX_FLOATS = 16;
const INST_FLOATS = 4;
const GROWTH = 2;
const _cam = new THREE.Vector3();
const byDist2 = (a, b) => a.dist2 - b.dist2;   // shared comparator (no closure per decision)

/** One InstancedMesh of a far group geometry (all instances share geometry and the instanced paint material) */
class UnitGroup {
  constructor(batcher, key, source, texture) {
    this.batcher = batcher;
    this.key = key;
    this.source = source;
    this.texture = texture;
    this.material = acquireInstancedPaintMaterial(texture);
    this.items = [];
    this.capacity = 0;
    this.mesh = null;
    this.dirty = false;
    this.emptyFrame = batcher.frame;
    this.#alloc(UNIT_LOD.initialCapacity);
  }

  #alloc(capacity) {
    const old = this.mesh;
    const geometry = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(this.source.attributes)) geometry.setAttribute(name, attr);
    if (this.source.index) geometry.setIndex(this.source.index);
    geometry.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(capacity * INST_FLOATS), INST_FLOATS).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `UnitBatch:${this.key}`;
    mesh.frustumCulled = false;
    mesh.raycast = noRaycast;
    mesh.castShadow = this.batcher.shadows;
    mesh.receiveShadow = true;
    mesh.count = this.items.length;
    mesh.visible = mesh.count > 0;
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.items.length * MATRIX_FLOATS));
      geometry.attributes.aInst.array.set(old.geometry.attributes.aInst.array.subarray(0, this.items.length * INST_FLOATS));
      this.batcher.scene.remove(old);
      old.dispose();
      this.#freeGeometry(old.geometry);
    }
    this.batcher.scene.add(mesh);
    this.mesh = mesh;
    this.capacity = capacity;
  }

  add(item, unit) {
    if (this.items.length === this.capacity) this.#alloc(this.capacity * GROWTH);
    const i = this.items.length;
    this.items.push(item);
    item.group = this;
    item.slot = i;
    this.writeMatrix(item);
    this.writeInst(item, unit);
    this.mesh.count = i + 1;
    this.mesh.visible = true;
  }

  remove(item) {
    const last = this.items.length - 1;
    const i = item.slot;
    if (i !== last) {
      this.mesh.instanceMatrix.array.copyWithin(i * MATRIX_FLOATS, last * MATRIX_FLOATS, (last + 1) * MATRIX_FLOATS);
      const inst = this.mesh.geometry.attributes.aInst;
      inst.array.copyWithin(i * INST_FLOATS, last * INST_FLOATS, (last + 1) * INST_FLOATS);
      inst.needsUpdate = true;
      const moved = this.items[last];
      this.items[i] = moved;
      moved.slot = i;
      this.dirty = true;
    }
    this.items.pop();
    item.group = null;
    item.slot = -1;
    this.mesh.count = last;
    this.mesh.visible = last > 0;
    if (last === 0) this.emptyFrame = this.batcher.frame;
  }

  writeMatrix(item) {
    const src = item.source.matrixWorld.elements;
    const dst = this.mesh.instanceMatrix.array;
    const o = item.slot * MATRIX_FLOATS;
    for (let k = 0; k < MATRIX_FLOATS; k++) dst[o + k] = src[k];
    this.dirty = true;
  }

  writeInst(item, unit) {
    const attr = this.mesh.geometry.attributes.aInst;
    const o = item.slot * INST_FLOATS;
    const b = unit.batch;
    attr.array[o] = b.team.r;
    attr.array[o + 1] = b.team.g;
    attr.array[o + 2] = b.team.b;
    attr.array[o + 3] = b.highlight;
    attr.needsUpdate = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  #freeGeometry(geometry) {
    for (const name of Object.keys(this.source.attributes)) geometry.deleteAttribute(name);
    geometry.setIndex(null);
    geometry.dispose();
  }

  dispose() {
    this.batcher.scene.remove(this.mesh);
    this.mesh.dispose();
    this.#freeGeometry(this.mesh.geometry);
    releaseInstancedPaintMaterial(this.material);
    this.mesh = null;
    this.items.length = 0;
  }
}

/** Unit batcher of one scene (unitBatcherFor). Runs in scene.onBeforeRender (render side only). */
class UnitBatcher {
  constructor(scene) {
    this.scene = scene;
    this.models = [];
    this.groups = new Map();      // key -> UnitGroup
    this.groupList = [];          // same groups, for allocation-free per-frame loops
    this.frame = 0;
    this.dirty = true;
    this.force = true;
    this.shadows = getBuildingQuality().shadows;
    this.candidates = [];
    this.lastSweep = 0;
    this.disposed = false;
    // one persistent hook per scene (sceneHooks): a disposed batcher leaves a pass-through that the next batcher of the
    // scene reuses, so the onBeforeRender chain never grows when batchers come and go
    let entry = sceneHooks.get(scene);
    if (!entry) {
      entry = { batcher: null, prev: scene.onBeforeRender, hook: null };
      entry.hook = (renderer, sc, camera, target) => {
        entry.prev.call(sc, renderer, sc, camera, target);
        if (entry.batcher && !entry.batcher.disposed) entry.batcher.renderFrame(camera);
      };
      scene.onBeforeRender = entry.hook;
      sceneHooks.set(scene, entry);
    }
    entry.batcher = this;
    this.hookEntry = entry;
    this.unsubscribe = onBuildingQualityChange(() => { this.dirty = true; this.force = true; });
  }

  register(unit) {
    this.models.push(unit);
    unit.batch.lod = -1;
    this.dirty = true;
  }

  unregister(unit) {
    this.#removeItems(unit);
    const i = this.models.indexOf(unit);
    if (i >= 0) { this.models[i] = this.models[this.models.length - 1]; this.models.pop(); }
    unit.batch.registered = false;
    unit.applyBatchLod(0);
    if (!this.models.length) this.dispose();
  }

  setVisible(unit, visible) {
    const b = unit.batch;
    b.visible = visible;
    if (!visible) this.#removeItems(unit);
    else if (b.lod > 0) this.#placeItems(unit);
  }

  refreshInst(unit) {
    const items = unit.batch.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) if (items[i].group) items[i].group.writeInst(items[i], unit);
  }

  #removeItems(unit) {
    const items = unit.batch.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) items[i].group?.remove(items[i]);
  }

  #group(item, geometry, lod) {
    const key = (item.keys[lod] ??= `${item.key}|${geometry.uuid}`);
    let g = this.groups.get(key);
    if (!g) {
      g = new UnitGroup(this, key, geometry, item.texture);
      this.groups.set(key, g);
      this.groupList.push(g);
    }
    return g;
  }

  #placeItems(unit) {
    const b = unit.batch;
    for (let i = 0; i < b.items.length; i++) {
      const item = b.items[i];
      const geometry = item.geos[Math.min(b.lod, item.geos.length - 1)];
      if (geometry) this.#group(item, geometry, b.lod).add(item, unit);
    }
  }

  #setLod(unit, lod) {
    const b = unit.batch;
    b.lod = lod;
    this.#removeItems(unit);
    if (lod > 0 && b.visible) this.#placeItems(unit);
    unit.applyBatchLod(lod);
  }

  /** Per rendered frame, from the scene hook (render side only) */
  renderFrame(camera) {
    this.frame++;
    if (this.dirty || this.frame % UNIT_LOD.updateFrames === 0) {
      this.dirty = false;
      camera.getWorldPosition(_cam);
      this.#decide();
    }
    // far units move: copy their bones' world matrices (updated by the renderer before onBeforeRender)
    const models = this.models;
    for (let i = 0; i < models.length; i++) {
      const b = models[i].batch;
      if (b.lod <= 0 || !b.visible) continue;
      for (let k = 0; k < b.items.length; k++) if (b.items[k].group) b.items[k].group.writeMatrix(b.items[k]);
    }
    for (let i = 0; i < this.groupList.length; i++) this.groupList[i].flush();
  }

  #decide() {
    const qa = getBuildingQuality();
    const q = UNIT_LOD.quality[qa.level] ?? UNIT_LOD.quality.high;
    const force = this.force;
    this.force = false;
    if (qa.shadows !== this.shadows) {
      this.shadows = qa.shadows;
      for (let i = 0; i < this.groupList.length; i++) this.groupList[i].mesh.castShadow = qa.shadows;
    }
    const models = this.models;
    const n = models.length;
    const hyst = 1 + UNIT_LOD.hysteresis;
    const limit2 = q.full * hyst * (q.full * hyst);
    const cand = this.candidates;
    cand.length = 0;
    for (let i = 0; i < n; i++) {
      const u = models[i];
      const b = u.batch;
      const e = u.matrixWorld.elements;
      const dx = e[12] - _cam.x;
      const dy = e[13] - _cam.y;
      const dz = e[14] - _cam.z;
      b.dist2 = dx * dx + dy * dy + dz * dz;
      b.rank = n;
      if (b.visible && b.dist2 <= limit2) { b.rank = 0; cand.push(b); }
    }
    if (cand.length > UNIT_LOD.maxFull) {   // rank only when there are more candidates than LOD0 slots
      cand.sort(byDist2);   // stable: equal distances keep the model order
      for (let i = 0; i < cand.length; i++) cand[i].rank = i;
    }
    for (let i = 0; i < n; i++) {
      const u = models[i];
      const b = u.batch;
      if (!b.visible && b.lod >= 0 && !force) continue;
      const d = Math.sqrt(b.dist2);
      const cur = b.lod;
      let lod;
      if (u.cloak > 0) lod = 0;   // transparent: never instanced
      else if (d < q.full * (cur === 0 ? hyst : 1) && b.rank < UNIT_LOD.maxFull + (cur === 0 ? UNIT_LOD.fullRankSlack : 0)) lod = 0;
      else lod = d < q.mid * (cur <= 1 ? hyst : 1) ? 1 : 2;
      if (force || lod !== cur) this.#setLod(u, lod);
    }
    if (this.frame - this.lastSweep >= UNIT_LOD.idleFrames) this.#sweep();
  }

  #sweep() {
    this.lastSweep = this.frame;
    for (let i = this.groupList.length - 1; i >= 0; i--) {
      const g = this.groupList[i];
      if (g.items.length || this.frame - g.emptyFrame <= UNIT_LOD.idleFrames) continue;
      g.dispose();
      this.groups.delete(g.key);
      this.groupList.splice(i, 1);
    }
  }

  stats() {
    let instances = 0;
    let drawCalls = 0;
    for (const g of this.groupList) { instances += g.items.length; if (g.items.length) drawCalls++; }
    const lods = [0, 0, 0];
    for (const u of this.models) if (u.batch.visible && u.batch.lod >= 0) lods[u.batch.lod]++;
    return { models: this.models.length, groups: this.groupList.length, instances, drawCalls, lods };
  }

  dispose() {
    this.disposed = true;
    const entry = this.hookEntry;
    if (entry.batcher === this) entry.batcher = null;
    if (this.scene.onBeforeRender === entry.hook) {   // still the last link: unhook completely
      this.scene.onBeforeRender = entry.prev;
      sceneHooks.delete(this.scene);
    }                                                 // else: stays as a pass-through, reused by the next batcher
    this.unsubscribe();
    for (const g of this.groupList) g.dispose();
    this.groups.clear();
    this.groupList.length = 0;
    for (const u of this.models) if (u.batch) { u.batch.registered = false; u.batch.batcher = null; u.applyBatchLod(0); }
    this.models.length = 0;
    batchers.delete(this.scene);
  }
}

const batchers = new WeakMap();   // scene -> UnitBatcher
const sceneHooks = new WeakMap(); // scene -> { batcher, prev, hook } (persistent onBeforeRender link, see UnitBatcher)

/** The unit batcher of a scene (created on first use, released with its last unit) */
export function unitBatcherFor(scene) {
  let b = batchers.get(scene);
  if (!b) { b = new UnitBatcher(scene); batchers.set(scene, b); }
  return b;
}

/** Console: `(await import('./src/procedural/units/UnitKit.js')).unitBatchStats(steelMans.scene)` */
export const unitBatchStats = (scene) => batchers.get(scene)?.stats() ?? null;

// ---------------------------------------------------------------- registry

const factories = new Map();   // unit id (stats.json vehicles key or model name) -> (race, teamColor, opts) => ProcUnit

/** Registers a procedural unit model (called by each <Name>Unit.js at module load) */
export function registerProcUnit(id, factory) { factories.set(id, factory); }

export const hasProceduralUnit = (id) => factories.has(id);
export const proceduralUnitIds = () => [...factories.keys()];

/** New procedural unit model or null (needs loadBuildingStyles() done and the model module imported) */
export function createProceduralUnit(id, race, teamColor, opts = {}) {
  const f = factories.get(id);
  return f ? f(race, teamColor, opts) : null;
}
