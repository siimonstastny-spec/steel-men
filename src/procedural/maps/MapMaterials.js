// Procedural map materials for the A8 map restyle (docs/notes/b5-map-fx.md). Visual only – no simulation state.
//   • dark stone walls: tileable canvas textures (colour, normal, roughness), MeshStandardMaterial, optional triplanar
//   • lava in fissures: small unlit ShaderMaterial (animated flow / pulse by a time uniform) + soft glowing rim
// Everything is cached per MapFx instance and shared; dispose() frees textures, materials and the cached geometries' owners
// are the caller (geometry factories return fresh geometries). Own seeded PRNG: same look every run, no Math.random.
import * as THREE from 'three';
import { PROC_MAP_FX as C } from '../../config.js';

// ---------- seeded helpers ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** periodic value noise grids (one per octave) so the texture tiles */
function makeNoise(rng, periods) {
  const grids = periods.map(p => { const g = new Float32Array(p * p); for (let i = 0; i < g.length; i++) g[i] = rng(); return { p, g }; });
  return (u, v) => { // u, v in [0,1) tile space
    let sum = 0, amp = 1, norm = 0;
    for (const { p, g } of grids) {
      const x = u * p, y = v * p;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const xa = ((x0 % p) + p) % p, xb = (xa + 1) % p, ya = ((y0 % p) + p) % p, yb = (ya + 1) % p;
      const a = g[ya * p + xa], b = g[ya * p + xb], c = g[yb * p + xa], d = g[yb * p + xb];
      sum += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      norm += amp; amp *= 0.5;
    }
    return sum / norm;
  };
}

// ---------- stone textures ----------
/** @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}} */
function buildStoneTextures(S) {
  const N = S.textureSize;
  const rng = mulberry32(S.seed);
  const noise = makeNoise(rng, S.noisePeriods);
  const rows = S.blockRows, ch = N / rows;
  // courses: block boundaries in px, random sizes, each course shifted
  const courses = [];
  for (let r = 0; r < rows; r++) {
    const n = S.blocksPerRow[0] + Math.floor(rng() * (S.blocksPerRow[1] - S.blocksPerRow[0] + 1));
    const w = []; let sum = 0;
    for (let i = 0; i < n; i++) { const x = S.blockWidthJitter[0] + rng() * (S.blockWidthJitter[1] - S.blockWidthJitter[0]); w.push(x); sum += x; }
    let x = rng() * N; const bounds = [];
    for (let i = 0; i < n; i++) { bounds.push({ x0: x, w: w[i] / sum * N, shade: rng(), tint: rng() }); x += w[i] / sum * N; }
    courses.push(bounds);
  }
  const cDark = new THREE.Color(S.colorDark), cLight = new THREE.Color(S.colorLight), cTint = new THREE.Color(S.colorTint);
  const mortarPx = S.mortarWidth * ch, bevelPx = Math.max(1, S.bevel * ch);
  const height = new Float32Array(N * N);
  const colour = new Float32Array(N * N * 3);
  const rough = new Float32Array(N * N);
  const col = new THREE.Color();
  for (let y = 0; y < N; y++) {
    const r = Math.min(rows - 1, Math.floor(y / ch));
    const fy = y - r * ch;
    const dY = Math.min(fy, ch - fy);
    const bounds = courses[r];
    for (let x = 0; x < N; x++) {
      // find block of this course (wrap the strip)
      let blk = bounds[bounds.length - 1], lx = 0;
      for (let i = 0; i < bounds.length; i++) {
        const b = bounds[i];
        let d = x - b.x0; d = ((d % N) + N) % N;
        if (d < b.w) { blk = b; lx = d; break; }
      }
      const dX = Math.min(lx, blk.w - lx);
      const d = Math.min(dX, dY);
      const u = x / N, v = y / N;
      const fine = noise(u, v), cracks = noise((u + 0.37) % 1, (v + 0.71) % 1);
      let h = smooth(mortarPx, mortarPx + bevelPx, d);
      h = h * (1 - S.noiseAmount * 0.5) + (fine - 0.5) * S.noiseAmount + 0.5 * S.noiseAmount * 0.5;
      // thin dark crack lines where the second noise crosses 0.5
      const crack = 1 - smooth(0.0, S.crackWidth, Math.abs(cracks - 0.5));
      h -= crack * S.crackDepth;
      const i = y * N + x;
      height[i] = h;
      col.copy(cDark).lerp(cLight, blk.shade * S.colorMix.shade + fine * S.colorMix.fine).lerp(cTint, blk.tint * S.colorMix.tint);
      const dim = h < S.mortarHeight ? S.mortarDim : 1 - crack * S.crackDim;     // mortar and cracks darker
      colour[i * 3] = col.r * dim; colour[i * 3 + 1] = col.g * dim; colour[i * 3 + 2] = col.b * dim;
      rough[i] = S.roughness[0] + (S.roughness[1] - S.roughness[0]) * Math.min(1, (1 - h) * S.roughFromHeight + fine * (1 - S.roughFromHeight));
    }
  }
  const mk = (data, srgb) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = N;
    const ctx = canvas.getContext('2d'); const img = ctx.createImageData(N, N);
    data(img.data); ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = S.anisotropy;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  };
  const map = mk(px => {
    const lin = new THREE.Color();
    for (let i = 0; i < N * N; i++) {
      lin.setRGB(colour[i * 3], colour[i * 3 + 1], colour[i * 3 + 2], THREE.LinearSRGBColorSpace);
      lin.getRGB(lin, THREE.SRGBColorSpace);
      px[i * 4] = Math.round(lin.r * 255); px[i * 4 + 1] = Math.round(lin.g * 255); px[i * 4 + 2] = Math.round(lin.b * 255); px[i * 4 + 3] = 255;
    }
  }, true);
  const normalMap = mk(px => {
    const k = S.normalStrength;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const hx = height[y * N + (x + 1) % N] - height[y * N + (x + N - 1) % N];
      const hy = height[((y + 1) % N) * N + x] - height[((y + N - 1) % N) * N + x];
      let nx = -hx * k, ny = hy * k, nz = 1; // image y points down, uv v up → +hy
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * N + x) * 4;
      px[i] = Math.round((nx * 0.5 + 0.5) * 255); px[i + 1] = Math.round((ny * 0.5 + 0.5) * 255); px[i + 2] = Math.round((nz * 0.5 + 0.5) * 255); px[i + 3] = 255;
    }
  }, false);
  const roughnessMap = mk(px => {
    for (let i = 0; i < N * N; i++) { const g = Math.round(rough[i] * 255); px[i * 4] = g; px[i * 4 + 1] = g; px[i * 4 + 2] = g; px[i * 4 + 3] = 255; }
  }, false);
  return { map, normalMap, roughnessMap };
}

