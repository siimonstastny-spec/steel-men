// Steel Mans – 3D "hologram" of a mech standing in an assembly bay: the assembly preview and the mech being
// assembled. Static models (no animation, no stats, not pickable) put together like ModularMech (legs → torso
// socket → arm sockets). Each slot shows either its real part or a Frame placeholder (parts not installed yet);
// a slot without a model stays empty. Look: HOLOGRAM in config.js.
import * as THREE from 'three';
import { loadModel } from '../core/AssetLoader.js';
import { SOCKETS, HOLOGRAM } from '../config.js';
import { resetPose } from '../anim/AnimLibrary.js';
import { isLocal } from '../core/LocalPlayer.js';

/**
 * Who may see an assembly hologram of a bay owned by `ownerTeam`: its owner (and allies once the game has
 * alliances – extend here). An enemy who sees the building does not see the mech inside it. null owner = shown.
 */
export function hologramVisibleToLocal(ownerTeam) {
  return ownerTeam == null || isLocal(ownerTeam);
}

const SLOTS = ['legs', 'torso', 'leftArm', 'rightArm'];

export class MechHologram extends THREE.Group {
  constructor() {
    super();
    this.key = '';          // signature of the shown models (rebuilt only when it changes)
    this.building = null;   // pending rebuild (models load asynchronously)
    this.time = 0;
    this.owner = null;      // team of the bay (set it when a hologram may be created for a non-local bay) – see hologramVisibleToLocal
    this.materials = {
      part: new THREE.MeshBasicMaterial({ color: HOLOGRAM.partColor, transparent: true, opacity: HOLOGRAM.partOpacity,
        depthWrite: false, blending: THREE.AdditiveBlending }),
      frame: new THREE.MeshBasicMaterial({ color: HOLOGRAM.frameColor, transparent: true, opacity: HOLOGRAM.frameOpacity,
        depthWrite: false, blending: THREE.AdditiveBlending, wireframe: HOLOGRAM.frameWireframe }),
    };
    this.seenByLocal = false; // enemy bay currently visible to the local player (fog) – display only, never read by the simulation
    this.visible = false;
  }

  /**
   * Shows the given models. @param {object} slots  { legs, torso, leftArm, rightArm } → { path, frame } | null
   * (frame = placeholder look). Does nothing when nothing changed.
   */
  show(slots) {
    const key = SLOTS.map((s) => (slots[s] ? `${slots[s].path}${slots[s].frame ? '#f' : ''}` : '-')).join('|');
    this.visible = this.#mayShow();
    if (key === this.key) return;
    this.key = key;
    const job = this.#build(slots).then((root) => {
      if (this.building !== job || !root) return;
      this.clear();
      this.add(root);
    }).catch((err) => console.error(err));
    this.building = job;
  }

  hide() { this.visible = false; }

  // Own bay: always; an enemy bay only while the owner of the view sees it (RobotProduction sets seenByLocal each frame)
  #mayShow() { return hologramVisibleToLocal(this.owner) || this.seenByLocal; }

  update(dt) {
    if (this.key && !this.#mayShow()) this.visible = false; // owner changed / local team switched / bay left the fog view
    if (!this.visible) return;
    this.time += dt;
    const pulse = 1 + HOLOGRAM.pulse * Math.sin(this.time * HOLOGRAM.pulseSpeed);
    this.materials.part.opacity = HOLOGRAM.partOpacity * pulse;
    this.materials.frame.opacity = HOLOGRAM.frameOpacity * pulse;
  }

  dispose() {
    this.removeFromParent();
    Object.values(this.materials).forEach((m) => m.dispose());
  }

  async #build(slots) {
    if (!slots.legs) return null;
    const entries = SLOTS.filter((s) => slots[s]);
    const objects = await Promise.all(entries.map((s) => loadModel(slots[s].path)));
    const obj = Object.fromEntries(entries.map((s, i) => [s, objects[i]]));
    for (const s of entries) {
      resetPose(obj[s]);
      const mat = slots[s].frame ? this.materials.frame : this.materials.part;
      obj[s].traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; o.raycast = () => {}; } });
    }
    const root = new THREE.Group();
    root.add(obj.legs);
    const socket = (parent, name) => parent.getObjectByName(name) ?? parent;
    if (obj.torso) {
      socket(obj.legs, SOCKETS.torso).add(obj.torso);
      for (const s of ['leftArm', 'rightArm']) if (obj[s]) socket(obj.torso, SOCKETS[s]).add(obj[s]);
    }
    // Feet on the group's y = 0 (the legs' origin is in the pelvis)
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj.legs);
    obj.legs.position.y = -box.min.y;
    return root;
  }
}

