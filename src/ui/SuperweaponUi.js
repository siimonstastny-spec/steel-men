// Steel Men – [A9-F4a] UI of superweapons, auras and detection:
//   • SuperweaponTargeting – launch targeting (CommandInput.setPlacement-compatible: move / confirm / cancel): a ring of the
//     blast radius follows the cursor on the terrain, left click launches, right click / Esc cancels
//   • SuperweaponWarnings  – warning for everybody (world.superweapons 'warning'): banner with countdown, impact ring on the
//     terrain and a countdown label projected over it (pooled, no allocation per frame)
//   • RangeRings           – aura (blue) and detection (green) circle of the selected building / unit and of a building being placed
//   • drawStrikeMarks      – pulsing circles of the strikes on the minimap (called by Minimap.#draw)
// Pure view of the simulation: the only thing it sends is the launch command. Every class has dispose().
import * as THREE from 'three';
import { ORDER_BUTTONS, STEALTH } from '../config.js';
import { t } from '../i18n/i18n.js';
import { unitStats } from '../data/Stats.js';
import { isLocal } from '../core/LocalPlayer.js';
import { commandBus } from '../game/commands/CommandBus.js';
import { launchCommand } from '../game/commands/superweaponCommands.js';

// Stylesheet next to this module (no index.html change needed), same way as minimap.css
try {
  const href = new URL('./superweapon.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
} catch { /* no DOM: the markup still works, just unstyled */ }

/** UI constants of this module (not simulation balance) */
export const SW_UI = {
  ringSegments: 72,          // segments of a ring on the terrain
  ringWidth: 0.9,            // world units, ribbon width of a ring
  ringLift: 0.7,             // world units above the terrain (no z-fighting)
  ringRenderOrder: 5,
  maxStrikeSlots: 6,         // strikes shown at the same time (marker + banner each)
  targetColor: '#ffd24a',    // launch targeting circle
  targetOpacity: 0.85,
  enemyStrikeColor: '#ff4a3a', // impact circle of a strike launched by another team
  ownStrikeColor: '#ffb03a',   // ... launched by the local team
  strikeOpacity: 0.8,
  auraColor: '#4ac8ff',
  auraInactiveOpacity: 0.25,
  auraOpacity: 0.7,
  detectionColor: '#9aff6a',
  detectionOpacity: 0.7,
  labelHeightPx: 0,          // extra pixel offset of the countdown label
  minimapLineWidth: 2,
  minimapPulsesPerSec: 1.5,
  minimapMinRadiusPx: 3,
  minimapFillAlpha: 0.18,
  minimapEnemyColor: '#ff4a3a',
  minimapOwnColor: '#ffb03a',
};

const TAU = Math.PI * 2;
const SIN = new Float32Array(SW_UI.ringSegments + 1);
const COS = new Float32Array(SW_UI.ringSegments + 1);
for (let i = 0; i <= SW_UI.ringSegments; i++) { SIN[i] = Math.sin((i / SW_UI.ringSegments) * TAU); COS[i] = Math.cos((i / SW_UI.ringSegments) * TAU); }

const _v = new THREE.Vector3();
const RING_INDEX = (() => {
  const n = SW_UI.ringSegments;
  const index = new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  return index;
})();

const ringMaterial = (color, opacity) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});

/** A ring (ribbon) lying on the terrain; set() re-drapes it only when centre or radius changed */
class DrapedRing {
  constructor(scene, material) {
    this.scene = scene;
    this.material = material;
    const n = SW_UI.ringSegments;
    this.positions = new THREE.BufferAttribute(new Float32Array((n + 1) * 2 * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setIndex(new THREE.BufferAttribute(RING_INDEX, 1)); // shared index data, never changes
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false; // the positions change: the bounding sphere is not kept up to date
    this.mesh.renderOrder = SW_UI.ringRenderOrder;
    this.mesh.visible = false;
    this.mesh.raycast = () => {}; // never picked
    scene.add(this.mesh);
    this.x = this.z = this.r = NaN;
  }

  /** Shows the ring around (x, z); `world.heightAt` drapes it on the terrain */
  show(world, x, z, radius) {
    this.mesh.visible = true;
    if (x === this.x && z === this.z && radius === this.r) return;
    this.x = x; this.z = z; this.r = radius;
    const half = SW_UI.ringWidth / 2;
    const arr = this.positions.array;
    for (let i = 0, o = 0; i <= SW_UI.ringSegments; i++) {
      const c = COS[i];
      const s = SIN[i];
      for (let side = 0; side < 2; side++) {
        const r = radius + (side ? half : -half);
        const px = x + c * r;
        const pz = z + s * r;
        arr[o++] = px; arr[o++] = world.heightAt(px, pz) + SW_UI.ringLift; arr[o++] = pz;
      }
    }
    this.positions.needsUpdate = true;
  }

  hide() { this.mesh.visible = false; }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.scene = this.mesh = this.geometry = this.positions = this.material = null;
  }
}

// ---------- launch targeting ----------

/**
 * Targeting mode after the "Launch" button / key. Plugs into CommandInput.setPlacement (move / confirm / cancel); the left click
 * submits the launch command, the right click and Esc cancel (CommandInput calls cancel()).
 */
export class SuperweaponTargeting {
  /** @param {{world:object, input:object, building:object, team:number}} deps */
  constructor({ world, input, building, team }) {
    this.world = world;
    this.input = input;
    this.building = building;
    this.team = team;
    this.radius = building.stats?.superweapon?.radius ?? 0;
    this.material = ringMaterial(SW_UI.targetColor, SW_UI.targetOpacity);
    this.ring = new DrapedRing(world.scene, this.material);
    this.done = false;
    input.dom.style.cursor = ORDER_BUTTONS.pendingCursor;
  }

