// Steel Mans – načítání GLB s cache – SIT
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MODELS_BASE, MODEL_ENCODING, BASE64_MODEL_SUFFIX, MODEL_TEXTURE_FIX, MODEL_GEOMETRY_FIX } from '../config.js';

const loader = new GLTFLoader();
const cache = new Map(); // url -> Promise<gltf>

/** Načte GLB (jednou) a označí uzly glTF + jejich klidovou pózu */
export function loadGltf(path) {
  const url = MODELS_BASE + path;
  if (!cache.has(url)) {
    cache.set(url, fetchGltf(url).then(markNodes).then((gltf) => fixTextures(fixGeometry(gltf, path), path)));
  }
  return cache.get(url);
}

/**
 * Models from MODEL_GEOMETRY_FIX.capFront have no front wall: a flat face is added through the vertices near the
 * frontmost one (+Z), outlined by their convex hull in XY. It reuses the material of the rearmost mesh (the back
 * wall) and maps the texture the same way (u across X, v up Y), so MODEL_TEXTURE_FIX treats it like the rest.
 */
function fixGeometry(gltf, path) {
  const cap = MODEL_GEOMETRY_FIX.capFront;
  if (!cap.paths.some((prefix) => path.startsWith(prefix))) return gltf;
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const points = [];
  let back = null;
  let backZ = Infinity;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld);
    const pos = o.geometry.attributes.position;
    let meshZ = 0;
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m);
      points.push(p);
      meshZ += p.z / pos.count;
    }
    if (meshZ < backZ) { backZ = meshZ; back = o; }
  });
  if (!back || !points.length) return gltf;
  const frontZ = Math.max(...points.map((p) => p.z));
  const front = convexHullXY(points.filter((p) => p.z >= frontZ - cap.tolerance));
  if (front.length < 3) return gltf;
  const minX = Math.min(...front.map((p) => p.x));
  const maxX = Math.max(...front.map((p) => p.x));
  const minY = Math.min(...front.map((p) => p.y));
  const maxY = Math.max(...front.map((p) => p.y));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(front.flatMap((p) => [p.x, p.y, p.z]), 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(front.flatMap(() => [0, 0, 1]), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(front.flatMap((p) => [
    (maxX - p.x) / (maxX - minX || 1), (p.y - minY) / (maxY - minY || 1)]), 2)); // seen from the front: u runs right to left in X
  const index = [];
  for (let i = 1; i < front.length - 1; i++) index.push(0, i, i + 1);
  geometry.setIndex(index);
  const face = new THREE.Mesh(geometry, back.material);
  face.name = `${root.name}_frontCap`;
  root.add(face);
  return gltf;
}

/** Convex hull of points in the XY plane (monotone chain), counter-clockwise; duplicates removed */
function convexHullXY(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * Models from MODEL_TEXTURE_FIX.flipV folders have their textures upside down: mirror V through the texture
 * transform (repeat.y = −1, offset.y = 1). Done once on the cached model, whose materials every copy shares.
 */
function fixTextures(gltf, path) {
  if (!MODEL_TEXTURE_FIX.flipV.some((prefix) => path.startsWith(prefix))) return gltf;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const material of [o.material].flat()) {
      const t = material.map;
      if (!t || t.userData.flippedV) continue; // a texture shared by several materials flips once
      t.repeat.y = -t.repeat.y;
      t.offset.y = 1 - t.offset.y;
      t.userData.flippedV = true;
    }
  });
  return gltf;
}

function fetchGltf(url) {
  if (MODEL_ENCODING !== 'base64') return loader.loadAsync(url);
  // Artifact build: the GLB bytes are stored as base64 text next to where the .glb would be
  return fetch(url + BASE64_MODEL_SUFFIX)
    .then((res) => {
      if (!res.ok) throw new Error(`Model ${url}: HTTP ${res.status}`);
      return res.text();
    })
    .then((text) => {
      const binary = atob(text.trim());
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return loader.parseAsync(bytes.buffer, url.slice(0, url.lastIndexOf('/') + 1));
    });
}

/**
 * Starts loading models into the cache (match start), so units produced later load from memory and appear on
 * time (World.spawnDeferred). Failures are only logged – the real load reports them again when it happens.
 * @param {string[]} paths  model paths (duplicates and empty entries are skipped)
 * @returns {Promise<void>}
 */
export async function preloadModels(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  await Promise.all(unique.map((p) => loadGltf(p).catch((err) => console.warn(`[AssetLoader] preload ${p}:`, err))));
}

/** Vrací NOVOU kopii scény modelu (stejný model lze použít pro více robotů) */
export async function loadModel(path) {
  return (await loadGltf(path)).scene.clone(true);
}

// userData se při clone() kopíruje, takže značky má i každá kopie
function markNodes(gltf) {
  gltf.scene.traverse((o) => {
    const assoc = gltf.parser.associations.get(o);
    if (assoc?.nodes === undefined) return;
    o.userData.gltfNode = true;
    o.userData.rest = { p: o.position.toArray(), q: o.quaternion.toArray() };
  });
  return gltf;
}
