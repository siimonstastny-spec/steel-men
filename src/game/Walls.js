// Steel Mans – walls: posts joined by wall segments, turrets on posts (stats.json structures, WALL in config.js).
//
//   • A post is a structure with `placement: 'wall'`; its `wallSegment` names the segment structure and
//     `turretSocket` the model node a turret stands on. A segment is a normal structure (HP, armour, cost) whose
//     model is stretched between two posts.
//   • Placing (HoverTruck build menu → WallPlacement): first click = start (snaps to an own post within
//     WALL.snapRadius), second click = end. Posts stand every WALL.postSpacing units; a line ending on an existing
//     post divides its length evenly. Shift keeps going from the end point. Each post and segment is a building of
//     its own, paid when ordered (the whole line must be affordable) and built in order by the builders
//     (races with continuesWithoutBuilder only start them).
//   • Segments block pathfinding for everybody (one box when axis-aligned, else a chain of circles – navShapes).
//   • A turret (`placement: 'post'`, `mountOn` = post id) is placed on a finished own post without a turret
//     (TurretPlacement); it is a DefenseStructure and dies with its post.
import * as THREE from 'three';
import { getStats, unitStats } from '../data/Stats.js';
import { loadModel } from '../core/AssetLoader.js';
import { PLACEMENT, WALL, WALL_DRAG, STRUCTURE, CMD_WALL, UI_SMALL } from '../config.js';
import { Structure, modelFootprint, cachedFootprint, footprintAt, snapYaw, structureScale } from '../units/Structure.js';
import { DefenseStructure } from '../units/DefenseStructure.js';
import { registerStructureClass } from '../units/structureClasses.js';
import { localTeam } from '../core/LocalPlayer.js';
import { canPlace, PlacementGhost } from './Construction.js';
import { boxInArea } from './PreBuild.js';
import { commandBus, registerCommand, resolve } from './commands/CommandBus.js';
import { newTicket, reportResult, eidsOf, buildersOf, orderBuild, orderBuildChain, checkRules, createStructure, addAndLoad } from './commands/buildCommands.js';
import { t } from '../i18n/i18n.js';

const isPostStats = (stats) => stats.placement === 'wall';
const live = (s) => s && !s.destroyed && !s.removed;
const LINE_TOLERANCE = 0.01; // units – how far a segment of a command may be from the middle of its two posts

// ---------- structures ----------

/** Wall post: segments join it, a turret may stand on it */
export class WallPost extends Structure {
  constructor(id, race, opts) {
    super(id, race, opts);
    this.turret = null;
  }

  /** World height of the turret socket (top of the post) above the post's base */
  get turretHeight() {
    const socket = this.model?.getObjectByName(this.stats.turretSocket);
    if (!socket) return this.bodyHeight;
    this.updateMatrixWorld(true);
    return socket.getWorldPosition(new THREE.Vector3()).y - this.position.y;
  }

  get hasTurret() { return live(this.turret); }

  destroy(opts) {
    super.destroy(opts);
    if (live(this.turret)) this.turret.destroy(opts);
  }
}

/**
 * Wall segment between two posts, turned to `yaw` (any angle). Its model is either stretched to `length` (between
 * two posts a fixed distance apart) or – `trim`, the end of a wall that reaches the map edge – a normal segment
 * whose far end is CUT OFF at `length` (the model keeps its size, the geometry is sliced, see setCrop).
 */
export class WallSegment extends Structure {
  constructor(id, race, { length = WALL.postSpacing, trim = false, ...opts } = {}) {
    super(id, race, opts);
    this.rotation.y = opts.yaw ?? 0; // segments follow the line, not the 90° building steps
    this.length = length;
    this.trim = trim;
    this.postHalf = 0;               // half size of the posts at its ends (pathfinding shapes start there)
  }

  // Synchronous part (build commands): the stretched footprint, known before the model is attached
  setup(fp) {
    if (this.stats) return;
    super.setup(fp);
    this.lengthFactor = (this.trim ? WALL.postSpacing : this.length) / segmentModelLength(fp);
    this.halfThick = fp.halfZ;
    const c = Math.abs(Math.cos(this.rotation.y));
    const s = Math.abs(Math.sin(this.rotation.y));
    const half = this.length / 2;
    this.footprint = { halfX: half * c + this.halfThick * s, halfZ: half * s + this.halfThick * c };
    this.radius = (half + this.halfThick) / 2;
  }

  async load() {
    await super.load();
    this.holder.scale.x = this.lengthFactor;
    if (this.trim) setCrop(this.holder, segmentCrop(this.fp, this.lengthFactor, this.length));
    return this;
  }

  /** Pathfinding shapes: one box along an axis, else circles along the line (between the posts' edges) */
  get navShapes() {
    if (!this.footprint) return [this.obstacle];
    return segmentShapes(this.position, this.rotation.y, this.length, this.halfThick, this.postHalf, this);
  }
}

/** Length of the (scaled) segment model – the footprint carries STRUCTURE.footprintPadding on both ends */
const segmentModelLength = (fp) => Math.max((fp.halfX - STRUCTURE.footprintPadding) * 2, Number.EPSILON);

