// Steel Mans – console preview of procedural buildings: the procedural model next to the current GLB model, both
// animated by a requestAnimationFrame loop of their own (UI side, never the simulation). Any style key of
// data/buildingStyles.json works (also one without a race in stats.json – the GLB beside it is then the first race's).
//   const p = await spawnProceduralPreview(scene, { x: 0, y: 0, z: 0 }, 'Y', '#c8302c');
//   p.producing = false;  p.model.stats();  p.dispose();
import * as THREE from 'three';
import { createProceduralStructure, loadBuildingStyles } from './registry.js';
import { loadModel, loadGltf } from '../core/AssetLoader.js';
import { applyTeamColor } from '../core/TeamColor.js';
import { loadStats, unitStats } from '../data/Stats.js';
import { structureScale } from '../units/Structure.js';

/** Preview tuning */
export const PROC_PREVIEW = {
  gap: 26,          // model units between the procedural model and the GLB (along +X, before structure scale)
  maxDelta: 0.1,    // s – frame delta clamp (tab in background)
};

/**
 * Spawns a procedural structure (default the vehicle factory) at `position` and, unless withOriginal is false,
 * the current GLB model beside it (+X). Returns a handle { model, original, producing, dispose() }.
 * @param {THREE.Object3D} scene
 * @param {{x:number, y:number, z:number}} position
 * @param {string} race
 * @param {THREE.ColorRepresentation} teamColor
 * @param {object} [opts] { id = 'vehicleFactory', withOriginal = true, producing = true, yaw = 0 }
 */
export async function spawnProceduralPreview(scene, position = { x: 0, y: 0, z: 0 }, race = 'X', teamColor = '#3a5ccc',
  { id = 'vehicleFactory', withOriginal = true, producing = true, yaw = 0 } = {}) {
  await Promise.all([loadStats(), loadBuildingStyles()]);
  const stats = unitStats('structures', id, race);
  const scale = structureScale(stats);
  const model = createProceduralStructure(id, race, teamColor);
  if (!model) throw new Error(`[ProcPreview] no procedural model for ${id}`);
  model.scale.setScalar(scale);
  model.position.set(position.x, position.y ?? 0, position.z);
  model.rotation.y = yaw;
  scene.add(model);

  const handle = { model, original: null, mixer: null, producing, disposed: false, dispose: null };

  if (withOriginal) {
    const original = await loadModel(stats.model);
    original.scale.setScalar(scale);
    original.position.set(position.x + PROC_PREVIEW.gap * scale, position.y ?? 0, position.z);
    original.rotation.y = yaw;
    original.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    applyTeamColor(original, teamColor);
    const clip = (await loadGltf(stats.model)).animations[0];
    if (clip) {
      handle.mixer = new THREE.AnimationMixer(original);
      handle.mixer.clipAction(clip).play();
    }
    if (!handle.disposed) scene.add(original);
    handle.original = original;
  }

  let last = performance.now();
  let raf = 0;
  const tick = (now) => {
    const dt = Math.min(PROC_PREVIEW.maxDelta, (now - last) / 1000);
    last = now;
    model.update(dt, handle.producing);
    handle.mixer?.update(dt);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  handle.dispose = () => {
    if (handle.disposed) return;
    handle.disposed = true;
    cancelAnimationFrame(raf);
    model.dispose();
    handle.mixer?.stopAllAction();
    handle.original?.removeFromParent();   // GLB geometries are shared with the AssetLoader cache – not disposed
  };
  return handle;
}
