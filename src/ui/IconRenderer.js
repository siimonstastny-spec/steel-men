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
import { TEAMS, ICON_RENDERER } from '../config.js';

export { ICON_RENDERER };

const _hex = new THREE.Color();
const hexOfColor = new Map();       // team colour (number / string) → '#rrggbb' (no Color allocation per UI redraw)

function colorKey(teamColor) {
  let hex = hexOfColor.get(teamColor);
  if (hex === undefined) { hex = `#${_hex.set(teamColor).getHexString()}`; hexOfColor.set(teamColor, hex); }
  return hex;
}

const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _dir = new THREE.Vector3();
const _bg = new THREE.Color(0, 0, 0);

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

/** Renders one entry into its canvas (building is created, drawn and disposed again) */
function renderEntry(e) {
  let model = null;
  try {
    model = createProceduralStructure(e.id, e.race, e.color);
    if (!model) { e.state = 'failed'; return; }
    const g = ensureGl(e.size);
    model.update(0, false);
    g.scene.add(model);
    model.updateWorldMatrix(true, true);
    _box.makeEmpty().expandByObject(model);
    if (_box.isEmpty()) { e.state = 'failed'; return; }
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
    g.renderer.render(g.scene, g.camera);
    const ctx = e.canvas.getContext('2d');
    ctx.clearRect(0, 0, e.size, e.size);
    ctx.drawImage(g.renderer.domElement, 0, 0, e.size, e.size);   // same task as render → buffer still valid
    e.state = 'done';
    // Short blob: URL instead of a long data URL in every UI string; the snapshot is taken synchronously
    e.canvas.toBlob((blob) => {
      if (cache.get(e.key) !== e) return;   // disposed meanwhile: nothing to publish (no blob URL is created)
      e.url = blob ? URL.createObjectURL(blob) : e.canvas.toDataURL('image/png');
      version++;
      for (const fn of listeners) fn();
    }, 'image/png');
  } catch (err) {
    console.warn(`[IconRenderer] icon ${e.id}/${e.race} failed`, err);
    e.state = 'failed';
  } finally {
    if (model) { model.removeFromParent(); model.dispose(); }
  }
}

function pump() {
  raf = 0;
  if (disposed) return;
  let n = ICON_RENDERER.perFrame;
  while (n-- > 0 && queue.length) renderEntry(queue.shift());   // listeners fire when the blob URL exists
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
  const key = keyOf(id, race, color, size);
  let e = cache.get(key);
  if (!e) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    e = { canvas, id, race, color, size, key, state: 'queued', url: null };
    cache.set(key, e);
    queue.push(e);
    ensureStyles();
    schedule();
  }
  return e;
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