// ---------- cutting a segment model (trimmed wall ends) ----------

/**
 * What to keep of a segment model that is cut to `length`: holder-space x range [lo, hi] (the part nearest to the
 * start post) and the shift that centres the kept part on the segment's middle. `factor` = holder.scale.x.
 */
function segmentCrop(fp, factor, length) {
  const modelLength = segmentModelLength(fp);
  const lo = -modelLength / 2;
  return { lo, hi: lo + length / factor, shift: (WALL.postSpacing - length) / 2 };
}

/**
 * Keeps only the part of every mesh of `holder` whose holder-space x lies in [lo, hi] – triangles are really sliced,
 * not scaled – and shifts the holder so the kept part stays centred. crop = null restores the whole model.
 * The original geometries are kept in userData (shared with other models, never modified).
 */
function setCrop(holder, crop) {
  holder.position.x = crop ? crop.shift : 0;
  holder.updateWorldMatrix(true, true);
  const inverse = new THREE.Matrix4().copy(holder.matrixWorld).invert();
  const toHolder = new THREE.Matrix4();
  holder.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    o.userData.fullGeometry ??= o.geometry;
    if (!crop) { o.geometry = o.userData.fullGeometry; return; }
    const e = toHolder.multiplyMatrices(inverse, o.matrixWorld).elements; // x of a vertex in holder space
    o.geometry = cropGeometry(o.userData.fullGeometry, [e[0], e[4], e[8], e[12]], crop.lo, crop.hi);
  });
}

/**
 * Slices a geometry: keeps what lies in lo <= row·(x, y, z, 1) <= hi. Triangles that cross a limit are cut along it
 * (all attributes interpolated), so the result is a real cut model. Returns a new non-indexed geometry.
 */
function cropGeometry(source, row, lo, hi) {
  const geo = source.index ? source.toNonIndexed() : source;
  const names = Object.keys(geo.attributes);
  const attrs = names.map((n) => geo.attributes[n]);
  const posIndex = names.indexOf('position');
  const side = (v) => row[0] * v[posIndex][0] + row[1] * v[posIndex][1] + row[2] * v[posIndex][2] + row[3];
  const read = (i) => attrs.map((a) => Array.from({ length: a.itemSize }, (_, k) => a.getComponent(i, k)));
  const mix = (a, b, f) => a.map((va, ai) => va.map((x, k) => x + (b[ai][k] - x) * f));
  // Sutherland–Hodgman against one limit: keep side(v) * sign >= limit * sign
  const clip = (poly, limit, sign) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = side(a) * sign - limit * sign;
      const db = side(b) * sign - limit * sign;
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) out.push(mix(a, b, da / (da - db)));
    }
    return out;
  };
  const chunks = attrs.map(() => []);
  const count = geo.attributes.position.count;
  for (let i = 0; i + 2 < count; i += 3) {
    let poly = [read(i), read(i + 1), read(i + 2)];
    poly = clip(poly, lo, 1);
    if (poly.length >= 3) poly = clip(poly, hi, -1);
    for (let k = 1; k + 1 < poly.length; k++) {
      for (const v of [poly[0], poly[k], poly[k + 1]]) v.forEach((comp, ai) => chunks[ai].push(...comp));
    }
  }
  const out = new THREE.BufferGeometry();
  attrs.forEach((a, ai) => out.setAttribute(names[ai], new THREE.BufferAttribute(new Float32Array(chunks[ai]), a.itemSize, a.normalized)));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Shapes of a segment centred at `centre`, turned to `yaw`, `length` long, `halfThick` thick */
function segmentShapes(centre, yaw, length, halfThick, postHalf, owner) {
  const dirX = Math.cos(yaw);
  const dirZ = -Math.sin(yaw);
  const half = length / 2;
  const axis = Math.min(Math.abs(dirX), Math.abs(dirZ)) < Math.sin(WALL.axisTolerance);
  if (axis) {
    const alongX = Math.abs(dirX) > Math.abs(dirZ);
    const inner = Math.max(half - postHalf, Number.EPSILON); // between the posts' edges (posts block the rest)
    return [{ x: centre.x, z: centre.z, halfX: alongX ? inner : halfThick, halfZ: alongX ? halfThick : inner, owner }];
  }
  const from = -half + postHalf;
  const to = half - postHalf;
  const step = Math.max(halfThick * WALL.shapeStepFactor, Number.EPSILON);
  const count = Math.max(1, Math.ceil((to - from) / step));
  const out = [];
  for (let i = 0; i <= count; i++) {
    const d = from + ((to - from) * i) / count;
    out.push({ x: centre.x + dirX * d, z: centre.z + dirZ * d, radius: halfThick, owner });
  }
  return out;
}

registerStructureClass((stats) => (isPostStats(stats) ? WallPost : null));

// ---------- wall line plan ----------

/** Own post (finished or not) nearest to a point within `radius`, or null */
export function nearestPost(world, team, point, radius, filter = () => true) {
  let best = null;
  let bestD = radius;
  for (const s of world.structures) {
    if (!(s instanceof WallPost) || s.team !== team || !live(s) || !filter(s)) continue;
    const d = Math.hypot(s.position.x - point.x, s.position.z - point.z);
    if (d <= bestD) { best = s; bestD = d; }
  }
  return best;
}

