// Steel Men – economy pages of the option grid (left), a pure view of the simulation for the local player:
//   • selected own builder vehicle (construct ability) → buildings the faction may build (canProduce
//     'structures', buildable, requires) → placement preview (Construction.PlacementGhost)
//   • selected own building under construction → progress, builders, "cancel construction" (partial refund)
//   • selected own finished building → what it produces (stats.produces: 'crew' / 'vehicle') with its own queue;
//     robot parts ('part') and mech assembly ('mech') have their own pages in RobotProduction.js
// Production (queues, paying, population, build time, spawning, refunds) lives in world.production
// (src/game/Production.js); buttons only submit commands (src/game/commands/productionCommands.js) after
// world.production.check(cmd) – a refusal is shown as a message. Hud.js asks view() first and falls back to its
// own pages when it returns null.
import { getBuildingIconUrl, unitIconUrl } from './IconRenderer.js';
import { TEAMS, HUD, ECONOMY,ECONOMY_ALERTS, KEYBINDINGS, BUILD_GRID, RALLY, BEHAVIOUR, SHIFT_BATCH, SOUND_HOOKS } from '../config.js';
import { play } from '../audio/Sound.js';
import { keyLabel } from '../input/CommandInput.js';
import { getStats, unitStats, canProduce, superweaponLimit } from '../data/Stats.js';
import { t } from '../i18n/i18n.js';
import { createPlacement, wallTip } from '../game/Walls.js'; // walls / turrets have their own placement
import { localTeam } from '../core/LocalPlayer.js';
import { snapYaw } from '../units/Structure.js';
import { commandBus } from '../game/commands/CommandBus.js';
import '../game/commands/productionCommands.js'; // registers the production commands
import { REASON, canGather } from '../game/Production.js';
import { formatAmount } from './formatAmount.js';

const ICONS = { structure: '🏗', vehicle: '🚚', crew: '👥', cancel: '✖' };
const PERCENT = 100;
const ICON_LETTERS = 3;      // letters of a building / vehicle name shown as its grid icon
const RATE_DECIMALS = 2;

/** Display name of a building / vehicle id (i18n, falls back to the id) */
export function unitName(group, id) {
  const key = `${group === 'structures' ? 'structure' : 'vehicle'}.${id}`;
  const text = t(key);
  return text === key ? id : text;
}

export class BuildMenu {
  /**
   * @param {object} deps
   *   world, input (CommandInput), hud (message),
   *   race, unlocks   – fallbacks before world.production exists (it knows every team's race / unlocks)
   *   placementYaw()  – rotation of new buildings (e.g. towards the map centre)
   * Old deps (queue, team, spawnVehicle, spawnCrew) are ignored: the team is localTeam(), spawning is in Production.
   */
  constructor({ world, input, hud, race, unlocks = null, placementYaw }) {
    Object.assign(this, { world, input, hud, placementYaw });
    this.fallbackRace = race;
    this.fallbackUnlocks = unlocks;
    this.messageTimer = 0;
    this.placing = null;        // { id, ghost } while a building is being placed
    this.placedYaw = null;      // rotation of the last placed building (the next placement starts with it)
    this.robotProduction = null; // part factory / assembly bay pages (RobotProduction, set by main.js)
    this.researchView = null;    // research facility page (ResearchView, set by main.js)
    this.ordering = new Map();   // building id -> constructions ordered but not on the map yet
  }

