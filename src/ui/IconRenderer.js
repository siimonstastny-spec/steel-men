// Steel Men – UI icons rendered at runtime (docs/notes/icon-renderer.md). Every building with a procedural model is drawn
// once from a fixed 3/4 view (team colour, race style) into a small canvas. Visual only – never touches the simulation.
//   const c = getBuildingIcon('vehicleFactory', 'X', '#3a5ccc');   // canvas, or null while it is still being rendered
//   const off = onIconReady(() => rebuildUi());                      // fired when a requested icon is done; off() unsubscribes
// Design: ONE private offscreen WebGLRenderer (own canvas, created lazily on the first request). Rendering into the main
// renderer would share GPU resources but needs its render-target / colour-space / tone-mapping state juggled and must
// never run inside its frame; the private one is isolated and only costs a 2nd context + a re-upload of the used geometries.
// Icons are rendered at most ICON_RENDERER.perFrame per animation frame (queue), everything is reused (no allocations
// after the first icon: temp objects are module constants, the queue / cache are plain preallocated containers).
import * as THREE from 'three';
import { createProceduralStructure, hasProceduralModel, loadBuildingStyles } from '../procedural/registry.js';
import { emblemPathData } from '../procedural/ProcModules.js';
import {
  unitProcId, partProcId, partHasOwnProc, partHasStandIn, createUnitIconModel, createRobotIconModel, createPartIconModel, iconBounds, drawCrewIcon,
} from '../procedural/IconScenes.js';
import { TEAMS, ICON_RENDERER, PROC_ROBOTS } from '../config.js';
import { procRobotsOn } from '../units/ProcMechVisual.js';   // [B6] robot / part icons follow the in-game switch

export { ICON_RENDERER };

const CREW_ID = 'crew';

const _hex = new THREE.Color();
const hexOfColor = new Map();       // team colour (number / string) → '#rrggbb' (no Color allocation per UI redraw)

/** '#rrggbb' of a team colour; null for a missing / unknown colour (never cached, so no stale colour leaks in) */
function colorKey(teamColor) {
  if (teamColor === undefined || teamColor === null) return null;
  let hex = hexOfColor.get(teamColor);
  if (hex === undefined) { hex = `#${_hex.set(teamColor).getHexString()}`; hexOfColor.set(teamColor, hex); }
  return hex;
}

const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _dir = new THREE.Vector3();
const _bg = new THREE.Color(0, 0, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _corner = new THREE.Vector3();
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(ICON_RENDERER.fov / 2));

const cache = new Map();            // key → { canvas, id, race, color, size, state: 'queued' | 'done' | 'failed' }
const queue = [];                   // entries waiting for render
const listeners = new Set();
let gl = null;                      // { renderer, scene, camera, hemi, sun, size }
let raf = 0;
let stylesReady = false;
let stylesLoading = false;
let disposed = false;
let version = 0;                    // grows whenever icons were finished (views with a change signature include it)

const keyOf = (id, race, color, size) => `${id}|${race}|${color}|${size}`;

function ensureGl(size) {
  if (!gl) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(1);
    renderer.setClearColor(_bg, 0);
    renderer.shadowMap.enabled = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(ICON_RENDERER.fov, 1, ICON_RENDERER.nearMin, ICON_RENDERER.farInitial);
    const hs = ICON_RENDERER.hemi;
    const hemi = new THREE.HemisphereLight(hs.sky, hs.ground, hs.intensity);
    const sun = new THREE.DirectionalLight(ICON_RENDERER.sun.color, ICON_RENDERER.sun.intensity);
    sun.position.fromArray(ICON_RENDERER.sun.pos);
    scene.add(hemi, sun);
    gl = { renderer, scene, camera, hemi, sun, size: 0 };
  }
  if (gl.size !== size) { gl.renderer.setSize(size, size, false); gl.size = size; }
  return gl;
}