/** Half size of the playable area walls may use (walls reach the edge: CMD_WALL.edgeMargin instead of the building margin) */
const wallLimit = (world) => (world.map?.half ?? world.nav.half) - CMD_WALL.edgeMargin;

/** canPlace for wall pieces: the map edge margin is CMD_WALL.edgeMargin */
const canPlaceWall = (world, box, ignore) => canPlace(world, box, ignore, CMD_WALL.edgeMargin);

/** How far (units) a line from (sx, sz) in direction (ux, uz) may run until a post of this `box` would leave the map */
function edgeReach(world, box, sx, sz, ux, uz) {
  const lim = wallLimit(world);
  const along = (s, u, half) => {
    if (Math.abs(u) < Number.EPSILON) return Infinity;
    return ((u > 0 ? lim - half : half - lim) - s) / u;
  };
  return Math.max(0, Math.min(along(sx, ux, box.halfX), along(sz, uz, box.halfZ)) - CMD_WALL.edgeEpsilon);
}

/** A segment shorter than a normal one by more than the tolerance is a cut one */
const isTrimmed = (length) => length < WALL.postSpacing - CMD_WALL.trimTolerance;

/**
 * Plan of a wall line from `start` to the cursor: posts { x, z, existing? } and segments { x, z, yaw, length, trim,
 * from, to } (indices into posts). start = { x, z, post? } (post = existing WallPost).
 * Free end: segments of postSpacing; when the line would run past the map edge it ends AT the edge and its last
 * segment is shorter (`trim`: the model is cut, see WallSegment). End on an existing post: even, stretched segments.
 */
function planLine(world, team, start, cursor, postFp) {
  const end = nearestPost(world, team, cursor, WALL.snapRadius, (p) => p !== start.post);
  const target = end ? end.position : cursor;
  const dx = target.x - start.x;
  const dz = target.z - start.z;
  const len = Math.hypot(dx, dz);
  const posts = [{ x: start.x, z: start.z, existing: start.post ?? null }];
  const segments = [];
  const spacing = WALL.postSpacing;
  if (!end && len < spacing * WALL.singlePostFactor) return { posts, segments, ok: true };
  const ux = dx / Math.max(len, Number.EPSILON);
  const uz = dz / Math.max(len, Number.EPSILON);
  const yaw = Math.atan2(-uz, ux);
  let n = Math.min(WALL.maxSegments, Math.max(1, Math.round(len / spacing)));
  let ok = true;
  const lengths = [];
  if (end) {
    const segLen = len / n;
    ok = segLen >= spacing * WALL.snappedMinFactor && segLen <= spacing * WALL.snappedMaxFactor;
    for (let i = 0; i < n; i++) lengths.push(segLen);
  } else {
    for (let i = 0; i < n; i++) lengths.push(spacing);
    // Does the last post still fit on the map? If not, the wall ends at the edge with a cut segment
    const reach = edgeReach(world, footprintAt(postFp, 0, 0, snapYaw(yaw)), start.x, start.z, ux, uz);
    if (n * spacing > reach) {
      const full = Math.min(WALL.maxSegments, Math.floor(reach / spacing));
      const rest = reach - full * spacing;
      lengths.length = 0;
      for (let i = 0; i < full; i++) lengths.push(spacing);
      if (rest >= CMD_WALL.minTrimmedLength && full < WALL.maxSegments) lengths.push(rest);
      n = lengths.length;
      if (!n) return { posts, segments, ok: true, yaw };
    }
  }
  let travelled = 0;
  for (let i = 1; i <= n; i++) {
    const segLen = lengths[i - 1];
    travelled += segLen;
    const last = i === n && end;
    posts.push(last ? { x: end.position.x, z: end.position.z, existing: end }
      : { x: start.x + ux * travelled, z: start.z + uz * travelled, existing: null });
    const a = posts[i - 1];
    const b = posts[i];
    segments.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, yaw, length: segLen, trim: !end && isTrimmed(segLen), from: i - 1, to: i });
  }
  return { posts, segments, ok, yaw };
}

// ---------- placement ----------

/** Footprints of the post and segment models of a post id (cached promise per id / race) */
const footprints = new Map();
function wallFootprints(postId, race) {
  const key = `${postId}:${race}`;
  if (!footprints.has(key)) {
    const segId = getStats().structures[postId].wallSegment;
    footprints.set(key, Promise.all([modelFootprint(postId, race), modelFootprint(segId, race)]));
  }
  return footprints.get(key);
}

const ghostMaterial = (opacity = PLACEMENT.opacity) => new THREE.MeshBasicMaterial({
  color: PLACEMENT.validColor, transparent: true, opacity, depthWrite: false,
});

/** Model copy for previews: one material, no shadows, not clickable */
function ghostOf(model, material) {
  model.traverse((o) => { if (o.isMesh) { o.material = material; o.castShadow = false; o.raycast = () => {}; } });
  return model;
}

