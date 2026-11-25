// Steel Men – [W-skin] hand-made GLB robot parts drawn over a ModularMech; [basic-m1] every race (docs/notes/basic-m1-skins.md).
// DISPLAY ONLY (docs/notes/w-glb-skin.md). The simulation body stays the stand-in GLB parts (hidden by ProcMechVisual
// exactly like for procedural robots). Every skin mesh follows a rig node of the simulation part – paired by tree
// position ('native' style) or by the `_partNN` suffix ('draft') – so the stand-in's clips (walk, attack, hit, death)
// move the skin too. A skin socket that lies elsewhere than the stand-in's moves everything mounted on it; a mounted
// part without a skin above such a socket is redrawn by the skin (copies of its GLB meshes, sharing their materials).
// The skin lives under the mech in its own group (never inside a part's hierarchy), so Box3.setFromObject on parts
// (#placeOnGround, wreck landing) and part.meshes (radius, aim height, muzzles) never see it; it is not pickable.
import * as THREE from 'three';
import { GLB_SKINS, HIGHLIGHT, SIM, SOCKETS, TEAMS } from '../config.js';
import { loadGltf } from '../core/AssetLoader.js';
import { isDataOnlyPart } from '../data/Stats.js';
import { prepareSkinGltf, findEmblemPlacement, createEmblemMesh, attachTeamPaint, setTeamPaint } from './GlbSkinTexture.js';

export const SKIN_SLOTS = ['legs', 'torso', 'leftArm', 'rightArm'];
const PART_SUFFIX = /_part(\d+)$/;
const loaded = new Map();  // path -> skin model root (the glTF scene holding the nodes; sync code reads only this)
const pending = new Map(); // path -> load promise (one load per model, however many races / robots ask)
const emblems = new Map(); // path -> emblem placement { index, matrix } or null ([W-skin-tex], found once per model)
const sockets = new Map(); // [basic-m1] path -> Map(socket name -> part-space position or null), measured once per model
const normalized = new WeakMap(); // config entry -> { path, shift, mechOffset, style }

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);
const HOVER = new THREE.Color(HIGHLIGHT.color);
const IDENTITY = new THREE.Matrix4();
const noRaycast = () => {};
const ARM_SLOTS = ['leftArm', 'rightArm'];
const NATIVE = GLB_SKINS.nativePaint;
// Rec. 709 luminance weights of linear RGB (relative luminance of a colour)
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
// [W-glb-arms] emission pulse of "(Animated)" meshes: phase step per simulation tick, mid / amplitude of the factor
const PULSE = GLB_SKINS.pulse;
const PULSE_STEP = PULSE.speed / SIM.tickRate;
const PULSE_MID = (PULSE.min + PULSE.max) / 2;
const PULSE_AMP = (PULSE.max - PULSE.min) / 2;
let skinSeq = 0; // phase offset of the next skin (creation order; display only)

/** Skin data of a race ({ enabled, sets }) or null – config only, so it may decide what a robot loads */
function raceSkin(race) {
  if (!GLB_SKINS.enabled) return null;
  const r = GLB_SKINS.races[race];
  return r && r.enabled !== false ? r : null;
}

/** [basic-m1] Display switch: window.steelMen.glbSkins = false draws the stand-in GLB parts again (next sync) */
const skinsOn = () => GLB_SKINS.enabled && globalThis.window?.steelMen?.glbSkins !== false;

/** [basic-m1] Style of a set ({ bind, runtimeTexture, paint }) */
const styleOf = (set) => GLB_SKINS.styles[set.style ?? GLB_SKINS.defaultStyle] ?? GLB_SKINS.styles[GLB_SKINS.defaultStyle];

/** Config entry with its set's style (cached per entry, no allocation on later lookups) */
function normalize(raw, set) {
  let e = normalized.get(raw);
  if (!e) {
    e = { path: raw.path, shift: raw.shift ?? null, mechOffset: raw.mechOffset ?? null, style: styleOf(set) };
    normalized.set(raw, e);
  }
  return e;
}

