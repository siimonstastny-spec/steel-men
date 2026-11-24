// Steel Mans – combat visuals: instant tracers, travelling projectiles, explosions and status indicators.
// Explosion models (models/explosion/*.glb) are static meshes – all their animation happens here.
import * as THREE from 'three';
import { loadModel } from '../core/AssetLoader.js';
import { VFX, R2 } from '../config.js';
import { play } from '../audio/Sound.js';
import { loadExplosionData, explosionData, explosionPlan, damagePlan, ParticleField } from './ExplosionStyles.js';

const TRACER_LIFE = VFX.tracerLife;

// Scratch objects of the projectile batch (recycled, nothing is allocated per frame)
const _pDummy = new THREE.Object3D();
const _pColor = new THREE.Color();
const _pWhite = new THREE.Color(1, 1, 1);
const _pDir = new THREE.Vector3();

/**
 * All travelling projectiles drawn as two instanced meshes (bright core + additive halo). Visual only: arrival
 * callbacks into the simulation fire for every projectile in launch order, drawn or not (beyond maxInstances).
 */
class ProjectileBatch {
  constructor(scene) {
    const cfg = VFX.projectile;
    this.scene = scene;
    this.cap = cfg.maxInstances;
    this.geo = new THREE.SphereGeometry(1, ...cfg.segments);
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    this.core = this.#mesh(this.coreMat, 0);
    this.glow = this.#mesh(this.glowMat, VFX.renderOrder);
    this.live = [];      // records in launch order
    this.arrived = [];   // recycled: records that arrived this frame
    this.pool = [];      // recycled records
  }

  #mesh(mat, order) {
    const m = new THREE.InstancedMesh(this.geo, mat, this.cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false; // instances move; the initial bounding sphere would cull them
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = order;
    m.raycast = () => {};
    this.scene.add(m);
    return m;
  }

  launch(from, aim, speed, color, onArrive, r, shape) {
    const rec = this.pool.pop() ?? { pos: new THREE.Vector3(), hit: new THREE.Vector3(), core: new THREE.Color(), halo: new THREE.Color() };
    rec.pos.copy(from);
    rec.aim = aim;
    rec.speed = speed;
    rec.onArrive = onArrive;
    rec.r = r;
    rec.stretch = shape.stretch;
    rec.glowR = r * shape.glow;
    rec.glowOpacity = shape.glowOpacity;
    rec.life = VFX.projectile.maxLife;
    rec.halo.set(color);
    rec.core.copy(rec.halo).lerp(_pWhite, VFX.projectile.coreWhite);
    rec.done = false;
    this.live.push(rec);
  }

  update(dt) {
    const live = this.live;
    if (!live.length) return;
    let error = null; // first exception of an aim() / onArrive callback, rethrown after the batch is consistent
    // 1) move; mark the ones that arrive (or time out)
    for (let i = 0; i < live.length; i++) {
      const rec = live[i];
      rec.life -= dt;
      let target;
      try { target = rec.aim(); } catch (e) { rec.done = true; rec.timeout = true; error ??= e; continue; } // one bad aim must not drop the batch
      _pDir.subVectors(target, rec.pos);
      const dist = _pDir.length();
      const step = rec.speed * dt;
      if (dist <= step) { rec.pos.copy(target); rec.hit.copy(target); rec.done = true; rec.timeout = false; } else {
        rec.pos.addScaledVector(_pDir, step / dist);
        rec.dirX = _pDir.x; rec.dirY = _pDir.y; rec.dirZ = _pDir.z;
        if (rec.life <= 0) { rec.done = true; rec.timeout = true; }
      }
    }
    // 2) compact in launch order and write the instances of the survivors
    let n = 0;
    for (let i = 0; i < live.length; i++) {
      const rec = live[i];
      if (rec.done) { this.arrived.push(rec); continue; }
      live[n++] = rec;
    }
    live.length = n;
    const drawn = Math.min(n, this.cap);
    for (let i = 0; i < drawn; i++) {
      const rec = live[i];
      _pDummy.position.copy(rec.pos);
      if (rec.stretch !== 1) { _pDir.set(rec.dirX, rec.dirY, rec.dirZ).add(rec.pos); _pDummy.lookAt(_pDir); } else _pDummy.quaternion.identity();
      _pDummy.scale.set(rec.r, rec.r, rec.r * rec.stretch); // long axis = local +Z, which lookAt points along the flight
      _pDummy.updateMatrix();
      this.core.setMatrixAt(i, _pDummy.matrix);
      this.core.setColorAt(i, rec.core);
      _pDummy.scale.set(rec.glowR, rec.glowR, rec.glowR * rec.stretch);
      _pDummy.updateMatrix();
      this.glow.setMatrixAt(i, _pDummy.matrix);
      _pColor.copy(rec.halo).multiplyScalar(rec.glowOpacity); // additive blending: colour x strength = halo brightness
      this.glow.setColorAt(i, _pColor);
    }
    this.core.count = this.glow.count = drawn;
    this.core.instanceMatrix.needsUpdate = this.glow.instanceMatrix.needsUpdate = true;
    if (this.core.instanceColor) this.core.instanceColor.needsUpdate = this.glow.instanceColor.needsUpdate = true;
    // 3) arrivals last: the callbacks may launch new projectiles (appended to `live`)
    const arrived = this.arrived;
    try {
      for (let i = 0; i < arrived.length; i++) {
        const rec = arrived[i];
        const cb = rec.onArrive;
        const point = rec.timeout ? null : rec.hit.clone();
        rec.aim = null; rec.onArrive = null;
        this.pool.push(rec);
        if (point) { try { cb(point); } catch (e) { error ??= e; } }
      }
    } finally {
      arrived.length = 0; // a record must never be processed (and pooled) twice
    }
    if (error) throw error;
  }

