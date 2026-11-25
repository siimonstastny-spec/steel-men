// Steel Men – [W3] frame with ALL queues of the local player, above the player statistics (bottom right).
// Groups: the builders' constructions (current + Shift-queued buildings, read only: click = camera) and the production queue
// of every producing building (icons of the items; the head item is highlighted with its progress, an item waiting for energy
// is marked). Visible only when something is queued. A pure view over world.production (ProductionQueue.js) and the builders'
// orders; a right click on a production item cancels it with the same 'cancelProduction' command as before, a left click puts
// the camera on the production site.
//   const frame = new QueueFrame({ world, queue, parent, spawnPoint, focusAt, onChange })
//   frame.update()   from Hud.refresh() (a few times a second; the markup is rewritten only when it changed)
//   frame.dispose()
import { QUEUE_FRAME } from '../config.js';
import { t } from '../i18n/i18n.js';
import { localTeam } from '../core/LocalPlayer.js';
import { unitName } from './BuildMenu.js';
import { buildingIconHtml, iconVersion } from './IconRenderer.js';
import { progressOf, isWaitingEnergy } from './ProductionQueue.js';
import { setHtmlKeepScroll } from './scrollKeep.js';
import { esc } from './hudUtil.js';

const Q = QUEUE_FRAME;
const ICON_LETTERS = 3;          // letters of a building name used as its icon (same as the construction grid)
const ENERGY_ICON = '⚡';
const STATS_ID = 'player-stats-bar';

/** `<img class="ico-img">` of a rendered icon URL, '' when it is not ready (the caller keeps its emoji) */
const iconImg = (url) => (url ? `<img class="ico-img" src="${esc(url)}" alt="">` : '');

export class QueueFrame {
  /**
   * @param {object} deps  world; queue (ProductionQueue view); parent (element, default #hud-root);
   *   spawnPoint(producer) → {x, z}|null; focusAt(x, z) centres the camera; onChange() after a cancel
   */
  constructor({ world, queue, parent = null, spawnPoint = null, focusAt = null, onChange = null }) {
    Object.assign(this, { world, queue, spawnPoint, focusAt, onChange });
    this.sig = [];               // structure signature of the rendered markup (recycled with sigNext)
    this.sigNext = [];
    this.cellEls = [];           // cached item elements + their sources / last written values (progress in place)
    this.cellSrcs = [];
    this.cellPct = [];
    this.cellLeft = [];
    this.cellHead = [];
    this.statsHeight = -1;
    this.builds = [];            // recycled: structures of the builders' orders
    this.buildSet = new Set();   // recycled
    this.el = document.createElement('div');
    this.el.id = 'queue-frame';
    this.el.hidden = true;
    this.body = document.createElement('div'); // the scroller (data-scroll-key: the position survives a rewrite)
    this.body.className = 'qf-body';
    this.body.dataset.scrollKey = 'queue-frame';
    this.el.appendChild(this.body);
    (parent ?? document.getElementById('hud-root') ?? document.body).appendChild(this.el);
    this.onPointer = (e) => this.#pointer(e);
    this.onContext = (e) => e.preventDefault();
    this.el.addEventListener('pointerdown', this.onPointer); // pointerdown: the markup is rewritten several times a second
    this.el.addEventListener('contextmenu', this.onContext);
  }

