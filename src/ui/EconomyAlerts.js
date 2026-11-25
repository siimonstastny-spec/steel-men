// Steel Men – economy alerts at the top of the screen (below the pre-build banner, never overlapping it):
//   - no HQ (main building): mining and energy income only 10 %
//   - low energy: towers off, production slowed
// Local player only; hidden for spectators and after the match ended. Refreshes on an interval (no per-frame DOM work).
import { ECONOMY_ALERTS, ECONOMY_POWER, SOUND_HOOKS } from '../config.js';
import { getStats } from '../data/Stats.js';
import { t } from '../i18n/i18n.js';
import { play } from '../audio/Sound.js';

const PERCENT = 100;

export class EconomyAlerts {
  /** @param {{economy:object, getTeam:()=>number}} opts getTeam returns the local team (or <0/null = spectator) */
  constructor({ economy, getTeam }) {
    this.economy = economy;
    this.getTeam = getTeam;
    this.match = null;
    this.lastRefresh = 0;
    this.lastLowPowerSound = -Infinity; // [A6] ms of the last lowPower sound (a flickering energy level does not repeat it)
    this.shown = { hq: null, energy: null }; // last rendered state, avoids touching the DOM when unchanged
    this.root = document.createElement('div');
    this.root.className = 'hud-econ-alerts';
    this.root.hidden = true;
    this.noHq = this.#line('noHq');
    this.lowEnergy = this.#line('lowEnergy');
    this.#setTexts();
    document.body.appendChild(this.root);
  }

  #line(kind) {
    const el = document.createElement('div');
    el.className = `hud-econ-alert ${kind}`;
    el.hidden = true;
    this.root.appendChild(el);
    return el;
  }

  #setTexts() {
    const noHq = getStats().rules?.economy?.noHqIncomeFactor ?? 1;
    this.noHq.textContent = t('econ.alert.noHq', { n: Math.round(noHq * PERCENT) });
    this.lowEnergy.textContent = t('econ.alert.lowEnergy', { n: Math.round(ECONOMY_POWER.lowWorkRate * PERCENT) });
  }

  /** match: Match instance (reads `result`, `eliminated`) or null; hides everything when the match is over */
  setMatch(match) { this.match = match ?? null; this.reset(); }

  setEconomy(economy) { this.economy = economy; this.reset(); }

  /** forget the rendered state (new match / language change) */
  reset() {
    if (!this.root) return;
    this.#setTexts();
    this.lastRefresh = 0;
    this.shown.hq = this.shown.energy = null;
  }

  /** call every frame; `nowMs` e.g. performance.now() (UI only, not the simulation) */
  update(nowMs = performance.now()) {
    if (!this.root) return;
    if (nowMs - this.lastRefresh < ECONOMY_ALERTS.refreshMs) return;
    this.lastRefresh = nowMs;
    const team = this.getTeam?.();
    const active = this.economy && team != null && team >= 0 && !this.match?.result && !this.match?.eliminated?.has(team);
    const noHq = !!active && this.economy.hasHq?.(team) === false;
    const low = !!active && !!this.economy.isLowEnergy?.(team);
    if (noHq !== this.shown.hq) { this.noHq.hidden = !noHq; this.shown.hq = noHq; }
    if (low !== this.shown.energy) {
      if (low && this.shown.energy === false && nowMs - this.lastLowPowerSound >= SOUND_HOOKS.lowPowerCooldownMs) { // [A6] once per episode
        this.lastLowPowerSound = nowMs; // not right after reset (load / new match: shown is null)
        play('lowPower');
      }
      this.lowEnergy.hidden = !low; this.shown.energy = low;
    }
    this.root.hidden = !(noHq || low);
  }

  dispose() {
    this.root.remove();
    this.root = this.noHq = this.lowEnergy = this.economy = this.match = this.getTeam = null;
  }
}
