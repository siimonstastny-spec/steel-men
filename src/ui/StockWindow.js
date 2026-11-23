// Steel Mans – part stock window [F1] (docs/notes/f1-inventory.md): the finished robot parts of the local team
// (world.economy.parts) by slot, with set / faction / HP / count / sale value, and selling through the commandBus
// (command PART_SALE.commandType, src/game/commands/stockCommands.js). UI only: never mutates the simulation.
//
//   const win = new StockWindow()
//   win.setMatch(world)                 new match (null = closed and inactive)
//   win.open() / win.close() / win.toggle() / win.isOpen
//   win.onOpenChange = (open) => …      optional
//   win.dispose()
// Open: CommandInput → input.onStockWindow (KEYBINDINGS.stockWindow) or the button in the factory / assembly bay panel.
// Click a row to select it, "Sell" sells one piece, Shift+click on Sell sells every piece of the type. Esc closes.
// Styles: stock.css (loaded here).
import { KEYBINDINGS, PART_SALE } from '../config.js';
import { commandBus } from '../game/commands/CommandBus.js';
import { sellQuote, sellValue, canSellParts, sellFactor, slotOfPath } from '../game/commands/stockCommands.js'; // also registers the command
import { PART_SLOTS, catalogSlot, catalogEntry } from '../game/PartStock.js';
import { partStats, raceName } from '../data/Stats.js';
import { localTeam } from '../core/LocalPlayer.js';
import { isConfirmDialogOpen } from './ConfirmDialog.js';
import { setHtmlKeepScroll } from './scrollKeep.js';
import { onLanguageChange, t } from '../i18n/i18n.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