/**
 * Wall placement (CommandInput.placement interface): move(point), confirm(point, keep), cancel(), rotate / setYaw
 * (no-ops – the line sets the direction). Same callbacks as PlacementGhost.
 */
export class WallPlacement {
  constructor({ world, team = localTeam(), race, id, builders = [], onPlaced, onEnd }) {
    Object.assign(this, { world, team, race, id, builders, onPlaced, onEnd });
    this.segId = getStats().structures[id].wallSegment;
    this.yaw = 0;
    this.start = null;       // { x, z, post? } after the first click
    this.plan = null;
    this.valid = false;
    this.ended = false;
    this.point = null;
    this.group = new THREE.Group();
    this.postGhosts = [];
    this.segGhosts = [];
    this.chain = Promise.resolve();
    this.placedCount = 0;
  }

  async init() {
    const stats = unitStats('structures', this.id, this.race);
    const seg = unitStats('structures', this.segId, this.race);
    const [[postFp, segFp], postModel, segModel] = await Promise.all([
      wallFootprints(this.id, this.race), loadModel(stats.model), loadModel(seg.model)]);
    if (this.ended) return this;
    Object.assign(this, { postFp, segFp, postStats: stats, segStats: seg });
    this.postTemplate = postModel;
    this.segTemplate = segModel;
    this.world.scene.add(this.group);
    this.#createTip();
    if (this.point) this.move(this.point);
    return this;
  }

  /**
   * Text for the build menu while placing. Static on purpose: the length and price of the line are in the label at the
   * cursor ([UISMALL] #updateTip), so no stale "Release" text can hang in the menu after the mouse button is let go.
   */
  hint() {
    return t(this.start ? 'wall.hint.end' : 'wall.hint.start');
  }

  // ---- [UISMALL] price label at the cursor ----

