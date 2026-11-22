// Steel Mans – [D4] starting resources option (New game / lobby combobox, settings key `startMultiplier`).
// Value: one of START_MULTIPLIER.options (a number that scales every player's starting resources, or 'infinite' =
// resources never run out; the effect lives in Economy).
//
//   validStartMultiplier(v)        v if listed, else START_MULTIPLIER.default
//   isInfiniteStart(v)             true for 'infinite'
//   startMultiplierLabel(v)        combobox text: '0.5×' … '4×', '∞'
//   startMultiplierFromSettings(s) reads s.startMultiplier (validated)
import { START_MULTIPLIER } from '../config.js';

export { START_MULTIPLIER };

export function validStartMultiplier(v) {
  return START_MULTIPLIER.options.includes(v) ? v : START_MULTIPLIER.default;
}

export const isInfiniteStart = (v) => v === START_MULTIPLIER.infinite;

export function startMultiplierLabel(v) {
  return isInfiniteStart(v) ? '∞' : `${v}×`;
}

export function startMultiplierFromSettings(s) {
  return validStartMultiplier(s?.startMultiplier);
}