/** Model of an entry (building: structure model; unit / robot / part: procedural unit in its rest pose); null = none */
function createModel(e) {
  switch (e.kind) {
    case 'unit': return createUnitIconModel(e.id, e.race, e.color);
    case 'robot': return createRobotIconModel(e.spec, e.race, e.color);
    case 'part': return createPartIconModel(e.spec, e.id, e.race, e.color);
    default: {
      const m = createProceduralStructure(e.id, e.race, e.color);
      m?.update(0, false);
      return m;
    }
  }
}

/** View of a non-building entry: { dir: [x, y, z], margin } */
function viewOf(e) {
  if (e.kind === 'unit') return ICON_RENDERER.unit;
  if (e.kind === 'robot') return ICON_RENDERER.robot;
  return ICON_RENDERER.part;
}

/** Camera that fits the projected bounding box (exact extent, no sphere slack) – units, robots and parts */
function fitCameraToBox(g, e, view) {
  const P = ICON_RENDERER.part;
  let dir = view.viewDir;
  if (e.kind === 'part') dir = P.viewDir[e.spec === 'legs' || e.spec === 'torso' ? e.spec : 'arm'];
  _dir.fromArray(dir).normalize();
  if (e.kind === 'part' && e.spec === 'leftArm' && P.mirrorLeftArm) _dir.x = -_dir.x;
  _right.crossVectors(_up, _dir).normalize();
  _camUp.crossVectors(_dir, _right);
  _box.getCenter(_center);
  _box.getBoundingSphere(_sphere);
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z).sub(_center);
    const ext = Math.max(Math.abs(_corner.dot(_right)), Math.abs(_corner.dot(_camUp)));
    dist = Math.max(dist, (ext * view.fitMargin) / TAN_HALF_FOV + _corner.dot(_dir));   // corner nearer to the camera needs more room
  }
  const r = _sphere.radius;
  g.camera.position.copy(_center).addScaledVector(_dir, dist);
  g.camera.near = Math.max(ICON_RENDERER.nearMin, dist - r * 2);
  g.camera.far = dist + r * 2;
  g.camera.updateProjectionMatrix();
  g.camera.lookAt(_center);
}

/** Camera of buildings: bounding sphere, fixed 3/4 view */
function fitCameraToSphere(g) {
  _box.getBoundingSphere(_sphere);
  _box.getCenter(_center);
  const r = _sphere.radius;
  const dist = (r * ICON_RENDERER.fitMargin) / Math.sin(THREE.MathUtils.degToRad(ICON_RENDERER.fov / 2));
  _dir.fromArray(ICON_RENDERER.viewDir).normalize();
  g.camera.position.copy(_center).addScaledVector(_dir, dist);
  g.camera.near = Math.max(ICON_RENDERER.nearMin, dist - r * 2);
  g.camera.far = dist + r * 2;
  g.camera.updateProjectionMatrix();
  _center.y -= r * ICON_RENDERER.targetLift;
  g.camera.lookAt(_center);
}

/** Short blob: URL instead of a long data URL in every UI string; the snapshot is taken synchronously */
function publish(e) {
  e.canvas.toBlob((blob) => {
    if (cache.get(e.key) !== e) return;   // disposed meanwhile: nothing to publish (no blob URL is created)
    e.url = blob ? URL.createObjectURL(blob) : e.canvas.toDataURL('image/png');
    version++;
    for (const fn of listeners) fn();
  }, 'image/png');
}

/** Renders one entry into its canvas (model is created, drawn and disposed again; crew is drawn with the 2D canvas) */
function renderEntry(e) {
  let model = null;
  try {
    if (e.kind === 'crew') {
      drawCrewIcon(e.canvas.getContext('2d'), e.size, e.race, e.color);
      e.state = 'done';
      publish(e);
      return;
    }
    model = createModel(e);
    if (!model) { e.state = 'failed'; return; }
    const g = ensureGl(e.size);
    g.scene.add(model);
    model.updateWorldMatrix(true, true);
    if (e.kind === 'building') _box.makeEmpty().expandByObject(model);
    else iconBounds(model, _box);
    if (_box.isEmpty()) { e.state = 'failed'; return; }
    if (e.kind === 'building') fitCameraToSphere(g); else fitCameraToBox(g, e, viewOf(e));
    g.renderer.render(g.scene, g.camera);
    const ctx = e.canvas.getContext('2d');
    ctx.clearRect(0, 0, e.size, e.size);
    ctx.drawImage(g.renderer.domElement, 0, 0, e.size, e.size);   // same task as render → buffer still valid
    e.state = 'done';
    publish(e);
  } catch (err) {
    console.warn(`[IconRenderer] icon ${e.kind} ${e.id}/${e.race} failed`, err);
    e.state = 'failed';
  } finally {
    if (model) { model.removeFromParent(); model.dispose(); }
  }
}

