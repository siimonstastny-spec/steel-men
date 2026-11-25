// Steel Men – blood stains: decals on the terrain where a crew squad died. Display only (not simulation):
// one InstancedMesh, one shared canvas texture, a ring buffer of BLOOD_STAINS.max, fade-out by age.
// Own PRNG (never world.rng): rotation / size / scatter do not touch the deterministic state.
import * as THREE from 'three';
import { BLOOD_STAINS as B } from '../config.js';

const UP = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class BloodStains {
  /** @param {object} world  needs scene, heightAt(x, z), optional fog (FogOfWar.patchMaterial) */
  constructor(world) {
    this.world = world;
    this.enabled = B.enabled;
    this.used = 0;      // instances in use (grows to B.max)
    this.next = 0;      // ring buffer cursor
    this.ages = new Float32Array(B.max);
    this.alive = new Uint8Array(B.max);
    this.rng = B.texture.seed;
    this.mesh = null;
    this.onDied = (e) => this.spawnForCrew(e.detail?.crew); // listener (kept for removeEventListener)
    if (!this.enabled) return;

    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2); // lies flat, faces up
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(B.max), 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAlpha', this.alphaAttr);
    this.texture = this.#makeTexture();
    const material = new THREE.MeshBasicMaterial({
      map: this.texture, color: B.color, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: B.polygonOffset, polygonOffsetUnits: B.polygonOffset,
    });
    world.fog?.patchMaterial(material); // darkened by the fog of war like the terrain
    const fogPatch = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      fogPatch?.(shader, renderer);
      // FogOfWar.patchMaterial reads the fog at modelMatrix * position, which ignores instanceMatrix: every stain
      // would sample the fog at the map origin. Use the instance's world position.
      shader.vertexShader = shader.vertexShader
        .replace('vec4 fogWorldPos = modelMatrix * vec4(transformed, 1.0);',
          'vec4 fogLocalPos = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nfogLocalPos = instanceMatrix * fogLocalPos;\n#endif\nvec4 fogWorldPos = modelMatrix * fogLocalPos;');
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
    };
    material.customProgramCacheKey = () => 'bloodStains';
    material.needsUpdate = true;

    this.mesh = new THREE.InstancedMesh(geometry, material, B.max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances spread over the whole map
    this.mesh.renderOrder = B.renderOrder;
    this.mesh.raycast = () => {};    // never picked
    world.scene.add(this.mesh);
    window.addEventListener(B.event, this.onDied);
  }

  /** One or more stains per member of a dead squad, at the places they fell (squad position + member offsets) */
  spawnForCrew(crew) {
    if (!this.mesh || !crew) return;
    crew.updateMatrixWorld(true);
    for (const member of crew.members) {
      member.object.getWorldPosition(_pos);
      for (let i = 0; i < B.perMember; i++) this.spawn(_pos.x, _pos.z);
    }
  }

  /** One stain at (x, z): random scatter / rotation / size, tilted to the terrain normal */
  spawn(x, z) {
    if (!this.mesh) return;
    const a = this.#random() * Math.PI * 2;
    const d = Math.sqrt(this.#random()) * B.scatter;
    const px = x + Math.sin(a) * d;
    const pz = z + Math.cos(a) * d;
    const size = B.size[0] + this.#random() * (B.size[1] - B.size[0]);
    const h = this.world.heightAt(px, pz);
    const e = B.normalStep;
    const dx = this.world.heightAt(px + e, pz) - this.world.heightAt(px - e, pz);
    const dz = this.world.heightAt(px, pz + e) - this.world.heightAt(px, pz - e);
    _normal.set(-dx / (2 * e), 1, -dz / (2 * e));
    const slope = Math.hypot(_normal.x, _normal.z);
    _normal.normalize();
    _q.setFromUnitVectors(UP, _normal);
    _qYaw.setFromAxisAngle(UP, this.#random() * Math.PI * 2);
    _q.multiply(_qYaw);
    _pos.set(px, h + B.heightOffset + slope * size * B.sizeHalf * B.slopeOffset, pz);
    _scale.set(size, 1, size);
    this.mesh.setMatrixAt(this.next, _m.compose(_pos, _q, _scale));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.ages[this.next] = 0;
    this.alive[this.next] = 1;
    this.alphaAttr.array[this.next] = B.alpha;
    this.alphaAttr.needsUpdate = true;
    this.mesh.count = Math.max(this.mesh.count, this.next + 1);
    this.next = (this.next + 1) % B.max;
    this.used = Math.min(B.max, this.used + 1);
  }

  /** Ages the stains, fades the old ones; dt = frame time (visual only) */
  update(dt) {
    if (!this.mesh || this.used === 0) return;
    const fadeStart = B.lifetime - B.fadeTime;
    const arr = this.alphaAttr.array;
    let changed = false;
    let top = 0; // highest living index + 1: faded-out instances are not drawn
    for (let i = 0; i < this.used; i++) {
      if (!this.alive[i]) continue;
      const age = (this.ages[i] += dt);
      if (age >= fadeStart) {
        arr[i] = age >= B.lifetime ? 0 : B.alpha * (B.lifetime - age) / B.fadeTime;
        if (age >= B.lifetime) this.alive[i] = 0;
        changed = true;
      }
      if (this.alive[i]) top = i + 1;
    }
    this.mesh.count = top;
    if (changed) this.alphaAttr.needsUpdate = true;
  }

  dispose() {
    window.removeEventListener(B.event, this.onDied);
    if (!this.mesh) return;
    this.world.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.texture.dispose();
    this.mesh = null;
  }

  // Own xorshift32 (display only); not the simulation's world.rng
  #random() {
    let s = this.rng;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.rng = s || 1;
    return this.rng / 4294967296;
  }

  // Soft dark blobs and droplets on a transparent canvas; the colour comes from the material (white-ish grey here)
  #makeTexture() {
    const cfg = B.texture;
    const size = cfg.size;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    let seed = cfg.seed;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const blob = (x, y, r, alpha) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${alpha})`);
      g.addColorStop(cfg.gradientMid, `rgba(255,255,255,${alpha * cfg.gradientMidAlpha})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    const c = size / 2;
    const range = ([lo, hi]) => lo + rnd() * (hi - lo);
    blob(c, c, size * cfg.mainRadius, cfg.mainAlpha);
    for (let i = 0; i < cfg.blobs; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * size * cfg.blobSpread;
      blob(c + Math.cos(a) * d, c + Math.sin(a) * d, size * range(cfg.blobRadius), cfg.blobAlpha);
    }
    for (let i = 0; i < cfg.droplets; i++) {
      const a = rnd() * Math.PI * 2;
      const d = size * range(cfg.dropletDistance);
      blob(c + Math.cos(a) * d, c + Math.sin(a) * d, size * range(cfg.dropletRadius), cfg.dropletAlpha);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
}
