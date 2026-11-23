// Steel Mans – loading screen shown from the Start press until the match is ready (docs/notes/w6-loading.md).
// Text only for now; the background picture is set by LOADING.backgroundImage (CSS variable --loading-bg).
//   const loading = new LoadingScreen();
//   loading.show();                       // sync: overlay is in the DOM; `loading.painted` = Promise after the first paint
//   loading.begin(5); loading.step('map'); // "step 2/5: map", bar = steps done / steps
//   loading.setStatus(text); loading.hide();
import * as THREE from 'three';
import { t } from '../i18n/i18n.js';
import { LOADING } from '../config.js';

export class LoadingScreen {
  /** @param {{parent?: HTMLElement}} [o] */
  constructor({ parent = document.body } = {}) {
    this.parent = parent;
    this.stepCount = 0;
    this.stepIndex = 0;
    this.fileBase = 0;          // files already counted by the three.js manager before show()
    this.painted = Promise.resolve();
    this.hideTimer = null;
    this.prevProgress = null;
    this.ourProgress = null;

    const el = document.createElement('div');
    el.className = 'loading-screen';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    if (LOADING.backgroundImage) el.style.setProperty('--loading-bg', `url("${LOADING.backgroundImage}")`);
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'loading-title';
    this.stepEl = document.createElement('div');
    this.stepEl.className = 'loading-step';
    const bar = document.createElement('div');
    bar.className = 'loading-bar';
    this.fillEl = document.createElement('div');
    this.fillEl.className = 'loading-fill';
    bar.appendChild(this.fillEl);
    this.filesEl = document.createElement('div');
    this.filesEl.className = 'loading-files';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'loading-status';
    const box = document.createElement('div');
    box.className = 'loading-box';
    box.append(this.titleEl, this.stepEl, bar, this.filesEl, this.statusEl);
    el.appendChild(box);
    parent.appendChild(el);
    this.el = el;
  }

  get visible() { return !this.el.hidden; }

  /** Shows the overlay at once (sync). `this.painted` resolves after it was drawn – await it before heavy work. */
  show() {
    clearTimeout(this.hideTimer);
    this.el.classList.remove('loading--hide');
    this.el.hidden = false;
    this.titleEl.textContent = t('loading.title');
    this.stepEl.textContent = '';
    this.statusEl.textContent = '';
    this.filesEl.textContent = '';
    this.stepCount = 0;
    this.stepIndex = 0;
    this.#setFill(null);
    this.#watchFiles();
    this.painted = new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, LOADING.paintTimeoutMs);
      requestAnimationFrame(() => requestAnimationFrame(done));
    });
    return this.painted;
  }

  /** Number of steps of this load (bar = finished steps / count); 0 = indeterminate bar */
  begin(count) {
    this.stepCount = Math.max(0, count | 0);
    this.stepIndex = 0;
    this.#setFill(this.stepCount ? 0 : null);
  }

  /** Next step: text t('loading.step.<key>') (+ "n/total"); the previous step counts as finished */
  step(key, params) {
    this.stepIndex++;
    const label = t(`loading.step.${key}`, params);
    this.stepEl.textContent = this.stepCount ? `${label} (${Math.min(this.stepIndex, this.stepCount)}/${this.stepCount})` : label;
    if (this.stepCount) this.#setFill((this.stepIndex - 1) / this.stepCount);
  }

  /** Free text under the bar (e.g. "Waiting for players 1/2"); '' clears it */
  setStatus(text) { this.statusEl.textContent = text ?? ''; }

  /** Runs `work` (promise or function) as one step; resolves with its result */
  async track(key, work, params) {
    this.step(key, params);
    return typeof work === 'function' ? work() : work;
  }

  /** Fades out; no-op when not shown */
  hide() {
    if (this.el.hidden) return;
    this.#unwatchFiles();
    this.#setFill(1);
    this.el.classList.add('loading--hide');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => { this.el.hidden = true; this.el.classList.remove('loading--hide'); }, LOADING.fadeMs);
  }

  dispose() {
    clearTimeout(this.hideTimer);
    this.#unwatchFiles();
    this.el.remove();
  }

  #setFill(ratio) {
    this.fillEl.classList.toggle('indeterminate', ratio === null);
    this.fillEl.style.width = ratio === null ? '' : `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  }

  // File counter: the three.js default manager sees every GLTF / texture load that uses it (JSON via fetch is not counted)
  #watchFiles() {
    this.#unwatchFiles();
    const mgr = THREE.DefaultLoadingManager;
    this.fileBase = mgr.itemsLoaded ?? 0;
    this.prevProgress = mgr.onProgress;
    this.ourProgress = (url, loaded, total) => {
      this.prevProgress?.(url, loaded, total);
      this.filesEl.textContent = t('loading.files', { loaded: Math.max(0, loaded - this.fileBase), total: Math.max(0, total - this.fileBase) });
    };
    mgr.onProgress = this.ourProgress;
  }

  #unwatchFiles() {
    const mgr = THREE.DefaultLoadingManager;
    if (this.ourProgress && mgr.onProgress === this.ourProgress) mgr.onProgress = this.prevProgress;
    this.ourProgress = null;
    this.prevProgress = null;
  }
}
