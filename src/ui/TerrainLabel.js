// Steel Men – [A14-ui] terrain label under the cursor: "Mud · wheels ×0.35" / "Mud · impassable".
// Small tag next to the pointer (own element, like the wreck tooltip). The DOM is rewritten only when the
// cell / selection classes / type changes; the ground raycast runs at most every TERRAIN_UI.pickInterval s.
// Works without the A14 API in TerrainTypes.js (then it shows only the terrain name).
import * as THREE from 'three';
import * as TerrainTypes from '../game/TerrainTypes.js';
import { t, getLanguage } from '../i18n/i18n.js';
import { esc } from './hudUtil.js';
import { TERRAIN_UI, TERRAIN_COST } from '../config.js';

const CLASS_ORDER = TERRAIN_COST.classes;

/** Terrain class of a selected unit ('legs'|'wheels'|'tracks'|'hover'|'air'), or null when unknown */
function classOfUnit(u) {
  const cls = TerrainTypes.terrainClassOf?.(u.stats);
  if (cls) return cls;
  return u.isMech ? 'legs' : null;
}

export class TerrainLabel {
  /**
   * @param {object} deps  world, camera, dom (canvas), input (CommandInput)
   */
  constructor({ world, camera, dom, input }) {
    this.world = world;
    this.camera = camera;
    this.dom = dom;
    this.input = input;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.pickTimer = 0;
    this.lastX = NaN;
    this.lastY = NaN;
    this.typeName = null;
    this.cells = { x: NaN, z: NaN };
    this.classSeen = new Array(CLASS_ORDER.length).fill(false); // recycled
    this.sig = '';
    this.html = '';
    this.el = document.createElement('div');
    this.el.className = 'hud-tooltip hud-terrain-label';
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }

  /** @param {number} dt seconds; pointer = input.pointerClient; visible = pointer is over the canvas */
  update(dt, visible) {
    const p = this.input.pointerClient;
    const grid = this.world.terrainTypes;
    if (!visible || !p || !grid?.nameAt || this.input.hoveredWreck) { this.el.hidden = true; return; }

    this.pickTimer -= dt;
    if (p.x !== this.lastX || p.y !== this.lastY || this.pickTimer <= 0) {
      if (this.pickTimer <= 0) {
        this.pickTimer = TERRAIN_UI.pickInterval;
        this.#pick(p);
      }
      this.lastX = p.x;
      this.lastY = p.y;
    }
    if (this.typeName === null) { this.el.hidden = true; return; }

    // classes of the selection (recycled flags, no allocation)
    const seen = this.classSeen;
    seen.fill(false);
    let key = 0;
    for (const u of this.input.selection) {
      if (!u.isMech && !u.isVehicle) continue;
      const cls = classOfUnit(u);
      const i = cls ? CLASS_ORDER.indexOf(cls) : -1;
      if (i >= 0 && !seen[i]) { seen[i] = true; key |= 1 << i; }
    }
    if (key === 0 && TERRAIN_UI.hideTypes.includes(this.typeName)) { this.el.hidden = true; return; }

    const sig = `${this.typeName}|${key}|${getLanguage()}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.html = this.#build(key);
    }
    if (this.el._html !== this.html) { this.el._html = this.html; this.el.innerHTML = this.html; }
    this.el.style.left = `${p.x + TERRAIN_UI.offsetX}px`;
    this.el.style.top = `${p.y + TERRAIN_UI.offsetY}px`;
    this.el.hidden = false;
  }

  #pick(p) {
    const ground = this.world.ground;
    this.typeName = null;
    if (!ground) return;
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((p.x - rect.left) / rect.width) * 2 - 1, -((p.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObject(ground, false)[0];
    if (hit) this.typeName = this.world.terrainTypes.nameAt(hit.point.x, hit.point.z) ?? null;
  }

  /** Label text; runs only when the type / selection classes / language changed */
  #build(key) {
    const name = t(`terrain.type.${this.typeName}`);
    const parts = [];
    for (let i = 0; i < CLASS_ORDER.length && parts.length < TERRAIN_UI.maxClasses; i++) {
      if (!(key & (1 << i))) continue;
      const cls = CLASS_ORDER[i];
      const f = TerrainTypes.terrainSpeedFactor?.(this.typeName, cls);
      const clsName = t(`terrain.class.${cls}`);
      if (typeof f !== 'number') continue; // old TerrainTypes.js without the API
      parts.push(f <= 0
        ? t('terrain.label.blocked', { cls: clsName })
        : t('terrain.label.factor', { cls: clsName, factor: this.#fmt(f) }));
    }
    const tail = parts.length ? ` · ${parts.map(esc).join(' · ')}` : '';
    return `<b>${esc(name)}</b>${tail}`;
  }

  #fmt(n) {
    return n.toLocaleString(getLanguage(), { maximumFractionDigits: TERRAIN_UI.decimals });
  }

  dispose() {
    this.el.remove();
    this.world = this.camera = this.dom = this.input = null;
  }
}
