// Steel Men – start menu: title screen, new game setup (faction + team colour per team, fog of war, rules)
// and the Settings screen (SettingsScreen.js). The last new-game choice is kept in the player profile
// (src/core/Profile.js) and handed to the game through onStart(settings). All texts go through i18n.
import { MENU, ECONOMY, AIMENU, GAME_SPEED, PLAYERS_UI, AI_PLAYERS, GAME_VERSION, GAME_NAME } from '../config.js';
import { pickAiNames } from '../ai/AiProfiles.js'; // [N6] call signs of computer players
import { avatarHtml, humanAvatarHtml } from './Avatar.js';
import { validPrebuild } from '../game/PreBuild.js'; // [N8] pre-build phase option
import { validStartSet } from '../game/StartSets.js'; // [N15] start set (units a team starts with)
import { getStats } from '../data/Stats.js';
import { oreMultiplierFromSettings } from '../game/OreMultiplier.js'; // [B1]
import { startMultiplierFromSettings } from '../game/StartMultiplier.js'; // [D4]
import { startResearchFromSettings } from '../game/StartResearch.js';
import { optionsHtml, mapSelectHtml, readOptionChange, syncOptions, friendlyFireHtml } from './GameOptions.js'; // [B1]
import { validPopulationCap } from '../game/Economy.js'; // [W5a]
import {
  allianceLetter, ffaAlliances, presetAlliances, normalizeAlliances, hasEnoughAlliances, isAllianceId,
} from '../core/AllianceSetup.js';
import { validCondition, validConditionForSet } from '../game/Victory.js';
import { colorsTooSimilar, firstDistinctColor } from '../core/ColorCheck.js';
import { getNewGame, getSettings, saveNewGame, getAvatarImage } from '../core/Profile.js';
import { onLanguageChange, t } from '../i18n/i18n.js';
import { SettingsScreen } from './SettingsScreen.js';
import { LobbyScreen } from './LobbyScreen.js';
import { loadMapCatalog, validMapId } from '../game/MapCatalog.js'; // [MAPS]
import { cleanPicks } from '../game/MapStarts.js';
import { MapPreview, applyStartPick } from './MapPreview.js';

/** Translated faction description when its descriptionKey exists in the language files, else the raw data text */
function raceDescription(race) {
  const text = race.descriptionKey ? t(race.descriptionKey) : '';
  return text && text !== race.descriptionKey ? text : race.description;
}

const TEAM_PALETTE = MENU.teamPalette;
const FRIENDLY_FIRE_DEFAULTS = MENU.friendlyFire;

/** Saved new-game settings or null (kept for older callers; the data now lives in the profile) */
export const loadSettings = () => getNewGame();

