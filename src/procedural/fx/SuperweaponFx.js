// Steel Men – superweapon effects (orbitalBomb, tectonicTorpedo, phaseCharge, neutronBomb).
// Visual only: own seeded generator (never world.rng / Math.random / time), nothing the simulation reads.
// Everything is batched: 3 particle InstancedMeshes (glow / smoke / debris) + 4 shape InstancedMeshes
// (cylinder, sphere, dome, ring) shared by all running effects = 7 draw calls max, no extra lights.
// Ground height = `at.y` / `to.y` (the caller passes points already on the terrain).
import * as THREE from 'three';
import { PROC_SUPERWEAPON_FX as CFG } from '../../config.js';

const KINDS = ['orbitalBomb', 'tectonicTorpedo', 'phaseCharge', 'neutronBomb'];
const SHAPE_MAX = 96;
const TAU = Math.PI * 2;
const DEFAULT_COLORS = 'default';
const EPS_DIR = 0.012;       // finite-difference step (flight ratio) for the neutron missile heading

const _col = new THREE.Color();
const _pos = new Float32Array(3);   // scratch for posAt()
const _pos2 = new Float32Array(3);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const easeIn = (k) => k * k;
const lerp = (a, b, k) => a + (b - a) * k;

// ---------- batched particles ----------

class ParticlePool {
  constructor(scene, geo, material, max, mode) {
    this.mode = mode; // 0 glow, 1 smoke, 2 debris
    this.max = max;
    this.n = 0;
    this.scene = scene;
    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _col.set(0xffffff));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.raycast = () => {};
    this.mesh.renderOrder = CFG.renderOrder;
    scene.add(this.mesh);
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'r', 'g', 'b', 'grav', 'drag', 'gy']) this[k] = new Float32Array(max);
  }

  add(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, grav, drag, gy) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.r[i] = r; this.g[i] = g; this.b[i] = b;
    this.grav[i] = grav; this.drag[i] = drag; this.gy[i] = gy;
  }

  #move(d, s) {
    this.x[d] = this.x[s]; this.y[d] = this.y[s]; this.z[d] = this.z[s];
    this.vx[d] = this.vx[s]; this.vy[d] = this.vy[s]; this.vz[d] = this.vz[s];
    this.age[d] = this.age[s]; this.life[d] = this.life[s]; this.s0[d] = this.s0[s]; this.s1[d] = this.s1[s];
    this.r[d] = this.r[s]; this.g[d] = this.g[s]; this.b[d] = this.b[s];
    this.grav[d] = this.grav[s]; this.drag[d] = this.drag[s]; this.gy[d] = this.gy[s];
  }

  clear() { this.n = 0; this.mesh.count = 0; }

  update(dt) {
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.#move(i, --this.n); continue; }
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= damp; this.vz[i] *= damp; this.vy[i] = this.vy[i] * damp - this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      if (this.mode === 2 && this.y[i] <= this.gy[i]) { this.y[i] = this.gy[i]; this.vy[i] = 0; this.vx[i] *= 0.9; this.vz[i] *= 0.9; }
    }
    const mat = this.mesh.instanceMatrix.array;
    const col = this.mesh.instanceColor.array;
    for (let i = 0; i < this.n; i++) {
      const k = this.age[i] / this.life[i];
      let s = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      let c = 1;
      if (this.mode === 0) c = (1 - k) ** CFG.glowFadePower;
      else if (k > CFG.smokeFadeStart) s *= 1 - (k - CFG.smokeFadeStart) / (1 - CFG.smokeFadeStart);
      const o = i * 16;
      mat[o] = s; mat[o + 1] = 0; mat[o + 2] = 0; mat[o + 3] = 0;
      mat[o + 4] = 0; mat[o + 5] = s; mat[o + 6] = 0; mat[o + 7] = 0;
      mat[o + 8] = 0; mat[o + 9] = 0; mat[o + 10] = s; mat[o + 11] = 0;
      mat[o + 12] = this.x[i]; mat[o + 13] = this.y[i]; mat[o + 14] = this.z[i]; mat[o + 15] = 1;
      const q = i * 3;
      col[q] = this.r[i] * c; col[q + 1] = this.g[i] * c; col[q + 2] = this.b[i] * c;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.material.dispose();
  }
}

// ---------- batched shapes (rewritten every frame from the running effects) ----------

class ShapeBatch {
  constructor(scene, geo, material) {
    this.scene = scene;
    this.geo = geo;
    this.n = 0;
    this.mesh = new THREE.InstancedMesh(geo, material, SHAPE_MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _col.set(0xffffff));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.raycast = () => {};
    this.mesh.renderOrder = CFG.renderOrder + 1;
    scene.add(this.mesh);
  }

  begin() { this.n = 0; }

