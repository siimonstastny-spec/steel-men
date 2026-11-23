// Steel Mans – scéna, kamera, světla, terén – SIT
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAP, R2, MAP_EDGE_FADE } from '../config.js';

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(R2.void.color); // dark void outside the map
  scene.fog = new THREE.Fog(R2.void.color, R2.void.fogNear, R2.void.fogFar);

  // Kamera – modely mají cca 20–30 jednotek na výšku
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.5, 2000);
  camera.position.set(45, 40, 60);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 12, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49; // nepodlézt pod terén
  controls.minDistance = 15;
  controls.maxDistance = 400;
  // Left = selection (click / box), middle = rotate, right = orders; panning via WASD (CameraKeys), wheel = zoom
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null };
  controls.update();

  // Světla
  const hemi = new THREE.HemisphereLight(0xdde8ff, 0x3a3326, 0.9);
  hemi.name = 'hemiLight';
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.name = 'sunLight';
  sun.position.set(...MAP.sunOffset);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 80;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 300 });
  scene.add(sun);
  scene.add(sun.target);
  // The shadow box covers only the area around the camera target – move it along with the camera
  const followSun = () => {
    sun.target.position.copy(controls.target);
    sun.position.copy(controls.target).add(new THREE.Vector3(...MAP.sunOffset));
  };
  controls.addEventListener('change', followSun);
  followSun();

  const terrain = createTerrain();
  scene.add(terrain);
  const ground = terrain.getObjectByName('ground');

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  return { renderer, scene, camera, controls, ground };
}

/**
 * [MAPS] Planet look of a map (MAP_PLANETS in config.js): light colours / intensities, background and fog.
 * `planet` = a MAP_PLANETS entry, or null = the default look created above (maps without a planet look unchanged).
 * Runs once per map build, no allocations in the frame loop.
 */
export function applyPlanetLook(scene, planet) {
  const sun = scene.getObjectByName('sunLight');
  const hemi = scene.getObjectByName('hemiLight');
  const base = (scene.userData.baseLook ??= {
    background: R2.void.color, fogColor: R2.void.color, fogNear: R2.void.fogNear, fogFar: R2.void.fogFar,
    sunColor: sun?.color.getHex(), sunIntensity: sun?.intensity,
    hemiSky: hemi?.color.getHex(), hemiGround: hemi?.groundColor.getHex(), hemiIntensity: hemi?.intensity,
  });
  const sky = planet?.sky;
  // [W9] outside the map is always black (the terrain fades into it, MapEdgeFade.js); the fog below keeps the sky colour
  scene.background = new THREE.Color(MAP_EDGE_FADE.outsideColor);
  if (sky && sky.fogNear === null) scene.fog = null;
  else scene.fog = new THREE.Fog(sky ? sky.color : base.fogColor, sky?.fogNear ?? base.fogNear, sky?.fogFar ?? base.fogFar);
  if (sun) { sun.color.setHex(planet?.sun.color ?? base.sunColor); sun.intensity = planet?.sun.intensity ?? base.sunIntensity; }
  if (hemi) {
    hemi.color.setHex(planet?.hemi.sky ?? base.hemiSky);
    hemi.groundColor.setHex(planet?.hemi.ground ?? base.hemiGround);
    hemi.intensity = planet?.hemi.intensity ?? base.hemiIntensity;
  }
}

// Default terrain before a map loads: flat centre, gentle hills around (menu background)
function createTerrain() {
  const group = new THREE.Group();
  group.name = 'terrain';
  const ground = new THREE.Mesh(
    buildTerrainGeometry({ size: MAP.defaultSize, flats: [{ x: 0, z: 0 }] }),
    new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95 }),
  );
  ground.name = 'ground';
  ground.receiveShadow = true;
  group.add(ground);
  return group;
}

/**
 * Terrain height at a point: hills (MAP.terrain layers) fading out near the flat spots (starts,
 * super node). symmetry 'rotate4' averages the four 90° rotations so all four quadrants get the
 * same hills (balanced 4-player map).
 */
export function terrainHeight(x, z, { terrain = {}, flats = [], symmetry = null } = {}) {
  const t = { ...MAP.terrain, ...terrain };
  let near = Infinity;
  for (const f of flats) near = Math.min(near, Math.hypot(x - f.x, z - f.z));
  const falloff = flats.length ? THREE.MathUtils.smoothstep(near, t.flatRadius, t.flatRadius + t.flatFalloff) : 1;
  if (falloff === 0) return 0;
  const hills = (px, pz) => t.hillAmplitude.reduce((sum, amp, i) => {
    const [fx, fz] = t.hillFrequency[i];
    // layer 0 = checker of bumps, other layers = diagonal waves. Even functions (cos): odd ones (sin)
    // would cancel out when the four rotations of a symmetric map are averaged
    return sum + (i === 0 ? Math.cos(px * fx) * Math.cos(pz * fz) : Math.cos(px * fx + pz * fz)) * amp;
  }, 0);
  const h = symmetry === 'rotate4'
    ? (hills(x, z) + hills(-z, x) + hills(-x, -z) + hills(z, -x)) * (t.symmetryGain ?? 1) / 4
    : hills(x, z);
  return h * falloff;
}

/**
 * Plane geometry of the terrain with heights and vertex colours. The height grid is kept in
 * geometry.userData.heightField so World.heightAt can read heights without ray casting.
 * @param {object} opts  { size, flats, terrain, symmetry } – see terrainHeight
 */
export function buildTerrainGeometry(opts) {
  const { size } = opts;
  const t = { ...MAP.terrain, ...opts.terrain };
  const segments = Math.max(1, Math.round(size * MAP.segmentsPerUnit));
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const heights = new Float32Array(pos.count);
  const colors = new Float32Array(pos.count * 3);
  const low = new THREE.Color(t.color);
  const high = new THREE.Color(t.colorHigh);
  const maxHeight = t.hillAmplitude.reduce((a, b) => a + b, 0) || 1;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = terrainHeight(pos.getX(i), pos.getZ(i), opts);
    pos.setY(i, h);
    heights[i] = h;
    const k = THREE.MathUtils.clamp((h / maxHeight + 1) / 2, 0, 1) * t.colorVariation;
    c.copy(low).lerp(high, k).toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.heightField = { size, segments, heights };
  return geo;
}

/**
 * Height of the terrain mesh at x, z from its height field (exact: same triangles as the mesh).
 * Returns null outside the terrain or when the geometry has no height field.
 */
export function sampleHeightField(field, x, z) {
  if (!field) return null;
  const { size, segments, heights } = field;
  const cell = size / segments;
  const fx = (x + size / 2) / cell;
  const fz = (z + size / 2) / cell;
  if (fx < 0 || fz < 0 || fx > segments || fz > segments) return null;
  const ix = Math.min(Math.floor(fx), segments - 1);
  const iz = Math.min(Math.floor(fz), segments - 1);
  const u = fx - ix, v = fz - iz;
  const row = segments + 1;
  const ha = heights[iz * row + ix];             // (ix, iz)
  const hb = heights[(iz + 1) * row + ix];       // (ix, iz+1)
  const hc = heights[(iz + 1) * row + ix + 1];   // (ix+1, iz+1)
  const hd = heights[iz * row + ix + 1];         // (ix+1, iz)
  // PlaneGeometry splits each cell along the b–d diagonal (u + v = 1)
  if (u + v <= 1) return ha + u * (hd - ha) + v * (hb - ha);
  return hc + (1 - u) * (hb - hc) + (1 - v) * (hd - hc);
}
