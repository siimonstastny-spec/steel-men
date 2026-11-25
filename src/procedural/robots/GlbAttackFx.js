// Steel Men – muzzle flash layer for GLB mechs (docs/notes/b5-attack-clips.md). Weapons whose GLB part set has no attack
// clip (MechAnimator plays the fallback / a redirected set) get a flash at the weapon's launch socket.
// PURELY READ-ONLY towards the mech: it never writes a transform of any GLB node (no recoil), never calls
// MechPart.muzzlePoint / getWorldPosition / updateMatrixWorld (those refresh matrixWorld caches the simulation reads for the
// projectile start), only reads the current node.matrixWorld. The flashes live in their own group in the scene (not under
// the mech), so Box3.setFromObject(mech), picking, highlight and mech traversals never see them.
// Visual only: time comes from update(dt); update allocates nothing (pool + slots built once); dispose() releases everything.
import * as THREE from 'three';
import { PROC_ROBOTS, ATTACK_CLIP_SET, MUZZLE } from '../../config.js';

const F = PROC_ROBOTS.glbFx;

// ---- shared GPU data (module level, ref-counted by the mechs using it)
let sharedGeo = null;
let geoRefs = 0;
const sharedMats = new Map();   // colour hex -> { mat, refs }

function acquireGeo() {
  if (!sharedGeo) {
    // cone along +Z, base at the muzzle (radius 1, length 1 – scaled per kind)
    sharedGeo = new THREE.ConeGeometry(1, 1, 6, 1, true);
    sharedGeo.rotateX(Math.PI / 2);
    sharedGeo.translate(0, 0, 0.5);
  }
  geoRefs++;
  return sharedGeo;
}

function releaseGeo() {
  if (--geoRefs > 0 || !sharedGeo) return;
  sharedGeo.dispose();
  sharedGeo = null;
}

function acquireMat(hex) {
  let e = sharedMats.get(hex);
  if (!e) {
    const mat = new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    e = { mat, refs: 0 };
    sharedMats.set(hex, e);
  }
  e.refs++;
  return e.mat;
}

function releaseMat(hex) {
  const e = sharedMats.get(hex);
  if (!e || --e.refs > 0) return;
  e.mat.dispose();
  sharedMats.delete(hex);
}

const NO_RAYCAST = () => {};   // flashes are never picked
const _c = new THREE.Color();
const _box = new THREE.Box3();
const _bx = new THREE.Box3();

/** part → { sockets: Object3D[] (launch sockets of this part only), local: Vector3|null (geometry centre in part.object space) } */
const MUZZLE_CACHE = new WeakMap();

