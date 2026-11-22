// Steel Mans – diplomacy menu (docs/notes/b4-diplomacy.md): overview of the players of the match (colour, avatar,
// name, alliance, planet = faction, state) and sending ore / energy to a living ally (rules.diplomacy.tributeLoss is
// lost on the way). Pick a resource and an amount, the row shows what really arrives, Send submits the command
// DIPLOMACY.commandType through the commandBus (lockstep in multiplayer). UI only: never mutates the simulation.
//
//   const dip = new DiplomacyView({ nameOf })   nameOf(team) → display name (default: call sign / "Player N")
//   dip.setMatch(match, world)                  new match (null = closed and inactive)
//   dip.open() / dip.close() / dip.toggle() / dip.isOpen
//   dip.onOpenChange = (open) => …             optional (HUD button state)
//   dip.dispose()
// Key: KEYBINDINGS.diplomacy toggles, KEYBINDINGS.cancel (Esc) closes. Styles: diplomacy.css (loaded here).
import { DIPLOMACY, KEYBINDINGS, TEAMS } from '../config.js';
import { commandBus } from '../game/commands/CommandBus.js';
import { tributeKeep, tributeQuote } from '../game/commands/diplomacyCommands.js'; // also registers the command
import { allianceOf, areAllies } from '../game/Alliances.js';
import { allianceLetter } from '../core/AllianceSetup.js';
import { localTeam } from '../core/LocalPlayer.js';
import { playerLabel } from '../core/PlayerLabels.js';
import { raceName } from '../data/Stats.js';
import { isConfirmDialogOpen } from './ConfirmDialog.js';
import { playerAvatarHtml } from './Avatar.js';
import { onLanguageChange, t } from '../i18n/i18n.js';

const U = DIPLOMACY.ui;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const colorOf = (team) => (COLOR_RE.test(TEAMS[team]?.color ?? '') ? TEAMS[team].color : U.fallbackColor);
const defaultName = (team) => playerLabel(team) || t('ping.player', { n: team + 1 });