  /** Axis aligned: scale (sx, sy, sz), colour (r, g, b) already multiplied by brightness */
  add(x, y, z, sx, sy, sz, r, g, b) {
    if (this.n >= SHAPE_MAX || sx <= 0 || sz <= 0) return;
    const o = this.n * 16;
    const m = this.mesh.instanceMatrix.array;
    m[o] = sx; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    const c = this.mesh.instanceColor.array;
    c[this.n * 3] = r; c[this.n * 3 + 1] = g; c[this.n * 3 + 2] = b;
    this.n++;
  }

  /** Y axis along the unit direction (dx, dy, dz): radius rad, length len */
  addDir(x, y, z, dx, dy, dz, rad, len, r, g, b) {
    if (this.n >= SHAPE_MAX || rad <= 0) return;
    // x = normalize(helper x d), z = d x x
    let hx = 0, hy = 1, hz = 0;
    if (Math.abs(dy) > 0.99) { hx = 1; hy = 0; }
    let ax = hy * dz - hz * dy, ay = hz * dx - hx * dz, az = hx * dy - hy * dx;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    const bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
    const o = this.n * 16;
    const m = this.mesh.instanceMatrix.array;
    m[o] = ax * rad; m[o + 1] = ay * rad; m[o + 2] = az * rad; m[o + 3] = 0;
    m[o + 4] = dx * len; m[o + 5] = dy * len; m[o + 6] = dz * len; m[o + 7] = 0;
    m[o + 8] = bx * rad; m[o + 9] = by * rad; m[o + 10] = bz * rad; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    const c = this.mesh.instanceColor.array;
    c[this.n * 3] = r; c[this.n * 3 + 1] = g; c[this.n * 3 + 2] = b;
    this.n++;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.material.dispose();
    this.geo.dispose();
  }
}

// Additive shell with a fresnel rim: bright edge, faded centre (gives domes volume). Per-instance colour = brightness.
function rimMaterial() {
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uCenter: { value: CFG.rim.centerLevel }, uPower: { value: CFG.rim.power } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vC;
      void main() {
        mat4 m = modelViewMatrix * instanceMatrix;
        vec4 mv = m * vec4(position, 1.0);
        vN = normalize(transpose(inverse(mat3(m))) * normal);
        vV = mv.xyz;
        #ifdef USE_INSTANCING_COLOR
          vC = instanceColor;
        #else
          vC = vec3(1.0);
        #endif
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uCenter; uniform float uPower;
      varying vec3 vN; varying vec3 vV; varying vec3 vC;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vV))), uPower);
        gl_FragColor = vec4(vC * mix(uCenter, 1.0, f), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  m.forceSinglePass = true;
  return m;
}

// ---------- palettes (data from config, converted once per race) ----------

function rgb(hex) { _col.set(hex); return new Float32Array([_col.r, _col.g, _col.b]); }

function makePalette(src) {
  const p = {};
  for (const k of Object.keys(src)) p[k] = rgb(src[k]);
  return p;
}

// ---------- effect slots ----------

function makeSlot() {
  return {
    active: false, mode: 0, kind: 0, t: 0, dur: 0, flight: 1, autoImpact: false, stage: 0, acc: 0,
    fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, dx: 0, dz: 0, dist: 0, radius: 30, s: 1, pal: null, raceKey: DEFAULT_COLORS,
  };
}

