// Steel Men – procedural model kit. Shared low-level helpers for buildings generated in code:
//   • one "paint" shader for every static and animated part: vertex colour + per-vertex surface attribute
//     aSurface = (teamMask, metalness, roughness, emissive) → a whole building is a few draw calls
//   • panel textures from canvas, one per surface type (clean / worn / smooth / circuit – PROC_KIT.textures), used
//     as bump map and diffuse detail (RGB: worn plates carry rust)
//   • geometry builders (box, rounded box, tapered box, cylinder, cone, hazard strip, pipe run) and a PartBuilder that
//     merges them into one BufferGeometry with box-projected world-scale UVs; GlowBuilder for additive glow layers
//   • ref-counted caches: paint material per team colour + texture type, textures (glow materials: ProcModules GlowLayer)
// Team colour: the material has no `map`, so core/TeamColor.applyTeamColor leaves it alone; the team colour is
// the uniform uTeamColor (setTeamColor on the model). Visual only – nothing here is read by the simulation.
// Style-aware modules (fans, beacons, cranes, emblem…) live in ProcModules.js.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HIGHLIGHT, BUILDING_LOD, PROC_STATE } from '../config.js';

/** Kit tuning (visual only) */
export const PROC_KIT = {
  textureSize: 256,        // px – panel texture (square, tiles)
  textureWorldSize: 6,     // model units covered by one texture tile
  textureSeed: 1337,
  defaultTexture: 'clean', // used for an unknown texture type
  // Panel textures by type (style.texture). kind = painter; baseGrey = diffuse multiplier, detail = 0 texture
  // ignored in diffuse … 1 full multiply, bumpScale of the material; the rest are painter parameters (px / counts).
  textures: {
    clean: {
      kind: 'plates', baseGrey: 0.9, plateVar: 0.04, panels: 2, stagger: 0, seam: 1, seamGrey: 0.6, split: 0.25,
      rivets: false, rivetRadius: 1, grime: 40, grimeAlpha: 0.04, streaks: 0, rust: 0, scratches: 0,
      detail: 0.55, bumpScale: 0.7,
    },
    worn: {
      kind: 'plates', baseGrey: 0.82, plateVar: 0.12, panels: 3, stagger: 0.5, seam: 3, seamGrey: 0.2, split: 0.5,
      rivets: true, rivetRadius: 1.6, grime: 320, grimeAlpha: 0.11, streaks: 70, rust: 70, rustAlpha: 0.35,
      rustColor: [0.55, 0.26, 0.11], scratches: 60, detail: 0.95, bumpScale: 1.7,
    },
    smooth: {
      kind: 'hex', baseGrey: 0.95, hexRows: 4, lineGrey: 0.86, lineWidth: 1, blotches: 50, blotchAlpha: 0.035,
      detail: 0.3, bumpScale: 0.45,
    },
    circuit: {
      kind: 'circuit', baseGrey: 0.9, diamonds: 4, seam: 1.5, seamGrey: 0.42, traces: 28, traceGrey: 0.72,
      traceGrid: 32, traceDot: 1.6, detail: 0.6, bumpScale: 0.9,
    },
  },
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

// ---------------------------------------------------------------- panel textures (one per type, ref-counted)

/** Known texture type (style.texture), unknown → PROC_KIT.defaultTexture */
export const textureTypeOf = (type) => (Object.hasOwn(PROC_KIT.textures, type) ? type : PROC_KIT.defaultTexture);

const css = (r, g, b, a = 1) => {
  const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${c(r)},${c(g)},${c(b)},${a})`;
};
const grey = (v, a = 1) => css(v, v, v, a);

function softSpot(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// Plates with seams (clean: few fine seams; worn: staggered heavy plates, rivets, rust, grime, streaks, scratches)
function paintPlates(ctx, size, rng, o) {
  ctx.fillStyle = grey(o.baseGrey);
  ctx.fillRect(0, 0, size, size);
  const cell = size / o.panels;
  const shiftOf = (row) => (row % 2 ? cell * o.stagger : 0);
  for (let j = 0; j < o.panels; j++) {
    for (let i = -1; i < o.panels; i++) {
      const x = i * cell + shiftOf(j);
      ctx.fillStyle = grey(o.baseGrey + (rng() - 0.5) * o.plateVar);
      ctx.fillRect(x, j * cell, cell, cell);
      if (rng() < o.split) {   // a split plate now and then
        ctx.fillStyle = grey(o.seamGrey);
        ctx.fillRect(x, j * cell + cell / 2 - o.seam / 4, cell, Math.max(1, o.seam / 2));
      }
    }
  }
  for (let n = 0; n < o.rust; n++) {
    const [r, g, b] = o.rustColor;
    softSpot(ctx, rng() * size, rng() * size, 3 + rng() * 14, css(r, g, b, o.rustAlpha * (0.4 + rng() * 0.6)));
  }
  for (let n = 0; n < o.grime; n++) softSpot(ctx, rng() * size, rng() * size, 2 + rng() * 10, grey(0, o.grimeAlpha * (0.5 + rng())));
  for (let n = 0; n < o.streaks; n++) {   // rain streaks below the horizontal seams
    const x = rng() * size;
    const y = Math.floor(rng() * o.panels) * cell;
    const len = cell * (0.3 + rng() * 0.6);
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, grey(0, 0.16));
    g.addColorStop(1, grey(0, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 1 + rng() * 2, len);
  }
  ctx.strokeStyle = grey(1, 0.25);
  ctx.lineWidth = 1;
  for (let n = 0; n < o.scratches; n++) {
    const x = rng() * size;
    const y = rng() * size;
    const a = rng() * Math.PI;
    const len = 4 + rng() * 18;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
  }
  // seams: horizontal full lines, vertical per row (staggered rows)
  ctx.fillStyle = grey(o.seamGrey);
  for (let j = 0; j <= o.panels; j++) ctx.fillRect(0, Math.round(j * cell) - o.seam / 2, size, o.seam);
  for (let j = 0; j < o.panels; j++) {
    for (let i = -1; i <= o.panels; i++) ctx.fillRect(Math.round(i * cell + shiftOf(j)) - o.seam / 2, j * cell, o.seam, cell);
  }
  if (!o.rivets) return;
  const step = cell / 6;
  const rivet = (x, y) => {
    ctx.fillStyle = grey(1);
    ctx.beginPath(); ctx.arc(x, y, o.rivetRadius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = grey(0.35);
    ctx.beginPath(); ctx.arc(x + 0.6, y + 0.6, o.rivetRadius * 0.6, 0, Math.PI * 2); ctx.fill();
  };
  const inset = o.seam + o.rivetRadius * 2;
  for (let j = 0; j <= o.panels; j++) for (let s = step / 2; s < size; s += step) rivet(s, j * cell + inset);
  for (let j = 0; j < o.panels; j++) {
    for (let i = 0; i <= o.panels; i++) for (let s = step / 2; s < cell; s += step) rivet(i * cell + shiftOf(j) + inset, j * cell + s);
  }
}

// Smooth pearl surface: soft blotches and a faint hexagonal pattern (no seams)
function paintHex(ctx, size, rng, o) {
  ctx.fillStyle = grey(o.baseGrey);
  ctx.fillRect(0, 0, size, size);
  for (let n = 0; n < o.blotches; n++) {
    softSpot(ctx, rng() * size, rng() * size, 10 + rng() * 40, grey(rng() < 0.5 ? 1 : 0, o.blotchAlpha));
  }
  const r = size / (3 * o.hexRows);                       // 2·hexRows rows of 1.5 r tile the height exactly
  const colW = Math.sqrt(3) * r;
  const cols = Math.max(1, Math.round(size / colW));
  const sx = size / (cols * colW);                        // slight horizontal stretch so the columns tile too
  ctx.strokeStyle = grey(o.lineGrey);
  ctx.lineWidth = o.lineWidth;
  for (let row = -1; row <= o.hexRows * 2; row++) {
    for (let col = -1; col <= cols; col++) {
      const cx = (col + (row % 2 ? 0.5 : 0)) * colW * sx;
      const cy = row * 1.5 * r;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        const x = cx + Math.cos(a) * r * sx;
        const y = cy + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
}

// Precise diamond seams and engraved circuit traces
function paintCircuit(ctx, size, rng, o) {
  ctx.fillStyle = grey(o.baseGrey);
  ctx.fillRect(0, 0, size, size);
  const c = size / o.diamonds;
  ctx.strokeStyle = grey(o.seamGrey);
  ctx.lineWidth = o.seam;
  for (let k = -o.diamonds; k <= o.diamonds * 2; k++) {
    ctx.beginPath(); ctx.moveTo(k * c, 0); ctx.lineTo(k * c - size, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(k * c, 0); ctx.lineTo(k * c + size, size); ctx.stroke();
  }
  const g = size / o.traceGrid;
  ctx.strokeStyle = grey(o.traceGrey);
  ctx.fillStyle = grey(o.traceGrey);
  ctx.lineWidth = 1;
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1]];
  for (let n = 0; n < o.traces; n++) {
    let x = Math.floor(rng() * o.traceGrid) * g;
    let y = Math.floor(rng() * o.traceGrid) * g;
    ctx.beginPath(); ctx.arc(x, y, o.traceDot, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, y);
    const legs = 2 + Math.floor(rng() * 3);
    for (let l = 0; l < legs; l++) {
      const [dx, dy] = dirs[Math.floor(rng() * dirs.length)];
      const len = (2 + Math.floor(rng() * 5)) * g;
      x += dx * len; y += dy * len;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, o.traceDot, 0, Math.PI * 2); ctx.fill();
  }
}

const PAINTERS = { plates: paintPlates, hex: paintHex, circuit: paintCircuit };

let textureSizeNow = PROC_KIT.textureSize;   // px, changed by setPanelTextureSize (building quality level)

// Painted always at PROC_KIT.textureSize (painter parameters are in px of that size), smaller sizes are downscaled copies
function paintPanelCanvas(type) {
  const o = PROC_KIT.textures[type];
  const full = PROC_KIT.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = full;
  PAINTERS[o.kind](canvas.getContext('2d'), full, makeRng(PROC_KIT.textureSeed), o);
  if (textureSizeNow === full) return canvas;
  const small = document.createElement('canvas');
  small.width = small.height = textureSizeNow;
  const ctx = small.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, textureSizeNow, textureSizeNow);
  return small;
}

/**
 * Resolution of the panel textures (px). Existing textures are repainted in place (materials keep working), new ones
 * are created at this size. Called by the building quality level (BuildingBatcher).
 */
export function setPanelTextureSize(px) {
  if (px === textureSizeNow) return;
  textureSizeNow = px;
  for (const [type, entry] of textureCache) {
    const tex = entry.texture;
    tex.dispose();                      // new GPU storage for the new size
    tex.image = paintPanelCanvas(type);
    tex.needsUpdate = true;
  }
}

function createPanelTexture(type) {
  const tex = new THREE.CanvasTexture(paintPanelCanvas(type));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;   // data: bump heights (red) and a linear diffuse factor (RGB)
  tex.anisotropy = 4;
  return tex;
}

const textureCache = new Map();   // type -> { texture, users }

function acquirePanelTexture(type) {
  let entry = textureCache.get(type);
  if (!entry) {
    entry = { texture: createPanelTexture(type), users: 0 };
    textureCache.set(type, entry);
  }
  entry.users++;
  return entry.texture;
}

function releasePanelTexture(type) {
  const entry = textureCache.get(type);
  if (!entry || --entry.users > 0) return;
  entry.texture.dispose();
  textureCache.delete(type);
}

// ---------------------------------------------------------------- paint material (one shader for all parts)

// Regular function: three.js calls it as material.onBeforeCompile(shader) → `this` = material. One function for
// all team clones = one shader program; each clone keeps its own uTeamColor uniform.
function paintOnBeforeCompile(shader) {
  shader.uniforms.uDetail = this.userData.uDetail;
  if (this.defines.PROC_INSTANCED !== undefined) { paintInstancedShader(shader, this.userData.uHighlight, this.defines.PROC_STATE_ATTR !== undefined); return; }
  shader.uniforms.uTeamColor = this.userData.uTeamColor;
  shader.uniforms.uState = this.userData.uState;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aSurface;\nvarying vec4 vSurface;')
    .replace('#include <color_vertex>', '#include <color_vertex>\nvSurface = aSurface;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uTeamColor;\nuniform vec3 uState;\nuniform float uDetail;\nvarying vec4 vSurface;')
    .replace('#include <color_fragment>', [
      '#include <color_fragment>',
      'diffuseColor.rgb *= mix(vec3(1.0), texture2D(bumpMap, vBumpMapUv).rgb, uDetail);',
      'diffuseColor.rgb *= mix(vec3(1.0), uTeamColor, vSurface.x);',
      'diffuseColor.rgb *= mix(uState.x, uState.y, vSurface.x);',   // damage: paint scale, team-masked scale
    ].join('\n'))
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.z;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;')
    // team-masked glowing parts (neon strips in the team colour) glow in the team colour; uState.z = power glow scale
    .replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor * mix(vec3(1.0), uTeamColor, vSurface.x) * vSurface.w * uState.z;');
}

/**
 * Building state look (damage darkening + power glow) from quantised steps: out = (paint scale, team-masked paint scale,
 * emissive scale). Steps 0 / 0 = the unchanged look (1, 1, 1). Writes into `out` (no allocation).
 */
export function stateLook(damageStep, powerStep, out) {
  const f = damageStep / PROC_STATE.damageSteps;
  const paint = 1 + (PROC_STATE.minPaint - 1) * f;
  out[0] = paint;
  out[1] = 1 - (1 - paint) * (1 - PROC_STATE.teamKeep);
  const p = powerStep / PROC_STATE.powerSteps;
  out[2] = PROC_STATE.offGlow + (1 - PROC_STATE.offGlow) * p;
  return out;
}

// Instanced variant (BuildingBatcher): per-instance attribute aInst = (team colour rgb, hover highlight 0..1) replaces
// the uTeamColor uniform; the hover highlight adds the HIGHLIGHT emissive. Same texture / surface logic otherwise.
// With `withState` (buildings) the instance also carries aState = (paint scale, team-masked scale, emissive scale),
// see stateLook; units have no such attribute and keep the plain look.
function paintInstancedShader(shader, highlight, withState) {
  shader.uniforms.uHighlight = highlight;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec4 aSurface;\nattribute vec4 aInst;\n${withState ? 'attribute vec3 aState;\nvarying vec3 vState;\n' : ''}varying vec4 vSurface;\nvarying vec4 vInst;`)
    .replace('#include <color_vertex>', `#include <color_vertex>\nvSurface = aSurface;\nvInst = aInst;${withState ? '\nvState = aState;' : ''}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform float uDetail;\nuniform vec3 uHighlight;\n${withState ? 'varying vec3 vState;\n' : ''}varying vec4 vSurface;\nvarying vec4 vInst;`)
    .replace('#include <color_fragment>', [
      '#include <color_fragment>',
      'diffuseColor.rgb *= mix(vec3(1.0), texture2D(bumpMap, vBumpMapUv).rgb, uDetail);',
      'diffuseColor.rgb *= mix(vec3(1.0), vInst.rgb, vSurface.x);',
      withState ? 'diffuseColor.rgb *= mix(vState.x, vState.y, vSurface.x);' : '',
    ].join('\n'))
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.z;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;')
    .replace('#include <emissivemap_fragment>', [
      '#include <emissivemap_fragment>',
      `totalEmissiveRadiance += vColor * mix(vec3(1.0), vInst.rgb, vSurface.x) * vSurface.w${withState ? ' * vState.z' : ''} + uHighlight * vInst.a;`,
    ].join('\n'));
}