  /** Creates the label and starts following the mouse (called once the models are loaded) */
  #createTip() {
    if (typeof document === 'undefined') return;
    this.tip = document.createElement('div');
    this.tip.className = 'wall-cost-tip';
    this.tip.hidden = true;
    document.body.appendChild(this.tip);
    this.tipMove = (e) => {
      this.cursor = { x: e.clientX, y: e.clientY, over: e.target?.tagName === 'CANVAS' }; // over the scene, not the HUD
      this.#updateTip();
    };
    window.addEventListener('pointermove', this.tipMove, { passive: true });
  }

  #removeTip() {
    if (this.tipMove) window.removeEventListener('pointermove', this.tipMove);
    this.tip?.remove();
    this.tip = this.tipMove = null;
  }

  /** Label text and position: segments, price per resource (red = not affordable), "release = build" while dragging */
  #updateTip() {
    const tip = this.tip;
    if (!tip) return;
    const c = this.cursor;
    if (this.ended || !this.plan || !c?.over) { tip.hidden = true; return; }
    const cost = this.#cost(this.plan);
    const economy = this.world.economy;
    const lines = Object.entries(cost).filter(([, v]) => v > 0).map(([res, v]) => {
      const name = t(`hud.${res}`);
      const bad = !economy.canAfford(this.team, { [res]: v });
      return `<span class="${bad ? 'bad' : ''}">${name === `hud.${res}` ? res : name} ${v}</span>`;
    });
    const parts = [];
    if (this.plan.segments.length) parts.push(`<span>${t('wall.cost.segments', { n: this.plan.segments.length })}</span>`);
    parts.push(...lines);
    if (!this.valid && this.plan.segments.length) parts.push(`<span class="bad">${t('wall.cost.blocked')}</span>`);
    else if (this.dragging && this.valid) parts.push(`<span class="muted">${t('wall.cost.release')}</span>`);
    tip.innerHTML = parts.join('');
    tip.style.left = `${c.x + UI_SMALL.wallTip.offsetX}px`;
    tip.style.top = `${c.y + UI_SMALL.wallTip.offsetY}px`;
    tip.hidden = false;
  }

  /** Cursor clamped to the reach of a dragged line (WALL_DRAG.maxSegments) from the start */
  #clampDrag(point) {
    const s = this.start;
    if (!s || !point) return point;
    const reach = Math.min(WALL_DRAG.maxSegments, WALL.maxSegments) * WALL.postSpacing;
    const dx = point.x - s.x;
    const dz = point.z - s.z;
    const d = Math.hypot(dx, dz);
    if (d <= reach) return point;
    return { x: s.x + (dx / d) * reach, y: point.y, z: s.z + (dz / d) * reach };
  }

  /**
   * Mouse press of a drag: the press sets the line start (like a first click). @returns {boolean} false = not a
   * drag start (not loaded yet, or the start is already set – then the press is the usual click on the end point)
   */
  beginDrag(point) {
    if (!this.postFp || this.ended || this.start || !point) return false;
    this.start = this.#startAt(point);
    this.dragging = true;
    this.move(point);
    return true;
  }

  /**
   * Mouse release of a drag. moved = the mouse really travelled (else it was a click: the start stays and the
   * second click ends the line). A dragged line is ordered with the same command as a two-click line; a blocked or
   * unaffordable one is dropped (the start is cleared, the player can drag again).
   * @returns {boolean} the placement is finished
   */
  endDrag(point, moved, keep = false) {
    this.dragging = false;
    if (this.ended) return false;
    this.#updateTip(); // the "release" text goes away at once (move() below redraws it for the new state)
    if (!moved || !point) { if (this.point) this.move(this.point); return false; }
    const p = this.#clampDrag(point);
    const before = this.placedCount;
    const done = this.confirm(p, keep);
    if (!done && !this.ended && this.placedCount === before) {
      this.start = null; // refused (blocked / resources): nothing was ordered
      this.move(p);
    }
    return done;
  }

  rotate() {}
  setYaw() {}

  // Preview pieces, created on demand and reused
  #ghost(list, template, fp, scale, i) {
    if (!list[i]) {
      const material = ghostMaterial();
      const model = ghostOf(template.clone(true), material);
      model.scale.setScalar(scale);
      model.position.set(-fp.offsetX, 0, -fp.offsetZ);
      // outer: position + yaw of the piece; inner: stretch / cut of a segment (same layout as Structure.holder)
      const inner = new THREE.Group();
      inner.add(model);
      const holder = new THREE.Group();
      holder.add(inner);
      holder.userData.material = material;
      holder.userData.inner = inner;
      this.group.add(holder);
      list[i] = holder;
    }
    return list[i];
  }

  /** Segment preview: stretched to the segment length, or – a cut end – normal size with the far end sliced off */
  #shapeSegment(g, s) {
    const inner = g.userData.inner;
    const modelLength = segmentModelLength(this.segFp);
    if (!s.trim) {
      inner.scale.x = s.length / modelLength;
      if (g.userData.cropLength !== null && g.userData.cropLength !== undefined) setCrop(inner, null);
      g.userData.cropLength = null;
      return;
    }
    const factor = WALL.postSpacing / modelLength;
    inner.scale.x = factor;
    const last = g.userData.cropLength;
    if (last !== null && last !== undefined && Math.abs(last - s.length) < CMD_WALL.previewCropStep) return;
    setCrop(inner, segmentCrop(this.segFp, factor, s.length));
    g.userData.cropLength = s.length;
  }

  #placeGhost(g, x, z, yaw, valid, opacity = PLACEMENT.opacity) {
    g.visible = true;
    g.position.set(x, this.world.heightAt(x, z), z);
    g.rotation.y = yaw;
    g.userData.material.color.set(valid ? PLACEMENT.validColor : PLACEMENT.invalidColor);
    g.userData.material.opacity = opacity;
  }

  /** Start under the cursor: an own post nearby, else the cursor point */
  #startAt(point) {
    const post = nearestPost(this.world, this.team, point, WALL.snapRadius);
    return post ? { x: post.position.x, z: post.position.z, post } : { x: point.x, z: point.z, post: null };
  }

  /** Can each piece of the plan stand? (existing posts are fine; segments may touch their end posts) */
  #check(plan) {
    const ignore = [...this.builders, ...plan.posts.map((p) => p.existing).filter(Boolean)];
    const postOk = plan.posts.map((p) => Boolean(p.existing) || canPlaceWall(this.world, footprintAt(this.postFp, p.x, p.z, snapYaw(plan.yaw ?? 0)), ignore));
    const segOk = plan.segments.map((s) => {
      const half = this.postFp.halfX + this.segFp.halfZ; // clear of both end posts
      return segmentShapes(s, s.yaw, s.length, this.segFp.halfZ, half, null)
        .every((c) => canPlaceWall(this.world, { x: c.x, z: c.z, halfX: c.radius ?? c.halfX, halfZ: c.radius ?? c.halfZ }, ignore));
    });
    return { postOk, segOk, ok: plan.ok && postOk.every(Boolean) && segOk.every(Boolean) };
  }

  move(point) {
    if (this.dragging) point = this.#clampDrag(point);
    this.point = point;
    if (!this.postFp || !point || this.ended) return;
    if (this.start?.pending && !this.start.post) {
      // The post ordered by the previous Shift line exists once the command ran: continue from it
      const made = nearestPost(this.world, this.team, this.start, WALL.postSpacing * WALL.snappedMinFactor / 2);
      if (made) this.start.post = made;
    }
    const start = this.start ?? this.#startAt(point);
    const plan = this.start ? planLine(this.world, this.team, start, point, this.postFp) : { posts: [{ ...start, existing: start.post }], segments: [], ok: true };
    const check = this.#check(plan);
    this.plan = plan;
    this.valid = check.ok && (plan.segments.length > 0 || !plan.posts[0].existing);
    const postScale = structureScale(this.postStats);
    const segScale = structureScale(this.segStats);
    for (const g of [...this.postGhosts, ...this.segGhosts]) g.visible = false;
    plan.posts.forEach((p, i) => {
      if (p.existing && this.start) return; // already standing
      const g = this.#ghost(this.postGhosts, this.postTemplate, this.postFp, postScale, i);
      this.#placeGhost(g, p.x, p.z, snapYaw(plan.yaw ?? 0), check.postOk[i] && plan.ok, this.start ? PLACEMENT.opacity : WALL.previewHoverOpacity);
    });
    plan.segments.forEach((s, i) => {
      const g = this.#ghost(this.segGhosts, this.segTemplate, this.segFp, segScale, i);
      this.#placeGhost(g, s.x, s.z, s.yaw, check.segOk[i] && plan.ok);
      this.#shapeSegment(g, s);
    });
    this.#updateTip();
  }

  /** Total cost of the new pieces of a plan */
  #cost(plan) {
    const total = {};
    const add = (cost) => { for (const [r, v] of Object.entries(cost ?? {})) total[r] = (total[r] ?? 0) + v; };
    for (const p of plan.posts) if (!p.existing) add(this.postStats.cost);
    for (let i = 0; i < plan.segments.length; i++) add(this.segStats.cost);
    return total;
  }

  confirm(point, keep = false) {
    this.move(point);
    if (!this.plan) return false;
    if (!this.start) {
      // First click: the start of the line (an existing post, or a new post placed with the line)
      this.start = this.#startAt(point);
      this.move(point);
      return false;
    }
    if (!this.valid) { this.onPlaced?.({ error: 'blocked' }); return false; }
    const plan = this.plan;
    const cost = this.#cost(plan);
    if (!this.world.economy.canAfford(this.team, cost)) { this.onPlaced?.({ error: 'resources', cost }); return false; }
    // Shift (keep) = behind the builders' current orders, and every further line of this placement joins the queue
    const queued = this.placedCount > 0 || keep;
    this.placedCount += 1;
    // The simulation validates the whole line again, pays it and creates the posts and segments in order
    const ticket = newTicket(this.team, (res) => this.onPlaced?.(res));
    commandBus.submit({
      type: 'placeWall', team: this.team, race: this.race, unitId: this.id, yaw: plan.yaw ?? 0,
      posts: plan.posts.map((p) => ({ x: p.x, z: p.z, eid: p.existing?.eid ?? null })),
      segments: plan.segments.map((s) => ({ x: s.x, z: s.z, yaw: s.yaw, length: s.length, trim: Boolean(s.trim) })),
      builders: eidsOf(this.builders), queued, ticket,
    });
    const last = plan.posts[plan.posts.length - 1];
    if (keep) {
      // Shift: the next line starts at this end (the new post exists only once built – snap by position)
      this.start = { x: last.x, z: last.z, post: last.existing ?? null, pending: true };
      this.move(point);
      return false;
    }
    this.cancel();
    return true;
  }

  cancel() {
    if (this.ended) return;
    this.ended = true;
    this.#removeTip();
    this.world.scene.remove(this.group);
    for (const g of [...this.postGhosts, ...this.segGhosts]) g.userData.material.dispose();
    this.onEnd?.();
  }
}