/** [basic-m1] Race whose skin draws a part: the race that made it, else the mech's (a captured part keeps its look) */
const partRace = (part, race) => part.stats?.race ?? race;

/** Skin entry { path, shift, mechOffset, style } of a mounted part (model side = part.key), or null */
export function skinEntry(race, part) {
  const set = raceSkin(partRace(part, race))?.sets[part.set];
  const raw = set && set.enabled !== false ? set[part.key] : null;
  return raw?.path ? normalize(raw, set) : null;
}

/** A race has any skin at all (decides whether a robot of it loads skins and gets a ProcMechVisual) */
export const hasGlbSkins = (race) => !!raceSkin(race);

/** Loads every skin model of the race into the cache (idempotent); resolves when ready, never rejects */
export function prepareGlbSkins(race) {
  const skin = raceSkin(race);
  if (!skin) return null;
  const jobs = [];
  for (const set of Object.values(skin.sets)) {
    if (set.enabled === false) continue;
    for (const slot of SKIN_SLOTS) if (set[slot]?.path) jobs.push(loadSkin(normalize(set[slot], set)));
  }
  return Promise.all(jobs);
}

function loadSkin(entry) {
  const path = entry.path;
  let job = pending.get(path);
  if (job) return job;
  job = loadGltf(path).then((g) => {
    const root = modelRoot(g);
    markSkinNodes(g, root);
    // [W-skin-tex] UVs + shared textures once on the cached model (copies share geometry / textures); never on
    // 'native' models (own UVs, texture and logo)
    if (entry.style.runtimeTexture) {
      try { prepareSkinGltf(g); } catch (err) { console.warn(`[GlbSkin] texture ${path}:`, err); }
    }
    loaded.set(path, root);
  }).catch((err) => {
    console.warn(`[GlbSkin] ${path}:`, err);
    pending.delete(path); // a failed load may be tried again by the next robot
  });
  pending.set(path, job);
  return job;
}

/** [basic-m1] The glTF scene that holds the nodes (the Blender export of some M1 models names an empty default scene) */
function modelRoot(gltf) {
  if (gltf.scene.children.length) return gltf.scene;
  return gltf.scenes.find((s) => s.children.length) ?? gltf.scene;
}

/** [basic-m1] Marks the glTF nodes of the skin model (userData.skinNode); a multi-material mesh is a group of meshes */
function markSkinNodes(gltf, root) {
  root.traverse((o) => {
    if (gltf.parser.associations.get(o)?.nodes !== undefined) o.userData.skinNode = true;
  });
}

/**
 * [basic-m1] Loads the skins of mounted parts whose race's models are not loaded yet (a part picked up from another
 * race). Returns a promise to sync the display after, or null when nothing is missing.
 */
export function missingGlbSkins(mech, race) {
  let jobs = null;
  for (const slot of SKIN_SLOTS) {
    const part = mech.parts[slot];
    const e = part ? skinEntry(race, part) : null;
    if (!e || loaded.has(e.path)) continue;
    (jobs ??= []).push(prepareGlbSkins(partRace(part, race)));
  }
  return jobs ? Promise.all(jobs) : null;
}

/** The mounted part has a loaded skin (of the race that made it) and skins are on */
export function partSkinned(part, race) {
  if (!part || !skinsOn()) return false;
  const e = skinEntry(race, part);
  return !!e && loaded.has(e.path);
}

/**
 * The mech is drawn with the skin as soon as ANY mounted part has one ([W-glb-arms]). A part without a skin (other
 * weapon sets) stays drawn as its stand-in GLB part, following the same rig ([basic-m1] or redrawn by the skin when a
 * skin socket under it moved).
 */
export function skinReady(mech, race) {
  if (!skinsOn()) return false;
  let any = false;
  for (const slot of SKIN_SLOTS) {
    const part = mech.parts[slot];
    if (partSkinned(part, race)) any = true;
    // [basic-m1] a data-only part without a skin has only a placeholder GLB: the procedural robot draws that mech
    else if (part && isDataOnlyPart(part.stats)) return false;
  }
  return any;
}

