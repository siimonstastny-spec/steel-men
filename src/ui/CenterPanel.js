// Steel Mans – HUD v2 centre panel (bottom centre, everything except one mech): a group (every member listed with its
// HP %), or the details of a single combat vehicle / crew / economy vehicle / building / wreck.
// Artwork center_panel_left + mid (tiled) + right; the width follows the content. Layout numbers: config.js HUD_PANELS.center,
// styles selection-panel.css. Pure view: html(...) returns markup, onPointer(e) handles a click on a group member.
import { HUD, HUD_PANELS } from '../config.js';
import { t } from '../i18n/i18n.js';
import { canGather } from '../game/Production.js';
import { unitName, incomeText, storageText } from './BuildMenu.js';
import { serviceState } from './RobotProduction.js';
import { ITEM_ICONS, itemLabel, isWaitingEnergy, progressOf } from './ProductionQueue.js';
import {
  esc, unitHp, unitIcon, hpColorOf, slimBar, pct, bonusText, VEHICLE_BONUS_KEYS, weaponDps, weaponState, maxRange,
  damageOf, teamTag, wreckInfo,
} from './hudUtil.js';

const C = HUD_PANELS.center;
const SEP = ' · ';
const GROUP_ROWS = Math.max(1, Math.floor((C.height - C.margins.top - C.margins.bottom - C.headerHeight) / (C.memberHeight + C.memberGap)));
const DECIMALS = 1;
const RATE_DECIMALS = 2;
const ENERGY_DECIMALS = 2;

/** Display name of any unit: mechs / crews have a name, vehicles and buildings their type name */
export const unitLabel = (u) => (!u ? '' : u.isVehicle || u.isStructure
  ? unitName(u.isStructure ? 'structures' : 'vehicles', u.unitId) : u.name ?? '');

/** Sort rank by type: mechs first, then crews, armed vehicles, other vehicles, buildings */
const kindRank = (u) => (u.isMech ? 0 : u.isVehicle ? (u.canAttack ? 2 : 3) : u.isStructure ? 4 : 1);

const GEOMETRY = `--cp-h:${C.height};--cp-left:${C.left};--cp-mid:${C.mid};--cp-right:${C.right};--cp-min-inner:${C.minInnerWidth};`
  + `--cp-mt:${C.margins.top};--cp-mr:${C.margins.right};--cp-mb:${C.margins.bottom};--cp-ml:${C.margins.left};`
  + `--cp-head:${C.headerHeight};--cp-rows:${GROUP_ROWS};--cp-min-font:${HUD_PANELS.robot.minFontPx}px;`;

const frame = (inner, style = '') => `<div class="cp" style="${GEOMETRY}${style}">`
  + `<i class="cp-l"></i><i class="cp-m"></i><i class="cp-r"></i><div class="cp-inner" data-scroll-key="cp-inner">${inner}</div></div>`;

const hpValue = (hp, max) => `${Math.ceil(hp)}/${max}${SEP}${pct(max ? hp / max : 0)} % ${slimBar(hp, max)}`;
const xpValue = (u) => {
  const r = u.rank;
  return `${esc(r.name)} ${slimBar(u.xp, r.next ?? r.xp, 'var(--hud-accent)')} ${Math.floor(u.xp)}${r.next ? `/${r.next}` : ''} XP`;
};

export class CenterPanel {
  /** @param {object} deps { input } – CommandInput (selection, select, setSelection) */
  constructor({ input, world }) {
    this.input = input;
    this.world = world;
  }

  /** Click on a group member: select only it, Shift = remove it from the selection (as before) */
  onPointer(e) {
    const id = e.target.closest?.('[data-unit]')?.dataset.unit;
    if (id === undefined) return false;
    e.preventDefault();
    const unit = this.input.selection.find((u) => u.eid === Number(id)); // by entity id: the selection may change between refreshes
    if (!unit) return true;
    if (e.shiftKey) this.input.setSelection(this.input.selection.filter((u) => u !== unit));
    else this.input.select(unit);
    return true;
  }

  /** Markup for the current selection (units) or a selected wreck */
  html(units, wreck) {
    if (units.length > 1) return this.#group(units);
    if (units.length === 1) return this.#single(units[0]);
    return wreck ? this.#wreck(wreck) : '';
  }

  // ---------- group ----------

