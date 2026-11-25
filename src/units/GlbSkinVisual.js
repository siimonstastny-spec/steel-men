// Steel Men – [W-skin] hand-made GLB robot parts of a faction (models/RobotPartsMercuryDraft) drawn over a ModularMech.
// DISPLAY ONLY (docs/notes/w-glb-skin.md). The simulation body stays the stand-in GLB parts (modelRace, hidden by
// ProcMechVisual exactly like for procedural robots). Every skin mesh follows the rig node of the simulation part with
// the same `_partNN` suffix, so the stand-in's animation clips (walk, attack, hit, death) move the skin too.
// The skin lives under the mech in its own group (never inside a part's hierarchy), so Box3.setFromObject on parts
// (#placeOnGround, wreck landing) and part.meshes (radius, aim height, muzzles) never see it; it is not pickable.
import * as THREE from 'three';
import { GLB_SKINS, HIGHLIGHT, SIM } from '../config.js';
import { loadGltf } from '../core/AssetLoader.js';
import { prepareSkinGltf, findEmblemPlacement, createEmblemMesh, attachTeamPaint, setTeamPaint } from './GlbSkinTexture.js';

export const SKIN_SLOTS = ['legs', 'torso', 'leftArm', 'rightArm'];
const PART_SUFFIX = /_part(\d+)$/;
const loaded = new Map(); // path -> gltf (filled by prepareGlbSkins; sync code reads only this)
const emblems = new Map(); // path -> emblem placement { index, matrix } or null ([W-skin-tex], found once per model)

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);
const HOVER = new THREE.Color(HIGHLIGHT.color);
const noRaycast = () => {};
const NO_OFFSET = new THREE.Matrix4();
const ARM_SLOTS = ['leftArm', 'rightArm'];
// [W-glb-arms] emission pulse of "(Animated)" meshes: phase step per simulation tick, mid / amplitude of the factor
const PULSE = GLB_SKINS.pulse;
const PULSE_STEP = PULSE.speed / SIM.tickRate;
const PULSE_MID = (PULSE.min + PULSE.max) / 2;
const PULSE_AMP = (PULSE.max - PULSE.min) / 2;
let skinSeq = 0; // phase offset of the next skin (creation order; display only)

/** Skin data of a race ({ offset, sets }) or null */
const raceSkin = (race) => (GLB_SKINS.enabled ? GLB_SKINS.races[race] ?? null : null);

/** Skin entry { path, shift } for a mounted part of this race (model side = part.key), or null */
export function skinEntry(race, part) {
  return raceSkin(race)?.sets[part.set]?.[part.key] ?? null;
}

/** A race has any skin at all (decides whether prepareGlbSkins loads something) */
export const hasGlbSkins = (race) => !!raceSkin(race);

/** Loads every skin model of the race into the cache (idempotent); resolves when ready, never rejects */
export function prepareGlbSkins(race) {
  const skin = raceSkin(race);
  if (!skin) return null;
  const jobs = [];
  for (const set of Object.values(skin.sets)) {
    for (const slot of SKIN_SLOTS) {
      const path = set[slot]?.path;
      if (!path || loaded.has(path)) continue;
      jobs.push(loadGltf(path).then((g) => {
        // [W-skin-tex] UVs + shared textures once on the cached model (copies share geometry / textures)
        try { prepareSkinGltf(g); } catch (err) { console.warn(`[GlbSkin] texture ${path}:`, err); }
        loaded.set(path, g);
      })
        .catch((err) => console.warn(`[GlbSkin] ${path}:`, err)));
    }
  }
  return Promise.all(jobs);
}

/** The mounted part has a loaded skin of this race (a captured part of another race has none) */
export function partSkinned(part, race) {
  if (!part || (part.stats.race ?? race) !== race) return false;
  const e = skinEntry(race, part);
  return !!e && loaded.has(e.path);
}

/**
 * The mech is drawn with the skin as soon as ANY mounted part has one ([W-glb-arms]). A part without a skin (other
 * weapon sets, captured parts) stays drawn as its stand-in GLB part, following the same rig.
 */
export function skinReady(mech, race) {
  if (!raceSkin(race)) return false;
  for (const slot of SKIN_SLOTS) if (partSkinned(mech.parts[slot], race)) return true;
  return false;
}