function pump() {
  raf = 0;
  if (disposed) return;
  // at least perFrame icons; with a backlog more of them while the frame time budget lasts (the stock window waited ~3 s
  // at 1 icon per frame). Listeners fire when the blob URL exists (asynchronously), so the UI rebuilds once per batch.
  const t0 = performance.now();
  let n = 0;
  while (queue.length && n < ICON_RENDERER.maxPerFrame
    && (n < ICON_RENDERER.perFrame || performance.now() - t0 < ICON_RENDERER.frameBudgetMs)) {
    renderEntry(queue.shift());
    n++;
  }
  if (queue.length) schedule();
}

function schedule() {
  if (!raf && !disposed && stylesReady) raf = requestAnimationFrame(pump);
}

function ensureStyles() {
  if (stylesReady || stylesLoading) return;
  stylesLoading = true;
  loadBuildingStyles().then(() => { stylesReady = true; schedule(); })
    .catch((err) => { stylesLoading = false; console.warn('[IconRenderer] styles not loaded', err); });
}

/**
 * Icon of a building for a race and team colour. Returns the ready canvas (cached; draw it with drawImage or use
 * getBuildingIconUrl) or null – not rendered yet (the request is queued, onIconReady fires later) or the building has no
 * procedural model / failed (then keep the letters). Never throws.
 * @param {string} id structure id (stats.json)
 * @param {string} race race / style key
 * @param {THREE.ColorRepresentation} teamColor
 * @param {number} [size]
 * @returns {HTMLCanvasElement|null}
 */
export function getBuildingIcon(id, race, teamColor, size = ICON_RENDERER.size) {
  const e = entryOf(id, race, teamColor, size);
  return e?.state === 'done' ? e.canvas : null;
}

/** Cache entry (queued on first request); null after dispose (until initIconRenderer) or without a procedural model */
function entryOf(id, race, teamColor, size) {
  if (disposed || !hasProceduralModel(id)) return null;   // GLB buildings: fallback (letters), see note
  const color = colorKey(teamColor);
  if (!color) return null;
  return cachedEntry(keyOf(id, race, color, size), 'building', id, race, color, size, null);
}

/** Cache entry for a key, queued for rendering on the first request (spec = robot combo / part slot, else null) */
function cachedEntry(key, kind, id, race, color, size, spec) {
  let e = cache.get(key);
  if (!e) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    e = { canvas, kind, id, race, color, size, key, spec, state: 'queued', url: null };
    cache.set(key, e);
    queue.push(e);
    ensureStyles();
    schedule();
  } else if (e.state === 'queued' && !e.hot) {
    // requested again by a UI view that is being drawn now = visible: render it before the prewarmed backlog
    e.hot = true;
    const i = queue.indexOf(e);
    if (i > 0) { queue.splice(i, 1); queue.unshift(e); }
  }
  return e;
}

// ---------------------------------------------------------------- units, robots, parts (B2-1)

/** Entry of a unit icon ('crew' = squad emblem) or null (disposed / no procedural model / stats not loaded yet) */
function unitEntry(unitId, race, teamColor, size) {
  if (disposed) return null;
  const color = colorKey(teamColor);
  if (!color) return null;
  if (unitId === CREW_ID) return cachedEntry(keyOf(`crew:${CREW_ID}`, race, color, size), 'crew', CREW_ID, race, color, size, null);
  const proc = unitProcId(unitId);
  return proc ? cachedEntry(keyOf(`unit:${proc}`, race, color, size), 'unit', proc, race, color, size, null) : null;
}