  /**
   * Why a building cannot be built now beyond requires / cost: the per-team limit (stats maxPerTeam, buildings
   * under construction count) or a research tier that is not open yet (stats requiresTier). '' = allowed.
   */
  limitText(id, stats) {
    // Finished, under construction, and ordered but not loaded yet (Shift placement)
    const own = this.world.structures.filter((s) => s.team === localTeam() && s.unitId === id && !s.destroyed).length
      + (this.ordering.get(id) ?? 0);
    if (stats.maxPerTeam && own >= stats.maxPerTeam) return t('build.limit', { max: stats.maxPerTeam });
    if (stats.superweapon) { // [A9-F4a] one superweapon per team in total, whatever its id (buildCommands.checkRules)
      const swOwn = this.world.structures.filter((s) => s.team === localTeam() && s.stats?.superweapon && !s.destroyed).length
        + [...this.ordering].reduce((n, [oid, c]) => n + (unitStats('structures', oid, this.race)?.superweapon ? c : 0), 0);
      if (swOwn >= superweaponLimit()) return t('build.superweaponLimit');
    }
    const research = this.world.research;
    if (stats.requiresTier && research && research.openTier(localTeam()) < stats.requiresTier) {
      return t('build.requiresTier', { tier: stats.requiresTier });
    }
    return '';
  }

  get economy() { return this.world.economy; }
  get production() { return this.world.production ?? null; }
  /** The local player (UI viewpoint only). Kept for RobotProduction / ResearchView; BuildMenu itself calls localTeam(). */
  get team() { return localTeam(); }
  get race() { return this.production?.raceOf(localTeam()) ?? this.fallbackRace; }
  get unlocks() { return this.production?.unlocksOf(localTeam()) ?? this.fallbackUnlocks; }

  // ---------- messages ----------

  /** Refusal notice in the HUD message line; [A6] with its sound (SOUND_HOOKS.refusalSound unless given) */
  notify(text, sound = SOUND_HOOKS.refusalSound) {
    if (sound) play(sound);
    this.hud.message(text);
    this.messageTimer = ECONOMY.messageTime;
  }

