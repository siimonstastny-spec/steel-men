// Steel Mans – in-game HUD (HUD v2: frame of data/image/ui/hud2 pieces, content in its slots; docs/notes/hud2-layout.md).
//   frame         fixed pieces + stretched strips for any aspect ratio, recoloured per faction (--hud-frame-filter)
//   top left      ore / energy / population in the resource bar; production panel under it: option grid 4×4
//                 (BuildMenu: buildings, production inside buildings, robot parts / assembly) + production queue rows
//   top centre    ☰ menu button (MatchUi) + game clock;  top right  diplomacy ⚑ + help ?
//   top           control group chips (Ctrl + 1–9) under the bar
//   bottom left   idle crew / idle builder buttons + universal command grid 4×4 (RTS orders)
//   bottom centre container for SelectionPanel / RobotPanel (their look is not made here)
//   bottom right  player statistics (PlayerStatsBar) above the minimap (#minimap, made by the map code)
//   above units   health / progress bars (UnitOverlays), wreck tooltip under the cursor
// --hud-scale (unitless, on :root) = clamp(min(W / 1920, H / 1080), HUD_V2.scaleMin, HUD_V2.scaleMax), updated on resize.
import * as THREE from 'three';
import { HUD, HUD_V2, ECONOMY_ALERTS, KEYBINDINGS, SIM, GAME_CLOCK, GAME_SPEED, IDLE_BUILDER } from '../config.js';
import { localTeam } from '../core/LocalPlayer.js';
import { getSettings } from '../core/Profile.js';
import { formatGameTime, gameSpeed, speedLabel } from '../game/GameSpeed.js';
import { getStats } from '../data/Stats.js';
import { t } from '../i18n/i18n.js';
import { keyLabel, TARGETED_ORDERS } from '../input/CommandInput.js';
import { OptionGrid } from './OptionGrid.js';
import { SelectionPanel } from './SelectionPanel.js';
import { UnitOverlays } from './UnitOverlays.js';
import { OrderQueueMarkers } from './OrderQueueMarkers.js';
import { Pings } from './Pings.js'; // [N7] map pings, lost-part alerts
import { ProductionQueue, progressOf } from './ProductionQueue.js';
import { esc, wreckInfo } from './hudUtil.js';

const ICONS = { ore: '⛏', energy: '⚡', population: '👥', idleCrew: '👷' };
const GROUP_COUNT = 9;
const PERCENT = 100;
const GEOMETRY_VARS = ['--hud-prod-y', '--hud-prod-top-h', '--hud-prod-bottom-h', '--hud-prod-row-h', '--hud-prod-col-y', '--hud-idle-from-bottom',
  '--hud-ml', '--hud-mr', '--hud-mt', '--hud-mb', '--hud-idle-scale', '--hud-backdrop'];
// Command grid cells highlighted when the selection has this behaviour
const BEHAVIOUR_CELLS = { behaviourAggressive: 'aggressive', behaviourDefensive: 'defensive', behaviourPassive: 'passive' };

const ARROW_SYMBOLS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const NO_KEY = '–';
const CAMERA_ACTIONS = ['cameraForward', 'cameraLeft', 'cameraBack', 'cameraRight'];
const HELP_ACTIONS = ['attackMove', 'guard', 'patrol', 'move', 'stop', 'cancel', 'eject', 'debugXp'];

const codeLabel = (code) => ARROW_SYMBOLS[code] ?? keyLabel(code);
const actionKeys = (action) => KEYBINDINGS[action]?.map(codeLabel).join('/') || NO_KEY;

/** Help text built from the current KEYBINDINGS (remapping in the settings is reflected the next time it opens) */
function helpText() {
  const groups = KEYBINDINGS.controlGroups;
  const params = {
    modifier: t(`key.${KEYBINDINGS.groupModifier}`),
    groupFirst: codeLabel(groups[0][0]),
    groupLast: codeLabel(groups[groups.length - 1][0]),
    cameraKeys: CAMERA_ACTIONS.flatMap((a) => KEYBINDINGS[a].map(codeLabel)).join(' '),
  };
  for (const action of HELP_ACTIONS) params[action] = actionKeys(action);
  return t('hud.helpText', params);
}

