// Steel Mans – bottom centre panel (HUD v2), a dispatcher:
//   nothing selected (and no wreck) → hidden;  exactly one mech → RobotPanel;
//   everything else (group, single non-mech unit, building, wreck) → CenterPanel.
// The element is hidden through its `hidden` attribute and the class `sp-empty`; the owner of the layout container
// (.hud-bottom-center) should treat an empty / hidden child as "nothing to show". Styles: src/ui/selection-panel.css.
import { t } from '../i18n/i18n.js';
import { RobotPanel } from './RobotPanel.js';
import { CenterPanel } from './CenterPanel.js';
export { mechState } from './hudUtil.js'; // kept for old importers

export class SelectionPanel {
  /**
   * @param {HTMLElement} el
   * @param {object} deps  { input, world }
   */
  constructor(el, { input, world }) {
    this.el = el;
    this.input = input;
    this.world = world;
    this.robot = new RobotPanel({ input });
    this.center = new CenterPanel({ input, world });
    this.html = null;           // null = nothing rendered yet (first render always writes)
    this.active = null;         // panel that produced the current markup
    this.el.classList.add('sp-root');
    this.onPointer = (e) => this.#onPointer(e);
    el.addEventListener('pointerdown', this.onPointer);
    this.onWheel = (e) => this.#onWheel(e);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    this.render();
  }

  render() {
    const sel = this.input.selection;
    let panel = null;
    let html = '';
    if (sel.length === 1 && sel[0].isMech) { panel = this.robot; html = this.robot.html(sel[0]); }
    else {
      html = this.center.html(sel, this.input.selectedWreck);
      if (html) panel = this.center;
    }
    this.active = panel;
    if (html === this.html) return;
    this.html = html;
    this.el.innerHTML = html;
    this.el.hidden = !html;
    this.el.classList.toggle('sp-empty', !html);
    this.el.classList.toggle('sp-robot', panel === this.robot);
    this.el.classList.toggle('sp-center', panel === this.center);
    // Screen-reader name of the region (the panels carry their own titles)
    this.el.setAttribute('aria-label', html ? t('sel.region') : '');
  }

  #onPointer(e) {
    if (e.button !== 0) return;
    this.active?.onPointer(e);
  }

  /** Vertical wheel over an overflowing centre panel scrolls it sideways (and does not move the camera) */
  #onWheel(e) {
    const inner = e.target.closest?.('.cp-inner');
    if (!inner || inner.scrollWidth <= inner.clientWidth) return;
    inner.scrollLeft += e.deltaY || e.deltaX;
    e.preventDefault();
    e.stopPropagation();
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this.onPointer);
    this.el.removeEventListener('wheel', this.onWheel);
    this.robot.dispose();
    this.center.dispose();
    this.el.innerHTML = '';
    this.el.classList.remove('sp-root', 'sp-empty', 'sp-robot', 'sp-center');
    this.html = null;
    this.active = null;
  }
}