/**
 * Turret placement: the preview jumps onto the own finished post (stats.mountOn) nearest to the cursor that has
 * no turret yet; click = order it there.
 */
export class TurretPlacement {
  constructor({ world, team = localTeam(), race, id, builders = [], onPlaced, onEnd, onStart }) {
    Object.assign(this, { world, team, race, id, builders, onPlaced, onEnd, onStart });
    this.stats = unitStats('structures', id, race);
    this.yaw = 0;
    this.post = null;
    this.valid = false;
    this.ended = false;
    this.placedCount = 0;
    this.chain = Promise.resolve();
  }

  async init() {
    const [model] = await Promise.all([loadModel(this.stats.model), modelFootprint(this.id, this.race)]); // footprint: for the command
    if (this.ended) return this;
    this.material = ghostMaterial();
    model.scale.setScalar(structureScale(this.stats));
    this.object = ghostOf(model, this.material);
    this.object.visible = false;
    this.world.scene.add(this.object);
    if (this.point) this.move(this.point);
    return this;
  }

  hint() { return t('wall.hint.turret'); }
  rotate() {}
  setYaw() {}

  #free(p) { return p.unitId === this.stats.mountOn && p.complete && !p.hasTurret; }

  move(point) {
    this.point = point;
    if (!this.object || !point) return;
    const post = nearestPost(this.world, this.team, point, WALL.turretSnapRadius, (p) => this.#free(p));
    this.post = post;
    this.valid = Boolean(post);
    const at = post ? post.position : point;
    this.object.visible = true;
    this.object.position.set(at.x, (post ? post.position.y + post.turretHeight : this.world.heightAt(at.x, at.z)), at.z);
    this.object.rotation.y = post ? post.rotation.y : 0;
    this.material.color.set(this.valid ? PLACEMENT.validColor : PLACEMENT.invalidColor);
  }

  confirm(point, keep = false) {
    this.move(point);
    const post = this.post;
    if (!post) { this.onPlaced?.({ error: 'noPost' }); return false; }
    if (!this.world.economy.canAfford(this.team, this.stats.cost)) { this.onPlaced?.({ error: 'resources' }); return false; }
    const queued = this.placedCount > 0;
    this.placedCount += 1;
    const ticket = newTicket(this.team, (res) => this.onPlaced?.(res));
    commandBus.submit({
      type: 'placeTurret', team: this.team, race: this.race, unitId: this.id, post: post.eid,
      builders: eidsOf(this.builders), queued, ticket,
    });
    if (keep) return false;
    this.cancel();
    return true;
  }

  cancel() {
    if (this.ended) return;
    this.ended = true;
    if (this.object) { this.world.scene.remove(this.object); this.material.dispose(); }
    this.onEnd?.();
  }
}

/** Placement preview for a building: walls and turrets have their own, the rest uses PlacementGhost */
export function createPlacement(stats, opts) {
  if (isPostStats(stats)) return new WallPlacement(opts);
  if (stats.placement === 'post') return new TurretPlacement(opts);
  return new PlacementGhost(opts);
}

// ---------- commands ----------
//   placeWall   { team, race, unitId (post id), yaw, posts: [{ x, z, eid|null }], segments: [{ x, z, yaw, length, trim }],
//                 builders: [eid], queued, ticket? } – segments[i] joins posts[i] and posts[i + 1]; a post with an eid
//                 (or standing within the snap distance) is an existing one, the others are new. `trim` = the end of a
//                 wall at the map edge: shorter than postSpacing, its model is cut, not scaled. The builders get the
//                 whole line as ONE chained order (orderBuildChain), queued = behind their current orders (Shift).
//   placeTurret { team, race, unitId (turret id), post: eid, builders: [eid], queued, ticket? }
// Results go to the UI through the ticket (buildCommands.newTicket), like placeStructure.

/** Checks a placeWall command against the current world; returns { error } or the resolved plan */
function checkWall(world, cmd) {
  const { team, race } = cmd;
  const stats = unitStats('structures', cmd.unitId, race);
  if (!stats || !isPostStats(stats)) return { error: 'invalid' };
  const rules = checkRules(world, team, race, cmd.unitId, stats);
  if (rules) return { error: rules };
  const segStats = unitStats('structures', stats.wallSegment, race);
  const postFp = cachedFootprint(cmd.unitId, race);
  const segFp = cachedFootprint(stats.wallSegment, race);
  if (!postFp || !segFp) return { error: 'blocked' }; // footprints not preloaded
  const { posts, segments } = cmd;
  const wellFormed = Array.isArray(posts) && Array.isArray(segments) && posts.length >= 1
    && segments.length === posts.length - 1 && segments.length <= WALL.maxSegments
    && posts.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.z))
    && segments.every((s) => [s?.x, s?.z, s?.yaw, s?.length].every(Number.isFinite));
  if (!wellFormed) return { error: 'invalid' };
  // A cut segment (map edge) is at most a normal one; any other is a normal or an evenly stretched one
  const maxLength = WALL.postSpacing * WALL.snappedMaxFactor;
  const lengthOk = (s) => (s.trim === true
    ? s.length >= CMD_WALL.minTrimmedLength && s.length <= WALL.postSpacing
    : s.length >= WALL.postSpacing * WALL.snappedMinFactor && s.length <= maxLength);
  const geometryOk = segments.every((s, i) => lengthOk(s)
    && Math.hypot(s.x - (posts[i].x + posts[i + 1].x) / 2, s.z - (posts[i].z + posts[i + 1].z) / 2) <= LINE_TOLERANCE);
  if (!geometryOk) return { error: 'invalid' };
  // Existing posts: by id, else the own post standing at that spot (a post of the previous Shift line)
  const existing = posts.map((p) => {
    const byId = p.eid == null ? null : resolve(world, p.eid);
    if (byId instanceof WallPost && byId.team === team && live(byId)) return byId;
    return nearestPost(world, team, p, WALL.postSpacing * WALL.snappedMinFactor / 2);
  });
  if (segments.length === 0 && existing[0]) return { error: 'invalid' };
  const builders = buildersOf(world, cmd.builders, team);
  const yaw = snapYaw(cmd.yaw ?? 0);
  const ignore = [...builders, ...existing.filter(Boolean)];
  const postsOk = posts.every((p, i) => existing[i] || canPlaceWall(world, footprintAt(postFp, p.x, p.z, yaw), ignore))
    && posts.every((p) => boxInArea(world, cmd.team, footprintAt(postFp, p.x, p.z, yaw))); // [N8] pre-build square (convex)
  const half = postFp.halfX + segFp.halfZ; // clear of both end posts
  const segmentsOk = segments.every((s) => segmentShapes(s, s.yaw, s.length, segFp.halfZ, half, null)
    .every((c) => canPlaceWall(world, { x: c.x, z: c.z, halfX: c.radius ?? c.halfX, halfZ: c.radius ?? c.halfZ }, ignore)));
  if (!postsOk || !segmentsOk) return { error: 'blocked' };
  const total = {};
  const add = (cost) => { for (const [r, v] of Object.entries(cost ?? {})) total[r] = (total[r] ?? 0) + v; };
  existing.forEach((e) => { if (!e) add(stats.cost); });
  segments.forEach(() => add(segStats.cost));
  if (!world.economy.canAfford(team, total)) return { error: 'resources', cost: total };
  return { stats, segStats, postFp, segFp, existing, builders, yaw };
}