  move(point) {
    if (this.done) return;
    if (!point) this.ring.hide();
    else this.ring.show(this.world, point.x, point.z, this.radius);
  }

  confirm(point) {
    if (this.done) return;
    if (point && this.world.superweapons?.canLaunch(this.building)) {
      commandBus.submit(launchCommand(this.team, this.building, point.x, point.z));
    }
    this.cancel();
  }

  cancel() {
    if (this.done) return;
    this.done = true;
    if (this.input.placement === this) this.input.placement = null;
    this.input.dom.style.cursor = '';
    this.ring.dispose();
    this.material.dispose();
    this.world = this.input = this.building = this.ring = this.material = null;
  }
}

// ---------- warning for everybody ----------

export class SuperweaponWarnings {
  /** @param {{world:object, camera:THREE.Camera, dom:HTMLElement}} deps  dom = the render canvas (label projection) */
  constructor({ world, camera, dom }) {
    this.world = world;
    this.camera = camera;
    this.dom = dom;
    this.root = document.createElement('div');
    this.root.className = 'sw-warn';
    this.banners = document.createElement('div');
    this.banners.className = 'sw-warn-banners';
    this.labels = document.createElement('div');
    this.labels.className = 'sw-warn-labels';
    this.root.append(this.banners, this.labels);
    document.body.appendChild(this.root);
    this.ownMaterial = ringMaterial(SW_UI.ownStrikeColor, SW_UI.strikeOpacity);
    this.enemyMaterial = ringMaterial(SW_UI.enemyStrikeColor, SW_UI.strikeOpacity);
    this.slots = [];
    for (let i = 0; i < SW_UI.maxStrikeSlots; i++) {
      const banner = document.createElement('div');
      banner.className = 'sw-warn-banner';
      banner.hidden = true;
      const label = document.createElement('div');
      label.className = 'sw-warn-label';
      label.hidden = true;
      this.banners.appendChild(banner);
      this.labels.appendChild(label);
      this.slots.push({ banner, label, ring: new DrapedRing(world.scene, this.enemyMaterial), id: -1, seconds: -1, y: 0, name: '' });
    }
    this.dirty = true;
    this.off = world.superweapons.on('warning', () => { this.dirty = true; }); // a new strike: refresh at once
  }

  /** Call every frame (UI only) */
  update() {
    if (!this.root) return;
    const sw = this.world.superweapons;
    const strikes = sw.activeStrikes();
    const rect = strikes.length ? this.dom.getBoundingClientRect() : null;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const strike = strikes[i];
      if (!strike) { if (slot.id !== -1) this.#release(slot); continue; }
      if (strike.id !== slot.id) this.#assign(slot, strike);
      const seconds = Math.ceil(sw.timeLeft(strike));
      if (seconds !== slot.seconds) {
        slot.seconds = seconds;
        slot.banner.textContent = t('superweapon.warning', { name: slot.name, s: seconds });
        slot.label.textContent = String(seconds);
      }
      _v.set(strike.x, slot.y, strike.z).project(this.camera);
      if (_v.z > 1 || _v.z < -1) { slot.label.hidden = true; continue; }
      slot.label.hidden = false;
      const x = rect.left + ((_v.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - _v.y) / 2) * rect.height + SW_UI.labelHeightPx;
      slot.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
    this.dirty = false;
  }

  #assign(slot, strike) {
    const own = isLocal(strike.team);
    slot.id = strike.id;
    slot.seconds = -1;
    slot.name = t(`structure.${strike.kind}`);
    slot.y = this.world.heightAt(strike.x, strike.z);
    slot.ring.mesh.material = own ? this.ownMaterial : this.enemyMaterial;
    slot.ring.show(this.world, strike.x, strike.z, strike.radius);
    slot.banner.classList.toggle('own', own);
    slot.label.classList.toggle('own', own);
    slot.banner.hidden = false;
  }