const highlightUniform = { value: new THREE.Color(HIGHLIGHT.color).multiplyScalar(HIGHLIGHT.intensity) };
const instancedCache = new Map();   // texture type -> { material, users }

/**
 * Instanced paint material (InstancedMesh with an `aInst` InstancedBufferAttribute, see BuildingBatcher), one per
 * panel texture type, ref-counted – pair with releaseInstancedPaintMaterial.
 */
export function acquireInstancedPaintMaterial(texture = PROC_KIT.defaultTexture, withState = false) {
  const type = textureTypeOf(texture);
  const key = withState ? `${type}:state` : type;   // buildings: instances carry aState (damage / power look)
  let entry = instancedCache.get(key);
  if (!entry) {
    const o = PROC_KIT.textures[type];
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, bumpMap: acquirePanelTexture(type), bumpScale: o.bumpScale });
    material.defines.PROC_INSTANCED = '';
    if (withState) material.defines.PROC_STATE_ATTR = '';
    material.userData.uDetail = { value: o.detail };
    material.userData.uHighlight = highlightUniform;
    material.userData.procedural = true;
    material.onBeforeCompile = paintOnBeforeCompile;
    material.customProgramCacheKey = () => (withState ? 'steelMenProcPaintInstancedState' : 'steelMenProcPaintInstanced');
    entry = { material, users: 0, type };
    instancedCache.set(key, entry);
  }
  entry.users++;
  return entry.material;
}

