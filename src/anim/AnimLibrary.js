// Steel Men – knihovna animací kostry robota a jejich přenos na díly – SIT
// Animace jsou v animbase/RobotSkeleton.glb (node animace bez skinningu).
// Uzly kostry se mapují na uzly dílů podle pozice ve stromu (nejbližší sourozenec).
import * as THREE from 'three';
import { loadGltf } from '../core/AssetLoader.js';
import { R2 } from '../config.js';

const SKELETON = 'animbase/RobotSkeleton.glb';
const AMPUTATED = {
  leftArm: 'animbase/AmputatedLeftArmSkeleton.glb',
  rightArm: 'animbase/AmputatedRightArmSkeleton.glb',
};

// Kořen každého segmentu v kostře (odpovídá kotevním bodům v dílech)
export const SKELETON_ROOTS = {
  legs: 'RobotSkeleton_part00',     // pánev
  torso: 'RobotSkeleton_part11',    // socket_TorsoMount
  rightArm: 'RobotSkeleton_part13', // socket_ArmRight
  leftArm: 'RobotSkeleton_part18',  // socket_ArmLeft
};

// Kde podstrom segmentu končí (tam začíná další díl)
const STOPS = {
  legs: [SKELETON_ROOTS.torso],
  torso: [SKELETON_ROOTS.rightArm, SKELETON_ROOTS.leftArm],
  rightArm: [],
  leftArm: [],
};

let libraryPromise = null;

/** Načte kostru a klipy jednou pro celou hru */
export function loadAnimLibrary() {
  libraryPromise ??= (async () => {
    const [sk, ampL, ampR] = await Promise.all([
      loadGltf(SKELETON), loadGltf(AMPUTATED.leftArm), loadGltf(AMPUTATED.rightArm),
    ]);
    const clips = new Map(sk.animations.map((c) => [c.name, c]));

    // Výška pánve ve stoje – od ní se počítá posun pánve u jiných nohou
    const stand = clips.get('stand')?.tracks.find((t) => t.name === `${SKELETON_ROOTS.legs}.position`);
    const pelvisRef = stand ? new THREE.Vector3().fromArray(stand.values, 0) : new THREE.Vector3(0, 21.2, 0.6);
    const sides = classifyClipSides(sk.scene, clips);

    return {
      skeleton: sk.scene,
      clips,
      pelvisRef,
      sides,
      amputated: { leftArm: ampL.animations[0], rightArm: ampR.animations[0] },
      /**
       * Útočné klipy specifické pro sadu dílů (např. 'Basic', 'Axe').
       * @param {'left'|'right'} [side]  only clips that swing this arm (clips come in mirrored pairs)
       */
      clipsForSet(set, side = null) {
        const all = [...clips.keys()].filter((n) => n.startsWith(`RobotParts${set}_`));
        if (!side) return all;
        const matching = all.filter((n) => sides.get(n) === side || sides.get(n) === 'both');
        return matching.length ? matching : all;
      },
    };
  })();
  return libraryPromise;
}

/**
 * Which arm a clip mainly moves: 'left' | 'right' | 'both'.
 * Measured as total rotation of the nodes under each arm root; set attack clips come in mirrored pairs.
 */
function classifyClipSides(skeleton, clips) {
  const subtree = (rootName) => {
    const names = new Set();
    skeleton.getObjectByName(rootName)?.traverse((o) => names.add(o.name));
    return names;
  };
  const arms = { left: subtree(SKELETON_ROOTS.leftArm), right: subtree(SKELETON_ROOTS.rightArm) };
  const a = new THREE.Quaternion();
  const b = new THREE.Quaternion();
  const motion = (clip, names) => {
    let total = 0;
    for (const t of clip.tracks) {
      if (!t.name.endsWith('.quaternion') || !names.has(t.name.slice(0, t.name.lastIndexOf('.')))) continue;
      for (let i = 4; i < t.values.length; i += 4) total += a.fromArray(t.values, i - 4).angleTo(b.fromArray(t.values, i));
    }
    return total;
  };
  const sides = new Map();
  for (const [name, clip] of clips) {
    if (!name.startsWith('RobotParts')) continue;
    const l = motion(clip, arms.left);
    const r = motion(clip, arms.right);
    sides.set(name, Math.max(l, r) < Math.min(l, r) * BOTH_ARMS_RATIO ? 'both' : l > r ? 'left' : 'right');
  }
  return sides;
}

