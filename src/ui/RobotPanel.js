// Steel Mans – HUD v2 robot panel (bottom centre, exactly one mech selected): artwork robot-panel.png with
//   left column (arm / arm / crew boxes + EJECT buttons), hologram (5 masks tinted by --hud-neon, a missing part = no mask),
//   right labels (crew, torso, right arm, left arm, legs). Layout numbers: config.js HUD_PANELS.robot, styles selection-panel.css.
// Pure view: html(mech) returns the markup, onPointer(e) handles the EJECT buttons through the input command path.
import { HUD_PANELS, TEAMS } from '../config.js';
import { isLocal } from '../core/LocalPlayer.js';
import { t } from '../i18n/i18n.js';
import { avatarHtml } from './Avatar.js';
import { pilotSlot } from '../units/ModularMech.js';
import { esc, partLabel, mechState, teamTag, bonusText, weaponState, slimBar, pct, plainText } from './hudUtil.js';

const R = HUD_PANELS.robot;
// Panel side (pilot's view) -> input command (CommandInput maps dropLeft -> the pilot's left hand = slot rightArm)
const DROP_COMMAND = { leftArm: 'dropLeft', rightArm: 'dropRight' };
const SEP = ' · ';
const NO_RANK = Object.freeze({ name: '', bonuses: {}, next: null });
const HASH_MUL = 31;

const rect = (r) => `--x:${r.x};--y:${r.y};--w:${r.w};--h:${r.h}`;
/** Box stretching with the panel: left edge x, right edge `right` image px from the panel's right edge */
const rectLR = (r) => `--x:${r.x};--y:${r.y};--r:${r.right};--h:${r.h}`;
// Panel entries are named by the PILOT's side (left = the robot's left hand, as drawn in the schematic);
// pilotSlot() gives the mech slot that physically sits there (slot names follow the model files, see ModularMech.js)
const present = (mech, slot) => (slot === 'crew' ? !!mech.crew : !!mech.parts[pilotSlot(slot)]?.alive);
const hashCache = new Map(); // crew name -> avatar hash (names repeat, the panel re-renders every refresh)
function nameHash(s) {
  let h = hashCache.get(s);
  if (h === undefined) {
    h = 0;
    for (let i = 0; i < s.length; i++) h = (h * HASH_MUL + s.charCodeAt(i)) >>> 0;
    hashCache.set(s, h);
  }
  return h;
}

export class RobotPanel {
  /** @param {object} deps { input } – CommandInput (command(name), commands) */
  constructor({ input }) {
    this.input = input;
  }

  /** Handles a left click inside the panel; true = consumed (an EJECT button) */
  onPointer(e) {
    const btn = e.target.closest?.('[data-eject]');
    if (!btn) return false;
    e.preventDefault();
    if (!btn.disabled) this.input.command(btn.dataset.eject);
    return true;
  }

  /** Markup of the whole panel for a mech */
  html(mech) {
    const own = isLocal(mech);
    const cmds = own ? this.input.commands : null;
    const base = R.displayHeight / R.image.h;
    const im = R.image;
    const root = `--rp-h:${im.h};--rp-left:${im.left};--rp-mid:${im.mid};--rp-right:${im.right};--rp-min:${im.minWidth};`
      + `--rp-base:${base};--rp-min-font:${R.minFontPx}px`;
    const dir = HUD_PANELS.imageDir;
    const masks = Object.values(R.masks).filter((m) => present(mech, m.present)).map((m) => {
      const url = `url(${HUD_PANELS.imageDir}${m.file})`;
      return `<div class="rp-mask" style="${rect(m)};mask-image:${url};-webkit-mask-image:${url}"></div>`;
    }).join('');
    const column = R.column.map((c) => this.#columnRow(mech, c, own, cmds)).join('');
    const state = mechState(mech);
    const labels = R.labels.map((l) => this.#label(mech, l, state)).join('');
    return `<div class="rp" style="${root}"><img class="rp-bg rp-bg-l" src="${dir}${R.pieces.left}" alt="" draggable="false">`
      + `<i class="rp-bg rp-bg-m" style="background-image:url(${dir}${R.pieces.mid})"></i>`
      + `<img class="rp-bg rp-bg-r" src="${dir}${R.pieces.right}" alt="" draggable="false">`
      + `${masks}`
      + `<div class="rp-title" style="${rect(R.titleSlot)}" title="${esc(`${mech.name} – ${state}`)}">`
      + `<b>${esc(mech.name)}${teamTag(mech)}</b></div>`
      + `${column}${labels}</div>`;
  }

  // ---------- left column ----------

  #columnRow(mech, c, own, cmds) {
    const isCrew = c.slot === 'crew';
    const ok = present(mech, c.slot);
    let icon;
    if (!ok) icon = `<span class="rp-glyph muted">${R.glyphs.empty}</span>`;
    else if (isCrew) {
      const index = nameHash(mech.crew.name) % HUD_PANELS.crewAvatarVariants;
      icon = avatarHtml({ name: mech.crew.name, avatar: index, color: TEAMS[mech.team]?.color, size: R.crewAvatarSize });
    } else {
      const w = mech.parts[pilotSlot(c.slot)].weapons[0];
      icon = `<span class="rp-glyph">${w?.def.class === 'melee' ? R.glyphs.melee : R.glyphs.ranged}</span>`;
    }
    const name = isCrew ? t('rp.crew') : partLabel(pilotSlot(c.slot)); // labels are by mech slot (i18n swapped), c.slot is the pilot side
    const weapon = !isCrew && ok ? mech.parts[pilotSlot(c.slot)].weapons.map((w) => w.def.id).join(SEP) : '';
    const eject = own
      ? `<button class="rp-eject" data-eject="${isCrew ? 'eject' : DROP_COMMAND[c.slot]}" style="${rect({ ...c.ejectSlot, y: c.ejectSlot.y - R.ejectGrow, h: c.ejectSlot.h + R.ejectGrow })}"`
        + `${ok && cmds[isCrew ? 'eject' : DROP_COMMAND[c.slot]] ? '' : ' disabled'}>${esc(t('rp.eject'))}</button>`
      : '';
    return `<div class="rp-icon${ok ? '' : ' missing'}" style="${rect(c.iconBox)}">${icon}</div>`
      + `<div class="rp-name${ok ? '' : ' muted'}" style="${rect(c.nameSlot)}">${esc(name)}${weapon ? ` <small class="muted">${esc(weapon)}</small>` : ''}</div>`
      + eject;
  }

  // ---------- right labels ----------

  #label(mech, l, state) {
    const header = l.slot === 'crew' ? t('rp.crew') : partLabel(pilotSlot(l.slot));
    const [line1, line2, tip] = l.slot === 'crew' ? this.#crewLines(mech) : this.#partLines(mech, l.slot);
    // Tooltip: armor (parts) and the full text of both lines – long lines are cut with an ellipsis
    const full = [tip, plainText(line1), plainText(line2)].filter(Boolean).join('\n');
    // The mech's state (standing / attacking X / boarding…) sits right-aligned in the crew box header, where there is room
    const stateHtml = l.slot === 'crew' ? `<span class="rp-state" title="${esc(state)}">${esc(state)}</span>` : '';
    return `<div class="rp-lhead" style="${rectLR(l.header)}"><span class="rp-hname">${esc(header)}</span>${stateHtml}</div>`
      + `<div class="rp-lbody" style="${rectLR(l.body)}"${full ? ` title="${esc(full)}"` : ''}>`
      + `<div class="rp-line">${line1}</div><div class="rp-line">${line2}</div></div>`;
  }