export class Hud {
  /**
   * @param {object} deps
   *   world, input (CommandInput), camera, dom (canvas), focus(Vector3) – centres the camera,
   *   spawnPoint(producer) -> {x, z} – where the next item of a producer appears (its building)
   */
  constructor({ world, input, camera, dom, focus, spawnPoint }) {
    this.world = world;
    this.input = input;
    this.idleCrewHandler = () => this.selectNextIdleCrew();       // KEYBINDINGS.idleCrew / idleBuilder (CommandInput)
    this.idleBuilderHandler = () => this.selectNextIdleBuilder();
    this.input.onIdleCrew = this.idleCrewHandler;
    this.input.onIdleBuilder = this.idleBuilderHandler;
    this.dom = dom;
    this.focus = focus;
    this.pointerOnCanvas = false; // the wreck tooltip hides while the cursor is over a panel
    this.onPointerMove = (e) => { this.pointerOnCanvas = e.target === dom; };
    window.addEventListener('pointermove', this.onPointerMove);
    this.scale = 0;            // current --hud-scale (0 = not applied yet)
    this.prodFree = 0;         // base px the production panel may grow beyond production_top + production_bottom (stays above the idle buttons)
    this.prodMid = -1;         // mid strip height currently set (--hud-prod-mid, base px)
    this.layoutDirty = true;   // grid extras or queue changed: re-measure the panel (refresh)
    this.activeSet = new Set(); // recycled: production items in progress
    this.onResize = () => { this.#applyScale(); this.#fitBudget(); this.#fitProduction(); };
    window.addEventListener('resize', this.onResize);
    this.#publishGeometry();
    this.#applyScale();
    this.#fitBudget();
    this.spawnPoint = spawnPoint;
    this.queue = new ProductionQueue(world); // view of world.production for the local team
    this.buildMenu = null;
    this.idleTime = new WeakMap(); // crew -> seconds without an order
    this.idleIndex = 0;
    this.idleBuilderTime = new WeakMap(); // builder vehicle -> seconds without an order
    this.idleBuilderIndex = 0;
    this.timer = 0;

    this.#createLayout();
    this.optionGrid = new OptionGrid(this.el.optionGrid, { columns: HUD.optionGrid.columns, minRows: 0 });
    const cmd = HUD.commandGrid;
    this.commandGrid = new OptionGrid(this.el.commandGrid, { columns: cmd.columns, minRows: Math.ceil(cmd.layout.length / cmd.columns) });
    this.selectionPanel = new SelectionPanel(this.el.selection, { input, world });
    this.overlays = new UnitOverlays({ world, camera, dom, input, queue: this.queue, spawnPoint });
    this.orderMarkers = new OrderQueueMarkers({ world, input }); // Shift order queue on the ground
    this.pings = new Pings({ world, camera, dom, focus }); // [N7]
    this.hide();
  }

  /** Shows the HUD for a started game: production (BuildMenu) and the faction tint */
  start({ race, buildMenu = null }) {
    this.buildMenu = buildMenu; // economy pages of the option grid + paid production (src/ui/BuildMenu.js)
    this.applyFaction(race);
    this.root.hidden = false;
    this.refresh();
  }

  hide() { this.root.hidden = true; }

  /** Removes the HUD DOM and its listeners (window, input callbacks) */
  dispose() {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('resize', this.onResize);
    if (this.input.onIdleCrew === this.idleCrewHandler) this.input.onIdleCrew = null;
    if (this.input.onIdleBuilder === this.idleBuilderHandler) this.input.onIdleBuilder = null;
    for (const part of [this.selectionPanel, this.overlays, this.orderMarkers, this.pings]) part?.dispose?.();
    this.root.remove();
    this.el.message.remove();
    this.el.tooltip.remove();
    for (const name of GEOMETRY_VARS) document.documentElement.style.removeProperty(name);
    document.documentElement.style.removeProperty('--hud-scale');
    document.documentElement.style.removeProperty('--hud-prod-mid');
    document.documentElement.style.removeProperty('--hud-prod-col-max');
  }

  /** Geometry that code and hud.css share (HUD_V2.production): published once as CSS variables (base px, unitless) */
  #publishGeometry() {
    const p = HUD_V2.production;
    const style = document.documentElement.style;
    style.setProperty('--hud-prod-y', String(p.panelTop));
    style.setProperty('--hud-prod-top-h', String(p.topHeight));
    style.setProperty('--hud-prod-bottom-h', String(p.bottomHeight));
    style.setProperty('--hud-prod-row-h', String(p.rowHeight));
    style.setProperty('--hud-prod-col-y', String(p.columnTop));
    style.setProperty('--hud-idle-from-bottom', String(HUD_V2.idleTopFromBottom));
    style.setProperty('--hud-prod-mid', '0');
    const b = HUD_V2.frameBleed;
    style.setProperty('--hud-ml', String(b.left));
    style.setProperty('--hud-mr', String(b.right));
    style.setProperty('--hud-mt', String(b.top));
    style.setProperty('--hud-mb', String(b.bottom));
    style.setProperty('--hud-idle-scale', String(HUD_V2.idleButtonScale));
    style.setProperty('--hud-backdrop', String(HUD_V2.frameBackdrop));
  }