  dispose() {
    this.scene.remove(this.core, this.glow);
    this.core.dispose();
    this.glow.dispose();
    this.geo.dispose();
    this.coreMat.dispose();
    this.glowMat.dispose();
    this.live.length = 0;
    this.arrived.length = 0;
    this.pool.length = 0;
  }
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.projectiles = new ProjectileBatch(scene); // every travelling projectile, drawn as two instanced meshes
    this.templates = {};    // VFX model key -> loaded scene (cloned per effect)
    this.time = 0;
    this.field = null;      // batched explosion particles (ExplosionStyles.ParticleField), created on first use
  }

  /** Loads the explosion models once; effects requested before that are skipped */
  async preload() {
    await Promise.all(Object.entries(VFX.models).map(async ([key, path]) => {
      try { this.templates[key] = await loadModel(path); } catch (err) { console.warn(`[Effects] ${path}:`, err); }
    }));
    try { await loadExplosionData(); } catch (err) { console.warn('[Effects] explosions.json:', err); } // without it units use VFX.mechExplosion
    return this;
  }

  /**
   * Unit death (mech): fire and smoke first, the explosion after the data's `delay` (mech has fallen); kinds without a
   * delay explode at once. Style by unit kind x race from data/explosions.json. Visual only.
   * @param {object} unit  mech / vehicle (uses race, unitId, position, aimHeight)
   * @param {object} [opts]  { fallbackSize } VFX.mechExplosion scale when the data is not loaded
   */
  unitDeath(unit, { fallbackSize = 1 } = {}) {
    const plan = explosionData() ? explosionPlan(unit) : null;
    if (!plan || plan.delay <= 0) { this.explodeUnit(unit, { fallbackSize }); return; }
    this.burn(unit, unit, plan.delay, () => this.explodeUnit(unit, { fallbackSize }));
  }

  /**
   * Immediate explosion in the style of the unit.
   * @param {object} [opts]  { position (default unit.position), size = 1 (multiplier), fallbackSize }
   */
  explodeUnit(unit, { position = unit.position, size = 1, fallbackSize = 1 } = {}) {
    const plan = explosionData() ? explosionPlan(unit) : null;
    const aim = unit.aimHeight ?? 1;
    if (!plan) { this.burst(VFX.mechExplosion, position.clone(), { size: fallbackSize, heightUnit: aim }); return; }
    this.burst(plan.layers, position.clone(), { size: plan.size * size, heightUnit: plan.heightByAim ? aim : 1 });
    const field = this.#field();
    const gy = position.y;
    const y = position.y + (plan.heightByAim ? aim * 0.8 : 1);
    for (const name of ['glow', 'smoke', 'debris']) field.spray(name, plan.pools[name], position.x, y, position.z, gy);
  }

  /**
   * Flames and smoke on a dying unit for `duration` s (Infinity-safe; stop() ends it early), at `follow.position`
   * (the unit itself, or the falling ghost of an aircraft). `onEnd` runs when it ends (not on Effects.dispose).
   * @returns {{ stop(): void }}
   */
  burn(unit, follow = unit, duration = 1, onEnd = null) {
    const plan = explosionData() ? explosionPlan(unit) : null;
    const b = plan?.burn ?? null;
    const field = b ? this.#field() : null;
    const aim = unit.aimHeight ?? 1;
    const spread = (unit.radius ?? 1) * (b?.spread ?? 0);
    let flames = 0;
    let puffs = 0;
    const item = {
      life: duration,
      update: (dt) => {
        if (!b) return;
        flames += b.flameRate * dt;
        puffs += b.smokeRate * dt;
        const p = follow.position;
        const y = p.y + aim * b.height;
        while (flames >= 1) { flames -= 1; field.puff(false, b, p.x + (field.rand() - 0.5) * 2 * spread, y, p.z + (field.rand() - 0.5) * 2 * spread); }
        while (puffs >= 1) { puffs -= 1; field.puff(true, b, p.x + (field.rand() - 0.5) * 2 * spread, y, p.z + (field.rand() - 0.5) * 2 * spread); }
      },
      dispose: () => { if (onEnd && !this.#disposed) onEnd(); },
    };
    this.items.push(item);
    return { stop: () => { item.life = 0; } };
  }

  /**
   * Persistent damage smoke on a unit / building while its hp fraction is below the data threshold (light smoke when
   * slightly hurt, thick dark smoke when nearly dead). Ends itself when the target is destroyed / dead / removed, or on
   * dispose(). Purely visual: reads state, never writes it, own seeded generator (no world.rng).
   * @param {object} target  unit or building (uses position, aimHeight | bodyHeight, radius, destroyed / dead / removed)
   * @param {() => number} hpFraction  current hp / maxHp (0..1), evaluated every frame
   * @param {object} [opts]  { kind = 'unit' ('unit' | 'building'), isShown = () => true (fog of war), sizeScale = 1 }
   * @returns {{ dispose(): void }}
   */
  damageSmoke(target, hpFraction, { kind = 'unit', isShown = () => true, sizeScale = 1 } = {}) {
    const spec = damagePlan(kind);
    if (!spec || !explosionData()) return { dispose() {} };
    const field = this.#field();
    let puffs = 0;
    const item = {
      life: Infinity,
      update: (dt) => {
        if (target.destroyed || target.dead || target.removed) { item.life = 0; return; }
        const hp = hpFraction();
        if (hp >= spec.threshold || hp <= 0 || !isShown()) { puffs = 0; return; }
        const sev = Math.min(1, (spec.threshold - hp) / spec.threshold);
        puffs += (spec.rateMin + (spec.rateMax - spec.rateMin) * sev) * dt;
        if (puffs < 1) return;
        const spread = (target.radius ?? 1) * spec.spread;
        const p = target.position;
        const y = p.y + (kind === 'building' ? (target.bodyHeight ?? 1) : (target.aimHeight ?? 1)) * spec.height;
        while (puffs >= 1) {
          puffs -= 1;
          field.damagePuff(spec, sev, sizeScale, p.x + (field.rand() - 0.5) * 2 * spread, y, p.z + (field.rand() - 0.5) * 2 * spread);
        }
      },
      dispose: () => {},
    };
    this.items.push(item);
    return { dispose: () => { item.life = 0; } };
  }

  #field() {
    return (this.field ??= new ParticleField(this.scene));
  }

  /**
   * Generic timed visual (aircraft crash): `update(dt, item)` runs every frame while it lives (set item.life = 0 to
   * end it early), `dispose()` once at the end. Purely visual – never touches the simulation.
   */
  custom(life, update, dispose) {
    this.items.push({ life, update, dispose });
  }

  /** Instant shot line (lasers, guns without projectile speed) */
  tracer(from, to, color) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.items.push({
      life: TRACER_LIFE,
      update: (dt, item) => { mat.opacity = Math.max(0, item.life / TRACER_LIFE); },
      dispose: () => { this.scene.remove(line); geo.dispose(); mat.dispose(); },
    });
  }

  /**
   * Projectile flying towards a (possibly moving) target; onArrive(point) is called on impact.
   * @param {() => THREE.Vector3} aim  current aim point (homing), evaluated every frame
   * @param {object} [look]  { size (radius, units), shape ('orb' | 'shell' | 'missile' | 'bolt'), color (optional
   *   hex / CSS colour overriding the shape colour and `color`) } – see VFX.projectile
   */
  projectile(from, aim, speed, color, onArrive, { size = 0, shape = '', color: lookColor = null } = {}) {
    const cfg = VFX.projectile;
    const r = (size > 0 ? size : cfg.defaultSize) * cfg.sizeScale;
    const spec = cfg.shapes[shape] ?? cfg.shapes.orb;
    this.projectiles.launch(from, aim, speed, lookColor ?? spec.color ?? color, onArrive, r, spec);
  }

  /**
   * One-shot layered effect (see VFX in config.js), e.g. VFX.mechExplosion.
   * @param {object[]} layers
   * @param {THREE.Vector3} position  ground point of the effect
   * @param {object} [opts]  { size = 1 (scale multiplier), heightUnit = 1 (layer.height × this) }
   */
  burst(layers, position, { size = 1, heightUnit = 1 } = {}) {
    play('explosion', { position });
    for (const layer of layers) {
      const obj = this.#instance(layer.model, layer.color, layer.textured ?? true);
      if (!obj) continue;
      const base = position.clone();
      base.y += (layer.height ?? 0) * heightUnit;
      const duration = layer.duration;
      let t = -(layer.delay ?? 0);
      obj.visible = false;
      obj.position.copy(base);
      obj.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(obj);
      this.items.push({
        life: duration + (layer.delay ?? 0),
        update: (dt) => {
          t += dt;
          if (t < 0) return;
          const k = Math.min(1, t / duration);
          const s = THREE.MathUtils.lerp(layer.scaleFrom, layer.scaleTo, easeOut(k)) * size;
          obj.visible = true;
          obj.scale.set(s, s * (layer.flatten ?? 1), s);
          obj.rotation.y += (layer.spin ?? 0) * dt;
          setOpacity(obj, THREE.MathUtils.lerp(layer.opacityFrom, layer.opacityTo, k));
          scrollTexture(obj, (layer.scroll ?? 0) * dt);
        },
        dispose: () => this.#release(obj),
      });
    }
  }

  /**
   * Indicator that follows a unit until dispose() is called (stun sparks, flames).
   * @param {object} cfg   VFX.stunIndicator / VFX.burnIndicator
   * @param {THREE.Object3D} unit  followed unit (uses position and aimHeight)
   * @param {number} [scale]  extra size multiplier (crews are small)
   * @returns {{ dispose(): void }}
   */
  attach(cfg, unit, scale = 1) {
    const obj = this.#instance(cfg.model, cfg.color, cfg.textured ?? true);
    if (!obj) return { dispose() {} };
    const offset = new THREE.Vector3();
    if (cfg.spread) { // flames at a random spot on the body
      const r = (unit.radius ?? 1) * cfg.spread;
      const a = Math.random() * Math.PI * 2;
      offset.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
    const phase = Math.random() * Math.PI * 2;
    this.scene.add(obj);
    const item = {
      life: Infinity,
      update: (dt) => {
        obj.position.copy(unit.position).add(offset);
        obj.position.y += (unit.aimHeight ?? 1) * cfg.height;
        obj.rotation.y += (cfg.spin ?? 0) * dt;
        const wave = Math.sin(this.time * (cfg.pulseSpeed ?? cfg.flickerSpeed ?? 0) + phase);
        const s = cfg.scale * scale * (1 + wave * (cfg.pulse ?? cfg.flicker ?? 0));
        obj.scale.set(s, s * (cfg.flatten ?? 1), s);
        setOpacity(obj, cfg.opacity ?? 1);
        scrollTexture(obj, (cfg.scroll ?? 0) * dt);
      },
      dispose: () => this.#release(obj),
    };
    item.update(0);
    this.items.push(item);
    return { dispose: () => { item.life = 0; } };
  }

  /**
   * Straight narrow beam rising from the middle of a building into the sky (R2.hqBeam), in `color`. Follows the
   * building, disappears when `isShown()` is false and is released when the building is destroyed / removed.
   * Purely visual (no simulation state). @param {() => boolean} [isShown]  e.g. fog of war visibility
   * @returns {{ dispose(): void }}
   */
  beam(unit, color, isShown = () => true) {
    const cfg = R2.hqBeam;
    const geo = new THREE.CylinderGeometry(cfg.radius, cfg.radius, cfg.height, cfg.segments, 1, true);
    geo.translate(0, cfg.height / 2, 0); // base at the local origin, rising along +Y
    const coreGeo = new THREE.CylinderGeometry(cfg.radius * cfg.coreRadiusFactor, cfg.radius * cfg.coreRadiusFactor, cfg.height, cfg.segments, 1, true);
    coreGeo.translate(0, cfg.height / 2, 0);
    const makeMat = (opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const mat = makeMat(cfg.opacity);
    const coreMat = makeMat(Math.min(1, cfg.opacity * 1.6));
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geo, mat), new THREE.Mesh(coreGeo, coreMat));
    group.traverse((o) => { if (o.isMesh) { o.renderOrder = VFX.renderOrder; o.castShadow = false; o.receiveShadow = false; o.raycast = () => {}; } });
    this.scene.add(group);
    const phase = (unit.eid ?? 0) * 1.7;
    const item = {
      life: Infinity,
      update: () => {
        if (unit.destroyed || unit.dead || unit.removed) { item.life = 0; return; }
        group.visible = !!isShown();
        group.position.set(unit.position.x, unit.position.y + (unit.bodyHeight ?? 0) * cfg.startFactor, unit.position.z);
        const wave = 1 + cfg.pulse * Math.sin(this.time * cfg.pulseSpeed + phase);
        mat.opacity = cfg.opacity * wave;
        coreMat.opacity = Math.min(1, cfg.opacity * 1.6 * wave);
      },
      dispose: () => { this.scene.remove(group); geo.dispose(); coreGeo.dispose(); mat.dispose(); coreMat.dispose(); },
    };
    item.update();
    this.items.push(item);
    return { dispose: () => { item.life = 0; } };
  }

  update(dt) {
    this.time += dt;
    for (const item of this.items) {
      item.life -= dt;
      if (item.life > 0) item.update(dt, item);
    }
    // Compact in place (no per-frame arrays); dispose() may push new items (a crash explosion) after the compaction
    const items = this.items;
    let n = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.life > 0) items[n++] = item;
      else this.#expired.push(item);
    }
    items.length = n;
    this.#drainExpired();
    this.projectiles.update(dt);
    this.field?.update(dt);
  }

  // Each item leaves the list before its dispose() runs, so a throwing dispose is never repeated and the rest still run
  #drainExpired() {
    const expired = this.#expired;
    let error = null;
    while (expired.length) {
      const item = expired.pop();
      try { item.dispose(); } catch (err) { error ??= err; }
    }
    if (error) throw error;
  }

  /** Ends every live item (projectiles, bursts, indicators, a falling aircraft's ghost) and frees the shared geometry */
  dispose() {
    this.#disposed = true;
    const items = this.items;
    this.items = [];
    for (const item of items) this.#expired.push(item);
    try { this.#drainExpired(); } finally { this.projectiles.dispose(); this.field?.dispose(); this.field = null; }
  }

  #expired = []; // recycled list of items finished this frame
  #disposed = false;

  // Fresh copy of a VFX model with its own glowing, transparent material
  // textured = false drops the (fire) texture, leaving a plain glow in `color` (electric effects)
  #instance(key, color, textured = true) {
    const template = this.templates[key];
    if (!template) return null;
    const obj = template.clone(true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material;
      const map = textured ? src.map?.clone() ?? null : null;
      if (map) { map.wrapS = map.wrapT = THREE.RepeatWrapping; map.needsUpdate = true; }
      o.material = new THREE.MeshBasicMaterial({
        map,
        color: color ?? 0xffffff,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: VFX.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      o.renderOrder = VFX.renderOrder;
      o.castShadow = false;
      o.receiveShadow = false;
    });
    return obj;
  }

  #release(obj) {
    this.scene.remove(obj);
    obj.traverse((o) => { if (o.isMesh) { o.material.map?.dispose(); o.material.dispose(); } });
  }
}

const easeOut = (k) => 1 - (1 - k) * (1 - k);

function setOpacity(obj, opacity) {
  obj.traverse((o) => { if (o.isMesh) o.material.opacity = opacity; });
}

function scrollTexture(obj, amount) {
  if (!amount) return;
  obj.traverse((o) => { if (o.isMesh && o.material.map) o.material.map.offset.y += amount; });
}
