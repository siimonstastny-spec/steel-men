// Steel Mans – minimap in the bottom-right corner (#minimap, created here).
// Shows the terrain, obstacles, super node, start positions, own units and enemies the player can see
// (fog of war) in team colours, and the camera view. Click / drag = move the camera there.
// An own unit that lost HP blinks for MINIMAP.damageFlashTime (damage warning).
// [B3] Radar look (PPI scope): concentric range rings + centre dot, a sweep line circling at RADAR.sweepPeriod.
// Terrain and fog are drawn normally (live). Own units/buildings stay live (the player must see and order them);
// allies and enemies are refreshed only when the sweep passes over them and fade (afterglow) until the next pass.
import * as THREE from 'three';
import { MINIMAP, TEAMS, R2, PLAYERS_UI, MAPS, RADAR, N2_UI, AIR } from '../config.js';
import { CELL } from '../game/AsciiMap.js'; // [MAPS] cell types of ASCII maps
import { isLocal, localTeam } from '../core/LocalPlayer.js';
import { areAllies } from '../game/Alliances.js'; // [N5a] alliances API
import { terrainHeight } from '../core/SceneSetup.js';
import { getStats } from '../data/Stats.js';
import { drawMinimapMarks, submitPing, isPingClick } from './Pings.js'; // [N7]

