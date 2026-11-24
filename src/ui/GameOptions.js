// Steel Mans – [B1] shared game-setting comboboxes of the New game and multiplayer lobby screens (modern RTS style:
// one labelled select per option). The screens own the state; this module only draws the controls and decodes changes.
//
//   optionsHtml(values, { disabled })         rows "label + select" (pre-build, start set, energy cap, population cap,
//                                             ore multiplier, game speed, fog of war, victory condition)
//   mapSelectHtml(values, { maps, disabled, random })  the map select (above the map preview; random = "Random" entry)
//   readOptionChange(target)                  -> { key, value } of a changed `select[data-opt]` (typed value) or null
//   friendlyFireHtml(ff, { disabled, attr })  the friendly-fire checkboxes (attr = data attribute name of the checkbox)
//   syncOptions(root, values)                 sets every select[data-opt] in root from values (no re-render)
// setup.css (layout, selects) is loaded by this module.
import { MENU, VICTORY, ECONOMY, GAME_SPEED } from '../config.js';
import { speedLabel } from '../game/GameSpeed.js';
import { PREBUILD, prebuildLabel } from '../game/PreBuild.js';
import { ORE_MULTIPLIER, oreMultiplierLabel } from '../game/OreMultiplier.js';
import { START_MULTIPLIER, startMultiplierLabel } from '../game/StartMultiplier.js'; // [D4]
import { START_RESEARCH, startResearchLabel } from '../game/StartResearch.js';
import { t } from '../i18n/i18n.js';
import { formatCapOption } from './formatAmount.js';
import { RANDOM_MAP } from '../game/MapCatalog.js';
import { getStats } from '../data/Stats.js';
import { startSetOrder } from '../game/StartSets.js'; // [N15]
import { conditionAllowed } from '../game/Victory.js';