// Per-robot material copies (highlight, darkness, team colour): one copy per source material
class SkinMaterials {
  constructor(teamColor) {
    this.map = new Map(); // source material -> copy
    this.animMap = new Map(); // [W-glb-arms] source material -> copy for "(Animated)" meshes (pulsing emission)
    this.pulsed = [];         // copies in animMap that have an emission
    this.teamColor = teamColor;
    this.highlighted = false;
    this.darkness = 0;
  }

  get(source, animated = false) {
    const map = animated ? this.animMap : this.map;
    let m = map.get(source);
    if (!m) {
      m = source.clone();
      m.userData.skinBase = m.color.clone();
      m.userData.skinEmissive = m.emissive ? m.emissive.clone() : null;
      m.userData.skinEmissiveIntensity = m.emissiveIntensity ?? 1;
      // the torso marks it extras.runtimeColor, legs and arms extras.role
      m.userData.skinTeam = source.userData?.runtimeColor === GLB_SKINS.teamColorTag || source.userData?.role === GLB_SKINS.teamColorTag;
      m.userData.skinEmissiveMap = m.emissiveMap; // [W-skin-tex] dropped while highlighted (the whole part lights up)
      m.userData.skinPaint = attachTeamPaint(m);  // [W-skin-tex round 2] team colour on whole facets (uniforms or null)
      map.set(source, m);
      if (animated && m.emissive) this.pulsed.push(m);
      this.#apply(m);
    }
    return m;
  }

  /** Emission factor of the pulsing copies (a hulk and a highlighted part keep their fixed emission); no allocation */
  setPulse(factor) {
    if (this.highlighted || this.darkness > 0) return;
    for (let i = 0; i < this.pulsed.length; i++) this.pulsed[i].emissiveIntensity = this.pulsed[i].userData.skinEmissiveIntensity * factor;
  }

  setTeamColor(color) { this.teamColor = color; this.#applyAll(); }
  setHighlighted(on) { this.highlighted = on; this.#applyAll(); }
  setDarkness(d) { if (this.darkness === d) return; this.darkness = d; this.#applyAll(); } // a hulk calls it every step

  #applyAll() {
    for (const m of this.map.values()) this.#apply(m);
    for (const m of this.animMap.values()) this.#apply(m);
  }

  #apply(m) {
    const u = m.userData;
    if (u.skinTeam && this.teamColor != null) m.color.set(this.teamColor).multiply(_tint.copy(u.skinBase));
    else m.color.copy(u.skinBase);
    if (this.darkness > 0) m.color.multiplyScalar(1 - this.darkness);
    if (u.skinPaint) setTeamPaint(u.skinPaint, this.teamColor, this.darkness);
    if (!m.emissive) return;
    const emap = this.highlighted ? null : u.skinEmissiveMap;
    if (m.emissiveMap !== emap) { m.emissiveMap = emap; m.needsUpdate = true; }
    if (this.highlighted) { m.emissive.copy(HOVER); m.emissiveIntensity = HIGHLIGHT.intensity; return; }
    m.emissive.copy(u.skinEmissive);
    m.emissiveIntensity = this.darkness > 0 ? 0 : u.skinEmissiveIntensity; // a hulk's photon lights go out
  }

  dispose() {
    for (const m of this.map.values()) m.dispose();
    for (const m of this.animMap.values()) m.dispose();
    this.map.clear();
    this.animMap.clear();
    this.pulsed.length = 0;
  }
}
const _tint = new THREE.Color();

/** Matrix of a mesh inside its glTF scene (skin models keep vertices in part space, nodes are usually identity) */
function sceneMatrix(obj, root, out) {
  out.identity();
  for (let o = obj; o && o !== root; o = o.parent) { o.updateMatrix(); out.premultiply(o.matrix); }
  return out;
}

/**
 * Skin meshes of a part model: [{ mesh, suffix, animated, matrix }] (matrix = mesh in part space incl. the slot shift).
 * [W-glb-arms] An arm mesh under a node without `_partNN` (weapon) gets the wrist suffix; a node named "(Animated)" pulses.
 */
function skinMeshes(entry, slot) {
  const root = loaded.get(entry.path).scene;
  const shift = new THREE.Matrix4().makeTranslation(entry.shift?.[0] ?? 0, entry.shift?.[1] ?? 0, entry.shift?.[2] ?? 0);
  const attach = ARM_SLOTS.includes(slot) ? GLB_SKINS.armAttachPart : null;
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    let suffix = null;
    let animated = false;
    for (let n = o; n && n !== root; n = n.parent) {
      if (suffix === null) suffix = PART_SUFFIX.exec(n.name)?.[1] ?? null;
      if (n.name.includes(PULSE.nodePattern) || (n === o && o.material?.name?.includes?.(PULSE.nodePattern))) animated = true;
    }
    out.push({ mesh: o, suffix: suffix ?? attach, animated, matrix: shift.clone().multiply(sceneMatrix(o, root, new THREE.Matrix4())) });
  });
  return out;
}