  #group(units) {
    const order = units.map((u, i) => i).sort((a, b) => {
      const ua = units[a];
      const ub = units[b];
      return kindRank(ua) - kindRank(ub) || String(ua.unitId ?? '').localeCompare(String(ub.unitId ?? '')) || a - b;
    });
    const cells = order.map((i) => {
      const u = units[i];
      const [hp, max] = unitHp(u);
      const ratio = max ? hp / max : 0;
      return `<button class="cp-unit" data-unit="${u.eid}" title="${esc(unitLabel(u))}"><span class="ico">${unitIcon(u)}</span>`
        + `<span class="pct" style="color:${hpColorOf(hp, max)}">${pct(ratio)}%</span></button>`;
    }).join('');
    const vars = `--cp-cw:${C.memberWidth};--cp-ch:${C.memberHeight};--cp-gap:${C.memberGap}`;
    return frame(`<div class="cp-title">${esc(t('sel.count', { count: units.length }))}</div><div class="cp-group">${cells}</div>`, vars);
  }

  // ---------- single unit ----------

  #single(u) {
    const [state, rows] = u.isStructure ? this.#structure(u) : u.isVehicle ? this.#vehicle(u) : this.#crew(u);
    return this.#sheet(`${esc(unitLabel(u))}${teamTag(u)} – ${esc(state)}`, rows);
  }

  #sheet(title, rows) {
    const cells = rows.map(([label, value]) => `<div class="cp-row"><span class="cp-k">${esc(label)}</span><span class="cp-v">${value}</span></div>`).join('');
    return frame(`<div class="cp-title">${title}</div><div class="cp-stats" style="--cp-stat-rows:${C.statRows}">${cells}</div>`);
  }

  /** Rows shared by every armed unit: damage, DPS, range, weapons with cooldown */
  #weaponRows(weapons, rows) {
    if (!weapons?.length) return;
    const damage = weapons.reduce((a, w) => a + damageOf((w.stats ?? w.def)?.damage), 0);
    const dps = weapons.reduce((a, w) => a + weaponDps(w), 0);
    rows.push([t('cp.damage'), String(Math.round(damage))], [t('cp.dps'), dps.toFixed(DECIMALS)],
      [t('cp.range'), String(Math.round(maxRange(weapons)))], [t('cp.weapons'), esc(weapons.map(weaponState).join(SEP))]);
  }

  #armorRow(u, rows) {
    const a = u.stats?.armor;
    if (a) rows.push([t('cp.armor'), `${a.physical ?? 0} / ${a.energy ?? 0}`]);
  }

  #crew(c) {
    const type = c.order?.type;
    const state = type === 'board' ? t('state.crewBoard') : type === 'flee' ? t('state.crewFlee')
      : type ? t('state.moving') : t('state.crewWaiting');
    const rows = [[t('cp.hp'), hpValue(c.hp, c.maxHp)], [t('cp.members'), esc(t('unit.members', { size: c.size, supply: c.supply }))]];
    if (c.rank) rows.push([t('cp.rank'), xpValue(c)], [t('cp.bonuses'), esc(bonusText(c.rank.bonuses) || t('unit.noBonus'))]);
    this.#armorRow(c, rows);
    rows.push([t('cp.speed'), `${c.speed.toFixed(DECIMALS)} / ${(c.stats?.mobility?.moveSpeed ?? 0).toFixed(DECIMALS)}`]);
    this.#weaponRows(c.weapons, rows);
    return [state, rows];
  }

  #vehicle(u) {
    const o = u.order;
    let state = u.activity ? t(`vehicle.${u.activity}`) : o ? t('state.moving') : t('state.idle');
    if (u.canAttack) {
      if (o?.type === 'attack') state = t('state.attacking', { target: unitLabel(o.target) });
      else if (o?.type === 'attackMove' || o?.type === 'guard' || o?.type === 'patrol') state = t(`state.${o.type}`);
    }
    const rows = [[t('cp.hp'), hpValue(u.hp, u.maxHp)]];
    this.#armorRow(u, rows);
    rows.push([t('cp.speed'), `${u.speed.toFixed(DECIMALS)} / ${(u.stats?.mobility?.moveSpeed ?? 0).toFixed(DECIMALS)}`]);
    if (u.canAttack) {
      this.#weaponRows(u.weapons, rows);
      if (u.rank) rows.push([t('cp.rank'), xpValue(u)], [t('cp.bonuses'), esc(bonusText(u.rank.bonuses, VEHICLE_BONUS_KEYS) || t('unit.noBonus'))]);
    }
    if (o?.type === 'harvest' && o.deposit) {
      const d = o.deposit;
      rows.push([t('cp.deposit'), esc(t('deposit.left', { amount: d.infinite ? '∞' : Math.floor(d.amount) }))]);
    }
    if (o?.type === 'repair' && o.target) {
      const [hp, max] = unitHp(o.target);
      rows.push([t('cp.repairTarget'), `${esc(unitLabel(o.target))} ${slimBar(hp, max)}`]);
    }
    if (o?.type === 'build' && o.structure && !o.structure.complete) {
      rows.push([t('structure.progress'), `${slimBar(o.structure.progress, 1, 'var(--hud-accent)')} ${pct(o.structure.progress)} %`]);
    }
    if (u.supply) rows.push([t('hud.population'), String(u.supply)]);
    return [state, rows];
  }

  #structure(u) {
    let state = u.complete ? t('structure.ready') : u.buildRate > 0 ? t('structure.building') : t('structure.paused');
    if (u.complete && u.powered === false) state = t('structure.noPower');
    const rows = [[t('cp.hp'), hpValue(u.hp, u.maxHp)]];
    this.#armorRow(u, rows);
    if (u.service) { // assembly bay servicing a mech (Repair.js)
      state = t('service.inBay', { name: u.service.mech.name });
      rows.push([t('cp.service'), esc(serviceState(u.service))]);
    }
    if (!u.complete) {
      const rate = u.buildRate ?? 0;
      rows.push([t('structure.progress'), `${slimBar(u.progress, 1, 'var(--hud-accent)')} ${pct(u.progress)} %`]);
      rows.push([t('structure.builders'), `<span class="${rate <= 0 ? 'warn' : ''}">${u.builders?.size ?? 0} (×${rate.toFixed(RATE_DECIMALS)})</span>`]);
    } else {
      rows.push([t('cp.power'), u.powered === false ? `<span class="warn">${esc(t('cp.powerOff'))}</span>` : esc(t('cp.powerOn'))]);
      const st = u.stats ?? {};
      if (st.energyUse) rows.push([t('cp.energyUse'), String(+st.energyUse.toFixed(ENERGY_DECIMALS))]);
      // What the building gives (formerly the summary of the option grid panel): population, income, storage
      if (st.supplyProvided) rows.push([t('hud.population'), `+${st.supplyProvided}`]);
      if (st.income) rows.push([t('structure.incomeLabel'), esc(incomeText(st.income))]);
      if (st.storage) rows.push([t('structure.storageLabel'), esc(storageText(st.storage))]);
      const prod = this.world?.production;
      if (prod?.unitOptions(u).length) {
        rows.push([t('hud.queue.title'), this.#queueRow(prod.itemsOf(u.eid))]);
        if (canGather(u)) rows.push([t('rally.title'), esc(u.rally?.length ? t('rally.points', { n: u.rally.length }) : t('rally.hint'))]);
      }
      this.#weaponRows(u.weapons, rows);
    }
    return [state, rows];
  }

  /** [W3] Production of a building: only the running item (name, progress, energy wait), the rest as small icons in a row */
  #queueRow(items) {
    if (!items.length) return esc(`0 / ${HUD.production.maxQueue}`);
    const head = items[0];
    const waiting = isWaitingEnergy(head, this.world?.economy);
    let html = `<span class="cp-qhead">${esc(ITEM_ICONS[head.kind] ?? '')} ${esc(itemLabel(head, this.world))} `
      + `${slimBar(head.elapsed, head.total, 'var(--hud-accent)')} ${pct(progressOf(head))} %</span>`;
    if (waiting) html += ` <span class="warn">${esc(t('econ.waitingEnergy'))}</span>`;
    if (items.length > 1) {
      html += '<span class="cp-qrest">';
      for (let i = 1; i < items.length; i++) html += `<i title="${esc(itemLabel(items[i], this.world))}">${esc(ITEM_ICONS[items[i].kind] ?? '')}</i>`;
      html += '</span>';
    }
    return html;
  }

  #wreck(wreck) {
    const w = wreckInfo(wreck);
    const rows = [[t('cp.set'), esc(`${w.set} (${w.race})`)], [t('cp.hp'), hpValue(w.hp, w.maxHp)],
      [t('cp.hint'), esc(t(w.isArm ? 'wreck.pickup' : 'wreck.salvage'))]];
    return this.#sheet(esc(t('wreck.title', { part: w.name })), rows);
  }

  dispose() {
    this.input = null;
  }
}