/** [B6] procedural robot / part icons only for races drawn procedurally in game (PROC_ROBOTS.races) and while the switch is on; else letters */
const robotIconsOn = (race) => procRobotsOn() && PROC_ROBOTS.races.includes(race);

/** Part id for an icon: any registered part for a proc race; for other races only parts with their own stats.procModel (as before B6) */
function iconProcId(slot, model, race, standInRobot = false) {
  const id = partProcId(slot, model);
  if (!id) return '';
  // [B3] a part with stats.standInSet, and every part of a robot that carries one, is procedural for any race
  if (procRobotsOn() && (standInRobot || partHasStandIn(slot, model))) return id;
  return robotIconsOn(race) || (procRobotsOn() && partHasOwnProc(slot, model)) ? id : '';
}

/** Part ids of a loadout (legs and torso required, a missing arm = ''); null when a mounted part has no procedural model */
function robotEntry(loadout, race, teamColor, size) {
  if (disposed || !loadout) return null;
  const si = partHasStandIn('legs', loadout.legs) || partHasStandIn('torso', loadout.torso)
    || partHasStandIn('leftArm', loadout.leftArm) || partHasStandIn('rightArm', loadout.rightArm);   // [B3]
  const legs = iconProcId('legs', loadout.legs, race, si);
  const torso = iconProcId('torso', loadout.torso, race, si);
  if (!legs || !torso) return null;
  const leftArm = loadout.leftArm ? iconProcId('leftArm', loadout.leftArm, race, si) : '';
  const rightArm = loadout.rightArm ? iconProcId('rightArm', loadout.rightArm, race, si) : '';
  if ((loadout.leftArm && !leftArm) || (loadout.rightArm && !rightArm)) return null;
  const color = colorKey(teamColor);
  if (!color) return null;
  const key = keyOf(`robot:${legs}|${torso}|${leftArm}|${rightArm}`, race, color, size);
  return cachedEntry(key, 'robot', 'robot', race, color, size, { legs, torso, leftArm, rightArm });
}

function partEntry(slot, model, race, teamColor, size) {
  if (disposed) return null;
  const id = iconProcId(slot, model, race);
  if (!id) return null;
  const color = colorKey(teamColor);
  if (!color) return null;
  return cachedEntry(keyOf(`part:${slot}:${id}`, race, color, size), 'part', id, race, color, size, slot);
}

/**
 * Icon of a unit as a blob URL: procedural vehicle / aircraft (unitId = stats.json vehicles key or procedural model id) or
 * unitId 'crew' (race emblem on a bust, drawn with a canvas). null = not rendered yet or no model (keep the letters / emoji).
 */
export function unitIconUrl(unitId, race, teamColor, size = ICON_RENDERER.size) {
  try { return unitEntry(unitId, race, teamColor, size)?.url ?? null; } catch { return null; }
}

/** `<img class="ico-img">` of a unit in the colour of a team (index into TEAMS), or '' */
export function unitIconHtml(unitId, race, team) {
  const color = TEAMS[team]?.color;
  const url = color === undefined ? null : unitIconUrl(unitId, race, color);
  return url ? `<img class="ico-img" src="${url}" alt="">` : '';
}

/**
 * Icon of a whole robot as a blob URL. loadout = { legs, torso, leftArm, rightArm }: part model paths as the simulation
 * keeps them (MechPart.key / RobotProduction.loadout, e.g. '3DParts/…glb') or procedural part ids; leftArm / rightArm
 * null = no arm. null = not ready, or a part has no procedural model.
 */
export function robotIconUrl(loadout, race, teamColor, size = ICON_RENDERER.size) {
  try { return robotEntry(loadout, race, teamColor, size)?.url ?? null; } catch { return null; }
}

