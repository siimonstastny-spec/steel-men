// Steel Mans – in-game menu (Esc when there is nothing to cancel, F10, or the ☰ button) and the end-of-match
// screen with the statistics of all teams.
//   resume · [multiplayer: pause] · settings (the start menu's Settings screen, returns here) · surrender (confirm)
//   · quit to menu (confirm)
// Pause [R5] (docs/notes/r5-pause.md): single player – the open menu (and the settings opened from it) pauses the
// game (main.js reads `pausesSimulation`). Multiplayer – the menu never pauses by itself; its Pause button asks the
// Lockstep for a deterministic pause, and while the match stands every player sees a banner "Player X paused the
// game" with Resume (anyone may resume). main.js calls update() every frame to keep the banner current.
// [N5FIX] (docs/notes/n5-fix.md) An eliminated local player whose ally still plays is an observer: no defeat screen,
// a small label (#match-observer), Leave instead of Surrender in the menu, and the alliance's real result at the end.
// The defeat screen comes when he leaves (menu → Leave) or when his whole alliance is out.
// Styles: src/ui/match.css. Texts: i18n keys match.*, dialog.surrender, dialog.quit, dialog.leave, victory.*.
import { MATCH_STATS, MATCH_UI, TEAMS, PAUSE, GAME_SPEED } from '../config.js';
import { gameSpeed, speedLabel } from '../game/GameSpeed.js';
import { getStats } from '../data/Stats.js';
import { t } from '../i18n/i18n.js';
import { confirmDialog, isConfirmDialogOpen } from './ConfirmDialog.js';
import { localTeam, isLocal } from '../core/LocalPlayer.js';
import { commandBus } from '../game/commands/CommandBus.js';
import { allianceOf, areAllies, teamsOfAlliance } from '../game/Alliances.js'; // [N5a] alliances API
import { allianceLetter } from '../core/AllianceSetup.js';
import { playerAvatarHtml } from './Avatar.js'; // [N6] computer players' avatars in the stats header

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** 1:05:09 / 12:03 */
export function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const m = Math.floor(s / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  return h > 0 ? `${h}:${pad(m)}:${pad(s % SECONDS_PER_MINUTE)}` : `${m}:${pad(s % SECONDS_PER_MINUTE)}`;
}

