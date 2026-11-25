// Steel Men – option grid page of a research facility (BuildMenu shows it for a finished, selected own
// building with stats.produces 'research'):
//   • one tab per research tier: the research the faction may do there (Research.available), with cost, time,
//     effect, done / running / locked and why; a click pays the cost and queues it in the building's queue
//   • "salvage analysis" tab: captured parts brought to the facility (Research.analyses); analysing one
//     unlocks production of that part kind, the part itself is kept
// A pure view: clicks submit 'queueResearch' / 'queueAnalysis' (BuildMenu.submit); paying, the queue and
// completion live in world.production. A destroyed facility cancels its queue with a refund (Production.update);
// finished research stays.
import { HUD, RESEARCH, TEAMS } from '../config.js';
import { t } from '../i18n/i18n.js';
import { unitName } from './BuildMenu.js';
import { unitIconUrl } from './IconRenderer.js';

/** [A9-F4a] Tab label of a tier: a tier may have its own name (i18n research.tier<N>, e.g. the super tier), else "Tier N" */
function tierLabel(tier) {
  const own = t(`research.tier${tier}`);
  return own === `research.tier${tier}` ? t('research.tier', { tier }) : own;
}

const TIME_DECIMALS = 1;

/** Display name of a research id: i18n research.<id>, else stats name, else the id */
export function researchName(id, def = {}) {
  const key = `research.${id}`;
  const text = t(key);
  return text === key ? (def.name ?? id) : text;
}

export class ResearchView {
  /**
   * @param {object} deps  buildMenu (submit, producer ids, team of the local player), research (Research, optional:
   *                       defaults to world.research)
   */
  constructor({ buildMenu, research = null }) {
    this.buildMenu = buildMenu;
    this.fallbackResearch = research;
    this.tab = null; // tier number or RESEARCH.analysisTab
  }

  get research() { return this.buildMenu.world.research ?? this.fallbackResearch; }
  get team() { return this.buildMenu.team; }
  /** world.production (read only here) */
  get queue() { return this.buildMenu.production; }

  view(structure, title) {
    const tiers = this.research.tiers();
    this.tab ??= tiers[0] ?? RESEARCH.analysisTab;
    const producer = this.buildMenu.producerId(structure);
    const analysis = this.tab === RESEARCH.analysisTab;
    const items = analysis ? this.#analysisItems(structure, producer) : this.#researchItems(structure, producer, this.tab);
    const summary = analysis ? this.#analysisSummary(items) : this.#tierSummary(this.tab, items);
    summary.push({ label: t('hud.queue.title'), value: `${this.queue.itemsOf(producer).length} / ${HUD.production.maxQueue}` });
    const lootCount = this.research.analyses(this.team).length;
    const tabs = [
      ...tiers.map((tier) => ({ label: tierLabel(tier), on: this.tab === tier, onClick: () => this.#select(tier) })),
      { label: t('research.analysis.tab', { n: lootCount }), on: analysis, onClick: () => this.#select(RESEARCH.analysisTab) },
    ];
    return { title, items, tabs, summary };
  }

  #select(tab) { this.tab = tab; this.buildMenu.hud.refresh?.(); }

  // ---------- research ----------

  #researchItems(structure, producer, tier) {
    const r = this.research;
    const defs = r.defs;
    const full = this.queue.isFull(producer);
    return r.available(this.team)
      .filter((id) => defs[id].tier === tier && this.#researchedHere(defs[id], structure))
      .map((id) => {
        const def = defs[id];
        const name = researchName(id, def);
        const st = r.status(this.team, id);
        const done = st.reason === 'done';
        const time = r.timeOf(this.team, id);
        const why = done ? t('research.done') : st.reason === 'active' ? t('research.active') : this.#lockText(st, id);
        const tip = [
          name, this.#description(id),
          t('grid.cost', { ore: def.cost?.ore ?? 0, energy: def.cost?.energy ?? 0 }),
          t('grid.time', { time: +time.toFixed(TIME_DECIMALS) }),
          this.#unlockText(id),
          r.hasPendingEffects(id) ? t('research.pending') : '',
          why, !st.ok || !full ? '' : t('hud.queue.full', { max: HUD.production.maxQueue }),
        ].filter(Boolean).join('\n');
        return {
          icon: done ? RESEARCH.doneIcon : st.reason === 'tier' ? RESEARCH.lockedIcon : name.slice(0, RESEARCH.iconLetters),
          label: r.hasPendingEffects(id) ? `${name} *` : name,
          on: done, pending: st.reason === 'active', disabled: !st.ok || full, tip,
          onClick: () => this.#queueResearch(structure, id),
        };
      });
  }

  #researchedHere(def, structure) {
    return !def.researchedAt || [].concat(def.researchedAt).includes(structure.unitId);
  }

  #description(id) {
    const key = `research.${id}.desc`;
    const text = t(key);
    return text === key ? (this.research.defs[id]?.description ?? '') : text;
  }

  #unlockText(id) {
    const list = this.research.unlocksOf(id).map((u) => (u.sub ? `${u.id} (${t(`research.kind.${u.sub}`)})` : unitName(u.group, u.id)));
    return list.length ? t('research.unlocks', { list: list.join(', ') }) : '';
  }

  #lockText(st, id) {
    if (st.reason === 'tier') return st.tier.missing.map((m) => this.#missingText(m)).join('\n');
    if (st.reason === 'disabled') return t('research.disabled'); // [A9-F4a] superweapons off in this match
    if (st.reason === 'research') {
      const defs = this.research.defs;
      const lines = [];
      const all = this.research.missingResearch(this.team, id);
      if (all.length) lines.push(t('research.needResearch', { list: all.map((r) => researchName(r, defs[r])).join(', ') }));
      const any = this.research.missingAnyResearch(this.team, id); // [A9-F4a] one of the list is enough
      if (any.length) lines.push(t('research.anyOf', { list: any.map((r) => researchName(r, defs[r])).join(', ') }));
      return lines.join('\n');
    }
    return '';
  }

  #missingText(m) {
    if (m.type === 'structure') return t('research.needStructure', { name: unitName('structures', m.id) });
    if (m.type === 'flag') return t('research.missingFlag'); // [A9-F4a] e.g. a superweapon program
    if (m.type === 'option') return t('research.disabled'); // [A9-F4a] match option off
    return t('research.needCompleted', { tier: m.tier, count: m.count, have: m.have });
  }