  /** --hud-scale on :root: min(W / 1920, H / 1080) clamped to [scaleMin, scaleMax] (hud.css sizes everything in base px × scale) */
  #applyScale() {
    const b = HUD_V2.frameBleed; // the root is wider than the window by the bleed: scale from the extended area
    const raw = Math.min(window.innerWidth / (HUD_V2.baseWidth - b.left - b.right),
      window.innerHeight / (HUD_V2.baseHeight - b.top - b.bottom));
    const clamped = Math.min(Math.max(raw, HUD_V2.scaleMin), HUD_V2.scaleMax);
    const s = Math.round(clamped * HUD_V2.scalePrecision) / HUD_V2.scalePrecision;
    if (s === this.scale) return;
    this.scale = s;
    document.documentElement.style.setProperty('--hud-scale', String(s));
  }

  /** Room the production panel may grow by (real window height): its bottom stays above the idle buttons (base px).
   *  The column inside the panel gets a max height, so too much content scrolls inside the panel. */
  #fitBudget() {
    const p = HUD_V2.production;
    const b = HUD_V2.frameBleed;
    const free = window.innerHeight / this.scale + b.top + b.bottom - HUD_V2.idleTopFromBottom - HUD_V2.panelBottomGap
      - p.panelTop - p.topHeight - p.bottomHeight;
    this.prodFree = Math.max(0, free);
    document.documentElement.style.setProperty('--hud-prod-col-max', String(p.plainBottom + this.prodFree - p.columnTop));
  }

  /** Panel height follows the content under the grid (grid extras + queue). Measured only when that content changed. */
  #fitProduction() {
    this.layoutDirty = false;
    const p = HUD_V2.production;
    const flow = this.el.prodCol.scrollHeight / this.scale - (p.gridEnd - p.columnTop) - p.flowGap; // extras + queue block
    const slack = p.plainBottom - p.flowStart; // plain inner area below the first row with no mid strip
    // the mid strip grows with the content up to the room above the idle buttons; beyond that the column scrolls (max-height)
    const mid = Math.min(Math.max(flow - slack, 0), this.prodFree);
    if (mid !== this.prodMid) {
      this.prodMid = mid;
      document.documentElement.style.setProperty('--hud-prod-mid', String(mid));
    }
  }

  /** Faction colours from stats.json → races[race].uiColor as CSS variables */
  applyFaction(race) {
    const c = { ...HUD.fallbackColor, ...(getStats().races?.[race]?.uiColor ?? {}) };
    document.documentElement.style.setProperty('--hud-primary', c.primary);
    document.documentElement.style.setProperty('--hud-accent', c.accent);
    // Neon edges / highlights and the steel panel tint of the faction (hud.css falls back to the menu look)
    const set = (name, value) => (value ? document.documentElement.style.setProperty(name, value)
      : document.documentElement.style.removeProperty(name));
    set('--hud-neon', c.neon);
    set('--hud-panel-top', c.panelTop);
    set('--hud-panel-bottom', c.panelBottom);
    set('--hud-frame-filter', c.frameFilter); // recolours the blue-neon frame artwork (e.g. hue-rotate)
  }

  /** Error / info text in the middle of the screen (empty = hidden) */
  message(text) { this.el.message.textContent = text; }

  /** Called every frame */
  update(dt) {
    if (this.root.hidden) return;
    this.queue.update(); // production itself is ticked by the simulation (world.production)
    this.buildMenu?.update(dt);
    this.#trackIdle(dt);
    this.overlays.update(dt);
    this.orderMarkers.update();
    this.pings.update(); // [N7]
    this.#renderTooltip();
    this.#renderClock();
    if ((this.timer -= dt) <= 0) { this.timer = HUD.refreshInterval; this.refresh(); }
  }

  refresh() {
    this.#renderResources();
    this.#renderQueue();
    this.#renderGroups();
    this.#renderOptionGrid();
    this.#renderCommandGrid();
    this.#renderIdle();
    if (this.layoutDirty) this.#fitProduction(); // the panel follows its content (one measurement, only after a change)
    this.selectionPanel.render();
  }

  // ---------- layout ----------

  #createLayout() {
    const root = document.createElement('div');
    root.id = 'hud-root';
    root.innerHTML = `
      <div class="hud-backdrop" aria-hidden="true"></div>
      <div class="hud-frame" aria-hidden="true">
        <div class="fp tl"><i class="hit"></i></div>
        <div class="fp tc"><i class="hit"></i></div>
        <div class="fp tr"><i class="hit"></i></div>
        <div class="fp ta"><i class="hit"></i></div>
        <div class="fp tb"><i class="hit"></i></div>
        <div class="fp sl"></div>
        <div class="fp sr"></div>
        <div class="fp sld"></div>
        <div class="fp srd"></div>
        <div class="fp bl"><i class="hit"></i></div>
        <div class="fp br"><i class="hit"></i></div>
        <div class="fp bm"><i class="hit"></i></div>
      </div>
      <div class="hud-resources" data-el="resources"></div>
      <div class="hud-groups" data-el="groups"></div>
      <div class="hud-clock" data-el="clock" hidden></div>
      <button class="hud-top-btn hud-dip-btn" data-el="dipBtn" hidden>⚑</button>
      <button class="hud-top-btn hud-help-btn" data-el="helpBtn">?</button>
      <div class="hud-popup hud-help" data-el="help" hidden></div>
      <div class="hud-prod" data-el="prod">
        <div class="hud-prod-art"><i class="t"></i><i class="m"></i><i class="b"></i></div>
        <div class="hud-prod-col" data-el="prodCol">
          <div data-el="optionGrid"></div>
          <div class="hud-queue" data-el="queue"></div>
        </div>
      </div>
      <button class="hud-idle hud-idle-crew" data-el="idle" hidden></button>
      <button class="hud-idle hud-idle-builder" data-el="idleBuilder" hidden></button>
      <div class="hud-cmd" data-el="commandGrid"></div>
      <div class="hud-bottom-center"><div data-el="selection"></div></div>`;
    document.body.appendChild(root);
    const msg = document.createElement('div');
    msg.id = 'hud-message';
    document.body.appendChild(msg);
    const tip = document.createElement('div');
    tip.className = 'hud-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
    this.root = root;
    this.el = Object.fromEntries([...root.querySelectorAll('[data-el]')].map((e) => [e.dataset.el, e]));
    this.el.message = msg;
    this.el.tooltip = tip;

    // pointerdown: panels are refreshed several times a second, a click could fall between two refreshes
    this.el.queue.addEventListener('pointerdown', (e) => this.#onQueuePointer(e));
    this.el.queue.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.groups.addEventListener('pointerdown', (e) => {
      const n = e.target.closest('[data-group]')?.dataset.group;
      if (n === undefined || e.button !== 0) return;
      e.preventDefault();
      this.input.controlGroup(Number(n)); // second quick press centres the camera (CommandInput)
    });
    this.el.idle.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); this.selectNextIdleCrew(); } });
    this.el.idleBuilder.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); this.selectNextIdleBuilder(); } });
    this.el.dipBtn.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); this.diplomacy?.toggle(); } });
    this.el.helpBtn.title = t('hud.help');
    this.el.helpBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.el.help.innerHTML = helpText(); // own trusted string with <br>
      this.el.help.hidden = !this.el.help.hidden;
    });
  }

  /** [B4] Diplomacy button (src/ui/DiplomacyView.js) next to the help button; null hides it */
  setDiplomacy(view) {
    this.diplomacy = view ?? null;
    this.el.dipBtn.hidden = !view;
    if (view) this.el.dipBtn.title = t('dip.button.hint', { key: (KEYBINDINGS.diplomacy ?? []).map(keyLabel).join('/') });
  }

  // ---------- top left: resources + production queue ----------

  #renderResources() {
    const eco = this.world.economy;
    const pop = this.world.crews.filter((c) => c.team === localTeam() && !c.dead).reduce((s, c) => s + (c.supply ?? 0), 0);
    const res = (key, icon, value, disabled, tip = t(`hud.${key}`), warn = false) =>
      `<span class="hud-res hud-res-${key} ${disabled ? 'disabled' : ''} ${warn === 'lowEnergy' ? 'lowEnergy' : warn ? 'warn' : ''}" title="${esc(tip)}${disabled ? ` – ${esc(t('hud.noEconomy'))}` : ''}">`
      + `<i>${icon}</i><b>${value}</b></span>`;
    if (!eco) { // before a game starts: ore and energy show a dash
      this.#set(this.el.resources, res('ore', ICONS.ore, '–', true) + res('energy', ICONS.energy, '–', true)
        + res('population', ICONS.population, pop, false));
      return;
    }
    const team = localTeam();
    const energy = Math.floor(eco.amount(team, 'energy'));
    const energyCap = eco.energyCapOf(team); // + EnergyBank storage
    const used = eco.populationUsed(team);
    const cap = eco.populationCap(team);
    const low = !!eco.isLowEnergy?.(team);
    const flow = eco.energyFlow?.(team);
    const scale = 10 ** ECONOMY_ALERTS.flowDecimals;
    const income = flow ? Math.round(flow.income * scale) : -1;
    const drain = flow ? Math.round(flow.drain * scale) : -1;
    const c = this.energyTipCache; // tooltip text is rebuilt only when one of its inputs changes
    if (!c || c.cap !== energyCap || c.income !== income || c.drain !== drain || c.low !== low) {
      const dec = ECONOMY_ALERTS.flowDecimals;
      const text = [t('hud.energyCap', { cap: energyCap }),
        flow ? t('hud.energyFlow', { income: flow.income.toFixed(dec), drain: flow.drain.toFixed(dec) }) : '',
        low ? t('hud.energyLow') : ''].filter(Boolean).join('\n');
      this.energyTipCache = { cap: energyCap, income, drain, low, text };
    }
    const energyTip = this.energyTipCache.text;
    this.#set(this.el.resources, res('ore', ICONS.ore, Math.floor(eco.amount(team, 'ore')), false)
      + res('energy', ICONS.energy, `${energy}/${energyCap}`, false, energyTip, low ? 'lowEnergy' : energy >= energyCap)
      + res('population', ICONS.population, `${used}/${cap}`, false, t('hud.population'), used >= cap));
  }

  /** Queue under the grid: one 40 px row per item, always all of them (max HUD.production.maxQueue per producer). When they
   *  do not fit, the column of the production panel scrolls inside the panel (max-height), so every item can be cancelled. */
  #renderQueue() {
    const items = this.queue.items;
    const shown = items.length;
    const active = this.activeSet;
    active.clear();
    for (const it of this.queue.active) active.add(it);
    let html = '';
    for (let i = 0; i < shown; i++) {
      const it = items[i];
      const pct = active.has(it) ? progressOf(it) * PERCENT : 0;
      const left = Math.max(0, it.total - it.elapsed).toFixed(0);
      html += `<div class="hud-qitem ${active.has(it) ? '' : 'waiting'}" data-q="${it.id}" title="${esc(it.label)} – ${left} s · ${esc(t('hud.queue.hint'))}">`
        + `<span class="ico">${it.icon}</span><span class="nm">${esc(it.label)}</span><span class="tm">${left} s</span>`
        + `<span class="bar" style="width:${pct}%"></span></div>`;
    }
    if (this.#set(this.el.queue, html)) this.layoutDirty = true;
  }

  #onQueuePointer(e) {
    const id = Number(e.target.closest('[data-q]')?.dataset.q);
    if (!id) return;
    e.preventDefault();
    const item = this.queue.items.find((i) => i.id === id);
    if (!item) return;
    if (e.button === 2) { this.queue.cancel(id); this.refresh(); return; }
    // Camera to the production site: the building later, now the spawn point of the producer
    const p = this.spawnPoint?.(item.producer);
    if (p && e.button === 0) this.focus?.(new THREE.Vector3(p.x, this.world.heightAt(p.x, p.z), p.z));
  }

  // ---------- top right: control groups ----------

  #renderGroups() {
    const sel = this.input.selection;
    let html = '';
    for (let n = 1; n <= GROUP_COUNT; n++) {
      const units = this.input.groupUnits(n);
      if (!units.length) continue;
      const on = units.length === sel.length && units.every((u) => sel.includes(u));
      html += `<button class="hud-group ${on ? 'on' : ''}" data-group="${n}" title="${esc(t('hud.groups.hint', { n, count: units.length }))}">`
        + `<b>${n}</b><small>${units.length}×</small></button>`;
    }
    this.#set(this.el.groups, html);
  }

  // ---------- left: option grid ----------

  #renderOptionGrid() {
    // Builder vehicle / own building selected: economy pages (BuildMenu) – buildings, crews, vehicles, robot
    // parts and mech assembly are all produced in buildings
    // HUD v2: building info / delete / cancel are gone from the pages (BuildMenu.structureInfo → centre panel); the summary and
    // action of production pages (assembly, service, research, factory) stay under the grid
    const page = this.buildMenu?.view() ?? null;
    const hasOptions = Boolean(page) && (Boolean(page.tabs?.length) || Boolean(page.summary?.length) || Boolean(page.action)
      || page.items?.some(Boolean));
    const show = hasOptions || this.queue.items.length > 0; // nothing to choose and nothing queued: no panel
    if (this.el.prod.hidden === show) { this.el.prod.hidden = !show; this.layoutDirty = true; }
    if (!show) return;
    const before = this.optionGrid.signature;
    this.optionGrid.show(hasOptions ? page : { title: page?.title ?? t('hud.queue.title'), items: [] });
    if (this.optionGrid.signature !== before) this.layoutDirty = true; // tabs may have changed the height
  }

  // ---------- bottom left: command grid ----------

  #renderCommandGrid() {
    const enabled = this.input.commands;
    const stance = this.input.stance;
    const behaviour = this.input.behaviour;
    const repairing = this.input.repairing;
    const items = HUD.commandGrid.layout.map((name) => {
      if (!name) return null;
      const key = KEYBINDINGS[name]?.[0];
      // The repair button turns into "stop repair" while the selected mechs are being repaired
      const look = name === 'repair' && repairing ? 'stopRepair' : name;
      return {
        icon: HUD.commandIcons[look] ?? '', label: t(`cmd.${look}`), hotkey: key ? keyLabel(key) : '',
        tip: t(`cmd.${look}.tip`) + (key ? ` [${keyLabel(key)}]` : ''),
        disabled: !enabled[name],
        on: (name === 'stanceRanged' && stance === 'ranged') || (name === 'stanceMelee' && stance === 'melee')
          || (BEHAVIOUR_CELLS[name] !== undefined && BEHAVIOUR_CELLS[name] === behaviour),
        pending: TARGETED_ORDERS.includes(name) && this.input.pending === name,
        onClick: () => { this.input.command(name); this.refresh(); },
      };
    });
    this.commandGrid.show({ items });
  }

  // ---------- idle crews ----------

  #trackIdle(dt) {
    for (const c of this.world.crews) {
      const idle = c.team === localTeam() && !c.dead && !c.inside && !c.order;
      this.idleTime.set(c, idle ? (this.idleTime.get(c) ?? 0) + dt : 0);
    }
    for (const v of this.world.vehicles) { // builders: no order = neither building nor repairing nor moving
      const idle = v.team === localTeam() && !v.dead && v.canConstruct && !v.order;
      this.idleBuilderTime.set(v, idle ? (this.idleBuilderTime.get(v) ?? 0) + dt : 0);
    }
  }

  get idleBuilders() {
    return this.world.vehicles.filter((v) => v.team === localTeam() && !v.dead && v.canConstruct
      && (this.idleBuilderTime.get(v) ?? 0) >= IDLE_BUILDER.minIdleTime);
  }

  get idleCrews() {
    return this.world.crews.filter((c) => c.team === localTeam() && !c.dead && !c.inside
      && (this.idleTime.get(c) ?? 0) >= HUD.idleCrew.minIdleTime);
  }

  #renderIdle() {
    const n = this.idleCrews.length;
    this.el.idle.hidden = n === 0;
    this.#set(this.el.idle, `${ICONS.idleCrew}<b>${n}</b>`);
    this.el.idle.title = t('idle.title', { count: n });
    const builders = this.idleBuilders.length;
    this.el.idleBuilder.hidden = builders === 0;
    this.#set(this.el.idleBuilder, `${IDLE_BUILDER.icon}<b>${builders}</b>`);
    this.el.idleBuilder.title = t('idle.builders.title', { count: builders });
  }

  /** Selects the next idle builder (cycles) and centres the camera on it */
  selectNextIdleBuilder() {
    const list = this.idleBuilders;
    if (!list.length) return;
    this.idleBuilderIndex = (this.idleBuilderIndex + 1) % list.length;
    const truck = list[this.idleBuilderIndex];
    this.input.select(truck);
    this.focus?.(truck.position.clone());
    this.refresh();
  }

  /** Selects the next idle crew (cycles) and centres the camera on it */
  selectNextIdleCrew() {
    const list = this.idleCrews;
    if (!list.length) return;
    this.idleIndex = (this.idleIndex + 1) % list.length;
    const crew = list[this.idleIndex];
    this.input.select(crew);
    this.focus?.(crew.position.clone());
    this.refresh();
  }

  // ---------- game clock [N4] ----------

  /** Game time (simulation ticks / tick rate, so a pause stops it) next to the menu button; the speed shows when not 1× */
  #renderClock() {
    const el = this.el.clock;
    const show = getSettings().ui?.showClock ?? GAME_CLOCK.defaultVisible;
    if (el.hidden === show) el.hidden = !show;
    if (!show) return;
    const speed = gameSpeed.value;
    const key = `${Math.floor(this.world.tick / SIM.tickRate)}|${speed}`;
    if (el._key === key) return;
    el._key = key;
    const speedText = speed === GAME_SPEED.default ? '' : ` <small>${speedLabel(speed)}</small>`;
    el.innerHTML = `${formatGameTime(this.world.tick / SIM.tickRate)}${speedText}`;
    el.title = t('hud.clock');
  }

  // ---------- wreck tooltip ----------

  #renderTooltip() {
    const wreck = this.input.hoveredWreck;
    const p = this.input.pointerClient;
    const tip = this.el.tooltip;
    if (!wreck || !p || !this.pointerOnCanvas) { tip.hidden = true; return; }
    const w = wreckInfo(wreck);
    this.#set(tip, `<b>${esc(w.name)}</b> · ${esc(w.set)} (${esc(w.race)})<br>${esc(t('wreck.hp', { hp: w.hp, max: w.maxHp }))}`);
    tip.style.left = `${p.x + HUD.wreckTooltip.offsetX}px`;
    tip.style.top = `${p.y + HUD.wreckTooltip.offsetY}px`;
    tip.hidden = false;
  }

  /** innerHTML only when it changed (keeps hover state and saves layout work) */
  #set(el, html) {
    if (el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  }
}
