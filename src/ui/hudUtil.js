// Steel Men – small helpers shared by the HUD panels
import { HUD, TEAMS } from '../config.js';
import { isLocal, localTeam } from '../core/LocalPlayer.js';
import { areAllies } from '../game/Alliances.js';
import { raceName } from '../data/Stats.js';
import { t } from '../i18n/i18n.js';

export const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

/** HP colour: 100 % full, above warn threshold warn, above critical threshold critical; null / 0 = missing */
export function hpColor(ratio) {
  const c = HUD.hpColors;
  const th = HUD.hpThresholds;
  if (ratio === null || ratio <= 0) return c.missing;
  if (ratio >= 1) return c.full;
  if (ratio > th.warn) return c.warn;
  return ratio > th.critical ? c.critical : c.missing; // ≤ 1 % counts as gone
}

/** [hp, maxHp] of a unit: crew squad, or sum of the mounted parts of a mech */
export function unitHp(u) {
  if (!u.isMech) return [u.hp, u.maxHp];
  return Object.values(u.parts).reduce((a, p) => [a[0] + p.hp, a[1] + p.maxHp], [0, 0]);
}

export const bar = (value, max, color = null) => {
  const ratio = max ? Math.max(0, value / max) : 1;
  return `<span class="hud-bar"><i style="width:${ratio * PERCENT}%;background:${color ?? hpColor(ratio)}"></i></span>`;
};

/** Display name of a mech part key (legs, torso, leftArm, rightArm) */
export const partLabel = (key) => t(`part.${key}`);

/** Name of a part lying on the ground: arm side, kind, set and faction */
export function wreckInfo(wreck) {
  const part = wreck.part;
  return {
    // Arms without a side: a picked-up arm goes to whichever slot is free
    name: partLabel(part.isArm ? 'arm' : part.stats.kind ?? part.key),
    set: part.set,
    race: part.stats.race ? raceName(part.stats.race) : '–',
    hp: Math.ceil(part.hp),
    maxHp: part.maxHp,
    isArm: part.isArm,
  };
}

/** Text icon of a unit for group lists and the production queue */
export const unitIcon = (u) => (u.isMech ? '🤖' : u.isVehicle ? (u.canAttack ? '🛻' : '🚚') : u.isStructure ? '🏗' : '👥');

// ---------- HUD v2 panels (RobotPanel / CenterPanel) ----------

const PERCENT = 100;
const BONUS_KEYS = ['damage', 'attackSpeed', 'moveSpeed', 'accuracy', 'evasion', 'boardSpeed'];
export const VEHICLE_BONUS_KEYS = BONUS_KEYS.filter((k) => k !== 'boardSpeed'); // vehicles have no crew to board

/** Thin bar of the v2 panels (styles in selection-panel.css) */
export const slimBar = (value, max, color = null) => {
  const ratio = max ? Math.min(1, Math.max(0, value / max)) : 1;
  return `<span class="sp-bar"><i style="width:${ratio * PERCENT}%;background:${color ?? hpColor(ratio)}"></i></span>`;
};

/** Whole percent of a ratio */
export const pct = (ratio) => Math.round(Math.max(0, ratio) * PERCENT);

/** Colour of a HP value as the share of its maximum */
export const hpColorOf = (hp, maxHp) => hpColor(maxHp > 0 ? hp / maxHp : null);

/** "+10 % damage · +10 % attack speed" for a rank's bonuses ('' = none) */
export function bonusText(b = {}, keys = BONUS_KEYS, short = false) {
  const prefix = short ? 'bonusShort' : 'bonus';
  return keys.filter((k) => b[k]).map((k) => `+${Math.round(b[k] * PERCENT)} % ${t(`${prefix}.${k}`)}`).join(' · ');
}

/** Plain text of a small HTML snippet built by the panels (tags dropped, entities decoded) – for tooltips */
export const plainText = (html) => String(html).replace(/<[^>]*>/g, '').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

/** Damage of one shot (physical + energy) from a weapon's damage field */
export const damageOf = (d) => (typeof d === 'number' ? d : (d?.physical ?? 0) + (d?.energy ?? 0));

/** Damage per second of one weapon ({ stats | def }): damage per shot / longer of attack time and cooldown (0 = unknown) */
export function weaponDps(w) {
  const s = w.stats ?? w.def ?? {};
  const cycle = Math.max(s.cooldown ?? 0, s.attackTime ?? 0);
  return cycle > 0 ? damageOf(s.damage) / cycle : 0;
}

/** Longest weapon range of a unit (0 = unarmed) */
export const maxRange = (weapons = []) => Math.max(0, ...weapons.map((w) => (w.stats ?? w.def)?.range ?? 0));

/** "fist 0.6s" / "fist ✓" for weapons with their cooldown state */
export function weaponState(w) {
  const id = w.def?.id ?? w.stats?.id ?? '?';
  return w.cooldown > 0 ? `${id} ${w.cooldown.toFixed(1)}s` : `${id} ✓`;
}

/** Current activity of a mech as text */
export function mechState(mech) {
  const o = mech.order;
  if (mech.bay) return t('service.inBayMech');
  if (mech.repairing) return t('state.repairing');
  if (!mech.crew) return t('state.inactive');
  if (!mech.active) return t('state.boarding');
  if (!o) return t('state.idle');
  if (o.type === 'attack') return t('state.attacking', { target: o.target?.name ?? '' });
  if (o.type === 'collect') return t('state.collecting');
  if (o.type === 'enterBay') return t(o.waiting ? 'state.bayWaiting' : 'state.enteringBay');
  if (o.type === 'attackMove' || o.type === 'guard' || o.type === 'patrol') return t(`state.${o.type}`);
  return t('state.moving');
}

const teamName = (team) => (TEAMS[team]?.nameKey ? t(TEAMS[team].nameKey) : t('sel.enemy'));

/** [N5b] Owner note next to a name (HTML): nothing for own units, "(ally – team)" for an ally, "(team)" as an enemy */
export function teamTag(unit) {
  if (isLocal(unit)) return '';
  if (areAllies(localTeam(), unit.team)) return ` <span class="ally">(${esc(t('sel.ally'))} – ${esc(teamName(unit.team))})</span>`;
  return ` <span class="warn">(${esc(teamName(unit.team))})</span>`;
}