  /** Structures the local builders are building / have queued, each once (current ones first) */
  #collectBuilds() {
    const list = this.builds;
    const seen = this.buildSet;
    list.length = 0;
    seen.clear();
    const team = localTeam();
    const add = (s) => {
      if (!s || s.complete || s.destroyed || s.removed || seen.has(s)) return;
      seen.add(s);
      list.push(s);
    };
    for (const v of this.world.vehicles) {
      if (v.team !== team || v.dead || !v.canConstruct) continue;
      if (v.order?.type === 'build') add(v.order.structure);
    }
    const current = list.length;
    for (const v of this.world.vehicles) {
      if (v.team !== team || v.dead || !v.canConstruct || !v.orderQueue?.length) continue;
      for (const e of v.orderQueue) if (e.type === 'build') add(e.ref?.structure);
    }
    return current;
  }

  #buildsGroup() {
    const current = this.#collectBuilds();
    const list = this.builds;
    if (!list.length) return '';
    const shown = Math.min(list.length, Q.maxBuildsShown);
    let cells = '';
    for (let i = 0; i < shown; i++) {
      const s = list[i];
      const name = unitName('structures', s.unitId);
      const pct = Math.floor((s.progress ?? 0) * Q.percent);
      cells += `<div class="qf-item ${i < current ? 'active' : ''}" data-s="${s.eid}" title="${esc(name)} – ${pct} %">`
        + `<span class="ico">${buildingIconHtml(s.unitId, s.race, s.team) || esc(name.slice(0, ICON_LETTERS))}</span><span class="bar" style="width:${pct}%"></span></div>`;
    }
    const more = list.length > shown ? `<span class="qf-more">+${list.length - shown}</span>` : '';
    return `<div class="qf-group"><div class="qf-name">${esc(t('build.builders'))}</div><div class="qf-cells">${cells}${more}</div></div>`;
  }

  #productionGroups() {
    const items = this.queue.items; // producer by producer, the head of each queue first
    const eco = this.world.economy;
    let html = '';
    let producer = null;
    let cells = '';
    const flush = () => {
      if (producer === null) return;
      const s = this.world.entityById?.(producer);
      const name = s?.unitId ? unitName('structures', s.unitId) : t('hud.queue.title');
      html += `<div class="qf-group"><div class="qf-name">${esc(name)}</div><div class="qf-cells">${cells}</div></div>`;
    };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.producer !== producer) { flush(); producer = it.producer; cells = ''; }
      const head = cells === '';
      const waiting = head && isWaitingEnergy(it, eco);
      const pct = head ? Math.floor(progressOf(it) * Q.percent) : 0;
      const left = Math.max(0, it.total - it.elapsed).toFixed(Q.progressDecimals);
      const tip = [it.label, `${left} s`, waiting ? t('econ.waitingEnergy') : '', t('hud.queue.hint')].filter(Boolean).join(' – ');
      cells += `<div class="qf-item ${head ? 'active' : ''} ${waiting ? 'energy' : ''}" data-q="${it.id}" title="${esc(tip)}">`
        + `<span class="ico">${iconImg(it.iconUrl) || esc(it.icon)}</span>${waiting ? `<span class="wait">${ENERGY_ICON}</span>` : ''}`
        + `<span class="bar" style="width:${pct}%"></span></div>`;
    }
    flush();
    return html;
  }

  /** Structure signature (items, order, highlight, energy wait, group counts) into this.sigNext; numbers only */
  #computeSignature() {
    const sig = this.sigNext;
    sig.length = 0;
    const current = this.#collectBuilds();
    const list = this.builds;
    const shown = Math.min(list.length, Q.maxBuildsShown);
    sig.push(shown, list.length, current, iconVersion());
    for (let i = 0; i < shown; i++) sig.push(list[i].eid);
    const items = this.queue.items;
    const eco = this.world.economy;
    let producer = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const head = it.producer !== producer;
      if (head) producer = it.producer;
      sig.push(it.producer, it.id, head && isWaitingEnergy(it, eco) ? 1 : 0);
    }
  }

  #sameSignature() {
    const a = this.sig;
    const b = this.sigNext;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Cache the item elements (in render order: constructions first, then production) for in-place progress updates */
  #cacheItems() {
    this.cellEls.length = 0;
    this.cellSrcs.length = 0;
    this.cellPct.length = 0;
    this.cellLeft.length = 0;
    const cells = this.body.querySelectorAll('.qf-item');
    const list = this.builds;
    const shown = Math.min(list.length, Q.maxBuildsShown);
    const items = this.queue.items;
    let k = 0;
    for (let i = 0; i < shown && k < cells.length; i++, k++) this.#addCell(cells[k], list[i], false);
    let producer = null;
    for (let i = 0; i < items.length && k < cells.length; i++, k++) {
      const head = items[i].producer !== producer;
      if (head) producer = items[i].producer;
      this.#addCell(cells[k], items[i], head);
    }
  }

  #addCell(el, src, head) {
    this.cellEls.push(el);
    this.cellSrcs.push(src);
    this.cellPct.push(-1);
    this.cellLeft.push(-1);
    this.cellHead.push(head);
  }

  /** Progress only: writes the bar width / tooltip of changed items directly, no markup */
  #updateProgress() {
    const els = this.cellEls;
    const nBuilds = Math.min(this.builds.length, Q.maxBuildsShown);
    for (let i = 0; i < els.length; i++) {
      const src = this.cellSrcs[i];
      const isBuild = i < nBuilds;
      const head = isBuild || this.cellHead[i];
      const pct = isBuild ? Math.floor((src.progress ?? 0) * Q.percent) : (head ? Math.floor(progressOf(src) * Q.percent) : 0);
      const left = isBuild ? 0 : Math.max(0, src.total - src.elapsed).toFixed(Q.progressDecimals);
      if (pct === this.cellPct[i] && left === this.cellLeft[i]) continue;
      this.cellPct[i] = pct;
      this.cellLeft[i] = left;
      const el = els[i];
      const bar = el.lastElementChild;
      if (bar) bar.style.width = `${pct}%`;
      if (isBuild) el.title = `${unitName('structures', src.unitId)} – ${pct} %`;
      else el.title = this.#itemTip(src, el.classList.contains('energy'), left);
    }
  }

  #itemTip(it, waiting, left) {
    return [it.label, `${left} s`, waiting ? t('econ.waitingEnergy') : '', t('hud.queue.hint')].filter(Boolean).join(' – ');
  }

  /** Per refresh: rebuilds the frame only when its structure changed; progress is written in place */
  update() {
    this.#computeSignature();
    if (!this.#sameSignature()) {
      const tmp = this.sig;
      this.sig = this.sigNext;
      this.sigNext = tmp;
      this.cellHead.length = 0;
      const html = this.#buildsGroup() + this.#productionGroups();
      this.el.hidden = html === '';
      if (html) {
        setHtmlKeepScroll(this.body, `<h3>${esc(t('hud.queue.title'))}</h3>${html}`);
        this.#cacheItems();
      } else {
        this.cellEls.length = 0;
      }
    }
    if (this.el.hidden) return;
    this.#updateProgress();
    this.#placeAboveStats();
  }

  /** The frame sits right above the statistics bar, whose height depends on the number of teams */
  #placeAboveStats() {
    const stats = document.getElementById(STATS_ID);
    const h = stats && !stats.hidden ? stats.offsetHeight : 0;
    if (h === this.statsHeight) return;
    this.statsHeight = h;
    const scale = Number.parseFloat(document.documentElement.style.getPropertyValue('--hud-scale')) || 1; // set by Hud.js
    this.el.style.setProperty('--qf-bottom', String(Q.statsBottom + Q.gapAboveStats + (h > 0 ? h / scale : 0)));
  }

  #pointer(e) {
    const cell = e.target.closest?.('[data-q],[data-s]');
    if (!cell || e.button > 2) return;
    e.preventDefault();
    if (cell.dataset.q) {
      const id = Number(cell.dataset.q);
      const item = this.queue.items.find((i) => i.id === id);
      if (!item) return;
      if (e.button === 2) { this.queue.cancel(id); this.onChange?.(); return; } // as before: right click = cancel
      const p = this.spawnPoint?.(item.producer);
      if (p && e.button === 0) this.focusAt?.(p.x, p.z);
      return;
    }
    const s = this.world.entityById?.(Number(cell.dataset.s));
    if (s && e.button === 0) this.focusAt?.(s.position.x, s.position.z);
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this.onPointer);
    this.el.removeEventListener('contextmenu', this.onContext);
    this.el.remove();
    this.builds.length = 0;
    this.buildSet.clear();
    this.cellEls.length = 0;
    this.cellSrcs.length = 0;
    this.world = null;
    this.queue = null;
  }
}