// ---------- lava / rim shaders ----------
const LAVA_VERT = /* glsl */`
varying vec2 vXZ;
varying vec2 vUv;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXZ = wp.xz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const NOISE_GLSL = /* glsl */`
float mfHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mfNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mfHash(i), mfHash(i + vec2(1.0, 0.0)), f.x), mix(mfHash(i + vec2(0.0, 1.0)), mfHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

const gf = (x) => Number(x).toFixed(4); // number → GLSL float literal
const lavaFrag = (L) => /* glsl */`
uniform float uTime, uScale, uWarp, uCrustLow, uCrustHigh, uPulse, uPulseSpeed, uIntensity, uEdgeCrust, uSeed;
uniform vec2 uFlow;
uniform vec3 uHot, uMid, uCrust;
varying vec2 vXZ;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
${NOISE_GLSL}
void main() {
  vec2 p = vXZ * uScale + vec2(uSeed, uSeed * 0.37);
  vec2 drift = uFlow * uTime;
  // two layers drifting in opposite directions, the first warps the second (cheap flowing look)
  float a = mfNoise(p + drift) * ${gf(L.layerMix[0])} + mfNoise(p * ${gf(L.layerScale.a2)} - drift * ${gf(L.driftScale.a2)}) * ${gf(L.layerMix[1])};
  float b = mfNoise(p * ${gf(L.layerScale.b1)} - drift + uWarp * (a - 0.5) * 2.0) * ${gf(L.warpMix[0])} + mfNoise(p * ${gf(L.layerScale.b2)} + drift * ${gf(L.driftScale.b2)} + a) * ${gf(L.warpMix[1])};
  float edge = abs(vUv.y * 2.0 - 1.0);
  float v = b + uEdgeCrust * edge * edge;
  float crust = smoothstep(uCrustLow, uCrustHigh, v);
  float heat = 1.0 - crust;
  float pulse = 1.0 + uPulse * sin(uTime * uPulseSpeed + a * 6.2831);
  vec3 lava = mix(uMid, uHot, smoothstep(${gf(L.heatRange[0])}, ${gf(L.heatRange[1])}, heat) * pulse);
  vec3 c = mix(lava * uIntensity * pulse, uCrust, crust * crust);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const rimFrag = (R) => /* glsl */`
uniform float uTime, uIntensity, uFalloff, uPulse, uPulseSpeed;
uniform vec3 uColor;
varying vec2 vXZ;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() {
  float e = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = pow(clamp(e, 0.0, 1.0), uFalloff);
  a *= 1.0 + uPulse * sin(uTime * uPulseSpeed + (vXZ.x + vXZ.y) * ${gf(R.waveScale)});
  gl_FragColor = vec4(uColor * uIntensity * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ---------- geometry factories (build-time allocation only) ----------
const _hashPos = (x, y, z, seed) => { // deterministic 0..1 from a position (equal vertices of different faces get the same value)
  let h = Math.imul(Math.round(x * 64) | 0, 73856093) ^ Math.imul(Math.round(y * 64) | 0, 19349663) ^ Math.imul(Math.round(z * 64) | 0, 83492791) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

/**
 * Wall / block: box with feet on y = 0, centred on x/z, long axis x. UVs in world units / tileWorld (no stretching on any
 * length). The top edge is slightly uneven (seeded by vertex position, so faces stay closed).
 * @param {{length?:number, height?:number, thickness?:number, seed?:number, jag?:number, tileWorld?:number}} o
 */
export function createWallGeometry(o = {}) {
  const S = C.stone;
  const height = o.height ?? C.mechHeight * C.wallHeightFactor;
  const length = o.length ?? 20, thickness = o.thickness ?? 3;
  const tile = o.tileWorld ?? S.tileWorld, seed = o.seed ?? S.seed;
  const jag = (o.jag ?? S.jag) * height;
  const segL = Math.max(1, Math.round(length / S.wallSegmentLength)), segT = Math.max(1, Math.round(thickness / S.wallSegmentLength));
  const g = new THREE.BoxGeometry(length, height, thickness, segL, Math.max(1, Math.round(height / S.wallSegmentLength)), segT);
  g.translate(0, height / 2, 0);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y > height - 1e-4) y -= jag * _hashPos(x, 0, z, seed);   // uneven top (same for every face sharing the vertex)
    pos.setY(i, y);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i));
    if (ay > 0.5) uv.setXY(i, x / tile, z / tile);
    else if (ax > 0.5) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  pos.needsUpdate = true; uv.needsUpdate = true;
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
export const createBlockGeometry = (o = {}) => createWallGeometry({ length: o.width ?? 6, thickness: o.depth ?? 6, ...o });

/**
 * Flat ribbon along a polyline (x, z; y = ribbon.lift) for a fissure bottom or the rim. uv.x = distance / width, uv.y 0…1 across.
 * @param {Array<{x:number,z:number}|number[]>} points  @param {number|number[]} width constant or one per point
 */
export function createLavaRibbonGeometry(points, width = 4, y = C.ribbon.lift) {
  const n = points.length;
  const px = points.map(p => (Array.isArray(p) ? p[0] : p.x)), pz = points.map(p => (Array.isArray(p) ? p[1] : p.z));
  const positions = new Float32Array(n * 2 * 3), uvs = new Float32Array(n * 2 * 2);
  const index = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let tx = px[i1] - px[i0], tz = pz[i1] - pz[i0]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    if (i > 0) dist += Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
    const w = (Array.isArray(width) ? width[i] : width) / 2;
    const nx = -tz, nz = tx;
    positions.set([px[i] + nx * w, y, pz[i] + nz * w, px[i] - nx * w, y, pz[i] - nz * w], i * 6);
    const u = dist / (Array.isArray(width) ? width[i] : width);
    uvs.set([u, 0, u, 1], i * 4);
    if (i < n - 1) { const a = i * 2; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } // normal +Y (visible from above)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** Flat lava pool filling a polygon (x, z points), facing up at y = ribbon.lift. */
export function createLavaPatchGeometry(points, y = C.ribbon.lift) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(Array.isArray(p) ? p[0] : p.x, -(Array.isArray(p) ? p[1] : p.z))));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), 0.5); // no ribbon edge: uv.y = 0.5 → edge crust 0, rim full
  uv.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