try {
  const href = new URL('./setup.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
} catch { /* no DOM / odd URL: the screens still work, just unstyled */ }

export const FF_OPTIONS = ['enabled', 'artilleryOnly', 'reduced'];

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// key = settings key; options built per call (labels follow the language)
// [W5a] map choice: drawn above the map preview (mapSelectHtml), not among the rules; `random` adds the Random entry
function mapDef(maps, random) {
  const options = maps.map((m) => ({ value: m.id, label: `${m.name} (${t('setup.map.players', { n: m.players })})`, hint: m.description }));
  if (random) options.push({ value: RANDOM_MAP, label: t('setup.map.random'), hint: t('lobby.map.randomHint') });
  return { key: 'map', labelKey: 'setup.map', hintKey: null, options };
}

function defs(values) {
  const list = [];
  list.push(
    { key: 'prebuild', labelKey: 'setup.prebuild', hintKey: 'setup.prebuild.hint', options: PREBUILD.options.map((v) => ({ value: v, label: prebuildLabel(v) })) },
    // [N15] start set: options from stats.json (rules.economy.startSetOrder); the hint follows the selected set
    { key: 'startSet', labelKey: 'startSet.label', hintKey: null, options: startSetOrder(getStats()).map((v) => ({ value: v, label: t(`startSet.${v}`), hint: t(`startSet.${v}.desc`) })) },
    { key: 'energyCap', labelKey: 'setup.energyCap', hintKey: 'setup.energyCap.hint', options: ECONOMY.energyCaps.map((v) => ({ value: v, label: formatCapOption(v) })) },
    { key: 'populationCap', labelKey: 'setup.populationCap', hintKey: 'setup.populationCap.hint', options: ECONOMY.populationCaps.map((v) => ({ value: v, label: formatCapOption(v) })) },
    { key: 'oreMultiplier', labelKey: 'setup.oreMultiplier', hintKey: 'setup.oreMultiplier.hint', options: ORE_MULTIPLIER.options.map((v) => ({ value: v, label: oreMultiplierLabel(v) })) },
    { key: 'startMultiplier', labelKey: 'setup.startMultiplier', hintKey: 'setup.startMultiplier.hint', options: START_MULTIPLIER.options.map((v) => ({ value: v, label: startMultiplierLabel(v) })) }, // [D4]
    { key: 'startResearch', labelKey: 'setup.startResearch', hintKey: 'setup.startResearch.hint', options: START_RESEARCH.options.map((v) => ({ value: v, label: startResearchLabel(v) })) },
    { key: 'speed', labelKey: 'setup.gameSpeed', hintKey: 'setup.gameSpeed.hint', options: GAME_SPEED.options.map((v) => ({ value: v, label: speedLabel(v) })) },
    { key: 'fogOfWar', labelKey: 'setup.fogOfWar', hintKey: null, options: MENU.fogModes.map((v) => ({ value: v, label: t(`setup.fog.${v}`), hint: t(`setup.fog.${v}.hint`) })) },
    { key: 'victory', labelKey: 'setup.victory', hintKey: null, options: VICTORY.conditions.map((v) => {
      // A condition the chosen start set cannot play (no main building) is listed but disabled, with the reason as tooltip
      const allowed = !values || conditionAllowed(v, values.startSet, getStats());
      return { value: v, label: t(`victory.${v}`), hint: allowed ? t(`victory.${v}.hint`) : t('victory.needsMainBuilding'), disabled: !allowed };
    }) },
  );
  return list;
}

function rowHtml(d, values, disabled) {
  const cur = String(values[d.key]);
  const hint = d.hintKey ? t(d.hintKey) : (d.options.find((o) => String(o.value) === cur)?.hint ?? '');
  return `<label class="opt-row" title="${escapeHtml(hint)}"><span class="opt-label">${t(d.labelKey)}</span>
    <select class="opt-select" data-opt="${d.key}"${disabled ? ' disabled' : ''}>${d.options.map((o) =>
    `<option value="${escapeHtml(o.value)}"${String(o.value) === cur ? ' selected' : ''}${o.disabled ? ' disabled' : ''}${o.hint ? ` title="${escapeHtml(o.hint)}"` : ''}>${escapeHtml(o.label)}</option>`).join('')}</select></label>`;
}

/** The rules comboboxes (the map select is separate: mapSelectHtml) */
export function optionsHtml(values, { disabled = false } = {}) {
  return defs(values).map((d) => rowHtml(d, values, disabled)).join('');
}

/** [W5a] Map combobox (shown above the map preview); random = add the "Random" entry (lobby); maps = GameMap list */
export function mapSelectHtml(values, { maps, disabled = false, random = false } = {}) {
  if (!maps?.length) return '';
  return rowHtml(mapDef(maps, random), values, disabled);
}

/** { key, value } of a change event target; the value has the type of the option (number / 'infinite' / id), null if foreign */
export function readOptionChange(target) {
  const key = target?.dataset?.opt;
  if (!key) return null;
  if (key === 'map') return { key, value: target.value };
  const def = defs().find((d) => d.key === key);
  const opt = def?.options.find((o) => String(o.value) === target.value);
  return opt ? { key, value: opt.value } : null;
}

export function syncOptions(root, values) {
  for (const sel of root.querySelectorAll('select[data-opt]')) {
    const v = values[sel.dataset.opt];
    if (v !== undefined) sel.value = String(v);
  }
}

export function friendlyFireHtml(ff, { disabled = false, attr = 'data-ff' } = {}) {
  return FF_OPTIONS.map((k) => `
    <label class="rule${k === 'enabled' ? ' master' : ' sub'}${k !== 'enabled' && !ff.enabled ? ' disabled' : ''}" title="${escapeHtml(t(`setup.ff.${k}.hint`))}">
      <input type="checkbox" ${attr}="${k}"${ff[k] ? ' checked' : ''}${disabled || (k !== 'enabled' && !ff.enabled) ? ' disabled' : ''}>
      <span>${t(`setup.ff.${k}`)}</span></label>`).join('');
}