export function releaseInstancedPaintMaterial(material) {
  for (const [type, entry] of instancedCache) {
    if (entry.material !== material) continue;
    if (--entry.users > 0) return;
    material.dispose();
    instancedCache.delete(type);
    releasePanelTexture(entry.type);
    return;
  }
}

const paintCache = new Map();   // "hex:texture" -> { material, users, type }

/**
 * Shared paint material for a team colour and a panel texture type (style.texture), ref-counted – pair with
 * releasePaintMaterial. All clones share one shader program.
 */
export function acquirePaintMaterial(color, texture = PROC_KIT.defaultTexture, damageStep = 0, powerStep = PROC_STATE.powerSteps) {
  const type = textureTypeOf(texture);
  const key = `${new THREE.Color(color).getHexString()}:${type}:${damageStep}:${powerStep}`;
  let entry = paintCache.get(key);
  if (!entry) {
    const o = PROC_KIT.textures[type];
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      bumpMap: acquirePanelTexture(type),
      bumpScale: o.bumpScale,
    });
    material.userData.uState = { value: new THREE.Vector3().fromArray(stateLook(damageStep, powerStep, [1, 1, 1])) };
    material.userData.uTeamColor = { value: new THREE.Color(color) };
    material.userData.uDetail = { value: o.detail };
    material.userData.procedural = true;
    material.onBeforeCompile = paintOnBeforeCompile;
    material.customProgramCacheKey = () => 'steelMenProcPaint';
    entry = { material, users: 0, type };
    paintCache.set(key, entry);
  }
  entry.users++;
  return entry.material;
}