const MINIMAP_ORDER_EVENT = 'steelmans:minimapOrder'; // same name in input/CommandInput.js
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // screen corners (NDC) for the camera view outline
const TAU = Math.PI * 2;
const KIND_STRUCTURE = 0, KIND_VEHICLE = 1, KIND_MECH = 2, KIND_CREW = 3, KIND_AIR = 4; // [N7] aircraft = triangle
// minimap.css is a separate file next to this module (no index.html change needed)
try {
  const href = new URL('./minimap.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
} catch { /* no DOM / odd URL: the minimap still works, just without the radar frame styling */ }

export class Minimap {
  /**
   * @param {import('../game/World.js').World} world
   * @param {THREE.Camera} camera
   * @param {object} [opts]  { onFocus(point) } – move the camera (CameraKeys.focus)
   */
  constructor(world, camera, { onFocus } = {}) {
    this.world = world;
    this.camera = camera;
    this.onFocus = onFocus;
    this.timer = 0;
    this.time = 0;
    this.hp = new WeakMap();      // unit -> last seen HP (damage detection)
    this.flashUntil = new WeakMap();
    this.background = null;       // pre-rendered terrain layer (per map)
    this.backgroundMap = null;
    this.fogLayer = null;
    this.fogVersion = -1;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();
    this._ndc = new THREE.Vector2();
    this._dir = new THREE.Vector3();
    this._lists = [null, null, null, null];    // scratch: current unit lists of the world
    this._viewPts = new Float32Array(8);      // camera outline corners (x, y × 4), reused
    this._toMiniFn = (x, z) => this.toMini(x, z);
    this.blips = new Map();       // [B3] unit -> last swept snapshot { x, y, kind, team, ally, t } (own, allied and enemy units)
    this.sweepAngle = -Math.PI / 2; // radians, 0 = right, clockwise on screen; starts pointing up
    this.damageTimer = 0;
    this.primed = false;          // first frame of a map: everything is "swept" once so the map is not empty
    this.layersDisposed = false;
    this.res = MINIMAP.minPixelRatio; // [R2] backing pixels per logical px (MINIMAP.size); refreshed by #syncResolution
    this.resDirty = true;             // measure the element on the next redraw
    this.resWait = 0;                 // s left of the resize debounce
    this._onResize = () => { this.resDirty = true; this.resWait = MINIMAP.resizeDebounce; };
    window.addEventListener('resize', this._onResize);
    this.el = this.#createElement();
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.overlay = null;
    this.trail = null;
    this.radarRace = undefined;   // race the radar layers were built for
    this.radarColor = RADAR.fallbackColor; // stats are not loaded yet here: the race colour is applied lazily in update()
    this.#buildLayers();
    this.el.hidden = true; // shown once a map is loaded
  }

  update(dt) {
    if (this.layersDisposed) return;
    this.time += dt;
    this.timer -= dt;
    this.damageTimer -= dt;
    if (this.timer > 0) return;
    const elapsed = RADAR.redrawInterval - this.timer; // time since the last redraw (>= interval)
    this.timer = RADAR.redrawInterval;
    const map = this.world.map;
    this.el.hidden = !map;
    if (!map) { this.primed = false; this.blips.clear(); return; }
    if (this.resDirty) {
      this.resWait -= elapsed;
      if (this.resWait <= 0) this.#syncResolution(map);
    }
    // Race known / changed (economy exists only after the stats are loaded, so getStats() is safe here)
    if (this.world.economy?.races?.[localTeam()] !== this.radarRace) this.#applyRace();
    if (this.backgroundMap !== map) { this.#renderBackground(map); this.blips.clear(); this.primed = false; }
    if (this.damageTimer <= 0) { this.damageTimer = MINIMAP.updateInterval; this.#trackDamage(); }
    const prev = this.sweepAngle;
    const delta = Math.min(elapsed * TAU / RADAR.sweepPeriod, TAU);
    this.sweepAngle = prev + delta;
    this.#draw(map, prev, this.primed ? delta : TAU);
    this.primed = true;
  }

  /** Releases DOM, canvases, listeners (the element owns the pointer listeners) and snapshots. */
  dispose() {
    this.layersDisposed = true;
    window.removeEventListener('resize', this._onResize);
    this.el?.remove();
    for (const c of [this.background, this.fogLayer, this.overlay, this.trail, this.canvas]) {
      if (c) { c.width = 0; c.height = 0; }
    }
    this.background = this.fogLayer = this.overlay = this.trail = null;
    this.blips.clear();
    this.hp = new WeakMap();
    this.flashUntil = new WeakMap();
    this.ctx = null;
    this.canvas = null;
    this.onFocus = null;
  }

  // ---------- coordinates ----------

  get mapSize() { return MINIMAP.size; }
  /** World x/z -> minimap pixels (top = −Z, the direction the player looks at the start) */
  toMini(x, z) {
    const s = this.world.map.size;
    return [(x / s + 0.5) * this.mapSize, (z / s + 0.5) * this.mapSize];
  }
  toWorld(px, py) {
    const s = this.world.map.size;
    return new THREE.Vector3((px / this.mapSize - 0.5) * s, 0, (py / this.mapSize - 0.5) * s);
  }

  // ---------- DOM ----------

  #createElement() {
    document.getElementById('minimap')?.remove();
    const el = document.createElement('div');
    el.id = 'minimap';
    Object.assign(el.style, {
      position: 'fixed', right: `${MINIMAP.margin}px`, bottom: `${MINIMAP.margin}px`,
      padding: `${MINIMAP.padding}px`, background: MINIMAP.background, border: MINIMAP.border,
      borderRadius: `${MINIMAP.borderRadius}px`, zIndex: String(MINIMAP.zIndex), lineHeight: '0',
      cursor: 'pointer',
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.round(MINIMAP.size * this.res);
    Object.assign(canvas.style, { width: `${MINIMAP.size}px`, height: `${MINIMAP.size}px` });
    canvas.getContext('2d').setTransform(this.res, 0, 0, this.res, 0, 0);
    el.appendChild(canvas);
    document.body.appendChild(el);

    // Click or drag on the map moves the camera
    let dragging = false;
    const focusAt = (e) => {
      if (!this.world.map) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * this.mapSize;
      const py = ((e.clientY - rect.top) / rect.height) * this.mapSize;
      this.onFocus?.(this.toWorld(px, py));
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // [N7] modifier + click = ping (allies see it), the camera stays
      if (isPingClick(e) && this.world.map) {
        const rect = canvas.getBoundingClientRect();
        submitPing(this.toWorld(((e.clientX - rect.left) / rect.width) * this.mapSize, ((e.clientY - rect.top) / rect.height) * this.mapSize));
        e.preventDefault(); e.stopPropagation();
        return;
      }
      // An armed point order (Move / Attack-move / Patrol) takes the click instead of the camera
      if (this.#sendOrder(e, true)) { e.preventDefault(); e.stopPropagation(); return; }
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      focusAt(e);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => { if (dragging) focusAt(e); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    // Right click = order for the selected own units to that place (CommandInput listens); Shift = queue
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;
      this.#sendOrder(e, false);
      e.preventDefault();
      e.stopPropagation();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  }

  // Hands the clicked ground point to CommandInput (same path as a terrain click); true when it took the click
  #sendOrder(e, left) {
    if (!this.world.map) return false;
    const rect = this.canvas.getBoundingClientRect();
    const point = this.toWorld(((e.clientX - rect.left) / rect.width) * this.mapSize, ((e.clientY - rect.top) / rect.height) * this.mapSize);
    const detail = { point, queued: e.shiftKey, left, handled: false };
    window.dispatchEvent(new CustomEvent(MINIMAP_ORDER_EVENT, { detail }));
    return detail.handled;
  }

  // ---------- layers ----------

  // [R2] Picks the backing-store resolution from the real on-screen size × devicePixelRatio and rebuilds the layers
  #syncResolution(map) {
    this.resDirty = false;
    const css = this.canvas.clientWidth; // 0 while hidden: fall back to the logical size
    const wanted = (css > 0 ? css / MINIMAP.size : 1) * (window.devicePixelRatio || 1);
    const res = Math.round(THREE.MathUtils.clamp(wanted, MINIMAP.minPixelRatio, MINIMAP.maxPixelRatio) * 4) / 4;
    if (res === this.res) return;
    this.res = res;
    this.canvas.width = this.canvas.height = Math.round(MINIMAP.size * res); // resets the context state
    this.ctx.setTransform(res, 0, 0, res, 0, 0);
    if (this.backgroundMap === map) this.#renderBackground(map); // a new map renders its own background right after
    this.#buildLayers();
  }

  // Terrain by height + obstacles + super node + starts; drawn once per map (and per resolution change)
  #renderBackground(map) {
    const px = Math.round(MINIMAP.size * this.res);
    const bg = document.createElement('canvas');
    bg.width = bg.height = px;
    drawMapBackground(bg.getContext('2d'), map, px, { markScale: this.res });
    if (this.background) { this.background.width = 0; this.background.height = 0; }
    this.background = bg;
    this.backgroundMap = map;
    this.fogVersion = -1;
  }

  // Black for unexplored, dark for shrouded cells – rebuilt only when the fog recomputed
  #fogImage() {
    const fog = this.world.fog;
    if (!fog || fog.mode === 'off') return null;
    if (this.fogLayer && this.fogVersion === fog.version) return this.fogLayer;
    const n = fog.cols;
    const layer = this.fogLayer?.width === n ? this.fogLayer : Object.assign(document.createElement('canvas'), { width: n, height: n });
    const ctx = layer.getContext('2d');
    ctx.clearRect(0, 0, n, n);
    const shroud = MINIMAP.shroudColor;
    const black = MINIMAP.unexploredColor;
    for (let i = 0; i < n * n; i++) {
      if (fog.visible[i]) continue;
      ctx.fillStyle = fog.mode === 'unexplored' && !fog.explored[i] ? black : shroud;
      ctx.fillRect(i % n, Math.floor(i / n), 1, 1);
    }
    this.fogLayer = layer;
    this.fogVersion = fog.version;
    return layer;
  }

  // Own units that lost HP since the last redraw start blinking
  #trackDamage() {
    const w = this.world;
    const lists = this._lists;
    lists[0] = w.mechs; lists[1] = w.crews; lists[2] = w.vehicles; lists[3] = w.structures;
    for (let k = 0; k < 4; k++) {
      const list = lists[k];
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (u.destroyed || u.removed || u.inside || !u.world || !isLocal(u)) continue;
        const hp = unitHp(u);
        const last = this.hp.get(u);
        if (last !== undefined && hp < last) this.flashUntil.set(u, this.time + MINIMAP.damageFlashTime);
        this.hp.set(u, hp);
      }
    }
  }

  // Radar colour of the local player's race (stats.json races[race].uiColor.primary, as the HUD); rebuilds the layers
  #applyRace() {
    const race = this.world.economy?.races?.[localTeam()];
    this.radarRace = race;
    const primary = getStats().races?.[race]?.uiColor?.primary;
    this.radarColor = typeof primary === 'string' && /^#[0-9a-f]{6}$/i.test(primary) ? primary : RADAR.fallbackColor;
    this.#buildLayers();
  }

  #buildLayers() {
    this.el.style.setProperty('--radar-color', this.radarColor);
    this.el.style.setProperty('--radar-glow-alpha', String(RADAR.frameGlowAlpha));
    for (const c of [this.overlay, this.trail]) if (c) { c.width = 0; c.height = 0; }
    this.overlay = this.#renderOverlay();
    this.trail = this.#renderTrail();
  }

  // Concentric range rings (clipped by the square canvas) + centre dot; drawn once per race
  #renderOverlay() {
    const n = MINIMAP.size;
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(n * this.res);
    const ctx = c.getContext('2d');
    ctx.scale(this.res, this.res);
    const half = n / 2;
    const step = half / RADAR.ringsInside;
    ctx.strokeStyle = this.radarColor;
    ctx.fillStyle = this.radarColor;
    ctx.globalAlpha = RADAR.ringAlpha;
    ctx.lineWidth = RADAR.ringWidth;
    for (let r = step; r <= half * Math.SQRT2 + 0.5; r += step) { // rings past the frame are cut by the canvas edge
      ctx.beginPath();
      ctx.arc(half, half, r, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = RADAR.crossAlpha;
    ctx.beginPath();
    ctx.moveTo(half, 0); ctx.lineTo(half, n);
    ctx.moveTo(0, half); ctx.lineTo(n, half);
    ctx.stroke();
    ctx.globalAlpha = RADAR.centerAlpha;
    ctx.beginPath();
    ctx.arc(half, half, RADAR.centerRadius, 0, TAU);
    ctx.fill();
    return c;
  }

  // Fading wedge behind the sweep line (angle 0 = line, trailing to negative angles); drawn once, rotated per frame
  #renderTrail() {
    const reach = Math.ceil(MINIMAP.size * Math.SQRT1_2) + 2; // centre -> corner
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(reach * 2 * this.res);
    const ctx = c.getContext('2d');
    ctx.scale(this.res, this.res);
    ctx.translate(reach, reach);
    ctx.fillStyle = this.radarColor;
    const steps = RADAR.trailSteps;
    const span = (RADAR.trailDegrees * Math.PI) / 180;
    for (let i = 0; i < steps; i++) {
      ctx.globalAlpha = RADAR.trailAlpha * (1 - i / steps) ** 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, reach, -span * (i + 1) / steps, -span * i / steps);
      ctx.closePath();
      ctx.fill();
    }
    this.trailReach = reach;
    return c;
  }

  // Refreshes the snapshot of every non-own unit the sweep passed since the last frame (arc prev .. prev + delta)
  #sweepBlips(prev, delta) {
    const n = MINIMAP.size;
    const half = n / 2;
    const w = this.world; // the arrays are replaced by World.update, read them fresh (no allUnits copy)
    const lists = this._lists; // reused array of the 4 current lists
    lists[0] = w.mechs; lists[1] = w.crews; lists[2] = w.vehicles; lists[3] = w.structures;
    for (let k = 0; k < 4; k++) {
      const list = lists[k];
      for (let i = 0; i < list.length; i++) this.#sweepUnit(list[i], prev, delta, n, half);
    }
    // Snapshots of units that left the lists (removed) or died / went inside: drop them when the sweep passes
    for (const [u, snap] of this.blips) {
      if (!u.destroyed && !u.removed && !u.inside && u.world) continue;
      let rel = Math.atan2(snap.y - half, snap.x - half) - prev;
      rel -= Math.floor(rel / TAU) * TAU;
      if (rel <= delta) this.blips.delete(u);
    }
  }

  #sweepUnit(u, prev, delta, n, half) {
    const alive = !u.destroyed && !u.removed && !u.inside && u.world;
    if (!alive) return; // handled by the blips pass in #sweepBlips
    const size = this.world.map.size;
    const x = (u.position.x / size + 0.5) * n;
    const y = (u.position.z / size + 0.5) * n;
    const snap = this.blips.get(u);
    let rel = Math.atan2(y - half, x - half) - prev;
    rel -= Math.floor(rel / TAU) * TAU;
    if (rel > delta) return; // not passed this frame
    if (this.world.isVisible(u)) {
      const s = snap ?? { x: 0, y: 0, kind: 0, team: 0, ally: false, t: 0 };
      s.x = x; s.y = y; s.team = u.team; s.t = this.time;
      s.kind = u.isStructure ? KIND_STRUCTURE : u.airborne ? KIND_AIR : u.isVehicle ? KIND_VEHICLE : 'parts' in u ? KIND_MECH : KIND_CREW;
      s.ally = !isLocal(u) && areAllies(localTeam(), u.team);
      if (!snap) this.blips.set(u, s);
    } else if (snap) {
      this.blips.delete(u); // hidden by fog now
    }
  }

  // One marker: buildings small squares, units circles; sizes follow the window height (resolution)
  #drawBlip(ctx, x, y, kind, team, ally, scale) {
    ctx.fillStyle = TEAMS[team]?.color ?? '#fff';
    if (ally) { ctx.strokeStyle = PLAYERS_UI.minimapAllyOutline; ctx.lineWidth = PLAYERS_UI.minimapAllyOutlineWidth; }
    if (kind === KIND_STRUCTURE) {
      const s = R2.minimap.structureHalf * MINIMAP.structureScale * scale; // [R2] small squares
      ctx.fillRect(x - s, y - s, s * 2, s * 2);
      if (ally) ctx.strokeRect(x - s, y - s, s * 2, s * 2);
    } else if (kind === KIND_AIR) { // [N7] triangle pointing up
      const r = R2.minimap.vehicleRadius * AIR.minimapBlipScale * scale;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      ctx.fill();
      if (ally) ctx.stroke();
    } else {
      const r = (kind === KIND_VEHICLE ? R2.minimap.vehicleRadius : kind === KIND_MECH ? R2.minimap.mechRadius : R2.minimap.crewRadius) * scale;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      if (ally) ctx.stroke();
    }
  }

  #draw(map, prevAngle, delta) {
    const ctx = this.ctx;
    const n = MINIMAP.size;
    const half = n / 2;
    ctx.clearRect(0, 0, n, n);
    ctx.drawImage(this.background, 0, 0, n, n);
    const fog = this.#fogImage();
    if (fog) {
      // The fog grid covers whole cells, possibly a bit more than the map
      const covered = (this.world.fog.cols * this.world.fog.cellSize / map.size) * n;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fog, 0, 0, covered, covered);
    }
    ctx.drawImage(this.overlay, 0, 0, n, n); // range rings + centre dot

    // Sweep line with its fading trail (rotated around the map centre)
    const angle = this.sweepAngle;
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(angle);
    ctx.drawImage(this.trail, -this.trailReach, -this.trailReach, this.trailReach * 2, this.trailReach * 2);
    ctx.globalAlpha = RADAR.sweepLineAlpha;
    ctx.strokeStyle = this.radarColor;
    ctx.lineWidth = RADAR.sweepLineWidth;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(this.trailReach, 0);
    ctx.stroke();
    ctx.restore();

    this.#sweepBlips(prevAngle, delta);
    const dotScale = THREE.MathUtils.clamp(window.innerHeight / R2.minimap.refHeight, R2.minimap.minScale, R2.minimap.maxScale)
      * N2_UI.minimapMarkScale; // [N2] markers 25 % larger

    // All units (own too): snapshot from the last sweep pass, fading (afterglow) until the next pass.
    // The damage blink of an own unit runs at its snapshot position.
    const blinkOn = Math.floor(this.time * MINIMAP.damageBlinkRate * 2) % 2 === 0;
    for (const [u, s] of this.blips) {
      const age = this.time - s.t;
      const fade = Math.max(RADAR.afterglowMin, 1 - (age / RADAR.afterglowTime) * (1 - RADAR.afterglowMin));
      const pulse = age < RADAR.hitPulseTime ? 1 + RADAR.hitPulseScale * (1 - age / RADAR.hitPulseTime) : 1;
      ctx.globalAlpha = fade;
      this.#drawBlip(ctx, s.x, s.y, s.kind, s.team, s.ally, dotScale * pulse);
      if (blinkOn && (this.flashUntil.get(u) ?? 0) > this.time) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = MINIMAP.damageColor;
        ctx.lineWidth = MINIMAP.viewWidth;
        ctx.beginPath();
        ctx.arc(s.x, s.y, MINIMAP.damageRing, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    drawMinimapMarks(ctx, this._toMiniFn, this.world); // [N7] pings + lost arms of the own team
    this.#drawView(ctx);
  }

  // Outline of what the camera sees: screen corners projected onto the ground plane
  #drawView(ctx) {
    const pts = this._viewPts;
    for (let i = 0; i < CORNERS.length; i++) {
      this._ray.setFromCamera(this._ndc.set(CORNERS[i][0], CORNERS[i][1]), this.camera);
      const origin = this._ray.ray.origin;
      let hit = this._ray.ray.intersectPlane(this._plane, this._hit);
      if (!hit || Math.hypot(hit.x - origin.x, hit.z - origin.z) > MINIMAP.viewMaxDistance) {
        // corner above the horizon or very far: cut it at viewMaxDistance along the flattened direction
        const dir = this._dir.copy(this._ray.ray.direction).setY(0).normalize();
        hit = this._hit.copy(origin).addScaledVector(dir, MINIMAP.viewMaxDistance).setY(0);
      }
      const s = this.world.map.size;
      pts[i * 2] = (hit.x / s + 0.5) * this.mapSize;
      pts[i * 2 + 1] = (hit.z / s + 0.5) * this.mapSize;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, MINIMAP.size, MINIMAP.size);
    ctx.clip();
    ctx.strokeStyle = MINIMAP.viewColor;
    ctx.lineWidth = MINIMAP.viewWidth;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) (i ? ctx.lineTo(pts[i * 2], pts[i * 2 + 1]) : ctx.moveTo(pts[0], pts[1]));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Map picture without units: terrain (ASCII maps: cell types, others: height), obstacles, super node, start rings.
 * Shared by the minimap and the map preview (src/ui/MapPreview.js). Top = −Z.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../game/Map.js').GameMap} map
 * @param {number} n  canvas size in px (square)
 * @param {{starts?: boolean}} [opts]  starts: false = no start rings (the preview draws its own)
 */
