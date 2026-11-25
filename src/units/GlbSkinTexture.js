// Steel Men – [W-skin-tex] procedural textures of the hand-made GLB skins (docs/notes/w-skin-texture.md). DISPLAY ONLY.
// Canvas 2D textures generated once per material kind and shared by every robot (rhombus panel seams, engraved circuit
// traces with 45° bends like the Mercury logo rays, raised inner plates, glowing laser traces and points). The models have
// no UVs: ensureSkinUv() adds them once per shared geometry by a per-triangle box projection in part space.
// Also the faction emblem decal (logo drawn on a canvas) and its placement by a ray cast on the slot's skin meshes.
// Deterministic: own seeded generator, no Math.random. Nothing here is called per frame.
import * as THREE from 'three';
import { GLB_SKIN_TEXTURE as CFG } from '../config.js';

const texCache = new Map();      // kind -> { map, rm, normal, emissive }
const preparedMats = new WeakSet();
let layoutCache = null;
let emblemShared = null;         // { texture, material, geometry }

/** mulberry32: deterministic [0, 1) generator */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a, b, t) => a + (b - a) * t;
const randInt = (r, [lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const grey = (v) => { const c = Math.round(clamp01(v) * 255); return `rgb(${c},${c},${c})`; };
const rgb = (r, g, b) => `rgb(${Math.round(clamp01(r) * 255)},${Math.round(clamp01(g) * 255)},${Math.round(clamp01(b) * 255)})`;

// 8 directions (index * 45°), unit length; even = axis aligned
const DIRS = [];
for (let i = 0; i < 8; i++) DIRS.push([Math.round(Math.cos(i * Math.PI / 4) * 1e6) / 1e6, Math.round(Math.sin(i * Math.PI / 4) * 1e6) / 1e6]);

// --- UV ---------------------------------------------------------------------------------------------------------

/** Box-projected UVs in the geometry's own (part) space, once per geometry; a model with its own UVs is kept */
export function ensureSkinUv(geometry) {
  if (geometry.attributes.uv) return;
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const inv = 1 / CFG.tileSize;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const project = (i, nx, ny, nz) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let u, v;
    if (ax >= ay && ax >= az) { u = nx > 0 ? -z : z; v = y; }        // side faces: right = -z on +x
    else if (az >= ay) { u = nz > 0 ? x : -x; v = y; }               // front / back
    else { u = x; v = ny > 0 ? -z : z; }                             // top / bottom
    uv[i * 2] = u * inv;
    uv[i * 2 + 1] = v * inv;
  };
  if (geometry.index || count % 3) {
    // shared vertices: the vertex normal picks the axis
    for (let i = 0; i < count; i++) {
      if (nrm) project(i, nrm.getX(i), nrm.getY(i), nrm.getZ(i)); else project(i, 0, 0, 1);
    }
  } else {
    // triangle soup: one axis per triangle (no stretch seam inside a face)
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      n.subVectors(c, b).cross(a.sub(b));
      if (n.lengthSq() < 1e-12 && nrm) n.fromBufferAttribute(nrm, i);
      for (let k = 0; k < 3; k++) project(i + k, n.x, n.y, n.z);
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// --- tile layout (shared by all kinds, tile units 0..1) -----------------------------------------------------------

function buildLayout() {
  const L = CFG.layout;
  const r = makeRng(CFG.seed);
  const n2 = L.diamondsPerTile * 2;
  const s = 1 / n2;
  const seams = [];
  const cells = [];
  for (let j = 0; j < n2; j++) {
    for (let i = 0; i < n2; i++) {
      if ((i + j) % 2 === 0) {
        if (r() < L.seamKeep) seams.push([i * s, j * s, (i + 1) * s, (j + 1) * s]);
        if (r() < L.seamKeep) seams.push([i * s, j * s, (i + 1) * s, (j - 1) * s]);
      } else {
        cells.push({
          x: i * s, y: j * s, half: s,
          tone: r() * 2 - 1, rough: r() * 2 - 1,
          inset: r() < L.insetChance, dot: r() < L.glowDotChance,
        });
      }
    }
  }
  const traces = [];
  for (let t = 0; t < L.traces; t++) {
    let x = Math.round(r() * 128) / 128, y = Math.round(r() * 128) / 128;
    let dir = Math.floor(r() * 4) * 2;
    const pts = [[x, y]];
    const segs = randInt(r, L.traceSegments);
    for (let k = 0; k < segs; k++) {
      const len = lerp(L.traceLength[0], L.traceLength[1], r());
      x += DIRS[dir][0] * len; y += DIRS[dir][1] * len;
      pts.push([x, y]);
      dir = (dir + (r() < 0.5 ? 1 : 7)) % 8;
    }
    const bundle = randInt(r, L.traceBundle);
    const lines = [];
    for (let k = 0; k < bundle; k++) lines.push(offsetPolyline(pts, (k - (bundle - 1) / 2) * L.traceSpacing));
    traces.push({ lines, glow: r() < L.traceGlowChance });
  }
  const brush = [];
  for (let i = 0; i < L.brushLines; i++) brush.push({ y: r(), w: 0.4 + r() * 1.4, a: r() * 2 - 1 });
  return { cells, seams, traces, brush };
}

/** Parallel polyline at distance d (mitred corners, so bundles stay parallel through 45° bends) */
function offsetPolyline(pts, d) {
  if (d === 0) return pts.map((p) => [p[0], p[1]]);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const inX = i > 0 ? p[0] - a[0] : b[0] - p[0], inY = i > 0 ? p[1] - a[1] : b[1] - p[1];
    const outX = i < pts.length - 1 ? b[0] - p[0] : inX, outY = i < pts.length - 1 ? b[1] - p[1] : inY;
    const li = Math.hypot(inX, inY) || 1, lo = Math.hypot(outX, outY) || 1;
    const nax = -inY / li, nay = inX / li, nbx = -outY / lo, nby = outX / lo;
    let mx = nax + nbx, my = nay + nby;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml; my /= ml;
    const k = d / Math.max(0.3, mx * nax + my * nay);
    out.push([p[0] + mx * k, p[1] + my * k]);
  }
  return out;
}

const layout = () => (layoutCache ??= buildLayout());

// --- painting -------------------------------------------------------------------------------------------------------

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Runs draw() at the 9 tile offsets, so shapes crossing the edge wrap (seamless tile) */
function wrapped(ctx, S, draw) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save();
      ctx.translate(ox * S, oy * S);
      draw();
      ctx.restore();
    }
  }
}