export function releasePaintMaterial(material) {
  for (const [key, entry] of paintCache) {
    if (entry.material !== material) continue;
    if (--entry.users > 0) return;
    material.dispose();
    paintCache.delete(key);
    releasePanelTexture(entry.type);
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
  constructor() { this.parts = []; }   // entries { geo, detail (explicit 0..2 | null = by size), size, round }

  /**
   * Stores a finished part. `detail` = coarsest LOD the part still appears in: 0 = fine detail (LOD0 only),
   * 1 = also in LOD1, 2 = also in the LOD2 silhouette; null = by size (share of the whole building, BUILDING_LOD.partMinShare).
   */
  #push(geo, detail = null, round = null) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    this.parts.push({ geo, detail, size, round });
    return this;
  }

  /** Placement key `detail: 0|1|2` of any add* method marks the part (see #push); default = by size */
  add(geo, s, t) {
    return this.#push(paintGeo(place(geo, t), s), t?.detail ?? null);
  }

  /** Box, origin at its centre unless t.base (origin at the bottom face) */
  box(w, h, d, s, t = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (t.base) g.translate(0, h / 2, 0);
    return this.add(g, s, t);
  }

  /**
   * Box with rounded (segments ≥ 2) or chamfered (segments = 1) edges and corners, origin at its centre unless t.base.
   * Triangles: 12 · (2·segments + 1)² – use it for big volumes only.
   */
  roundedBox(w, h, d, radius, segments, s, t = {}) {
    const g = roundedBoxGeometry(w, h, d, radius, segments);
    if (t.base) g.translate(0, h / 2, 0);
    return this.#push(paintGeo(place(g, t), s), t.detail ?? null, { w, h, d, radius, s, t });
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
    return this.#push(g, t.detail ?? null);
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
      this.#push(paintGeo(g, s));
      if (i > 0) this.sphere(radius * 1.15, segments, Math.max(3, segments / 2), s, { x: a.x, y: a.y, z: a.z });
    }
    return this;
  }

  /** Merges everything (LOD0) into one indexed geometry with box-projected UVs (PROC_KIT.textureWorldSize per tile) */
  build() {
    const merged = this.#merge(0, 0);
    this.#release();
    return merged;
  }

  /**
   * Geometry set of a building, one merged geometry per LOD (index = LOD, BUILDING_LOD.levels): LOD0 = everything,
   * LOD1 = without fine parts (rounded boxes chamfered), LOD2 = coarse silhouette (rounded boxes plain). A part is in
   * LOD n when its `detail` ≥ n (explicit placement key) or – without one – its largest side is at least
   * BUILDING_LOD.partMinShare[n] of the building's largest side. Every LOD holds at least the largest part.
   */
  buildLods() {
    const box = new THREE.Box3();
    for (const p of this.parts) box.union(p.geo.boundingBox);
    const extent = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    const out = [];
    for (let lod = 0; lod < BUILDING_LOD.levels; lod++) out.push(this.#merge(lod, extent));
    this.#release();
    return out;
  }

  #levelOf(p, extent) {
    if (p.detail !== null) return p.detail;
    let level = 0;
    for (let n = 1; n < BUILDING_LOD.levels; n++) if (p.size >= extent * BUILDING_LOD.partMinShare[n]) level = n;
    return level;
  }

  #merge(lod, extent) {
    let picks = this.parts.filter((p) => this.#levelOf(p, extent) >= lod);
    if (!picks.length) picks = [this.parts.reduce((a, b) => (b.size > a.size ? b : a))];
    const temp = [];
    const geos = picks.map((p) => {
      const segments = BUILDING_LOD.roundedSegments[lod];
      if (!p.round || segments === null) return p.geo;
      const { w, h, d, radius, s, t } = p.round;
      const g = segments > 0 ? roundedBoxGeometry(w, h, d, radius, segments) : new THREE.BoxGeometry(w, h, d);
      if (t.base) g.translate(0, h / 2, 0);
      paintGeo(place(g, t), s);
      temp.push(g);
      return g;
    });
    const merged = mergeGeometries(geos, false);
    for (const g of temp) g.dispose();
    projectUvs(merged);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  #release() {
    for (const p of this.parts) p.geo.dispose();
    this.parts = [];
  }
}