  #release(slot) {
    slot.id = -1;
    slot.seconds = -1;
    slot.ring.hide();
    slot.banner.hidden = true;
    slot.label.hidden = true;
  }

  dispose() {
    this.off?.();
    for (const slot of this.slots) slot.ring.dispose();
    this.ownMaterial.dispose();
    this.enemyMaterial.dispose();
    this.root.remove();
    this.slots.length = 0;
    this.root = this.banners = this.labels = this.world = this.camera = this.dom = this.off = null;
  }
}

// ---------- aura / detection circles ----------

const RING_INFO = new Map(); // `${id}:${race}` -> { auraRadius, detection } of a building type (placement preview)

function typeInfo(id, race) {
  const key = `${id}:${race}`;
  let info = RING_INFO.get(key);
  if (!info) {
    const s = unitStats('structures', id, race) ?? {};
    let detection = s[STEALTH.designationStat] ?? 0;
    for (const a of s.abilities ?? []) if (a.type === STEALTH.detectionType && a.radius > detection) detection = a.radius;
    info = { auraRadius: s.aura?.radius ?? 0, detection };
    RING_INFO.set(key, info);
  }
  return info;
}

export class RangeRings {
  /** @param {{scene:THREE.Scene, world:object, input:object, buildMenu?:object}} deps */
  constructor({ scene, world, input, buildMenu = null }) {
    this.world = world;
    this.input = input;
    this.buildMenu = buildMenu;
    this.auraMaterial = ringMaterial(SW_UI.auraColor, SW_UI.auraOpacity);
    this.detectionMaterial = ringMaterial(SW_UI.detectionColor, SW_UI.detectionOpacity);
    this.aura = new DrapedRing(scene, this.auraMaterial);
    this.detection = new DrapedRing(scene, this.detectionMaterial);
  }

  /** Call every frame (UI only) */
  update() {
    if (!this.world) return;
    let x = 0;
    let z = 0;
    let auraRadius = 0;
    let auraActive = true;
    let detection = 0;
    const ghost = this.buildMenu?.placing?.ghost;
    if (ghost?.point && ghost.fp && ghost.id) { // building being placed: circles at the cursor
      const info = typeInfo(ghost.id, ghost.race);
      x = ghost.point.x; z = ghost.point.z;
      if (info.auraRadius > 0) auraRadius = info.auraRadius + Math.max(ghost.fp.halfX, ghost.fp.halfZ);
      detection = info.detection;
    } else {
      const sel = this.input?.selection;
      const u = sel?.length === 1 ? sel[0] : null;
      if (u && !u.destroyed && !u.removed && !u.inside) {
        x = u.position.x; z = u.position.z;
        const aura = u.isStructure && u.complete ? this.world.auras?.auraOf(u) : null; // shared object: read now
        if (aura && aura.radius > 0) {
          auraRadius = aura.radius + (u.fp ? Math.max(u.fp.halfX, u.fp.halfZ) : 0); // radius counts from the footprint edge
          auraActive = aura.active;
        }
        detection = this.world.stealth?.detectionRadius(u) ?? 0;
      }
    }
    if (auraRadius > 0) {
      this.auraMaterial.opacity = auraActive ? SW_UI.auraOpacity : SW_UI.auraInactiveOpacity;
      this.aura.show(this.world, x, z, auraRadius);
    } else this.aura.hide();
    if (detection > 0) this.detection.show(this.world, x, z, detection);
    else this.detection.hide();
  }

  dispose() {
    this.aura.dispose();
    this.detection.dispose();
    this.auraMaterial.dispose();
    this.detectionMaterial.dispose();
    this.world = this.input = this.buildMenu = this.aura = this.detection = null;
  }
}

// ---------- minimap ----------

/** Called by Minimap.#draw: a pulsing circle (the real blast radius) and a dot for every strike on the way. `time` in seconds. */
export function drawStrikeMarks(ctx, mapSize, world, time) {
  const strikes = world.superweapons?.activeStrikes();
  if (!strikes?.length) return;
  const size = world.map.size;
  const phase = (time * SW_UI.minimapPulsesPerSec) % 1;
  ctx.save();
  ctx.lineWidth = SW_UI.minimapLineWidth;
  for (let i = 0; i < strikes.length; i++) {
    const s = strikes[i];
    const x = (s.x / size + 0.5) * mapSize;
    const y = (s.z / size + 0.5) * mapSize;
    const r = Math.max(SW_UI.minimapMinRadiusPx, (s.radius / size) * mapSize);
    const color = isLocal(s.team) ? SW_UI.minimapOwnColor : SW_UI.minimapEnemyColor;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = SW_UI.minimapFillAlpha;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1 - phase;
    ctx.beginPath(); ctx.arc(x, y, r * (1 + phase), 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, SW_UI.minimapMinRadiusPx, 0, TAU); ctx.fill();
  }
  ctx.restore();
}