/**
 * Hologram of ONE part being mounted on a real mech (service in an assembly bay, Repair.js): it sits in the
 * part's slot of the mech, and the part it replaces is hidden meanwhile. While the real part is being put on
 * (task.mounting – the model loads) the hologram is taken away, so it never counts into the mech's new size.
 */
export class PartHologram {
  constructor() {
    this.material = new THREE.MeshBasicMaterial({ color: HOLOGRAM.partColor, transparent: true, opacity: HOLOGRAM.partOpacity,
      depthWrite: false, blending: THREE.AdditiveBlending });
    this.target = null;   // { mech, slot, path } shown now
    this.object = null;
    this.job = null;
    this.hiddenPart = null; // MechPart whose own meshes are hidden
    this.time = 0;
  }

  /** Shows `path` in the slot of the mech (mounting = the real part is going on: hologram gone, old part still hidden) */
  show(mech, slot, path, { mounting = false } = {}) {
    if (!hologramVisibleToLocal(mech.team)) { this.hide(); return; } // enemy service is not shown
    const t = this.target;
    if (!t || t.mech !== mech || t.slot !== slot || t.path !== path) {
      this.hide();
      this.target = { mech, slot, path };
      this.#setPartHidden(mech.parts[slot] ?? null);
      const job = loadModel(path).then((obj) => {
        if (this.job !== job) return;
        resetPose(obj);
        obj.traverse((o) => { if (o.isMesh) { o.material = this.material; o.castShadow = false; o.receiveShadow = false; o.raycast = () => {}; } });
        this.object = obj;
      }).catch((err) => console.error(err));
      this.job = job;
    }
    if (mounting) this.object?.removeFromParent();
    else if (this.object && !this.object.parent) this.#mount(mech, slot, this.object);
  }

  hide() {
    this.job = null;
    this.object?.removeFromParent();
    this.object = null;
    this.target = null;
    this.#setPartHidden(null);
  }

  update(dt) {
    if (!this.object) return;
    this.time += dt;
    this.material.opacity = HOLOGRAM.partOpacity * (1 + HOLOGRAM.pulse * Math.sin(this.time * HOLOGRAM.pulseSpeed));
  }

  dispose() { this.hide(); this.material.dispose(); }

  // Same place as ModularMech mounts the real part: arm sockets of the torso, torso socket of the legs, legs on the root
  #mount(mech, slot, obj) {
    obj.position.set(0, 0, 0);
    obj.quaternion.identity();
    obj.scale.set(1, 1, 1);
    if (slot === 'legs') {
      obj.position.y = mech.parts.legs?.object.position.y ?? 0;
      mech.add(obj);
    } else if (slot === 'torso') {
      const legs = mech.parts.legs.object;
      (legs.getObjectByName(SOCKETS.torso) ?? legs).add(obj);
    } else {
      mech.sockets[slot]?.add(obj);
    }
  }

  // Hides the part's own meshes (not the parts mounted on it), shows the previously hidden one again
  #setPartHidden(part) {
    const set = (p, visible) => {
      const mech = p.mech;
      const others = new Set(Object.values(mech?.parts ?? {}).filter((o) => o !== p).map((o) => o.object));
      const walk = (o) => {
        if (others.has(o) || o === this.object) return;
        if (o.isMesh) o.visible = visible;
        o.children.forEach(walk);
      };
      walk(p.object);
    };
    if (this.hiddenPart && this.hiddenPart !== part) set(this.hiddenPart, true);
    this.hiddenPart = part;
    if (part) set(part, false);
  }
}
