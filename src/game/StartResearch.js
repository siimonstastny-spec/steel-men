// Steel Men – starting research option (New game / lobby combobox, settings key `startResearch`).
// Value: one of START_RESEARCH.options = the highest tier whose research every team starts with (0 = none).
// Every team (humans and AI) gets all research of tier <= value that its faction may research; building / previous
// tier / salvage requirements are ignored. Effects go through Research.complete (same as a finished research).
// [A9] Superweapon programs (stats research superweaponProgram) are never given at start.
//
//   validStartResearch(v)            v if listed, else START_RESEARCH.default
//   startResearchLabel(v)            combobox text (i18n)
//   startResearchFromSettings(s)     reads s.startResearch (validated)
//   applyStartResearch(research, v)  completes the research of every team, in stable order (tier, id)
import { START_RESEARCH } from '../config.js';
import { t } from '../i18n/i18n.js';

export { START_RESEARCH };

export function validStartResearch(v) {
  return START_RESEARCH.options.includes(v) ? v : START_RESEARCH.default;
}

export function startResearchLabel(v) {
  return v === START_RESEARCH.none ? t('setup.startResearch.none') : t('setup.startResearch.tier', { n: v });
}

export function startResearchFromSettings(s) {
  return validStartResearch(s?.startResearch);
}

/** Completes research up to `maxTier` for every team. Call once, before the first tick (same in all clients). */
export function applyStartResearch(research, maxTier) {
  const tier = validStartResearch(maxTier);
  if (!research || tier <= START_RESEARCH.none) return;
  const defs = research.defs;
  for (let team = 0; team < research.races.length; team++) {
    const ids = research.available(team)
      .filter((id) => Number.isFinite(defs[id]?.tier) && defs[id].tier <= tier && !research.isProgram(id)) // [A9] programs are always researched
      .sort((a, b) => defs[a].tier - defs[b].tier || (a < b ? -1 : a > b ? 1 : 0)); // stable key, not insertion order
    for (const id of ids) research.complete(team, id);
    research.grantTier(team, tier); // buildings with requiresTier <= tier can be built at once (no research facility needed)
  }
}