// ---------- pure helpers for the AI (no side effects, same code as the UI preview and the command) ----------

/**
 * Plan of a wall line exactly as WallPlacement would make it: from `start` { x, z, post? } towards `cursor` (a free
 * end runs at most to the map edge, its last segment cut – `trim`). @returns plan { posts, segments, ok, yaw } or null
 * when the post footprint is not loaded yet.
 */
export function planWallLine(world, team, race, postId, start, cursor) {
  const postFp = cachedFootprint(postId, race);
  return postFp ? planLine(world, team, start, cursor, postFp) : null;
}

/** placeWall command fields of a plan (as WallPlacement.confirm submits them) */
export function wallCommandOf(plan, { race, postId, builders = [], queued = false }) {
  return {
    type: 'placeWall', race, unitId: postId, yaw: plan.yaw ?? 0,
    posts: plan.posts.map((p) => ({ x: p.x, z: p.z, eid: p.existing?.eid ?? null })),
    segments: plan.segments.map((s) => ({ x: s.x, z: s.z, yaw: s.yaw, length: s.length, trim: Boolean(s.trim) })),
    builders: eidsOf(builders), queued,
  };
}

/**
 * Would the simulation accept this placeWall command now? The same check as its validation (reads the world only).
 * @returns {{ error?: string, cost?: object }} no error = it would be placed
 */