  #missingText(cost) {
    const miss = this.economy.missing(localTeam(), cost);
    return t('econ.notEnough', { missing: Object.entries(miss).map(([r, v]) => `${t(`hud.${r}`)} ${v}`).join(', ') });
  }

  #populationText() {
    return t('econ.noPopulation', { used: this.economy.populationUsed(localTeam()), cap: formatAmount(this.economy.populationCap(localTeam())) });
  }

  // ---------- commands ----------

  /**
   * Submits a production command of the local player (team is filled in). It is checked first
   * (world.production.check): a refusal shows why and nothing is sent. @returns {boolean} sent
   */
  submit(cmd) {
    const full = { ...cmd, team: localTeam() };
    const res = this.production?.check(full);
    if (!res) return false; // no running game
    if (!res.ok) { this.notifyRefusal(res); return false; }
    commandBus.submit(full);
    this.hud.refresh?.();
    return true;
  }

  /**
   * Shift + click: up to `count` copies of a paid production command, each an ordinary command (as if clicked
   * `count` times). Commands run on the next tick, so check() does not see the earlier copies – queue space, cost
   * and population are summed here. When a copy does not fit, the rest is dropped and the reason shown once.
   * @returns {number} commands sent
   */
  submitBatch(cmd, count = SHIFT_BATCH.count) {
    const full = { ...cmd, team: localTeam() };
    const first = this.production?.check(full);
    if (!first) return 0;
    if (!first.ok) { this.notifyRefusal(first); return 0; }
    const team = localTeam();
    const eco = this.economy;
    const space = HUD.production.maxQueue - this.production.itemsOf(full.producer).length;
    const { cost = {}, supply = 0 } = first;
    const scaled = (k) => Object.fromEntries(Object.entries(cost).map(([r, v]) => [r, (v ?? 0) * k]));
    let n = 1;
    while (n < count && n < space && eco.canAfford(team, scaled(n + 1)) && eco.canSupport(team, supply * (n + 1))) n++;
    for (let i = 0; i < n; i++) commandBus.submit(full);
    this.hud.refresh?.();
    if (n < count) { // why the next copy was not queued (one message)
      if (n >= space) this.notifyRefusal({ reason: REASON.full });
      else if (!eco.canAfford(team, scaled(n + 1))) this.notify(this.#missingText(scaled(n + 1)), SOUND_HOOKS.fundsSound);
      else this.notifyRefusal({ reason: REASON.population });
    }
    return n;
  }

  /** Message for a refused production command (Production.check result) */
  notifyRefusal({ reason, cost }) {
    if (reason === REASON.resources) this.notify(this.#missingText(cost ?? {}), SOUND_HOOKS.fundsSound);
    else if (reason === REASON.population) this.notify(this.#populationText());
    else if (reason === REASON.full) this.notify(t('hud.queue.full', { max: HUD.production.maxQueue }));
    else if (reason === REASON.service) this.notify(t('assembly.blockedByService'));
    // other reasons: the button is shown disabled with its own tooltip
  }

  // ---------- helpers ----------

  /** Own finished building of each id in `requires` exists */
  requirementsMet(requires = []) {
    return this.production?.requirementsMet(localTeam(), requires)
      ?? requires.every((id) => this.world.structures.some((s) => s.team === localTeam() && s.unitId === id && s.complete && !s.destroyed));
  }

  #requiresText(requires = []) {
    const missing = requires.filter((id) => !this.requirementsMet([id]));
    return missing.length ? t('build.requires', { list: missing.map((id) => unitName('structures', id)).join(', ') }) : '';
  }

  /** Buildings this team may construct (data order) */
  buildableStructures() {
    const all = getStats().structures ?? {};
    return Object.keys(all).filter((id) => all[id].buildable !== false && canProduce(this.race, 'structures', id, this.unlocks));
  }

  /** Builder vehicles in the selection */
  get selectedBuilders() { return this.input.selectedVehicles.filter((v) => v.canConstruct); }

  /** Producer key of a building in world.production = its entity id */
  producerId(structure) { return structure.eid; }

  /** Where the production of a producer (structure eid) appears (HUD queue click, progress bar) – null when gone */
  spawnPointOf(producer) {
    const s = this.world.entityById?.(producer) ?? null;
    return s && s.isStructure && !s.destroyed && !s.removed ? s.spawnPoint() : null;
  }

  // ---------- per frame ----------

  update(dt) {
    if (this.messageTimer > 0 && (this.messageTimer -= dt) <= 0) this.hud.message('');
    this.robotProduction?.update(dt); // holograms in the assembly bays (a lost building's queue is refunded by Production)
  }

  // ---------- option grid ----------

  /** Grid view for the current selection, or null (Hud shows its own pages) */
  view() {
    if (this.placing) return this.#placingView();
    const builders = this.selectedBuilders;
    if (builders.length) return this.#buildView(builders);
    const s = this.input.selectedStructure;
    if (s && s.team === localTeam() && !s.destroyed) {
      return s.complete ? this.#structureView(s) : this.#constructionView(s);
    }
    return null;
  }

  /**
   * Information rows of an own building that the production panel no longer shows (HUD v2: the panel holds only title,
   * option grid, tabs and queue). For the centre panel: [{ label, value, warn }] – a finished building: population provided,
   * income, storage, queue fill + rally / gather rows (gatherSummary); a building under construction: progress, builders
   * (rate), paused. Same rows the old summary under the grid listed.
   */
  structureInfo(s) {
    const summary = [];
    if (!s.complete) {
      const rate = s.buildRate;
      summary.push({ label: t('structure.progress'), value: `${Math.floor(s.progress * PERCENT)} %` },
        { label: t('structure.builders'), value: `${s.builders.size} (×${rate.toFixed(RATE_DECIMALS)})`, warn: rate <= 0 });
      if (rate <= 0) summary.push({ label: t('structure.paused'), value: '', warn: true });
      return summary;
    }
    if (s.stats.supplyProvided) summary.push({ label: t('hud.population'), value: `+${s.stats.supplyProvided}` });
    const income = incomeOf(s.stats);
    if (income) summary.push({ label: t('structure.incomeLabel'), value: incomeText(income) });
    if (s.stats.storage) summary.push({ label: t('structure.storageLabel'), value: storageText(s.stats.storage) });
    const producer = this.producerId(s);
    if (this.#productionOptions(s).length) {
      const queued = this.production?.itemsOf(producer).length ?? 0;
      summary.push({ label: t('hud.queue.title'), value: `${queued} / ${HUD.production.maxQueue}` }, ...this.gatherSummary(s));
    }
    return summary;
  }

  // The grid panel no longer carries buttons: delete building = input.confirmDelete([], [s]) (command grid, deleteUnit);
  // cancel construction = cancelConstruction(world, s) + input.setSelection([]); cancel placement = input.placement?.cancel()

  #costTip(stats) {
    return [t('grid.cost', { ore: stats.cost?.ore ?? 0, energy: stats.cost?.energy ?? 0 }), t('grid.time', { time: +(stats.buildTime ?? 0).toFixed(1) }),
      stats.energyUse ? t('grid.energyUse', { n: +stats.energyUse.toFixed(ECONOMY_ALERTS.flowDecimals) }) : ''];
  }

  /** Role of a building from data (explicit stats.role wins); BUILD_GRID maps it to a grid row */
  buildRole(s) {
    if (s.role) return s.role;
    const produces = s.produces ?? [];
    if (s.hq) return 'hq';
    for (const kind of ['crew', 'vehicle', 'aircraft', 'part', 'mech']) if (produces.includes(kind)) return kind;
    if (produces.includes('research')) return 'research';
    if (s.deepExtraction) return 'power'; // [H3] economy row (power / storage), not research, despite requiresTier
    if (s.requiresTier) return 'advancedResearch';
    if (s.income) return 'power';
    if (s.storage) return 'storage';
    if (s.wallSegment) return 'wall';
    if (s.mountOn) return 'turret';
    if (s.weapons?.length) return 'pointDefense';
    return null;
  }

  /** Building ids sorted by grid row (stable: data order inside a role) */
  #sortedByRow(ids) {
    const info = ids.map((id, index) => {
      const role = this.buildRole(unitStats('structures', id, this.race));
      const order = BUILD_GRID.roleOrder.indexOf(role);
      return { id, index, row: BUILD_GRID.roleRow[role] ?? BUILD_GRID.lastRow, order: order < 0 ? BUILD_GRID.roleOrder.length : order };
    });
    info.sort((a, b) => a.row - b.row || a.order - b.order || a.index - b.index);
    return info;
  }

  #buildView(builders) {
    const columns = HUD.optionGrid.columns;
    const sorted = this.#sortedByRow(this.buildableStructures());
    const entries = [];
    let lastRow = null;
    for (const e of sorted) {
      if (lastRow !== null && e.row !== lastRow) while (entries.length % columns) entries.push(null); // new row = new line
      lastRow = e.row;
      entries.push(e.id);
    }
    const items = entries.map((id) => {
      if (!id) return null;
      const s = unitStats('structures', id, this.race);
      const name = unitName('structures', id);
      const req = [this.#requiresText(s.requires), this.limitText(id, s)].filter(Boolean).join('\n');
      const afford = this.economy?.canAfford(localTeam(), s.cost) ?? true;
      const extra = [
        s.supplyProvided ? t('structure.supply', { n: s.supplyProvided }) : '',
        incomeOf(s) ? t('structure.income', { list: incomeText(incomeOf(s)) }) : '',
        s.storage ? t('structure.storage', { list: storageText(s.storage) }) : '',
        wallTip(s, this.race),
        req, afford ? '' : this.#missingText(s.cost),
      ];
      return {
        icon: name.slice(0, ICON_LETTERS), iconUrl: getBuildingIconUrl(id, this.race, TEAMS[localTeam()]?.color) ?? undefined,
        label: name, disabled: Boolean(req) || !afford,
        tip: [name, ...this.#costTip(s), ...extra].filter(Boolean).join('\n'),
        onClick: () => this.startPlacement(id, builders),
      };
    });
    return { title: t('build.title'), items };
  }

  /** Placement hint text (rotation keys, ghost hint) – no longer shown in the grid panel */
  placingHint() {
    if (!this.placing) return '';
    return this.placing.ghost.hint?.()
      ?? t('build.placing.hint', { rotate: KEYBINDINGS.rotateBuilding.map(keyLabel).join('/') || '–' });
  }

  #placingView() {
    return { title: t('build.placing', { name: unitName('structures', this.placing.id) }), items: [] };
  }

  /** Starts the placement preview of a building for the given builders */
  startPlacement(id, builders = this.selectedBuilders) {
    const stats = unitStats('structures', id, this.race);
    const limit = this.limitText(id, stats);
    if (limit) { this.notify(limit); return; }
    if (!this.economy.canAffordUpfront(localTeam(), stats.cost)) { this.notify(this.#missingText(stats.cost), SOUND_HOOKS.fundsSound); return; }
    // Rotation turns smoothly: the next building keeps the last angle, the first one faces the map centre in a quarter turn
    const yaw = this.placedYaw ?? snapYaw(this.placementYaw?.() ?? 0);
    const ghost = createPlacement(stats, {
      world: this.world, team: localTeam(), race: this.race, id, yaw, builders: [...builders],
      // Ordered constructions count towards maxPerTeam until they exist (startConstruction is async)
      onStart: () => this.ordering.set(id, (this.ordering.get(id) ?? 0) + 1),
      blockedReason: () => this.limitText(id, stats),
      onPlaced: (res) => {
        if (res.error === 'limit') { this.notify(res.reason); return; }
        this.ordering.set(id, Math.max(0, (this.ordering.get(id) ?? 0) - 1));
        if (res.error === 'resources') this.notify(this.#missingText(res.cost ?? stats.cost), SOUND_HOOKS.fundsSound);
        else if (res.error === 'noPost') this.notify(t('wall.noPost'));
        else if (res.error) this.notify(t('build.blocked'));
      },
      onEnd: () => {
        this.placedYaw = ghost.yaw;
        if (this.input.placement === ghost) this.input.placement = null;
        if (this.placing?.ghost === ghost) this.placing = null;
      },
    });
    this.placing = { id, ghost };
    this.input.setPlacement(ghost);
    ghost.init().catch((err) => { console.error(err); ghost.cancel(); });
  }

  #constructionView(s) {
    return { title: unitName('structures', s.unitId), items: [] };
  }

  #structureView(s) {
    // Robot production buildings have their own pages (src/ui/RobotProduction.js)
    const robots = this.robotProduction;
    if (robots && s.produces.includes('part')) return robots.factoryView(s, unitName('structures', s.unitId));
    if (robots && s.produces.includes('mech')) return robots.assemblyView(s, unitName('structures', s.unitId));
    if (this.researchView && s.produces.includes('research')) return this.researchView.view(s, unitName('structures', s.unitId));
    const producer = this.producerId(s);
    const full = this.production?.isFull(producer) ?? false;
    const items = this.#productionOptions(s).map((opt) => ({
      ...opt, disabled: opt.disabled || full,
      tip: [opt.tip, full ? t('hud.queue.full', { max: HUD.production.maxQueue }) : ''].filter(Boolean).join('\n'),
    }));
    if (items.length) items.push(...this.gatherItems(s)); // [R4]
    return { title: unitName('structures', s.unitId), items }; // info rows: structureInfo(s)
  }

  // ---------- [R4] rally point and spawn stance ----------

  /** Stances a building's new units can take: crews only know defensive / passive */
  #spawnModes(s) {
    const crewOnly = !s.produces.some((k) => k === 'vehicle' || k === 'mech');
    return RALLY.spawnModes.filter((m) => !crewOnly || BEHAVIOUR.crewModes.includes(m));
  }

  /** Stance the new units get: the building's choice, else the default of the unit kind */
  #spawnMode(s) {
    return s.spawnBehaviour ?? getStats().rules?.combat?.defaultBehaviour ?? RALLY.spawnModes[0];
  }

  /** Grid buttons of unit-producing buildings: stance for new units (click = next one), clear rally chain */
  gatherItems(s) {
    if (!canGather(s)) return [];
    const modes = this.#spawnModes(s);
    const mode = modes.includes(this.#spawnMode(s)) ? this.#spawnMode(s) : modes[0];
    const next = modes[(modes.indexOf(mode) + 1) % modes.length];
    const items = [{
      icon: RALLY.stanceIcons[mode], label: t(`rally.stance.${mode}`), on: true,
      tip: [t('rally.stance.tip'), t(`rally.stance.${mode}.tip`)].join('\n'),
      onClick: () => this.submit({ type: 'setSpawnStance', structure: s.eid, mode: next }),
    }];
    if (s.rally?.length) {
      items.push({ icon: ICONS.cancel, label: t('rally.clear'), tip: t('rally.clear.tip'),
        onClick: () => this.submit({ type: 'setRally', structure: s.eid, points: [] }) });
    }
    return items;
  }

  /** Summary rows of unit-producing buildings: rally points set / how to set them */
  gatherSummary(s) {
    if (!canGather(s)) return [];
    return [{ label: t('rally.title'), value: s.rally?.length ? t('rally.points', { n: s.rally.length }) : t('rally.hint') }];
  }

  /** Grid buttons for what a finished building can produce */
  #productionOptions(s) {
    const options = this.production?.unitOptions(s) ?? [];
    const color = TEAMS[localTeam()]?.color;
    return options.map(({ kind, unitId, stats }) => (kind === 'crew'
      ? this.#option(t('grid.training'), ICONS.crew, stats, { producer: s.eid, kind }, t('grid.training.tip', { size: stats.squadSize }),
        unitIconUrl('crew', this.race, color))
      : this.#option(unitName('vehicles', unitId), ICONS.vehicle, stats, { producer: s.eid, kind, unitId }, '',
        unitIconUrl(unitId, this.race, color))));
  }

  #option(label, icon, stats, payload, desc = '', iconUrl = null) {
    const req = this.#requiresText(stats.requires);
    const supply = stats.supply ?? 0;
    return {
      icon, iconUrl: iconUrl ?? undefined, label, disabled: Boolean(req),
      tip: [label, desc, ...this.#costTip(stats), supply ? `${t('hud.population')}: ${supply}` : '', req,
        t('grid.shiftBatch', { n: SHIFT_BATCH.count })].filter(Boolean).join('\n'),
      onClick: (e) => (e?.shift ? this.submitBatch({ type: 'queueUnit', ...payload }) : this.submit({ type: 'queueUnit', ...payload })),
    };
  }
}

/**
 * [H3] Income of a building per second: stats.income plus the ore of its deepExtraction; null when it has none.
 * Info panels and the build tooltip show incomeText(incomeOf(stats)).
 */
export function incomeOf(stats) {
  const rate = stats?.deepExtraction?.ratePerSecond;
  if (!rate) return stats?.income ?? null;
  return { ...(stats.income ?? {}), ore: (stats.income?.ore ?? 0) + rate };
}

/** '2 energy/s' style text of an income object */
export function incomeText(income = {}) {
  return Object.entries(income).map(([r, v]) => t('econ.perSecond', { value: v, resource: t(`hud.${r}`) })).join(', ');
}

/** '+200 energy' style text of a storage object (raises the storage cap) */
export function storageText(storage = {}) {
  return Object.entries(storage).map(([r, v]) => `+${v} ${t(`hud.${r}`)}`).join(', ');
}
