// Steel Men – in-game HUD (HUD v2: frame of data/image/ui/hud2 pieces, content in its slots; docs/notes/hud2-layout.md).
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
import { HUD, HUD_V2, UI_SCALE, ECONOMY_ALERTS, KEYBINDINGS, FORMATION, SIM, GAME_CLOCK, GAME_SPEED, IDLE_BUILDER, IDLE_DRILL, ORE_ICON } from '../config.js';
import { localTeam } from '../core/LocalPlayer.js';
import { getSettings, onSettingsChange } from '../core/Profile.js';
import { formatGameTime, gameSpeed, speedLabel } from '../game/GameSpeed.js';
import { getStats } from '../data/Stats.js';
import { t, getLanguage } from '../i18n/i18n.js';
import { keyLabel, TARGETED_ORDERS } from '../input/CommandInput.js';
import { OptionGrid } from './OptionGrid.js';
import { setHtmlKeepScroll } from './scrollKeep.js';
import { SelectionPanel } from './SelectionPanel.js';
import { UnitOverlays } from './UnitOverlays.js';
import { TerrainLabel } from './TerrainLabel.js'; // [A14-ui] terrain type + speed factor under the cursor
import { OrderQueueMarkers } from './OrderQueueMarkers.js';
import { Pings } from './Pings.js'; // [N7] map pings, lost-part alerts
import { ProductionQueue } from './ProductionQueue.js';
import { QueueFrame } from './QueueFrame.js'; // [W3] all queues of the player in a frame above the statistics
import { esc, wreckInfo } from './hudUtil.js';
import { formatAmount } from './formatAmount.js';

const ICONS = { ore: ORE_ICON, energy: '⚡', population: '👥', idleCrew: '👷' };
const GROUP_COUNT = 9;
const GEOMETRY_VARS = ['--hud-prod-y', '--hud-prod-top-h', '--hud-prod-bottom-h', '--hud-prod-row-h', '--hud-prod-col-y', '--hud-idle-from-bottom',
  '--hud-ml', '--hud-mr', '--hud-mt', '--hud-mb', '--hud-idle-left', '--hud-idle-size', '--hud-idle-gap', '--hud-backdrop'];
