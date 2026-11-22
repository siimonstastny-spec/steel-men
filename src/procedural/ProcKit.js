// Steel Mans – procedural model kit (prototype N3). Shared helpers for buildings generated in code:
//   • one "paint" shader for every static and animated part: vertex colour + per-vertex surface attribute
//     aSurface = (teamMask, metalness, roughness, emissive) → a whole building is a few draw calls
//   • shared greyscale panel texture (seams, rivets, grime) used as bump map and diffuse detail
//   • geometry builders (box, tapered box, cylinder, cone, hazard strip, pipe run) and a PartBuilder that merges
//     them into one BufferGeometry with box-projected world-scale UVs
//   • ref-counted caches: paint material per team colour, glow material per colour
// Team colour: the material has no `map`, so core/TeamColor.applyTeamColor leaves it alone; the team colour is
// the uniform uTeamColor (setTeamColor on the model). Visual only – nothing here is read by the simulation.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Kit tuning (visual only) */
export const PROC_KIT = {
  textureSize: 256,        // px – panel texture (square, tiles)
  textureWorldSize: 6,     // model units covered by one texture tile
  panelsPerTile: 3,        // panel grid per tile
  seamWidth: 2,            // px
  rivetRadius: 1.4,        // px
  grimeSpots: 220,
  streaks: 40,
  baseGrey: 0.86,          // texture base brightness (diffuse multiplier)
  detailStrength: 0.85,    // 0 = texture ignored in diffuse, 1 = full multiply
  bumpScale: 1.2,
  textureSeed: 1337,
  glowOpacity: 0.95,
};

// ---------------------------------------------------------------- deterministic rng (visual layout only)

/** Small seeded PRNG (mulberry32) – returns () => [0, 1) */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- panel texture

let panelTexture = null;
let panelTextureUsers = 0;

