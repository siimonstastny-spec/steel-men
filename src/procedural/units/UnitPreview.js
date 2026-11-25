// Steel Men – console preview of procedural units (roadmap U0): one model per style side by side (+X), optionally the
// current GLB vehicle behind each (−Z), all animated by a requestAnimationFrame loop of their own (UI side, never the
// simulation – performance.now is fine here). The demo drives the tracks / wheels / hover in place, sweeps the turret,
// fires, cycles the status marker and (optional) deploy and cloak.
//   const { spawnUnitPreview } = await import('./src/procedural/units/UnitPreview.js');
//   const p = await spawnUnitPreview(steelMen.scene, { x: 0, y: 0, z: 0 });                     // light tank, all styles
//   const j = await spawnUnitPreview(steelMen.scene, { x: 0, y: 0, z: 20 }, { id: 'previewJet' });
//   p.cloak = true; p.deploy = true; p.demo = false; p.models[0].fire(); p.stats(); p.dispose();
// Also defines a small aircraft test model ('previewJet') that exercises the aircraft modules (fuselage, wings, fins,
// 1–4 engines, nose weapon); it is only for checking the kit, not a game unit.
import * as THREE from 'three';
import { loadBuildingStyles, styleKeys } from '../BuildingStyle.js';
import { loadModel } from '../../core/AssetLoader.js';
import { applyTeamColor } from '../../core/TeamColor.js';
import { loadStats, unitStats } from '../../data/Stats.js';
import { VEHICLE } from '../../config.js';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, createProceduralUnit, unitBatchStats } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp } from './UnitModules.js';
import './index.js';   // registers every procedural unit

const TAU = Math.PI * 2;

/** Preview tuning (UI only) */
export const UNIT_PREVIEW = {
  gap: 10,                 // world units between the styles (along +X)
  originalGap: 9,          // the GLB vehicle stands this far behind (−Z)
  maxDelta: 0.1,           // s – frame delta clamp
  teamColor: '#3a5ccc',
  statsScale: 0.8,         // stats.modelScale assumed for the preview scale (light tank ≈ gunTank)
  demo: {
    speed: 14, turn: 0.6, period: 6,          // in-place driving: speed / turn amplitude, s period
    turretSpeed: 0.7, turretArc: 0.6,         // rad/s phase speed, share of π
    pitchAmp: 0.15, pitchSpeed: 0.9,
    fireEvery: 1.5, deployPeriod: 8, cloakPeriod: 10, cloakGain: 1.5, statusEvery: 3,
  },
  statuses: ['idle', 'move', 'attack', 'deployed', 'cloaked', 'disabled'],
};

// ---------------------------------------------------------------- aircraft test model (kit check only)

const JET_SHAPES = {
  rounded: { L: 6.0, W: 1.1, H: 1.0, span: 6.0, rc: 2.2, tc: 0.8, sweep: 1.0, fins: 1, engines: 1, weapon: 'gun' },
  angular: { L: 7.2, W: 1.5, H: 1.2, span: 6.8, rc: 3.4, tc: 0.6, sweep: 2.4, fins: 2, engines: 4, weapon: 'missile' },
  round: { L: 5.6, W: 2.0, H: 0.9, span: 6.4, rc: 2.6, tc: 0, sweep: 1.4, fins: 0, engines: 2, weapon: 'plasma' },
  faceted: { L: 6.6, W: 1.0, H: 0.8, span: 5.6, rc: 2.0, tc: 0.5, sweep: -0.6, fins: 2, engines: 2, weapon: 'laser' },
};
const JET = {
  altitude: 3, bobAmp: 0.12, bobFreq: 0.4, engineR: 0.24, engineLen: 1.6, engineSpacing: 0.5,
  finH: 1.0, finChord: 1.2, finY: 0.3, finZ: -0.38, wingY: -0.1, wingZ: -0.1,
  gunY: -0.35, gunZ: 0.3, gunLen: 1.4, gunCal: 0.08, missiles: 4, statusY: 0.45, statusZ: -0.2,
};

function buildJet(kit) {
  const s = JET_SHAPES[kit.style.silhouette] ?? JET_SHAPES.rounded;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L: s.L, W: s.W, H: s.H });
  wings(ub, { bone: 'hull', y: s.H * JET.wingY, z: s.L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  if (s.fins) tailFins(ub, { bone: 'hull', y: s.H * JET.finY, z: s.L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins });
  for (let i = 0; i < s.engines; i++) {
    const x = (i - (s.engines - 1) / 2) * JET.engineSpacing;
    exhaust(ub, { parent: 'hull', position: [x, 0, -s.L / 2], r: JET.engineR, length: JET.engineLen, index: i + 1 });
  }
  weapon(ub, s.weapon, {
    parent: 'hull', position: [0, s.H * JET.gunY, s.L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, pitch: [0, 0], count: JET.missiles,
  });
  statusLamp(ub, { parent: 'hull', position: [0, s.H * JET.statusY, s.L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  return ub.build();
}

const JET_CACHE = createUnitCache(buildJet);

/** Aircraft test model of the kit (not a game unit) */
export class PreviewJetUnit extends ProcUnit {
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: JET_CACHE, type: 'previewJet', name: 'PreviewJetUnit' });
  }
}
registerProcUnit('previewJet', (race, teamColor) => new PreviewJetUnit({ race, teamColor }));

// ---------------------------------------------------------------- preview

// The current GLB vehicle of a race behind the procedural one (sized as Vehicle.load does); null when missing
async function loadOriginal(scene, glbId, race, teamColor, at) {
  try {
    const stats = unitStats('vehicles', glbId, race);
    const obj = await loadModel(stats.model);
    obj.scale.setScalar(VEHICLE.modelScale * (stats.modelScale ?? 1));
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const centre = box.getCenter(new THREE.Vector3());
    const holder = new THREE.Group();
    obj.position.set(-centre.x, -box.min.y, -centre.z);
    holder.add(obj);
    holder.position.copy(at);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    applyTeamColor(obj, teamColor);
    scene.add(holder);
    return holder;
  } catch (err) {
    console.warn(`[UnitPreview] no GLB ${glbId} for ${race}:`, err.message);
    return null;
  }
}

// Removes a GLB holder and disposes the materials applyTeamColor cloned for it (userData.unique); geometries belong to
// the AssetLoader cache
function disposeOriginal(holder) {
  if (!holder) return;
  holder.removeFromParent();
  holder.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) if (mat?.userData?.unique) mat.dispose();
  });
}