/** Merges a change into the saved new-game settings (e.g. a colour changed later in the game) */
export const saveSettings = (patch) => saveNewGame(patch);

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export class MainMenu {
  /**
   * @param {HTMLElement} el
   * @param {object} opts
   * @param {{key: string, name: string, description?: string, modifiers?: object}[]} opts.races  factions (Stats.raceList)
   * @param {{name: string, color: string}[]} opts.teams                  default team colours (config TEAMS)
   * @param {(settings: {playerCount: number, alliances: number[], races: string[], colors: string[], seats: string[],
   *          aiDifficulty: (string|null)[], friendlyFire: object, fogOfWar: string}) => void} opts.onStart
   *        [N5b] playerCount = 2..teams.length; races / colors / seats / aiDifficulty / alliances have length playerCount,
   *        index = team (seat); seats = 'human' (seat 0) | 'ai'; alliances[team] = alliance id (equal = allies)
   * @param {{createTransport: Function, Lobby: Function}} [opts.multiplayer]  src/net/ API; without it the
   *        Multiplayer button is disabled
   * @param {(startInfo: {settings: object, seats: object[], seed: number, localTeam: number, startAtMs: number},
   *          net: {transport: object, lobby: object}) => void} [opts.onMultiplayerStart]  lobby started a game
   */
  constructor(el, { races, teams, onStart, multiplayer = null, onMultiplayerStart = null, loading = null }) {
    this.el = el;
    this.loading = loading; // [W6] LoadingScreen (src/ui/LoadingScreen.js): shown from Start until onStart / onMultiplayerStart settle
    this.races = races;
    this.teams = teams;
    this.maxPlayers = teams.length; // [N5b] seats of the new-game menu (TEAMS.length)
    this.onStart = onStart;
    this.multiplayer = multiplayer;
    this.onMultiplayerStart = onMultiplayerStart;
    this.mpUnavailable = false; // set when the transport could not be created
    this.lobbyScreen = null;
    this.screen = 'home';
    this.maps = [];           // [MAPS] GameMaps of MAPS.list (loaded below)
    this.preview = null;      // MapPreview of the setup screen
    this.pickSeat = 0;        // seat the next click on a start assigns
    this.settings = this.#initialSettings();
    this.#rerollNames(); // [N6]
    loadMapCatalog().then((maps) => {
      this.maps = maps;
      this.#clampToMap();
      this.#refreshAll();
    });
    this.el.addEventListener('click', (e) => this.#onClick(e));
    this.el.addEventListener('input', (e) => {
      const team = e.target.dataset.customColor;
      if (team !== undefined) this.#setColor(Number(team), e.target.value);
    });
    this.el.addEventListener('change', (e) => {
      const d = e.target.dataset;
      const opt = readOptionChange(e.target); // [B1] game-setting comboboxes
      if (opt) {
        if (opt.key === 'map') this.#setMap(opt.value);
        else {
          this.settings[opt.key] = opt.value;
          if (opt.key === 'startSet') { // a condition the new set cannot play is switched, and the select redrawn (disabled entry)
            this.settings.victory = validConditionForSet(this.settings.victory, opt.value, getStats());
            this.optionsMaps = null;
          }
          this.#refreshRules();
        }
        return;
      }
      if (d.raceSelect !== undefined) { this.settings.races[Number(d.raceSelect)] = e.target.value; this.#refreshTeam(Number(d.raceSelect)); return; }
      if (d.allianceSelect !== undefined) {
        this.settings.alliances[Number(d.allianceSelect)] = Number(e.target.value);
        this.#alliancesMessage('');
        this.#refreshAll();
        return;
      }
      if (d.aiDiffSelect !== undefined) { this.settings.aiDifficulty[Number(d.aiDiffSelect)] = e.target.value; return; }
      const rule = e.target.dataset.rule;
      if (rule === undefined) return;
      this.settings.friendlyFire[rule] = e.target.checked;
      this.#refreshRules();
    });
    this.#render();
    this.show('home');
    onLanguageChange(() => { this.#render(); this.show(this.screen); });
  }

  // Saved choice, validated against the current factions and colour rules
  #initialSettings() {
    const saved = getNewGame() ?? {};
    const keys = this.races.map((r) => r.key);
    const colors = this.teams.map((tm, i) => (isColor(saved.colors?.[i]) ? saved.colors[i].toLowerCase() : tm.color));
    // Saved colours must also obey the similarity rule (the threshold may have changed): fix the later teams
    this.#dedupeColors(colors, colors.length);
    const max = this.maxPlayers;
    const savedCount = Number.isInteger(saved.playerCount) ? saved.playerCount : PLAYERS_UI.defaultPlayerCount;
    return {
      // [N5b] number of players (seats in play); the arrays below always have one entry per possible seat
      playerCount: Math.min(max, Math.max(PLAYERS_UI.minPlayers, savedCount)),
      // [N5b] alliance id of each seat (equal ids = allies); default everybody alone
      alliances: this.teams.map((_, i) => (isAllianceId(saved.alliances?.[i], max) ? saved.alliances[i] : i)),
      races: this.teams.map((_, i) => (keys.includes(saved.races?.[i]) ? saved.races[i] : keys[i % keys.length])),
      colors,
      // Seat of each team in a solo game: seat 0 is the human, every other seat a computer player
      seats: this.teams.map((_, i) => (i === 0 ? 'human' : 'ai')),
      // Difficulty of every team (used only where the seat is 'ai'; remembered in the profile)
      aiDifficulty: this.teams.map((_, i) => (AIMENU.difficulties.includes(saved.aiDifficulty?.[i]) ? saved.aiDifficulty[i] : AIMENU.defaultDifficulty)),
      friendlyFire: Object.fromEntries(Object.entries(FRIENDLY_FIRE_DEFAULTS).map(([k, def]) =>
        [k, typeof saved.friendlyFire?.[k] === 'boolean' ? saved.friendlyFire[k] : def])),
      fogOfWar: MENU.fogModes.includes(saved.fogOfWar) ? saved.fogOfWar : MENU.defaultFogMode,
      victory: validConditionForSet(saved.victory, saved.startSet, getStats()), // VICTORY.conditions id the start set can play
      speed: GAME_SPEED.options.includes(saved.speed) ? saved.speed : GAME_SPEED.default, // [N4] game speed multiplier
      prebuild: validPrebuild(saved.prebuild), // [N8] pre-build phase in minutes (PREBUILD.options, 0 = off)
      startSet: validStartSet(saved.startSet, getStats()), // [N15] stats.json rules.economy.startSetOrder id (default set when unknown)
      // Economy: energy storage cap and deposits that never run out (Economy.js)
      energyCap: ECONOMY.energyCaps.includes(saved.energyCap) ? saved.energyCap : ECONOMY.defaultEnergyCap,
      populationCap: validPopulationCap(saved.populationCap), // [W5a] 100..500 | 'infinite'
      oreMultiplier: oreMultiplierFromSettings(saved), // [B1] 0.5 | 1 | 2 | 4 | 'infinite' (old infiniteDeposits → 'infinite')
      startMultiplier: startMultiplierFromSettings(saved), // [D4] 0.5 | 1 | 2 | 4 | 'infinite' (starting resources)
      startResearch: startResearchFromSettings(saved), // 0 = none | 1 | 2 | 3 (starting research tier)
      // [MAPS] map id (MAPS.list) and picked starts { seat: start index } (validated when the map is known)
      map: validMapId(saved.map),
      startPicks: saved.startPicks && typeof saved.startPicks === 'object' ? { ...saved.startPicks } : {},
    };
  }

  // ---------- [MAPS] map choice, preview, start picks ----------

  #currentMap() { return this.maps.find((m) => m.id === this.settings.map) ?? null; }

  // Seats the chosen map has room for (unknown map: all seats)
  #mapPlayers() { return Math.max(PLAYERS_UI.minPlayers, this.#currentMap()?.players ?? this.maxPlayers); }

  // Player count and picks must fit the map
  #clampToMap() {
    const s = this.settings;
    s.playerCount = Math.min(s.playerCount, this.#mapPlayers(), this.maxPlayers);
    const map = this.#currentMap();
    s.startPicks = map ? cleanPicks(s.startPicks, s.playerCount, map.players) : {};
    if (this.pickSeat >= s.playerCount) this.pickSeat = 0;
    // [B1] alliances must stay valid for the new seat count: when everybody would be in one alliance, everybody plays alone
    const active = s.alliances.slice(0, s.playerCount);
    if (!hasEnoughAlliances(active)) ffaAlliances(s.playerCount)?.forEach((id, i) => { s.alliances[i] = id; });
  }

  #mapBlock() {
    return `
      <div class="setup-map map-select">
        <div class="map-pick" data-role="map-select"></div>
        <div class="map-select-body">
          <div class="map-preview-box" data-role="map-preview"></div>
          <div class="map-side">
            <p class="menu-muted" data-role="map-desc"></p>
            <div class="row-label">${t('setup.map.startPick')}</div>
            <div class="factions" data-role="pick-seats"></div>
            <button class="faction" data-map-random title="${escapeHtml(t('setup.map.randomStarts.hint'))}"><b>${t('setup.map.randomStarts')}</b></button>
            <small class="menu-muted">${t('setup.map.startHint')}</small>
          </div>
        </div>
      </div>`;
  }

  #mountPreview() {
    this.preview?.dispose();
    this.preview = new MapPreview({ onPick: (start) => this.#pickStart(start), title: t('setup.map.startHint') });
    this.el.querySelector('[data-role="map-preview"]')?.appendChild(this.preview.el);
  }

  #pickStart(start) {
    const { picks, nextSeat } = applyStartPick(this.settings.startPicks, this.pickSeat, start, this.settings.playerCount);
    this.settings.startPicks = picks;
    this.pickSeat = nextSeat;
    this.#refreshMap();
  }

  #setMap(id) {
    if (id === this.settings.map) return;
    this.settings.map = validMapId(id);
    this.settings.startPicks = {};
    this.pickSeat = 0;
    this.#clampToMap();
    this.#refreshAll();
  }

  #refreshMap() {
    const desc = this.el.querySelector('[data-role="map-desc"]');
    if (!desc) return;
    const map = this.#currentMap();
    desc.textContent = map?.description ?? '';
    const count = this.settings.playerCount;
    this.el.querySelector('[data-role="pick-seats"]').innerHTML = Array.from({ length: count }, (_, i) => `
      <button class="faction pick-seat${i === this.pickSeat ? ' on' : ''}" data-pick-seat="${i}" title="${escapeHtml(this.#teamName(i))}">
        <span class="team-dot" style="background:${this.settings.colors[i]}"></span><b>${i + 1}</b></button>`).join('');
    this.preview?.setMap(map);
    this.preview?.setMarks(Object.entries(this.settings.startPicks).filter(([seat]) => Number(seat) < count)
      .map(([seat, start]) => ({ start, color: this.settings.colors[seat], label: String(Number(seat) + 1) })));
  }

  // The colours of the first `count` seats must differ clearly: a later colour too close to an earlier one is replaced
  #dedupeColors(colors, count) {
    for (let i = 1; i < count; i++) {
      if (colors.slice(0, i).some((c) => colorsTooSimilar(c, colors[i]))) {
        colors[i] = firstDistinctColor(TEAM_PALETTE.map((p) => p.color), colors.filter((_, j) => j !== i)) ?? colors[i];
      }
    }
  }

  // [N6] A fresh seed per new-game screen: the computer seats (1..max-1) get different call signs, never repeated.
  // The seed is menu state only (not saved); the chosen names travel in onStart (settings.aiNames / avatars).
  #rerollNames() {
    this.aiSeed = Math.floor(Math.random() * AI_PLAYERS.seedRange);
    this.aiIdentities = pickAiNames(this.maxPlayers - 1, this.aiSeed); // seat i (i >= 1) uses [i - 1]
  }

  // Call sign + avatar index of a computer seat, null for seat 0 (the local human)
  #aiIdentity(i) { return i === 0 ? null : (this.aiIdentities[i - 1] ?? null); }

  // Seat 0 is the local human; the others are computer players with a call sign
  #teamName(i) {
    if (i === 0) return getSettings().nickname || t('common.player');
    return this.#aiIdentity(i)?.name ?? t('setup.computer', { n: i });
  }

  // [N5b] Player count and quick alliance layouts
  #playersBlock() {
    const counts = Array.from({ length: this.maxPlayers - PLAYERS_UI.minPlayers + 1 }, (_, k) => PLAYERS_UI.minPlayers + k);
    return `
      <div class="setup-tools players">
        <span class="row-label">${t('setup.playerCount')}</span>
        <div class="factions">${counts.map((n) => `
          <button class="faction" data-player-count="${n}"><b>${n}</b></button>`).join('')}</div>
        <span class="row-label">${t('setup.alliances')}</span>
        <div class="factions">
          <button class="faction" data-alliance-preset="ffa" title="${escapeHtml(t('setup.alliance.ffa.hint'))}"><b>${t('setup.alliance.ffa')}</b></button>
          <button class="faction" data-alliance-preset="team"><b data-role="preset-label"></b></button>
        </div>
      </div>`;
  }

  #refreshPlayers() {
    const count = this.settings.playerCount;
    const fit = this.#mapPlayers(); // [MAPS] a map has room for this many players
    for (const b of this.el.querySelectorAll('[data-player-count]')) {
      b.classList.toggle('on', Number(b.dataset.playerCount) === count);
      b.disabled = Number(b.dataset.playerCount) > fit;
      b.title = b.disabled ? t('setup.map.tooManyPlayers') : '';
    }
    const preset = PLAYERS_UI.presets[count];
    const presetBtn = this.el.querySelector('[data-alliance-preset="team"]');
    if (presetBtn) {
      presetBtn.hidden = !preset;
      if (preset) {
        presetBtn.querySelector('[data-role="preset-label"]').textContent = t(`setup.alliance.${preset.id}`);
        presetBtn.title = t(`setup.alliance.${preset.id}.hint`);
      }
    }
    const active = this.settings.alliances.slice(0, count);
    const ffa = active.every((a, i) => active.indexOf(a) === i);
    const same = preset && normalizeAlliances(active).join() === preset.alliances.join();
    this.el.querySelector('[data-alliance-preset="ffa"]')?.classList.toggle('on', ffa);
    presetBtn?.classList.toggle('on', !!same);
  }

  #setPlayerCount(n) {
    this.settings.playerCount = Math.min(this.maxPlayers, Math.max(PLAYERS_UI.minPlayers, n));
    this.#clampToMap(); // [MAPS]
    this.#dedupeColors(this.settings.colors, this.settings.playerCount);
    this.#alliancesMessage('');
    this.#message('');
    this.#refreshAll();
  }

  #applyAlliancePreset(kind) {
    const count = this.settings.playerCount;
    const layout = kind === 'ffa' ? ffaAlliances(count) : presetAlliances(count);
    if (!layout) return;
    layout.forEach((id, i) => { this.settings.alliances[i] = id; });
    this.#alliancesMessage('');
    this.#refreshAll();
  }

  #alliancesMessage(text) {
    const p = this.el.querySelector('[data-role="alliance-message"]');
    if (!p) return;
    p.textContent = text;
    p.hidden = !text;
  }

  // Game rules block: fog of war + friendly fire master switch + options that only apply while it is on
  #rulesBlock() {
    // [B1] comboboxes (GameOptions.js, drawn again when the map list arrives) + friendly-fire checkboxes
    return `
      <aside class="setup-side">
        <h3>${t('setup.rules')}</h3>
        <div class="setup-options" data-role="options"></div>
        <div class="setup-ff" data-role="ff">${friendlyFireHtml(this.settings.friendlyFire, { attr: 'data-rule' })}</div>
      </aside>`;
  }

  // Syncs the rule controls with the settings; options are disabled while friendly fire is off
  #refreshRules() {
    const ff = this.settings.friendlyFire;
    for (const input of this.el.querySelectorAll('[data-rule]')) {
      input.checked = ff[input.dataset.rule];
      if (input.dataset.rule !== 'enabled') {
        input.disabled = !ff.enabled;
        input.closest('.rule').classList.toggle('disabled', !ff.enabled);
      }
    }
    const box = this.el.querySelector('[data-role="options"]');
    const mapBox = this.el.querySelector('[data-role="map-select"]'); // [W5a] map select above the preview
    if (box) {
      if (this.optionsMaps !== this.maps) { // first draw, or the map catalogue arrived
        this.optionsMaps = this.maps;
        box.innerHTML = optionsHtml(this.settings);
        if (mapBox) mapBox.innerHTML = mapSelectHtml(this.settings, { maps: this.maps });
      }
      syncOptions(box, this.settings);
      if (mapBox) syncOptions(mapBox, this.settings);
    }
  }

  /** Switches the visible screen: 'home' | 'setup' | 'settings' | 'lobby'; false hides the whole menu */
  show(screen) {
    const prev = this.screen;
    const wasHidden = this.el.hidden;
    if (screen) this.screen = screen;
    this.el.hidden = !screen;
    for (const s of this.el.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== screen;
    if (prev === 'lobby' && screen !== 'lobby') this.lobbyScreen?.close(); // leaving the lobby drops the connection
    if (screen === 'setup') this.#refreshAll(); // nickname may have changed in Settings
    if (screen === 'settings') this.settingsScreen?.open();
    if (screen === 'home') this.#refreshMultiplayerButton();
    if (screen === 'lobby' && (prev !== 'lobby' || wasHidden)) this.#openLobby(); // not on a re-render (language change)
  }

  async #openLobby() {
    if (!this.lobbyScreen) { this.show('home'); return; }
    const ok = await this.lobbyScreen.open();
    if (!ok && this.screen === 'lobby') this.show('home'); // onUnavailable already flagged it
  }

  #refreshMultiplayerButton() {
    const btn = this.el.querySelector('[data-action="multiplayer"]');
    const note = this.el.querySelector('[data-role="mp-note"]');
    if (!btn || !note) return;
    const reason = !this.multiplayer ? t('menu.multiplayer.unavailable')
      : this.mpUnavailable ? t('menu.multiplayer.noConnection') : '';
    btn.disabled = !this.multiplayer;
    btn.title = reason;
    note.textContent = reason;
    note.hidden = !reason;
  }

  #render() {
    this.optionsMaps = null; // [B1] the comboboxes are drawn again with the new markup
    this.el.innerHTML = `
      <div class="menu-bg"></div>
      <div class="menu-content">
        <header class="menu-title">
          <h1>${GAME_NAME}</h1>
          <p>${t('menu.title.tagline')}</p>
        </header>

        <nav class="menu-home" data-screen="home">
          <button class="menu-btn primary" data-action="new">${t('menu.newGame')}</button>
          <button class="menu-btn" data-action="multiplayer">${t('menu.multiplayer')}</button>
          <small class="menu-warn" data-role="mp-note" hidden></small>
          <button class="menu-btn" data-action="settings">${t('menu.settings')}</button>
          <small class="menu-version">${t('menu.version', { v: GAME_VERSION })}</small>
        </nav>

        <section class="menu-card settings" data-screen="settings"></section>

        <section class="menu-card lobby" data-screen="lobby"></section>

        <section class="menu-card setup" data-screen="setup">
          <h2>${t('menu.newGame')}</h2>
          <div class="setup-layout">
            <div class="setup-main">
              ${this.#playersBlock()}
              <div class="setup-seats">
                <div class="setup-seat head"><span>${t('setup.player')}</span><span>${t('setup.faction')}</span><span>${t('setup.teamColor')}</span><span>${t('setup.alliance.short')}</span><span>${t('ai.difficulty')}</span></div>
                ${this.teams.map((tm, i) => this.#teamBlock(i)).join('')}
              </div>
              <p class="menu-warn" data-role="color-message" hidden></p>
              <p class="menu-warn" data-role="alliance-message" hidden></p>
              ${this.#mapBlock()}
            </div>
            ${this.#rulesBlock()}
          </div>
          <div class="menu-actions">
            <button class="menu-btn" data-action="home">${t('common.back')}</button>
            <button class="menu-btn primary" data-action="start">${t('menu.start')}</button>
          </div>
        </section>
      </div>`;
    const settingsEl = this.el.querySelector('[data-screen="settings"]');
    if (this.settingsScreen) this.settingsScreen.attach(settingsEl);
    else this.settingsScreen = new SettingsScreen(settingsEl, { onBack: () => this.#settingsBack() });
    this.#mountPreview(); // [MAPS]
    this.#renderLobby();
    this.#refreshAll();
  }

  // The lobby section is rebuilt with the menu (language change); the LobbyScreen object and its connection stay
  #renderLobby() {
    if (!this.multiplayer) return;
    const lobbyEl = this.el.querySelector('[data-screen="lobby"]');
    if (this.lobbyScreen) { this.lobbyScreen.attach(lobbyEl); return; }
    this.lobbyScreen = new LobbyScreen({
      multiplayer: this.multiplayer,
      races: this.races,
      teams: this.teams,
      onStart: (info, net) => { this.#launch(() => this.onMultiplayerStart?.(info, net)); },
      onBack: () => this.show('home'),
      onUnavailable: () => { this.mpUnavailable = true; this.#refreshMultiplayerButton(); if (this.screen === 'lobby') this.show('home'); },
    });
    this.lobbyScreen.attach(lobbyEl);
  }

  /** Settings opened from the in-game menu: shows the Settings screen, calls returnTo when Back is pressed */
  openSettingsFrom(returnTo) {
    this.settingsReturn = returnTo;
    this.show('settings');
  }

  #settingsBack() {
    const returnTo = this.settingsReturn;
    this.settingsReturn = null;
    if (returnTo) { this.show(false); returnTo(); } else this.show('home');
  }

  #refreshAll() {
    this.#refreshPlayers();
    for (let i = 0; i < this.teams.length; i++) this.#refreshTeam(i);
    this.#refreshRules();
    this.#refreshMap(); // [MAPS] seat colours / count shown in the start picker
  }

  #teamBlock(i) {
    const factions = this.races.map((r) => `
      <option value="${escapeHtml(r.key)}" title="${escapeHtml(raceDescription(r) || r.name)}">${escapeHtml(r.name)}</option>`).join('');
    const swatches = TEAM_PALETTE.map((p) => `
      <button class="swatch" data-team="${i}" data-color="${p.color}" title="${escapeHtml(t(p.nameKey))}" style="--c:${p.color}"></button>`).join('');
    return `
      <div class="setup-seat" data-team-block="${i}">
        <div class="seat-player"><span class="team-dot" data-role="dot"></span><span data-role="avatar"></span><b data-role="team-name"></b></div>
        <div class="seat-cell col">
          <select class="seat-select" data-race-select="${i}" aria-label="${escapeHtml(t('setup.faction'))}">${factions}</select>
          <small class="menu-muted" data-role="mods"></small>
        </div>
        <div class="swatches">${swatches}
          <label class="swatch custom" title="${t('setup.customColor')}"><input type="color" data-custom-color="${i}"><span>+</span></label>
        </div>
        <select class="seat-select" data-alliance-select="${i}" title="${escapeHtml(t('setup.alliance.hint'))}" aria-label="${escapeHtml(t('setup.alliance'))}">${Array.from({ length: this.maxPlayers }, (_, id) => `
          <option value="${id}">${escapeHtml(allianceLetter(id))}</option>`).join('')}</select>
        <div class="seat-cell" data-role="ai-block" hidden>
          <select class="seat-select" data-ai-diff-select="${i}" aria-label="${escapeHtml(t('ai.difficulty'))}">${AIMENU.difficulties.map((id) => `
            <option value="${id}" title="${escapeHtml(t(`ai.difficulty.${id}.hint`))}">${t(`ai.difficulty.${id}`)}</option>`).join('')}</select>
        </div>
      </div>`;
  }

  #modifierText(mods = {}) {
    const parts = Object.entries(mods)
      .filter(([, v]) => typeof v === 'number' && v !== 1)
      .map(([k, v]) => {
        const label = t(`mod.${k}`);
        return `${label === `mod.${k}` ? k : label} ${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)} %`;
      });
    return parts.join(' · ') || t('setup.noModifiers');
  }

  #onClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const { action, team, color } = btn.dataset;
    if (btn.disabled) return;
    if (action === 'new') { this.#rerollNames(); this.show('setup'); }
    else if (action === 'multiplayer') this.show('lobby');
    else if (action === 'settings') this.show('settings');
    else if (action === 'home') this.show('home');
    else if (action === 'start') this.#start();
    else if (btn.dataset.pickSeat !== undefined) { this.pickSeat = Number(btn.dataset.pickSeat); this.#refreshMap(); }
    else if (btn.dataset.mapRandom !== undefined) { this.settings.startPicks = {}; this.pickSeat = 0; this.#refreshMap(); }
    else if (btn.dataset.playerCount !== undefined) this.#setPlayerCount(Number(btn.dataset.playerCount));
    else if (btn.dataset.alliancePreset !== undefined) this.#applyAlliancePreset(btn.dataset.alliancePreset);
    else if (color !== undefined) this.#setColor(Number(team), color);
  }

  // Colours of the other seats that take part (the first playerCount seats)
  #otherColors(team) { return this.settings.colors.slice(0, this.settings.playerCount).filter((_, i) => i !== team); }

  // Colours of two players must differ clearly (COLOR_SIMILARITY.minDeltaE): a too similar pick is refused
  #setColor(team, color) {
    if (this.#otherColors(team).some((c) => colorsTooSimilar(c, color))) {
      this.#message(t('setup.colorRefused'));
    } else {
      this.settings.colors[team] = color.toLowerCase();
      this.#message('');
    }
    this.#refreshAll();
  }

  #message(text) {
    const p = this.el.querySelector('[data-role="color-message"]');
    p.textContent = text;
    p.hidden = !text;
  }

  // Highlights the chosen faction and colour of a team; swatches too close to the other team's colour are disabled
  #refreshTeam(i) {
    const block = this.el.querySelector(`[data-team-block="${i}"]`);
    const { races, colors } = this.settings;
    const others = this.#otherColors(i);
    block.hidden = i >= this.settings.playerCount; // [N5b] seats beyond the player count do not exist
    block.querySelector('[data-alliance-select]').value = String(this.settings.alliances[i]);
    block.querySelector('[data-race-select]').value = races[i];
    const race = this.races.find((r) => r.key === races[i]);
    block.querySelector('[data-role="mods"]').textContent = race ? this.#modifierText(race.modifiers) : '';
    const aiBlock = block.querySelector('[data-role="ai-block"]');
    aiBlock.hidden = this.settings.seats[i] !== 'ai';
    block.querySelector('[data-ai-diff-select]').value = this.settings.aiDifficulty[i];
    const preset = TEAM_PALETTE.some((p) => p.color === colors[i]);
    for (const b of block.querySelectorAll('.swatch[data-color]')) {
      b.classList.toggle('on', b.dataset.color === colors[i]);
      const blocked = others.some((c) => colorsTooSimilar(c, b.dataset.color));
      b.classList.toggle('blocked', blocked);
      b.disabled = blocked;
    }
    const custom = block.querySelector('.swatch.custom');
    custom.classList.toggle('on', !preset);
    custom.style.setProperty('--c', preset ? 'transparent' : colors[i]);
    custom.querySelector('input').value = colors[i];
    block.querySelector('[data-role="dot"]').style.background = colors[i];
    block.querySelector('[data-role="team-name"]').textContent = this.#teamName(i);
    const id = this.settings.seats[i] === 'ai' ? this.#aiIdentity(i) : null; // [N6] avatar in the team colour
    block.querySelector('[data-role="avatar"]').innerHTML = id
      ? avatarHtml({ name: id.name, avatar: id.avatar, color: colors[i], size: AI_PLAYERS.avatar.sizes.menu })
      : (i === 0 ? humanAvatarHtml({ image: getAvatarImage(), color: colors[i], size: AI_PLAYERS.avatar.sizes.menu }) : ''); // [UISMALL]
  }

  #start() {
    const n = this.settings.playerCount;
    const alliances = this.settings.alliances.slice(0, n);
    if (!hasEnoughAlliances(alliances)) { // everybody allied: nobody could win
      this.#alliancesMessage(t('setup.alliance.needTwo'));
      return;
    }
    const settings = {
      playerCount: n,
      alliances: normalizeAlliances(alliances), // [N5b] dense ids in order of first appearance
      races: this.settings.races.slice(0, n),
      colors: this.settings.colors.slice(0, n),
      seats: this.settings.seats.slice(0, n),
      aiDifficulty: this.settings.seats.slice(0, n).map((s, i) => (s === 'ai' ? this.settings.aiDifficulty[i] : null)),
      // [N6] call sign / avatar index of every computer seat (null for the human); same indices as seats
      aiNames: this.settings.seats.slice(0, n).map((s, i) => (s === 'ai' ? (this.#aiIdentity(i)?.name ?? null) : null)),
      avatars: this.settings.seats.slice(0, n).map((s, i) => (s === 'ai' ? (this.#aiIdentity(i)?.avatar ?? null) : null)),
      friendlyFire: { ...this.settings.friendlyFire },
      fogOfWar: this.settings.fogOfWar,
      victory: this.settings.victory,
      speed: this.settings.speed, // [N4] game speed multiplier (GAME_SPEED.options)
      prebuild: this.settings.prebuild, // [N8] pre-build minutes (PREBUILD.options, 0 = off)
      startSet: this.settings.startSet, // [N15] start set id
      energyCap: this.settings.energyCap,
      populationCap: this.settings.populationCap, // [W5a]
      oreMultiplier: this.settings.oreMultiplier, // [B1] 0.5 | 1 | 2 | 4 | 'infinite'
      startMultiplier: this.settings.startMultiplier, // [D4] 0.5 | 1 | 2 | 4 | 'infinite'
      startResearch: this.settings.startResearch, // 0 = none | 1 | 2 | 3
      // [MAPS] map id and picked starts { seat: start index }; seats without a pick get one from the seed (MapStarts.js)
      map: this.settings.map,
      startPicks: { ...this.settings.startPicks },
    };
    // The profile keeps the whole menu state (all seats and the raw alliance ids), not only the seats in play
    saveNewGame(this.settings); // saveNewGame clones
    this.#launch(() => this.onStart?.(settings));
  }

  /**
   * [W6] Hides the menu and covers the screen with the loading screen until `start()` (a promise from main.js:
   * the match is built, in multiplayer every player is loaded) settles. Without a loading screen: as before.
   */
  #launch(start) {
    const loading = this.loading;
    loading?.show();
    this.show(false);
    (async () => {
      await loading?.painted; // the overlay is drawn before the heavy work starts
      try { await start(); } finally { loading?.hide(); }
    })().catch((err) => console.error(err));
  }
}
