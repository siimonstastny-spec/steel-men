// Steel Men – [A4-UI] small toggleable performance overlay (KEYBINDINGS.perfPanel): FPS, frame time, simulation tick
// time, AI time per tick (average and maximum over the last A4_UI.perf.windowSeconds) and unit / player counts.
// UI only. sample() is called from the game loop every frame and allocates nothing (ring buffers).
//
//   const perf = new PerfPanel(parent)           parent defaults to document.body; installs the key listener
//   perf.sample(frameMs, tickMs, aiMs)           every frame; tickMs / aiMs = summed ms of the ticks run this frame,
//                                                or a negative number / NaN when no tick (AI) ran (then not counted)
//   perf.setCounts({ units, players, aiTeams })  any time (e.g. once a second)
//   perf.toggle() / perf.show() / perf.hide() / perf.visible
//   perf.dispose()
// Texts: i18n keys perf.* (docs/notes/a4-ui.md). Styles: perf.css (loaded here).
import { A4_UI, KEYBINDINGS } from '../config.js';
import { t, onLanguageChange } from '../i18n/i18n.js';

const P = A4_UI.perf;
const CAPACITY = Math.max(1, Math.round(P.windowSeconds * P.sampleHz));
const SECOND_MS = 1000;
const DECIMALS = 1;

try {
  const href = new URL('./perf.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
} catch { /* no DOM / odd URL: the panel still works, just unstyled */ }

/** Ring buffer of numbers with running count; avg / max loops over at most CAPACITY values (no allocation) */
class Ring {
  constructor() { this.buf = new Float32Array(CAPACITY); this.head = 0; this.n = 0; }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % CAPACITY;
    if (this.n < CAPACITY) this.n++;
  }
  avg() {
    if (!this.n) return 0;
    let sum = 0;
    for (let i = 0; i < this.n; i++) sum += this.buf[i];
    return sum / this.n;
  }
  max() {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.buf[i] > m) m = this.buf[i];
    return m;
  }
  clear() { this.head = 0; this.n = 0; }
}

const ROWS = ['fps', 'frame', 'tick', 'ai', 'units', 'players'];

export class PerfPanel {
  constructor(parent = null) {
    this.frames = new Ring();
    this.ticks = new Ring();
    this.ais = new Ring();
    this.counts = { units: 0, players: 0, aiTeams: 0 };
    this.timer = null;
    this.visible = false;
    this.el = document.createElement('div');
    this.el.id = 'perf-panel';
    this.el.hidden = true;
    this.el.innerHTML = `<b class="perf-title"></b>${ROWS.map((r) => `<div class="perf-row" data-row="${r}"><span class="perf-label"></span><span class="perf-val"></span></div>`).join('')}`;
    this.title = this.el.querySelector('.perf-title');
    this.rows = {};
    for (const r of ROWS) {
      const row = this.el.querySelector(`[data-row="${r}"]`);
      this.rows[r] = { row, label: row.children[0], val: row.children[1] };
    }
    (parent ?? document.body).appendChild(this.el);
    this.onKey = (e) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || !KEYBINDINGS.perfPanel?.includes(e.code)) return;
      if (e.target?.closest?.('input, select, textarea')) return;
      e.preventDefault();
      this.toggle();
    };
    window.addEventListener('keydown', this.onKey);
    this.offLanguage = onLanguageChange(() => { if (this.visible) this.#labels(); });
  }

  /** Called every frame by the game loop; tickMs / aiMs < 0 or NaN = nothing ran this frame */
  sample(frameMs, tickMs, aiMs) {
    if (frameMs >= 0) this.frames.push(frameMs);
    if (tickMs >= 0) this.ticks.push(tickMs);
    if (aiMs >= 0) this.ais.push(aiMs);
  }

  setCounts({ units = 0, players = 0, aiTeams = 0 } = {}) {
    this.counts.units = units;
    this.counts.players = players;
    this.counts.aiTeams = aiTeams;
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.el.hidden = false;
    this.#labels();
    this.#refresh();
    this.timer = setInterval(() => this.#refresh(), P.refreshMs);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.hidden = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  toggle() { if (this.visible) this.hide(); else this.show(); }

  #labels() {
    this.title.textContent = t('perf.title');
    for (const r of ROWS) this.rows[r].label.textContent = t(`perf.${r}`);
  }

  #set(name, text, warn) {
    const r = this.rows[name];
    r.val.textContent = text;
    r.row.classList.toggle('warn', warn);
  }

  #refresh() {
    const fAvg = this.frames.avg();
    const fMax = this.frames.max();
    const tAvg = this.ticks.avg();
    const tMax = this.ticks.max();
    const aAvg = this.ais.avg();
    const aMax = this.ais.max();
    const d = DECIMALS;
    this.#set('fps', fAvg > 0 ? (SECOND_MS / fAvg).toFixed(0) : '–', fAvg > P.warnFrameMs);
    this.#set('frame', `${fAvg.toFixed(d)} / ${fMax.toFixed(d)} ms`, fAvg > P.warnFrameMs);
    this.#set('tick', `${tAvg.toFixed(d)} / ${tMax.toFixed(d)} ms`, tAvg > P.warnTickMs);
    this.#set('ai', `${aAvg.toFixed(d)} / ${aMax.toFixed(d)} ms`, aAvg > P.warnAiMs);
    this.#set('units', String(this.counts.units), false);
    this.#set('players', t('perf.playersValue', { n: this.counts.players, ai: this.counts.aiTeams }), false);
  }

  dispose() {
    this.hide();
    window.removeEventListener('keydown', this.onKey);
    this.offLanguage?.();
    this.el.remove();
    this.frames.clear(); this.ticks.clear(); this.ais.clear();
  }
}