try {
  const href = new URL('./stock.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
} catch { /* no DOM (tests) */ }

export class StockWindow {
  constructor() {
    this.world = null;
    this.onOpenChange = null;
    this.timer = null;
    this.selected = null;   // stock key of the selected row
    this.signature = '';
    this.el = document.createElement('div');
    this.el.id = 'stock-window';
    this.el.className = 'stk-overlay';
    this.el.hidden = true;
    this.onClick = (e) => this.#click(e);
    this.onPointer = (e) => { if (e.target === this.el) this.close(); };
    this.el.addEventListener('click', this.onClick);
    this.el.addEventListener('pointerdown', this.onPointer);
    document.body.appendChild(this.el);
    this.onKey = (e) => {
      if (this.isOpen && !e.repeat && !isConfirmDialogOpen() && KEYBINDINGS.cancel.includes(e.code)) {
        this.close(); e.preventDefault(); e.stopPropagation();
      }
    };
    window.addEventListener('keydown', this.onKey, true);
    this.offLanguage = onLanguageChange(() => { if (this.isOpen) this.#render(true); });
  }

  get isOpen() { return !this.el.hidden; }

  setMatch(world) {
    this.close();
    this.world = world ?? null;
    this.selected = null;
  }

  open() {
    if (!this.world || this.isOpen) return;
    this.el.hidden = false;
    this.#render(true);
    this.timer = setInterval(() => this.#render(false), PART_SALE.refreshMs);
    this.onOpenChange?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.el.textContent = '';
    this.signature = '';
    clearInterval(this.timer);
    this.timer = null;
    this.onOpenChange?.(false);
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  dispose() {
    this.close();
    window.removeEventListener('keydown', this.onKey, true);
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('pointerdown', this.onPointer);
    this.offLanguage?.();
    this.el.remove();
    this.world = null;
  }

  // ---------- model ----------

  /** Rows of the local team's stock grouped by slot: [{ slot, rows: [{ key, set, race, hp, count, value }] }] */
  #groups(team) {
    const w = this.world;
    const stock = w.economy.parts;
    const catalog = w.production.catalog;
    const race = w.production.raceOf(team);
    return PART_SLOTS.map((slot) => {
      const rows = stock.paths(team)
        .filter((key) => slotOfPath(catalog, key) === catalogSlot(slot))
        .map((key) => {
          const entry = catalogEntry(catalog, catalogSlot(slot), key);
          const stats = partStats(key, catalogSlot(slot), race);
          return { key, set: entry?.set ?? '', race: stats.race, hp: stats.hp ?? '–', count: stock.count(team, key), value: sellValue(w, team, key) };
        })
        .sort((a, b) => a.set.localeCompare(b.set) || a.key.localeCompare(b.key));
      return { slot, rows };
    }).filter((g) => g.rows.length);
  }

  // ---------- rendering ----------

  #render(force) {
    const w = this.world;
    const team = localTeam();
    if (!w?.economy?.parts || !w.production) return;
    const groups = this.#groups(team);
    const can = canSellParts(w, team);
    const allKeys = groups.flatMap((g) => g.rows.map((r) => r.key));
    if (this.selected && !allKeys.includes(this.selected)) this.selected = null;
    const sig = JSON.stringify([groups, can, this.selected]);
    if (!force && sig === this.signature) return;
    this.signature = sig;

    const body = groups.length
      ? groups.map((g) => `<h3>${esc(t(`part.${g.slot}`))}</h3>${g.rows.map((r) => this.#rowHtml(r)).join('')}`).join('')
      : `<p class="stk-empty">${esc(t('stock.empty'))}</p>`;
    const sel = this.selected ? groups.flatMap((g) => g.rows).find((r) => r.key === this.selected) : null;
    const quote = sel ? sellQuote(w, { team, path: sel.key, count: 1 }) : null;
    const gain = sel?.value ? t('stock.gain', { ore: sel.value.ore, energy: sel.value.energy }) : '';
    const total = sel?.value ? t('stock.gainAll', { ore: sel.value.ore * sel.count, energy: sel.value.energy * sel.count }) : '';
    const pct = Math.round(sellFactor() * PART_SALE.percent);

    setHtmlKeepScroll(this.el, `<div class="stk-panel" role="dialog" aria-label="${esc(t('stock.title'))}">
      <h2>${esc(t('stock.title'))}</h2>
      <p class="stk-hint">${esc(t('stock.hint', { pct }))}</p>
      <div class="stk-list" data-scroll-key="stock-list">${body}</div>
      ${can ? '' : `<p class="stk-warn">${esc(t('stock.needBuilding'))}</p>`}
      <div class="stk-sell">
        <span class="stk-gain">${esc(gain)}${total && sel.count > 1 ? ` · ${esc(total)}` : ''}</span>
        <button data-act="sell" ${quote?.ok ? '' : 'disabled'} title="${esc(t('stock.sell.tip'))}">${esc(t('stock.sell'))}</button>
      </div>
      <div class="stk-actions"><button data-act="close">${esc(t('stock.close'))}</button></div>
    </div>`);
  }

  #rowHtml(r) {
    const faction = r.race ? ` <small>${esc(raceName(r.race))}</small>` : '';
    const value = r.value ? t('stock.gain', { ore: r.value.ore, energy: r.value.energy }) : '';
    return `<div class="stk-row${r.key === this.selected ? ' on' : ''}" data-key="${esc(r.key)}">
      <span class="stk-name">${esc(r.set)}${faction}</span>
      <span class="stk-hp">HP ${esc(r.hp)}</span>
      <span class="stk-value">${esc(value)}</span>
      <b class="stk-count">×${r.count}</b></div>`;
  }

  // ---------- input ----------

  #click(e) {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'close') { this.close(); return; }
    if (act === 'sell') { this.#sell(e.shiftKey); return; }
    const row = e.target.closest?.('.stk-row');
    if (row) { this.selected = row.dataset.key; this.#render(true); }
  }

  /** Sells one piece of the selected type, or all of them with Shift */
  #sell(all) {
    const team = localTeam();
    const key = this.selected;
    if (!key) return;
    const count = all ? this.world.economy.parts.count(team, key) : 1;
    const cmd = { type: PART_SALE.commandType, team, path: key, count };
    if (sellQuote(this.world, cmd).ok) commandBus.submit(cmd);
  }
}