// ---------- MapFx: cache of textures / materials + shared time ----------
export class MapFx {
  constructor() {
    this.time = { value: 0 };           // shared uniform object of every lava / rim material
    this._tex = null;
    this._stone = new Map();
    this._lava = null;
    this._rim = null;
    this._t = 0;
  }

  /** Seconds since start (visual time). No allocation. */
  setTime(t) { this._t = t % C.lava.timeWrap; this.time.value = this._t; }
  update(dt) { this.setTime(this._t + dt); }

  get wallHeight() { return C.mechHeight * C.wallHeightFactor; }

  _textures() { return this._tex || (this._tex = buildStoneTextures(C.stone)); }

  /**
   * Shared dark stone material. Use createWallGeometry (UVs in world units) with triplanar = false, or any mesh with
   * triplanar = true (world-space projection, colour + roughness only – no normal map).
   * @param {{triplanar?:boolean, tileWorld?:number}} o
   */
  getStoneMaterial(o = {}) {
    const key = `${o.triplanar ? 't' : 'u'}${o.tileWorld ?? ''}`;
    let m = this._stone.get(key);
    if (m) return m;
    const S = C.stone, tx = this._textures(), tile = o.tileWorld ?? S.tileWorld;
    m = new THREE.MeshStandardMaterial({ map: tx.map, roughnessMap: tx.roughnessMap, roughness: 1, metalness: S.metalness });
    if (!o.triplanar) {
      m.normalMap = tx.normalMap;
      m.normalScale.set(1, 1);
    } else {
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nconst float MF_TILE = ${(1 / tile).toFixed(6)};`)
          .replace('#include <map_fragment>', `
            vec3 mfW = pow(abs(normalize(vWNrm)), vec3(4.0)); mfW /= (mfW.x + mfW.y + mfW.z);
            vec2 mfUx = vWPos.zy * MF_TILE, mfUy = vWPos.xz * MF_TILE, mfUz = vWPos.xy * MF_TILE;
            diffuseColor *= texture2D(map, mfUx) * mfW.x + texture2D(map, mfUy) * mfW.y + texture2D(map, mfUz) * mfW.z;`)
          .replace('#include <roughnessmap_fragment>', `
            float roughnessFactor = roughness;
            roughnessFactor *= texture2D(roughnessMap, mfUx).g * mfW.x + texture2D(roughnessMap, mfUy).g * mfW.y + texture2D(roughnessMap, mfUz).g * mfW.z;`);
      };
      m.customProgramCacheKey = () => `mapfx-tri-${tile}`;
    }
    this._stone.set(key, m);
    return m;
  }

  /** Shared lava material (unlit, emissive look, animated by the time uniform). edgeCrust only matters on ribbon UVs. */
  getLavaMaterial() {
    if (this._lava) return this._lava;
    const L = C.lava;
    this._lava = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: this.time, uScale: { value: L.noiseScale }, uWarp: { value: L.warp },
        uCrustLow: { value: L.crustLow }, uCrustHigh: { value: L.crustHigh },
        uPulse: { value: L.pulseAmount }, uPulseSpeed: { value: L.pulseSpeed }, uIntensity: { value: L.intensity },
        uEdgeCrust: { value: L.edgeCrust }, uSeed: { value: (L.seed % L.seedMod) * L.seedScale },
        uFlow: { value: new THREE.Vector2(L.flowSpeed[0], L.flowSpeed[1]) },
        uHot: { value: new THREE.Color(L.colorHot) }, uMid: { value: new THREE.Color(L.colorMid) },
        uCrust: { value: new THREE.Color(L.colorCrust) },
      }]),
      vertexShader: LAVA_VERT, fragmentShader: lavaFrag(L), fog: true,
    });
    this._lava.uniforms.uTime = this.time; // merge clones values: re-share the single time object
    return this._lava;
  }

  /** Shared additive glow along the fissure edge (ribbon UVs, uv.y 0…1 across). Render after the lava (renderOrder). */
  getRimMaterial() {
    if (this._rim) return this._rim;
    const R = C.rim;
    this._rim = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: this.time, uIntensity: { value: R.intensity }, uFalloff: { value: R.falloff },
        uPulse: { value: R.pulseAmount }, uPulseSpeed: { value: R.pulseSpeed }, uColor: { value: new THREE.Color(R.color) },
      }]),
      vertexShader: LAVA_VERT, fragmentShader: rimFrag(R), fog: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: R.polygonOffset, polygonOffsetUnits: R.polygonOffset,
    });
    this._rim.uniforms.uTime = this.time;
    return this._rim;
  }

  /** Frees textures and materials (geometries made by the factories belong to the caller). */
  dispose() {
    for (const m of this._stone.values()) m.dispose();
    this._stone.clear();
    if (this._tex) { this._tex.map.dispose(); this._tex.normalMap.dispose(); this._tex.roughnessMap.dispose(); this._tex = null; }
    if (this._lava) { this._lava.dispose(); this._lava = null; }
    if (this._rim) { this._rim.dispose(); this._rim = null; }
  }
}