/** [W-skin-tex] Emblem placement of a skin model on this slot (ray cast once per model), or null */
function emblemOf(entry, slot, list) {
  if (!emblems.has(entry.path)) emblems.set(entry.path, findEmblemPlacement(slot, list));
  return emblems.get(entry.path);
}

/** A transparent skin mesh (energy field of the shield arm): no shadow, hidden on a hulk */
const isField = (mesh) => !!mesh.material?.transparent;

function cloneMesh(src, mats, animated = false) {
  const mesh = new THREE.Mesh(src.geometry, Array.isArray(src.material) ? src.material.map((m) => mats.get(m, animated)) : mats.get(src.material, animated));
  mesh.castShadow = !isField(mesh);
  mesh.receiveShadow = true;
  mesh.raycast = noRaycast;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Rig nodes of a simulation part by `_partNN` suffix (stops at other parts hanging under it) */
function rigNodes(part) {
  const nodes = new Map();
  const visit = (o) => {
    if (o !== part.object && o.userData.mechPart) return;
    const s = PART_SUFFIX.exec(o.name)?.[1];
    if (s !== undefined && o.userData.gltfNode && !nodes.has(s)) nodes.set(s, o);
    for (const c of o.children) visit(c);
  };
  visit(part.object);
  return nodes;
}

/** Inverse rest transform of a rig node relative to its part root (glTF rest pose, not the current clip pose) */
function restInverse(node, root, out) {
  out.identity();
  for (let o = node; o && o !== root; o = o.parent) {
    const r = o.userData.rest;
    _m.compose(r ? _p.fromArray(r.p) : _p.copy(o.position), r ? _q.fromArray(r.q) : _q.copy(o.quaternion), ONE);
    out.premultiply(_m);
  }
  return out.invert();
}

/**
 * Skin of one mech: a group under the mech; per mounted part, followers of its rig nodes. tick() (every step, after the
 * GLB mixer) copies each followed node's pose in mech space. Duck-types the ProcRobot calls made on mech.procModel
 * (setHighlighted, setPartVisible, setTeamColor, setDarkness, dispose).
 */
export class GlbSkin {
  constructor(mech, race, teamColor) {
    this.mech = mech;
    this.race = race;
    this.isGlbSkin = true;
    this.highlighted = false;
    this.mats = new SkinMaterials(teamColor);
    this.root = new THREE.Group();
    this.root.name = 'glbSkin';
    this.followers = [];          // { node, bind: Matrix4, group }
    this.slots = {};              // slot -> THREE.Group
    this.covered = new Set();     // MechParts drawn by the skin (their GLB meshes stay hidden); others are drawn as GLB
    this.emblems = [];            // [W-skin-tex] emblem decals (shared geometry / material; hidden on a hulk)
    this.fields = [];             // [W-glb-arms] transparent energy fields (hidden on a hulk)
    const off = raceSkin(race).offset ?? [0, 0, 0];
    this.offset = new THREE.Matrix4().makeTranslation(off[0], off[1], off[2]);
    this.lowered = false;         // the legs are skinned: the whole skin is lowered by `offset` (feet on the ground)
    this.phase = (skinSeq++ * PULSE.phaseStep) % (Math.PI * 2); // [W-glb-arms] emission pulse
    this.key = '';
    mech.add(this.root);
  }

  /** Rebuilds the followers for the mech's current parts (part swap); cheap: geometry is shared */
  rebuild(key) {
    this.key = key;
    this.#clear();
    const m = this.mech;
    this.lowered = partSkinned(m.parts.legs, this.race); // parts on stand-in legs stay at the stand-in's sockets
    const offset = this.lowered ? this.offset : NO_OFFSET;
    for (const slot of SKIN_SLOTS) {
      const part = m.parts[slot];
      const slotGroup = new THREE.Group();
      slotGroup.name = `skin_${slot}`;
      this.root.add(slotGroup);
      this.slots[slot] = slotGroup;
      if (!partSkinned(part, this.race)) { slotGroup.visible = false; continue; }
      this.covered.add(part);
      const nodes = rigNodes(part);
      const byNode = new Map(); // node -> follower
      const entry = skinEntry(this.race, part);
      const list = skinMeshes(entry, slot);
      const groups = [];        // list index -> follower group
      for (const s of list) {
        const node = (s.suffix !== null && nodes.get(s.suffix)) || part.object;
        let f = byNode.get(node);
        if (!f) {
          const group = new THREE.Group();
          group.matrixAutoUpdate = false;
          slotGroup.add(group);
          f = { node, root: part.object, rest: restInverse(node, part.object, new THREE.Matrix4()), group, offset };
          byNode.set(node, f);
          this.followers.push(f);
        }
        const mesh = cloneMesh(s.mesh, this.mats, s.animated);
        if (isField(mesh)) { mesh.visible = this.mats.darkness <= 0; this.fields.push(mesh); }
        mesh.matrix.copy(s.matrix);
        f.group.add(mesh);
        groups.push(f.group);
      }
      const em = emblemOf(entry, slot, list); // [W-skin-tex] faction emblem follows the mesh it sits on
      if (em) {
        const mesh = createEmblemMesh(em.matrix);
        mesh.visible = this.mats.darkness <= 0;
        groups[em.index].add(mesh);
        this.emblems.push(mesh);
      }
    }
    this.tick();
  }

  /** Follows the simulation rig (call after the GLB mixer moved it); display only */
  tick() {
    const mech = this.mech;
    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i];
      const mat = f.group.matrix;
      mat.identity();
      for (let o = f.node; o && o !== mech; o = o.parent) { o.updateMatrix(); mat.premultiply(o.matrix); }
      mat.multiply(f.rest).premultiply(f.offset);
      f.group.matrixWorldNeedsUpdate = true;
    }
    if (this.mats.pulsed.length) { // [W-glb-arms] pulsing emission of the "(Animated)" meshes
      this.phase += PULSE_STEP;
      this.mats.setPulse(PULSE_MID + PULSE_AMP * Math.sin(this.phase));
    }
  }

  /** The skin draws this part (else its GLB meshes are shown) */
  covers(part) { return this.covered.has(part); }
  setPartVisible(slot, visible) { if (this.slots[slot]) this.slots[slot].visible = visible && this.covered.has(this.mech.parts[slot]); }
  setHighlighted(on) { this.highlighted = on; this.mats.setHighlighted(on); }
  setTeamColor(color) { this.mats.setTeamColor(color); }
  setDarkness(d) {
    this.mats.setDarkness(d);
    for (let i = 0; i < this.emblems.length; i++) this.emblems[i].visible = d <= 0; // a hulk's emblem goes dark
    for (let i = 0; i < this.fields.length; i++) this.fields[i].visible = d <= 0;   // and its shield field goes out
  }

  #clear() {
    for (const g of Object.values(this.slots)) g.removeFromParent();
    this.slots = {};
    this.followers.length = 0;
    this.emblems.length = 0;
    this.fields.length = 0;
    this.covered.clear();
  }

  dispose() {
    this.#clear();
    this.root.removeFromParent();
    this.mats.dispose(); // geometry belongs to the cached glTF (shared)
  }
}

