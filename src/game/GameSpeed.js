// Steel Men – game speed [N4] (docs/notes/n4-clock.md). Speed only changes how many fixed simulation ticks run per
// real second (main.js: simAccumulator += dt * gameSpeed.value); the step 1 / SIM.tickRate is never scaled, so the
// simulation stays deterministic. Single player: the in-game menu sets it directly. Multiplayer: only the host
// asks (Lockstep.requestSpeed); every client applies the same change before the same tick (Lockstep, control
// entry GAME_SPEED.commandType) and calls set() here.
import { GAME_SPEED, GAME_CLOCK } from '../config.js';

let value = GAME_SPEED.default;
const listeners = new Set();
const pad = (n) => String(n).padStart(2, '0');

export const gameSpeed = {
  /** current multiplier */
  get value() { return value; },
  isValid: (v) => GAME_SPEED.options.includes(v),
  /** Sets the multiplier (must be one of GAME_SPEED.options); returns false when refused */
  set(v) {
    const n = Number(v);
    if (!GAME_SPEED.options.includes(n)) return false;
    if (n !== value) {
      value = n;
      for (const fn of [...listeners]) { try { fn(value); } catch (err) { console.error(err); } }
    }
    return true;
  },
  /** New match: back to `v` (default GAME_SPEED.default) */
  reset(v = GAME_SPEED.default) { if (!this.set(v)) this.set(GAME_SPEED.default); },
  /** fn(value) after every change; returns unsubscribe */
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

/** 0.75 → "0.75×" */
export const speedLabel = (v) => `${v}${GAME_SPEED.symbol}`;

/** Game time in seconds → "mm:ss", or "h:mm:ss" from one hour on */
export function formatGameTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const perHour = GAME_CLOCK.secondsPerMinute * GAME_CLOCK.minutesPerHour;
  const h = Math.floor(s / perHour);
  const m = Math.floor(s / GAME_CLOCK.secondsPerMinute) % GAME_CLOCK.minutesPerHour;
  const sec = s % GAME_CLOCK.secondsPerMinute;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
