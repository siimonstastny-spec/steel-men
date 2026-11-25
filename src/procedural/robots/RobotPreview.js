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
import { partStats } from '../../data/Stats.js';
import { ProcRobot, ProcRobotPart, robotPartIds } from './RobotParts.js';
import { procPartId } from './RobotPartMap.js';

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
  compare: {            // spawnPartCompare: GLB robot (left) | procedural robot (right) pairs along +X
    pairGap: 24,           // world units between the GLB and the procedural robot of a pair
    setGap: 62,            // world units between pairs (sets)
    baseArm: 'fist',       // procedural arm of the slots that are not compared
    baseId: 'basic',       // procedural legs / torso of the slots that are not compared
    label: { height: 6, y: 40, scale: 0.16, font: 'bold 44px sans-serif', width: 512, canvasHeight: 96, color: '#ffffff', back: 'rgba(0,0,0,0.6)' },
  },
  demo: {
    walkPeriod: 10,        // s – walk / stand cycle
    walkShare: 0.6,        // share of the period spent walking
    speed: 16,             // units/s
    turnAmp: 0.4,          // rad/s turning wobble while walking
    attackEvery: 2.6,      // s between attacks (arms alternate, a turret fires every second attack)
    attackTime: 1.5,       // s – VISUAL preview default (= stats Basic fist attackTime); in game use the weapon's attackTime
    aimSpeed: 0.5, aimArc: 1.2, aimPitch: [0.2, 1.0], aimPitchRate: 1.7,   // turret sweep (rad/s phase, rad, pitch range, pitch phase × yaw phase)
    kinds: {               // attack clips of the showcase (p.showcase = true), see ROBOT_KIT.anim
      arm: ['punch', 'swing', 'gun', 'launcher', 'blaster', 'beam'],
      torso: ['launch', 'pulse', 'artillery'],
    },
    hitEvery: 7,           // s between demo hit reactions
    hitDirs: ['front', 'left', 'back', 'right'],
  },
};

const D = ROBOT_PREVIEW.demo;

