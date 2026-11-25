// Steel Men – [A5] one-time, non-modal "turn on full screen" bar. Shown once when the window is smaller than
// UI_SCALE.fullscreenOffer and not in fullscreen; either button marks the offer as shown (ui.fullscreenOffered) for good.
// Checks again on window resize until it has been shown once. Not part of the simulation.
import { UI_SCALE } from '../config.js';
import { getSettings, updateSettings } from '../core/Profile.js';
import { onLanguageChange, t } from '../i18n/i18n.js';

export class FullscreenOffer {
  /** @param {{parent?: HTMLElement}} opts  where the bar is added (default document.body) */
  constructor({ parent = document.body, canShow = () => true } = {}) {
    this.parent = parent;
    this.canShow = canShow; // e.g. only while the menu is open, never over a running game
    this.bar = null;
    this.done = false; // shown once in this page life (or already answered in the profile)
    this.onResize = () => this.check();
    window.addEventListener('resize', this.onResize);
    this.offLanguage = onLanguageChange(() => this.#fillTexts());
  }

  /** Shows the bar when the offer is due; safe to call any time (menu opened, game started, resize) */
  check() {
    if (this.done || this.bar) return;
    if (getSettings().ui?.fullscreenOffered) { this.done = true; window.removeEventListener('resize', this.onResize); return; }
    if (document.fullscreenElement || !document.fullscreenEnabled || !this.canShow()) return;
    const { width, height } = UI_SCALE.fullscreenOffer;
    if (window.innerWidth >= width && window.innerHeight >= height) return;
    this.#show();
  }

  #show() {
    this.done = true;
    window.removeEventListener('resize', this.onResize); // decided: no more resize checks
    const bar = document.createElement('div');
    bar.className = 'fullscreen-offer';
    bar.setAttribute('role', 'dialog');
    bar.innerHTML = '<span class="fullscreen-offer-text"></span>'
      + '<button type="button" class="menu-btn primary" data-act="yes"></button>'
      + '<button type="button" class="menu-btn" data-act="no"></button>';
    this.onClick = (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      updateSettings({ ui: { fullscreenOffered: true } });
      this.#hide();
      if (act === 'yes') document.documentElement.requestFullscreen?.()?.catch?.(() => {}); // click = user gesture
    };
    bar.addEventListener('click', this.onClick);
    this.bar = bar;
    this.#fillTexts();
    this.parent.appendChild(bar);
  }

  #fillTexts() {
    if (!this.bar) return;
    this.bar.querySelector('.fullscreen-offer-text').textContent = t('ui.fullscreenOffer.text');
    this.bar.querySelector('[data-act="yes"]').textContent = t('ui.fullscreenOffer.yes');
    this.bar.querySelector('[data-act="no"]').textContent = t('ui.fullscreenOffer.no');
  }

  #hide() {
    if (!this.bar) return;
    this.bar.removeEventListener('click', this.onClick);
    this.bar.remove();
    this.bar = null;
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    if (typeof this.offLanguage === 'function') this.offLanguage();
    this.#hide();
  }
}
