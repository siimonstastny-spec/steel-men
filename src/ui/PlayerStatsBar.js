// Steel Men – short player statistics above the minimap (docs/notes/b4-diplomacy.md). One row per team of the
// match, grouped by alliance: colour, name, solo value, team (alliance) value; a defeated team is struck through.
// Value = MatchStats.score / allianceScore (weights PLAYER_STATS_BAR.score). UI only, never touches the simulation.
//
//   const bar = new PlayerStatsBar({ parent, nameOf })   parent defaults to #hud-root; nameOf(team) → display name
//   bar.setMatch(match)    new match (src/game/Match.js) – builds the rows; null hides the bar
//   bar.update(dt)         every frame (real seconds); re-reads the values every PLAYER_STATS_BAR.refreshSeconds
//   bar.refresh()          re-read now
//   bar.dispose()
// Styles: HUD v2 – the panel is built from stats_top (header) + one stats_row per team + stats_bottom (hud2 artwork);
// the rules live in hud.css (#player-stats-bar). player-stats.css is no longer loaded (obsolete file).
import { PLAYER_STATS_BAR, TEAMS } from '../config.js';
import { allianceOf } from '../game/Alliances.js';
import { playerLabel } from '../core/PlayerLabels.js';
import { onLanguageChange, t } from '../i18n/i18n.js';

const P = PLAYER_STATS_BAR;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** 950 → "950", 12345 → "12.3k" */
export function formatValue(n) {
  if (Math.abs(n) < P.compactFrom) return String(n);
  return `${(n / P.compactDivisor).toFixed(P.compactDecimals)}k`;
}

const defaultName = (team) => playerLabel(team) || t('ping.player', { n: team + 1 });

export class PlayerStatsBar {
  /** @param {{parent?: HTMLElement, nameOf?: (team: number) => string}} [opts] */
  constructor({ parent = null, nameOf = defaultName } = {}) {
    this.nameOf = nameOf;
    this.match = null;
    this.timer = 0;
    this.rows = [];        // { team, el, name, solo, ally }
    this.lastSolo = [];
    this.lastAlly = [];
    this.lastOut = [];
    this.el = document.createElement('div');
    this.el.id = 'player-stats-bar';
    this.el.hidden = true;
    (parent ?? document.getElementById('hud-root') ?? document.body).appendChild(this.el);
    this.offLanguage = onLanguageChange(() => { if (this.match) this.#build(); });
  }

  setMatch(match) {
    this.match = match ?? null;
    this.timer = 0;
    if (!this.match) { this.el.hidden = true; this.el.textContent = ''; this.rows = []; return; }
    this.#build();
    this.el.hidden = false;
  }

  #build() {
    const teams = [...this.match.teams].sort((a, b) => (allianceOf(a) ?? a) - (allianceOf(b) ?? b) || a - b);
    this.el.textContent = '';
    const head = document.createElement('div');
    head.className = 'psb-row psb-head';
    head.innerHTML = '<span class="psb-swatch"></span><span class="psb-name"></span><span class="psb-val"></span><span class="psb-val"></span>';
    head.children[2].textContent = t('statsBar.solo');
    head.children[3].textContent = t('statsBar.team');
    this.el.appendChild(head);
    this.rows = teams.map((team, i) => {
      const el = document.createElement('div');
      el.className = 'psb-row';
      // A new alliance group starts: thin separator
      if (i > 0 && (allianceOf(team) ?? team) !== (allianceOf(teams[i - 1]) ?? teams[i - 1])) el.classList.add('psb-group');
      el.innerHTML = '<span class="psb-swatch"></span><span class="psb-name"></span><span class="psb-val"></span><span class="psb-val psb-ally"></span>';
      const color = TEAMS[team]?.color;
      el.children[0].style.background = typeof color === 'string' && COLOR_RE.test(color) ? color : P.fallbackColor;
      this.el.appendChild(el);
      return { team, el, name: el.children[1], solo: el.children[2], ally: el.children[3], shownName: null };
    });
    const foot = document.createElement('div'); // stats_bottom piece
    foot.className = 'psb-foot';
    this.el.appendChild(foot);
    this.lastSolo = this.rows.map(() => NaN);
    this.lastAlly = this.rows.map(() => NaN);
    this.lastOut = this.rows.map(() => null);
    this.refresh();
  }

  update(dt) {
    if (!this.match) return;
    this.timer += dt;
    if (this.timer < P.refreshSeconds) return;
    this.timer = 0;
    this.refresh();
  }

  refresh() {
    const stats = this.match?.stats;
    if (!stats) return;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const solo = stats.score(row.team);
      const ally = stats.allianceScore(row.team);
      const out = this.match.eliminated.has(row.team);
      // Names can arrive late (multiplayer nickname): compare on every refresh, touch the DOM only on change
      const name = this.nameOf(row.team);
      if (name !== row.shownName) { row.shownName = name; row.name.textContent = name; row.name.title = name; }
      if (solo !== this.lastSolo[i]) { this.lastSolo[i] = solo; row.solo.textContent = formatValue(solo); }
      if (ally !== this.lastAlly[i]) { this.lastAlly[i] = ally; row.ally.textContent = formatValue(ally); }
      if (out !== this.lastOut[i]) { this.lastOut[i] = out; row.el.classList.toggle('psb-out', out); }
    }
  }

  dispose() {
    this.offLanguage?.();
    this.el.remove();
    this.rows = [];
    this.match = null;
  }
}