function diamondPath(ctx, S, cx, cy, half) {
  ctx.beginPath();
  ctx.moveTo((cx - half) * S, cy * S);
  ctx.lineTo(cx * S, (cy - half) * S);
  ctx.lineTo((cx + half) * S, cy * S);
  ctx.lineTo(cx * S, (cy + half) * S);
  ctx.closePath();
}

function polyPath(ctx, S, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * S, pts[0][1] * S);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * S, pts[i][1] * S);
}

/**
 * Paints the layout into ctx; style(feature, item) returns a CSS colour or null (feature skipped):
 * base, cell, inset, insetRing, seam, trace, pad.
 */
function paintLayout(ctx, S, k, style) {
  const lay = layout();
  const L = CFG.layout;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.fillStyle = style('base');
  ctx.fillRect(0, 0, S, S);
  wrapped(ctx, S, () => {
    for (const c of lay.cells) {
      const col = style('cell', c);
      if (col) { diamondPath(ctx, S, c.x, c.y, c.half); ctx.fillStyle = col; ctx.fill(); }
    }
    if (k.insets) {
      for (const c of lay.cells) {
        if (!c.inset) continue;
        diamondPath(ctx, S, c.x, c.y, c.half * L.insetScale);
        const fill = style('inset', c);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        const ring = style('insetRing', c);
        if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = CFG.seamWidth * 0.6 * S; ctx.stroke(); }
      }
    }
    const seam = k.seams ? style('seam') : null;
    if (seam) {
      ctx.strokeStyle = seam;
      ctx.lineWidth = CFG.seamWidth * S;
      ctx.beginPath();
      for (const e of lay.seams) { ctx.moveTo(e[0] * S, e[1] * S); ctx.lineTo(e[2] * S, e[3] * S); }
      ctx.stroke();
    }
    const trace = k.traces > 0 ? style('trace') : null;
    if (trace) {
      const n = Math.round(lay.traces.length * k.traces);
      ctx.strokeStyle = trace;
      ctx.lineWidth = CFG.traceWidth * S;
      for (let i = 0; i < n; i++) for (const line of lay.traces[i].lines) { polyPath(ctx, S, line); ctx.stroke(); }
      const pad = style('pad');
      if (pad) {
        ctx.strokeStyle = pad;
        for (let i = 0; i < n; i++) {
          for (const line of lay.traces[i].lines) {
            const p = line[line.length - 1];
            ctx.beginPath();
            ctx.arc(p[0] * S, p[1] * S, L.padRadius * S, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }
  });
}

/** Horizontal brushed streaks (full tile width, so they wrap); value(a) returns a CSS colour for streak strength a ∈ [-1, 1] */
function paintBrush(ctx, S, value) {
  for (const b of layout().brush) {
    ctx.fillStyle = value(b.a);
    ctx.fillRect(0, b.y * S, S, b.w);
  }
}

/** Tangent-space normal map from a height canvas (R channel, wrapped sampling); +V = canvas up (flipY texture) */
function heightToNormal(heightCanvas, S) {
  const src = heightCanvas.getContext('2d').getImageData(0, 0, S, S).data;
  const out = makeCanvas(S);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const st = CFG.normalStrength / 255 / 2;
  for (let y = 0; y < S; y++) {
    const yu = ((y - 1 + S) % S) * S, yd = ((y + 1) % S) * S, yr = y * S;
    for (let x = 0; x < S; x++) {
      const xl = (x - 1 + S) % S, xr = (x + 1) % S;
      const dx = (src[(yr + xr) * 4] - src[(yr + xl) * 4]) * st;
      const dy = (src[(yd + x) * 4] - src[(yu + x) * 4]) * st;
      const nx = -dx, ny = dy, inv = 1 / Math.hypot(nx, ny, 1);
      const o = (yr + x) * 4;
      d[o] = (nx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[o + 2] = (inv * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function toTexture(canvas, srgb = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = CFG.anisotropy;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function buildKind(kind) {
  const k = CFG.kindsSetup[kind];
  const S = k.size;
  const out = { map: null, rm: null, normal: null, emissive: null };
  if (k.maps !== false) {
    // colour detail (multiplies the material colour, incl. the team colour)
    const color = makeCanvas(S);
    const cc = color.getContext('2d');
    paintLayout(cc, S, k, (f, c) => {
      switch (f) {
        case 'base': return grey(k.color);
        case 'cell': return grey(k.color * (1 + c.tone * k.toneVar));
        case 'inset': return grey(k.insetColor * (1 + c.tone * k.toneVar * 0.5));
        case 'insetRing': case 'seam': return grey(k.seamColor);
        case 'trace': case 'pad': return grey(k.traceColor * k.color);
        default: return null;
      }
    });
    if (k.brush) paintBrush(cc, S, (a) => (a >= 0 ? `rgba(255,255,255,${a * k.brushColor})` : `rgba(0,0,0,${-a * k.brushColor})`));
    out.map = toTexture(color);

    // roughness (G) / metalness (B), absolute values (material factors set to 1)
    const rm = makeCanvas(S);
    const rc = rm.getContext('2d');
    paintLayout(rc, S, k, (f, c) => {
      switch (f) {
        case 'base': return rgb(0, k.roughness, k.metalness);
        case 'cell': case 'inset': return rgb(0, k.roughness + c.rough * k.roughVar, k.metalness);
        case 'insetRing': case 'seam': return rgb(0, k.seamRough, k.seamMetal);
        case 'trace': case 'pad': return rgb(0, k.traceRough, k.metalness);
        default: return null;
      }
    });
    if (k.brush) {
      rc.globalCompositeOperation = 'lighter';
      paintBrush(rc, S, (a) => rgb(0, Math.abs(a) * k.brushRough, 0));
      rc.globalCompositeOperation = 'source-over';
    }
    out.rm = toTexture(rm);

    if (k.normal !== false) {
      const H = CFG.height;
      const h = makeCanvas(S);
      paintLayout(h.getContext('2d'), S, k, (f) => {
        switch (f) {
          case 'base': return grey(H.base);
          case 'inset': return grey(H.inset);
          case 'insetRing': case 'seam': return grey(H.seam);
          case 'trace': return grey(H.trace);
          case 'pad': return grey(H.pad);
          default: return null;
        }
      });
      out.normal = toTexture(heightToNormal(h, S));
    }
  }
  if (k.emissive) out.emissive = toTexture(paintEmissive(k, S));
  return out;
}

function paintEmissive(k, S) {
  const e = k.emissive;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = grey(e.base ?? 0);
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (e.lines) {
    // photon cells: bright 45° laser lines over a lit base
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = e.lineWidth * S;
    wrapped(ctx, S, () => {
      ctx.beginPath();
      for (let i = 0; i < e.lines; i++) { const x = i / e.lines; ctx.moveTo(x * S, 0); ctx.lineTo((x + 1) * S, S); }
      ctx.stroke();
    });
    return c;
  }
  const lay = layout();
  const n = Math.round(lay.traces.length * k.traces);
  wrapped(ctx, S, () => {
    if (e.traces) {
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? 'rgba(255,255,255,0.22)' : '#ffffff';
        ctx.lineWidth = CFG.glowWidth * S * (pass === 0 ? 3 : 1);
        for (let i = 0; i < n; i++) {
          if (!lay.traces[i].glow) continue;
          for (const line of lay.traces[i].lines) { polyPath(ctx, S, line); ctx.stroke(); }
        }
      }
    }
    if (e.dots) {
      ctx.fillStyle = '#ffffff';
      for (const cell of lay.cells) {
        if (!cell.dot) continue;
        diamondPath(ctx, S, cell.x, cell.y, CFG.layout.glowDotSize);
        ctx.fill();
      }
    }
  });
  return c;
}

/** Shared textures of a kind (built on first use) */
function kindTextures(kind) {
  let t = texCache.get(kind);
  if (!t) { t = buildKind(kind); texCache.set(kind, t); }
  return t;
}

/** Adds the kind's textures to a source glTF material (once; per-robot copies made by clone() share them) */
function texturize(m) {
  if (preparedMats.has(m)) return;
  preparedMats.add(m);
  const kind = CFG.kinds[m.name];
  if (!kind || !m.isMeshStandardMaterial) return;
  const k = CFG.kindsSetup[kind];
  const t = kindTextures(kind);
  if (t.map) m.map = t.map;
  if (t.rm) { m.roughnessMap = t.rm; m.metalnessMap = t.rm; m.roughness = 1; m.metalness = 1; }
  if (t.normal) { m.normalMap = t.normal; m.normalScale.set(CFG.normalScale, CFG.normalScale); }
  if (t.emissive) {
    m.emissiveMap = t.emissive;
    if (k.emissive.color) m.emissive.set(k.emissive.color);
    if (k.emissive.intensity != null) m.emissiveIntensity = k.emissive.intensity;
  }
  m.needsUpdate = true;
}

/** Prepares a loaded skin glTF once: UVs on its geometries, shared textures on its materials. No-op when disabled. */
export function prepareSkinGltf(gltf) {
  if (!CFG.enabled) return;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    ensureSkinUv(o.geometry);
    if (Array.isArray(o.material)) o.material.forEach(texturize); else texturize(o.material);
    const share = !Array.isArray(o.material) && teamShare(o.material);
    if (share > 0) ensureTeamMask(o.geometry, share);
  });
}

// --- [round 2] team colour over whole facets ------------------------------------------------------------------------

/** Team share of a material by its kind (0 = never painted) */
function teamShare(m) {
  const T = CFG.team;
  if (!CFG.enabled || !T?.enabled || !m) return 0;
  return T.shares[CFG.kinds[m.name]] ?? 0;
}

/** FNV-1a of a string with the seed → [0, 1) */
function hashUnit(str) {
  let h = (0x811c9dc5 ^ CFG.seed) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * Per-vertex attribute `skinTeam` (0 / 1), once per geometry: flat facets (normal + plane, mirrored in x) taken in a
 * seeded order until share × area is painted. Undersides stay graphite. Indexed geometry gets no paint (all 0).
 */
function ensureTeamMask(geometry, share) {
  if (geometry.attributes.skinTeam) return;
  const T = CFG.team;
  const pos = geometry.attributes.position;
  const count = pos.count;
  const mask = new Float32Array(count);
  if (!geometry.index && count % 3 === 0) {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    const facets = new Map(); // key -> { key, area, nz, tris }
    let total = 0;
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      n.subVectors(c, b).cross(_e.subVectors(a, b));
      const len = n.length();
      if (len < 1e-9) continue;
      n.multiplyScalar(1 / len);
      if (n.y < T.downLimit) continue;
      const d = n.x * (a.x + b.x + c.x) / 3 + n.y * (a.y + b.y + c.y) / 3 + n.z * (a.z + b.z + c.z) / 3; // mirror-invariant
      const q = T.normalQuant;
      const key = `${Math.round(Math.abs(n.x) * q)},${Math.round(n.y * q)},${Math.round(n.z * q)},${Math.round(d * T.planeQuant)}`;
      let f = facets.get(key);
      if (!f) { f = { key, area: 0, nz: n.z, tris: [] }; facets.set(key, f); }
      f.area += len / 2;
      f.tris.push(i);
      total += len / 2;
    }
    const list = [...facets.values()];
    for (const f of list) f.prio = hashUnit(f.key) * (1 - T.frontBias) + T.frontBias * (0.5 - 0.5 * f.nz);
    list.sort((p, r) => p.prio - r.prio || (p.key < r.key ? -1 : 1));
    let acc = 0;
    for (const f of list) {
      if (acc >= share * total) break;
      acc += f.area;
      for (const i of f.tris) mask[i] = mask[i + 1] = mask[i + 2] = 1;
    }
  }
  geometry.setAttribute('skinTeam', new THREE.BufferAttribute(mask, 1));
}
const _e = new THREE.Vector3();

const TEAM_VERT = 'attribute float skinTeam;\nvarying float vSkinTeam;\n';
const TEAM_FRAG = 'uniform vec3 skinTeamColor;\nuniform float skinTeamOn;\nuniform float skinTeamRough;\nuniform float skinTeamMetal;\nvarying float vSkinTeam;\n';
const TEAM_MAP = `
float skinTm = vSkinTeam * skinTeamOn;
#ifdef USE_MAP
  vec3 skinDetail = texture2D( map, vMapUv ).rgb;
#else
  vec3 skinDetail = vec3( 1.0 );
#endif
diffuseColor.rgb = mix( diffuseColor.rgb, skinTeamColor * skinDetail, skinTm );
`;
function teamCompile(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${TEAM_VERT}`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinTeam = skinTeam;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${TEAM_FRAG}`)
    .replace('#include <map_fragment>', `#include <map_fragment>\n${TEAM_MAP}`)
    .replace('#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, clamp( roughnessFactor + skinTeamRough, 0.0, 1.0 ), skinTm );')
    .replace('#include <metalnessmap_fragment>',
      '#include <metalnessmap_fragment>\nmetalnessFactor = mix( metalnessFactor, metalnessFactor * skinTeamMetal, skinTm );');
}

/**
 * Adds the team paint shader to a per-robot material copy (once, when the copy is made). Returns its uniforms (pass them
 * to setTeamPaint) or null when the material is never painted. Every copy shares one program.
 */
export function attachTeamPaint(material) {
  if (!(teamShare(material) > 0)) return null;
  const T = CFG.team;
  const uniforms = {
    skinTeamColor: { value: new THREE.Color() },
    skinTeamOn: { value: 0 },
    skinTeamRough: { value: T.roughAdd },
    skinTeamMetal: { value: T.metalScale },
  };
  material.onBeforeCompile = (shader) => teamCompile(shader, uniforms);
  material.customProgramCacheKey = () => 'glbSkinTeam';
  material.needsUpdate = true;
  return uniforms;
}

/** Team colour of the paint (null = off); luminance clamped to minLum..maxLum, darkened with the hulk. No allocation. */
export function setTeamPaint(uniforms, teamColor, darkness) {
  if (teamColor == null) { uniforms.skinTeamOn.value = 0; return; }
  const T = CFG.team;
  const c = uniforms.skinTeamColor.value.set(teamColor);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (lum < T.minLum) c.lerp(_white, (T.minLum - lum) / (1 - lum));
  else if (lum > T.maxLum) c.multiplyScalar(T.maxLum / lum);
  c.multiplyScalar(T.paint * (1 - darkness));
  uniforms.skinTeamOn.value = 1;
}
const _white = new THREE.Color(1, 1, 1);

// --- emblem ---------------------------------------------------------------------------------------------------------

/** Mercury logo: sun disc with a double vertical slit and a ring, rays with 45° bends (orange → gold gradient) */
function paintEmblem(withPlate, logo) {
  const E = CFG.emblem;
  const S = E.texSize;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const P = E.plate;
  if (withPlate && P) {
    // [round 2] dark graphite rhombus with a light outer and a dark inner rim under the logo
    diamondPath(ctx, S, 0.5, 0.5, P.half);
    ctx.fillStyle = P.color;
    ctx.fill();
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = P.rim;
    ctx.lineWidth = P.rimWidth * S;
    ctx.stroke();
    diamondPath(ctx, S, 0.5, 0.5, P.half - P.rimWidth - P.innerRimWidth * 0.5);
    ctx.strokeStyle = P.innerRim;
    ctx.lineWidth = P.innerRimWidth * S;
    ctx.stroke();
  } else if (!withPlate) {
    ctx.fillStyle = '#000000'; // emissive map: only the logo glows
    ctx.fillRect(0, 0, S, S);
  }
  // the logo is its own transparent canvas (its slits are cut there, so the plate shows through them)
  const w = S * (E.logoScale ?? 1);
  ctx.drawImage(logo, (S - w) / 2, (S - w) / 2, w, w);
  return c;
}

function paintLogo() {
  const E = CFG.emblem;
  const S = E.texSize;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const m = S / 2;
  const grad = ctx.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, '#e8521a');
  grad.addColorStop(0.5, '#f7861f');
  grad.addColorStop(1, '#ffbf3c');
  ctx.fillStyle = grad;
  ctx.strokeStyle = grad;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.arc(m, m, S * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(m - S * 0.026, m - S * 0.16, S * 0.012, S * 0.32);
  ctx.fillRect(m - S * 0.006, m - S * 0.16, S * 0.012, S * 0.32);
  ctx.lineWidth = S * 0.01;
  ctx.beginPath();
  ctx.arc(m, m, S * 0.07, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';

  const r = makeRng(CFG.seed + 1);
  ctx.lineWidth = S * 0.014;
  for (let i = 0; i < E.rays; i++) {
    const th = ((i + 0.5) / E.rays) * Math.PI * 2;
    const cx = Math.cos(th), cy = Math.sin(th);
    let x = m + cx * S * 0.2, y = m + cy * S * 0.2;
    const pts = [[x, y]];
    const l1 = S * lerp(0.03, 0.07, r());
    x += cx * l1; y += cy * l1; pts.push([x, y]);
    // snap to the nearest 45° direction (neighbouring rays run parallel, like the logo bundles)
    let dir = ((Math.round(th / (Math.PI / 4)) % 8) + 8) % 8;
    const l2 = S * lerp(0.04, 0.1, r());
    x += DIRS[dir][0] * l2; y += DIRS[dir][1] * l2; pts.push([x, y]);
    // then a bend toward the axis / diagonal on the ray's side
    const side = Math.sin(th - dir * Math.PI / 4) >= 0 ? 1 : 7;
    dir = (dir + side) % 8;
    const l3 = S * lerp(0.0, 0.07, r()) * (i % 3 === 0 ? 0.3 : 1);
    if (l3 > S * 0.005) { x += DIRS[dir][0] * l3; y += DIRS[dir][1] * l3; pts.push([x, y]); }
    polyPath(ctx, 1, pts);
    ctx.stroke();
  }
  return c;
}

function emblem() {
  if (!emblemShared) {
    const E = CFG.emblem;
    const logo = paintLogo();
    const texture = toTexture(paintEmblem(true, logo), true);
    const glow = toTexture(paintEmblem(false, logo), true);
    texture.wrapS = texture.wrapT = glow.wrapS = glow.wrapT = THREE.ClampToEdgeWrapping;
    const material = new THREE.MeshStandardMaterial({
      map: texture, emissiveMap: glow, emissive: new THREE.Color(E.color), emissiveIntensity: E.intensity,
      transparent: true, depthWrite: false, metalness: 0.2, roughness: 0.3,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    emblemShared = { texture, glow, material, geometry: new THREE.PlaneGeometry(1, 1) };
  }
  return emblemShared;
}

/**
 * Emblem placement on a slot's skin meshes: a ray along -z (from the front) at CFG.emblem.center hits the nearest front
 * face. meshes = [{ mesh, matrix }] (matrix = mesh in part space). Returns { index, matrix } (matrix in that mesh's
 * parent space, i.e. next to the mesh) or null. Runs once per model (cache it); allocations are fine here.
 */
export function findEmblemPlacement(slot, meshes) {
  const E = CFG.emblem;
  if (!CFG.enabled || !E.enabled || slot !== E.slot) return null;
  const ray = new THREE.Raycaster(new THREE.Vector3(E.center[0], E.center[1], 1e4), new THREE.Vector3(0, 0, -1));
  const probe = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial());
  const hits = [];
  let best = null;
  for (let i = 0; i < meshes.length; i++) {
    probe.geometry = meshes[i].mesh.geometry;
    probe.matrixWorld.copy(meshes[i].matrix);
    hits.length = 0;
    probe.raycast(ray, hits);
    for (const h of hits) if (h.face && (!best || h.distance < best.hit.distance)) best = { hit: h, index: i };
  }
  probe.material.dispose();
  if (!best) return null;
  const n = best.hit.face.normal.clone().transformDirection(meshes[best.index].matrix);
  const p = best.hit.point.clone().addScaledVector(n, E.lift);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  return { index: best.index, matrix: new THREE.Matrix4().compose(p, q, new THREE.Vector3(E.size, E.size, E.size)) };
}

/** New emblem mesh (shared geometry / material, nothing to dispose per robot) at a placement matrix */
export function createEmblemMesh(matrix) {
  const e = emblem();
  const mesh = new THREE.Mesh(e.geometry, e.material);
  mesh.name = 'skinEmblem';
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  mesh.raycast = () => {};
  return mesh;
}

/** Frees every shared texture (game teardown; robots never call it) */
export function disposeSkinTextures() {
  for (const t of texCache.values()) for (const tex of Object.values(t)) tex?.dispose();
  texCache.clear();
  if (emblemShared) {
    emblemShared.texture.dispose();
    emblemShared.glow.dispose();
    emblemShared.material.dispose();
    emblemShared.geometry.dispose();
    emblemShared = null;
  }
}
