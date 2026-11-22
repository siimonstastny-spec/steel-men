// Steel Mans – map preview canvas (New game menu, lobby): minimap-style picture of a map with clickable start
// positions. A start shows the seat that picked it (team colour + seat number). Clicks call onPick(startIndex).
import { MAPS } from '../config.js';
import { drawMapBackground } from './Minimap.js';

const P = MAPS.preview;

export class MapPreview {
  /**
   * @param {object} [opts]
   * @param {(start: number) => void} [opts.onPick]  click on a start marker (not called when interactive is false)
   * @param {string} [opts.title]                    tooltip of the canvas
   */
  constructor({ onPick = null, title = '' } = {}) {
    this.onPick = onPick;
    this.map = null;
    this.background = null;
    this.marks = [];          // [{ start, color, label }]
    this.interactive = true;
    this.el = document.createElement('canvas');
    this.el.className = 'map-preview';
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.el.width = this.el.height = Math.round(P.size * this.ratio);
    this.el.style.width = this.el.style.height = `${P.size}px`;
    if (title) this.el.title = title;
    this._onClick = (e) => this.#click(e);
    this.el.addEventListener('click', this._onClick);
  }

  /** Map to show (GameMap); null = empty */
  setMap(map) {
    if (map !== this.map) {
      this.map = map;
      this.background = null;
      if (map) {
        this.background = document.createElement('canvas');
        this.background.width = this.background.height = this.el.width;
        drawMapBackground(this.background.getContext('2d'), map, this.el.width, { starts: false });
      }
    }
    this.draw();
  }

  /**
   * @param {{start: number, color: string, label: string}[]} marks  picked starts
   * @param {boolean} interactive  false = clicks do nothing (lobby guest)
   */
  setMarks(marks, interactive = true) {
    this.marks = marks;
    this.interactive = interactive;
    this.el.classList.toggle('readonly', !interactive);
    this.draw();
  }

  draw() {
    const ctx = this.el.getContext('2d');
    const n = this.el.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, n, n);
    if (!this.map || !this.background) return;
    ctx.drawImage(this.background, 0, 0);
    ctx.scale(this.ratio, this.ratio);
    const r = P.startRadius;
    this.map.startPositions.forEach((p, i) => {
      const [x, y] = this.#toPx(p);
      const mark = this.marks.find((m) => m.start === i);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = mark?.color ?? P.startFill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = P.startStroke;
      ctx.stroke();
      if (mark) {
        ctx.fillStyle = P.labelColor;
        ctx.font = P.labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(mark.label, x, y + 0.5);
      }
    });
  }

  dispose() {
    this.el.removeEventListener('click', this._onClick);
    this.el.remove();
    this.background = null;
    this.map = null;
  }

  // CSS px of a world point
  #toPx(p) { return [(p.x / this.map.size + 0.5) * P.size, (p.z / this.map.size + 0.5) * P.size]; }

  #click(e) {
    if (!this.map || !this.interactive || !this.onPick) return;
    const rect = this.el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * P.size;
    const py = ((e.clientY - rect.top) / rect.height) * P.size;
    let best = -1;
    let bestDist = P.hitRadius;
    this.map.startPositions.forEach((p, i) => {
      const [x, y] = this.#toPx(p);
      const d = Math.hypot(x - px, y - py);
      if (d <= bestDist) { best = i; bestDist = d; }
    });
    if (best >= 0) this.onPick(best);
  }
}

/**
 * Click on a start in the preview: the active seat takes it (another seat that had it loses it); clicking the
 * active seat's own start frees it. Returns the new picks object and the next seat without a start.
 * @param {object} picks  { seat: start }
 * @param {number} seat   active seat
 * @param {number} start
 * @param {number} count  seats in play
 */
export function applyStartPick(picks, seat, start, count) {
  const next = { ...picks };
  if (next[seat] === start) delete next[seat];
  else {
    for (const s of Object.keys(next)) if (next[s] === start) delete next[s];
    next[seat] = start;
  }
  let nextSeat = seat;
  for (let k = 1; k <= count; k++) {
    const s = (seat + k) % count;
    if (next[s] === undefined) { nextSeat = s; break; }
  }
  return { picks: next, nextSeat };
}
