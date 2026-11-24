// Steel Men – [W5b] text of a resource amount / cap for the UI (HUD, statistics, tooltips, menus).
// An unlimited value (Infinity, the settings value ECONOMY.infinite, or the fixed amount of infinite resources
// ECONOMY.infiniteAmount and above) reads "∞"; anything else is rounded down to a whole number.
//
//   formatAmount(v)       12.7 → '12', Infinity / 'infinite' / 99999999999999 → '∞'
//   isUnlimitedAmount(v)  true when formatAmount shows '∞'
//   formatCapOption(v)    menu label of a cap option (ECONOMY.energyCaps / populationCaps): 400 → '400', 'infinite' → '∞'
import { ECONOMY } from '../config.js';

export const INFINITY_SIGN = '∞';

export function isUnlimitedAmount(v) {
  return v === ECONOMY.infinite || (typeof v === 'number' && v >= ECONOMY.infiniteAmount);
}

export function formatAmount(v) {
  if (isUnlimitedAmount(v)) return INFINITY_SIGN;
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.floor(n)) : '0';
}

export function formatCapOption(v) {
  return isUnlimitedAmount(v) ? INFINITY_SIGN : String(v);
}
