// Steel Men – console preview of the procedural crew (block B5): a squad of crew members per race in a row, optionally the
// GLB crew behind (static, same scale / lift as Crew.load). Own requestAnimationFrame loop (UI side – performance.now is fine
// here, never the simulation): alternates idle and run every PROC_CREW.preview.switchEvery seconds.
//   const { spawnCrewPreview } = await import('./src/procedural/crew/CrewPreview.js');
//   const p = await spawnCrewPreview(steelMen.scene, { x: 0, y: 0, z: 0 });          // squad of 5, race Z, next to the camera target
//   p.mode = 'run' | 'idle' | 'auto';  p.teamColor('#ff3030');  p.stats();  p.dispose();
//   spawnCrewPreview(scene, pos, { races: ['Z'], original: true, batching: true, scale: 0.5 })
import * as THREE from 'three';
import { loadBuildingStyles } from '../BuildingStyle.js';
import { loadModel } from '../../core/AssetLoader.js';
import { applyTeamColor } from '../../core/TeamColor.js';
import { loadStats, getStats, crewStats } from '../../data/Stats.js';
import { PROC_CREW } from '../../config.js';
import { ProcCrewMember, hasProcCrew } from './ProcCrew.js';

const P = PROC_CREW.preview;

/** Local offsets of n members in rows (as Crew.formation, front row towards +Z) */
function formation(n, spacing) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    out.push({ x: ((i % cols) - (inRow - 1) / 2) * spacing, z: ((rows - 1) / 2 - row) * spacing });
  }
  return out;
}

/**
 * @param {THREE.Object3D} scene
 * @param {{x:number, y?:number, z:number}} position
 * @param {object} [o] { races = ['Z'], squad = PROC_CREW.preview.squad, teamColor, batching = false, original = false
 *   (GLB crew behind, −Z), scale (default stats.crew.modelScale), mode = 'auto', force = false (build the proc crew of a race
 *   that is not in PROC_CREW.races / while procedural models are off; without it such a race is skipped with a warning) }
 * @returns handle { models, originals, mode, teamColor(c), stats(), dispose() }
 */
export async function spawnCrewPreview(scene, position = { x: 0, y: 0, z: 0 }, {
  races = ['Z'], squad = P.squad, teamColor = PROC_CREW.defaultTeamColor, batching = false, original = false, scale, mode = 'auto',
  force = false,
} = {}) {
  await Promise.all([loadStats(), loadBuildingStyles()]);
  const crewData = getStats().crew;
  const s = scale ?? crewData.modelScale ?? 1;
  const offsets = formation(squad, crewData.formationSpacing ?? P.spacing);
  const handle = { models: [], originals: [], mode, time: 0, disposed: false, dispose: null };
  handle.teamColor = (c) => {
    for (const m of handle.models) m.setTeamColor(c);
    for (const o of handle.originals) applyTeamColor(o, c);
  };
  handle.stats = () => handle.models.map((m) => ({ race: m.race, index: m.index, ...m.stats(), dims: m.dims, batched: m.batched }));
  try {
    let slot = 0;
    for (const race of races) {
      if (!force && !hasProcCrew(race)) { console.warn(`[CrewPreview] race ${race} has no procedural crew (PROC_CREW.races); pass force: true`); continue; }
      const r = slot++;
      const baseX = position.x + r * P.gap * squad * 0.5;
      for (const [i, off] of offsets.entries()) {
        const m = new ProcCrewMember({ race, teamColor, index: i });
        m.scale.setScalar(s);
        m.position.set(baseX + off.x, position.y ?? 0, position.z + off.z);
        scene.add(m);
        if (batching) m.enableBatching();
        handle.models.push(m);
        if (original) {
          const obj = await loadModel(crewStats(race).model);   // the race's GLB (Venus has none of its own: resolves to the X model)
          obj.scale.setScalar(s);
          obj.updateMatrixWorld(true);
          obj.position.set(baseX + off.x, (position.y ?? 0) - new THREE.Box3().setFromObject(obj).min.y, position.z + off.z - P.rowGap);
          obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
          applyTeamColor(obj, teamColor);
          scene.add(obj);
          handle.originals.push(obj);
        }
      }
    }
  } catch (err) {
    for (const m of handle.models) m.dispose();
    for (const o of handle.originals) o.removeFromParent();
    throw err;
  }

  let last = performance.now();
  let raf = 0;
  const loop = (now) => {
    const dt = Math.max(0, Math.min(P.maxDelta, (now - last) / 1000));
    last = now;
    handle.time += dt;
    const run = handle.mode === 'run' || (handle.mode === 'auto' && Math.floor(handle.time / P.switchEvery) % 2 === 1);
    for (const m of handle.models) {
      m.setMotion(run ? P.runSpeed : 0);
      m.tick(dt);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  handle.dispose = () => {
    if (handle.disposed) return;
    handle.disposed = true;
    cancelAnimationFrame(raf);
    for (const m of handle.models) m.dispose();
    for (const o of handle.originals) {
      o.removeFromParent();
      o.traverse((x) => { if (x.isMesh) for (const mat of Array.isArray(x.material) ? x.material : [x.material]) if (mat?.userData?.unique) mat.dispose(); });
    }
    handle.models.length = 0;
    handle.originals.length = 0;
  };
  return handle;
}

/**
 * Comparison of the proc crew with the GLB original for every race of PROC_CREW.preview.compareRaces side by side
 * (proc in front, GLB behind, forced even for races outside PROC_CREW.races). Same handle as spawnCrewPreview.
 *   const { spawnCrewCompare } = await import('./src/procedural/crew/CrewPreview.js');
 *   const p = await spawnCrewCompare(steelMen.scene, { x: 0, y: 0, z: 0 });  // p.mode = 'idle'; p.dispose();
 */
export function spawnCrewCompare(scene, position = { x: 0, y: 0, z: 0 }, o = {}) {
  return spawnCrewPreview(scene, position, {
    races: P.compareRaces, squad: P.compareSquad, original: true, batching: true, force: true, ...o,
  });
}