/**
 * Stand-alone model of one skinned part (arm wreck): the skin meshes in the part's root space, frozen in the rest
 * pose. Returns null when the part has no loaded skin. The group has dispose() / setHighlighted().
 */
export function createSkinPartModel(race, part, teamColor, lowered = true) {
  const e = skinEntry(race, part);
  if (!e || !loaded.has(e.path)) return null;
  const mats = new SkinMaterials(teamColor);
  const group = new THREE.Group();
  group.name = 'glbSkinPart';
  const list = skinMeshes(e, part.slot);
  // the live skin's mech-space offset (feet on the ground), so the torn-off arm does not jump when it becomes a wreck
  const off = lowered ? raceSkin(race).offset ?? [0, 0, 0] : [0, 0, 0];
  const offset = new THREE.Matrix4().makeTranslation(off[0], off[1], off[2]);
  for (const s of list) {
    if (isField(s.mesh)) continue; // a torn-off arm has no energy field
    const mesh = cloneMesh(s.mesh, mats, s.animated);
    mesh.matrix.copy(s.matrix).premultiply(offset);
    group.add(mesh);
  }
  const em = emblemOf(e, part.slot, list); // [W-skin-tex] only a slot with an emblem (torso) gets one
  if (em) group.add(createEmblemMesh(em.matrix.clone().premultiply(offset)));
  group.setHighlighted = (on) => mats.setHighlighted(on);
  group.dispose = () => { group.removeFromParent(); mats.dispose(); };
  return group;
}