/**
 * Rounded box geometry (centred): a subdivided unit box whose vertices are pushed onto an inner box + radius
 * (same scheme as three's RoundedBoxGeometry addon, which is not vendored). segments = 1 gives a 45° chamfer.
 */
export function roundedBoxGeometry(w, h, d, radius, segments) {
  const n = segments * 2 + 1;
  const g = new THREE.BoxGeometry(1, 1, 1, n, n, n);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const half = 0.5 / n;
  const r = Math.min(radius, w / 2, h / 2, d / 2);
  const bx = w / 2 - r;
  const by = h / 2 - r;
  const bz = d / 2 - r;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let nx = x - Math.sign(x) * half;
    let ny = y - Math.sign(y) * half;
    let nz = z - Math.sign(z) * half;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    pos.setXYZ(i, Math.sign(x) * bx + nx * r, Math.sign(y) * by + ny * r, Math.sign(z) * bz + nz * r);
    nor.setXYZ(i, nx, ny, nz);
  }
  return g;
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

const _ga = new THREE.Vector3();
const _gb = new THREE.Vector3();
const _gup = new THREE.Vector3(0, 1, 0);
const _gq = new THREE.Quaternion();

/**
 * Position-only geometry for additive glow layers (halos, strips, beams, rings, arcs): every part is converted to
 * non-indexed triangles and merged → one draw call per layer. `vertices` = vertex count so far (use it to record
 * draw ranges, e.g. arc variants). Construction time only.
 */
