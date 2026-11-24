// Steel Men – console preview of procedural robots (experiment). Spawns one robot (or a row of combinations / styles),
// optionally the GLB Basic robot beside it for size, and animates them with a requestAnimationFrame loop of its own
// (UI side, never the simulation – performance.now is fine here): walk in place, punches, turret bursts, hits.
// Signature of this module: spawnRobotPreview(scene, race, color, pos, opts). The console helper wired in main.js,
// steelMen.spawnRobotPreview(race, color, pos, opts), passes the scene itself – the examples below use that helper:
//   p = await steelMen.spawnRobotPreview('W', '#3a5ccc', { x: 0, y: 0, z: 0 }, { legs: 'recon', torso: 'flak' });
//   p = await steelMen.spawnRobotPreview('W', '#c8302c', pos, { combos: 'all', original: true });
//   p.walk = false; p.attack('rightArm'); p.attack('torso'); p.powered = false; p.robots[0].hit('left'); p.stats(); p.dispose();
//   p.addPart('rightArm', 'gattling') – single arm model (arm wreck, createProcRobotPart) after the row
// Without the main.js wiring: const { spawnRobotPreview } = await import('./src/procedural/robots/RobotPreview.js');
//   spawnRobotPreview(steelMen.scene, 'W', '#3a5ccc', pos, opts)  (the wired helper passes the scene itself)
import * as THREE from 'three';
import { loadBuildingStyles } from '../BuildingStyle.js';
import { loadModel } from '../../core/AssetLoader.js';
import { applyTeamColor } from '../../core/TeamColor.js';
import { basicLoadout, SOCKETS } from '../../config.js';
import { ProcRobot, ProcRobotPart, robotPartIds } from './RobotParts.js';

const TAU = Math.PI * 2;

/** Preview tuning (UI only) */
export const ROBOT_PREVIEW = {
  gap: 24,                 // world units between robots of a row (+X)
  originalGap: 24,         // the GLB Basic robot stands this far to the left (−X) of the first robot
  glbRaces: ['X', 'Y', 'Z'],   // races with GLB robot parts (others show the first one)
  maxDelta: 0.1,           // s – frame delta clamp
  teamColor: '#3a5ccc',
  // combos: 'all' = these combinations in a row (every part appears at least once)
  allCombos: [
    { legs: 'basic', torso: 'basic' },
    { legs: 'basic', torso: 'flak', rightArm: 'gattling' },
    { legs: 'heavyLift', torso: 'basic', leftArm: 'gattling' },
    { legs: 'recon', torso: 'flak', leftArm: 'gattling', rightArm: 'gattling' },   // heaviest combination (triangle budget)
  ],
  partGap: 10,             // addPart: spacing of single arm models after the row
  demo: {
    walkPeriod: 10,        // s – walk / stand cycle
    walkShare: 0.6,        // share of the period spent walking
    speed: 16,             // units/s
    turnAmp: 0.4,          // rad/s turning wobble while walking
    attackEvery: 2.6,      // s between attacks (arms alternate, a turret fires every second attack)
    attackTime: 1.5,       // s – VISUAL preview default (= stats Basic fist attackTime); in game use the weapon's attackTime
    aimSpeed: 0.5, aimArc: 1.2, aimPitch: [0.2, 1.0], aimPitchRate: 1.7,   // turret sweep (rad/s phase, rad, pitch range, pitch phase × yaw phase)
    hitEvery: 7,           // s between demo hit reactions
    hitDirs: ['front', 'left', 'back', 'right'],
  },
};

const D = ROBOT_PREVIEW.demo;

// GLB Basic robot assembled statically (legs → torso → arms by the config sockets), standing on the ground at `at`
async function loadOriginal(scene, race, teamColor, at) {
  try {
    const key = ROBOT_PREVIEW.glbRaces.includes(race) ? race : ROBOT_PREVIEW.glbRaces[0];
    const L = basicLoadout(key);
    const [legs, torso, left, right] = await Promise.all([L.legs, L.torso, L.leftArm, L.rightArm].map((p) => loadModel(p)));
    legs.getObjectByName(SOCKETS.torso)?.add(torso);
    torso.getObjectByName(SOCKETS.leftArm)?.add(left);
    torso.getObjectByName(SOCKETS.rightArm)?.add(right);
    const holder = new THREE.Group();
    holder.add(legs);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(legs);
    legs.position.y = -box.min.y;
    holder.position.copy(at);
    holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    applyTeamColor(holder, teamColor);
    scene.add(holder);
    return holder;
  } catch (err) {
    console.warn('[RobotPreview] GLB Basic robot not loaded:', err.message);
    return null;
  }
}