/** [basic-m1] Colour of a mounted part: its paint team's (a captured part keeps the painter's until an assembly bay) */
function paintColor(mech, part) {
  return TEAMS[part.paintTeam ?? mech.team]?.color ?? TEAMS[mech.team]?.color;
}

/** [basic-m1] 'native' team paint: the owner's colour, luminance clamped (no allocation) */
function nativePaint(color, out) {
  out.set(color);
  const lum = LUMA_R * out.r + LUMA_G * out.g + LUMA_B * out.b;
  if (lum < NATIVE.minLum) out.lerp(_white, (NATIVE.minLum - lum) / (1 - lum));
  else if (lum > NATIVE.maxLum) out.multiplyScalar(NATIVE.maxLum / lum);
  return out;
}
const _white = new THREE.Color(1, 1, 1);

/** [basic-m1] Team-painted glow: the team hue at the source emission's brightness (brightest channel) */
function nativeGlow(source, color, out) {
  out.set(color);
  const top = Math.max(out.r, out.g, out.b);
  return top > 0 ? out.multiplyScalar(Math.max(source.r, source.g, source.b) / top) : out.copy(source);
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

  /** Per-robot copy of a source material; style = the model's set style ([basic-m1] paint mode, runtime texture) */
  get(source, animated, style) {
    const map = animated ? this.animMap : this.map;
    let m = map.get(source);
    if (!m) {
      m = source.clone();
      m.userData.skinBase = m.color.clone();
      m.userData.skinEmissive = m.emissive ? m.emissive.clone() : null;
      m.userData.skinEmissiveIntensity = m.emissiveIntensity ?? 1;
      // the torso marks it extras.runtimeColor, legs and arms extras.role
      m.userData.skinTeam = source.userData?.runtimeColor === GLB_SKINS.teamColorTag || source.userData?.role === GLB_SKINS.teamColorTag;
      m.userData.skinNative = style.paint === 'native'; // [basic-m1] team paint = the owner's colour (not a tint of it)
      m.userData.skinEmissiveMap = m.emissiveMap; // [W-skin-tex] dropped while highlighted (the whole part lights up)
      // [W-skin-tex round 2] team colour on whole facets (uniforms or null); only on models with the runtime texture
      m.userData.skinPaint = style.runtimeTexture ? attachTeamPaint(m) : null;
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
    const team = u.skinTeam && this.teamColor != null;
    if (team && u.skinNative) nativePaint(this.teamColor, m.color);
    else if (team) m.color.set(this.teamColor).multiply(_tint.copy(u.skinBase));
    else m.color.copy(u.skinBase);
    if (this.darkness > 0) m.color.multiplyScalar(1 - this.darkness);
    if (u.skinPaint) setTeamPaint(u.skinPaint, this.teamColor, this.darkness);
    if (!m.emissive) return;
    const emap = this.highlighted ? null : u.skinEmissiveMap;
    if (m.emissiveMap !== emap) { m.emissiveMap = emap; m.needsUpdate = true; }
    if (this.highlighted) { m.emissive.copy(HOVER); m.emissiveIntensity = HIGHLIGHT.intensity; return; }
    if (team && u.skinNative) nativeGlow(u.skinEmissive, this.teamColor, m.emissive); // [basic-m1] team neon
    else m.emissive.copy(u.skinEmissive);
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
 * Skin meshes of a part model: [{ mesh, suffix, skinNode, animated, matrix }] (matrix = mesh in part space incl. the
 * entry shift; skinNode = the glTF node the mesh belongs to, for tree pairing). Allocates: rebuild / wreck only.
 * [W-glb-arms] A draft arm mesh under a node without `_partNN` (weapon) gets the wrist suffix; "(Animated)" pulses.
 */
function skinMeshes(entry, slot) {
  const root = loaded.get(entry.path);
  const shift = new THREE.Matrix4().makeTranslation(entry.shift?.[0] ?? 0, entry.shift?.[1] ?? 0, entry.shift?.[2] ?? 0);
  const attach = entry.style.bind !== 'tree' && ARM_SLOTS.includes(slot) ? GLB_SKINS.armAttachPart : null;
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    let suffix = null;
    let skinNode = null;
    let animated = false;
    for (let n = o; n && n !== root; n = n.parent) {
      if (suffix === null) suffix = PART_SUFFIX.exec(n.name)?.[1] ?? null;
      if (!skinNode && n.userData.skinNode) skinNode = n;
      if (n.name.includes(PULSE.nodePattern) || (n === o && o.material?.name?.includes?.(PULSE.nodePattern))) animated = true;
    }
    out.push({ mesh: o, suffix: suffix ?? attach, skinNode, animated, matrix: shift.clone().multiply(sceneMatrix(o, root, new THREE.Matrix4())) });
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

function cloneMesh(src, mats, animated, style) {
  const mesh = new THREE.Mesh(src.geometry, Array.isArray(src.material) ? src.material.map((m) => mats.get(m, animated, style)) : mats.get(src.material, animated, style));
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

/** Rest transform of a rig node relative to its part root (glTF rest pose, not the current clip pose) */
function restMatrix(node, root, out) {
  out.identity();
  for (let o = node; o && o !== root; o = o.parent) {
    const r = o.userData.rest;
    _m.compose(r ? _p.fromArray(r.p) : _p.copy(o.position), r ? _q.fromArray(r.q) : _q.copy(o.quaternion), ONE);
    out.premultiply(_m);
  }
  return out;
}

/** Inverse rest transform of a rig node relative to its part root */
const restInverse = (node, root, out) => restMatrix(node, root, out).invert();

// [basic-m1] tree pairing of a 'native' skin model with the stand-in rig (like AnimLibrary.bindPart): root with root,
// then each skin child with the nearest unused rig child by rest position (part trees match, node names do not)
const isRigNode = (o) => o.userData.gltfNode && !!o.userData.rest && !o.userData.mechPart && !o.name.startsWith('socket_');
const isSkinNode = (o) => o.userData.skinNode && !o.name.startsWith('socket_');

/** Skin node -> rig node of the part (allocates: rebuild only) */
function pairTree(skinRoot, part) {
  const pairs = new Map();
  const rig = part.object.children.find(isRigNode);
  const top = skinRoot.children.find(isSkinNode);
  if (rig && top) pairNode(top, rig, pairs, GLB_SKINS.bindMaxDistance ** 2);
  return pairs;
}

function pairNode(skin, rig, pairs, maxSq) {
  pairs.set(skin, rig);
  const rigKids = rig.children.filter(isRigNode);
  const used = new Set();
  for (const child of skin.children) {
    if (!isSkinNode(child)) continue;
    let best = null;
    let bestSq = maxSq;
    for (const k of rigKids) {
      if (used.has(k)) continue;
      const d = child.position.distanceToSquared(_v.fromArray(k.userData.rest.p));
      if (d < bestSq) { bestSq = d; best = k; }
    }
    if (!best) continue; // no counterpart nearby: its meshes follow the paired parent
    used.add(best);
    pairNode(child, best, pairs, maxSq);
  }
}

/** [basic-m1] Part-space position of a socket of the skin model incl. the entry shift (cached per model), or null */
function skinSocket(entry, name) {
  let map = sockets.get(entry.path);
  if (!map) { map = new Map(); sockets.set(entry.path, map); }
  if (!map.has(name)) {
    const root = loaded.get(entry.path);
    const node = root.getObjectByName(name);
    let pos = null;
    if (node) {
      pos = new THREE.Vector3().setFromMatrixPosition(sceneMatrix(node, root, new THREE.Matrix4()));
      if (entry.shift) pos.add(_v.fromArray(entry.shift));
    }
    map.set(name, pos);
  }
  return map.get(name);
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
    this.darkness = 0;
    this.teamColor = teamColor;   // fallback colour of a slot whose part has no paint team
    this.root = new THREE.Group();
    this.root.name = 'glbSkin';
    this.followers = [];          // { node, rest: Matrix4, group }
    this.proxies = [];            // [basic-m1] { src, mesh } GLB meshes of an unskinned part redrawn above a moved socket
    this.slots = {};              // slot -> THREE.Group
    this.slotMats = {};           // [basic-m1] slot -> SkinMaterials (each part in its own paint team's colour)
    this.matList = [];            // the same SkinMaterials as a list (loops without allocation)
    this.covered = new Set();     // MechParts drawn by the skin (their GLB meshes stay hidden); others are drawn as GLB
    this.emblems = [];            // [W-skin-tex] emblem decals (shared geometry / material; hidden on a hulk)
    this.fields = [];             // [W-glb-arms] transparent energy fields (hidden on a hulk)
    // [basic-m1] mech-space offset of the whole drawing (mounted skinned legs' mechOffset) and the socket shifts: a
    // stand-in socket object (or null) + the translation by which the skin model's socket of that name lies elsewhere
    this.offset = new THREE.Matrix4();
    this.torsoSocket = null;
    this.torsoShift = new THREE.Matrix4();
    this.leftSocket = null;
    this.leftShift = new THREE.Matrix4();
    this.rightSocket = null;
    this.rightShift = new THREE.Matrix4();
    this.lowered = false;         // kept for ProcMechVisual.createArmWreckView (a torn-off arm is drawn without offsets)
    this.phase = (skinSeq++ * PULSE.phaseStep) % (Math.PI * 2); // [W-glb-arms] emission pulse
    this.key = '';
    mech.add(this.root);
  }

  /** Rebuilds the followers for the mech's current parts (part swap); cheap: geometry is shared */
  rebuild(key) {
    this.key = key;
    this.#clear();
    const m = this.mech;
    this.#measureSockets();
    for (const slot of SKIN_SLOTS) {
      const part = m.parts[slot];
      const slotGroup = new THREE.Group();
      slotGroup.name = `skin_${slot}`;
      this.root.add(slotGroup);
      this.slots[slot] = slotGroup;
      if (part && partSkinned(part, this.race)) this.#buildSkin(slot, part, slotGroup);
      else if (part && this.#moved(slot)) this.#buildProxy(part, slotGroup);
      else slotGroup.visible = false;
    }
    this.tick();
  }

  // [basic-m1] Socket shifts of the current parts: skinned legs move the torso socket, a skinned torso its arm sockets
  #measureSockets() {
    const { legs, torso } = this.mech.parts;
    this.offset.identity();
    this.torsoSocket = this.leftSocket = this.rightSocket = null;
    if (partSkinned(legs, this.race)) {
      const e = skinEntry(this.race, legs);
      if (e.mechOffset) this.offset.makeTranslation(e.mechOffset[0], e.mechOffset[1], e.mechOffset[2]);
      this.torsoSocket = socketShift(legs, e, SOCKETS.torso, this.torsoShift);
    }
    if (partSkinned(torso, this.race)) {
      const e = skinEntry(this.race, torso);
      this.leftSocket = socketShift(torso, e, SOCKETS.leftArm, this.leftShift);
      this.rightSocket = socketShift(torso, e, SOCKETS.rightArm, this.rightShift);
    }
  }

  /** A socket under this slot moved: a part there without a skin must be redrawn by the skin to follow it */
  #moved(slot) {
    if (slot === 'legs') return false;
    if (this.torsoSocket) return true;
    return slot === 'leftArm' ? !!this.leftSocket : slot === 'rightArm' ? !!this.rightSocket : false;
  }

  /** Per-slot materials in the part's paint colour, with the skin's current highlight / darkness */
  #mats(slot, part) {
    const mats = new SkinMaterials(paintColor(this.mech, part) ?? this.teamColor);
    mats.highlighted = this.highlighted;
    mats.darkness = this.darkness;
    this.slotMats[slot] = mats;
    this.matList.push(mats);
    return mats;
  }

  #buildSkin(slot, part, slotGroup) {
    this.covered.add(part);
    const entry = skinEntry(this.race, part);
    const mats = this.#mats(slot, part);
    const tree = entry.style.bind === 'tree';
    const pairs = tree ? pairTree(loaded.get(entry.path), part) : null;
    const nodes = tree ? null : rigNodes(part);
    const byNode = new Map(); // node -> follower
    const list = skinMeshes(entry, slot);
    const groups = [];        // list index -> follower group
    for (const s of list) {
      let node = null;
      if (tree) for (let n = s.skinNode; n && !node; n = n.parent) node = pairs.get(n) ?? null;
      else if (s.suffix !== null) node = nodes.get(s.suffix) ?? null;
      node ??= part.object;
      let f = byNode.get(node);
      if (!f) {
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        slotGroup.add(group);
        f = { node, rest: restInverse(node, part.object, new THREE.Matrix4()), group };
        byNode.set(node, f);
        this.followers.push(f);
      }
      const mesh = cloneMesh(s.mesh, mats, s.animated, entry.style);
      if (isField(mesh)) { mesh.visible = this.darkness <= 0; this.fields.push(mesh); }
      mesh.matrix.copy(s.matrix);
      f.group.add(mesh);
      groups.push(f.group);
    }
    const em = entry.style.runtimeTexture ? emblemOf(entry, slot, list) : null; // [W-skin-tex] draft emblem
    if (em) {
      const mesh = createEmblemMesh(em.matrix);
      mesh.visible = this.darkness <= 0;
      groups[em.index].add(mesh);
      this.emblems.push(mesh);
    }
  }

  // [basic-m1] An unskinned part above a moved socket: copies of its GLB meshes (shared geometry AND material, so its
  // team colour, highlight and charring stay MechPart's), each following its own GLB mesh
  #buildProxy(part, slotGroup) {
    this.covered.add(part);
    for (const src of part.meshes) {
      const mesh = new THREE.Mesh(src.geometry, src.material);
      mesh.castShadow = src.castShadow;
      mesh.receiveShadow = src.receiveShadow;
      mesh.raycast = noRaycast;
      mesh.matrixAutoUpdate = false;
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.add(mesh);
      slotGroup.add(group);
      this.followers.push({ node: src, rest: IDENTITY, group });
      this.proxies.push({ src, mesh });
    }
  }

  /** Follows the simulation rig (call after the GLB mixer moved it); display only, no allocation */
  tick() {
    const mech = this.mech;
    this.#syncColors();
    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i];
      const mat = f.group.matrix;
      mat.identity();
      for (let o = f.node; o && o !== mech; o = o.parent) {
        o.updateMatrix();
        mat.premultiply(o.matrix);
        // [basic-m1] a moved socket: everything mounted on it shifts with it (in the socket's parent space)
        if (o === this.torsoSocket) mat.premultiply(this.torsoShift);
        else if (o === this.leftSocket) mat.premultiply(this.leftShift);
        else if (o === this.rightSocket) mat.premultiply(this.rightShift);
      }
      mat.multiply(f.rest).premultiply(this.offset);
      f.group.matrixWorldNeedsUpdate = true;
    }
    for (let i = 0; i < this.proxies.length; i++) { // MechPart may swap a mesh's material (team colour, highlight)
      const p = this.proxies[i];
      if (p.mesh.material !== p.src.material) p.mesh.material = p.src.material;
    }
    let pulse = -1;
    for (let i = 0; i < this.matList.length; i++) { // [W-glb-arms] pulsing emission of the "(Animated)" meshes
      const mats = this.matList[i];
      if (!mats.pulsed.length) continue;
      if (pulse < 0) { this.phase += PULSE_STEP; pulse = PULSE_MID + PULSE_AMP * Math.sin(this.phase); }
      mats.setPulse(pulse);
    }
  }

  // [basic-m1] Each skinned part in its paint team's colour (capture, assembly-bay repaint, team colour change)
  #syncColors() {
    const parts = this.mech.parts;
    for (let i = 0; i < SKIN_SLOTS.length; i++) {
      const slot = SKIN_SLOTS[i];
      const mats = this.slotMats[slot];
      const part = parts[slot];
      if (!mats || !part) continue;
      const c = paintColor(this.mech, part) ?? this.teamColor;
      if (c !== mats.teamColor) mats.setTeamColor(c);
    }
  }

  /** The skin draws this part (else its GLB meshes are shown) */
  covers(part) { return this.covered.has(part); }
  setPartVisible(slot, visible) { if (this.slots[slot]) this.slots[slot].visible = visible && this.covered.has(this.mech.parts[slot]); }
  setHighlighted(on) {
    this.highlighted = on;
    for (let i = 0; i < this.matList.length; i++) this.matList[i].setHighlighted(on);
  }
  setTeamColor(color) { this.teamColor = color; this.#syncColors(); }
  setDarkness(d) {
    this.darkness = d;
    for (let i = 0; i < this.matList.length; i++) this.matList[i].setDarkness(d);
    for (let i = 0; i < this.emblems.length; i++) this.emblems[i].visible = d <= 0; // a hulk's emblem goes dark
    for (let i = 0; i < this.fields.length; i++) this.fields[i].visible = d <= 0;   // and its shield field goes out
  }

  #clear() {
    for (const g of Object.values(this.slots)) g.removeFromParent();
    for (const mats of this.matList) mats.dispose(); // geometry belongs to the cached glTF / the part (shared)
    this.slots = {};
    this.slotMats = {};
    this.matList.length = 0;
    this.followers.length = 0;
    this.proxies.length = 0;
    this.emblems.length = 0;
    this.fields.length = 0;
    this.covered.clear();
  }

  dispose() {
    this.#clear();
    this.root.removeFromParent();
  }
}