/**
 * Spawns one procedural unit per style (default: every style of data/buildingStyles.json) in a row along +X.
 * @param {THREE.Object3D} scene
 * @param {{x:number, y?:number, z:number}} position
 * @param {object} [o] { id = 'mediumTank', races, teamColor, opts (model options, e.g. { chassis: 'wheels', weapon:
 *   'lightning' }), demo = true, batching = false (far LOD instancing, needs a scene), original (GLB vehicle id to show
 *   behind, e.g. 'gunTank'), scale }
 * @returns handle { models, originals, demo, cloak, deploy, stats(), batchStats(), dispose() }
 */
export async function spawnUnitPreview(scene, position = { x: 0, y: 0, z: 0 }, {
  id = 'mediumTank', races, teamColor = UNIT_PREVIEW.teamColor, opts = {}, demo = true, batching = false, original = null, scale,
} = {}) {
  await Promise.all([loadStats(), loadBuildingStyles()]);
  const keys = races ?? styleKeys();
  const s = scale ?? VEHICLE.modelScale * UNIT_PREVIEW.statsScale;
  const handle = {
    models: [], originals: [], demo, cloak: false, deploy: false, time: 0, disposed: false,
    stats: () => handle.models.map((m) => ({ race: m.race, ...m.stats(), dims: m.dims, sockets: m.socketNames })),
    batchStats: () => unitBatchStats(scene),
    dispose: null,
  };
  try {
    keys.forEach((race, i) => {
      const m = createProceduralUnit(id, race, teamColor, opts);
      if (!m) throw new Error(`[UnitPreview] no procedural unit "${id}"`);
      m.scale.setScalar(s);
      m.position.set(position.x + i * UNIT_PREVIEW.gap, position.y ?? 0, position.z);
      scene.add(m);
      if (batching) m.enableBatching();
      handle.models.push(m);
    });
    if (original) {
      for (const m of handle.models) {
        const at = new THREE.Vector3(m.position.x, m.position.y, m.position.z - UNIT_PREVIEW.originalGap);
        handle.originals.push(await loadOriginal(scene, original, m.race, teamColor, at));
      }
    }
  } catch (err) {
    for (const m of handle.models) m.dispose();
    for (const o of handle.originals) disposeOriginal(o);
    throw err;
  }

  const D = UNIT_PREVIEW.demo;
  const fireIndex = handle.models.map(() => 0);
  let last = performance.now();
  let raf = 0;
  let statusIndex = -1;
  const loop = (now) => {
    // the first rAF timestamp can precede `last` (taken before the first frame): never step back in time
    const dt = Math.max(0, Math.min(UNIT_PREVIEW.maxDelta, (now - last) / 1000));
    last = now;
    const prev = handle.time;
    handle.time += dt;
    const t = handle.time;
    const shot = Math.floor(t / D.fireEvery) !== Math.floor(prev / D.fireEvery);
    const si = Math.floor(t / D.statusEvery) % UNIT_PREVIEW.statuses.length;
    for (let i = 0; i < handle.models.length; i++) {
      const m = handle.models[i];
      if (handle.demo) {
        m.setMotion(D.speed * Math.sin((TAU * t) / D.period + i), D.turn * Math.cos((Math.PI * t) / D.period + i));
        m.setTurretYaw(Math.sin(t * D.turretSpeed + i) * Math.PI * D.turretArc);
        m.setBarrelPitch(D.pitchAmp * (0.5 + 0.5 * Math.sin(t * D.pitchSpeed + i)));
        if (shot) {   // missiles: next launch socket each shot
          const launch = m.getSocket(`launch_${fireIndex[i] + 1}`);
          if (launch) { m.fire(launch.name); fireIndex[i] = (fireIndex[i] + 1) % 4; } else { fireIndex[i] = 0; m.fire(); }
        }
        if (si !== statusIndex) m.setStatus(UNIT_PREVIEW.statuses[si]);
      }
      m.setDeployed(handle.deploy ? 0.5 - 0.5 * Math.cos((TAU * t) / D.deployPeriod) : 0);
      m.setCloaked(handle.cloak ? Math.min(1, Math.max(0, D.cloakGain * Math.sin((TAU * t) / D.cloakPeriod))) : 0);
      m.tick(dt);
    }
    if (handle.demo) statusIndex = si;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  handle.dispose = () => {
    if (handle.disposed) return;
    handle.disposed = true;
    cancelAnimationFrame(raf);
    for (const m of handle.models) m.dispose();
    for (const o of handle.originals) disposeOriginal(o);
    handle.models.length = 0;
    handle.originals.length = 0;
  };
  return handle;
}