export class MatchUi {
  /**
   * @param {object} deps
   * @param {(i: number) => string} deps.teamName   display name of a team ([N6] main.js: playerLabel(i) of a computer player)
   * @param {(returnTo: () => void) => void} deps.openSettings  shows the Settings screen, calls returnTo when it closes
   * @param {() => void} deps.quit                  back to the start menu
   * @param {() => object|null} [deps.net]          the Lockstep of a multiplayer match, else null ([R5])
   * @param {() => string} [deps.nickname]          the local player's name, shown to everybody with a pause
   */
  constructor({ teamName, openSettings, quit, net = () => null, nickname = () => '' }) {
    this.teamName = teamName;
    this.openSettings = openSettings;
    this.quit = quit;
    this.getNet = net;
    this.nickname = nickname;
    this.match = null;
    this.inSettings = false;   // settings screen opened from this menu (single player: still paused)
    this.pauseKey = null;      // last banner state drawn by update()
    this.speedKey = gameSpeed.value; // [N4] last game speed drawn in the menu
    this.menuEl = this.#overlay('match-menu');
    this.endEl = this.#overlay('match-end');
    this.pauseEl = document.createElement('div');
    this.pauseEl.id = 'match-pause';
    this.pauseEl.hidden = true;
    this.pauseEl.setAttribute('role', 'status');
    this.pauseEl.setAttribute('aria-live', 'polite');
    this.pauseEl.addEventListener('click', (e) => this.#onClick(e));
    document.body.appendChild(this.pauseEl);
    this.button = document.createElement('button');
    this.button.id = 'match-menu-btn';
    this.button.textContent = MATCH_UI.menuButtonIcon;
    this.button.title = t('match.menu.title');
    this.button.hidden = true;
    this.button.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleMenu(); });
    document.body.appendChild(this.button);
    this.keyHandler = (e) => this.#onKey(e);
    window.addEventListener('keydown', this.keyHandler, true);
    // [MP-POLISH] update() normally runs from the animation loop, which a hidden tab does not get: keep the banner current
    this.pumpTimer = setInterval(() => this.update(), PAUSE.bannerPollMs);
  }

  dispose() {
    clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    window.removeEventListener('keydown', this.keyHandler, true);
    for (const el of [this.pauseEl, this.button, this.menuEl, this.endEl, this.observerEl]) el?.remove();
  }

  #overlay(id) {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'match-overlay';
    el.hidden = true;
    el.addEventListener('click', (e) => this.#onClick(e));
    document.body.appendChild(el);
    return el;
  }

  /** A new game starts: `match` = src/game/Match.js instance */
  setMatch(match) {
    this.match = match;
    this.button.hidden = false;
    this.menuEl.hidden = true;
    this.endEl.hidden = true;
    this.inSettings = false;
    this.pauseKey = null;
    this.pausePendingUntil = 0;
    this.pauseEl.hidden = true;
    this.localOutShown = false;
    this.left = false;        // [N5FIX] the eliminated local player left the game (menu → Leave): defeat is final
    this.#setObserver(false);
    // [N5b] after the local player's whole alliance fell, the final screen is shown only when it still wins in the end
    // (cannot happen, kept for safety). [N5FIX] an observer (eliminated, allies still played) sees the real result
    // of the alliance; a player who left sees nothing more.
    match.onEnd = (result) => {
      this.#setObserver(false);
      if (this.left) return;
      if (!this.localOutShown || this.#localWon(result)) this.showEnd(result);
    };
    // [N5FIX] The local player fell: while an ally still plays he only watches (small label, no defeat screen); the
    // defeat screen comes once the whole alliance is out while others fight on. Every elimination is checked, because
    // the last ally falling turns an observer into a defeated player.
    match.onEliminated = (team, reason) => {
      const me = localTeam();
      if (me == null || this.left || this.localOutShown || !match.eliminated.has(me)) return;
      if (!areAllies(me, team)) return;
      // A player who surrendered gave up the match: defeat at once (he stays among the losers, Match.surrendered)
      if (this.observing) { this.#setObserver(true); return; }
      this.#setObserver(false);
      this.localOutShown = true;
      this.showEnd({ winner: null, reason, stats: match.stats.snapshot(), ongoing: true });
    };
  }

  /** [N5FIX] Is the local player an observer (eliminated, an ally still plays, the match goes on)? */
  get observing() {
    const me = localTeam();
    return !!this.match && me != null && !this.left && !this.match.surrendered?.has(me) && !!this.match.isObserving?.(me);
  }

  /** [N5FIX] Small label "Observer – allies play on" under the ☰ button */
  #setObserver(on) {
    if (!this.observerEl) {
      this.observerEl = document.createElement('div');
      this.observerEl.id = 'match-observer';
      this.observerEl.setAttribute('role', 'status');
      document.body.appendChild(this.observerEl);
    }
    this.observerOn = on;
    this.observerEl.textContent = on ? t('match.observer') : '';
    this.observerEl.hidden = !on;
  }

  /** [N5FIX] The eliminated local player leaves: the defeat screen (current stats), only "back to menu" */
  #leave() {
    this.left = true;
    this.#setObserver(false);
    this.closeMenu();
    this.showEnd({ winner: null, reason: 'left', stats: this.match.stats.snapshot(), ongoing: true, left: true });
  }

  get isOpen() { return !this.menuEl.hidden || !this.endEl.hidden; }

  // ---------- pause [R5] ----------

  /** The Lockstep while a multiplayer match runs, else null */
  get #net() { return this.match ? (this.getNet?.() ?? null) : null; }

  /** Single player: no simulation tick while the menu (or the settings opened from it) is open. main.js reads this. */
  get pausesSimulation() {
    return PAUSE.soloPausesWithMenu && !!this.match && !this.#net && (!this.menuEl.hidden || this.inSettings);
  }

  /** Every frame (main.js): shows / hides the multiplayer pause banner */
  update() {
    if (this.match && this.observing !== !!this.observerOn) this.#setObserver(this.observing); // [N5FIX] label follows the sim
    if (gameSpeed.value !== this.speedKey) { // [N4] speed changed (menu click, or the host's change reached this client)
      this.speedKey = gameSpeed.value;
      if (!this.menuEl.hidden) this.openMenu();
    }
    const paused = this.#net?.status?.paused ?? null;
    // [MP-POLISH] The pause takes effect a few turns after the click, so the requester gets the window at once
    // (without Resume) instead of seeing nothing until the match stands.
    if (paused) this.pausePendingUntil = 0;
    const pending = !paused && this.pausePendingUntil > performance.now();
    const canResume = !!paused && !!this.#net?.canPause; // an observer never resumes
    const key = paused ? `${paused.turn}:${paused.team}:${canResume}` : pending ? 'pending' : null;
    if (key === this.pauseKey) return;
    this.pauseKey = key;
    if (!key) {
      this.pauseEl.hidden = true;
      this.pauseEl.innerHTML = '';
    } else {
      const name = paused ? (paused.name || this.teamName(paused.team)) : (this.pausePendingName || this.teamName(localTeam()));
      this.pauseEl.innerHTML = `<div class="match-card">
        <h2>${t('match.pause.title')}</h2>
        <p class="match-reason">${esc(t('match.pause.by', { name }))}</p>
        ${canResume ? `<button data-act="unpause" class="primary">${t('match.pause.resume')}</button>` : ''}
      </div>`;
      this.pauseEl.hidden = false;
    }
    if (!this.menuEl.hidden) this.openMenu(); // Pause / Resume button of the menu follows the state
  }

  #onKey(e) {
    if (!this.match || isConfirmDialogOpen()) return;
    if (document.getElementById('menu')?.hidden === false) return; // start menu / settings open
    if (e.code === 'Escape' && !this.menuEl.hidden) { this.closeMenu(); e.preventDefault(); e.stopPropagation(); }
    else if (e.code === 'Escape' && !this.endEl.hidden) { this.#observe(); e.preventDefault(); e.stopPropagation(); }
  }

  toggleMenu() { if (this.menuEl.hidden) this.openMenu(); else this.closeMenu(); }

  openMenu() {
    if (!this.match || !this.endEl.hidden) return;
    const over = !!this.match.result;
    const me = localTeam();
    const out = me != null && !!this.match.eliminated?.has(me); // [N5FIX] eliminated: Leave instead of Surrender
    const net = this.#net;
    let pauseRow = '';
    if (net?.canPause) {
      pauseRow = net.status?.paused
        ? `<button data-act="unpause">${t('match.pause.resume')}</button>`
        : `<button data-act="pause">${t('match.menu.pause')}</button>`;
    } else if (!net && PAUSE.soloPausesWithMenu) {
      pauseRow = `<p class="match-reason">${t('match.menu.paused')}</p>`;
    }
    // [N4] game speed: single player always, multiplayer only the host changes it (the others see the current one)
    const canSpeed = net ? !!net.canChangeSpeed : true;
    const speedRow = `<div class="match-speed" title="${esc(t('match.speed.hint'))}">
        <span class="match-reason">${t('match.speed')}${canSpeed ? '' : ` (${t('match.speed.hostOnly')})`}</span>
        <div class="match-speed-row">${GAME_SPEED.options.map((v) =>
    `<button data-act="speed" data-speed="${v}"${v === gameSpeed.value ? ' class="primary"' : ''}${canSpeed ? '' : ' disabled'}>${speedLabel(v)}</button>`).join('')}</div>
      </div>`;
    this.menuEl.innerHTML = `<div class="match-card">
      <h2>${t('match.menu.title')}</h2>
      ${pauseRow}
      ${speedRow}
      <button data-act="settings">${t('match.menu.settings')}</button>
      ${over ? `<button data-act="results">${t('match.menu.results')}</button>`
        : out ? `<button data-act="leave" class="danger">${t('match.menu.leave')}</button>`
        : `<button data-act="surrender" class="danger">${t('match.menu.surrender')}</button>`}
      <div class="match-actions">
        <button data-act="resume" class="primary">${t('match.menu.resume')}</button>
        <button data-act="quit">${t('match.menu.quit')}</button>
      </div>
    </div>`;
    this.menuEl.hidden = false;
  }

  closeMenu() { this.menuEl.hidden = true; }

  async #onClick(e) {
    const btn = e.target.closest('button');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'resume') this.closeMenu();
    else if (act === 'speed') this.#setSpeed(Number(btn.dataset.speed));
    else if (act === 'pause') {
      const name = this.nickname?.() ?? '';
      if (this.#net?.requestPause(name)) { // [MP-POLISH] window for the requester right away
        this.pausePendingName = name;
        this.pausePendingUntil = performance.now() + PAUSE.pendingMs;
      }
      this.closeMenu();
      this.update();
    }
    else if (act === 'unpause') { this.#net?.resume(); this.update(); }
    else if (act === 'settings') {
      this.inSettings = true; // single player stays paused behind the settings screen
      this.closeMenu();
      this.openSettings(() => { this.inSettings = false; this.openMenu(); });
    }
    else if (act === 'surrender') {
      if (await confirmDialog({ messageKey: 'dialog.surrender', confirmKey: 'match.menu.surrender' })) {
        this.closeMenu();
        commandBus.submit({ type: 'surrender', team: localTeam() }); // runs in the simulation (matchCommands.js)
      }
    } else if (act === 'leave') { // [N5FIX] eliminated player: no command (nothing of his team is left to change)
      if (await confirmDialog({ messageKey: 'dialog.leave', confirmKey: 'match.menu.leave' })) this.#leave();
    } else if (act === 'quit') {
      if (this.match.result || await confirmDialog({ messageKey: 'dialog.quit', confirmKey: 'match.menu.quit' })) this.quit();
    } else if (act === 'results') { this.closeMenu(); this.showEnd(this.match.result); }
    else if (act === 'observe') this.#observe();
    else if (act === 'toMenu') this.quit();
  }

  /** [N4] single player: set directly; multiplayer: the host asks the Lockstep (applied everywhere before the same tick) */
  #setSpeed(v) {
    const net = this.#net;
    if (!net) gameSpeed.set(v);
    else if (net.canChangeSpeed) net.requestSpeed(v);
  }

  #observe() { if (!this.left) this.endEl.hidden = true; } // [N5FIX] after leaving only "back to menu" remains

  // ---------- end of match ----------

  /** [N5b] Teams that won: result.winners when the simulation gives them, else the whole alliance of result.winner */
  #winnerTeams(result) {
    if (Array.isArray(result.winners)) return result.winners;
    return result.winner == null ? [] : teamsOfAlliance(allianceOf(result.winner));
  }

  /** [N5b] Did the local player's alliance win? (a draw and a spectator count as no; [N5FIX] so does surrendering) */
  #localWon(result) {
    const me = localTeam();
    if (me == null || this.match?.surrendered?.has(me)) return false;
    return this.#winnerTeams(result).some((w) => areAllies(me, w));
  }

  /** Other seats allied with the local player */
  #localAllies() {
    const me = localTeam();
    if (me == null) return [];
    return (this.match?.teams ?? []).filter((tm) => tm !== me && areAllies(me, tm));
  }

  /** Team name, with a note for an ally of the local player */
  #teamLabel(team) {
    const ally = !isLocal(team) && localTeam() != null && areAllies(localTeam(), team);
    return ally ? `${this.teamName(team)} (${t('match.ally')})` : this.teamName(team);
  }

  /** i18n key of the end reason; the local player's own surrender / [MP-LEAVE2] disconnection has its own text */
  #reasonKey(reason, selfSurrendered) {
    if (selfSurrendered && reason === 'surrender') return 'match.reason.surrenderSelf';
    if (reason === 'disconnected' && localTeam() != null && this.match?.isDisconnected?.(localTeam())) return 'match.reason.disconnectedSelf';
    return `match.reason.${reason}`;
  }

  showEnd(result) {
    this.closeMenu();
    const won = this.#localWon(result); // draw (winner null) counts as a defeat
    const selfSurrendered = localTeam() != null && !!this.match?.surrendered?.has(localTeam()); // [MP-POLISH]
    const allies = this.#localAllies();
    const allyFights = !!result.ongoing && allies.some((a) => !this.match.eliminated?.has(a));
    this.endEl.innerHTML = `<div class="match-card wide ${won ? 'won' : 'lost'}">
      <h1>${t(won ? 'match.victory' : 'match.defeat')}</h1>
      <p class="match-reason">${t(this.#reasonKey(result.reason, selfSurrendered))}</p>
      ${allyFights ? `<p class="match-reason">${t('match.allyFights')}</p>` : ''}
      ${allies.length ? `<p class="match-reason match-allies">${esc(t('match.allies', { names: allies.map((a) => this.teamName(a)).join(', ') }))}</p>` : ''}
      <div class="match-time">${t('match.duration')}: <b>${formatDuration(result.stats.time)}</b></div>
      ${this.#statsTable(result.stats, result)}
      <div class="match-actions">
        <button data-act="toMenu"${result.left ? ' class="primary"' : ''}>${t('match.toMenu')}</button>
        ${result.left ? '' : `<button data-act="observe" class="primary">${t('match.observe')}</button>`}
      </div>
    </div>`;
    this.endEl.hidden = false;
  }

  // [N5b] Columns of all teams, allies side by side. Header rows: alliance groups (only when someone has an ally),
  // team names, outcome of every team (not while the match goes on after the local player fell).
  #statsTable(stats, result) {
    const resources = getStats().resources ?? ['ore', 'energy'];
    const count = stats.teams.length;
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => allianceOf(a) - allianceOf(b) || a - b);
    const groups = [];
    for (const team of order) {
      const last = groups[groups.length - 1];
      if (last && last.alliance === allianceOf(team)) last.size++;
      else groups.push({ alliance: allianceOf(team), size: 1 });
    }
    const groupRow = groups.some((g) => g.size > 1)
      ? `<tr class="alliance-groups"><th></th>${groups.map((g) => `<th colspan="${g.size}" class="alliance-group${g.size > 1 ? ' team' : ''}">${g.size > 1 ? esc(t('match.alliance', { letter: allianceLetter(g.alliance) })) : ''}</th>`).join('')}</tr>`
      : '';
    const winners = this.#winnerTeams(result ?? {});
    const outcomeRow = result?.ongoing ? ''
      : `<tr class="outcome"><td></td>${order.map((i) => `<td class="${winners.includes(i) ? 'won' : 'lost'}">${t(winners.includes(i) ? 'match.team.won' : 'match.team.lost')}</td>`).join('')}</tr>`;
    // [N6] computer players: generated avatar (team colour) before the call sign; humans keep the colour dot only
    const head = order.map((i) => `<th><span class="match-dot" style="background:${esc(TEAMS[i].color)}"></span>${playerAvatarHtml(i, TEAMS[i].color, 'stats')}${esc(this.#teamLabel(i))}</th>`).join('');
    const row = (label, value) => `<tr><td>${label}</td>${order.map((i) => `<td>${value(stats.teams[i], i)}</td>`).join('')}</tr>`;
    const section = (label) => `<tr class="section"><th colspan="${count + 1}">${label}</th></tr>`;
    const kindRows = (bag) => MATCH_STATS.unitKinds.map((k) => row(t(`match.kind.${k}`), (tm) => tm[bag][k]));
    const amount = (n) => Math.round(n);
    return `<table class="match-stats"><thead>${groupRow}<tr><th></th>${head}</tr>${outcomeRow}</thead><tbody>
      ${section(t('match.stats.produced'))}${kindRows('produced').join('')}
      ${section(t('match.stats.lost'))}${kindRows('lost').join('')}
      ${section(t('match.stats.destroyed'))}
      ${row(t('match.stats.killedUnits'), (tm) => tm.kills.units)}
      ${row(t('match.stats.killedStructures'), (tm) => tm.kills.structures)}
      ${section(t('match.stats.gathered'))}${resources.map((r) => row(t(`hud.${r}`), (tm) => amount(tm.gathered[r] ?? 0))).join('')}
      ${section(t('match.stats.spent'))}${resources.map((r) => row(t(`hud.${r}`), (tm) => amount(tm.spent[r] ?? 0))).join('')}
      ${section(t('match.stats.other'))}
      ${row(t('match.stats.research'), (tm) => tm.research)}
    </tbody></table>`;
  }
}
