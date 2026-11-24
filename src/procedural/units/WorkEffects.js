// Steel Men – work effects of procedural trucks (build sparks, repair glints, harvest dust and debris). [B1-W3]
// Visual only: nothing here is read by the simulation, no world.rng (own mulberry32), no allocation per frame.
// One WorkFxSystem per scene = two THREE.Points (additive + normal blending) with fixed-size ring pools, shared by all
// trucks. Particles integrate in Points.onBeforeRender with the render clock; emission is requested by ProcDriver
// (src/units/ProcVehicle.js) through `emit()` from the world position of the model socket `work`.
import * as THREE from 'three';
import { PROC_WORK_FX as FX } from '../../config.js';

const _white = new THREE.Color(1, 1, 1);
const _c = new THREE.Color();
const _size = new THREE.Vector2();

const glf = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const VERT = `
attribute vec4 aColor;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize > 0.0 ? max(${glf(FX.minPointPx)}, aSize * uScale / max(${glf(FX.minViewDepth)}, -mv.z)) : 0.0;
}`;
const FRAG = `
varying vec4 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * ${glf(FX.pointRadiusNorm)};
  if (r2 > 1.0) discard;
  float a = vColor.a * (1.0 - r2);
  gl_FragColor = vec4(vColor.rgb, a);
}`;

/** Fixed-size ring pool drawn as one Points object */
class ParticlePool {
  constructor(cap, additive, seedShift) {
    this.cap = cap;
    this.head = 0;
    this.live = 0;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.siz = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);   // 0 = free slot
    this.s0 = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.a0 = new Float32Array(cap);
    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizAttr = new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('aColor', this.colAttr);
    this.geometry.setAttribute('aSize', this.sizAttr);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: FX.pointScaleFallback } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.castShadow = false;
    this.points.receiveShadow = false;
    this.points.renderOrder = additive ? 6 : 5;
    this.points.name = additive ? 'workFxAdd' : 'workFxNorm';
    this.points.visible = false;           // shown only while something is alive
    this.seedShift = seedShift;
  }

  spawn(x, y, z, vx, vy, vz, r, g, b, a, size, life, grow, grav, drag) {
    const i = this.head;
    this.points.visible = true;            // onBeforeRender only runs for a visible object
    this.head = (i + 1) % this.cap;
    if (this.life[i] <= 0) this.live++;    // overwriting the oldest live particle keeps the count
    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i4] = r; this.col[i4 + 1] = g; this.col[i4 + 2] = b; this.col[i4 + 3] = a;
    this.siz[i] = size;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = size; this.grow[i] = grow;
    this.grav[i] = grav; this.drag[i] = drag; this.a0[i] = a;
  }

  step(dt) {
    if (this.live <= 0) { this.points.visible = false; return; }
    const { pos, vel, col, siz, age, life, s0, grow, grav, drag, a0 } = this;
    for (let i = 0; i < this.cap; i++) {
      const l = life[i];
      if (l <= 0) continue;
      const t = age[i] + dt;
      if (t >= l) {
        life[i] = 0; siz[i] = 0; col[i * 4 + 3] = 0; this.live--;
        continue;
      }
      age[i] = t;
      const i3 = i * 3;
      const damp = Math.max(0, 1 - drag[i] * dt);
      vel[i3] *= damp; vel[i3 + 2] *= damp;
      vel[i3 + 1] = vel[i3 + 1] * damp - grav[i] * dt;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const k = t / l;
      siz[i] = s0[i] * (1 + (grow[i] - 1) * k);
      col[i * 4 + 3] = a0[i] * (1 - k) * Math.min(1, k / FX.fadeInShare);   // quick fade in, linear fade out
    }
    this.points.visible = true;
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true; this.sizAttr.needsUpdate = true;
  }

  dispose() {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Colour cache per style kit (built once per style, not per emission) */
const colorCache = new Map();
function kindColors(m) {
  const key = m.kit?.key ?? '';
  let c = colorCache.get(key);
  if (c) return c;
  const weapon = (m.unitStyle?.weaponGlow ?? _white).clone();
  const spark = weapon.clone().lerp(_white, FX.sparkCoreMix);
  const repair = new THREE.Color(FX.repairColor).lerp(_white, FX.repairCoreMix);
  const dust = new THREE.Color(FX.dustColor);
  const accent = m.kit?.style?.palette?.accent;
  if (accent) dust.lerp(_c.set(accent), FX.dustAccentMix);
  const debris = dust.clone().multiplyScalar(FX.debrisDarken);
  c = { weapon: spark, repair, dust, debris };
  colorCache.set(key, c);
  return c;
}

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const systems = new WeakMap();

class WorkFxSystem {
  constructor(scene) {
    this.scene = scene;
    this.rnd = mulberry32(FX.seed);
    this.add = new ParticlePool(FX.additiveCap, true);
    this.norm = new ParticlePool(FX.normalCap, false);
    this.last = 0;
    this.refs = 0;
    for (const p of [this.add, this.norm]) {
      p.points.onBeforeRender = (renderer, _s, camera) => this.#frame(renderer, camera);
      scene.add(p.points);
    }
  }

  #frame(renderer, camera) {
    const now = performance.now() * 0.001;   // render clock (visual only)
    const fresh = now - this.last > FX.minFrameGap;   // both pools render per frame: integrate once
    if (fresh) {
      const dt = Math.min(FX.maxFrameDt, this.last ? now - this.last : 0);
      this.last = now;
      this.add.step(dt);
      this.norm.step(dt);
      let scale = FX.pointScaleFallback;
      if (camera.isPerspectiveCamera) {
        renderer.getDrawingBufferSize(_size);
        scale = _size.y * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      }
      this.add.material.uniforms.uScale.value = scale;
      this.norm.material.uniforms.uScale.value = scale;
    }
  }

  /** Emits `n` particles of the emitters of `kind` at (x,y,z); level scales the count */
  burst(kind, level, dt, carry, m, x, y, z) {
    const defs = FX.kinds[kind];
    if (!defs) return carry;
    const colors = kindColors(m);
    const rnd = this.rnd;
    for (let d = 0; d < defs.length; d++) {
      const e = defs[d];
      const c = colors[e.color];
      const want = e.rate * level * dt + carry[d];
      const n = Math.floor(want);
      carry[d] = want - n;
      const pool = e.group === 'add' ? this.add : this.norm;
      for (let k = 0; k < n; k++) {
        const ang = rnd() * Math.PI * 2;
        const sp = e.speed[0] + rnd() * (e.speed[1] - e.speed[0]);
        const hs = sp * e.spread * Math.sqrt(rnd());
        const up = sp * e.up * (0.4 + rnd() * 0.6);
        const life = e.life[0] + rnd() * (e.life[1] - e.life[0]);
        const size = e.size[0] + rnd() * (e.size[1] - e.size[0]);
        const j = e.jitter;
        pool.spawn(
          x + (rnd() - 0.5) * j, y + (rnd() - 0.5) * j, z + (rnd() - 0.5) * j,
          Math.cos(ang) * hs, up, Math.sin(ang) * hs,
          c.r, c.g, c.b, e.alpha, size, life, e.grow, e.gravity, e.drag,
        );
      }
    }
    return carry;
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    this.add.dispose();
    this.norm.dispose();
    if (systems.get(this.scene) === this) systems.delete(this.scene);
  }
}