const UI_SCALE_VARS = ['--ui-font-main', '--ui-font-small', '--ui-hit', '--ui-dialog-font'];
const LEVEL_FULL = 0, LEVEL_COMPACT = 1, LEVEL_TINY = 2; // detail levels (hud-compact / hud-tiny)
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
    this.idleDrillHandler = () => this.selectNextIdleDrill();     // KEYBINDINGS.idleDrill (CommandInput.onIdleDrill)
    this.input.onIdleDrill = this.idleDrillHandler;
    this.dom = dom;
    this.focus = focus;
    this.pointerOnCanvas = false; // the wreck tooltip hides while the cursor is over a panel
    this.onPointerMove = (e) => { this.pointerOnCanvas = e.target === dom; };
    window.addEventListener('pointermove', this.onPointerMove);
    this.scale = 0;            // current --hud-scale (0 = not applied yet)
    this.prodFree = 0;         // base px the production panel may grow beyond production_top + production_bottom (stays above the idle buttons)
    this.prodMid = -1;         // mid strip height currently set (--hud-prod-mid, base px)
    this.layoutDirty = true;   // grid extras or queue changed: re-measure the panel (refresh)
    this.cmdSlots = new Array(HUD.commandGrid.layouts.mech.length).fill(null); // recycled: command grid slots of the current selection
    // Recycled command grid state: one item + one shared-per-slot onClick created once; signature of the last render
    const cmdCount = this.cmdSlots.length;
    this.cmdItems = new Array(cmdCount).fill(null);
    this.cmdView = { items: this.cmdItems };
    this.cmdItemPool = Array.from({ length: cmdCount }, (_, i) => ({
      icon: '', label: '', hotkey: '', tip: '', disabled: false, on: false, pending: false,
      onClick: () => {
        const name = this.cmdSlots[i];
        if (name) this.input.command(name); // 'formation' too: CommandInput cycles the mode (same as the key)
        if (name) this.refresh();
      },
    }));
    this.fmCounts = new Array(FORMATION.modes.length).fill(0); // recycled: units per formation mode of the selection
    this.cmdSig = { names: new Array(cmdCount).fill(undefined), enabled: new Array(cmdCount).fill(false), formation: undefined,
      repairing: undefined, stance: undefined, behaviour: undefined, pending: undefined, lang: undefined };
    this.level = LEVEL_FULL;     // detail level: 0 full, 1 compact, 2 tiny
    this.levelApplied = false;
    this.userScale = this.#readUserScale();
    this.onResize = () => { this.#applyScale(); this.#fitBudget(); this.#fitProduction(); };
    window.addEventListener('resize', this.onResize);
    this.offSettings = onSettingsChange(() => { // live HUD scale from the settings screen
      const u = this.#readUserScale();
      if (u === this.userScale) return;
      this.userScale = u;
      this.onResize();
    });
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
    this.idleDrillTime = new WeakMap(); // drill truck -> seconds without an order
    this.idleDrillIndex = 0;
    this.timer = 0;

    this.#createLayout();
    this.optionGrid = new OptionGrid(this.el.optionGrid, { columns: HUD.optionGrid.columns, minRows: 0 });
    const cmd = HUD.commandGrid;
    this.commandGrid = new OptionGrid(this.el.commandGrid, { columns: cmd.columns, minRows: Math.ceil(cmd.layouts.mech.length / cmd.columns) });
    this.queueFrame = new QueueFrame({
      world, queue: this.queue, parent: this.root, spawnPoint,
      focusAt: (x, z) => this.focus?.(new THREE.Vector3(x, this.world.heightAt(x, z), z)),
      onChange: () => this.refresh(),
    });
    this.selectionPanel = new SelectionPanel(this.el.selection, { input, world });
    this.overlays = new UnitOverlays({ world, camera, dom, input, queue: this.queue, spawnPoint });
    this.orderMarkers = new OrderQueueMarkers({ world, input }); // Shift order queue on the ground
    this.pings = new Pings({ world, camera, dom, focus }); // [N7]
    this.terrainLabel = new TerrainLabel({ world, camera, dom, input }); // [A14-ui]
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
    this.offSettings?.();
    document.documentElement.classList.remove('ui-compact', 'ui-tiny');
    for (const name of UI_SCALE_VARS) document.documentElement.style.removeProperty(name);
    if (this.input.onIdleCrew === this.idleCrewHandler) this.input.onIdleCrew = null;
    if (this.input.onIdleBuilder === this.idleBuilderHandler) this.input.onIdleBuilder = null;
    if (this.input.onIdleDrill === this.idleDrillHandler) this.input.onIdleDrill = null;
    for (const part of [this.queueFrame, this.selectionPanel, this.overlays, this.orderMarkers, this.pings, this.terrainLabel]) part?.dispose?.();
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
    style.setProperty('--hud-idle-left', String(HUD_V2.idleButton.left));
    style.setProperty('--hud-idle-size', String(HUD_V2.idleButton.size));
    style.setProperty('--hud-idle-gap', String(HUD_V2.idleButton.gap));
    style.setProperty('--hud-backdrop', String(HUD_V2.frameBackdrop));
    // UI_SCALE floors for CSS (px, unitless: hud.css wraps them in calc(N * 1px))
    style.setProperty('--ui-font-main', String(UI_SCALE.fontMain));
    style.setProperty('--ui-font-small', String(UI_SCALE.fontSmall));
    style.setProperty('--ui-hit', String(UI_SCALE.hitTarget));
    style.setProperty('--ui-dialog-font', String(UI_SCALE.dialogFont));
  }

  /** --hud-scale on :root: min(W / 1920, H / 1080) clamped to [scaleMin, scaleMax] (hud.css sizes everything in base px × scale) */
  #applyScale() {
    this.#applyLevel();
    const b = HUD_V2.frameBleed; // the root is wider than the window by the bleed: scale from the extended area
    const raw = Math.min(window.innerWidth / (HUD_V2.baseWidth - b.left - b.right),
      window.innerHeight / (HUD_V2.baseHeight - b.top - b.bottom));
    const clamped = Math.min(Math.max(raw * this.userScale, UI_SCALE.scaleMin), HUD_V2.scaleMax); // user multiplier before the clamp
    const s = Math.round(clamped * HUD_V2.scalePrecision) / HUD_V2.scalePrecision;
    if (s === this.scale) return;
    this.scale = s;
    document.documentElement.style.setProperty('--hud-scale', String(s));
  }

  /** User multiplier over the automatic scale (settings.ui.hudScale: 'auto' = 1, otherwise '0.75' / '1' / '1.25') */
  #readUserScale() {
    const v = Number(getSettings().ui?.hudScale);
    return Number.isFinite(v) && v > 0 ? v : 1; // 'auto' → NaN → 1
  }

  /** Detail level by window height (UI_SCALE.breakpoints, with hysteresis) and width: 0 full, 1 compact, 2 tiny */
  #applyLevel() {
    const bp = UI_SCALE.breakpoints;
    const h = window.innerHeight;
    const up = (limit, on) => h < limit + (on ? bp.hysteresis : 0); // a level is left only past the breakpoint + hysteresis
    let level = LEVEL_FULL;
    if (up(bp.tiny, this.level >= LEVEL_TINY)) level = LEVEL_TINY;
    else if (up(bp.compact, this.level >= LEVEL_COMPACT)) level = LEVEL_COMPACT;
    if (window.innerWidth < UI_SCALE.narrowWidth + (this.level >= LEVEL_COMPACT ? bp.hysteresis : 0)) level = Math.max(level, LEVEL_COMPACT);
    if (level === this.level && this.levelApplied) return;
    this.level = level;
    this.levelApplied = true;
    this.#setLevelClasses(this.root);
  }

  /** hud-compact / hud-tiny on the HUD root, ui-compact / ui-tiny on <html> (menu and dialog CSS reuse them) */
  #setLevelClasses(root) {
    const html = document.documentElement.classList;
    root?.classList.toggle('hud-compact', this.level === LEVEL_COMPACT);
    root?.classList.toggle('hud-tiny', this.level === LEVEL_TINY);
    html.toggle('ui-compact', this.level === LEVEL_COMPACT);
    html.toggle('ui-tiny', this.level === LEVEL_TINY);
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
    // natural height of the column: the grid may be shrunk by max-height (it scrolls), so use its content height
    const col = this.el.prodCol;
    const grid = col.querySelector('.hud-grid');
    const sum = col.querySelector('.hud-summary'); // may be shrunk too (it scrolls)
    const natural = grid ? col.clientHeight - grid.offsetHeight + grid.scrollHeight
      + (sum ? sum.scrollHeight - sum.offsetHeight : 0) : col.scrollHeight;
    const flow = natural / this.scale - (p.gridEnd - p.columnTop) - p.flowGap; // extras + queue block
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
    this.terrainLabel.update(dt, this.pointerOnCanvas && !this.root.hidden); // [A14-ui]
    this.#renderClock();
    if ((this.timer -= dt) <= 0) { this.timer = HUD.refreshInterval; this.refresh(); }
  }

  refresh() {
    this.#renderResources();
    this.queueFrame.update();
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
        </div>
      </div>
      <button class="hud-idle hud-idle-crew" data-el="idle" hidden></button>
      <button class="hud-idle hud-idle-builder" data-el="idleBuilder" hidden></button>
      <button class="hud-idle hud-idle-drill" data-el="idleDrill" hidden></button>
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
    this.#setLevelClasses(root); // the level was computed before the root existed
    this.el = Object.fromEntries([...root.querySelectorAll('[data-el]')].map((e) => [e.dataset.el, e]));
    this.el.message = msg;
    this.el.tooltip = tip;

    // pointerdown: panels are refreshed several times a second, a click could fall between two refreshes
    this.el.groups.addEventListener('pointerdown', (e) => {
      const n = e.target.closest('[data-group]')?.dataset.group;
      if (n === undefined || e.button !== 0) return;
      e.preventDefault();
      this.input.controlGroup(Number(n)); // second quick press centres the camera (CommandInput)
    });
    this.el.idle.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); this.selectNextIdleCrew(); } });
    this.el.idleBuilder.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); this.selectNextIdleBuilder(); } });
    this.el.idleDrill.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); this.selectNextIdleDrill(); } });
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
    let pop = 0;
    const localT = localTeam();
    for (const c of this.world.crews) if (c.team === localT && !c.dead) pop += c.supply ?? 0;
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
      const text = [t('hud.energyCap', { cap: formatAmount(energyCap) }),
        flow ? t('hud.energyFlow', { income: flow.income.toFixed(dec), drain: flow.drain.toFixed(dec) }) : '',
        low ? t('hud.energyLow') : ''].filter(Boolean).join('\n');
      this.energyTipCache = { cap: energyCap, income, drain, low, text };
    }
    const energyTip = this.energyTipCache.text;
    this.#set(this.el.resources, res('ore', ICONS.ore, formatAmount(eco.amount(team, 'ore')), false)
      + res('energy', ICONS.energy, `${formatAmount(energy)}/${formatAmount(energyCap)}`, false, energyTip, low ? 'lowEnergy' : energy >= energyCap)
      + res('population', ICONS.population, `${used}/${formatAmount(cap)}`, false, t('hud.population'), used >= cap));
  }

  // The production queues (and the builders' constructions) are shown by QueueFrame (src/ui/QueueFrame.js)

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
    const show = hasOptions; // nothing to choose: no panel (the queues have their own frame, QueueFrame)
    if (this.el.prod.hidden === show) { this.el.prod.hidden = !show; this.layoutDirty = true; }
    if (!show) return;
    const before = this.optionGrid.signature;
    this.optionGrid.show(page);
    if (this.optionGrid.signature !== before) this.layoutDirty = true; // tabs may have changed the height
  }

  // ---------- bottom left: command grid ----------

  /** Overlays the fixed layout of one unit kind onto cmdSlots */
  #addKind(kind) {
    const layout = HUD.commandGrid.layouts[kind];
    for (let i = 0; i < layout.length; i++) if (layout[i]) this.cmdSlots[i] = layout[i];
  }

  /**
   * Formation mode of the selected own units: the majority (a tie goes to the earlier mode); null = no group
   * ([A7b] fewer than FORMATION.minGroupSize own units – the formation slot stays empty)
   */
  #selectionFormation() {
    const counts = this.fmCounts;
    counts.fill(0);
    let total = 0;
    const input = this.input;
    total += this.#countFormations(input.selectedMechs, counts);
    total += this.#countFormations(input.selectedCrews, counts);
    total += this.#countFormations(input.selectedVehicles, counts);
    if (total < FORMATION.minGroupSize) return null;
    let best = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
    return FORMATION.modes[best];
  }

  /** Adds the formation modes of `list` to `counts` (no temporary arrays); returns the number of units */
  #countFormations(list, counts) {
    const modes = FORMATION.modes;
    const fallback = modes.indexOf(FORMATION.defaultMode);
    for (let i = 0; i < list.length; i++) {
      const k = modes.indexOf(list[i].formation);
      counts[k < 0 ? fallback : k]++;
    }
    return list.length;
  }

  #renderCommandGrid() {
    const enabled = this.input.commands;
    const formation = this.#selectionFormation();
    const stance = this.input.stance;
    const behaviour = this.input.behaviour;
    const repairing = this.input.repairing;
    // Fixed per-kind layouts (HUD.commandGrid.layouts) overlaid slot by slot for the selected kinds
    const grid = this.cmdSlots;
    grid.fill(null);
    const input = this.input;
    if (input.selectedMechs.length) this.#addKind('mech');
    if (input.selectedCrews.length) this.#addKind('crew');
    for (const v of input.selectedVehicles) {
      this.#addKind('vehicle');
      if (v.repairer) this.#addKind('repairVehicle');
      if (v.canAttack) this.#addKind('combatVehicle');
    }
    if (input.selectedOwnStructures.length) this.#addKind('structure');
    // [H1] conditional commands (e.g. wallGate) leave their slot empty while disabled
    const hidden = HUD.commandGrid.hiddenWhenDisabled;
    for (let i = 0; i < grid.length; i++) if (grid[i] && !enabled[grid[i]] && hidden.includes(grid[i])) grid[i] = null;
    // [A7b] the formation button exists only for a group (>= FORMATION.minGroupSize own units); its slot stays empty otherwise
    if (formation === null) for (let i = 0; i < grid.length; i++) if (grid[i] === 'formation') grid[i] = null;
    // Rebuild the items only when the "signature" changed (slot names, enabled flags, stance, behaviour, repairing, pending, language)
    const sig = this.cmdSig;
    const pending = input.pending;
    const lang = getLanguage();
    let changed = sig.repairing !== repairing || sig.stance !== stance || sig.behaviour !== behaviour
      || sig.pending !== pending || sig.lang !== lang || sig.formation !== formation;
    for (let i = 0; i < grid.length; i++) {
      const name = grid[i];
      const en = name === 'formation' ? formation !== null : name ? Boolean(enabled[name]) : false;
      if (sig.names[i] !== name || sig.enabled[i] !== en) { changed = true; sig.names[i] = name; sig.enabled[i] = en; }
    }
    if (!changed) return;
    sig.formation = formation; sig.repairing = repairing; sig.stance = stance; sig.behaviour = behaviour; sig.pending = pending; sig.lang = lang;
    const items = this.cmdItems;
    for (let i = 0; i < grid.length; i++) {
      const name = grid[i];
      if (!name) { items[i] = null; continue; }
      const key = KEYBINDINGS[name]?.[0];
      // The repair button turns into "stop repair" while the selected mechs are being repaired
      const look = name === 'repair' && repairing ? 'stopRepair' : name;
      const isFormation = name === 'formation';
      const label = isFormation && formation ? t(`formation.${formation}`) : t(`cmd.${look}`); // shows the current mode
      const keyText = key ? keyLabel(key) : '';
      const it = this.cmdItemPool[i];
      // Long key names (Delete) are not drawn in the corner – they would be a second text next to the label; the tooltip has them
      it.icon = HUD.commandIcons[look] ?? '';
      it.label = label;
      it.hotkey = keyText.length > HUD.commandGrid.hotkeyMaxLength ? '' : keyText;
      it.tip = t(`cmd.${look}.tip`) + (key ? ` [${keyText}]` : '');
      it.disabled = isFormation ? formation === null : !enabled[name];
      it.on = (isFormation && formation !== null && formation !== FORMATION.defaultMode)
        || (name === 'stanceRanged' && stance === 'ranged') || (name === 'stanceMelee' && stance === 'melee')
        || (BEHAVIOUR_CELLS[name] !== undefined && BEHAVIOUR_CELLS[name] === behaviour);
      it.pending = TARGETED_ORDERS.includes(name) && pending === name;
      items[i] = it;
    }
    this.commandGrid.show(this.cmdView);
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
      // drill trucks: a mining truck keeps its harvest order, so no order = standing
      const drillIdle = v.team === localTeam() && !v.dead && !!v.harvester && !v.order;
      this.idleDrillTime.set(v, drillIdle ? (this.idleDrillTime.get(v) ?? 0) + dt : 0);
    }
  }

  // The idle lists are read several times per refresh: one recycled array per class (valid until the next read)
  get idleDrills() {
    const out = (this.idleDrillList ??= []);
    out.length = 0;
    const team = localTeam();
    for (const v of this.world.vehicles) {
      if (v.team === team && !v.dead && !!v.harvester && (this.idleDrillTime.get(v) ?? 0) >= IDLE_DRILL.minIdleTime) out.push(v);
    }
    return out;
  }

  get idleBuilders() {
    const out = (this.idleBuilderList ??= []);
    out.length = 0;
    const team = localTeam();
    for (const v of this.world.vehicles) {
      if (v.team === team && !v.dead && v.canConstruct && (this.idleBuilderTime.get(v) ?? 0) >= IDLE_BUILDER.minIdleTime) out.push(v);
    }
    return out;
  }

  get idleCrews() {
    const out = (this.idleCrewList ??= []);
    out.length = 0;
    const team = localTeam();
    for (const c of this.world.crews) {
      if (c.team === team && !c.dead && !c.inside && (this.idleTime.get(c) ?? 0) >= HUD.idleCrew.minIdleTime) out.push(c);
    }
    return out;
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
    const drills = this.idleDrills.length;
    this.el.idleDrill.hidden = drills === 0;
    this.#set(this.el.idleDrill, `${IDLE_DRILL.icon}<b>${drills}</b>`);
    this.el.idleDrill.title = t('idle.drills.title', { count: drills });
  }

  /** Selects the next idle drill truck (cycles) and centres the camera on it */
  selectNextIdleDrill() {
    const list = this.idleDrills;
    if (!list.length) return;
    this.idleDrillIndex = (this.idleDrillIndex + 1) % list.length;
    const truck = list[this.idleDrillIndex];
    this.input.select(truck);
    this.focus?.(truck.position.clone());
    this.refresh();
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
    setHtmlKeepScroll(el, html); // the grid / summary scrollers (data-scroll-key) must not jump to the top
    return true;
  }
}