// diplomacy.css is a separate file next to this module (no index.html change needed)
try {
  const href = new URL('./diplomacy.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
} catch { /* no DOM (tests) */ }

export class DiplomacyView {
  /** @param {{nameOf?: (team: number) => string}} [opts] */
  constructor({ nameOf = defaultName } = {}) {
    this.nameOf = nameOf;
    this.match = null;
    this.world = null;
    this.onOpenChange = null;
    this.timer = null;
    this.drafts = new Map(); // team -> { resource, amount } (amount picker state per ally)
    this.el = document.createElement('div');
    this.el.id = 'diplomacy-view';
    this.el.className = 'dip-overlay';
    this.el.hidden = true;
    this.onClick = (e) => this.#click(e);
    this.onInput = (e) => this.#input(e);
    this.onPointer = (e) => { if (e.target === this.el) this.close(); };
    this.el.addEventListener('click', this.onClick);
    this.el.addEventListener('input', this.onInput);
    this.el.addEventListener('pointerdown', this.onPointer);
    document.body.appendChild(this.el);
    this.onKey = (e) => this.#key(e);
    window.addEventListener('keydown', this.onKey, true);
    this.offLanguage = onLanguageChange(() => { if (this.isOpen) this.#render(); });
  }

  get isOpen() { return !this.el.hidden; }

  setMatch(match, world = match?.world ?? null) {
    this.close();
    this.match = match ?? null;
    this.world = world;
    this.drafts.clear();
  }

  open() {
    if (!this.match || !this.world || this.isOpen) return;
    this.el.hidden = false;
    this.#render();
    this.timer = setInterval(() => this.#refresh(), U.refreshMs);
    this.onOpenChange?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.el.textContent = '';
    clearInterval(this.timer);
    this.timer = null;
    this.onOpenChange?.(false);
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  dispose() {
    this.close();
    window.removeEventListener('keydown', this.onKey, true);
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('input', this.onInput);
    this.el.removeEventListener('pointerdown', this.onPointer);
    this.offLanguage?.();
    this.el.remove();
    this.match = null;
    this.world = null;
  }

  // ---------- keys ----------

  #key(e) {
    if (!this.match || e.repeat || isConfirmDialogOpen()) return;
    if (document.getElementById('menu')?.hidden === false) return; // start menu / settings open
    if (this.isOpen && KEYBINDINGS.cancel.includes(e.code)) {
      this.close(); e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.target?.closest?.('input, select, textarea')) return;
    if (!KEYBINDINGS.diplomacy?.includes(e.code) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!this.isOpen && document.querySelector('.match-overlay:not([hidden])')) return; // game menu / end screen (MatchUi)
    this.toggle(); e.preventDefault(); e.stopPropagation();
  }

  // ---------- model ----------

  #state(team) {
    const m = this.match;
    if (m.disconnected?.has(team)) return 'left';
    if (m.surrendered?.has(team)) return 'surrendered';
    if (m.eliminated.has(team)) return 'defeated';
    return 'playing';
  }

  #draft(team) {
    let d = this.drafts.get(team);
    if (!d) { d = { resource: this.world.economy?.resources?.[0] ?? 'ore', amount: U.defaultAmount }; this.drafts.set(team, d); }
    return d;
  }

  /** Teams this client may send to: allies (not itself) */
  #canTrade(team) {
    const me = localTeam();
    return team !== me && areAllies(team, me) && this.match.teams.includes(me);
  }

  // ---------- rendering ----------

  #render() {
    const m = this.match;
    const me = localTeam();
    const eco = this.world.economy;
    const teams = [...m.teams].sort((a, b) => (allianceOf(a) ?? a) - (allianceOf(b) ?? b) || a - b);
    const rows = teams.map((team) => {
      const color = colorOf(team);
      const race = eco?.races?.[team];
      const ally = team === me ? t('dip.you') : areAllies(team, me) ? t('match.ally') : t('dip.enemy');
      return `<tr data-team="${team}" class="${team === me ? 'dip-me' : ''}">
        <td class="dip-avatar"><span class="dip-swatch" style="background:${color}"></span>${playerAvatarHtml(team, color, 'stats')}</td>
        <td class="dip-name">${esc(this.nameOf(team))}<small>${esc(ally)}</small></td>
        <td>${esc(t('match.alliance', { letter: allianceLetter(allianceOf(team) ?? team) }))}</td>
        <td>${esc(race ? raceName(race) : '–')}</td>
        <td class="dip-state" data-state-of="${team}"></td>
      </tr>${this.#canTrade(team) ? this.#tradeRow(team) : ''}`;
    }).join('');
    this.el.innerHTML = `<div class="dip-panel" role="dialog" aria-label="${esc(t('dip.title'))}">
      <h2>${esc(t('dip.title'))}</h2>
      <p class="dip-own" data-own></p>
      <table class="dip-table">
        <thead><tr><th></th><th>${esc(t('dip.col.player'))}</th><th>${esc(t('dip.col.team'))}</th>
          <th>${esc(t('dip.col.planet'))}</th><th>${esc(t('dip.col.state'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="dip-hint">${esc(t('dip.lossHint', { loss: Math.round((1 - tributeKeep()) * U.percent) }))}</p>
      <div class="dip-actions"><button data-act="close">${esc(t('dip.close'))}</button></div>
    </div>`;
    this.#refresh();
  }

  #tradeRow(team) {
    const d = this.#draft(team);
    const res = (this.world.economy?.resources ?? []).map((r) =>
      `<button data-act="res" data-to="${team}" data-res="${esc(r)}" class="${r === d.resource ? 'on' : ''}">${esc(t(`hud.${r}`))}</button>`).join('');
    const minus = [...U.steps].reverse().map((s) => `<button data-act="step" data-to="${team}" data-step="${-s}">−${s}</button>`).join('');
    const plus = U.steps.map((s) => `<button data-act="step" data-to="${team}" data-step="${s}">+${s}</button>`).join('');
    return `<tr class="dip-trade" data-trade="${team}"><td></td><td colspan="4">
      <div class="dip-send">
        <span class="dip-res">${res}</span>
        <span class="dip-amount">${minus}<input type="number" min="1" step="1" data-amount="${team}" value="${d.amount}">${plus}</span>
        <span class="dip-preview" data-preview="${team}"></span>
        <button class="dip-go" data-act="send" data-to="${team}">${esc(t('dip.send'))}</button>
      </div></td></tr>`;
  }

  /** Live texts: own resources, states, previews (no rebuild, inputs keep focus) */
  #refresh() {
    if (!this.isOpen || !this.match) return;
    const eco = this.world.economy;
    const me = localTeam();
    const own = this.el.querySelector('[data-own]');
    if (own && eco) {
      own.textContent = t('dip.own', { list: eco.resources.map((r) => `${t(`hud.${r}`)} ${Math.floor(eco.amount(me, r))}`).join(', ') });
    }
    for (const cell of this.el.querySelectorAll('[data-state-of]')) {
      const team = Number(cell.dataset.stateOf);
      const state = this.#state(team);
      cell.textContent = t(`dip.state.${state}`);
      cell.closest('tr').classList.toggle('dip-out', state !== 'playing');
    }
    for (const box of this.el.querySelectorAll('[data-preview]')) this.#preview(Number(box.dataset.preview));
  }

  #preview(team) {
    const box = this.el.querySelector(`[data-preview="${team}"]`);
    const btn = this.el.querySelector(`[data-act="send"][data-to="${team}"]`);
    if (!box || !btn) return;
    const d = this.#draft(team);
    const q = tributeQuote(this.world, localTeam(), team, d.resource, d.amount);
    btn.disabled = !q.ok;
    if (!q.ok) { box.textContent = t(`dip.reason.${q.reason}`); box.classList.add('bad'); return; }
    box.classList.remove('bad');
    box.textContent = q.paid < d.amount
      ? t('dip.arrivesCapped', { arrives: q.delivered, paid: q.paid })
      : t('dip.arrives', { arrives: q.delivered, paid: q.paid });
  }

  // ---------- events ----------

  #click(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') { this.close(); return; }
    const team = Number(b.dataset.to);
    if (!Number.isInteger(team)) return;
    const d = this.#draft(team);
    if (act === 'res') {
      d.resource = b.dataset.res;
      for (const x of this.el.querySelectorAll(`[data-act="res"][data-to="${team}"]`)) x.classList.toggle('on', x === b);
    } else if (act === 'step') {
      const step = Number(b.dataset.step) * (e.shiftKey ? U.shiftStepFactor : 1);
      d.amount = Math.min(DIPLOMACY.maxAmount, Math.max(1, d.amount + step));
      const input = this.el.querySelector(`[data-amount="${team}"]`);
      if (input) input.value = String(d.amount);
    } else if (act === 'send') {
      const q = tributeQuote(this.world, localTeam(), team, d.resource, d.amount);
      if (!q.ok) return;
      commandBus.submit({ type: DIPLOMACY.commandType, team: localTeam(), to: team, resource: d.resource, amount: d.amount });
    }
    this.#preview(team);
  }

  #input(e) {
    const field = e.target.closest('[data-amount]');
    if (!field) return;
    const team = Number(field.dataset.amount);
    const v = Math.floor(Number(field.value));
    this.#draft(team).amount = Number.isFinite(v) ? Math.min(DIPLOMACY.maxAmount, Math.max(0, v)) : 0;
    this.#preview(team);
  }
}