/**
 * [basic-m1] Stand-in socket object of a part when the skin model's socket of that name lies elsewhere (out = the
 * translation from the stand-in's socket to the skin's, part space = the socket's parent space: rest nodes are not
 * rotated), else null.
 */
function socketShift(part, entry, name, out) {
  const skinPos = skinSocket(entry, name);
  const sim = part.object.getObjectByName(name);
  if (!skinPos || !sim) return null;
  _p.setFromMatrixPosition(restMatrix(sim, part.object, _r));
  _p.subVectors(skinPos, _p);
  if (_p.length() < GLB_SKINS.socketEpsilon) return null;
  out.makeTranslation(_p.x, _p.y, _p.z);
  return sim;
}

/**
 * Stand-alone model of one skinned part (arm wreck): the skin meshes in the part's root space, frozen in the rest
 * pose. Returns null when the part has no loaded skin. The group has dispose() / setHighlighted().
 * [basic-m1] Drawn without the live skin's offsets (the wreck lands by its stand-in's box: feet / arm on the ground);
 * the 4th parameter (old `lowered`) is ignored.
 */
export function createSkinPartModel(race, part, teamColor) {
  if (!partSkinned(part, race)) return null;
  const e = skinEntry(race, part);
  const mats = new SkinMaterials(teamColor);
  const group = new THREE.Group();
  group.name = 'glbSkinPart';
  const list = skinMeshes(e, part.slot);
  for (const s of list) {
    if (isField(s.mesh)) continue; // a torn-off arm has no energy field
    const mesh = cloneMesh(s.mesh, mats, s.animated, e.style);
    mesh.matrix.copy(s.matrix);
    group.add(mesh);
  }
  const em = e.style.runtimeTexture ? emblemOf(e, part.slot, list) : null; // [W-skin-tex] only a slot with an emblem (torso)
  if (em) group.add(createEmblemMesh(em.matrix));
  group.setHighlighted = (on) => mats.setHighlighted(on);
  group.dispose = () => { group.removeFromParent(); mats.dispose(); };
  return group;
}