// GLB Basic robot assembled statically (legs → torso → arms by the config sockets), standing on the ground at `at`
async function loadOriginal(scene, race, teamColor, at, swap = null) {
  try {
    const key = ROBOT_PREVIEW.glbRaces.includes(race) ? race : ROBOT_PREVIEW.glbRaces[0];
    const L = { ...basicLoadout(key), ...swap };   // swap = { legs?, torso?, leftArm?, rightArm? } model paths replacing the Basic ones
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
    // attack(slot, kind?, shots?, time?) – kind overrides the part's own clip (ROBOT_PREVIEW.demo.kinds), e.g.
    // p.attack('rightArm', 'swing'); p.attack('leftArm', 'launcher', 4, 1.0); p.attack('torso', 'pulse')
    attack: (slot = 'rightArm', kind = null, shots = 0, time = D.attackTime) => handle.robots.map((r) => r.playAttack(slot, time, shots, kind)),
    // clip showcase: the demo attacks cycle through every kind (arms: D.kinds.arm, torso: D.kinds.torso); false = parts' own clips
    showcase: false,
    kinds: D.kinds,
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
          const show = handle.showcase;
          r.playAttack(attackCount % 2 ? 'rightArm' : 'leftArm', D.attackTime, 0, show ? D.kinds.arm[attackCount % D.kinds.arm.length] : null);
          if (attackCount % 2 === 0 || show) r.playAttack('torso', D.attackTime, 0, show ? D.kinds.torso[attackCount % D.kinds.torso.length] : null);
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

// ---------------------------------------------------------------- GLB vs procedural comparison (B6, screenshots for approval)

let catalogPromise = null;
/** parts.json once (what GLB models exist per slot): { legs: [{ path, set, race }], … } */
const loadCatalog = () => (catalogPromise ??= fetch('./parts.json').then((r) => r.json()));

// Text sprite above a pair member (UI only)
function makeLabel(text) {
  const L = ROBOT_PREVIEW.compare.label;
  const canvas = document.createElement('canvas');
  canvas.width = L.width;
  canvas.height = L.canvasHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = L.back;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = L.color;
  ctx.font = L.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(canvas.width * L.scale, canvas.height * L.scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function disposeLabel(sprite) {
  sprite.removeFromParent();
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

/**
 * Side-by-side comparison of GLB and procedural versions of one robot part per set, static pose (no walking), for
 * screenshots. For every set: [GLB robot | procedural robot] – the other slots are Basic in both (GLB Basic parts /
 * procedural 'basic' + 'fist'). A set whose part has no procedural id yet (stats.procModel / RobotPartMap) shows a
 * label only on the GLB side. Works for races outside PROC_ROBOTS.races (the preview ignores that switch).
 * Console (main.js wires steelMen.scene; this module is imported on demand):
 *   const { spawnPartCompare } = await import('./src/procedural/robots/RobotPreview.js');
 *   p = await spawnPartCompare(steelMen.scene, 'X', 'legs', ['Recon', 'HighStrength'], { x: 0, y: 0, z: 0 });
 *   p = await spawnPartCompare(steelMen.scene, 'Y', 'rightArm', ['HammerHand', 'Shield'], pos, { color: '#c8302c' });
 *   p.dispose()
 * @param {THREE.Object3D} scene
 * @param {string} race   style + GLB model race ('X' | 'Y' | 'Z'; others use the first GLB race for the GLB side)
 * @param {'legs'|'torso'|'leftArm'|'rightArm'} slot
 * @param {string[]} sets part sets ('Recon', 'Flak', 'HammerHand' …; as in stats.json parts)
 * @param {{x:number,y?:number,z:number}} [pos]
 * @param {{ color?: string, labels?: boolean, procIds?: Object<string,string> }} [o] procIds = { Set: procId } override
 * @returns handle { pairs: [{ set, glb, proc, procId }], dispose() }
 */
export async function spawnPartCompare(scene, race = 'X', slot = 'legs', sets = ['Basic'], pos = { x: 0, y: 0, z: 0 }, {
  color = ROBOT_PREVIEW.teamColor, labels = true, procIds = {},
} = {}) {
  const C = ROBOT_PREVIEW.compare;
  await loadBuildingStyles();
  const catalog = await loadCatalog();
  const glbRace = ROBOT_PREVIEW.glbRaces.includes(race) ? race : ROBOT_PREVIEW.glbRaces[0];
  const kind = slot === 'legs' || slot === 'torso' ? slot : 'arm';
  const handle = { pairs: [], disposed: false, dispose: null };
  const labelSprites = [];
  const place = (text, x) => {
    if (!labels) return;
    const s = makeLabel(text);
    s.position.set(x, (pos.y ?? 0) + C.label.y, pos.z);
    scene.add(s);
    labelSprites.push(s);
  };
  try {
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i];
      const x0 = pos.x + i * C.setGap;
      const entry = (catalog[slot] ?? []).find((p) => p.set === set && (p.race === glbRace || p.race === null));
      let stats = null;
      if (entry) { try { stats = partStats(entry.path, slot); } catch { stats = null; } }
      const procId = procIds[set] ?? procPartId(set, kind, stats);
      const pair = { set, glb: null, proc: null, procId };
      handle.pairs.push(pair);
      if (entry) {
        pair.glb = await loadOriginal(scene, glbRace, color, new THREE.Vector3(x0, pos.y ?? 0, pos.z), { [slot]: entry.path });
      } else console.warn(`[RobotPreview] no GLB model of set ${set} in slot ${slot} for race ${glbRace}`);
      if (procId && robotPartIds()[kind].includes(procId)) {
        const base = { legs: C.baseId, torso: C.baseId, leftArm: C.baseArm, rightArm: C.baseArm };
        const robot = new ProcRobot({ race, teamColor: color, ...base, [slot]: procId });
        robot.position.set(x0 + C.pairGap, pos.y ?? 0, pos.z);
        scene.add(robot);
        robot.setGait(0, 0);
        robot.tick(0);
        pair.proc = robot;
      } else console.warn(`[RobotPreview] set ${set} (${slot}) has no registered procedural part yet (id '${procId}')`);
      place(`${set} · GLB`, x0);
      place(`${set} · ${procId || '—'}`, x0 + C.pairGap);
    }
  } catch (err) {
    for (const pr of handle.pairs) { disposeOriginal(pr.glb); pr.proc?.dispose(); }
    for (const s of labelSprites) disposeLabel(s);
    throw err;
  }
  handle.dispose = () => {
    if (handle.disposed) return;
    handle.disposed = true;
    for (const pr of handle.pairs) { disposeOriginal(pr.glb); pr.proc?.dispose(); }
    for (const s of labelSprites) disposeLabel(s);
    handle.pairs.length = 0;
    labelSprites.length = 0;
  };
  return handle;
}

/**
 * Whole-robot comparison, static pose: for every combination of part sets – GLB robot (same GLB parts of the race,
 * assembled by the sockets like in game; left arm = the Left model) on the left, procedural robot (ids by procPartId:
 * stats.procModel, else RobotPartMap) on the right, labelled. A missing slot / set falls back to Basic.
 *   const { spawnRobotCompare } = await import('./src/procedural/robots/RobotPreview.js');
 *   p = await spawnRobotCompare(steelMen.scene, 'X', [
 *     { legs: 'Recon', torso: 'Flak', leftArm: 'HammerHand', rightArm: 'GattlingGun' },
 *     { legs: 'Armor', torso: 'Armor', leftArm: 'Shield', rightArm: 'KatanaSword' } ], { x: 0, y: 0, z: 0 });
 *   p.dispose()
 * @param {string} race  style + GLB model race (X | Y | Z; others use the first GLB race for the GLB side)
 * @param {Array<{legs?:string,torso?:string,leftArm?:string,rightArm?:string}>} combos
 * @returns handle { pairs: [{ combo, glb, proc, ids }], dispose() }
 */
export async function spawnRobotCompare(scene, race = 'X', combos = [{}], pos = { x: 0, y: 0, z: 0 }, {
  color = ROBOT_PREVIEW.teamColor, labels = true,
} = {}) {
  const C = ROBOT_PREVIEW.compare;
  await loadBuildingStyles();
  const catalog = await loadCatalog();
  const glbRace = ROBOT_PREVIEW.glbRaces.includes(race) ? race : ROBOT_PREVIEW.glbRaces[0];
  const KINDS = { legs: 'legs', torso: 'torso', leftArm: 'arm', rightArm: 'arm' };
  const handle = { pairs: [], disposed: false, dispose: null };
  const labelSprites = [];
  const place = (text, x) => {
    if (!labels) return;
    const s = makeLabel(text);
    s.position.set(x, (pos.y ?? 0) + C.label.y, pos.z);
    scene.add(s);
    labelSprites.push(s);
  };
  try {
    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];
      const x0 = pos.x + i * C.setGap;
      const swap = {};
      const ids = {};
      for (const slot of Object.keys(KINDS)) {
        const set = combo[slot] ?? 'Basic';
        const entry = (catalog[slot] ?? []).find((p) => p.set === set && (p.race === glbRace || p.race === null));
        let stats = null;
        if (entry) { try { stats = partStats(entry.path, slot); } catch { stats = null; } }
        else console.warn(`[RobotPreview] no GLB model of set ${set} in slot ${slot} for race ${glbRace}`);
        if (entry) swap[slot] = entry.path;
        const id = procPartId(set, KINDS[slot], stats);
        ids[slot] = robotPartIds()[KINDS[slot]].includes(id) ? id : '';
        if (!ids[slot]) console.warn(`[RobotPreview] set ${set} (${slot}) has no registered procedural part yet (id '${id}')`);
      }
      const pair = { combo, glb: null, proc: null, ids };
      handle.pairs.push(pair);
      pair.glb = await loadOriginal(scene, glbRace, color, new THREE.Vector3(x0, pos.y ?? 0, pos.z), swap);
      // an unregistered part falls back to the Basic one so the rest of the robot is still comparable
      const base = { legs: C.baseId, torso: C.baseId, leftArm: C.baseArm, rightArm: C.baseArm };
      const robot = new ProcRobot({ race, teamColor: color, legs: ids.legs || base.legs, torso: ids.torso || base.torso,
        leftArm: ids.leftArm || base.leftArm, rightArm: ids.rightArm || base.rightArm });
      robot.position.set(x0 + C.pairGap, pos.y ?? 0, pos.z);
      scene.add(robot);
      robot.setGait(0, 0);
      robot.tick(0);
      pair.proc = robot;
      const name = ['legs', 'torso', 'leftArm', 'rightArm'].map((s) => combo[s] ?? 'Basic').join(' / ');
      place(`${name} · GLB`, x0);
      place(`${name} · proc`, x0 + C.pairGap);
    }
  } catch (err) {
    for (const pr of handle.pairs) { disposeOriginal(pr.glb); pr.proc?.dispose(); }
    for (const s of labelSprites) disposeLabel(s);
    throw err;
  }
  handle.dispose = () => {
    if (handle.disposed) return;
    handle.disposed = true;
    for (const pr of handle.pairs) { disposeOriginal(pr.glb); pr.proc?.dispose(); }
    for (const s of labelSprites) disposeLabel(s);
    handle.pairs.length = 0;
    labelSprites.length = 0;
  };
  return handle;
}