export function drawMapBackground(ctx, map, n, { starts = true, markScale = 1 } = {}) { // markScale: px multiplier of the start / super node marks (hi-res canvas)
  const toMini = (x, z) => [(x / map.size + 0.5) * n, (z / map.size + 0.5) * n];
  const img = ctx.createImageData(n, n);
  const c = new THREE.Color();
  if (map.ascii) {
    // [MAPS] colour of the cell under each pixel
    const names = Object.keys(CELL);
    const colors = names.map((k) => new THREE.Color(MAPS.ascii.colors[k] ?? MAPS.ascii.colors.grass));
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        const col = colors[map.cellAt(((px + 0.5) / n - 0.5) * map.size, ((py + 0.5) / n - 0.5) * map.size)];
        const i = (py * n + px) * 4;
        img.data[i] = col.r * 255; img.data[i + 1] = col.g * 255; img.data[i + 2] = col.b * 255; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  } else {
    const low = new THREE.Color(MINIMAP.terrainLow);
    const high = new THREE.Color(MINIMAP.terrainHigh);
    const opts = map.terrainOptions;
    const amp = map.terrain.hillAmplitude ?? null;
    let min = Infinity, max = -Infinity;
    const heights = new Float32Array(n * n);
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        const h = terrainHeight(((px + 0.5) / n - 0.5) * map.size, ((py + 0.5) / n - 0.5) * map.size, opts);
        heights[py * n + px] = h;
        min = Math.min(min, h); max = Math.max(max, h);
      }
    }
    const range = max - min || amp?.[0] || 1;
    for (let i = 0; i < heights.length; i++) {
      c.copy(low).lerp(high, (heights[i] - min) / range);
      img.data[i * 4] = c.r * 255; img.data[i * 4 + 1] = c.g * 255; img.data[i * 4 + 2] = c.b * 255; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const scale = n / map.size;
    ctx.fillStyle = MINIMAP.obstacleColor;
    for (const o of map.obstacles) {
      const [x, y] = toMini(o.x, o.z);
      ctx.beginPath();
      if (o.radius !== undefined) ctx.arc(x, y, o.radius * scale, 0, Math.PI * 2);
      else ctx.rect(x - o.halfX * scale, y - o.halfZ * scale, o.halfX * 2 * scale, o.halfZ * 2 * scale);
      ctx.fill();
    }
  }
  if (starts) {
    ctx.strokeStyle = MINIMAP.startColor;
    ctx.lineWidth = markScale;
    for (const p of map.startPositions) {
      const [x, y] = toMini(p.x, p.z);
      ctx.beginPath();
      ctx.arc(x, y, MINIMAP.startSize * markScale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (map.superNode) {
    const [x, y] = toMini(map.superNode.x, map.superNode.z);
    ctx.fillStyle = MINIMAP.superNodeColor;
    ctx.beginPath();
    ctx.arc(x, y, MINIMAP.superNodeSize * markScale, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Total HP of a unit (mech: sum of its parts, crew: squad HP) */
function unitHp(u) {
  if ('parts' in u) {
    let sum = 0;
    for (const k in u.parts) sum += u.parts[k]?.hp ?? 0;
    return sum;
  }
  return u.hp ?? 0;
}