// Clips whose arms move within this ratio of each other count as two-handed
const BOTH_ARMS_RATIO = 1.1;

const nodeChildren = (o) => o.children.filter((c) => c.userData.gltfNode && !c.name.startsWith('socket_'));

/**
 * Namapuje uzly dílu na uzly kostry.
 * @param {THREE.Object3D} partObject  kořen načteného dílu (scéna GLB)
 * @param {string} slot                'legs' | 'torso' | 'leftArm' | 'rightArm'
 * @param {boolean} mirror             díl je zrcadlený (scale.x = -1)
 * @param {Map} out                    skelName -> binding
 */
export function bindPart(partObject, slot, lib, mirror = false, out = new Map()) {
  const partRoot = nodeChildren(partObject)[0];
  const skelRoot = lib.skeleton.getObjectByName(SKELETON_ROOTS[slot]);
  if (!partRoot || !skelRoot) return out;
  bindTree(partRoot, skelRoot, new Set(STOPS[slot]), mirror, out, slot === 'legs');
  return out;
}

function bindTree(partNode, skelNode, stops, mirror, out, isPelvis = false) {
  const rest = partNode.userData.rest;
  const skelRest = skelNode.userData.rest;
  out.set(skelNode.name, {
    object: partNode,
    mirror,
    pelvis: isPelvis,
    restP: new THREE.Vector3().fromArray(rest.p),
    restQ: new THREE.Quaternion().fromArray(rest.q),
    skelRestInv: new THREE.Quaternion().fromArray(skelRest.q).invert(),
  });

  const skelKids = nodeChildren(skelNode).filter((n) => !stops.has(n.name));
  const used = new Set();
  const p = new THREE.Vector3();
  for (const child of nodeChildren(partNode)) {
    p.fromArray(child.userData.rest.p);
    if (mirror) p.x = -p.x;
    let best = null;
    let bestDist = Infinity;
    for (const s of skelKids) {
      if (used.has(s)) continue;
      const d = p.distanceToSquared(new THREE.Vector3().fromArray(s.userData.rest.p));
      if (d < bestDist) { bestDist = d; best = s; }
    }
    // A node with no skeleton counterpart nearby (e.g. the flak turret on the torso) stays still; before, it took
    // the nearest unused skeleton node's clip and spun around while the mech walked
    if (!best || bestDist > R2.animBindMaxDistance ** 2) continue;
    used.add(best);
    bindTree(child, best, stops, mirror, out);
  }
}

/** Vytvoří kopii klipu, jejíž stopy míří na konkrétní uzly dílů (podle uuid) */
export function retargetClip(src, bindings, lib) {
  const tracks = [];
  const q = new THREE.Quaternion();
  for (const t of src.tracks) {
    const dot = t.name.lastIndexOf('.');
    const b = bindings.get(t.name.slice(0, dot));
    if (!b) continue;
    const prop = t.name.slice(dot + 1);

    if (prop === 'quaternion') {
      const v = t.values.slice();
      for (let i = 0; i < v.length; i += 4) {
        q.fromArray(v, i).multiply(b.skelRestInv).multiply(b.restQ);
        if (b.mirror) { q.y = -q.y; q.z = -q.z; } // zrcadlení rotace podle osy X
        q.toArray(v, i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${b.object.uuid}.quaternion`, t.times, v));
    } else if (prop === 'position' && b.pelvis) {
      // Jen posun pánve, jako odchylka od stoje (různé nohy mají různou výšku)
      const v = t.values.slice();
      for (let i = 0; i < v.length; i += 3) {
        v[i] += b.restP.x - lib.pelvisRef.x;
        v[i + 1] += b.restP.y - lib.pelvisRef.y;
        v[i + 2] += b.restP.z - lib.pelvisRef.z;
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${b.object.uuid}.position`, t.times, v));
    }
  }
  return new THREE.AnimationClip(src.name, src.duration, tracks);
}

/** Vrátí všechny uzly dílu do klidové pózy */
export function resetPose(object) {
  object.traverse((o) => {
    const r = o.userData.rest;
    if (!r) return;
    o.position.fromArray(r.p);
    o.quaternion.fromArray(r.q);
  });
}