export function checkWallCommand(world, cmd) {
  const res = checkWall(world, cmd);
  return res.error ? { error: res.error, cost: res.cost } : {};
}

registerCommand('placeWall', {
  validate(world, cmd) {
    const res = checkWall(world, cmd);
    if (!res.error) return true;
    reportResult(cmd, res);
    return false;
  },
  // Creates post, segment, post, segment… at once (eids in this order); the builders get them queued in this order
  execute(world, cmd) {
    const res = checkWall(world, cmd);
    if (res.error) { reportResult(cmd, res); return; }
    const { stats, segStats, postFp, segFp, existing, builders, yaw } = res;
    const { team, race } = cmd;
    const nodes = []; // posts and segments in building order
    const finish = (result) => {
      // One chained order for the whole line (a single slot of the builders' queue); queued = Shift
      orderBuildChain(builders, nodes, Boolean(cmd.queued));
      reportResult(cmd, result);
    };
    for (let i = 0; i < cmd.posts.length; i++) {
      const p = cmd.posts[i];
      if (!existing[i]) {
        if (!world.economy.pay(team, stats.cost)) { finish({ error: 'resources', cost: stats.cost }); return; }
        const post = createStructure(WallPost, cmd.unitId, race, { team, yaw }, postFp);
        addAndLoad(world, post, p.x, p.z);
        nodes.push(post);
      }
      const s = cmd.segments[i - 1];
      if (!s) continue;
      if (!world.economy.pay(team, segStats.cost)) { finish({ error: 'resources', cost: segStats.cost }); return; }
      const seg = createStructure(WallSegment, stats.wallSegment, race, { team, yaw: s.yaw, length: s.length, trim: s.trim === true }, segFp);
      seg.postHalf = postFp.halfX;
      addAndLoad(world, seg, s.x, s.z);
      nodes.push(seg);
    }
    finish({});
  },
});

function checkTurret(world, cmd) {
  const { team, race } = cmd;
  const stats = unitStats('structures', cmd.unitId, race);
  if (stats?.placement !== 'post') return { error: 'invalid' };
  const rules = checkRules(world, team, race, cmd.unitId, stats);
  if (rules) return { error: rules };
  const fp = cachedFootprint(cmd.unitId, race);
  if (!fp) return { error: 'blocked' }; // footprint not preloaded
  const post = resolve(world, cmd.post);
  const postOk = post instanceof WallPost && post.team === team && live(post) && post.unitId === stats.mountOn
    && post.complete && !post.hasTurret;
  if (!postOk) return { error: 'noPost' };
  if (!world.economy.canAfford(team, stats.cost)) return { error: 'resources', cost: stats.cost };
  return { stats, fp, post, builders: buildersOf(world, cmd.builders, team) };
}

registerCommand('placeTurret', {
  validate(world, cmd) {
    const res = checkTurret(world, cmd);
    if (!res.error) return true;
    reportResult(cmd, res);
    return false;
  },
  execute(world, cmd) {
    const res = checkTurret(world, cmd);
    if (res.error) { reportResult(cmd, res); return; }
    const { stats, fp, post, builders } = res;
    if (!world.economy.pay(cmd.team, stats.cost)) { reportResult(cmd, { error: 'resources', cost: stats.cost }); return; }
    const turret = createStructure(DefenseStructure, cmd.unitId, cmd.race, { team: cmd.team, yaw: post.rotation.y }, fp);
    turret.post = post;
    post.turret = turret;
    addAndLoad(world, turret, post.position.x, post.position.z);
    turret.position.y = post.position.y + post.turretHeight;
    orderBuild(builders, turret, Boolean(cmd.queued));
    reportResult(cmd, { structure: turret });
  },
});

/** Extra build menu tooltip line of a wall post: the segment price */
export function wallTip(stats, race) {
  if (!isPostStats(stats)) return '';
  const seg = unitStats('structures', stats.wallSegment, race);
  return t('wall.segmentCost', { ore: seg.cost?.ore ?? 0, energy: seg.cost?.energy ?? 0 });
}