function sceneOf(obj) {
  let o = obj;
  while (o.parent) o = o.parent;
  return o.isScene ? o : null;
}

/**
 * Per-truck emitter handle (owned by ProcDriver): holds the fractional-particle carry of every emitter and the scene
 * system reference. `update(m, kind, level, dt, camera?)` emits from the model's `work` socket.
 */
export class WorkEmitter {
  constructor() {
    this.sys = null;
    this.carry = new Float32Array(4);
    this.lastKind = '';
    this.disposed = false;
  }

  /** @param {object} m ProcUnit (needs getSocket('work')), kind 'build'|'repair'|'harvest', level 0..1, dt s */
  update(m, kind, level, dt) {
    if (this.disposed || !FX.enabled || level < FX.minLevel || !FX.kinds[kind]) return;
    for (let o = m; o; o = o.parent) if (!o.visible) return;        // hidden / fog of war
    const socket = m.getSocket?.('work');
    if (!socket) return;
    if (this.sys?.dead) this.sys = null;                              // scene effects were disposed: re-create
    if (!this.sys) {
      const scene = sceneOf(m);
      if (!scene) return;
      this.sys = systems.get(scene);
      if (!this.sys) { this.sys = new WorkFxSystem(scene); systems.set(scene, this.sys); }
      this.sys.refs++;
    }
    if (kind !== this.lastKind) { this.carry.fill(0); this.lastKind = kind; }
    socket.getWorldPosition(_v);
    this.sys.burst(kind, level, dt, this.carry, m, _v.x, _v.y, _v.z);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const sys = this.sys;
    this.sys = null;
    if (sys && !sys.dead && --sys.refs <= 0) sys.dispose();
  }
}

const _v = new THREE.Vector3();

/** Frees the effects of a scene at once (match teardown); emitters recreate it on demand */
export function disposeWorkEffects(scene) {
  systems.get(scene)?.dispose();
}