export class GlowBuilder {
  constructor() { this.parts = []; this.vertices = 0; }

  add(geo, t = {}) {
    place(geo, t);
    let g = geo;
    if (g.index) { g = geo.toNonIndexed(); geo.dispose(); }
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    this.parts.push(g);
    this.vertices += g.attributes.position.count;
    return this;
  }

  /** Small round halo (octahedron) at [x, y, z] */
  point([x, y, z], radius) { return this.add(new THREE.OctahedronGeometry(radius, 1), { x, y, z }); }
  box(w, h, d, t) { return this.add(new THREE.BoxGeometry(w, h, d), t); }
  cylinder(rTop, rBottom, h, segments, t, openEnded = true) {
    return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, openEnded), t);
  }
  sphere(r, wSeg, hSeg, t) { return this.add(new THREE.SphereGeometry(r, wSeg, hSeg), t); }
  torus(r, tube, radialSeg, tubularSeg, arc, t) { return this.add(new THREE.TorusGeometry(r, tube, radialSeg, tubularSeg, arc), t); }

  /** Thin square beam from point a to point b ([x, y, z]) */
  segment(a, b, thickness) {
    _ga.fromArray(a);
    _gb.fromArray(b);
    const len = _ga.distanceTo(_gb);
    if (len <= 0) return this;
    const g = new THREE.BoxGeometry(thickness, len, thickness);
    _gq.setFromUnitVectors(_gup, _gb.sub(_ga).normalize());
    g.applyQuaternion(_gq);
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    return this.add(g);
  }

  get empty() { return this.parts.length === 0; }

  /** Merged geometry (null when nothing was added) */
  build() {
    if (this.empty) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}