export class SuperweaponFx {
  constructor(scene) {
    this.scene = scene;
    this.headless = false;
    this.slots = [];
    for (let i = 0; i < CFG.maxEffects; i++) this.slots.push(makeSlot());
    this.palettes = new Map();
    this.phasePal = makePalette(CFG.phaseColors);
    this.neutronPal = makePalette(CFG.neutronColors);

    const seg = CFG.segments;
    // forceSinglePass: a transparent DoubleSide material would otherwise cost two draw calls (back + front)
    const glowMat = (side) => {
      const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side });
      m.forceSinglePass = true;
      return m;
    };
    this.partGeos = CFG.sphereDetail.map((d) => new THREE.IcosahedronGeometry(1, d));
    const smokeMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: CFG.smokeOpacity, depthWrite: false, fog: false });
    this.pools = [
      new ParticlePool(scene, this.partGeos[0], glowMat(THREE.FrontSide), CFG.pools.glow, 0),
      new ParticlePool(scene, this.partGeos[1], smokeMat, CFG.pools.smoke, 1),
      new ParticlePool(scene, this.partGeos[2], new THREE.MeshBasicMaterial({ transparent: CFG.debrisOpacity < 1, opacity: CFG.debrisOpacity, fog: false }), CFG.pools.debris, 2),
    ];
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, seg, 1, true);
    cylGeo.translate(0, 0.5, 0);
    const ringGeo = new THREE.RingGeometry(0.86, 1, seg * 2);
    ringGeo.rotateX(-Math.PI / 2);
    this.cyl = new ShapeBatch(scene, cylGeo, glowMat(THREE.DoubleSide));
    this.sph = new ShapeBatch(scene, new THREE.SphereGeometry(1, seg, CFG.sphereRows), glowMat(THREE.FrontSide));
    this.dome = new ShapeBatch(scene, new THREE.SphereGeometry(1, seg, CFG.sphereRows, 0, TAU, 0, Math.PI / 2), rimMaterial());
    this.ring = new ShapeBatch(scene, ringGeo, glowMat(THREE.DoubleSide));
    this.batches = [this.cyl, this.sph, this.dome, this.ring];
  }

  /** Number of draw calls this module adds when something is playing (for the budget note) */
  get drawCalls() { return this.pools.length + this.batches.length; }

  get busy() { return this.slots.some((s) => s.active); }

  setHeadless(on) {
    this.headless = !!on;
    if (on) this.#clearAll();
  }

  /** Flying projectile / projection. { kind, race, from, to, flightTime, radius, seed } */
  launch(o) {
    if (this.headless) return null;
    const e = this.#slot(o.kind, o.race, o.seed, o.radius);
    if (!e) return null;
    e.mode = 0;
    e.fx = o.from.x; e.fy = o.from.y; e.fz = o.from.z;
    e.tx = o.to.x; e.ty = o.to.y; e.tz = o.to.z;
    e.dx = e.tx - e.fx; e.dz = e.tz - e.fz;
    e.dist = Math.hypot(e.dx, e.dz);
    e.flight = Math.max(0.1, o.flightTime ?? 3);
    e.dur = e.flight;
    e.autoImpact = !!o.autoImpact;
    return e;
  }

  /** Explosion of the given style at a point. { kind, race, at, radius, seed } */
  impact(o) {
    if (this.headless) return null;
    const e = this.#slot(o.kind, o.race, o.seed, o.radius);
    if (!e) return null;
    e.mode = 1;
    e.tx = o.at.x; e.ty = o.at.y; e.tz = o.at.z;
    this.#spawnImpact(e);
    return e;
  }

  #slot(kind, race, seed, radius) {
    const ki = KINDS.indexOf(kind);
    if (ki < 0) return null;
    let e = null;
    for (const s of this.slots) if (!s.active) { e = s; break; }
    if (!e) return null;
    e.active = true; e.kind = ki; e.t = 0; e.stage = 0; e.acc = 0; e.autoImpact = false;
    e.radius = radius > 0 ? radius : CFG.demo.radius;
    e.s = ((seed ?? 1) * 2654435761 + 0x9e3779b9) >>> 0;
    const key = CFG.colors[race] ? race : DEFAULT_COLORS;
    e.raceKey = key;
    let pal = this.palettes.get(key);
    if (!pal) { pal = makePalette(CFG.colors[key]); this.palettes.set(key, pal); }
    e.pal = ki === 2 ? this.phasePal : ki === 3 ? this.neutronPal : pal;
    return e;
  }

  #rnd(e) {
    let t = (e.s = (e.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  #range(e, r) { return r[0] + this.#rnd(e) * (r[1] - r[0]); }

  /** Burst into a pool. speed/up/life/size are [min,max]; a, b = colours mixed per particle */
  #burst(e, pool, n, x, y, z, speed, up, life, s0, s1, a, b, grav, drag, gy, spread) {
    const p = this.pools[pool];
    for (let i = 0; i < n; i++) {
      const ang = this.#rnd(e) * TAU;
      const sp = this.#range(e, speed);
      const m = this.#rnd(e);
      const ox = spread > 0 ? Math.cos(ang + 1.7) * spread * this.#rnd(e) : 0;
      const oz = spread > 0 ? Math.sin(ang + 1.7) * spread * this.#rnd(e) : 0;
      p.add(x + ox, y, z + oz, Math.cos(ang) * sp, this.#range(e, up), Math.sin(ang) * sp, this.#range(e, life),
        s0 * (0.6 + this.#rnd(e) * 0.8), s1 * (0.6 + this.#rnd(e) * 0.8),
        a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m, a[2] + (b[2] - a[2]) * m, grav, drag, gy);
    }
  }

  // Scratch ranges (module-level, rewritten before use: no allocation in update/impact)
  #r1 = [0, 0]; #r2 = [0, 0]; #r3 = [0, 0];
  #rg(r, a, b) { r[0] = a; r[1] = b; return r; }

  #spawnImpact(e) {
    const R = e.radius;
    const pal = e.pal;
    const x = e.tx, y = e.ty, z = e.tz;
    const g = CFG.gravity, d = CFG.drag;
    if (e.kind === 0) {
      const c = CFG.orbital;
      e.dur = Math.max(c.waveLife, c.columnLife, c.smokeLife[1]) + 0.2;
      this.#burst(e, 1, c.smoke, x, y + 1, z, this.#rg(this.#r1, c.smokeSpeed[0] * R, c.smokeSpeed[1] * R),
        this.#rg(this.#r2, c.smokeRise[0], c.smokeRise[1]), c.smokeLife, R * c.smokeSize[0], R * c.smokeSize[1], pal.smoke, pal.dust, 0, c.smokeDrag, y, R * c.smokeSpread);
      const sp = c.spark, db = c.debrisFx;
      this.#burst(e, 0, c.sparks, x, y + 2, z, this.#rg(this.#r1, sp.speedMin, R * sp.speedRMax), this.#rg(this.#r2, sp.upMin, R * sp.upRMax),
        sp.life, R * sp.size, R * sp.sizeEnd, pal.core, pal.glow, g * sp.gravityShare, d, y, sp.spread);
      this.#burst(e, 2, c.debris, x, y + 1, z, this.#rg(this.#r1, db.speedMin, R * db.speedRMax), db.up,
        db.life, db.size, db.sizeEnd, pal.smoke, pal.dust, g, db.drag, y, db.spread);
    } else if (e.kind === 1) {
      const c = CFG.tectonic;
      e.dur = Math.max(c.columnLife, c.ringLife, c.smokeLife[1]) + 0.2;
      this.#burst(e, 1, c.eruptSmoke, x, y + 1, z, this.#rg(this.#r1, c.smokeSpeed[0] * R, c.smokeSpeed[1] * R), this.#rg(this.#r2, c.smokeRise[0], R * c.smokeRise[1]),
        c.smokeLife, R * c.smokeSize[0], R * c.smokeSize[1], pal.smoke, pal.dust, 0, c.smokeDrag, y, R * c.smokeSpread);
      this.#burst(e, 2, c.eruptDebris, x, y + 1, z, c.debrisSpeed, c.debrisUp,
        c.debrisLife, c.debrisSize[0], c.debrisSize[1], pal.smoke, pal.dust, g, c.debrisDrag, y, R * c.debrisSpread);
      const sp = c.spark;
      this.#burst(e, 0, c.eruptSparks, x, y + 1, z, this.#rg(this.#r1, sp.speedMin, R * sp.speedRMax), this.#rg(this.#r2, sp.upMin, R * sp.upRMax),
        sp.life, R * sp.size, R * sp.sizeEnd, pal.glow, pal.accent, g * sp.gravityShare, d, y, R * sp.spread);
    } else if (e.kind === 2) {
      const c = CFG.phase;
      e.dur = c.implodeLife + c.ringLife + 0.2;
      e.stage = 0;
    } else {
      const c = CFG.neutron;
      e.dur = Math.max(c.domeLife, c.flashLife, c.haloLife) + 0.2;
      const sp = c.spark;
      this.#burst(e, 0, c.sparks, x, y + 2, z, this.#rg(this.#r1, sp.speedMin, R * sp.speedRMax), this.#rg(this.#r2, sp.upMin, R * sp.upRMax),
        sp.life, R * sp.size, R * sp.sizeEnd, pal.core, pal.glow, 0, d, y, R * sp.spread);
    }
  }

  /** Position of the neutron missile at flight ratio k (out = [x, y, z]) */
  #neutronAt(e, k, out) {
    const c = CFG.neutron;
    const apex = c.apexHeight;
    const r = c.riseFraction, tu = c.turnFraction;
    const p1y = e.fy + apex, p2x = e.tx, p2y = e.ty + apex * c.apexDescent, p2z = e.tz;
    if (k < r) {
      const u = easeIn(k / r);
      out[0] = e.fx; out[1] = lerp(e.fy, p1y, u); out[2] = e.fz;
    } else if (k < r + tu) {
      const u = (k - r) / tu;
      const cx = (e.fx + p2x) * 0.5, cy = (p1y + p2y) * 0.5 + apex * c.turnLift, cz = (e.fz + p2z) * 0.5;
      const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, cc = u * u;
      out[0] = a * e.fx + b * cx + cc * p2x; out[1] = a * p1y + b * cy + cc * p2y; out[2] = a * e.fz + b * cz + cc * p2z;
    } else {
      const u = easeIn((k - r - tu) / (1 - r - tu));
      out[0] = p2x; out[1] = lerp(p2y, e.ty, u); out[2] = p2z;
    }
  }

  /** Position on the phaseCharge arc at ratio k */
  #arcAt(e, k, out) {
    const c = CFG.phase;
    const h = Math.max(c.arcMin, e.dist * c.arcHeight);
    out[0] = e.fx + e.dx * k; out[2] = e.fz + e.dz * k;
    out[1] = lerp(e.fy, e.ty, k) + 4 * h * k * (1 - k);
  }

  update(dt) {
    if (this.headless) return;
    let running = false;
    for (const s of this.slots) if (s.active) { running = true; break; }
    for (const p of this.pools) { if (p.n > 0) running = true; }
    if (!running) {
      if (this.cyl.mesh.count > 0 || this.sph.mesh.count > 0 || this.dome.mesh.count > 0 || this.ring.mesh.count > 0 || this.pools[0].mesh.count > 0) this.#clearAll();
      return;
    }
    for (const b of this.batches) b.begin();
    for (const e of this.slots) {
      if (!e.active) continue;
      e.t += dt;
      if (e.mode === 0) this.#flight(e, dt);
      else this.#blast(e, dt);
      if (e.t >= e.dur) {
        e.active = false;
        if (e.mode === 0 && e.autoImpact) {
          // Hand over to the impact of the same style (demo / tests); reuse the colours chosen at launch
          const o = this.#implTmp, at = this.#atTmp;
          at.x = e.tx; at.y = e.ty; at.z = e.tz;
          o.kind = KINDS[e.kind]; o.race = e.raceKey; o.at = at; o.radius = e.radius; o.seed = e.s;
          this.impact(o);
        }
      }
    }
    for (const b of this.batches) b.end();
    for (const p of this.pools) p.update(dt);
  }

  #atTmp = { x: 0, y: 0, z: 0 };
  #implTmp = { kind: '', race: '', at: null, radius: 0, seed: 0 };

  #flight(e, dt) {
    const k = clamp01(e.t / e.flight);
    const pal = e.pal;
    const pools = this.pools;
    if (e.kind === 0) {
      const c = CFG.orbital;
      const pulse = 0.65 + 0.35 * Math.sin(e.t * c.beamPulse * TAU);
      const ramp = c.beamRampMin + (1 - c.beamRampMin) * k;
      const h = c.skyHeight;
      // Targeting beam from the sky to the target, widening and brightening as the bomb falls
      const bw = c.beamRadius * (c.beamWidthGrow + k);
      this.cyl.add(e.tx, e.ty, e.tz, bw, h, bw,
        pal.glow[0] * ramp * pulse, pal.glow[1] * ramp * pulse, pal.glow[2] * ramp * pulse);
      // Ground marker ring that tightens
      const rr = e.radius * (1 + c.markerRingShrink * (1 - k));
      const mb = ramp * pulse * c.markerBrightness;
      this.ring.add(e.tx, e.ty + c.waveLift, e.tz, rr, 1, rr, pal.accent[0] * mb, pal.accent[1] * mb, pal.accent[2] * mb);
      // Falling head
      const hy = e.ty + h * (1 - k * k);
      const hs = c.headSize * (c.beamWidthGrow + k);
      this.sph.add(e.tx, hy, e.tz, hs, hs * c.headStretch, hs, pal.core[0], pal.core[1], pal.core[2]);
      const hp = c.headParticle;
      e.acc += dt * c.beamParticleRate;
      while (e.acc >= 1) {
        e.acc -= 1;
        pools[0].add(e.tx + (this.#rnd(e) - 0.5) * hp.jitter, hy + this.#rnd(e) * hp.height, e.tz + (this.#rnd(e) - 0.5) * hp.jitter, 0, hp.rise, 0, hp.life, hp.size, hp.sizeEnd, pal.glow[0], pal.glow[1], pal.glow[2], 0, 1, e.ty);
      }
    } else if (e.kind === 1) {
      const c = CFG.tectonic;
      const hx = e.fx + e.dx * k, hz = e.fz + e.dz * k, hy = lerp(e.fy, e.ty, k);
      // Glowing fissure line from the launch point to the underground head
      if (e.dist > 0.01) {
        const ux = e.dx / e.dist, uz = e.dz / e.dist;
        const len = e.dist * k;
        const fade = c.fissureBase + c.fissureAmp * Math.sin(e.t * c.fissurePulseHz);
        this.cyl.addDir(e.fx, e.fy + c.fissureLift, e.fz, ux, 0, uz, c.fissureRadius, len, pal.accent[0] * fade, pal.accent[1] * fade, pal.accent[2] * fade);
      }
      this.sph.add(hx, hy + c.fissureLift, hz, c.glowSize, c.glowSize * c.capHeight, c.glowSize, pal.glow[0], pal.glow[1], pal.glow[2]);
      e.acc += dt * (c.crackCount + c.crackPerUnit * (e.dist / e.flight));
      while (e.acc >= 1) {
        e.acc -= 1;
        const cd = c.crackDust, cs = c.crackSpark;
        const a = this.#rnd(e) * TAU, sp = cd.speedMin + this.#rnd(e) * cd.speedRange;
        const tint = cd.tintMin + this.#rnd(e) * cd.tintRange;
        // Dust puffs along the path behind the head
        const bx = hx - e.dx * cd.trailBack * this.#rnd(e), bz = hz - e.dz * cd.trailBack * this.#rnd(e);
        pools[1].add(bx + (this.#rnd(e) - 0.5) * cd.jitter, hy + cd.lift, bz + (this.#rnd(e) - 0.5) * cd.jitter, Math.cos(a) * sp, cd.rise + this.#rnd(e) * cd.riseRange, Math.sin(a) * sp,
          this.#range(e, c.crackLife), c.crackSize[0], c.crackSize[1], pal.dust[0] * tint, pal.dust[1] * tint, pal.dust[2] * tint, 0, cd.drag, hy);
        if (this.#rnd(e) < cs.chance) pools[0].add(bx, hy + cs.lift, bz, Math.cos(a) * sp * cs.speedShare, cs.rise + this.#rnd(e) * cs.riseRange, Math.sin(a) * sp * cs.speedShare,
          cs.life + this.#rnd(e) * cs.lifeRange, cs.size, cs.sizeEnd, pal.glow[0], pal.glow[1], pal.glow[2], 0, 1, hy);
      }
    } else if (e.kind === 2) {
      const c = CFG.phase;
      this.#arcAt(e, k, _pos);
      const pulse = 1 + c.ballPulseAmp * Math.sin(e.t * c.ballPulseHz);
      const s = c.ballSize * pulse;
      const hs = s * c.ballHaloSize, hb = c.ballHaloShare;
      this.sph.add(_pos[0], _pos[1], _pos[2], hs, hs, hs, pal.glow[0] * hb, pal.glow[1] * hb, pal.glow[2] * hb);
      this.sph.add(_pos[0], _pos[1], _pos[2], s, s, s, pal.core[0], pal.core[1], pal.core[2]);
      e.acc += dt * c.trailRate;
      while (e.acc >= 1) {
        e.acc -= 1;
        const a = this.#rnd(e) * TAU, sp = c.trailSpeed + this.#rnd(e) * c.trailSpeedRange;
        pools[0].add(_pos[0], _pos[1], _pos[2], Math.cos(a) * sp, (this.#rnd(e) - c.trailUp) * sp, Math.sin(a) * sp, c.trailLife * (c.trailLifeJitter + this.#rnd(e) * c.trailLifeRange),
          s * c.trailSizeShare, c.trailSizeEnd, pal.glow[0], pal.glow[1], pal.glow[2], 0, c.trailDrag, e.ty);
      }
    } else {
      const c = CFG.neutron;
      this.#neutronAt(e, k, _pos);
      this.#neutronAt(e, Math.min(1, k + EPS_DIR), _pos2);
      let dx = _pos2[0] - _pos[0], dy = _pos2[1] - _pos[1], dz = _pos2[2] - _pos[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      const L = c.bodyLength, hl = L * c.bodyHalf, ns = c.bodyRadius * c.noseSize, nb = c.noseShare;
      this.cyl.addDir(_pos[0] - dx * hl, _pos[1] - dy * hl, _pos[2] - dz * hl, dx, dy, dz, c.bodyRadius, L, pal.accent[0], pal.accent[1], pal.accent[2]);
      this.sph.add(_pos[0] - dx * hl, _pos[1] - dy * hl, _pos[2] - dz * hl, ns, ns, ns, pal.core[0] * nb, pal.core[1] * nb, pal.core[2] * nb);
      e.acc += dt * c.trailRate;
      while (e.acc >= 1) {
        e.acc -= 1;
        const a = this.#rnd(e) * TAU, sp = c.trailSpeed + this.#rnd(e) * c.trailSpeedRange, tb = c.trailBack;
        pools[0].add(_pos[0] - dx * L, _pos[1] - dy * L, _pos[2] - dz * L, Math.cos(a) * sp - dx * tb, Math.sin(a) * sp - dy * tb, Math.sin(a) * sp - dz * tb,
          c.trailLife * (c.trailLifeJitter + this.#rnd(e) * c.trailLifeRange), c.trailSize, c.trailSizeEnd, pal.core[0], pal.core[1], pal.core[2], 0, c.trailDrag, e.ty);
        if (this.#rnd(e) < c.smokeChance) pools[1].add(_pos[0] - dx * L, _pos[1] - dy * L, _pos[2] - dz * L, Math.cos(a) * sp * c.smokeSpeedShare, Math.sin(a) * sp * c.smokeSpeedShare, Math.sin(a) * sp * c.smokeSpeedShare,
          c.trailLife * c.smokeLifeMul, c.smokeSize, c.smokeSizeEnd, c.smokeColor[0], c.smokeColor[1], c.smokeColor[2], 0, 1, e.ty);
      }
    }
  }

  #blast(e, dt) {
    const R = e.radius;
    const t = e.t;
    const pal = e.pal;
    const x = e.tx, y = e.ty, z = e.tz;
    if (e.kind === 0) {
      const c = CFG.orbital;
      const fk = clamp01(t / c.flashLife);
      if (fk < 1) {
        const f = 1 - fk;
        const s = R * c.flashSizeFactor * (c.flashMin + (1 - c.flashMin) * easeOut(fk));
        const hs = s * c.flashHaloSize, hb = f * c.flashHaloShare;
        this.sph.add(x, y + s * c.flashLift, z, s, s, s, pal.core[0] * f, pal.core[1] * f, pal.core[2] * f);
        this.sph.add(x, y + s * c.flashLift, z, hs, hs, hs, pal.glow[0] * hb, pal.glow[1] * hb, pal.glow[2] * hb);
      }
      const ck = clamp01(t / c.columnLife);
      if (ck < 1) {
        const f = (1 - ck) ** c.columnFadePower * c.columnBrightness;
        const w = R * c.columnRadiusFactor * (1 + c.columnGrow * ck), gw = w * c.columnGlowWidth, gs = f * c.columnGlowShare;
        this.cyl.add(x, y, z, w, R * c.columnHeightFactor, w, pal.core[0] * f, pal.core[1] * f, pal.core[2] * f);
        this.cyl.add(x, y, z, gw, R * c.columnHeightFactor, gw, pal.glow[0] * gs, pal.glow[1] * gs, pal.glow[2] * gs);
      }
      const wk = clamp01(t / c.waveLife);
      if (wk < 1) {
        const f = 1 - wk;
        const rr = R * c.waveSizeFactor * easeOut(wk);
        const ds = f * c.waveDomeShare;
        this.ring.add(x, y + c.waveLift, z, rr, 1, rr, pal.core[0] * f, pal.core[1] * f, pal.core[2] * f);
        this.dome.add(x, y, z, rr * c.waveDomeWidth, rr * c.waveDomeHeight, rr * c.waveDomeWidth, pal.accent[0] * ds, pal.accent[1] * ds, pal.accent[2] * ds);
      }
    } else if (e.kind === 1) {
      const c = CFG.tectonic;
      const ck = clamp01(t / c.columnLife);
      if (ck < 1) {
        const rise = easeOut(clamp01(t / c.columnRise));
        const f = (1 - ck) * (1 - ck);
        const w = R * c.columnRadiusFactor * (c.columnGrow + c.columnGrow * ck), gs = f * c.columnGlowShare;
        this.cyl.add(x, y, z, w, R * c.columnHeightFactor * rise, w, pal.glow[0] * gs, pal.glow[1] * gs, pal.glow[2] * gs);
        this.sph.add(x, y + c.fissureLift * 5, z, w * c.capSize, w * c.capHeight, w * c.capSize, pal.core[0] * f, pal.core[1] * f, pal.core[2] * f);
      }
      const rk = clamp01(t / c.ringLife);
      if (rk < 1) {
        const f = 1 - rk;
        const rr = R * c.ringSizeFactor * easeOut(rk);
        const db = f * c.ringDustBoost, ia = f * c.innerRingShare, ir = rr * c.innerRing;
        this.ring.add(x, y + c.ringLift, z, rr, 1, rr, pal.dust[0] * db, pal.dust[1] * db, pal.dust[2] * db);
        this.ring.add(x, y + c.ringLift, z, ir, 1, ir, pal.accent[0] * ia, pal.accent[1] * ia, pal.accent[2] * ia);
      }
    } else if (e.kind === 2) {
      const c = CFG.phase;
      const fk = clamp01(t / c.flashLife);
      if (fk < 1) {
        const f = 1 - fk;
        const s = R * c.flashSizeFactor * (c.flashMin + (1 - c.flashMin) * easeOut(fk));
        const hs = s * c.flashHaloSize, hb = f * c.flashHaloShare;
        this.sph.add(x, y + c.flashLift, z, s, s, s, pal.core[0] * f, pal.core[1] * f, pal.core[2] * f);
        this.sph.add(x, y + c.flashLift, z, hs, hs, hs, pal.glow[0] * hb, pal.glow[1] * hb, pal.glow[2] * hb);
      }
      const ik = clamp01(t / c.implodeLife);
      if (ik < 1) {
        // Big violet sphere collapsing to a point
        const s = R * c.implodeSizeFactor * (1 - easeIn(ik) * c.implodeShrink) + c.implodeMin;
        const b = c.implodeBrightMin + (1 - c.implodeBrightMin) * ik, bs = b * c.implodeShellShare, cs = s * c.implodeCoreSize;
        const ly = y + R * c.implodeLift;
        this.sph.add(x, ly, z, s, s, s, pal.glow[0] * bs, pal.glow[1] * bs, pal.glow[2] * bs);
        this.sph.add(x, ly, z, cs, cs, cs, pal.core[0] * b, pal.core[1] * b, pal.core[2] * b);
      } else {
        if (e.stage === 0) {
          e.stage = 1;
          const bu = c.burst, pf = c.puff;
          this.#burst(e, 0, c.sparks, x, y + R * c.implodeLift, z, this.#rg(this.#r1, bu.speedMin, R * bu.speedRMax), this.#rg(this.#r2, R * bu.upRMin, R * bu.upRMax),
            bu.life, R * bu.size, R * bu.sizeEnd, pal.core, pal.accent, 0, CFG.drag, y, bu.spread);
          this.#burst(e, 1, c.smoke, x, y + 2, z, this.#rg(this.#r1, pf.speedMin, R * pf.speedRMax), this.#rg(this.#r2, pf.upMin, pf.upMax),
            pf.life, R * pf.size, R * pf.sizeEnd, pal.glow, pal.accent, 0, 1, y, R * pf.spread);
        }
        const rk = clamp01((t - c.implodeLife) / c.ringLife);
        if (rk < 1) {
          const f = 1 - rk;
          const rr = R * c.ringSizeFactor * easeOut(rk);
          const gl = f * c.ringGlowShare, dm = f * c.ringDomeShare;
          this.ring.add(x, y + c.ringLift, z, rr, 1, rr, pal.core[0] * f, pal.core[1] * f, pal.core[2] * f);
          this.ring.add(x, y + R * c.implodeLift, z, rr, c.ringWallHeight, rr, pal.glow[0] * gl, pal.glow[1] * gl, pal.glow[2] * gl);
          // Standing shell (wall of the shock) around the core
          this.dome.add(x, y, z, rr * c.ringDomeWidth, rr * c.ringDomeHeight, rr * c.ringDomeWidth, pal.accent[0] * dm, pal.accent[1] * dm, pal.accent[2] * dm);
        }
      }
    } else {
      const c = CFG.neutron;
      const fk = clamp01(t / c.flashLife);
      if (fk < 1) {
        const f = 1 - fk;
        const s = R * c.flashSizeFactor * (c.flashMin + (1 - c.flashMin) * easeOut(fk)) * c.flashScale;
        this.sph.add(x, y + R * c.flashLift, z, s, s, s, f, f, f);
      }
      const dk = clamp01(t / c.domeLife);
      if (dk < 1) {
        const f = 1 - dk;
        const s = R * c.domeSizeFactor * easeOut(dk);
        const d1 = f * c.domeShare, d2 = f * c.domeInnerShare, si = s * c.domeInnerScale;
        this.dome.add(x, y, z, s, s, s, pal.core[0] * d1, pal.core[1] * d1, pal.core[2] * d1);
        this.dome.add(x, y, z, si, si, si, pal.glow[0] * d2, pal.glow[1] * d2, pal.glow[2] * d2);
      }
      const hk = clamp01(t / c.haloLife);
      if (hk < 1) {
        const f = 1 - hk;
        const rr = R * c.haloScale * easeOut(hk);
        this.ring.add(x, y + c.haloLift, z, rr, 1, rr, f, f, f);
      }
    }
  }

  #clearAll() {
    for (const s of this.slots) s.active = false;
    for (const p of this.pools) p.clear();
    for (const b of this.batches) { b.n = 0; b.mesh.count = 0; }
  }

  dispose() {
    this.#clearAll();
    for (const p of this.pools) p.dispose();
    for (const b of this.batches) b.dispose();
    for (const g of this.partGeos) g.dispose();
    this.palettes.clear();
  }
}

/**
 * Debug helper (screenshots): plays all 4 kinds side by side around `at` (Vector3-like), flight then impact,
 * repeating every `cycle` seconds. Drives itself with requestAnimationFrame (visual only, outside the simulation).
 * Returns { fx, stop() } – stop() also disposes the effect.
 */
export function demo(scene, at, race = 'default') {
  const fx = new SuperweaponFx(scene);
  const d = CFG.demo;
  const cycle = d.flightTime + 7;
  let timer = 0;
  let last = 0;
  let raf = 0;
  let stopped = false;
  const from = { x: 0, y: 0, z: 0 };
  const to = { x: 0, y: 0, z: 0 };
  const play = () => {
    for (let i = 0; i < KINDS.length; i++) {
      const x = at.x + (i - 1.5) * d.spacing;
      to.x = x; to.y = at.y; to.z = at.z;
      from.x = x - 160; from.y = at.y; from.z = at.z + (i === 3 ? 0 : 150);
      if (i === 3) { from.x = x; from.z = at.z - 140; }
      fx.launch({ kind: KINDS[i], race, from, to, flightTime: d.flightTime, radius: d.radius, seed: 100 + i, autoImpact: true });
    }
  };
  const frame = (now) => {
    if (stopped) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    timer -= dt;
    if (timer <= 0) { timer = cycle; play(); }
    fx.update(dt);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    fx,
    stop() { stopped = true; cancelAnimationFrame(raf); fx.dispose(); },
  };
}
