// Steel Men – multiplayer lobby screen (opened from MainMenu). Talks only to the Lobby API of
// docs/MULTIPLAYER.md (src/net/Lobby.js): create / join, seat list, own faction + colour + ready,
// host game settings, Start. Texts go through t('lobby.*'); styles in lobby.css (loaded by this module).
import { NET, MENU, ECONOMY, VICTORY, LOBBY, AIMENU, GAME_SPEED, PLAYERS_UI, AI_PLAYERS } from '../config.js';
import { cleanAiIdentity } from '../ai/AiProfiles.js'; // [N6]
import { avatarForNetwork, avatarHtml, humanAvatarHtml } from './Avatar.js';
import { validPrebuild } from '../game/PreBuild.js'; // [N8] pre-build phase option
import { validStartSet } from '../game/StartSets.js'; // [N15] start set
import { getStats } from '../data/Stats.js';
import { validConditionForSet } from '../game/Victory.js';
import { oreMultiplierFromSettings } from '../game/OreMultiplier.js'; // [B1]
import { startMultiplierFromSettings } from '../game/StartMultiplier.js'; // [D4]
import { startResearchFromSettings } from '../game/StartResearch.js';
import { optionsHtml, mapSelectHtml, readOptionChange, friendlyFireHtml } from './GameOptions.js'; // [B1]
import { allianceLetter, ffaAlliances, hasEnoughAlliances, normalizeAlliances, presetAlliances } from '../core/AllianceSetup.js';
import { colorsTooSimilar, firstDistinctColor } from '../core/ColorCheck.js';
import { getAvatarImage, getSettings, getLobbyPrefs, saveLobbyPrefs } from '../core/Profile.js';
import { t } from '../i18n/i18n.js';
import { loadMapCatalog, validMapId, validMapChoice, isRandomMap, maxMapPlayers } from '../game/MapCatalog.js'; // [MAPS]
import { cleanPicks } from '../game/MapStarts.js';
import { MapPreview, applyStartPick } from './MapPreview.js';
import { getNetDiagnosis, inArtifact, supportsDirectory } from '../net/transports/index.js';
import { startNetProbe } from '../net/netProbe.js';
import { LobbyDirectory } from '../net/LobbyDirectory.js'; // [LOBBY_LIST] list of public games (P2P only)
import { cleanGameName } from '../net/Lobby.js';

// Network chosen in the lobby inside an artifact ('room' = platform, 'p2p' = WebRTC over Nostr relays, null = default).
// Kept for this page load only (no profile): both players must pick the same one.
let netChoice = null;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
// Seat colours come from other players over the network: only plain #rrggbb may reach a style attribute
const safeColor = (c, fallback) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : fallback);

// lobby.css is a separate file next to this module (no index.html change needed)
try {
  const href = new URL('./lobby.css', import.meta.url).href;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
} catch { /* no DOM / odd URL: the menu still works, just unstyled */ }