/** Triangle count of a geometry (respects a finite draw range) */
export function triangleCount(geo) {
  const total = geo.index ? geo.index.count : geo.attributes.position.count;
  return Math.min(total, geo.drawRange.count) / 3;
}

// ---------------------------------------------------------------- animation modules (visual only, no allocation in update)

/** Smootherstep 0..1 (zero velocity and acceleration at both ends) */
export const smootherstep = (t) => { const x = t <= 0 ? 0 : t >= 1 ? 1 : t; return x * x * x * (x * (x * 6 - 15) + 10); };

/**
 * Stepped ease 0..1: `steps` short smootherstep pushes with a stop between them (heavy, piston-like travel).
 * Same mean speed as smootherstep, so TrackMover leg durations stay valid.
 */
export function steppedEase(t, steps) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const s = x * steps;
  const k = Math.min(steps - 1, Math.floor(s));
  return (k + smootherstep(s - k)) / steps;
}

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
   * @param {{rest:number[], stops:number[][], speed:number[], dwell?:number, minLeg?:number, steps?:number}} o
   *   steps > 0 = jerky travel: each leg is split into `steps` pushes (steppedEase)
   */
  constructor({ rest, stops, speed, dwell = 2, minLeg = 0.6, steps = 0 }) {
    this.steps = steps;
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
    const t = this.legTime / this.legDuration;
    const e = this.steps > 0 ? steppedEase(t, this.steps) : smootherstep(t);
    for (let k = 0; k < this.axes; k++) this.value[k] = this.from[k] + (this.to[k] - this.from[k]) * e;
    if (this.legTime < this.legDuration) return;
    if (this.toRest) { this.phase = 'rest'; this.next = 0; return; }
    this.arrived = this.next;
    if (active) { this.phase = 'dwell'; this.dwellClock = 0; this.dwellT = 0; }
    else this.#startLeg(this.rest, true);
  }
}
