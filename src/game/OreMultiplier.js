// Steel Mans – [B1] ore multiplier option (New game / lobby combobox, settings key `oreMultiplier`).
// Value: one of ORE_MULTIPLIER.options (a number that scales the deposits' starting amount, or 'infinite').
//
//   validOreMultiplier(v)      v if listed, else ORE_MULTIPLIER.default
//   isInfiniteOre(v)           true for 'infinite'
//   oreMultiplierLabel(v)      combobox text: '0.5×' … '4×', '∞'
//   oreMultiplierFromSettings(s)  reads s.oreMultiplier; an old s.infiniteDeposits === true counts as 'infinite'
import { ORE_MULTIPLIER } from '../config.js';

export { ORE_MULTIPLIER };

export function validOreMultiplier(v) {
  return ORE_MULTIPLIER.options.includes(v) ? v : ORE_MULTIPLIER.default;
}

export const isInfiniteOre = (v) => v === ORE_MULTIPLIER.infinite;

export function oreMultiplierLabel(v) {
  return isInfiniteOre(v) ? '∞' : `${v}×`;
}

export function oreMultiplierFromSettings(s) {
  if (s && s.oreMultiplier === undefined && s.infiniteDeposits === true) return ORE_MULTIPLIER.infinite;
  return validOreMultiplier(s?.oreMultiplier);
}
