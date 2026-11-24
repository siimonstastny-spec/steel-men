// Steel Mans – universal grid of buttons. The same component serves the option grid on the left (buildings,
// production inside a building, robot parts) and the command grid in the bottom left (RTS orders).
//   grid.show({ title, back, tabs, items, summary, action })
//     items:   [{ icon, label, tip, hotkey, disabled, on, pending, onClick, onContext } | null (empty slot)]
//              onClick receives { shift } (modifier keys of the click)
//     tabs:    [{ label, on, onClick }]               optional row above the cells
//     back:    () => {}                               optional "back" button in the title
//     summary: [{ label, value, warn }]               optional rows under the cells
//     action:  { label, tip, disabled, onClick }      optional wide button at the bottom
// The DOM is rebuilt only when the visible content changes, so buttons keep hover / focus between refreshes.
import { t } from '../i18n/i18n.js';
import { setHtmlKeepScroll } from './scrollKeep.js';

const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

export class OptionGrid {
  /**
   * @param {HTMLElement} el
   * @param {object} opts  { columns, minRows } – minRows fills the grid with empty slots
   */
  constructor(el, { columns, minRows = 0 }) {
    this.el = el;
    this.columns = columns;
    this.minRows = minRows;
    this.view = null;
    this.signature = '';
    el.style.setProperty('--hud-cols', columns);
    // pointerdown: the panel may be refreshed between press and release, a click would get lost
    el.addEventListener('pointerdown', (e) => this.#onPointer(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  show(view) {
    this.view = view;
    const html = this.#html(view);
    if (html === this.signature) return;
    this.signature = html;
    setHtmlKeepScroll(this.el, html);
    this.#fit();
  }

  // Content taller than the window: one extra grid column (CSS class "wide" widens the panel); when even that does
  // not help the panel keeps its (themed) scrollbar. Measured only when the content changes.
  #fit() {
    const el = this.el;
    el.classList.remove('wide');
    el.style.setProperty('--hud-cols', this.columns);
    if (el.scrollHeight <= el.clientHeight + 1) return;
    el.classList.add('wide');
    el.style.setProperty('--hud-cols', this.columns + 1);
  }

  #html({ title = '', back, tabs = [], items = [], summary = [], action } = {}) {
    const slots = Math.max(items.length, this.minRows * this.columns);
    const cells = [];
    for (let i = 0; i < slots; i++) {
      const it = items[i];
      if (!it) { cells.push('<button class="hud-cell empty" tabindex="-1"></button>'); continue; }
      const cls = ['hud-cell', it.on ? 'on' : '', it.pending ? 'pending' : ''].join(' ');
      cells.push(`<button class="${cls}" data-i="${i}" title="${esc(it.tip)}" ${it.disabled ? 'disabled' : ''}>`
        + `<span class="ico">${it.iconUrl ? `<img class="ico-img" src="${esc(it.iconUrl)}" alt="">` : esc(it.icon)}</span><span class="lbl">${esc(it.label)}</span>`
        + (it.hotkey ? `<kbd>${esc(it.hotkey)}</kbd>` : '') + '</button>');
    }
    const head = title || back
      ? `<h3>${esc(title)}${back ? `<button class="hud-back" data-back="1">${esc(t('grid.back'))}</button>` : ''}</h3>` : '';
    const tabRow = tabs.length
      ? `<div class="hud-tabs">${tabs.map((tb, i) => `<button class="${tb.on ? 'on' : ''}" data-tab="${i}">${esc(tb.label)}</button>`).join('')}</div>` : '';
    const sum = summary.length
      ? `<div class="hud-summary">${summary.map((r) => `<div class="${r.warn ? 'warn' : ''}"><span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join('')}</div>` : '';
    const act = action
      ? `<button class="hud-action" data-action="1" title="${esc(action.tip)}" ${action.disabled ? 'disabled' : ''}>${esc(action.label)}</button>` : '';
    return `${head}${tabRow}<div class="hud-grid" data-scroll-key="grid">${cells.join('')}</div>${sum}${act}`;
  }

  #onPointer(e) {
    const v = this.view;
    if (!v || e.button > 2) return;
    const target = e.target.closest('button');
    if (!target || target.disabled) return;
    e.preventDefault(); // keeps the keyboard focus on the game (no focus ring, Space does not re-press)
    if (target.dataset.back) { if (e.button === 0) v.back?.(); return; }
    if (target.dataset.action) { if (e.button === 0) v.action?.onClick?.(); return; }
    if (target.dataset.tab !== undefined) { if (e.button === 0) v.tabs[Number(target.dataset.tab)]?.onClick?.(); return; }
    const item = v.items?.[Number(target.dataset.i)];
    if (!item) return;
    if (e.button === 2) item.onContext?.();
    else if (e.button === 0) item.onClick?.({ shift: e.shiftKey }); // modifiers; callers that ignore the argument are unaffected
  }
}