export class LobbyScreen {
  /**
   * @param {object} opts
   * @param {{createTransport: Function, Lobby: Function}} opts.multiplayer
   * @param {{key: string, name: string}[]} opts.races
   * @param {{color: string}[]} opts.teams
   * @param {(startInfo: object, net: {transport: object, lobby: object}) => void} opts.onStart
   *        lobby.onStart payload + the still-open transport and lobby (the game needs them for Lockstep)
   * @param {() => void} opts.onBack                     user left the lobby screen
   * @param {() => void} opts.onUnavailable              transport could not be created
   */
  constructor({ multiplayer, races, teams, onStart, onBack, onUnavailable }) {
    this.mp = multiplayer;
    this.races = races;
    this.teams = teams;
    this.onStart = onStart;
    this.onBack = onBack;
    this.onUnavailable = onUnavailable;
    // 'choose' | 'createForm' | 'joinMenu' | 'browse' | 'join' (code) | 'connecting' | 'lobby' | 'error' | 'unavailable'
    this.phase = 'choose';
    this.errorView = 'choose'; // [LOBBY_LIST] phase 'error' shows this view (where the failed attempt started) + the error
    this.form = { name: '', visibility: LOBBY.defaultVisibility, password: '' }; // create form (password never stored)
    this.joinPassword = '';    // code form
    this.browseSel = null;     // browse: locked game picked { key, code, name } (asks for its password)
    this.browsePassword = '';
    this.directory = null;     // LobbyDirectory while the game list is shown
    this.directoryToken = 0;   // bumped when the directory is dropped (a create still in flight is discarded)
    this.directoryPending = false;
    this.directoryFailed = false;
    this.kickArm = null;       // host: player id whose Kick button waits for the confirming second click
    this.error = '';
    this.errorTech = ''; // technical code of the error (room error code, …) shown next to it
    this.failLine = ''; // network line captured when a connection attempt failed (the transport is replaced on retry)
    this.probe = null; // running netProbe ({promise, cancel}) or null
    this.probeResult = null; // last netProbe result (also in diag.probe)
    this.session = 0; // bumped by #teardown: an async step that finds a different value was closed / replaced meanwhile
    this.codeValue = '';
    this.copied = false;
    this.lobby = null;
    this.transport = null;
    this.unsub = null;
    this.renderPending = false;
    // [MAPS] map list, one preview canvas kept across re-renders, seat (lobby team) the next start click assigns
    this.maps = [];
    this.preview = null; // created on demand, disposed with the connection (#teardown)
    this.pickTeam = null;
    loadMapCatalog().then((maps) => { this.maps = maps; this.#render(); });
  }

  attach(el) {
    this.el = el;
    // A re-render while a dropdown / colour picker is open would close it: wait until it loses focus
    el.addEventListener('focusout', () => { if (this.renderPending) setTimeout(() => this.#render(), 0); });
    el.addEventListener('click', (e) => this.#onClick(e));
    el.addEventListener('change', (e) => this.#onChange(e));
    el.addEventListener('input', (e) => {
      const d = e.target.dataset;
      if (d.lbCode !== undefined) this.codeValue = e.target.value;
      else if (d.lbInput === 'name') this.form.name = e.target.value; // [LOBBY_LIST]
      else if (d.lbInput === 'password') this.form.password = e.target.value;
      else if (d.lbInput === 'joinPassword') this.joinPassword = e.target.value;
      else if (d.lbInput === 'browsePassword') this.browsePassword = e.target.value;
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const d = e.target.dataset;
      if (d.lbCode !== undefined || d.lbInput === 'joinPassword') { e.preventDefault(); this.#join(); }
      else if (d.lbInput === 'name' || d.lbInput === 'password') { e.preventDefault(); this.#create(); } // [LOBBY_LIST]
      else if (d.lbInput === 'browsePassword') { e.preventDefault(); this.#joinPicked(); }
    });
    this.#render();
  }

  /** Re-render after a language change (keeps the lobby connection) */
  refresh() { this.#render(); }

  /** Called when the screen is shown. Returns false when multiplayer is unavailable. */
  async open() {
    this.#teardown();
    this.phase = 'choose';
    this.error = '';
    this.errorTech = '';
    this.failLine = '';
    this.codeValue = '';
    this.joinPassword = '';  // [LOBBY_LIST]
    this.browseSel = null;
    this.browsePassword = '';
    this.form.password = '';
    this.errorView = 'choose';
    this.phase = 'connecting'; // no clicks while claude.use / selfId are awaited (up to several seconds)
    this.#render();
    const session = this.session;
    let transport = null;
    try {
      transport = await this.mp.createTransport(netChoice ? { prefer: netChoice } : undefined);
    } catch { transport = null; }
    if (session !== this.session) { try { transport?.dispose?.(); } catch { /* gone */ } return true; } // closed / reopened meanwhile
    this.transport = transport;
    if (inArtifact()) this.#runProbe(); // artifact: always (cheap, answers "why not"); elsewhere only by the button
    if (!this.transport && this.#showUnavailable()) return true; // stay here: the reason is visible
    this.phase = 'choose';
    if (!this.transport) { this.onUnavailable?.(); return false; }
    this.#render();
    return true;
  }

  #runProbe() {
    this.probe?.cancel();
    const probe = startNetProbe({ transport: this.transport });
    this.probe = probe;
    this.probeResult = null;
    this.#render();
    probe.promise.then((result) => {
      if (this.probe !== probe) return; // cancelled / replaced
      this.probe = null;
      this.probeResult = result;
      const diag = this.transport?.diag ?? getNetDiagnosis();
      if (diag) diag.probe = result;
      this.#render();
    });
  }

  // Inside a claude.ai artifact without the room capability: explain instead of bouncing back to the menu
  #showUnavailable() {
    const diag = getNetDiagnosis();
    const reason = diag?.reason;
    if (reason !== 'room-unavailable' && reason !== 'artifact-no-room' && !(reason === 'p2p-unavailable' && inArtifact())) return false;
    this.phase = 'unavailable';
    this.error = '';
    this.#render();
    return true;
  }

  /** Leaves the lobby (if any) and drops the connection */
  close() { this.#teardown(); }

  #teardown() {
    this.session++; // invalidates every await still in flight (open / #connect)
    this.probe?.cancel();
    this.probe = null;
    this.unsub?.();
    this.unsub = null;
    try { this.lobby?.leave(); } catch { /* already gone */ }
    this.lobby = null;
    // P2P: a join still in progress (leaving while 'connecting') must not leave an open room behind
    try { this.transport?.dispose?.(); } catch { /* already gone */ }
    this.transport = null;
    this.#disposePreview();
    this.#disposeDirectory(); // [LOBBY_LIST]
    this.kickArm = null;
  }

  // ---- [LOBBY_LIST] game list: subscribed only while the list is on screen ----
  #isBrowsing() { return this.phase === 'browse' || (this.phase === 'error' && this.errorView === 'browse'); }

  /** Called after every render: starts the directory when the list is shown (P2P), drops it otherwise */
  #syncDirectory() {
    const want = this.#isBrowsing() && supportsDirectory(this.transport);
    if (!want) { this.#disposeDirectory(); return; }
    if (this.directory || this.directoryPending || this.directoryFailed) return;
    this.directoryPending = true;
    const token = this.directoryToken;
    LobbyDirectory.create().then((dir) => {
      if (token !== this.directoryToken) { dir?.dispose(); return; }
      this.directoryPending = false;
      if (!dir) { this.directoryFailed = true; this.#renderBrowseList(); return; }
      this.directory = dir;
      dir.onChange(() => this.#renderBrowseList());
      this.#renderBrowseList();
    });
  }

  #disposeDirectory() {
    this.directoryToken++;
    this.directoryPending = false;
    this.directoryFailed = false;
    this.directory?.dispose();
    this.directory = null;
  }

  #disposePreview() {
    this.preview?.dispose();
    this.preview = null;
  }

  // ---- connection flow ----
  #nickname() { return getSettings().nickname || t('common.player'); }

  async #connect(action) {
    if (!this.transport) return;
    const session = this.session;
    if (this.transport.diag) { delete this.transport.diag.lastLeave; delete this.transport.diag.joinError; }
    const from = this.phase === 'error' ? this.errorView : this.phase; // [LOBBY_LIST] a failure returns to this view
    this.phase = 'connecting';
    this.error = '';
    this.errorTech = '';
    this.failLine = '';
    this.#render();
    try {
      this.lobby = new this.mp.Lobby(this.transport);
      this.unsub = this.lobby.onChange((st) => {
        // [LOBBY_LIST] the host kicked us: leave and say so on the first screen
        if (st?.kicked && this.lobby && !this.lobby.isHost) { this.#fail(new Error(t('lobby.error.kicked')), 'choose'); return; }
        this.#render();
      });
      this.lobby.onStart((info) => {
        // The game takes over the connection: do not leave the lobby here (open()/close() would)
        const net = { transport: this.transport, lobby: this.lobby };
        this.probe?.cancel(); // the game took over: no probe result may redraw the lobby
        this.probe = null;
        this.unsub?.();
        this.unsub = null;
        this.lobby = null;
        this.transport = null;
        this.#disposePreview();
        this.onStart?.(info, net);
      });
      await action(this.lobby);
      if (session !== this.session) return; // closed meanwhile (or the game started: onStart took over)
      this.phase = 'lobby';
    } catch (err) {
      if (session !== this.session) return; // leaving while connecting makes the join fail: nothing to show
      await this.#fail(err, from);
      return;
    }
    this.#render();
  }

  /** A connection attempt failed (or we were kicked): show the error on `view`, drop the connection, new transport */
  async #fail(err, view) {
    this.phase = 'error';
    this.errorView = ['createForm', 'joinMenu', 'browse', 'join'].includes(view) ? view : 'choose';
    // RoomError carries i18nKey + code (not_permitted, limit_reached …); other errors already hold a translated text
    this.error = err?.i18nKey ? t(err.i18nKey) : err?.message ? String(err.message) : t('lobby.error.generic');
    this.errorTech = String(err?.code ?? err?.detail ?? (err?.name === 'P2PError' ? String(err.i18nKey).split('.').pop() : ''));
    this.failLine = this.#netLine(); // what we used and how many peers the room had (before the teardown)
    this.browsePassword = '';
    this.#teardown();
    this.#render();
    const retry = this.session;
    // a failed attempt needs a fresh transport on retry
    let fresh = null;
    try { fresh = await this.mp.createTransport(netChoice ? { prefer: netChoice } : undefined); } catch { fresh = null; }
    if (retry !== this.session) { try { fresh?.dispose?.(); } catch { /* gone */ } return; }
    this.transport = fresh;
    if (!this.transport && this.#showUnavailable()) return;
    if (!this.transport) { this.onUnavailable?.(); return; }
    this.#render();
  }

  // [UISMALL] own picture as a tiny thumbnail for the others ('' = silhouette)
  async #identity() { return { name: this.#nickname(), avatarImg: await avatarForNetwork(getAvatarImage()) }; }

  // [LOBBY_LIST] default game name follows the current nickname (profile name null)
  #defaultGameName() { return cleanGameName(t('lobby.defaultName', { name: this.#nickname() })); }

  #openCreateForm() {
    const prefs = getLobbyPrefs();
    this.form = { name: prefs.name ?? this.#defaultGameName(), visibility: prefs.visibility, password: '' };
    this.phase = 'createForm';
    this.error = '';
    this.#render();
  }

  #create() {
    const def = this.#defaultGameName();
    const typed = cleanGameName(this.form.name);
    // outside P2P 'public' cannot work: the stored choice stays as it was
    saveLobbyPrefs({ name: typed && typed !== def ? typed : null, visibility: supportsDirectory(this.transport) ? this.form.visibility : undefined });
    const opts = { gameName: typed || def, visibility: this.form.visibility, password: this.form.password };
    this.form.password = ''; // used once, never kept
    return this.#connect(async (l) => l.create({ ...(await this.#identity()), ...opts }));
  }

  #join() {
    const code = this.codeValue.trim();
    if (!code) return;
    const password = this.joinPassword;
    this.joinPassword = ''; // used once, never kept
    return this.#connect(async (l) => l.join(code, { ...(await this.#identity()), password }));
  }

  /** Browse: a game row was clicked (locked → ask for the password first) */
  #pickGame(key) {
    const e = this.directory?.entries().find((x) => x.key === key);
    if (!e || !e.compatible || e.full) return;
    if (e.lock) {
      this.browseSel = { key: e.key, code: e.code, name: e.name };
      this.browsePassword = '';
      this.error = '';
      this.#render();
      return;
    }
    this.browseSel = null;
    this.#connect(async (l) => l.join(e.code, { ...(await this.#identity()), password: '' }));
  }

  #joinPicked() {
    const sel = this.browseSel;
    if (!sel) return;
    const password = this.browsePassword;
    this.browsePassword = ''; // used once, never kept
    this.#connect(async (l) => l.join(sel.code, { ...(await this.#identity()), password }));
  }

  // ---- events ----
  #selfId() { return this.transport?.selfId; }
  #seats() { return this.lobby?.state?.seats ?? []; }
  #mySeat() { return this.#seats().find((s) => s.playerId && s.playerId === this.#selfId()); }
  #isHost() { return !!this.lobby?.state && this.lobby.state.hostId === this.#selfId(); }
  #call(fn) { try { Promise.resolve(fn()).catch((e) => this.#setError(e)); } catch (e) { this.#setError(e); } }
  #setError(e) {
    this.error = e?.i18nKey ? t(e.i18nKey) : e?.message ? String(e.message) : t('lobby.error.generic');
    this.errorTech = e?.code ? String(e.code) : '';
    this.#render();
  }

  #onClick(e) {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const d = btn.dataset;
    const lobby = this.lobby;
    switch (d.lb) {
      // [LOBBY_LIST] create form, join menu (list / code), game list
      case 'create': this.#openCreateForm(); break;
      case 'createGo': this.#create(); break;
      case 'visibility':
        if (LOBBY.visibilities.includes(d.value)) {
          this.form.visibility = d.value;
          if (this.phase === 'lobby' && lobby && this.#isHost()) { saveLobbyPrefs({ visibility: d.value }); this.#call(() => lobby.setVisibility(d.value)); }
          else this.#render();
        }
        break;
      case 'joinMenu': this.phase = 'joinMenu'; this.error = ''; this.browseSel = null; this.#render(); break;
      case 'browse': if (supportsDirectory(this.transport)) { this.phase = 'browse'; this.error = ''; this.browseSel = null; this.#render(); } break;
      case 'pickGame': this.#pickGame(d.key); break;
      case 'browseJoin': this.#joinPicked(); break;
      case 'browseCancel': this.browseSel = null; this.browsePassword = ''; this.error = ''; this.#render(); break;
      case 'joinForm': this.phase = 'join'; this.error = ''; this.#render(); break;
      case 'join': this.#join(); break;
      case 'chooseBack': this.phase = 'choose'; this.error = ''; this.#render(); break;
      case 'kick':
        if (!this.#isHost() || !d.id) break;
        if (this.kickArm !== d.id) { this.kickArm = d.id; this.#render(); break; } // first click arms, second kicks
        this.kickArm = null;
        this.#call(() => lobby.kick(d.id));
        break;
      case 'leave': this.probe?.cancel(); this.probe = null; this.#teardown(); this.onBack?.(); break;
      case 'netSwitch': netChoice = netChoice === 'p2p' ? 'room' : 'p2p'; this.open(); break;
      case 'probe': this.#runProbe(); break;
      case 'copy': this.#copy(); break;
      case 'take': this.#call(() => lobby.takeSeat(Number(d.team))); break;
      case 'leaveSeat': this.#call(() => lobby.leaveSeat()); break;
      case 'ready': this.#call(() => lobby.setReady(!this.#mySeat()?.ready)); break;
      // [MAPS] picks travel keyed by the packed seat index (= team in the match), see #packedPicks
      case 'start': this.#call(async () => { await lobby.setSettings({ startPicks: this.#packedPicks() }); return lobby.start(); }); break;
      case 'pickSeat': this.pickTeam = Number(d.team); this.#render(); break;
      case 'randomStarts': this.#setSetting('startPicksByTeam', {}); break;
      case 'race': this.#call(() => lobby.setRace(d.value)); break;
      case 'color': this.#setColor(d.value); break;
      case 'addAi': this.#addAi(Number(d.team)); break;
      case 'removeAi': if (this.#isHost()) this.#call(() => lobby.removeAi(Number(d.team))); break;
      case 'aiColor': this.#setAiColor(Number(d.team), d.value); break;
      // [N5b] seats and alliances (host only)
      case 'openSeat': if (this.#isHost()) this.#call(() => lobby.setSeatOpen(Number(d.team), true)); break;
      case 'closeSeat': if (this.#isHost()) this.#call(async () => { await lobby.setSeatOpen(Number(d.team), false); await this.#ensureAlliances(); }); break;
      case 'alliancePreset': this.#alliancePreset(d.value); break;
      default: break;
    }
  }

  #onChange(e) {
    const d = e.target.dataset;
    const opt = readOptionChange(e.target); // [B1] game-setting comboboxes (host only; disabled for the others)
    if (opt) {
      if (opt.key === 'map') this.#setMap(opt.value);
      else this.#setSetting(opt.key, opt.value);
    } else if (d.lbAlliance !== undefined) {
      if (this.#isHost()) this.#call(() => this.lobby.setSeatAlliance(Number(d.lbAlliance), Number(e.target.value)));
    } else if (d.lbCustom !== undefined) this.#setColor(e.target.value);
    else if (d.lbAiCustom !== undefined) this.#setAiColor(Number(d.lbAiCustom), e.target.value);
    else if (d.lbAiDiff !== undefined && this.#isHost()) this.#call(() => this.lobby.setAi(Number(d.lbAiDiff), { difficulty: e.target.value }));
    else if (d.lbAiRace !== undefined && this.#isHost()) this.#call(() => this.lobby.setAi(Number(d.lbAiRace), { race: e.target.value }));
    else if (d.lbRace !== undefined) this.#call(() => this.lobby.setRace(e.target.value));
    else if (d.lbFf !== undefined) {
      const ff = { ...this.#settings().friendlyFire, [d.lbFf]: e.target.checked };
      this.#setSetting('friendlyFire', ff);
    }
    // [W5a] A select keeps focus after a change, and #render waits while one is focused (it would close the open list):
    // the change then showed only after a click elsewhere. Blur → focusout → the pending render runs now.
    if (e.target.matches?.('select')) e.target.blur();
  }

  // [N5b] Quick alliance layout over the open seats: everybody alone, or the preset of this player count (2 on 2)
  #alliancePreset(kind) {
    if (!this.#isHost()) return;
    const count = this.#seats().filter((s) => s.open).length;
    const layout = kind === 'ffa' ? ffaAlliances(count) : presetAlliances(count);
    if (layout) this.#call(() => this.lobby.setAllianceLayout(layout));
  }

  #setSetting(key, value) {
    if (!this.#isHost()) return;
    this.#call(() => this.lobby.setSettings({ [key]: value }));
  }

  // ---- [MAPS] map choice and start picks (host only; synced through lobby settings: map, startPicksByTeam) ----
  #currentMap() { return this.maps.find((m) => m.id === this.#settings().map) ?? null; }
  // [MP-POLISH] Seats that will really play: open and filled. Empty open seats are dropped at start (Lobby.playingSeats),
  // so picks, their indices and the preview use exactly this list = the packed seat order.
  #openTeams() { return this.#seats().map((s, i) => (s.open && s.controller !== 'open' ? s.team ?? i : null)).filter((x) => x !== null); }
  #isRandom() { return isRandomMap(this.#settings().map); }
  // Random: the seats the biggest map has (the host picks among maps with enough starts at start, see Lobby.start)
  #mapPlayers() {
    if (this.#isRandom()) return maxMapPlayers(this.maps) || this.#seats().length;
    return this.#currentMap()?.players ?? this.#seats().length;
  }

  // Host picks a map: picks are cleared and open seats beyond the map's starts are closed (humans keep theirs)
  #setMap(id) {
    if (!this.#isHost()) return;
    if (isRandomMap(id)) { // [W5a] no preview, no picks; the real map is drawn when the host starts
      this.pickTeam = null;
      this.#call(() => this.lobby.setSettings({ map: id, startPicksByTeam: {} }));
      return;
    }
    const map = this.maps.find((m) => m.id === validMapId(id));
    if (!map) return;
    this.pickTeam = null;
    this.#call(async () => {
      await this.lobby.setSettings({ map: map.id, startPicksByTeam: {} });
      const open = this.#seats().map((s, i) => ({ s, team: s.team ?? i })).filter(({ s }) => s.open);
      const humans = open.filter(({ s }) => s.controller === 'human').length;
      const others = open.filter(({ s }) => s.controller !== 'human');
      for (const { team } of others.slice(Math.max(0, map.players - humans))) await this.lobby.setSeatOpen(team, false);
      await this.#ensureAlliances();
    });
  }

  // [B1] After seats were closed / opened the alliances must still leave two sides: otherwise everybody plays alone
  async #ensureAlliances() {
    const open = this.#seats().filter((s) => s.open);
    if (open.length && !hasEnoughAlliances(open.map((s) => s.alliance))) await this.lobby.setAllianceLayout(ffaAlliances(open.length));
  }

  // Lobby-team picks <-> picks keyed by the index among the open seats (what MapStarts / the match use)
  #indexPicks() {
    const open = this.#openTeams();
    const out = {};
    for (const [team, start] of Object.entries(this.#settings().startPicksByTeam)) {
      const i = open.indexOf(Number(team));
      if (i >= 0) out[i] = start;
    }
    return cleanPicks(out, open.length, this.#currentMap()?.players ?? 0);
  }

  #packedPicks() { return this.#indexPicks(); }

  #pickStart(start) {
    if (!this.#isHost()) return;
    const open = this.#openTeams();
    if (!open.length) return;
    const active = Math.max(0, open.indexOf(this.pickTeam ?? open[0]));
    const { picks, nextSeat } = applyStartPick(this.#indexPicks(), active, start, open.length);
    this.pickTeam = open[nextSeat];
    const byTeam = Object.fromEntries(Object.entries(picks).map(([i, s]) => [open[Number(i)], s]));
    this.#setSetting('startPicksByTeam', byTeam);
  }

  #mapBlock(host) {
    const open = this.#openTeams();
    const active = open.includes(this.pickTeam) ? this.pickTeam : open[0];
    const tooMany = open.length > this.#mapPlayers();
    const seatBtns = host ? open.map((team) => {
      const seat = this.#seats().find((x, i) => (x.team ?? i) === team);
      const color = safeColor(seat?.color, safeColor(this.teams[team]?.color, '#888888'));
      return `<button class="faction pick-seat${team === active ? ' on' : ''}" data-lb="pickSeat" data-team="${team}">
        <span class="team-dot" style="background:${color}"></span><b>${team + 1}</b></button>`;
    }).join('') : '';
    const select = mapSelectHtml(this.#settings(), { maps: this.maps, disabled: !host, random: true });
    if (this.#isRandom()) { // [W5a] Random: no preview and no start picks, just the explanation
      return `
      <div class="setup-map map-select">
        <div class="map-pick">${select}</div>
        <p class="menu-muted">${escapeHtml(t('lobby.map.randomHint'))}</p>
      </div>`;
    }
    return `
      <div class="setup-map map-select">
        <div class="map-pick">${select}</div>
        <div class="map-select-body">
          <div class="map-preview-box" data-role="lb-map-preview"></div>
          <div class="map-side">
            <p class="menu-muted">${escapeHtml(this.#currentMap()?.description ?? '')}</p>
            ${host ? `<div class="row-label">${t('setup.map.startPick')}</div><div class="factions">${seatBtns}</div>
              <button class="faction" data-lb="randomStarts" title="${escapeHtml(t('setup.map.randomStarts.hint'))}"><b>${t('setup.map.randomStarts')}</b></button>
              <small class="menu-muted">${t('setup.map.startHint')}</small>` : ''}
            ${tooMany ? `<p class="menu-warn">${escapeHtml(t('lobby.map.tooManySeats', { n: this.#mapPlayers() }))}</p>` : ''}
          </div>
        </div>
      </div>`;
  }

  // The preview canvas survives innerHTML re-renders: put it back into its box and refresh it
  #mountPreview() {
    const box = this.el?.querySelector('[data-role="lb-map-preview"]');
    if (!box) return;
    this.preview ??= new MapPreview({ onPick: (start) => this.#pickStart(start), title: t('setup.map.startHint') });
    box.appendChild(this.preview.el);
    const open = this.#openTeams();
    const picks = this.#indexPicks();
    const marks = Object.entries(picks).map(([i, start]) => {
      const team = open[Number(i)];
      const seat = this.#seats().find((x, k) => (x.team ?? k) === team);
      return { start, color: safeColor(seat?.color, safeColor(this.teams[team]?.color, '#888888')), label: String(team + 1) };
    });
    this.preview.setMap(this.#currentMap());
    this.preview.setMarks(marks, this.#isHost());
  }

  // Colour rules as in single player: a pick too similar to another seat's colour is refused
  #setColor(color) {
    const mine = this.#mySeat();
    if (!mine) return;
    const others = this.#seats().filter((s) => s !== mine && s.color).map((s) => s.color);
    if (others.some((c) => colorsTooSimilar(c, color))) {
      this.error = t('setup.colorRefused');
      this.#render();
      return;
    }
    this.error = '';
    this.#call(() => this.lobby.setColor(color.toLowerCase()));
  }

  // Host: free seat → computer player with default difficulty, a faction and a colour distinct from the others
  #addAi(team) {
    if (!this.#isHost()) return;
    const taken = this.#seats().filter((s) => s.color).map((s) => s.color);
    const color = firstDistinctColor(MENU.teamPalette.map((p) => p.color), taken) ?? this.teams[team]?.color;
    const race = this.races[team % Math.max(1, this.races.length)]?.key;
    this.error = '';
    this.#call(() => this.lobby.addAi(team, { difficulty: AIMENU.defaultDifficulty, race, color }));
  }

  #setAiColor(team, color) {
    if (!this.#isHost()) return;
    const others = this.#seats().filter((s) => s.team !== team && s.color).map((s) => s.color);
    if (others.some((c) => colorsTooSimilar(c, color))) {
      this.error = t('setup.colorRefused');
      this.#render();
      return;
    }
    this.error = '';
    this.#call(() => this.lobby.setAi(team, { color: color.toLowerCase() }));
  }

  async #copy() {
    const code = this.lobby?.state?.code;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); this.copied = true; } catch { this.copied = false; this.error = t('lobby.copyFailed'); }
    this.#render();
    if (this.copied) setTimeout(() => { this.copied = false; this.#render(); }, LOBBY.copyFeedbackMs);
  }

  // ---- rendering ----
  #settings() {
    const s = this.lobby?.state?.settings ?? {};
    return {
      fogOfWar: s.fogOfWar ?? MENU.defaultFogMode,
      victory: validConditionForSet(s.victory ?? VICTORY.defaultCondition, s.startSet, getStats()),
      energyCap: ECONOMY.energyCaps.includes(s.energyCap) ? s.energyCap : ECONOMY.defaultEnergyCap,
      populationCap: ECONOMY.populationCaps.includes(s.populationCap) ? s.populationCap : ECONOMY.defaultPopulationCap, // [W5a]
      speed: GAME_SPEED.options.includes(s.speed) ? s.speed : GAME_SPEED.default,
      prebuild: validPrebuild(s.prebuild), // [N8]
      startSet: validStartSet(s.startSet, getStats()), // [N15] host's choice shown to everyone; the host sends it in the start message
      oreMultiplier: oreMultiplierFromSettings(s), // [B1]
      startMultiplier: startMultiplierFromSettings(s), // [D4]
      startResearch: startResearchFromSettings(s),
      friendlyFire: { ...MENU.friendlyFire, ...(s.friendlyFire ?? {}) },
      map: validMapChoice(s.map), // [MAPS] map id or 'random' [W5a]
      startPicksByTeam: s.startPicksByTeam && typeof s.startPicksByTeam === 'object' ? s.startPicksByTeam : {},
    };
  }

  #render() {
    if (!this.el) return;
    const active = document.activeElement;
    if (this.phase === 'lobby' && active && this.el.contains(active) && active.matches('select, input[type="color"]')) {
      this.renderPending = true;
      return;
    }
    this.renderPending = false;
    const views = {
      choose: () => this.#viewChoose(),
      createForm: () => this.#viewCreateForm(), // [LOBBY_LIST]
      joinMenu: () => this.#viewJoinMenu(),
      browse: () => this.#viewBrowse(),
      join: () => this.#viewJoin(),
      connecting: () => this.#viewStatus(t('lobby.status.connecting'), true),
      lobby: () => this.#viewLobby(),
      unavailable: () => this.#viewUnavailable(),
    };
    const body = (this.phase === 'error' ? views[this.errorView] ?? views.choose : views[this.phase])();
    this.el.innerHTML = `<h2>${t('lobby.title')}</h2>${body}${this.#netDiagHtml()}`;
    if (this.phase === 'lobby') this.#mountPreview(); // [MAPS]
    if (this.phase === 'join') this.el.querySelector('[data-lb-code]')?.focus();
    if (this.phase === 'createForm') this.el.querySelector('[data-lb-input="name"]')?.focus();
    if (this.#isBrowsing() && this.browseSel) this.el.querySelector('[data-lb-input="browsePassword"]')?.focus();
    this.#syncDirectory(); // [LOBBY_LIST]
  }

  // ---- [LOBBY_LIST] create form, join menu, game list ----

  /** Visibility buttons (create form and host lobby header); 'public' needs the P2P game list */
  #visibilityButtons(current) {
    const p2p = supportsDirectory(this.transport);
    return LOBBY.visibilities.map((v) => {
      const off = v === 'public' && !p2p;
      return `<button class="faction${v === current ? ' on' : ''}" data-lb="visibility" data-value="${v}" aria-pressed="${v === current}"
        title="${escapeHtml(t(off ? 'lobby.list.p2pOnly' : `lobby.visibility.${v}.hint`))}"${off ? ' disabled' : ''}><b>${t(`lobby.visibility.${v}`)}</b></button>`;
    }).join('');
  }

  #viewCreateForm() {
    const p2p = supportsDirectory(this.transport);
    return `
      <div class="lobby-form">
        <label class="row-label" for="lobby-name">${t('lobby.form.name')}</label>
        <input id="lobby-name" class="lobby-text" data-lb-input="name" type="text" maxlength="${LOBBY.nameMaxLength}"
          autocomplete="off" spellcheck="false" value="${escapeHtml(this.form.name)}">
        <div class="row-label">${t('lobby.form.visibility')}</div>
        <div class="factions lobby-visibility">${this.#visibilityButtons(p2p ? this.form.visibility : 'code')}</div>
        ${p2p ? '' : `<small class="menu-muted">${escapeHtml(t('lobby.list.p2pOnly'))}</small>`}
        <label class="row-label" for="lobby-pass">${t('lobby.form.password')}</label>
        <input id="lobby-pass" class="lobby-text" data-lb-input="password" type="password" maxlength="${LOBBY.passwordMaxLength}"
          autocomplete="off" spellcheck="false" value="${escapeHtml(this.form.password)}"${p2p ? '' : ' disabled'}>
        <small class="menu-muted">${escapeHtml(t(p2p ? 'lobby.form.passwordHint' : 'lobby.form.passwordP2pOnly'))}</small>
      </div>
      ${this.#errorLine()}
      <div class="menu-actions">
        ${this.#backBtn('chooseBack')}
        <button class="menu-btn primary" data-lb="createGo">${t('lobby.form.create')}</button>
      </div>`;
  }

  #viewJoinMenu() {
    const p2p = supportsDirectory(this.transport);
    return `
      ${this.#errorLine()}
      <div class="lobby-choose">
        <button class="menu-btn${p2p ? ' primary' : ''}" data-lb="browse"${p2p ? '' : ` disabled title="${escapeHtml(t('lobby.list.p2pOnly'))}"`}>${t('lobby.list')}</button>
        <button class="menu-btn" data-lb="joinForm">${t('lobby.joinByCode')}</button>
      </div>
      ${p2p ? '' : `<small class="menu-muted">${escapeHtml(t('lobby.list.p2pOnly'))}</small>`}
      <div class="menu-actions">${this.#backBtn('chooseBack')}</div>`;
  }

  #viewBrowse() {
    const sel = this.browseSel;
    const ask = sel ? `
      <div class="lobby-form lobby-pass-ask">
        <label class="row-label" for="lobby-browse-pass">${escapeHtml(t('lobby.list.passwordFor', { name: sel.name }))}</label>
        <input id="lobby-browse-pass" class="lobby-text" data-lb-input="browsePassword" type="password" maxlength="${LOBBY.passwordMaxLength}"
          autocomplete="off" spellcheck="false" value="${escapeHtml(this.browsePassword)}">
        <div class="lobby-buttons">
          <button class="menu-btn" data-lb="browseCancel">${t('common.back')}</button>
          <button class="menu-btn primary" data-lb="browseJoin">${t('lobby.joinGo')}</button>
        </div>
      </div>` : '';
    return `
      <div class="lobby-browse" data-role="lb-browse-list" aria-live="polite">${this.#browseListHtml()}</div>
      ${ask}
      ${this.#errorLine()}
      <div class="menu-actions">${this.#backBtn('joinMenu')}</div>`;
  }

  /** Only the list part is redrawn on directory updates (inputs of the password prompt keep focus and text) */
  #renderBrowseList() {
    if (!this.#isBrowsing()) return;
    const box = this.el?.querySelector('[data-role="lb-browse-list"]');
    if (box) box.innerHTML = this.#browseListHtml();
  }

  #mapLabel(id) {
    if (isRandomMap(id)) return t('setup.map.random');
    return this.maps.find((m) => m.id === id)?.name ?? id;
  }

  #browseListHtml() {
    const status = (key) => `<p class="lobby-status" role="status">${key === 'lobby.list.searching' ? '<span class="lobby-spinner" aria-hidden="true"></span>' : ''}${escapeHtml(t(key))}</p>`;
    if (!supportsDirectory(this.transport)) return status('lobby.list.p2pOnly');
    if (this.directoryFailed) return status('lobby.list.offline');
    const dir = this.directory;
    if (!dir) return status('lobby.list.searching');
    const list = dir.entries();
    const state = dir.state();
    if (!list.length) return status(state === 'offline' ? 'lobby.list.offline' : state === 'open' ? 'lobby.list.empty' : 'lobby.list.searching');
    const head = `<div class="lobby-game head"><span>${t('lobby.list.col.name')}</span><span>${t('lobby.list.col.host')}</span><span>${t('setup.map')}</span><span>${t('lobby.list.col.players')}</span><span></span></div>`;
    const rows = list.map((e) => {
      const off = !e.compatible || e.full;
      const why = !e.compatible ? t('lobby.list.otherVersion', { build: e.build }) : e.full ? t('lobby.list.full') : '';
      const sel = this.browseSel?.key === e.key;
      return `<button class="lobby-game${off ? ' off' : ''}${sel ? ' on' : ''}" data-lb="pickGame" data-key="${escapeHtml(e.key)}"${off ? ' disabled' : ''}
          title="${escapeHtml(why || e.name)}">
        <b>${escapeHtml(e.name)}</b><span>${escapeHtml(e.host || t('common.player'))}</span><span>${escapeHtml(this.#mapLabel(e.map))}</span>
        <span>${e.n}/${e.max}</span><span class="lobby-lock" ${e.lock ? `title="${escapeHtml(t('lobby.locked'))}"` : 'aria-hidden="true"'}>${e.lock ? '🔒' : ''}</span>
      </button>`;
    }).join('');
    return `<div class="lobby-games" role="list">${head}${rows}</div>`;
  }

  #errorLine() {
    const tech = this.errorTech ? ` [${this.errorTech}]` : '';
    return `<p class="menu-warn" role="alert"${this.error ? '' : ' hidden'}>${escapeHtml(this.error + tech)}</p>`;
  }

  // ---- network diagnostics (transports/index.js getNetDiagnosis): small line "Network: room · id ab12… · connected" ----
  #netLine() {
    const diag = this.transport?.diag ?? getNetDiagnosis();
    if (!diag) return '';
    const parts = [`${t('lobby.net.label')}: ${diag.chosen ?? t('lobby.net.none')}`];
    const id = this.transport?.selfId;
    if (diag.chosen === 'room') parts.push(id ? t('lobby.net.id', { id: String(id).slice(0, NET.diagIdChars) }) : t('lobby.net.noId'));
    if (diag.chosen === 'room' && diag.connected !== undefined) parts.push(t(diag.connected ? 'lobby.net.connected' : 'lobby.net.disconnected'));
    if (diag.roomError) parts.push(t('lobby.net.code', { code: diag.roomError }));
    if (diag.chosen === null) parts.push(t('lobby.net.code', { code: `room ${diag.room}${diag.reason ? `, ${diag.reason}` : ''}${diag.p2pError ? `, ${diag.p2pError}` : ''}` }));
    if (diag.prefer === 'p2p' || diag.prefer === 'room') parts.push(t('lobby.net.choice', { net: diag.prefer }));
    if (diag.lastLeave && this.phase === 'error') parts.push(t('lobby.net.peersSeen', { n: diag.lastLeave.peers }));
    return parts.join(' · ');
  }

  // Result of the network test as one technical line (relays ok/total, WebRTC candidates, db state, guest flag)
  #probeLine() {
    if (this.probe) return t('lobby.net.probe.running');
    const p = this.probeResult;
    if (!p) return '';
    const r = p.relays;
    const relayFail = r.blocked ? ` blocked ${r.blocked}` : '';
    const webrtc = p.webrtc.state === 'ok' ? `host ${p.webrtc.host}/srflx ${p.webrtc.srflx}` : `${p.webrtc.state}${p.webrtc.error ? ` ${p.webrtc.error}` : ''}`;
    return t('lobby.net.probe.line', { relays: `${r.ok}/${r.total}${relayFail}`, webrtc, db: p.db.state, guest: String(p.guest) });
  }

  #netDiagHtml() {
    const line = (this.phase === 'error' && this.failLine) || this.#netLine();
    const probe = this.#probeLine();
    // controls only before a game is chosen: switch of the network (artifact) and the network test button
    const controls = ['choose', 'error', 'unavailable'].includes(this.phase) ? `
      <div class="lobby-net-tools">
        ${inArtifact() ? `<button class="menu-btn" data-lb="netSwitch" title="${escapeHtml(t('lobby.net.switchHint'))}">${t(netChoice === 'p2p' ? 'lobby.net.useRoom' : 'lobby.net.useP2p')}</button>` : ''}
        <button class="menu-btn" data-lb="probe"${this.probe ? ' disabled' : ''}>${t('lobby.net.probe.button')}</button>
      </div>
      ${inArtifact() ? `<small class="menu-muted">${escapeHtml(t('lobby.net.switchHint'))}</small>` : ''}` : '';
    if (!line && !probe && !controls) return '';
    return `<div class="lobby-net-diag menu-muted">${line ? `<p><small>${escapeHtml(line)}</small></p>` : ''}${probe ? `<p><small>${escapeHtml(probe)}</small></p>` : ''}${controls}</div>`;
  }

  // Artifact without a usable network: no silent fallback (a host on `room` would never be found by a P2P guest)
  #viewUnavailable() {
    const key = getNetDiagnosis()?.reason === 'p2p-unavailable' ? 'lobby.error.p2pUnavailable' : 'lobby.error.roomUnavailable';
    return `
      <p class="menu-warn" role="alert">${escapeHtml(t(key))}</p>
      <div class="menu-actions">${this.#backBtn()}</div>`;
  }

  #backBtn(action = 'leave') {
    return `<button class="menu-btn" data-lb="${action}">${t(action === 'leave' ? 'lobby.leave' : 'common.back')}</button>`;
  }

  // [LOBBY_LIST] game name on top; the host also sees the lock and switches the visibility
  #lobbyHeader(st, host) {
    const name = cleanGameName(st.name);
    if (!name && !host) return '';
    const lock = host && this.lobby?.locked ? `<span class="lobby-lock" title="${escapeHtml(t('lobby.locked'))}" aria-label="${escapeHtml(t('lobby.locked'))}">🔒</span>` : '';
    const vis = host ? `
      <div class="lobby-visibility-box">
        <span class="row-label">${t('lobby.form.visibility')}</span>
        <div class="factions lobby-visibility">${this.#visibilityButtons(this.lobby?.visibility ?? 'code')}</div>
      </div>` : '';
    return `<div class="lobby-title-row"><h3 class="lobby-name">${escapeHtml(name)}</h3>${lock}${vis}</div>`;
  }

  #viewStatus(text, busy) {
    return `<p class="lobby-status" role="status" aria-live="polite">${busy ? '<span class="lobby-spinner" aria-hidden="true"></span>' : ''}${escapeHtml(text)}</p>
      <div class="menu-actions">${this.#backBtn()}</div>`;
  }

  #viewChoose() {
    return `
      <p class="menu-muted">${t('lobby.intro')}</p>
      ${this.#errorLine()}
      <div class="lobby-choose">
        <button class="menu-btn primary" data-lb="create">${t('lobby.create')}</button>
        <button class="menu-btn" data-lb="joinMenu">${t('lobby.join')}</button>
      </div>
      <div class="menu-actions">${this.#backBtn()}</div>`;
  }

  #viewJoin() {
    return `
      <label class="row-label" for="lobby-code">${t('lobby.codeLabel')}</label>
      <input id="lobby-code" class="lobby-code" data-lb-code type="text" maxlength="${LOBBY.codeMaxLength}"
        autocomplete="off" autocapitalize="characters" spellcheck="false" value="${escapeHtml(this.codeValue)}"
        placeholder="${escapeHtml(t('lobby.codePlaceholder'))}">
      ${supportsDirectory(this.transport) ? `<div class="lobby-form">
        <label class="row-label" for="lobby-join-pass">${t('lobby.form.joinPassword')}</label>
        <input id="lobby-join-pass" class="lobby-text" data-lb-input="joinPassword" type="password" maxlength="${LOBBY.passwordMaxLength}"
          autocomplete="off" spellcheck="false" value="${escapeHtml(this.joinPassword)}">
      </div>` : ''}
      ${this.#errorLine()}
      <div class="menu-actions">
        ${this.#backBtn('joinMenu')}
        <button class="menu-btn primary" data-lb="join">${t('lobby.joinGo')}</button>
      </div>`;
  }

  #viewLobby() {
    const st = this.lobby?.state;
    if (!st) return this.#viewStatus(t('lobby.status.connecting'), true);
    const host = this.#isHost();
    const mine = this.#mySeat();
    const seats = st.seats ?? [];
    const problem = this.lobby.startProblem(); // [N5b] i18n key of what is missing (open seats, ready, alliances) or null
    const playing = seats.filter((s) => s.open && s.controller !== 'open').length; // [MP-POLISH] empty open seats are dropped at start
    const skipped = seats.filter((s) => s.open && s.controller === 'open').length;
    const tooMany = playing > this.#mapPlayers(); // [MAPS] more filled seats than the map has starts
    const canStart = host && !problem && !tooMany;
    const hostGone = !!(st.hostLeft || st.closed);

    let status;
    if (hostGone) status = t('lobby.status.hostLeft');
    else if (problem) status = t(problem);
    else if (skipped) status = t(host ? 'lobby.status.canStartSkip' : 'lobby.status.waitHostSkip', { n: skipped }); // [MP-POLISH]
    else status = host ? t('lobby.status.canStart') : t('lobby.status.waitHost');

    const code = st.code ? `
      <div class="lobby-code-box">
        <span class="row-label">${t('lobby.codeShare')}</span>
        <output class="lobby-code-value" aria-label="${escapeHtml(t('lobby.codeLabel'))}">${escapeHtml(st.code)}</output>
        <button class="menu-btn lobby-copy" data-lb="copy">${t(this.copied ? 'lobby.copied' : 'lobby.copy')}</button>
      </div>` : '';

    // [B1] seat grid left, game settings (comboboxes) right, Leave bottom left, Start bottom right
    return `
      ${this.#lobbyHeader(st, host)}
      ${code}
      <div class="setup-layout">
        <div class="setup-main">
          ${host ? this.#presetBar(seats) : ''}
          <div class="setup-seats" role="list">
            <div class="setup-seat head with-actions"><span>${t('setup.player')}</span><span>${t('setup.faction')}</span><span>${t('setup.teamColor')}</span><span>${t('setup.alliance.short')}</span><span>${t('lobby.state')}</span><span></span></div>
            ${seats.map((s, i) => this.#seatRow(s, i, mine, host)).join('')}
          </div>
          ${this.#mapBlock(host)}
        </div>
        ${this.#settingsBlock(host)}
      </div>
      ${this.#errorLine()}
      <p class="lobby-status" role="status" aria-live="polite">${escapeHtml(status)}</p>
      <div class="menu-actions">
        ${this.#backBtn()}
        ${host ? `<button class="menu-btn primary" data-lb="start"${canStart ? '' : ' disabled'}>${t('lobby.start')}</button>` : ''}
      </div>`;
  }

  // [N5b] Host: quick alliance layouts of the open seats (everybody alone, 2 on 2 …)
  #presetBar(seats) {
    const open = seats.filter((s) => s.open);
    const ids = open.map((s) => s.alliance);
    const ffa = ids.every((a, i) => ids.indexOf(a) === i);
    const preset = PLAYERS_UI.presets[open.length];
    const layoutOn = !!preset && normalizeAlliances(ids).join() === preset.alliances.join();
    return `
      <div class="setup-tools lobby-alliances">
        <span class="row-label">${t('setup.alliances')}</span>
        <div class="factions">
          <button class="faction${ffa ? ' on' : ''}" data-lb="alliancePreset" data-value="ffa" title="${escapeHtml(t('setup.alliance.ffa.hint'))}"><b>${t('setup.alliance.ffa')}</b></button>
          ${preset ? `<button class="faction${layoutOn ? ' on' : ''}" data-lb="alliancePreset" data-value="team" title="${escapeHtml(t(`setup.alliance.${preset.id}.hint`))}"><b>${t(`setup.alliance.${preset.id}`)}</b></button>` : ''}
        </div>
      </div>`;
  }

  // [N5b] Closed seat: not in the game; the host can open it
  #closedSeatRow(team, host) {
    const label = t('lobby.seat', { n: team + 1 });
    return `
      <div class="setup-seat with-actions closed" role="listitem" aria-label="${escapeHtml(label)}">
        <div class="seat-player"><span class="lobby-seat-no">${label}</span><i class="menu-muted">${t('lobby.closed')}</i></div>
        <span></span><span></span><span></span><span></span>
        <div class="seat-actions">${host && this.#openTeams().length < this.#mapPlayers() ? `<button class="menu-btn" data-lb="openSeat" data-team="${team}">${t('lobby.openSeat')}</button>` : ''}</div>
      </div>`;
  }

