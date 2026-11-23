// Steel Mans – Settings screen (tabs: Controls, Audio, Graphics, Game). Edits go to a draft (SettingsDraft.js);
// the Save button writes them to the player profile (src/core/Profile.js) and applies them. Leaving with unsaved
// changes asks: Save / Discard / Back (ChoiceDialog.js). Works the same when opened from the game menu.
import { graphicsPresetOf, graphicsPresetOptions } from '../core/Profile.js';
import { AUTO_ASSIST, GAME_CLOCK, GRAPHICS, I18N, KEYBINDINGS, KEY_CATEGORIES, MOUSE, PROFILE, SELECTION, UI_SMALL } from '../config.js';
import { cleanAvatarImage } from '../core/PlayerLabels.js';
import { pickAvatarData, humanAvatarHtml } from './Avatar.js';
import { onLanguageChange, t } from '../i18n/i18n.js';
import { refreshVolumes } from '../audio/Sound.js';
import { KEY_SLOTS, keyLabel } from './SettingsKeybindings.js';
import { SettingsDraft, fullscreenAvailable, isFullscreen } from './SettingsDraft.js';
import { choiceDialog } from './ChoiceDialog.js';

const TABS = ['controls', 'audio', 'graphics', 'game'];
const MOUSE_TAB = 'mouse'; // last vertical tab of Controls (i18n settings.controls.mouse)
const PERCENT = 100;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export class SettingsScreen {
  /**
   * @param {HTMLElement} el  container (the screen section inside the menu)
   * @param {{onBack?: () => void}} opts
   */
  constructor(el, { onBack } = {}) {
    this.onBack = onBack;
    this.tab = TABS[0];
    this.keyCat = KEY_CATEGORIES[0].id; // open vertical tab of Controls
    this.listening = null;   // { action, slot } while waiting for a key
    this.message = '';
    this.avatarError = '';
    this.fullscreenRefused = false; // the browser / iframe refused requestFullscreen (hint shown in the Graphics tab)
    this.draft = new SettingsDraft();
    this.onCaptureKey = (e) => this.#onKey(e);
    window.addEventListener('keydown', this.onCaptureKey, true);
    // Esc / F11 / the browser UI leave fullscreen without us: the switch follows the real state
    this.onFullscreenChange = () => { this.draft.syncFullscreen(isFullscreen()); this.render(); };
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    // Optional hotkey (KEYBINDINGS.fullscreen, no default key): toggles at once, a key press is a user gesture
    this.onFullscreenKey = (e) => {
      if (this.listening || e.repeat || e.target?.closest?.('input, textarea, select') || !KEYBINDINGS.fullscreen?.includes(e.code)) return;
      e.preventDefault();
      const result = isFullscreen() ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
      Promise.resolve(result).catch(() => { this.fullscreenRefused = true; this.render(); });
    };
    window.addEventListener('keydown', this.onFullscreenKey);
    this.offLanguage = onLanguageChange(() => this.render());
    this.onElClick = (e) => this.#onClick(e);
    this.onElInput = (e) => this.#onInput(e);
    this.attach(el);
  }

  #detach() {
    if (!this.el) return;
    this.el.removeEventListener('click', this.onElClick);
    this.el.removeEventListener('input', this.onElInput);
    this.el.removeEventListener('change', this.onElInput);
  }

  /** Binds the screen to a (new) container, e.g. after the menu re-rendered itself; keeps the open tab */
  attach(el) {
    this.#detach();
    this.el = el;
    el.addEventListener('click', this.onElClick);
    el.addEventListener('input', this.onElInput);
    el.addEventListener('change', this.onElInput);
    this.render();
  }

  /** Called by the menu when the screen is opened */
  open() { this.listening = null; this.message = ''; this.avatarError = ''; this.fullscreenRefused = false; this.draft.discard(); this.render(); }

  /** Save button: applies the draft */
  save() {
    const wantFullscreen = this.draft.fullscreen;
    if (this.draft.commit()) refreshVolumes();
    // Fullscreen needs a user gesture, so it is applied here (Save click), never on page load
    if (wantFullscreen !== isFullscreen()) {
      const result = wantFullscreen ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.();
      this.fullscreenRefused = false;
      Promise.resolve(result).catch(() => { this.fullscreenRefused = wantFullscreen; this.onFullscreenChange(); }); // refused (e.g. iframe without allowfullscreen): snap the switch back, say why
      this.draft.syncFullscreen(wantFullscreen); // optimistic; fullscreenchange corrects it
    }
    this.render();
  }

  /** Removes the document listener */
  dispose() {
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('keydown', this.onFullscreenKey);
    window.removeEventListener('keydown', this.onCaptureKey, true);
    if (typeof this.offLanguage === 'function') this.offLanguage();
    this.#detach();
  }

  /** Back button / any way out of the screen: unsaved changes ask Save / Discard / Back first */
  async requestLeave() {
    this.listening = null;
    if (this.draft.dirty) {
      const choice = await choiceDialog({
        messageKey: 'settings.unsaved.message',
        choices: [
          { id: 'back', labelKey: 'common.back' },
          { id: 'discard', labelKey: 'settings.discard', danger: true },
          { id: 'save', labelKey: 'settings.save' },
        ],
        cancelId: 'back',
        defaultId: 'save',
      });
      if (choice === 'back') { this.render(); return; }
      if (choice === 'save') this.save();
      else this.draft.discard();
    }
    this.onBack?.();
  }

  /** Enables the Save button only while there is something to save */
  #syncSave() {
    const dirty = this.draft.dirty;
    const btn = this.el.querySelector('[data-action="save"]');
    if (btn) btn.disabled = !dirty;
    const note = this.el.querySelector('[data-role="dirty-note"]');
    if (note) note.hidden = !dirty;
  }

  render() {
    this.el.innerHTML = `
      <h2>${t('settings.title')}</h2>
      <div class="tabs">${TABS.map((id) =>
        `<button class="tab ${id === this.tab ? 'on' : ''}" data-tab="${id}">${t(`settings.tab.${id}`)}</button>`).join('')}</div>
      <div class="tab-panel">${this.#panel()}</div>
      <p class="menu-warn small" data-role="dirty-note" ${this.draft.dirty ? '' : 'hidden'}>${t('settings.unsaved.note')}</p>
      <div class="menu-actions">
        <button class="menu-btn" data-action="back">${t('common.back')}</button>
        <button class="menu-btn primary" data-action="save" ${this.draft.dirty ? '' : 'disabled'}>${t('settings.save')}</button>
      </div>`;
  }

  #panel() {
    return { controls: this.#controls, audio: this.#audio, graphics: this.#graphics, game: this.#game }[this.tab].call(this);
  }

  // ---------- panels ----------

  #slider(path, label, value, { min = 0, max = 1, step = 0.05, percent = false } = {}) {
    const shown = percent ? `${Math.round(value * PERCENT)} %` : value.toFixed(1);
    return `<label class="setting-row"><span>${label}</span>
      <input type="range" data-path="${path}" data-type="number" data-percent="${percent}" min="${min}" max="${max}" step="${step}" value="${value}">
      <output>${shown}</output></label>`;
  }

  #check(path, label, value) {
    return `<label class="setting-row check"><input type="checkbox" data-path="${path}" data-type="boolean" ${value ? 'checked' : ''}><span>${label}</span></label>`;
  }

  #controls() {
    const s = this.draft.settings;
    const range = MOUSE.sensitivityRange;
    const keyRows = (actions) => actions.map((action) => `
      <div class="key-row"><span>${t(`key.${action}`)}</span>
        ${Array.from({ length: KEY_SLOTS }, (_, slot) => {
          const listening = this.listening?.action === action && this.listening.slot === slot;
          const code = this.draft.keysOf(action)[slot];
          return `<button class="key-slot ${listening ? 'listening' : ''}" data-key-action="${action}" data-slot="${slot}" title="${t(`key.slot${slot + 1}`)}">
            ${listening ? t('settings.controls.pressKey') : (code ? esc(keyLabel(code)) : `<i>${t('settings.controls.unbound')}</i>`)}</button>`;
        }).join('')}
      </div>`).join('');
    // Vertical tabs: key categories from config KEY_CATEGORIES + the mouse sliders
    const ids = [...KEY_CATEGORIES.map((c) => c.id), MOUSE_TAB];
    if (!ids.includes(this.keyCat)) this.keyCat = ids[0];
    const nav = `<div class="vtabs" role="tablist">${ids.map((id) =>
      `<button class="vtab ${id === this.keyCat ? 'on' : ''}" role="tab" data-key-cat="${id}">${t(`settings.controls.${id}`)}</button>`).join('')}</div>`;
    const category = KEY_CATEGORIES.find((c) => c.id === this.keyCat);
    const body = category ? `
      <p class="menu-muted small">${t('settings.controls.hint')}</p>
      <p class="menu-warn" data-role="key-message" ${this.message ? '' : 'hidden'}>${esc(this.message)}</p>
      ${keyRows(category.actions)}
      <div class="menu-actions left"><button class="menu-btn" data-action="reset-keys">${t('settings.controls.resetKeys')}</button></div>` : `
      ${this.#slider('mouse.rotateSensitivity', t('settings.mouse.rotate'), s.mouse.rotateSensitivity, range)}
      ${this.#slider('mouse.zoomSensitivity', t('settings.mouse.zoom'), s.mouse.zoomSensitivity, range)}
      ${this.#slider('mouse.panSensitivity', t('settings.mouse.pan'), s.mouse.panSensitivity, range)}
      ${this.#check('mouse.invertRotate', t('settings.mouse.invertRotate'), s.mouse.invertRotate)}
      ${this.#check('mouse.invertPan', t('settings.mouse.invertPan'), s.mouse.invertPan)}
      ${this.#check('mouse.invertZoom', t('settings.mouse.invertZoom'), s.mouse.invertZoom)}
      <div class="menu-actions left"><button class="menu-btn" data-action="reset-mouse">${t('common.reset')}</button></div>`;
    return `<div class="vtabs-layout">${nav}<div class="vtab-body">${body}</div></div>`;
  }

  #audio() {
    const a = this.draft.settings.audio;
    const opts = { percent: true };
    return `
      ${this.#slider('audio.master', t('settings.audio.master'), a.master, opts)}
      ${this.#slider('audio.effects', t('settings.audio.effects'), a.effects, opts)}
      ${this.#slider('audio.music', t('settings.audio.music'), a.music, opts)}
      <p class="menu-muted small">${t('settings.audio.note')}</p>
      <div class="menu-actions left"><button class="menu-btn" data-action="reset-audio">${t('common.reset')}</button></div>`;
  }

  #graphics() {
    const current = this.draft.settings.graphics.quality;
    const adv = this.draft.settings.graphics.advanced;
    const fsOk = fullscreenAvailable();
    const advRows = Object.entries(GRAPHICS.advanced).map(([key, spec]) => {
      const label = t(`settings.graphics.adv.${key}`);
      if (spec.type === 'boolean') {
        return `<label class="setting-row check"><input type="checkbox" data-role="gfx-adv" data-key="${key}" ${adv[key] ? 'checked' : ''}><span>${label}</span></label>`;
      }
      const opts = spec.values.map((v) => {
        const text = spec.percent ? `${Math.round(v * PERCENT)} %` : t(`settings.graphics.adv.${key}.${v}`);
        return `<option value="${v}" ${v === adv[key] ? 'selected' : ''}>${esc(text)}</option>`;
      }).join('');
      return `<label class="setting-row"><span>${label}</span><select data-role="gfx-adv" data-key="${key}">${opts}</select></label>`;
    }).join('');
    return `
      <label class="setting-row check" title="${esc(t('settings.graphics.fullscreen.hint'))}">
        <input type="checkbox" data-role="fullscreen" ${this.draft.fullscreen ? 'checked' : ''} ${fsOk ? '' : 'disabled'}>
        <span>${t('settings.graphics.fullscreen')}</span></label>
      <p class="menu-muted small" ${fsOk ? 'hidden' : ''}>${t('settings.graphics.fullscreen.unavailable')}</p>
      <p class="menu-warn" role="alert" ${this.fullscreenRefused ? '' : 'hidden'}>${t('settings.graphics.fullscreen.refused')}</p>
      <div class="row-label">${t('settings.graphics.quality')}</div>
      <div class="factions">${GRAPHICS.qualities.map((q) => `
        <button class="faction ${q === current ? 'on' : ''}" data-quality="${q}">
          <b>${t(`settings.graphics.${q}`)}</b><small>${t(`settings.graphics.${q}.hint`)}</small>
        </button>`).join('')}</div>
      <p class="menu-muted small gfx-custom" ${current === GRAPHICS.customQuality ? '' : 'hidden'}>${t('settings.graphics.custom')}</p>
      <div class="row-label gfx-advanced-title">${t('settings.graphics.advanced')}</div>
      <div class="gfx-advanced">${advRows}</div>`;
  }

  #game() {
    const s = this.draft.settings;
    const lang = this.draft.language;
    const avatar = cleanAvatarImage(s.avatar);
    return `
      <label class="setting-row"><span>${t('settings.game.language')}</span>
        <select data-role="language">${I18N.languages.map((l) =>
          `<option value="${l}" ${l === lang ? 'selected' : ''}>${esc(I18N.names[l])}</option>`).join('')}</select></label>
      <label class="setting-row"><span>${t('settings.game.nickname')}</span>
        <input type="text" data-path="nickname" data-type="string" maxlength="${PROFILE.nicknameMaxLength}"
          placeholder="${t('settings.game.nicknamePlaceholder')}" value="${esc(s.nickname)}"></label>
      <div class="setting-row settings-avatar"><span>${t('settings.game.avatar')}</span>
        <span class="settings-avatar-box">${humanAvatarHtml({ image: avatar, color: UI_SMALL.humanAvatar.previewColor, size: UI_SMALL.humanAvatar.size })}
          <label class="menu-btn avatar-pick">${t('settings.game.avatarUpload')}
            <input type="file" accept="image/*" data-role="avatar-file" hidden></label>
          ${avatar ? `<button class="menu-btn" data-action="avatar-remove">${t('settings.game.avatarRemove')}</button>` : ''}</span></div>
      <p class="menu-warn small" data-role="avatar-message" ${this.avatarError ? '' : 'hidden'}>${esc(this.avatarError ?? '')}</p>
      ${this.#check('ui.alwaysShowHealthBars', t('settings.game.healthBars'), s.ui.alwaysShowHealthBars)}
      ${this.#check('ui.alwaysShowBuildProgress', t('settings.game.buildProgress'), s.ui.alwaysShowBuildProgress)}
      ${this.#check('ui.edgeScroll', t('settings.game.edgeScroll'), s.ui.edgeScroll)}
      ${this.#check('ui.autoAssist', t('settings.game.autoAssist'), s.ui.autoAssist ?? AUTO_ASSIST.defaultOn)}
      ${this.#check('ui.showClock', t('settings.game.showClock'), s.ui.showClock ?? GAME_CLOCK.defaultVisible)}
      ${this.#check('ui.preferCombatOnDrag', t('settings.game.preferCombatOnDrag'), s.ui.preferCombatOnDrag ?? SELECTION.preferCombatDefault)}
      <p class="menu-muted small">${t('settings.game.profileNote')}</p>`;
  }

  // ---------- events ----------

  #onClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const d = btn.dataset;
    if (d.tab) { this.tab = d.tab; this.listening = null; this.message = ''; this.render(); }
    else if (d.keyCat) { this.keyCat = d.keyCat; this.listening = null; this.message = ''; this.render(); }
    else if (d.action === 'back') this.requestLeave();
    else if (d.action === 'save') this.save();
    else if (d.keyAction !== undefined) {
      this.listening = { action: d.keyAction, slot: Number(d.slot) };
      this.message = '';
      this.render();
    } else if (d.action === 'reset-keys') { this.draft.resetKeys(); this.message = ''; this.render(); }
    else if (d.action === 'avatar-remove') { this.draft.set('avatar', ''); this.avatarError = ''; this.render(); }
    else if (d.action === 'reset-mouse') { this.draft.resetGroup('mouse'); this.render(); }
    else if (d.action === 'reset-audio') { this.draft.resetGroup('audio'); this.render(); }
    else if (d.quality) { this.#setPreset(d.quality); this.render(); }
  }

  /** A preset button overwrites every advanced option */
  #setPreset(id) {
    this.draft.set('graphics.advanced', graphicsPresetOptions(id));
    this.draft.set('graphics.quality', id);
  }

  /** One advanced option changed by hand: the preset follows (Full / Reduced when it matches one, else Custom) */
  #setAdvanced(input) {
    const key = input.dataset.key;
    const spec = GRAPHICS.advanced[key];
    const value = spec.type === 'boolean' ? input.checked : spec.values.find((v) => String(v) === input.value);
    if (value === undefined) return;
    this.draft.set(`graphics.advanced.${key}`, value);
    this.draft.set('graphics.quality', graphicsPresetOf(this.draft.settings.graphics.advanced));
  }

  #onInput(e) {
    const target = e.target;
    if (target.dataset.role === 'language') { this.draft.set('language', target.value); this.#syncSave(); return; }
    if (target.dataset.role === 'gfx-adv') { this.#setAdvanced(target); this.render(); return; }
    if (target.dataset.role === 'fullscreen') { this.draft.fullscreen = target.checked; this.#syncSave(); return; }
    if (target.dataset.role === 'avatar-file') { if (e.type === 'change') this.#uploadAvatar(target); return; } // a file input fires input + change
    const { path, type } = target.dataset;
    if (!path) return;
    const value = type === 'boolean' ? target.checked : type === 'number' ? Number(target.value) : target.value.trim();
    this.draft.set(path, value);
    if (type === 'number') {
      target.nextElementSibling.textContent = target.dataset.percent === 'true' ? `${Math.round(value * PERCENT)} %` : value.toFixed(1);
    }
    this.#syncSave();
  }

  /** [UISMALL] Picture file → small square data URL in the profile; a refused file shows a message */
  async #uploadAvatar(input) {
    const file = input.files?.[0];
    if (!file) return;
    const data = await pickAvatarData(file);
    if (data === undefined) { input.value = ''; return; } // [R7] crop dialog cancelled – keep the avatar, allow re-picking the same file
    const clean = data ? cleanAvatarImage(data) : '';
    if (clean) this.draft.set('avatar', clean);
    this.avatarError = clean ? '' : t('settings.game.avatarError');
    this.render();
  }

  // Captures the next key while a slot is waiting (capture phase: the game never sees it)
  #onKey(e) {
    if (!this.listening || this.el.closest('[hidden]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const { action, slot } = this.listening;
    if (e.code === 'Escape') { this.listening = null; this.render(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') { this.draft.setKey(action, slot, null); this.listening = null; this.render(); return; }
    const problem = this.draft.validateKey(action, slot, e.code);
    if (problem) {
      this.message = this.#problemText(problem, e.code);
    } else {
      this.draft.setKey(action, slot, e.code);
      this.message = '';
    }
    this.listening = null;
    this.render();
  }

  #problemText({ reason, other }, code) {
    const key = keyLabel(code) || code;
    if (reason === 'conflict') return t('settings.controls.conflict', { key, action: t(`key.${other}`) });
    return t(`settings.controls.${reason === 'group' ? 'groupKey' : reason}`, { key });
  }
}