// Removes a GLB holder and disposes the materials applyTeamColor cloned (userData.unique); geometry = AssetLoader cache
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
 * Spawns procedural robots in a row along +X.
 * @param {THREE.Object3D} scene
 * @param {string|string[]} race      style key ('W' …) or several (one robot per style)
 * @param {THREE.ColorRepresentation} color
 * @param {{x:number, y?:number, z:number}} pos
 * @param {object} [o] { legs, torso, arms (both arms), leftArm, rightArm, combos ('all' | array of part combos),
 *   demo = true, walk = true, original = false (GLB Basic robot on the left), batching = false }
 * @returns handle { robots, originals, demo, walk, powered, attack(slot), stats(), parts(), dispose() }
 */
export async function spawnRobotPreview(scene, race = 'W', color = ROBOT_PREVIEW.teamColor, pos = { x: 0, y: 0, z: 0 }, {
  legs, torso, arms, leftArm, rightArm, combos, demo = true, walk = true, original = false, batching = false,
} = {}) {
  await loadBuildingStyles();
  const races = Array.isArray(race) ? race : [race];
  const base = { legs, torso, leftArm: leftArm ?? arms, rightArm: rightArm ?? arms };
  const list = combos === 'all' ? ROBOT_PREVIEW.allCombos : Array.isArray(combos) ? combos : [{}];
  const handle = {
    robots: [], originals: [], singles: [], demo, walk, powered: true, time: 0, disposed: false,
    attack: (slot = 'rightArm') => handle.robots.map((r) => r.playAttack(slot, D.attackTime)),
    stats: () => handle.robots.map((r) => r.describe()),
    parts: () => robotPartIds(),
    // single arm model (arm wreck test): standing after the row, static
    addPart: (slot = 'rightArm', partId = 'gattling', race0 = races[0]) => {
      const part = new ProcRobotPart({ race: race0, teamColor: color, slot, partId });
      const x = pos.x + handle.robots.length * ROBOT_PREVIEW.gap + handle.singles.length * ROBOT_PREVIEW.partGap;
      part.position.set(x, (pos.y ?? 0) - part.dims.minY, pos.z);   // lowest point on the ground
      scene.add(part);
      handle.singles.push(part);
      return part;
    },
    dispose: null,
  };
  try {
    let i = 0;
    for (const r of races) {
      for (const c of list) {
        const robot = new ProcRobot({ race: r, teamColor: color, ...base, ...c });
        robot.position.set(pos.x + i * ROBOT_PREVIEW.gap, pos.y ?? 0, pos.z);
        scene.add(robot);
        if (batching) robot.enableBatching();
        handle.robots.push(robot);
        i++;
      }
    }
    if (original) {
      const at = new THREE.Vector3(pos.x - ROBOT_PREVIEW.originalGap, pos.y ?? 0, pos.z);
      handle.originals.push(await loadOriginal(scene, races[0], color, at));
    }
  } catch (err) {
    for (const r of handle.robots) r.dispose();
    for (const o of handle.originals) disposeOriginal(o);
    throw err;
  }

  let last = performance.now();
  let raf = 0;
  let attackCount = 0;
  const loop = (now) => {
    // the first rAF timestamp can precede `last`: never step back in time
    const dt = Math.max(0, Math.min(ROBOT_PREVIEW.maxDelta, (now - last) / 1000));
    last = now;
    const prev = handle.time;
    handle.time += dt;
    const t = handle.time;
    const attack = Math.floor(t / D.attackEvery) !== Math.floor(prev / D.attackEvery);
    const hit = Math.floor(t / D.hitEvery) !== Math.floor(prev / D.hitEvery);
    if (attack) attackCount++;
    for (let i = 0; i < handle.robots.length; i++) {
      const r = handle.robots[i];
      r.setPowered(handle.powered);
      if (handle.demo) {
        const cyc = ((t + i) % D.walkPeriod) / D.walkPeriod;
        const walking = handle.walk && cyc < D.walkShare;
        r.setGait(walking ? D.speed : 0, walking ? D.turnAmp * Math.sin((TAU * t) / D.walkPeriod + i) : 0);
        const ph = t * D.aimSpeed + i;
        const lo = D.aimPitch[0];
        const hi = D.aimPitch[1];
        r.setAim(D.aimArc * Math.sin(ph), lo + (hi - lo) * (0.5 + 0.5 * Math.sin(ph * D.aimPitchRate)));
        if (attack && handle.powered) {
          r.playAttack(attackCount % 2 ? 'rightArm' : 'leftArm', D.attackTime);
          if (attackCount % 2 === 0) r.playAttack('torso', D.attackTime);
        }
        if (hit) r.hit(D.hitDirs[Math.floor(t / D.hitEvery) % D.hitDirs.length]);
      }
      r.tick(dt);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  handle.dispose = () => {
    if (handle.disposed) return;
    handle.disposed = true;
    cancelAnimationFrame(raf);
    for (const r of handle.robots) r.dispose();
    for (const s of handle.singles) s.dispose();
    for (const o of handle.originals) disposeOriginal(o);
    handle.robots.length = 0;
    handle.singles.length = 0;
    handle.originals.length = 0;
  };
  return handle;
}