function createPanelTexture() {
  const k = PROC_KIT;
  const size = k.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = makeRng(k.textureSeed);
  const grey = (v) => {
    const c = Math.round(Math.max(0, Math.min(1, v)) * 255);
    return `rgb(${c},${c},${c})`;
  };
  ctx.fillStyle = grey(k.baseGrey);
  ctx.fillRect(0, 0, size, size);
  const cell = size / k.panelsPerTile;
  // panels: slight brightness variation per plate
  for (let i = 0; i < k.panelsPerTile; i++) {
    for (let j = 0; j < k.panelsPerTile; j++) {
      ctx.fillStyle = grey(k.baseGrey + (rng() - 0.5) * 0.08);
      ctx.fillRect(i * cell, j * cell, cell, cell);
      // a split plate now and then
      if (rng() < 0.4) {
        ctx.fillStyle = grey(0.45);
        ctx.fillRect(i * cell, j * cell + cell / 2 - k.seamWidth / 2, cell, k.seamWidth / 2);
      }
    }
  }
  // grime spots (soft, darker)
  for (let n = 0; n < k.grimeSpots; n++) {
    const r = 2 + rng() * 10;
    const x = rng() * size;
    const y = rng() * size;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${0.05 + rng() * 0.08})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // rain streaks below the seams
  for (let n = 0; n < k.streaks; n++) {
    const x = rng() * size;
    const y = Math.floor(rng() * k.panelsPerTile) * cell;
    const len = cell * (0.3 + rng() * 0.6);
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, 'rgba(0,0,0,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 1 + rng() * 2, len);
  }
  // seams (dark recessed lines) + rivets along them
  ctx.fillStyle = grey(0.28);
  for (let i = 0; i <= k.panelsPerTile; i++) {
    const p = Math.round(i * cell);
    ctx.fillRect(p - k.seamWidth / 2, 0, k.seamWidth, size);
    ctx.fillRect(0, p - k.seamWidth / 2, size, k.seamWidth);
  }
  const rivetStep = cell / 6;
  for (let i = 0; i <= k.panelsPerTile; i++) {
    for (let s = rivetStep / 2; s < size; s += rivetStep) {
      for (const [x, y] of [[i * cell + 4, s], [s, i * cell + 4]]) {
        ctx.fillStyle = grey(1);
        ctx.beginPath(); ctx.arc(x, y, k.rivetRadius, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = grey(0.4);
        ctx.beginPath(); ctx.arc(x + 0.6, y + 0.6, k.rivetRadius * 0.6, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;   // data: bump heights and a linear diffuse factor
  tex.anisotropy = 4;
  return tex;
}

function acquirePanelTexture() {
  if (!panelTexture) panelTexture = createPanelTexture();
  panelTextureUsers++;
  return panelTexture;
}

function releasePanelTexture() {
  if (--panelTextureUsers > 0 || !panelTexture) return;
  panelTexture.dispose();
  panelTexture = null;
  panelTextureUsers = 0;
}

// ---------------------------------------------------------------- paint material (one shader for all parts)

// Regular function: three.js calls it as material.onBeforeCompile(shader) → `this` = material. One function for
// all team clones = one shader program; each clone keeps its own uTeamColor uniform.
function paintOnBeforeCompile(shader) {
  shader.uniforms.uTeamColor = this.userData.uTeamColor;
  shader.uniforms.uDetail = this.userData.uDetail;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aSurface;\nvarying vec4 vSurface;')
    .replace('#include <color_vertex>', '#include <color_vertex>\nvSurface = aSurface;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uTeamColor;\nuniform float uDetail;\nvarying vec4 vSurface;')
    .replace('#include <color_fragment>', [
      '#include <color_fragment>',
      'diffuseColor.rgb *= mix(1.0, texture2D(bumpMap, vBumpMapUv).r, uDetail);',
      'diffuseColor.rgb *= mix(vec3(1.0), uTeamColor, vSurface.x);',
    ].join('\n'))
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.z;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor * vSurface.w;');
}

const paintCache = new Map();   // hex -> { material, users }

/** Shared paint material for a team colour (ref-counted – pair with releasePaintMaterial) */
export function acquirePaintMaterial(color) {
  const hex = new THREE.Color(color).getHexString();
  let entry = paintCache.get(hex);
  if (!entry) {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      bumpMap: acquirePanelTexture(),
      bumpScale: PROC_KIT.bumpScale,
    });
    material.userData.uTeamColor = { value: new THREE.Color(color) };
    material.userData.uDetail = { value: PROC_KIT.detailStrength };
    material.userData.procedural = true;
    material.onBeforeCompile = paintOnBeforeCompile;
    material.customProgramCacheKey = () => 'steelMansProcPaint';
    entry = { material, users: 0, hex };
    paintCache.set(hex, entry);
  }
  entry.users++;
  return entry.material;
}

export function releasePaintMaterial(material) {
  for (const [hex, entry] of paintCache) {
    if (entry.material !== material) continue;
    if (--entry.users > 0) return;
    material.dispose();
    paintCache.delete(hex);
    releasePanelTexture();
    return;
  }
}

const glowCache = new Map();    // hex -> { material, users }

/** Shared additive glow material (beacon light halos), ref-counted */
export function acquireGlowMaterial(color) {
  const hex = new THREE.Color(color).getHexString();
  let entry = glowCache.get(hex);
  if (!entry) {
    const material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: PROC_KIT.glowOpacity,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    entry = { material, users: 0 };
    glowCache.set(hex, entry);
  }
  entry.users++;
  return entry.material;
}

export function releaseGlowMaterial(material) {
  for (const [hex, entry] of glowCache) {
    if (entry.material !== material) continue;
    if (--entry.users > 0) return;
    material.dispose();
    glowCache.delete(hex);
    return;
  }
}

// ---------------------------------------------------------------- surfaces

/**
 * Surface description of a part: colour (sRGB hex), team (0..1 mask – multiplied by the team colour),
 * metal (metalness), rough (roughness), glow (emissive strength of the vertex colour).
 */
export function surface(color, { team = 0, metal = 0.3, rough = 0.7, glow = 0 } = {}) {
  return { color: new THREE.Color(color), team, metal, rough, glow };
}

/** Same surface with a different colour or parameters */
export const withSurface = (s, patch) => ({ ...s, ...patch, color: patch.color ? new THREE.Color(patch.color) : s.color });

// ---------------------------------------------------------------- geometry builders

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Applies a placement { x, y, z, rx, ry, rz, sx, sy, sz } to a geometry (construction time only) */
export function place(geo, t = {}) {
  _e.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0);
  _q.setFromEuler(_e);
  _p.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  _s.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  geo.applyMatrix4(_m.compose(_p, _q, _s));
  return geo;
}

/** Writes the colour and aSurface attributes (and drops uv – PartBuilder projects UVs after merging) */
function paintGeo(g, s) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const surf = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = s.color.r; col[i * 3 + 1] = s.color.g; col[i * 3 + 2] = s.color.b;
    surf[i * 4] = s.team; surf[i * 4 + 1] = s.metal; surf[i * 4 + 2] = s.rough; surf[i * 4 + 3] = s.glow;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSurface', new THREE.BufferAttribute(surf, 4));
  g.deleteAttribute('uv');
  if (!g.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

/**
 * Collects painted primitives in model (or part-local) space and merges them into one geometry.
 * All add* methods take (dimensions…, surface, placement) and return the builder.
 */
export class PartBuilder {
  constructor() { this.parts = []; }

  add(geo, s, t) {
    this.parts.push(paintGeo(place(geo, t), s));
    return this;
  }

  /** Box, origin at its centre unless t.base (origin at the bottom face) */
  box(w, h, d, s, t = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (t.base) g.translate(0, h / 2, 0);
    return this.add(g, s, t);
  }

  /** Box whose top face is narrower in X (topW) and optionally in Z (topD) – sloped walls, buttresses. Origin at the bottom. */
  taperedBox(w, topW, h, d, s, t = {}, topD = d) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) <= h / 2) continue;
      pos.setX(i, pos.getX(i) * (topW / w));
      pos.setZ(i, pos.getZ(i) * (topD / d));
    }
    g.computeVertexNormals();     // box faces are not shared – normals stay flat per face
    return this.add(g, s, t);
  }

  /** Wedge: right-angled prism, the slope falls from +X (height h) to −X (0), length d along Z. Origin at bottom centre. */
  wedge(w, h, d, s, t = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > h / 2 && pos.getX(i) < 0) pos.setY(i, 0.001);
    g.computeVertexNormals();
    return this.add(g, s, t);
  }

  /** Cylinder along Y, origin at its centre */
  cylinder(rTop, rBottom, h, segments, s, t = {}, openEnded = false, thetaStart = 0, thetaLength = Math.PI * 2) {
    return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, openEnded, thetaStart, thetaLength), s, t);
  }

  sphere(r, wSeg, hSeg, s, t = {}) {
    return this.add(new THREE.SphereGeometry(r, wSeg, hSeg), s, t);
  }

  torus(r, tube, radialSeg, tubularSeg, arc, s, t = {}) {
    return this.add(new THREE.TorusGeometry(r, tube, radialSeg, tubularSeg, arc), s, t);
  }

  /**
   * Yellow/black hazard stripes on a flat strip (length along X, height along Y, facing +Z), centred at origin.
   * Each stripe is one parallelogram (2 triangles); place it 0.01–0.02 in front of a wall.
   */
  hazardStrip(length, height, stripeWidth, sA, sB, t = {}) {
    const count = Math.max(1, Math.round(length / stripeWidth));
    const step = length / count;
    const slant = height * 0.8;
    const pos = [];
    const col = [];
    const surf = [];
    const x0 = -length / 2;
    for (let i = 0; i < count; i++) {
      const a = x0 + i * step;
      const b = a + step;
      const s = i % 2 ? sB : sA;
      // clamp the slanted top edge to the strip ends
      const ta = Math.min(x0 + length, a + slant);
      const tb = Math.min(x0 + length, b + slant);
      const quad = [a, -height / 2, b, -height / 2, tb, height / 2, a, -height / 2, tb, height / 2, ta, height / 2];
      for (let v = 0; v < 6; v++) {
        pos.push(quad[v * 2], quad[v * 2 + 1], 0);
        col.push(s.color.r, s.color.g, s.color.b);
        surf.push(s.team, s.metal, s.rough, s.glow);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    place(g, t);
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aSurface', new THREE.Float32BufferAttribute(surf, 4));
    const n = pos.length / 3;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.parts.push(g);
    return this;
  }

  /** Pipe along a polyline of [x, y, z] points: a cylinder per segment and a ball at each inner joint */
  pipe(points, radius, segments, s) {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    for (let i = 0; i < points.length - 1; i++) {
      a.fromArray(points[i]);
      b.fromArray(points[i + 1]);
      const len = a.distanceTo(b);
      const g = new THREE.CylinderGeometry(radius, radius, len, segments, 1, true);
      q.setFromUnitVectors(up, b.clone().sub(a).normalize());
      g.applyQuaternion(q);
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      this.parts.push(paintGeo(g, s));
      if (i > 0) this.sphere(radius * 1.15, segments, Math.max(3, segments / 2), s, { x: a.x, y: a.y, z: a.z });
    }
    return this;
  }

  /** Merges everything into one indexed geometry with box-projected UVs (PROC_KIT.textureWorldSize per tile) */
  build() {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    projectUvs(merged);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}

/** Box (tri-planar by dominant normal axis) UV projection in world-scale units */
function projectUvs(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const k = 1 / PROC_KIT.textureWorldSize;
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    let u; let v;
    if (ax >= ay && ax >= az) { u = pos.getZ(i); v = pos.getY(i); }
    else if (ay >= az) { u = pos.getX(i); v = pos.getZ(i); }
    else { u = pos.getX(i); v = pos.getY(i); }
    uv[i * 2] = u * k;
    uv[i * 2 + 1] = v * k;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Plain geometry (position only) for glow halos – merged small octahedra at the given points */
export function glowGeometry(points, radius) {
  const parts = points.map(([x, y, z]) => new THREE.OctahedronGeometry(radius, 1).translate(x, y, z));
  for (const p of parts) { p.deleteAttribute('uv'); p.deleteAttribute('normal'); }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/** Triangle count of a geometry */
export const triangleCount = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;

// ---------------------------------------------------------------- animation modules (visual only, no allocation in update)

/** Smootherstep 0..1 (zero velocity and acceleration at both ends) */
export const smootherstep = (t) => { const x = t <= 0 ? 0 : t >= 1 ? 1 : t; return x * x * x * (x * (x * 6 - 15) + 10); };

/** Trapezoid 0→1→0 over t∈[0,1]: eased rise during `edge`, hold, eased fall during `edge` */
export function plateau(t, edge = 0.3) {
  if (t <= 0 || t >= 1) return 0;
  if (t < edge) return smootherstep(t / edge);
  if (t > 1 - edge) return smootherstep((1 - t) / edge);
  return 1;
}

/** Rotating part: turns `object[axis]` at `speed` rad/s (always, or only while `active`; eases the speed). */
export class Spinner {
  /**
   * @param {THREE.Object3D} object
   * @param {{speed?:number, axis?:'x'|'y'|'z', ease?:number, phase?:number}} [o] ease = 1/s speed damping (0 = instant)
   */
  constructor(object, { speed = 1, axis = 'y', ease = 0, phase = 0 } = {}) {
    this.object = object; this.speed = speed; this.axis = axis; this.ease = ease;
    this.current = ease > 0 ? 0 : speed;   // eased speed (rad/s)
    object.rotation[axis] = phase;
  }

  update(delta, active = true) {
    if (this.ease > 0) this.current += ((active ? this.speed : 0) - this.current) * Math.min(1, delta * this.ease);
    else this.current = active ? this.speed : 0;
    this.object.rotation[this.axis] += delta * this.current;
  }
}

/** Blinking two-phase signal: `on` is true during the first `duty` share of the period, `off` in the rest (while active). */
export class Blinker {
  constructor({ period = 1, duty = 0.5, phase = 0 } = {}) {
    this.period = period; this.duty = duty; this.time = phase * period; this.on = false; this.off = false;
  }

  update(delta, active) {
    this.time = active ? (this.time + delta) % this.period : 0;
    const first = this.time < this.period * this.duty;
    this.on = active && first;
    this.off = active && !first;
  }
}

/**
 * Industrial mover along a closed route of stops in 1..N axes (gantry bridge + trolley, lifts, door carriages).
 * While `active` it cycles stop → travel → dwell → next stop; the stops are listed per axis: stops[i] = [a0, a1, …].
 * Travel is smootherstep (start, cruise, stop) with duration = max over axes of distance / speed[axis]; the dwell
 * length is `dwell` seconds. When deactivated it finishes the current leg (and dwell) and then travels to `rest`.
 *   value[k]  – current position of axis k (read it, no allocation)
 *   phase     – 'rest' | 'travel' | 'dwell'
 *   dwellT    – 0..1 progress of the current dwell (0 outside); drive hooks / arms with it (see `plateau`)
 *   arrived   – stop index of the last / current dwell (-1 before the first)
 * Visual only: use delta of the render or tick loop; nothing here touches the simulation.
 */
export class TrackMover {
  /**
   * @param {{rest:number[], stops:number[][], speed:number[], dwell?:number, minLeg?:number}} o
   */
  constructor({ rest, stops, speed, dwell = 2, minLeg = 0.6 }) {
    this.axes = rest.length;
    this.rest = rest.slice();
    this.stops = stops.map((s) => s.slice());
    this.speed = speed.slice();
    this.dwell = dwell;
    this.minLeg = minLeg;
    this.value = rest.slice();
    this.from = rest.slice();
    this.to = rest.slice();
    this.phase = 'rest';
    this.legTime = 0; this.legDuration = 1;
    this.dwellT = 0; this.dwellClock = 0;
    this.next = 0; this.arrived = -1;
    this.toRest = false;
  }

  #startLeg(target, isRest) {
    let dur = this.minLeg;
    for (let k = 0; k < this.axes; k++) {
      this.from[k] = this.value[k];
      this.to[k] = target[k];
      dur = Math.max(dur, Math.abs(target[k] - this.value[k]) / this.speed[k] * 1.875);   // smootherstep peak = 1.875 × mean
    }
    this.legTime = 0; this.legDuration = dur; this.toRest = isRest; this.phase = 'travel';
  }

  update(delta, active) {
    if (this.phase === 'rest') {
      if (!active) return;
      this.#startLeg(this.stops[this.next], false);
    }
    if (this.phase === 'dwell') {
      this.dwellClock += delta;
      this.dwellT = Math.min(1, this.dwellClock / this.dwell);
      if (this.dwellT < 1) return;   // a started dwell always runs to its end (hook rises smoothly), even when deactivated
      this.dwellT = 0;
      if (active) { this.next = (this.next + 1) % this.stops.length; this.#startLeg(this.stops[this.next], false); }
      else this.#startLeg(this.rest, true);
    }
    if (this.phase !== 'travel') return;
    this.legTime += delta;
    const e = smootherstep(this.legTime / this.legDuration);
    for (let k = 0; k < this.axes; k++) this.value[k] = this.from[k] + (this.to[k] - this.from[k]) * e;
    if (this.legTime < this.legDuration) return;
    if (this.toRest) { this.phase = 'rest'; this.next = 0; return; }
    this.arrived = this.next;
    if (active) { this.phase = 'dwell'; this.dwellClock = 0; this.dwellT = 0; }
    else this.#startLeg(this.rest, true);
  }
}
