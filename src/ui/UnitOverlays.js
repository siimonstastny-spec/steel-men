// Steel Men – bars above units: health (shown when selected, recently damaged, or always via
// world.settings.ui.alwaysShowHealthBars), boarding progress of a mech and production progress at the
// spawn point of the item being produced. Plain DOM elements projected from 3D every frame.
import * as THREE from 'three';
import { HUD } from '../config.js';
import { isLocal } from '../core/LocalPlayer.js';
import { hpColor, unitHp } from './hudUtil.js';
import { progressOf } from './ProductionQueue.js';

const _v = new THREE.Vector3();

export class UnitOverlays {
  /**
   * @param {object} deps  { world, camera, dom (canvas), input, queue (ProductionQueue), spawnPoint(producer) -> {x,z} }
   */
  constructor({ world, camera, dom, input, queue, spawnPoint }) {
    this.world = world;
    this.camera = camera;
    this.dom = dom;
    this.input = input;
    this.queue = queue;
    this.spawnPoint = spawnPoint;
    this.root = document.createElement('div');
    this.root.id = 'unit-overlays';
    document.body.appendChild(this.root);
    this.entries = new Map();   // unit or queue item -> { el, hpBar, progBar, lastHp, damagedFor }
    this.time = 0;
  }

  update(dt) {
    this.time += dt;
    const ui = this.world.settings?.ui ?? {};
    const rect = this.dom.getBoundingClientRect();
    const seen = new Set();
    const cfg = HUD.overlays;

    for (const u of this.world.allUnits) {
      if (u.destroyed || u.removed || u.inside || u.visible === false || !u.stats) continue;
      seen.add(u);
      const kind = u.isMech ? 'mech' : u.isVehicle ? 'vehicle' : u.isStructure ? 'structure' : 'crew';
      const e = this.#entry(u, cfg.barWidth[kind]);
      const [hp, maxHp] = unitHp(u);
      if (e.lastHp !== null && hp < e.lastHp) e.damagedFor = cfg.damagedShowTime;
      e.lastHp = hp;
      e.damagedFor = Math.max(0, e.damagedFor - dt);
      const selected = this.input.selection.includes(u);
      const boarding = u.isMech && u.crew && u.boardTimer > 0;
      const building = u.isStructure && u.underConstruction; // construction progress
      const showHp = ui.alwaysShowHealthBars || selected || e.damagedFor > 0;
      // Boarding / construction of own units is always shown (the player waits for it); other teams' only when selected / always-on
      const showProgress = (boarding || building) && (isLocal(u) || selected || ui.alwaysShowBuildProgress);
      if (!showHp && !showProgress) { e.el.hidden = true; continue; }

      // [N2] compare as displayed (rounded): a finished building at 439.9 / 440 shows 440/440 and must be "full"
      const ratio = maxHp ? (Math.round(hp) >= Math.round(maxHp) ? 1 : hp / maxHp) : 0;
      e.hpWrap.hidden = !showHp;
      e.hpBar.style.width = `${ratio * 100}%`;
      e.hpBar.style.background = hpColor(ratio);
      e.hpWrap.style.setProperty('--uo-border', isLocal(u) ? cfg.ownBorder : cfg.enemyBorder);
      e.progWrap.hidden = !showProgress;
      if (showProgress && building) {
        e.progBar.style.width = `${u.progress * 100}%`;
      } else if (showProgress) {
        e.boardTotal = Math.max(e.boardTotal, u.boardTimer); // first value seen = full boarding time
        e.progBar.style.width = `${(1 - u.boardTimer / e.boardTotal) * 100}%`;
      } else e.boardTotal = 0;

      const fullHeight = (u.bodyHeight ?? u.aimHeight * 2) * (building ? u.holder?.scale.y ?? 1 : 1);
      const top = fullHeight + cfg.heightOffset[kind];
      this.#place(e, _v.copy(u.position).setY(u.position.y + top), rect);
    }

    // Production in progress: a bar at the spawn point of the producer (no buildings yet)
    for (const item of this.queue.active) {
      const p = this.spawnPoint?.(item.producer);
      if (!p) continue;
      seen.add(item);
      const e = this.#entry(item, cfg.barWidth.production, item.icon);
      e.hpWrap.hidden = true;
      e.progWrap.hidden = false;
      e.progBar.style.width = `${progressOf(item) * 100}%`;
      const y = this.world.heightAt(p.x, p.z) + cfg.productionHeight;
      this.#place(e, _v.set(p.x, y, p.z), rect);
    }

    for (const [key, e] of this.entries) {
      if (!seen.has(key)) { e.el.remove(); this.entries.delete(key); }
    }
  }

  #place(e, world, rect) {
    world.project(this.camera);
    if (world.z > 1 || world.z < -1) { e.el.hidden = true; return; }
    const x = rect.left + ((world.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - world.y) / 2) * rect.height;
    e.el.hidden = false;
    e.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }

  #entry(key, width, icon = '') {
    let e = this.entries.get(key);
    if (e) return e;
    const el = document.createElement('div');
    el.className = 'uo';
    el.style.setProperty('--uo-h', `${HUD.overlays.barHeight}px`);
    el.innerHTML = `${icon ? `<span class="ico">${icon}</span>` : ''}`
      + `<div class="b hp" style="width:${width}px"><i></i></div>`
      + `<div class="b prog" style="width:${width}px"><i style="background:${HUD.overlays.progressColor}"></i></div>`;
    this.root.appendChild(el);
    e = {
      el, lastHp: null, damagedFor: 0, boardTotal: 0,
      hpWrap: el.querySelector('.hp'), hpBar: el.querySelector('.hp > i'),
      progWrap: el.querySelector('.prog'), progBar: el.querySelector('.prog > i'),
    };
    this.entries.set(key, e);
    return e;
  }
}
