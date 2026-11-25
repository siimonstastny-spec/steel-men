// Steel Men – saved games UI [J2]: list of saves (load / export .smsave / delete / import), the "save game" name
// dialog, the restore progress (LoadingScreen with a cancel button) and the one-time notice about saves from an
// older simulation version. Core: src/core/SaveStore.js (IndexedDB + files) and src/game/SaveGame.js (docs/notes/j2-save-ui.md).
//   const view = new SaveLoadView({ store, saveGame, loading, mapName, onRestored });
//   view.openList({ inGame });  // main menu: inGame false; in-game menu: inGame true (warns the running game is lost)
//   view.openSaveDialog();      // asks for a name, saves, shows "saved"
import { SAVE_UI, SAVE, SIM, LOBBY_CONTINUE } from '../config.js';
import { getLanguage, t } from '../i18n/i18n.js';
import { confirmDialog, isConfirmDialogOpen } from './ConfirmDialog.js';
import { setHtmlKeepScroll } from './scrollKeep.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const pad = (n) => String(n).padStart(2, '0');
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

let openModals = 0;
/** True while a save/load window or dialog is shown (game hotkeys ignore keys then) */
export const isSaveLoadOpen = () => openModals > 0;

export function formatLength(ticks) { // [A2-ui] also used by the continue-lobby info
  if (!Number.isFinite(ticks)) return '–';
  const s = Math.floor(ticks / SIM.tickRate);
  const h = Math.floor(s / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const m = Math.floor(s / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  return h > 0 ? `${h}:${pad(m)}:${pad(s % SECONDS_PER_MINUTE)}` : `${m}:${pad(s % SECONDS_PER_MINUTE)}`;
}

function formatDate(date) {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString(getLanguage());
}

function formatPlayers(players) {
  if (Array.isArray(players)) return players.map((p) => (typeof p === 'string' ? p : (p?.name ?? '?'))).join(', ');
  return players == null ? '–' : String(players);
}

// Ratio 0..1 from whatever the restore reports (ratio, percent, {done,total} / {tick,total})
function progressRatio(p) {
  if (typeof p === 'number') return p > 1 ? p / 100 : p;
  if (p && typeof p === 'object') {
    if (typeof p.ratio === 'number') return p.ratio;
    const done = p.done ?? p.tick;
    if (typeof done === 'number' && p.total > 0) return done / p.total;
  }
  return 0;
}

export class SaveLoadView {
  /**
   * @param {object} deps
   * @param {object} deps.store      SaveStore (list / put / get / remove / exportFile / importFile / isCompatible)
   * @param {object} deps.saveGame   SaveGame (buildSave(name), restore(save, {onProgress, signal}))
   * @param {object} deps.loading    LoadingScreen (progress + cancel)
   * @param {() => string} [deps.mapName]  name of the running map (default save name)
   * @param {(result: any) => (void|Promise<void>)} [deps.onRestored]  the battle is restored: main.js switches to the game
   */
  constructor({ store, saveGame, loading, mapName = () => '', onRestored = () => {} }) {
    this.store = store;
    this.saveGame = saveGame;
    this.loading = loading;
    this.mapName = mapName;
    this.onRestored = onRestored;
    this.items = [];
    this.inGame = false;
    this.pickMode = false;       // [A2-ui] 'pick' mode: the row button returns the save instead of restoring it
    this.pickFilter = null;      // [A2-ui] 'mp' = only multiplayer saves
    this.pickResolve = null;     // [A2-ui] resolver of the openList promise in pick mode
    this.busy = false;
    this.listOpen = false;
    this.toastTimer = null;
    this.modals = new Set();     // open dialogs: close functions (Esc closes the newest)
    this.el = document.createElement('div');
    this.el.className = 'saveload-overlay';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="saveload-card menu-card" role="dialog" aria-modal="true">
      <h2 data-role="title"></h2>
      <p class="menu-warn" data-role="warn" hidden></p>
      <div class="saveload-notice" data-role="notice" hidden></div>
      <div class="saveload-list" data-role="list" data-scroll-key="saveload-list"></div>
      <div class="menu-actions">
        <button type="button" class="menu-btn" data-act="close"></button>
        <button type="button" class="menu-btn" data-act="import"></button>
      </div>
      <input type="file" accept=".smsave" hidden data-role="file">
    </div>`;
    this.listEl = this.el.querySelector('[data-role="list"]');
    this.fileEl = this.el.querySelector('[data-role="file"]');
    this.el.addEventListener('click', (e) => this.#onClick(e));
    this.fileEl.addEventListener('change', () => this.#onFile());
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el && !this.busy) this.closeList(); });
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'saveload-toast';
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.hidden = true;
    this.keyHandler = (e) => this.#onKey(e);
    window.addEventListener('keydown', this.keyHandler, true);
    document.body.append(this.el, this.toastEl);
  }

  dispose() {
    clearTimeout(this.toastTimer);
    window.removeEventListener('keydown', this.keyHandler, true);
    for (const close of [...this.modals]) close();
    this.#settlePick(null);
    if (this.listOpen) { this.listOpen = false; openModals--; }
    this.el.remove();
    this.toastEl.remove();
  }

  // ---------- list ----------

  /**
   * Opens the list of saved games; inGame = opened from a running game (loading discards it, a warning is shown).
   * [A2-ui] mode 'pick' (+ filter 'mp' = multiplayer saves only): the row button picks a save; resolves with the
   * chosen save object, or null when the window is closed. In the normal mode it resolves when the list is drawn.
   */
  async openList({ inGame = false, mode = null, filter = null } = {}) {
    this.#settlePick(null); // a previous pick window that is still open is replaced
    this.pickMode = mode === LOBBY_CONTINUE.pickMode;
    this.pickFilter = this.pickMode ? filter : null;
    this.inGame = inGame && !this.pickMode;
    this.#setTexts();
    if (!this.listOpen) { this.listOpen = true; openModals++; }
    this.el.hidden = false;
    const picked = this.pickMode ? new Promise((resolve) => { this.pickResolve = resolve; }) : null;
    await this.#refresh();
    await this.#offerIncompatible();
    return picked;
  }

  closeList() {
    this.#settlePick(null);
    if (!this.listOpen) return;
    this.listOpen = false;
    openModals--;
    this.el.hidden = true;
  }

  #settlePick(save) {
    const resolve = this.pickResolve;
    this.pickResolve = null;
    this.pickMode = false;
    resolve?.(save);
  }

  /** Pick mode: hands the save to the caller and closes the window */
  #pick(save) {
    this.#settlePick(save);
    this.closeList();
  }

  #setTexts() {
    const q = (r) => this.el.querySelector(`[data-role="${r}"]`);
    q('title').textContent = t(this.pickMode ? 'save.pick.title' : 'save.list.title');
    const warn = q('warn');
    warn.textContent = this.inGame ? t('save.list.loseWarning') : '';
    warn.hidden = !this.inGame;
    this.el.querySelector('[data-act="close"]').textContent = t('common.back');
    this.el.querySelector('[data-act="import"]').textContent = t('save.import');
  }

  async #refresh() {
    try {
      this.items = (await this.store.list()) ?? [];
    } catch (err) {
      console.error(err);
      this.items = [];
      this.#renderList(t('save.error.storage'));
      return;
    }
    this.#renderList();
  }

  #isAuto(item) {
    return item.id === SAVE.autoSlot || item.meta?.slot === SAVE.autoSlot || item.meta?.auto === true;
  }

  #reasonText(reason) {
    if (!reason) return t('save.reason.unknown');
    const key = `save.reason.${reason}`;
    const text = t(key);
    return text === key ? t('save.reason.unknown') : text;
  }

  #renderList(errorText = '') {
    const pick = this.pickMode;
    // [A2-ui] pick mode with filter 'mp' lists multiplayer saves only; the normal list shows them tagged and not loadable (single player)
    const shown = pick && this.pickFilter === LOBBY_CONTINUE.pickFilter ? this.items.filter((i) => i.meta?.multiplayer === true) : this.items;
    const sorted = [...shown].sort((a, b) =>
      (this.#isAuto(b) ? 1 : 0) - (this.#isAuto(a) ? 1 : 0)
      || (new Date(b.meta?.date).getTime() || 0) - (new Date(a.meta?.date).getTime() || 0));
    const rows = sorted.map((item) => {
      const meta = item.meta ?? {};
      const mp = meta.multiplayer === true;
      let compat = this.store.isCompatible(meta) ?? { ok: false };
      if (compat.ok && mp && !pick) compat = { ok: false, reason: 'multiplayer' };
      const parts = [meta.mapName ?? meta.map ?? '–', formatPlayers(meta.players), formatLength(meta.durationTicks), formatDate(meta.date)];
      const ver = meta.gameVersion != null ? t('save.version', { v: meta.gameVersion }) : '';
      return `<div class="save-row${compat.ok ? '' : ' bad'}${this.#isAuto(item) ? ' auto' : ''}" data-id="${esc(item.id)}">
        <div class="save-main">
          <div class="save-title"><b class="save-name">${esc(meta.name ?? item.id)}</b>${this.#isAuto(item) ? `<span class="save-tag">${t('save.autosave')}</span>` : ''}${mp ? `<span class="save-tag">${t('save.multiplayer')}</span>` : ''}</div>
          <small class="save-info">${parts.map(esc).join(' · ')}${ver ? ` · <span title="${esc(meta.simVersion ?? '')}">${esc(ver)}</span>` : ''}</small>
          ${compat.ok ? '' : `<small class="save-reason">${esc(this.#reasonText(compat.reason))}</small>`}
        </div>
        <div class="save-actions">
          <button type="button" class="menu-btn primary" data-act="${pick ? 'pick' : 'load'}"${compat.ok ? '' : ' disabled'}>${t(pick ? 'save.pick' : 'save.load')}</button>
          <button type="button" class="menu-btn" data-act="export">${t('save.export')}</button>
          <button type="button" class="menu-btn danger" data-act="delete">${t('save.delete')}</button>
        </div>
      </div>`;
    });
    const empty = errorText || (rows.length ? '' : t(pick ? 'save.pick.empty' : 'save.list.empty'));
    setHtmlKeepScroll(this.listEl, empty ? `<p class="menu-muted">${esc(empty)}</p>${rows.join('')}` : rows.join(''));
  }

  // ---------- incompatible saves (once) ----------

  #seenIds() {
    try { return new Set(JSON.parse(localStorage.getItem(SAVE_UI.notifyStorageKey) ?? '[]')); } catch { return new Set(); }
  }

  #markSeen(ids) {
    try {
      const all = this.#seenIds();
      for (const id of ids) all.add(id);
      localStorage.setItem(SAVE_UI.notifyStorageKey, JSON.stringify([...all]));
    } catch { /* storage unavailable: the notice may come again */ }
  }

  #incompatible() {
    // [A2-ui] pick mode with filter 'mp' lists multiplayer saves only: notices about the hidden ones would confuse
    const mpOnly = this.pickMode && this.pickFilter === LOBBY_CONTINUE.pickFilter;
    return this.items.filter((i) => (!mpOnly || i.meta?.multiplayer === true) && !(this.store.isCompatible(i.meta ?? {})?.ok));
  }

  async #offerIncompatible() {
    const seen = this.#seenIds();
    const fresh = this.#incompatible().filter((i) => !seen.has(i.id));
    const box = this.el.querySelector('[data-role="notice"]');
    if (!fresh.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = `<p>${esc(t('save.old.message', { n: fresh.length }))}</p>
      <div class="saveload-notice-actions">
        <button type="button" class="menu-btn" data-act="old-export">${t('save.old.export')}</button>
        <button type="button" class="menu-btn danger" data-act="old-delete">${t('save.old.delete')}</button>
        <button type="button" class="menu-btn" data-act="old-keep">${t('save.old.keep')}</button>
      </div>`;
    box.hidden = false;
    this.noticeIds = fresh.map((i) => i.id);
  }

  async #noticeAction(act) {
    const ids = this.noticeIds ?? [];
    if (act === 'old-export') {
      for (const id of ids) await this.#export(id);
      return; // the notice stays: the user still chooses delete / keep
    }
    if (act === 'old-delete') {
      if (!await confirmDialog({ messageKey: 'save.old.deleteConfirm', params: { n: ids.length }, confirmKey: 'save.delete' })) return;
      for (const id of ids) await this.#safe(() => this.store.remove(id));
    } else {
      this.#markSeen(ids);
    }
    this.noticeIds = [];
    const box = this.el.querySelector('[data-role="notice"]');
    box.hidden = true;
    box.innerHTML = '';
    await this.#refresh();
  }

  // ---------- actions ----------

  async #onClick(e) {
    const btn = e.target.closest('button');
    const act = btn?.dataset.act;
    if (!act || btn.disabled || this.busy) return;
    if (act === 'close') { this.closeList(); return; }
    if (act === 'import') { this.fileEl.click(); return; }
    if (act.startsWith('old-')) { await this.#noticeAction(act); return; }
    const id = btn.closest('.save-row')?.dataset.id;
    if (id == null) return;
    if (act === 'load') await this.#loadFromList(id);
    else if (act === 'pick') await this.#pickFromList(id);
    else if (act === 'export') await this.#export(id);
    else if (act === 'delete') await this.#delete(id);
  }

  async #safe(fn) {
    try { return await fn(); } catch (err) { console.error(err); await this.#notice(t('save.error.generic', { reason: err?.message ?? String(err) })); return undefined; }
  }

  async #delete(id) {
    const item = this.items.find((i) => i.id === id);
    if (!await confirmDialog({ messageKey: 'save.deleteConfirm', params: { name: item?.meta?.name ?? id }, confirmKey: 'save.delete' })) return;
    await this.#safe(() => this.store.remove(id));
    await this.#refresh();
  }

  async #export(id) {
    await this.#safe(async () => this.store.exportFile(await this.store.get(id)));
  }

  async #onFile() {
    const file = this.fileEl.files?.[0];
    this.fileEl.value = '';
    if (!file) return;
    let save;
    try {
      save = await this.store.importFile(file);
    } catch (err) {
      console.error(err);
      await this.#notice(t('save.error.import'));
      return;
    }
    // Without IndexedDB nothing can be stored: the imported file is loaded straight away
    if (!await this.store.isAvailable?.()) {
      if (this.pickMode) { if (save?.meta?.multiplayer === true) this.#pick(save); else await this.#notice(t('save.error.import')); return; } // [A2-ui]
      await this.#loadFromList(null, save);
      return;
    }
    try { await this.store.put(save); } catch (err) {
      console.error(err);
      await this.#notice(t('save.error.import'));
    }
    await this.#refresh();
  }

  // ---------- load + progress ----------

  // [A2-ui] pick mode: the stored save object goes to the caller (the lobby creates the continue game from it)
  async #pickFromList(id) {
    let save = null;
    try { save = await this.store.get(id); } catch (err) { console.error(err); }
    if (!save) { await this.#notice(t('save.reason.corrupt')); await this.#refresh(); return; }
    this.#pick(save);
  }

  // `id` of a stored save, or null with `direct` = a save object (import without storage)
  async #loadFromList(id, direct = null) {
    if (this.inGame && !await confirmDialog({ messageKey: 'save.loadConfirmLose', confirmKey: 'save.load' })) return;
    let save = direct;
    if (!save) { try { save = await this.store.get(id); } catch (err) { console.error(err); } }
    if (!save) { await this.#notice(t('save.reason.corrupt')); await this.#refresh(); return; }
    this.busy = true;
    this.el.hidden = true; // the list reappears when the load fails or is cancelled
    const abort = new AbortController();
    const loading = this.loading;
    loading.show();
    loading.setTitle(t('save.restoring.title'));
    loading.setRestore({ ratio: 0, onCancel: () => abort.abort() });
    await loading.painted;
    try {
      const result = await this.saveGame.restore(save, {
        signal: abort.signal,
        onProgress: (p) => loading.setRestore({ ratio: progressRatio(p) }),
      });
      // A late Cancel (restore already finished) does not discard the result: carry on
      this.closeList();
      await this.onRestored(result);
    } catch (err) {
      loading.hide();
      this.busy = false;
      loading.setRestore(null);
      if (!err?.cancelled) {
        console.error(err);
        let text;
        if (err?.code === 'hash') text = t('save.error.hash');
        else if (err?.code === 'incompatible') text = this.#reasonText(err.details?.reason);
        else text = t('save.error.generic', { reason: err?.message ?? String(err) });
        await this.#notice(text);
      }
      if (this.listOpen) this.el.hidden = false;
      return;
    }
    loading.hide();
    loading.setRestore(null);
    this.busy = false;
  }

  // ---------- save dialog ----------

  defaultName() {
    const map = this.mapName();
    return `${map ? `${map} – ` : ''}${formatDate(Date.now())}`.slice(0, SAVE_UI.nameMaxLength);
  }

  /** Asks for the name (default "map – date time"), saves, shows "saved". Resolves true when saved. */
  async openSaveDialog() {
    const name = await this.#prompt();
    if (name == null) return false;
    try {
      const save = await this.saveGame.buildSave(name);
      await this.store.put(save);
    } catch (err) {
      console.error(err);
      await this.#notice(t('save.error.generic', { reason: err?.message ?? String(err) }));
      return false;
    }
    this.#toast(t('save.saved'));
    return true;
  }

  #toast(text) {
    clearTimeout(this.toastTimer);
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, SAVE_UI.savedToastMs);
  }

  // Modal dialog on the confirm-dialog look; `build` fills it and returns a getter, resolves with that value or null
  #modal({ text, input = null, confirmKey, cancelKey = 'dialog.cancel' }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'confirm-backdrop saveload-modal';
      backdrop.innerHTML = `<div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <p></p>${input != null ? '<input type="text" class="saveload-name-input">' : ''}
        <div class="confirm-buttons">${cancelKey ? '<button type="button" data-role="cancel"></button>' : ''}<button type="button" data-role="confirm"></button></div></div>`;
      backdrop.querySelector('p').textContent = text;
      const field = backdrop.querySelector('input');
      if (field) { field.value = input; field.maxLength = SAVE_UI.nameMaxLength; }
      const cancelBtn = backdrop.querySelector('[data-role="cancel"]');
      const confirmBtn = backdrop.querySelector('[data-role="confirm"]');
      if (cancelBtn) cancelBtn.textContent = t(cancelKey);
      confirmBtn.textContent = t(confirmKey);
      const close = (ok) => {
        backdrop.remove();
        this.modals.delete(close);
        openModals--;
        resolve(ok ? (field ? (field.value.trim() || input) : true) : null);
      };
      this.modals.add(close);
      openModals++;
      confirmBtn.addEventListener('click', () => close(true));
      cancelBtn?.addEventListener('click', () => close(false));
      close.cancelBtn = cancelBtn; // Enter on the focused cancel button cancels (see #onKey)
      document.body.appendChild(backdrop);
      if (field) { field.focus(); field.select(); } else confirmBtn.focus();
    });
  }

  #prompt() {
    return this.#modal({ text: t('save.dialog.name'), input: this.defaultName(), confirmKey: 'save.dialog.save' });
  }

  #notice(text) {
    return this.#modal({ text, confirmKey: 'save.ok', cancelKey: null });
  }

  #onKey(e) {
    if (openModals <= 0) return;
    if (isConfirmDialogOpen()) return; // the confirm dialog (opened from the list) handles its own keys
    const last = [...this.modals].pop();
    if (e.code === 'Escape') {
      if (last) last(false);
      else if (this.listOpen && !this.busy) this.closeList();
    } else if (last && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      last(document.activeElement !== last.cancelBtn);
      e.preventDefault();
    }
    // Keys never reach the game (or the menu under it) while a save/load window is open; typing in the field still works
    e.stopPropagation();
  }
}