// Own copy of MechPart's socket search (read-only; MechPart.muzzles stays untouched), built once per part
function muzzleInfo(part) {
  let info = MUZZLE_CACHE.get(part);
  if (info) return info;
  const sockets = [];
  const visit = (o) => {
    if (o !== part.object && o.userData.mechPart) return;
    if (MUZZLE.socketPatterns.some((re) => re.test(o.name))) sockets.push(o);
    for (let i = 0; i < o.children.length; i++) visit(o.children[i]);
  };
  visit(part.object);
  let local = null;
  if (!sockets.length) {   // no socket: centre of the part's geometry (rest pose, part-local), like MechPart.muzzlePoint
    _box.makeEmpty();
    for (const mesh of part.meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      _box.union(_bx.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    local = _box.isEmpty() ? new THREE.Vector3() : part.object.worldToLocal(_box.getCenter(new THREE.Vector3()));
  }
  info = { sockets, local };
  MUZZLE_CACHE.set(part, info);
  return info;
}

// World position of muzzle `index` from the CURRENT matrixWorld values (read only, no matrix update)
function muzzleWorld(part, index, out) {
  const info = muzzleInfo(part);
  if (info.sockets.length) return out.setFromMatrixPosition(info.sockets[index % info.sockets.length].matrixWorld);
  return out.copy(info.local).applyMatrix4(part.object.matrixWorld);
}

/** Kind of a weapon (PROC_ROBOTS.glbFx.kinds key) or null (melee: nothing to add) */
export function glbFxKind(stats) {
  if (!stats || stats.class === 'melee') return null;
  return F.byShape[stats.projectileShape] ?? F.byClass[stats.class] ?? (stats.projectileColor ? 'beam' : 'gun');
}

/** True when the weapon's set plays no own attack clip: fallback clip or a set borrowed from another (ATTACK_CLIP_SET) */
export const lacksOwnClip = (set, clip) => clip === F.fallbackClip || set in ATTACK_CLIP_SET;

export class GlbAttackFx {
  /** @param {THREE.Object3D} mech  ModularMech – only read (position, rotation, scale, parent, procModel) */
  constructor(mech) {
    this.mech = mech;
    this.group = null;         // own scene group of the flashes (built on the first shot)
    this.flashes = null;       // pool
    this.attacks = [];
    for (let i = 0; i < F.maxAttacks; i++) {
      this.attacks.push({ active: false, part: null, cfg: null, time: 0, next: 0, interval: 0, left: 0, index: 0, hex: 0 });
    }
    this.disposed = false;
  }

  /**
   * One weapon attack (ModularMech.#fireWeapon).
   * @param {object} part   MechPart of the weapon
   * @param {object} stats  weapon stats (class, projectileShape, projectileColor)
   * @param {string|null} clip  clip name MechAnimator.attack returned (null = none played, e.g. firing on the move)
   * @param {number} duration  attackTime (s)
   * @param {number} [shots]   burst
   */
  attack(part, stats, clip, duration, shots = 1) {
    if (this.disposed || (this.mech.procModel && !this.mech.procModel.isGlbSkin)) return false; // a procedural robot draws its own attack; [W-skin] a GLB skin does not
    if (clip && !lacksOwnClip(part.set, clip)) return false;    // the set's own clip carries the weapon
    const kind = glbFxKind(stats);
    const cfg = kind ? F.kinds[kind] : null;
    if (!cfg || part.key === 'legs') return false;
    let e = null;
    for (let i = 0; i < this.attacks.length; i++) {
      const a = this.attacks[i];
      if (a.active && a.part === part) { e = a; break; }
      if (!a.active && !e) e = a;
    }
    if (!e) return false;
    const n = Math.max(1, shots | 0);
    e.active = true; e.part = part; e.cfg = cfg; e.time = 0;
    e.next = duration * cfg.lead; e.interval = (duration * cfg.share) / n; e.left = n; e.index = 0;
    e.hex = _c.set(stats.projectileColor ?? cfg.color).getHex();
    return true;
  }

  /** Call every step (after the mech's animator update; the order does not matter – nothing is written to the mech) */
  update(dt) {
    if (this.disposed) return;
    for (let i = 0; i < this.attacks.length; i++) {
      const e = this.attacks[i];
      if (!e.active) continue;
      if (e.part.mech !== this.mech || !e.part.alive) { e.active = false; e.part = null; continue; }   // arm lost / part dead
      e.time += dt;
      if (e.time >= e.next) {
        this.#flash(e);
        e.left--;
        e.next += e.interval;
        if (e.left <= 0) { e.active = false; e.part = null; }
      }
    }
    if (!this.flashes) return;
    const k = 1 / F.flashTime;
    const m = this.mech;
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (f.timer <= 0) continue;
      f.timer -= dt;
      if (f.timer <= 0) { f.timer = 0; f.mesh.visible = false; continue; }
      const s = f.timer * k * m.scale.x;   // shrinks to nothing
      f.mesh.rotation.y = m.rotation.y;
      f.mesh.scale.set(f.radius * s, f.radius * s, f.length * s);
    }
  }

  #flash(e) {
    const scene = this.mech.parent;
    if (!scene) return;
    if (!this.flashes) {
      const geo = acquireGeo();
      this.group = new THREE.Group();
      this.group.name = 'glbAttackFx';
      this.flashes = [];
      for (let i = 0; i < F.maxFlashes; i++) {
        const mesh = new THREE.Mesh(geo, null);
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.raycast = NO_RAYCAST;
        this.group.add(mesh);
        this.flashes.push({ mesh, timer: 0, radius: 1, length: 1, hex: undefined });
      }
    }
    if (this.group.parent !== scene) scene.add(this.group);
    let f = null;
    for (let i = 0; i < this.flashes.length; i++) if (this.flashes[i].timer <= 0) { f = this.flashes[i]; break; }
    f ??= this.flashes[0];   // all busy: the first slot is reused
    if (f.hex !== e.hex) {   // shared material per colour, ref-counted
      if (f.hex !== undefined) releaseMat(f.hex);
      f.mesh.material = acquireMat(e.hex);
      f.hex = e.hex;
    }
    // world position once per shot from the current matrixWorld (a flash lasts 0.08 s, the drift is negligible)
    muzzleWorld(e.part, e.index++, f.mesh.position);
    f.radius = e.cfg.radius; f.length = e.cfg.length;
    f.timer = F.flashTime;
    f.mesh.visible = true;
  }

  /** Removes the flashes and releases the shared geometry / materials (the mech is never touched) */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of this.attacks) { e.active = false; e.part = null; }
    if (!this.flashes) return;
    this.group.removeFromParent();
    for (const f of this.flashes) if (f.hex !== undefined) releaseMat(f.hex);
    this.flashes = null;
    this.group = null;
    releaseGeo();
  }
}