export function robotIconHtml(loadout, race, team) {
  const color = TEAMS[team]?.color;
  const url = color === undefined ? null : robotIconUrl(loadout, race, color);
  return url ? `<img class="ico-img" src="${url}" alt="">` : '';
}

/** Icon of one robot part (slot legs | torso | leftArm | rightArm, model path or procedural part id) as a blob URL, or null */
export function partIconUrl(slot, model, race, teamColor, size = ICON_RENDERER.size) {
  try { return partEntry(slot, model, race, teamColor, size)?.url ?? null; } catch { return null; }
}

export function partIconHtml(slot, model, race, team) {
  const color = TEAMS[team]?.color;
  const url = color === undefined ? null : partIconUrl(slot, model, race, color);
  return url ? `<img class="ico-img" src="${url}" alt="">` : '';
}

/** Queues unit icons (spread over frames) */
export function prewarmUnitIcons(unitIds, race, teamColor, size = ICON_RENDERER.size) {
  for (const id of unitIds) unitIconUrl(id, race, teamColor, size);
}

/** Queues part icons: list = [{ slot, model }] */
export function prewarmPartIcons(list, race, teamColor, size = ICON_RENDERER.size) {
  for (const p of list) partIconUrl(p.slot, p.model, race, teamColor, size);
}

/** Same as getBuildingIcon, as a short blob: URL shared by every <img> (revoked on dispose); null while not ready */
export function getBuildingIconUrl(id, race, teamColor, size = ICON_RENDERER.size) {
  return entryOf(id, race, teamColor, size)?.url ?? null;
}

/** Starts (or restarts after a match) the renderer: frees any previous state first. Call when the world is ready. */
export function initIconRenderer() {
  disposeIconRenderer();
  disposed = false;
}

/** `<img class="ico-img">` of a building in the colour of a team, or '' (no model / not ready: the caller keeps its letters) */
export function buildingIconHtml(id, race, team) {
  const color = TEAMS[team]?.color;
  const url = color === undefined ? null : getBuildingIconUrl(id, race, color);
  return url ? `<img class="ico-img" src="${url}" alt="">` : '';
}

/** Requests a batch of icons up front (e.g. all buildings of the local race when the build menu opens); spread over frames */
export function prewarmBuildingIcons(ids, race, teamColor, size = ICON_RENDERER.size) {
  for (const id of ids) getBuildingIcon(id, race, teamColor, size);
}

/** Counter that changes whenever icons were finished (cheap change detection for views without a listener) */
export const iconVersion = () => version;

/** Subscribe to "an icon finished"; returns the unsubscribe function */
export function onIconReady(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Faction emblem helper (not a building icon): draws the race emblem into a 2D context box [x, y, size, size] */
export function drawEmblem(ctx, race, x, y, size, color = ICON_RENDERER.emblemColorFallback) {
  let data;
  try { data = emblemPathData(race); } catch { return false; }   // styles not loaded yet
  if (!data) return false;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(data), 'evenodd');
  ctx.restore();
  return true;
}

/** Emblem SVG path string (viewBox 0 0 100 100, fill-rule evenodd) or '' when styles are not loaded yet */
export function emblemSvgPath(race) {
  try { return emblemPathData(race); } catch { return ''; }
}

/** Frees the offscreen renderer, the queue, the cache and the listeners. Later requests return null until initIconRenderer(). */
export function disposeIconRenderer() {
  disposed = true;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  queue.length = 0;
  for (const e of cache.values()) if (e.url?.startsWith('blob:')) URL.revokeObjectURL(e.url);
  cache.clear();
  listeners.clear();
  if (gl) {
    gl.scene.clear();
    gl.hemi.dispose?.();
    gl.sun.dispose?.();
    gl.renderer.dispose();
    gl.renderer.forceContextLoss();
    gl = null;
  }
}

/** Debug: { cached, queued, done, failed } */
export function iconStats() {
  let done = 0; let failed = 0;
  for (const e of cache.values()) { if (e.state === 'done') done++; else if (e.state === 'failed') failed++; }
  return { cached: cache.size, queued: queue.length, done, failed };
}