  // [N5b] Host: alliance select of an open seat (the others only see the letter)
  #allianceCell(seat, team, host) {
    if (!host) return `<span class="lobby-tag ally-tag" title="${escapeHtml(t('setup.alliance.hint'))}">${escapeHtml(allianceLetter(seat.alliance ?? team))}</span>`;
    const opts = Array.from({ length: this.#seats().length }, (_, id) => `
      <option value="${id}"${seat.alliance === id ? ' selected' : ''}>${escapeHtml(allianceLetter(id))}</option>`).join('');
    return `<select class="seat-select" data-lb-alliance="${team}" title="${escapeHtml(t('setup.alliance.hint'))}" aria-label="${escapeHtml(t('setup.alliance'))}">${opts}</select>`;
  }

  // Colour cell: swatches (own seat / host's computer seat, `action` = data-lb value + custom attribute) or just the colour
  #colorCell(color, others, action, team) {
    const t0 = team === undefined ? '' : ` data-team="${team}"`;
    const palette = MENU.teamPalette.map((p) => {
      const blocked = others.some((c) => colorsTooSimilar(c, p.color));
      return `<button class="swatch${p.color === color ? ' on' : ''}${blocked ? ' blocked' : ''}" data-lb="${action}"${t0} data-value="${p.color}"
        title="${escapeHtml(t(p.nameKey))}" aria-label="${escapeHtml(t(p.nameKey))}" aria-pressed="${p.color === color}" style="--c:${p.color}"${blocked ? ' disabled' : ''}></button>`;
    }).join('');
    const preset = MENU.teamPalette.some((p) => p.color === color);
    const customAttr = action === 'color' ? 'data-lb-custom' : `data-lb-ai-custom="${team}"`;
    return `<div class="swatches">${palette}
      <label class="swatch custom${preset ? '' : ' on'}" title="${escapeHtml(t('setup.customColor'))}" style="--c:${preset ? 'transparent' : color}">
        <input type="color" ${customAttr} value="${escapeHtml(color)}" aria-label="${escapeHtml(t('setup.customColor'))}"><span>+</span></label></div>`;
  }

  #seatRow(seat, i, mine, host) {
    if (!seat.open) return this.#closedSeatRow(seat.team ?? i, host);
    const isMine = !!mine && seat === mine;
    const taken = seat.controller === 'human' && seat.playerId;
    const team = seat.team ?? i;
    const color = safeColor(seat.color, safeColor(this.teams[team]?.color, '#888888'));
    const raceKey = seat.race ?? this.races[0]?.key;
    const raceName = this.races.find((r) => r.key === raceKey)?.name ?? '';
    const teamLabel = t('lobby.seat', { n: team + 1 });
    let who;
    if (taken) {
      // [UISMALL] picture (own: full stored one, others: thumbnail from their presence) or a head silhouette
      const image = isMine ? getAvatarImage() : this.lobby.avatarOf?.(seat.playerId);
      const head = humanAvatarHtml({ image, color, size: AI_PLAYERS.avatar.sizes.lobby, title: seat.nickname });
      who = `${head}<b>${escapeHtml(seat.nickname || t('common.player'))}</b>
        ${seat.playerId === this.lobby.state.hostId ? `<span class="lobby-tag">${t('lobby.host')}</span>` : ''}
        ${isMine ? `<span class="lobby-tag me">${t('lobby.you')}</span>` : ''}`;
    } else if (seat.controller === 'ai') {
      const diff = AIMENU.difficulties.includes(seat.difficulty) ? seat.difficulty : AIMENU.defaultDifficulty;
      // [N6] call sign + generated avatar chosen by the host (same for everybody); older state without a name: "Computer"
      const id = cleanAiIdentity(seat);
      const badge = id ? avatarHtml({ name: id.name, avatar: id.avatar, color, size: AI_PLAYERS.avatar.sizes.lobby }) : '';
      who = `${badge}<b>${id ? escapeHtml(id.name) : `<i>${t('lobby.ai')}</i>`}</b> <span class="lobby-tag">${t(`ai.difficulty.${diff}`)}</span>`;
    }
    else who = `<i class="menu-muted">${t('lobby.open')}</i>`;

    const raceSelect = (attr) => `<select class="seat-select" ${attr} aria-label="${escapeHtml(t('setup.faction'))}">${this.races.map((r) => `<option value="${escapeHtml(r.key)}"${r.key === raceKey ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}</select>`;
    const dot = `<span class="team-dot" style="background:${color}" aria-hidden="true"></span>`;
    let raceCell = `<span>${escapeHtml(raceName)}</span>`;
    let colorCell = dot;
    let stateCell = '';
    let actions = '';
    if (isMine) {
      const others = this.#seats().filter((s) => s !== seat && s.color).map((s) => safeColor(s.color, null)).filter(Boolean);
      raceCell = raceSelect('data-lb-race');
      colorCell = this.#colorCell(color, others, 'color');
      stateCell = `<span class="${seat.ready ? 'lobby-ok' : 'menu-muted'}">${t(seat.ready ? 'lobby.ready' : 'lobby.notReady')}</span>`;
      actions = `<button class="menu-btn" data-lb="leaveSeat">${t('lobby.leaveSeat')}</button>
        <button class="menu-btn lobby-ready${seat.ready ? ' on' : ''}" data-lb="ready" aria-pressed="${!!seat.ready}">${t(seat.ready ? 'lobby.ready' : 'lobby.notReady')}</button>`;
    } else if (taken) {
      stateCell = `<span class="${seat.ready ? 'lobby-ok' : 'menu-muted'}">${t(seat.ready ? 'lobby.ready' : 'lobby.notReady')}</span>`;
      // [LOBBY_LIST] host: Kick (second click confirms)
      if (host) {
        const armed = this.kickArm === seat.playerId;
        actions = `<button class="menu-btn lobby-kick${armed ? ' armed' : ''}" data-lb="kick" data-id="${escapeHtml(seat.playerId)}"
          title="${escapeHtml(t('lobby.kick.hint'))}">${t(armed ? 'lobby.kick.confirm' : 'lobby.kick')}</button>`;
      }
    } else if (seat.controller === 'ai') {
      const diff = AIMENU.difficulties.includes(seat.difficulty) ? seat.difficulty : AIMENU.defaultDifficulty;
      if (host) {
        const others = this.#seats().filter((s) => s.team !== team && s.color).map((s) => safeColor(s.color, null)).filter(Boolean);
        raceCell = raceSelect(`data-lb-ai-race="${team}"`);
        colorCell = this.#colorCell(color, others, 'aiColor', team);
        stateCell = `<select class="seat-select" data-lb-ai-diff="${team}" aria-label="${escapeHtml(t('ai.difficulty'))}">${AIMENU.difficulties.map((id) => `<option value="${id}" title="${escapeHtml(t(`ai.difficulty.${id}.hint`))}"${id === diff ? ' selected' : ''}>${t(`ai.difficulty.${id}`)}</option>`).join('')}</select>`;
        actions = `<button class="menu-btn" data-lb="removeAi" data-team="${team}">${t('lobby.removeAi')}</button>`;
      } else stateCell = `<span class="lobby-tag">${t(`ai.difficulty.${diff}`)}</span>`;
    } else if (seat.controller === 'open' || !seat.controller) {
      raceCell = '';
      colorCell = '';
      actions = `<button class="menu-btn" data-lb="take" data-team="${team}">${t(mine ? 'lobby.moveSeat' : 'lobby.takeSeat')}</button>
        ${host ? `<button class="menu-btn" data-lb="addAi" data-team="${team}">${t('lobby.addAi')}</button>` : ''}`;
    }
    if (host && !taken) actions += `<button class="menu-btn" data-lb="closeSeat" data-team="${team}">${t('lobby.closeSeat')}</button>`;
    return `
      <div class="setup-seat with-actions${isMine ? ' mine' : ''}" role="listitem" aria-label="${escapeHtml(teamLabel)}">
        <div class="seat-player">${dot}<span class="lobby-seat-no">${teamLabel}</span>${who}</div>
        <div class="seat-cell">${raceCell}</div>
        <div class="seat-cell">${colorCell}</div>
        <div class="seat-cell">${this.#allianceCell(seat, team, host)}</div>
        <div class="seat-cell">${stateCell}</div>
        <div class="seat-actions">${actions}</div>
      </div>`;
  }

  // [B1] Game settings as comboboxes (GameOptions.js) + friendly fire; only the host can change them
  #settingsBlock(host) {
    const s = this.#settings();
    return `
      <aside class="setup-side">
        <h3>${t('setup.rules')}${host ? '' : ` <small class="menu-muted">${t('lobby.hostOnly')}</small>`}</h3>
        <div class="setup-options">${optionsHtml(s, { disabled: !host })}</div>
        <div class="setup-ff">${friendlyFireHtml(s.friendlyFire, { disabled: !host, attr: 'data-lb-ff' })}</div>
      </aside>`;
  }
}