  #crewLines(mech) {
    const c = mech.crew;
    if (!c) return [`<span class="warn">${esc(t('unit.noCrew'))}</span>`, '', ''];
    const r = c.rank ?? NO_RANK; // rank is null until the squad finished loading
    const bonusFull = bonusText(r.bonuses) || t('unit.noBonus');
    const bonus = bonusText(r.bonuses, undefined, true) || t('unit.noBonus');
    const xp = `${Math.floor(c.xp)}${r.next ? `/${r.next}` : ''} XP`;
    return [
      esc([c.name, r.name, t('rp.members', { size: c.size })].join(SEP)),
      `${esc(xp)}${SEP}<span class="bonus" title="${esc(bonusFull)}"><span class="b-full">${esc(bonusFull)}</span>`
        + `<span class="b-short">${esc(bonus)}</span></span>`,
      bonusFull,
    ];
  }

  #partLines(mech, slot) {
    const p = mech.parts[pilotSlot(slot)];
    if (!p) return [`<span class="muted">${esc(t('part.missing'))}</span>`, '', ''];
    const armor = p.stats.armor ?? {};
    const tip = t('part.armor', { physical: armor.physical ?? 0, energy: armor.energy ?? 0 });
    const hp = `${esc(p.set)}${SEP}${Math.ceil(p.hp)}/${p.maxHp}${SEP}${pct(p.maxHp ? p.hp / p.maxHp : 0)} %`
      + ` ${slimBar(p.hp, p.maxHp)}`;
    return [hp, this.#detail(mech, slot, p), tip];
  }

  /** Second line of a part label: speed / load, weapon state, ability / stance */
  #detail(mech, slot, p) {
    const s = mech.stats;
    if (slot === 'torso') {
      if (!s) return '–';
      return `${esc(t('unit.speed', { speed: mech.speed.toFixed(1), max: s.mobility.moveSpeed.toFixed(1) }))}${SEP}`
        + `<span class="${s.overloaded ? 'warn' : ''}">${esc(t('unit.load', { load: `${s.carriedMass}/${s.loadCapacity}` }))}</span>`;
    }
    if (slot === 'legs') {
      const parts = [];
      if (mech.flightAbility) {
        const wait = Math.ceil(mech.flightCooldown);
        parts.push(t(wait > 0 ? 'hud.flightCooldown' : 'hud.flightReady', { value: wait }));
      }
      if (mech.hopAbility) parts.push(t('ability.hopRun'));
      if (mech.hasMixedWeapons) parts.push(t('unit.stance', { stance: t(mech.stance === 'melee' ? 'cmd.stanceMelee' : 'cmd.stanceRanged') }));
      return esc(parts.join(SEP) || '–');
    }
    // arm: weapons with cooldown
    return esc(p.weapons.map(weaponState).join(SEP) || '–');
  }

  dispose() {
    this.input = null;
  }
}