  /** [A9-F4a] Data network line of the tier summary: who the team shares research with (only for network members) */
  #networkRow() {
    const net = this.research.networkStatus?.(this.team);
    if (!net?.member) return null;
    const names = net.partners.map((p) => t('lobby.seat', { n: p + 1 }));
    return { label: t('research.network', { list: net.node && names.length ? names.join(', ') : '–' }), value: String(net.sharedIds.length) };
  }

  #tierSummary(tier, items) {
    const status = this.research.tierStatus(this.team, tier);
    const rows = [{ label: t('research.tier', { tier }), value: status.open ? t('research.open') : t('research.locked'), warn: !status.open }];
    for (const m of status.missing) rows.push({ label: this.#missingText(m), value: '', warn: true });
    rows.push({ label: t('research.completed'), value: this.research.doneInTier(this.team, tier) });
    const net = this.#networkRow();
    if (net) rows.push(net);
    if (!items.length) rows.push({ label: t('research.empty'), value: '' });
    if (items.some((it) => it.label.endsWith(' *'))) rows.push({ label: t('research.pendingMark'), value: '' });
    return rows;
  }

  #queueResearch(structure, id) {
    this.buildMenu.submit({ type: 'queueResearch', producer: structure.eid, researchId: id });
  }

  // ---------- salvage analysis ----------

  #analysisLabel(loot) {
    if (loot.kind === 'vehicle') return t('analysis.vehicle', { name: unitName('vehicles', loot.vehicle) }); // [A9-F4a]
    return t('research.analysis', { set: loot.set, kind: t(`research.kind.${loot.kind}`) });
  }

  #analysisItems(structure, producer) {
    const full = this.queue.isFull(producer);
    return this.research.analyses(this.team).map((loot) => {
      const { cost, buildTime } = this.research.analysisStats(this.team, loot);
      const active = this.research.isActive(this.team, loot.key);
      const label = this.#analysisLabel(loot);
      const iconUrl = loot.kind === 'vehicle'
        ? unitIconUrl(loot.vehicle, this.buildMenu.race, TEAMS[this.team]?.color) ?? undefined : undefined; // [A9-F4a] vehicle wreck icon
      return {
        icon: RESEARCH.analysisIcon, iconUrl, label, pending: active, disabled: active || full,
        tip: [label, t('research.analysis.tip'), t('grid.cost', { ore: cost.ore ?? 0, energy: cost.energy ?? 0 }),
          t('grid.time', { time: +buildTime.toFixed(TIME_DECIMALS) }), active ? t('research.active') : ''].filter(Boolean).join('\n'),
        onClick: () => this.#queueAnalysis(structure, loot),
      };
    });
  }

  #analysisSummary(items) {
    // The hint explains why a delivered part may be missing: only parts the faction cannot produce yet are analysed
    const hint = { label: t('research.analysis.hint'), value: '' };
    return items.length ? [hint] : [{ label: t('research.analysis.none'), value: '' }, hint];
  }

  #queueAnalysis(structure, loot) {
    this.buildMenu.submit({ type: 'queueAnalysis', producer: structure.eid, lootKey: loot.key });
  }
}
