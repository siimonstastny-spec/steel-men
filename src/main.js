// Steel Men – vstupní bod – SIT
import * as THREE from 'three';
import { createScene } from './core/SceneSetup.js';
import { World } from './game/World.js';
import { ModularMech } from './units/ModularMech.js';
import { Crew } from './units/Crew.js';
import { CommandInput } from './input/CommandInput.js';
import { CameraKeys, initMouseSettings } from './input/CameraKeys.js';
import { installEmbedGuard } from './input/EmbedGuard.js';
import { initGraphics } from './core/Graphics.js';
import { getSettings, getAvatarImage } from './core/Profile.js';
import { applySavedKeybindings } from './ui/SettingsKeybindings.js';
import { t } from './i18n/i18n.js';
import { RobotProduction } from './ui/RobotProduction.js';
import { loadPartCatalog, MECH_SLOTS } from './game/PartStock.js';
import { MainMenu } from './ui/MainMenu.js';
import { FullscreenOffer } from './ui/FullscreenOffer.js'; // [A5] one-time "turn on full screen" offer in a small window
import { Minimap } from './ui/Minimap.js';
import { Hud } from './ui/Hud.js';
import { EdgeScroll } from './ui/EdgeScroll.js';
import { MAP, MENU, PLAYER_TEAM, TEAMS, basicLoadout, ECONOMY, START_LAYOUT, TEST_SCENE, SIM, NET, NET_LEAVE, SEATS, AIMENU, MAP_MODE_ANY, A4_UI } from './config.js';
import { assignStarts } from './game/MapStarts.js';
import { validMapId } from './game/MapCatalog.js';
import { loadStats, raceList, raceName, createUnlocks, getStats, unitStats, crewStats, modelRaceOf, partStats } from './data/Stats.js';
import { commandBus } from './game/commands/CommandBus.js';
import { localTeam, setLocalTeam, isLocal } from './core/LocalPlayer.js';
import { randomSeed } from './core/Rng.js';
import { preloadModels } from './core/AssetLoader.js';
import { LoadingScreen } from './ui/LoadingScreen.js'; // [W6]
import { Economy, validPopulationCap } from './game/Economy.js';
import { loadVehicle } from './units/Aircraft.js'; // aircraft → Aircraft, other vehicles → CombatVehicle loader
import { Structure } from './units/Structure.js';
import { BuildMenu, unitName } from './ui/BuildMenu.js';
import { disposeIconRenderer, initIconRenderer, onIconReady, prewarmBuildingIcons, prewarmUnitIcons, prewarmPartIcons } from './ui/IconRenderer.js';
import { Research } from './game/Research.js';
import { superweaponsFromSettings } from './game/Superweapons.js'; // [A9] match option
import { SuperweaponFx } from './procedural/fx/SuperweaponFx.js'; // [A9/B3] superweapon flight + impact visuals
import { SuperweaponWarnings, RangeRings } from './ui/SuperweaponUi.js'; // [A9-F4a] strike warnings, aura / detection rings
import { ResearchView } from './ui/ResearchView.js';
import { Match } from './game/Match.js';
import { validConditionForSet } from './game/Victory.js';
import { gameSpeed, formatGameTime } from './game/GameSpeed.js';
import { validPrebuild, prebuildSecondsLeft, PREBUILD } from './game/PreBuild.js';
import { MatchUi } from './ui/MatchUi.js';
import { Production } from './game/Production.js';
import { preloadFootprints } from './game/commands/buildCommands.js';
import * as mp from './net/index.js';
import { Chat } from './net/Chat.js'; // [N11]
import { ChatBox } from './ui/ChatBox.js'; // [N11]
import { startLoadouts } from './game/StartLoadouts.js';
import { startSetPlan, validStartSet } from './game/StartSets.js'; // [N15] start sets (units a team starts with)
import { HqBeams } from './game/HqBeams.js';
import { DamageSmokeWiring } from './game/DamageSmokeWiring.js'; // damage smoke on hurt units / buildings (visual)
import { BloodStains } from './game/BloodStains.js'; // [A7] blood stains where crew members die (visual)
import { play as playSound, disposeAudio, unlockAudio, setListenerPosition, setSoundMuted, stopAllSounds, weaponSoundEvent } from './audio/Sound.js'; // [A6] synthesized sounds
import { GameSounds } from './audio/GameSounds.js'; // [A6] announcements (unit ready, research, under attack…)
import { install as installUiSounds } from './audio/UiSounds.js'; // [A6] UI click / hover
import { RallyMarkers } from './ui/RallyMarkers.js';
import { createAi, updateAis, clearAis, aiTickStats } from './ai/index.js';
import { PerfPanel } from './ui/PerfPanel.js'; // [A4] F2 performance overlay
import { setAlliances, normalizeAlliances, startOrder, alliesOf, areAllies, clampPlayerCount } from './game/Alliances.js';
import { installAiConsole } from './ai/aiVsAi.js';
import { installDeterminismConsole } from './debug/DeterminismHarness.js';
import { saveGame, noteMatchStart, startAutosave, stopAutosave, autosaveNow, isRestoring, canRestoreHere } from './game/SaveGame.js'; // [J1]
import { saveStore, scheduleRestore, takeScheduledRestore } from './core/SaveStore.js'; // [J1]
import { SaveLoadView } from './ui/SaveLoadView.js'; // [J2]
import { continueMultiplayer } from './net/MpContinue.js'; // [A2-net] continued saved multiplayer match
import { choiceDialog } from './ui/ChoiceDialog.js'; // [A2-net] host: end a stuck match
import { setPlayerLabels, playerLabel } from './core/PlayerLabels.js';
import { setPingNameResolver } from './ui/Pings.js';
// [N7] ping messages name AI allies by their N6 name, humans "Player N" (lobby nicknames: later)
setPingNameResolver((team) => playerLabel(team) || window.steelMen?.net?.nameOf(team) || t('ping.player', { n: team + 1 })); // [MP-LEAVE] lobby nickname
// Command executors register themselves on import (src/game/commands/CommandBus.js)
import './game/commands/unitCommands.js';
import './game/commands/productionCommands.js';
import './game/commands/matchCommands.js';
import './game/commands/diplomacyCommands.js'; // [B4] sendTribute
import { PlayerStatsBar } from './ui/PlayerStatsBar.js';
import { DiplomacyView } from './ui/DiplomacyView.js';
import './game/commands/stockCommands.js'; // [F1] registers the sellPart command on every client
import { StockWindow } from './ui/StockWindow.js'; // [F1] part stock window (key I, buttons in the part factory / assembly bay)
import { oreMultiplierFromSettings } from './game/OreMultiplier.js';
import { startMultiplierFromSettings } from './game/StartMultiplier.js'; // [D4]
import { startResearchFromSettings, applyStartResearch } from './game/StartResearch.js';
import { EconomyAlerts } from './ui/EconomyAlerts.js'; // [D2]
import { spawnProceduralPreview } from './procedural/ProcPreview.js'; // [N3] prototype, console only
import { spawnRobotPreview, spawnPartCompare, spawnRobotCompare } from './procedural/robots/RobotPreview.js'; // [proc-robot] experiment, console only
import { spawnCrewCompare } from './procedural/crew/CrewPreview.js'; // [B6] GLB vs proc crew, console only
import { loadBuildingStyles } from './procedural/BuildingStyle.js'; // [18A] faction building styles (data/buildingStyles.json)

const { renderer, scene, camera, controls, ground } = createScene(document.getElementById('app'));
// [W6] nothing is drawn behind the main menu: the canvas stays hidden and unrendered until startSimulation()
let worldVisible = false;
renderer.domElement.style.visibility = 'hidden';
const loading = new LoadingScreen();

const world = new World(scene, ground);
const hqBeams = new HqBeams(world); // src/game/HqBeams.js – team-coloured beam above each HQ
// [A9] superweapon visuals: simulation events → SuperweaponFx (visual only; payloads are copied by the fx)
const superweaponFx = new SuperweaponFx(scene);
world.superweapons.on('launch', (e) => superweaponFx.launch(e));
world.superweapons.on('impact', (e) => superweaponFx.impact(e));
let superweaponFxHeadless = false;
applySavedKeybindings();            // remapped keys from the player profile
initGraphics(renderer, scene);      // full / reduced graphics from the profile (live-updates on change)
initMouseSettings(controls);        // mouse sensitivity / invert from the profile
installEmbedGuard();                // iframe (itch.io): keyboard focus, no page scroll / text selection; lives with the page
const cameraKeys = new CameraKeys(camera, controls);
const input = new CommandInput(camera, renderer.domElement, world, { onFocus: (p) => cameraKeys.focus(p), controls }); // right drag = pan
const minimap = new Minimap(world, camera, { onFocus: (p) => cameraKeys.focus(p) }); // #minimap, bottom right
const swWarnings = new SuperweaponWarnings({ world, camera, dom: renderer.domElement }); // [A9-F4a] one for all matches (world is one instance)
let rangeRings = null; // [A9-F4a] aura / detection rings of the local player's selection and placement (per match)
const rallyMarkers = new RallyMarkers({ world, input }); // rally point lines of production buildings
const edgeScroll = new EdgeScroll(camera, controls, renderer.domElement); // cursor at the window edge pans (setting)
// In-game HUD (src/ui/Hud.js); spawnPoint = where the next item of a producer appears (no buildings yet)
const hud = new Hud({
  world, input, camera, dom: renderer.domElement,
  focus: (p) => cameraKeys.focus(p),
  // All production queues (BuildMenu) produce at their building
  spawnPoint: (producer) => game.buildMenu?.spawnPointOf(producer) ?? null,
});

// Settings of the running game from the start menu (races[team] = stats.json race key; playerRace / enemyRace
// = races[0] / races[1], kept for older code). unlocks[team] = production unlocked by salvage research
// (Stats.createUnlocks), empty at start. bases[team] = start position of the team.
// [N5] playerCount = seats in the match (races / bases / unlocks have this length), alliances[team] = alliance id
// (src/game/Alliances.js; everybody alone when the settings have none).
const game = {
  playerRace: null, enemyRace: null, races: [], bases: [], menu: null, unlocks: [],
  buildMenu: null, robotProduction: null, match: null, playerCount: 0, alliances: [],
};
const raceOf = (team) => game.races[team] ?? game.races[0];

const RESTART_KEY = 'steelMen.restart'; // sessionStorage: settings of a solo restart (survives the reload only)
let lastSoloSettings = null;             // settings of the running solo match (for Restart)
const RESTORE_ERROR_KEY = 'steelMen.restoreError'; // [J1] sessionStorage: message of a failed restore, shown after the reload

/** [J1] player text of a failed restore (hash mismatch / incompatible save / anything else) */
function restoreErrorText(err) {
  if (err?.code === 'hash') return t('save.error.hash');
  if (err?.code === 'incompatible') return t(`save.reason.${err.details?.reason ?? 'unknown'}`);
  return t('save.error.generic', { reason: err?.message ?? err });
}
// [J1/J2] save games: restore needs a fresh page (startGame does not tear down a match) → schedule + reload otherwise
const saveGameUi = { ...saveGame, restore: async (save, opts) => {
  if (!canRestoreHere()) { await scheduleRestore(save); window.location.reload(); return new Promise(() => {}); } // continues in showMenu
  try { return await saveGame.restore(save, opts); } catch (err) {
    if (canRestoreHere()) throw err; // failed before the match was set up (incompatible …): the page is still clean
    // a half-replayed match stays on the page → only a reload gives a clean menu (the error text is shown after it)
    if (err?.code !== 'cancelled') {
      try { sessionStorage.setItem(RESTORE_ERROR_KEY, restoreErrorText(err)); } catch { /* the reload still helps */ }
    }
    window.location.reload(); return new Promise(() => {});
  }
} };
function onSaveRestored() {
  game.menu?.show(false);
  lastSoloSettings = null; // a restored match has no menu settings to restart from
  startAutosave();
  world.paused = false;
  matchUi.toggleMenu(); // the restored match waits in the (pausing) game menu
}
const saveView = new SaveLoadView({
  store: saveStore, saveGame: saveGameUi, loading,
  mapName: () => saveGame.matchMapName() ?? '', // [J1] after a menu start and after a restore
  onRestored: onSaveRestored,
});

// Game menu (Esc / ☰) and the end-of-match screen; quit = reload (the start menu remembers the last choice)
const matchUi = new MatchUi({
  saveLoad: saveView, // [J2] Save / Load buttons (single player only)
  teamName: (i) => (playerLabel(i) || (isLocal(i) ? (getSettings().nickname || t('common.player'))
    : t(areAllies(i, localTeam()) ? 'common.ally' : 'common.enemy'))) + ` (${raceName(raceOf(i))})`,
  openSettings: (returnTo) => game.menu?.openSettingsFrom(returnTo),
  quit: async () => { try { await autosaveNow(); } catch (err) { console.error(err); } disposeIconRenderer(); disposeAudio(); window.location.reload(); }, // [J1] autosave on leaving, [B2] icon renderer freed
  // [W5c] solo restart = reload + the last settings with a new seed (startGame does not tear down the previous match)
  restart: () => {
    if (!lastSoloSettings || net) return;
    try { sessionStorage.setItem(RESTART_KEY, JSON.stringify({ ...lastSoloSettings, seed: randomSeed() })); } catch { return; }
    window.location.reload();
  },
  canRestart: () => !!lastSoloSettings,                        // [W5c] only a match started from the menu can restart
  net: () => net,                                              // multiplayer pause goes through the lockstep
  nickname: () => getSettings().nickname || t('common.player'), // "{name} paused the game"
});
input.onGameMenu = () => matchUi.toggleMenu();
// [B4] player score bar above the minimap and the diplomacy menu (U / HUD button)
const nameOf = (team) => playerLabel(team) || (isLocal(team) ? (getSettings().nickname || t('common.player'))
  : window.steelMen?.net?.nameOf?.(team) || t('ping.player', { n: team + 1 }));
const statsBar = new PlayerStatsBar({ nameOf });
const perfPanel = new PerfPanel(); // [A4] measures outside the simulation only (performance.now never feeds the state)
let perfTickMs = -1, perfAiMs = -1, perfTicks = 0, perfLastFrameMs = 0, perfCountFrames = 0; // tick / AI ms summed over the frame, perfTicks = ticks in it
const diplomacy = new DiplomacyView({ nameOf });
const stockWindow = new StockWindow(); // [F1]
input.onStockWindow = () => stockWindow.toggle();
let econAlerts = null; // [D2] no main building / low energy; created at the first match (needs loaded stats)

// Debug handle for the browser console, e.g. steelMen.input.selection, steelMen.game.playerRace
// commandBus: steelMen.commandBus.submit({...}); world.stateHash() / world.rng / world.tick for determinism checks
// startGame(settings): console tests of N players, e.g. steelMen.startGame({ playerCount: 4, alliances: [0, 0, 1, 1], … })
window.steelMen = { renderer, world, input, scene, camera, controls, game, minimap, hud, edgeScroll, commandBus, gameSpeed, startGame, statsBar, diplomacy, loading, stockWindow, saveGame, saveStore, perfPanel, aiTickStats };installAiConsole(); // steelMen.ai.start / fastForward / report / log / stop (AI vs AI test)
installDeterminismConsole(); // [I1] steelMen.det – determinism runs (docs/notes/i1-determinism.md)
window.steelMen.path = { run: (opts) => import('./debug/pathProbe.js').then((P) => P.runPathProbe(opts)) }; // [pathfinding-v2] steelMen.path.run({ only: 'tower' })
window.steelMen.modelBudget = (opts) => import('./procedural/debug/ModelBudget.js').then((B) => B.runModelBudget(opts)); // [B4] model triangle / draw call budget
window.steelMen.sound = { play: playSound, unlock: unlockAudio, stopAll: stopAllSounds, dispose: disposeAudio, weapon: weaponSoundEvent }; // [A6] steelMen.sound.play('shotCannon')
installUiSounds(); // [A6]
const listenerRight = new THREE.Vector3(); // [A6] camera right vector for stereo pan (reused every frame)
// [N3] procedural factory preview: p = await steelMen.spawnProceduralPreview('Y', '#c8302c', {x, y, z}); p.dispose()
window.steelMen.spawnProceduralPreview = (race = 'X', color = '#3a5ccc', pos = { x: 0, y: 0, z: 0 }, opts) =>
  spawnProceduralPreview(scene, pos, race, color, opts);
// [proc-robot] p = await steelMen.spawnRobotPreview('W', '#3a5ccc', {x, y, z}, { combos: 'all', original: true }); p.dispose()
window.steelMen.spawnRobotPreview = (race = 'W', color = '#3a5ccc', pos = { x: 0, y: 0, z: 0 }, opts) =>
  spawnRobotPreview(scene, race, color, pos, opts);
// [B6] GLB (left) vs proc (right) comparisons: p = await steelMen.spawnPartCompare('X', 'legs', ['Recon']); p.dispose()
window.steelMen.spawnPartCompare = (race, slot, sets, pos, opts) => spawnPartCompare(scene, race, slot, sets, pos, opts);
window.steelMen.spawnRobotCompare = (race, combos, pos, opts) => spawnRobotCompare(scene, race, combos, pos, opts);
window.steelMen.spawnCrewCompare = (pos, opts) => spawnCrewCompare(scene, pos, opts);

// Místa pro nové roboty: řady po 5 vedle sebe
// Spawn areas = map start positions (world.map.startPositions): player at 0, enemy at the opposite one
let spawnBase = { x: 0, z: 0, yaw: Math.PI };
let enemyBase = { x: 0, z: -150, yaw: 0 };
let spawnCount = 0;
const mechSpawnAt = (i) => ({ x: spawnBase.x + ((i % 5) - 2) * 30, z: spawnBase.z - Math.floor(i / 5) * 35 });
function nextSpawn() { return mechSpawnAt(++spawnCount); } // 1, 2, 3 -> x = -30, 0, 30

// Crew squads appear at the training area in front of the mechs, in rows of 4
let crewCount = 0;
const crewSpawnAt = (i) => ({ x: spawnBase.x - 24 + (i % 4) * 16, z: spawnBase.z + 28 + Math.floor(i / 4) * 16 });
function nextCrewSpawn() { return crewSpawnAt(crewCount++); }

// ---------- test setup ----------

// Starting robots: loadouts from parts the race may build (src/game/StartLoadouts.js, config LOADOUT)
// Enemy test squad in front of its base, crewed so they fight back; order matches LOADOUT.enemy
const ENEMY_SQUAD_SPOTS = [{ x: -25, z: 0 }, { x: 25, z: 0 }];
// Test scene seats: the test units are set up for team 0 and an enemy at team 1 (who sits at this computer is
// localTeam() – UI code must use that, not these constants)
const ENEMY_TEAM = 1;

// ---------- production spawns (deterministic) ----------

/**
 * Units produced in buildings (World.spawnDeferred): the entity id is reserved at the request and the unit
 * appears SIM.spawnDelayTicks later in front of its building, in request order – the same tick on every client,
 * independent of how fast the model loads. Team and race come from the producing building.
 * Simulation code (production, AI) calls these as world.spawn.mech / crew / vehicle; each returns a Promise of
 * the unit with `.eid` = the reserved id.
 */
const spawners = {
  /** Assembled mech (RobotAssemblyBay) walks out in front of its building */
  mech(loadout, structure) {
    const { team } = structure;
    const race = raceOf(team);
    const n = ++spawnCount;
    return world.spawnDeferred(
      () => new ModularMech(loadout, { name: t('unit.mechName', { n, race: raceName(race) }), team, race }).load(),
      (mech) => { const p = structure.nextSpawnPoint(); return world.addMech(mech, p.x, p.z, p.yaw); },
    );
  },
  /** Trained crew squad in front of the training building */
  crew(structure) {
    const { team } = structure;
    const race = raceOf(team);
    const n = ++crewCount;
    return world.spawnDeferred(
      () => new Crew(race, { name: t('unit.crewName', { n, race: raceName(race) }), nameIndex: n, team }).load(),
      (crew) => { const { x, z, yaw = Math.PI } = structure.nextSpawnPoint(); return world.addCrew(crew, x, z, yaw); },
    );
  },
  /** Produced vehicle (armed ones are CombatVehicles) */
  vehicle(id, structure) {
    const { team } = structure;
    return world.spawnDeferred(
      () => loadVehicle(id, raceOf(team), { team, name: unitName('vehicles', id) }),
      (v) => { const p = structure.nextSpawnPoint(); return world.addVehicle(v, p.x, p.z, p.yaw); },
    );
  },
};
world.spawn = spawners;

/**
 * The same deterministic spawns in the callback shape of Production.js (agent PROD): the spawn point `at`
 * {x, z, yaw} was already taken by the simulation. Wiring: new Production(world, { ..., spawn: productionSpawners }).
 */
const productionSpawners = {
  vehicle: (team, race, id, at) => world.spawnDeferred(
    () => loadVehicle(id, race, { team, name: unitName('vehicles', id) }),
    (v) => world.addVehicle(v, at.x, at.z, at.yaw),
  ),
  crew: (team, race, at) => {
    const n = ++crewCount;
    return world.spawnDeferred(
      () => new Crew(race, { name: t('unit.crewName', { n, race: raceName(race) }), nameIndex: n, team }).load(),
      (crew) => world.addCrew(crew, at.x, at.z, at.yaw ?? Math.PI),
    );
  },
  mech: (team, race, loadout, at) => {
    const n = ++spawnCount;
    return world.spawnDeferred(
      () => new ModularMech(loadout, { name: t('unit.mechName', { n, race: raceName(race) }), team, race }).load(),
      (mech) => world.addMech(mech, at.x, at.z, at.yaw),
    );
  },
};
game.productionSpawners = productionSpawners;

/** Loads in parallel, then adds in the listed order: entity ids follow the add order and must match on every client */
async function loadThenAdd(jobs) {
  const objects = await Promise.all(jobs.map((job) => job.load()));
  return objects.map((obj, i) => jobs[i].add(obj));
}

/**
 * Model paths a match with these races may produce (crews, buildable vehicles / structures with turrets, basic
 * mech parts) – preloaded into the AssetLoader cache so productions load from memory.
 */
function matchModelPaths(races) {
  const s = getStats();
  const paths = [];
  for (const race of new Set(races.filter(Boolean))) { // [A8] seats without a race load nothing
    const crew = crewStats(race);
    paths.push(crew.model, crew.animationSource, ...Object.values(basicLoadout(modelRaceOf(race) ?? race))); // [N17] stand-in models of W
    for (const group of ['vehicles', 'structures']) {
      for (const [id, raw] of Object.entries(s[group] ?? {})) {
        if (raw.buildable === false) continue; // never produced (starting units are loaded already)
        try {
          const u = unitStats(group, id, race);
          const turrets = u.turret?.models;
          paths.push(u.model, turrets ? turrets[race] ?? Object.values(turrets)[0] : null);
        } catch (err) { console.warn(err); }
      }
    }
  }
  return paths;
}

// ---------- economy: starting base, produced vehicles ----------

/** [N5] A per-team settings list cut / filled to `count` seats: list[team], else fallback(team) */
function seatList(list, count, fallback) {
  return Array.from({ length: count }, (_, team) => list?.[team] ?? fallback(team));
}

/** Point relative to a start position: forward = towards the map centre (start yaw), side = to the right */
function startOffset(base, { forward, side }) {
  const fx = Math.sin(base.yaw);
  const fz = Math.cos(base.yaw);
  return { x: base.x + fx * forward - fz * side, z: base.z + fz * forward + fx * side };
}

// Starting / test units below are loaded in parallel but added in a fixed order (loadThenAdd), before the
// simulation starts – so their entity ids are the same on every client.

/**
 * Starting units of a team: the chosen start set (game.startSet → StartSets.startSetPlan) at its start position
 * (START_LAYOUT). Fixed creation order: buildings, vehicles, the set's mech, its crews (the first one boards the mech).
 * The same for every team, AI included.
 * @returns {{load, add}[]} jobs for loadThenAdd
 */
function startingBaseJobs(team, race, base, catalog) {
  const plan = startSetPlan(game.startSet, race, getStats(), catalog);
  const jobs = [
    ...plan.structures.map(({ id, spot }) => ({
      load: () => new Structure(id, race, { team, complete: true, yaw: base.yaw, name: unitName('structures', id) }).load(),
      add: (s) => { const { x, z } = startOffset(base, spot); return world.addStructure(s, x, z); },
    })),
    ...plan.vehicles.map(({ id, spot }) => ({
      load: () => loadVehicle(id, race, { team, name: unitName('vehicles', id) }), // armed ones are CombatVehicles
      add: (v) => { const { x, z } = startOffset(base, spot); return world.addVehicle(v, x, z, base.yaw); },
    })),
  ];
  let mech = null;
  if (plan.mech) {
    jobs.push({
      load: () => new ModularMech(plan.mech.loadout, { race, team }).load(),
      add: (m) => {
        mech = m;
        m.name = t('unit.mechName', { n: ++spawnCount, race: raceName(race) });
        const { x, z } = startOffset(base, plan.mech.spot);
        return world.addMech(m, x, z, base.yaw);
      },
    });
  }
  plan.crews.forEach(({ spot, boardMech }, i) => jobs.push({
    load: () => new Crew(race, { team, name: t('unit.crewName', { n: i + 1, race: raceName(race) }), nameIndex: i + 1 }).load(),
    add: (crew) => {
      const { x, z } = startOffset(base, spot);
      world.addCrew(crew, x, z, base.yaw);
      if (boardMech && mech) mech.boardCrew(crew);
      return crew;
    },
  }));
  return jobs;
}

/** Test scene (?test=1 / steelMen.startTestScene()): the player also gets the finished robot production buildings (TEST_SCENE.structures) */
function testStructureJobs(team, race, base) {
  return TEST_SCENE.structures.map((id) => ({
    load: () => new Structure(id, race, { team, complete: true, yaw: base.yaw, name: unitName('structures', id) }).load(),
    add: (s) => {
      const { x, z } = startOffset(base, START_LAYOUT[id] ?? START_LAYOUT.fallback);
      return world.addStructure(s, x, z);
    },
  }));
}

/** Enemy test squad: crewed mechs around the enemy start */
function enemyJobs(race, loadouts) {
  return loadouts.map((loadout, i) => ({ loadout, ...ENEMY_SQUAD_SPOTS[i % ENEMY_SQUAD_SPOTS.length] })).map(({ x, z, loadout }, i) => ({
    load: () => Promise.all([
      new ModularMech(loadout, { name: `Nepřítel ${i + 1} (${raceName(race)})`, team: ENEMY_TEAM, race }).load(),
      new Crew(race, { name: `Nepřátelská posádka ${i + 1}`, team: ENEMY_TEAM }).load(),
    ]),
    add: ([mech, crew]) => {
      world.addMech(mech, enemyBase.x + x, enemyBase.z + z, enemyBase.yaw); // offsets around the enemy start
      world.addCrew(crew, enemyBase.x + x, enemyBase.z + z);
      mech.boardCrew(crew);
      return mech;
    },
  }));
}

/**
 * Builds the test scene for the settings chosen in the start menu.
 * @param {{races: string[], colors: string[], friendlyFire: object, seed?: number|string}} settings
 *   races/colors: index = team (0 player, 1 enemy); seed = simulation seed (multiplayer: from the host;
 *   missing = random, single player)
 *   [N5] playerCount (2–8, missing = 2) = seats 0..playerCount-1 take part; alliances[team] = alliance id (missing =
 *   everybody alone); races / colors / seats / aiDifficulty are read for those seats only. Test units: seats 0 and 1
 *   as before, the other seats get only their starting base.
 */
async function startGame(settings) {
  stopSimulation();
  loading.begin(settings.multiplayer ? 6 : 5); // [W6] steps: data, map, base, units, models (+ players in multiplayer)
  clearAis();
  if (!settings.multiplayer) stopNet(); // a single-player start ends any previous lockstep match
  setLocalTeam(settings.localTeam ?? PLAYER_TEAM); // single player sits at seat 0; multiplayer: the seat this client took
  world.multiplayer = Boolean(settings.multiplayer); // cheats (debugXp / debugDamage) are refused in multiplayer
  commandBus.reset();
  gameSpeed.reset(settings.speed); // N4: invalid / missing = 1×
  game.prebuild = validPrebuild(settings.prebuild); // [N8] minutes, 0 = off
  game.startSet = null; // [N15] validated below, once stats.json is loaded (menu / profile / host message value)
  // [N5] Seats of the match: the first playerCount teams (missing = PLAYERS.default = the old 1-on-1); every per-team
  // list from the settings is cut to that length. Alliances are set before anything is added (Combat / fog read them).
  const playerCount = clampPlayerCount(settings.playerCount);
  game.playerCount = playerCount;
  game.races = seatList(settings.races, playerCount, () => settings.races?.[0] ?? raceList()[0]?.key);
  game.alliances = normalizeAlliances(playerCount, settings.alliances);
  setAlliances(game.alliances);
  // [N6] AI names and avatars (UI only, never read by the simulation)
  setPlayerLabels(Array.from({ length: playerCount }, (_, i) => (settings.seats?.[i] === 'ai'
    ? { name: settings.aiNames?.[i] ?? null, avatar: settings.avatars?.[i] ?? null }
    : { human: true, image: i === (settings.localTeam ?? PLAYER_TEAM) ? getAvatarImage() : (settings.avatarImgs?.[i] ?? '') }))); // [UISMALL]
  const [playerRace, enemyRace] = game.races;
  game.playerRace = playerRace;
  game.enemyRace = enemyRace;
  game.victory = settings.victory; // VICTORY.conditions id (Match validates it)
  game.unlocks = game.races.map(() => createUnlocks());
  // Game rules from the menu; World.js owns the defaults, this only overrides the chosen ones
  world.settings ??= {};
  world.settings.playerCount = playerCount;      // FogOfWar grids, UI (read only)
  world.settings.alliances = [...game.alliances]; // UI (read only); the simulation asks src/game/Alliances.js
  world.settings.friendlyFire = { ...MENU.friendlyFire, ...settings.friendlyFire };
  world.settings.fogOfWar = settings.fogOfWar ?? MENU.defaultFogMode; // 'unexplored' | 'explored' | 'off'
  world.settings.superweapons = superweaponsFromSettings(settings); // [A9] lobby option, missing = on
  world.superweapons.reset(); // [A9] no strike of a previous match survives, strike ids start over
  superweaponFx.setHeadless(true); superweaponFx.setHeadless(superweaponFxHeadless); // [A9] drop visuals still running from the last match
  world.settings.ui = { ...world.settings.ui, ...getSettings().ui }; // alwaysShowHealthBars, alwaysShowBuildProgress
  // Team colours are set before any unit loads, so every model is painted once in the chosen colour
  (settings.colors ?? []).slice(0, playerCount).forEach((color, team) => { if (color) world.setTeamColor(team, color); });
  // Seed first: map start assignment and deposit placement depend on it (multiplayer: the host's seed, same everywhere)
  const urlSeed = new URLSearchParams(window.location.search).get('seed');
  const seed = settings.seed ?? (urlSeed !== null ? Number(urlSeed) : randomSeed());
  loading.step('map');
  // [MAP-MODES] debug: ?map=<id> starts any listed map (incl. campaign-only) in a single-player game
  const urlMap = new URLSearchParams(window.location.search).get('map');
  const mapId = !settings.multiplayer && urlMap ? urlMap : settings.map;
  const map = await world.loadMap(validMapId(mapId, MAP_MODE_ANY)); // terrain, obstacles, super node, fog of war
  // Start positions: picks from the menu / host first; 2 players on their own = start 0 and the opposite one (as before)
  const order = assignStarts({ map, count: playerCount, alliances: game.alliances, picks: settings.startPicks, seed });
  game.bases = order.map((i) => map.startPositions[i]);
  world.teamStarts = [...game.bases]; // AI: own / allied starts are not scouted (Perception.otherStarts)
  spawnBase = game.bases[PLAYER_TEAM];
  enemyBase = game.bases[ENEMY_TEAM];
  // Economy: accounts with the starting resources, energy cap and deposits from the new-game menu
  world.settings.economy = {
    energyCap: settings.energyCap ?? ECONOMY.defaultEnergyCap,
    populationCap: validPopulationCap(settings.populationCap), // [W5b] 100..500 | Infinity
    oreMultiplier: oreMultiplierFromSettings(settings), // [B1] 0.5 | 1 | 2 | 4 | 'infinite'
    startMultiplier: startMultiplierFromSettings(settings), // [D4] starting resources 0.5 | 1 | 2 | 4 | 'infinite'
  };
  loading.step('data');
  await Promise.all([loadStats(), loadBuildingStyles()]); // [18A] styles before any procedural building is created
  game.startSet = validStartSet(settings.startSet, getStats()); // [N15] multiplayer: the host's settings.startSet
  game.victory = validConditionForSet(game.victory, game.startSet, getStats()); // a set without a main building cannot play 'mainBuilding'
  world.economy = new Economy(world, { races: game.races, startSet: game.startSet, ...world.settings.economy });
  map.placeDeposits?.(seed); // ASCII maps: deposits on random field cells from the match seed
  world.economy.setupDeposits(map);
  // Research per team (src/game/Research.js): no sharing with allies, unlocks go into game.unlocks[team]
  world.research?.dispose?.(); // [A9] frees the previous match's research context in Stats
  world.research = new Research(world, { races: game.races, unlocks: game.unlocks });
  applyStartResearch(world.research, startResearchFromSettings(settings));
  // Production of every team inside the simulation (Production.js); units appear through the deterministic spawners
  world.production = new Production(world, {
    races: game.races, unlocks: game.unlocks, catalog: await loadPartCatalog(), spawn: productionSpawners,
  });
  // A finished unit waits when its building is boxed in (Production holds it at 100 %): tell the owner
  world.production.onSpawnBlocked?.((item) => { if (isLocal(item.team)) hud.message(t('prod.spawnBlocked')); });
  hqBeams.dispose?.(); // beams of the previous match
  // Building footprints must be cached before any build command runs (validation reads them synchronously)
  loading.step('base');
  await Promise.all([...new Set(game.races)].map((race) => preloadFootprints(race)));
  cameraKeys.focus(game.bases[localTeam()] ?? spawnBase);
  try {
    // Starting base of every seat in seat order (the chosen start set; test scene only with ?test=1)
    const catalog = await loadPartCatalog();
    await loadThenAdd(game.races.flatMap((race, team) => startingBaseJobs(team, race, game.bases[team], catalog)));
  } catch (err) { console.error(err); }
  loading.step('units');
  if (!settings.multiplayer && new URLSearchParams(window.location.search).get('test') === '1') await startTestScene();
  await initUi();
  // [W6] the models of later productions are cached before the match starts: nothing pops in during play
  loading.step('models');
  try { await preloadModels(matchModelPaths(game.races)); } catch (err) { console.warn(err); }
  // ?seed=123 in the URL fixes the seed (determinism checks: same seed + same commands = same world.stateHash())
  noteMatchStart(settings, seed); // [J1] record: settings + seed, AI seats run live on restore
  startSimulation(seed);
  // Idle HoverTrucks repair / finish nearby work if this player wants it (profile; a command, so every client agrees).
  // Multiplayer submits it in startMultiplayer AFTER net.start(): before that the bus is still local and the command
  // would run on this client only (desync 2026-11-22, docs/desync/).
  if (!settings.multiplayer) submitAutoAssist();
  // Computer players (src/ai): outside the simulation, commands only; in multiplayer only the host runs them
  if (!settings.multiplayer || settings.isHost) {
    game.races.forEach((race, team) => {
      const seat = settings.seats?.[team] ?? SEATS.defaults[team] ?? SEATS.defaultOther;
      if (seat !== 'ai') return;
      createAi({
        world, commandBus, team, race,
        difficulty: settings.aiDifficulty?.[team] ?? AIMENU.defaultDifficulty,
        unlocks: game.unlocks[team],
        allies: alliesOf(team), // never attacked (Perception also asks Alliances directly)
      });
    });
  }
  if (!settings.multiplayer) startAutosave(); else stopAutosave(); // [J1]
}

/**
 * Test scene (development only: ?test=1 or steelMen.startTestScene()): robot production buildings of seat 0, two
 * crewed robots + a spare crew of seat 0 and a crewed enemy squad. Not part of a normal start (start sets).
 */
async function startTestScene() {
  const RACE = game.playerRace;
  const enemyRace = game.enemyRace;
  try {
    // Test units of seat 0 (PLAYER_TEAM) and the enemy seat; added in a fixed order (loadThenAdd)
    const catalog = await loadPartCatalog();
    await loadStats();
    await loadThenAdd(testStructureJobs(PLAYER_TEAM, RACE, spawnBase));
    const myLoadouts = startLoadouts(RACE, catalog).player;
    const enemyLoadouts = startLoadouts(enemyRace, catalog).enemy;
    const [mechs] = await Promise.all([
      loadThenAdd(myLoadouts.map((l) => ({
        load: () => new ModularMech(l, { race: RACE, team: PLAYER_TEAM }).load(),
        add: (mech) => {
          mech.name = t('unit.mechName', { n: spawnCount + 1, race: raceName(RACE) });
          const { x, z } = nextSpawn();
          return world.addMech(mech, x, z, spawnBase.yaw); // facing the enemy (−Z)
        },
      }))),
    ]);

    // Crews: robots 1 and 2 are manned, the third crew waits at the training area
    const crews = await loadThenAdd([0, 1, 2].map((i) => ({
      load: () => new Crew(RACE, { name: t('unit.crewName', { n: i + 1, race: raceName(RACE) }), nameIndex: i + 1, team: PLAYER_TEAM }).load(),
      add: (crew) => { const { x, z, yaw = Math.PI } = nextCrewSpawn(); return world.addCrew(crew, x, z, yaw); },
    })));
    mechs[0].boardCrew(crews[0]);
    mechs[1].boardCrew(crews[1]);
    if (isLocal(mechs[1])) input.select(mechs[1]);
    await loadThenAdd(enemyJobs(enemyRace, enemyLoadouts));
  } catch (err) {
    console.error(err);
    hud.message(t('menu.errorLoading'));
  }
}
window.steelMen.startTestScene = startTestScene;

// [B2] HUD refresh when icons finish: coalesced to one call per animation frame
let hudRefreshQueued = false;
function scheduleHudRefresh() {
  if (hudRefreshQueued) return;
  hudRefreshQueued = true;
  requestAnimationFrame(() => { hudRefreshQueued = false; hud.refresh(); });
}

/** [B2] Unit icons worth prewarming for a faction: crew + vehicles / aircraft it may ever make (research not checked) */
function factionUnitIcons(race) {
  const stats = getStats();
  const races = stats.races ?? {};
  const owned = (id) => {
    const owners = Object.keys(races).filter((key) => races[key].exclusive?.vehicles?.includes(id));
    return owners.length === 0 || owners.includes(race);
  };
  return ['crew', ...Object.keys(stats.vehicles ?? {}).filter((id) => stats.vehicles[id].buildable !== false && owned(id))];
}

/** [B2] Part icons worth prewarming: [{ slot, model }] of the faction's catalog parts (and race-less buildable ones) */
function factionPartIcons(catalog, race) {
  const out = [];
  for (const slot of MECH_SLOTS) {
    for (const p of catalog?.[slot] ?? []) {
      if (p.race === race || (p.race === null && partStats(p.path, slot, race).buildable)) out.push({ slot, model: p.path });
    }
  }
  return out;
}

/** In-game UI of a match: build / production / research menus, HUD, match end (the units exist already) */
async function initUi() {
  try {
    const catalog = await loadPartCatalog();
    await loadStats();

    // Construction, building production and paid production (cost / population) – src/ui/BuildMenu.js;
    // everything is produced in buildings, robots in the part factory + assembly bay (RobotProduction).
    // The menus belong to the local player; the units appear through the deterministic spawners.
    const me = localTeam();
    game.buildMenu = new BuildMenu({
      world, input, hud, race: raceOf(me), unlocks: game.unlocks[me],
      placementYaw: () => (game.bases[me] ?? spawnBase).yaw,
    });
    rangeRings?.dispose();
    rangeRings = new RangeRings({ scene, world, input, buildMenu: game.buildMenu }); // [A9-F4a]
    game.robotProduction = new RobotProduction({ buildMenu: game.buildMenu, catalog });
    game.buildMenu.robotProduction = game.robotProduction;
    game.robotProduction.onOpenStock = () => stockWindow.open(); // [F1] button in the part factory / assembly bay panels
    stockWindow.setMatch(world);
    game.buildMenu.researchView = new ResearchView({ buildMenu: game.buildMenu, research: world.research });
    hud.start({ race: raceOf(me), buildMenu: game.buildMenu });
    // Building icons (IconRenderer): started only now (world ready); the previous match's cache / renderer is freed first
    initIconRenderer();
    onIconReady(scheduleHudRefresh); // [B2] many icons finish per frame: one HUD refresh per frame
    prewarmBuildingIcons(game.buildMenu.buildableStructures(),raceOf(me), TEAMS[me].color);
    prewarmUnitIcons(factionUnitIcons(raceOf(me)), raceOf(me), TEAMS[me].color); // [B2] crew + the faction's vehicles / aircraft
    prewarmPartIcons(factionPartIcons(catalog, raceOf(me)), raceOf(me), TEAMS[me].color); // [B2] robot parts of the faction
    // Match end: victory condition from the menu; checking starts now that the starting units exist
    game.match = new Match(world, { conditionId: game.victory, teamCount: game.playerCount, prebuild: game.prebuild }); // [N5] seats, [N8] pre-build
    world.match = game.match; // the surrender command reaches it (matchCommands.js)
    matchUi.setMatch(game.match);
    statsBar.setMatch(game.match);
    diplomacy.setMatch(game.match, world);
    hud.setDiplomacy(diplomacy);
    econAlerts ??= new EconomyAlerts({ economy: null, getTeam: localTeam }); // [D2]
    econAlerts.setEconomy(world.economy);
    econAlerts.setMatch(game.match);
    game.match.begin();
    { const endUi = game.match.onEnd; game.match.onEnd = (r) => { stockWindow.setMatch(null); disposeIconRenderer(); endUi?.(r); }; } // [N4] the stock window closes with the match
    // [N8] start/end shown in the top banner (not as a long centre message)
    game.match.onPrebuildEnd = () => { prebuildEndedAt = performance.now(); };
    prebuildEndedAt = 0;
  } catch (err) {
    console.error(err);
    hud.message(t('menu.errorLoading'));
  }
}

// ---------- start menu ----------

async function showMenu() {
  loading.show(); // [W6] covers the page start (stats / map previews load) – hidden below once the menu stands
  try {
    await loadStats();
    const races = raceList();
    if (races.length === 0) throw new Error('stats.json has no races');
    game.menu = new MainMenu(document.getElementById('menu'), {
      races, teams: TEAMS, onStart: (s) => { lastSoloSettings = s; world.paused = false; return startGame(s); }, // [I1] no frozen game after a console test
      multiplayer: { createTransport: mp.createTransport, Lobby: mp.Lobby },
      onMultiplayerStart: (info) => startMultiplayer(info).catch((err) => { console.error(err); hud.message(t('menu.errorLoading')); }),
      loading,
      saveLoad: saveView, // [J2] "Load game"
    });
    game.fullscreenOffer ??= new FullscreenOffer({ parent: document.body, canShow: () => !document.getElementById('menu').hidden }); // never over a running game // [A5] lives for the page; checks on resize until shown once
    game.fullscreenOffer.check();
  } catch (err) {
    console.error(err);
    loading.hide();
    hud.message(t('menu.errorLoading'));
    return;
  }
  // [J1] a save chosen during a match: the page was reloaded → restore it now
  try {
    const pending = await takeScheduledRestore();
    if (pending) {
      game.menu.show(false);
      loading.show(); loading.setTitle(t('save.restoring.title')); loading.setRestore({ ratio: 0 });
      try {
        await saveGame.restore(pending, { onProgress: (r) => loading.setRestore({ ratio: r }) });
        loading.hide();
        onSaveRestored();
      } catch (err) {
        console.error(err);
        // a half-replayed match stays on the page → reload into a clean menu and tell the player there
        try { sessionStorage.setItem(RESTORE_ERROR_KEY, restoreErrorText(err)); } catch { /* the message is lost, the reload still helps */ }
        window.location.reload();
      }
      return;
    }
    const restoreError = sessionStorage.getItem(RESTORE_ERROR_KEY);
    if (restoreError) { sessionStorage.removeItem(RESTORE_ERROR_KEY); hud.message(restoreError); }
  } catch (err) { console.error(err); }
  // [W5c] solo restart: the page was reloaded with the last settings (new seed) → start straight away
  try {
    const raw = sessionStorage.getItem(RESTART_KEY);
    if (raw) {
      sessionStorage.removeItem(RESTART_KEY);
      const s = JSON.parse(raw);
      lastSoloSettings = s;
      game.menu.show(false);
      try { await startGame(s); } finally { loading.hide(); } // the loading screen stays up from the page start
    } else loading.hide();
  } catch (err) { console.error(err); loading.hide(); }
}

// ---------- multiplayer: lockstep over src/net (docs/MULTIPLAYER.md) ----------

let net = null; // Lockstep during a multiplayer match, otherwise null
let netChannel = null;
let chat = null;    // [N11] Chat + ChatBox during a multiplayer match
let chatBox = null;

/** The local player's auto-assist wish (profile) as a simulation command */
function submitAutoAssist() {
  commandBus.submit({ type: 'setAutoAssist', team: localTeam(), on: getSettings().ui?.autoAssist ?? true });
}

/**
 * [A2-net] Continued saved match: replay to tick T (no live AI), compare hashes with everybody, then the host runs the
 * AI of every seat that is AI now (original AI and seats taken over from a human continue the base they find, A2-ai).
 * Returns false when the match must not go on (error dialog → reload, or the host ended it).
 */
async function continueSavedMatch(info) {
  const lock0 = net;
  const abort = new AbortController();
  const offEnded = lock0.onEnded(() => abort.abort());
  loading.show(); loading.setTitle(t('save.restoring.title')); loading.setRestore({ ratio: 0 });
  try {
    await continueMultiplayer({
      info, signal: abort.signal,
      onProgress: (ev) => {
        loading.setRestore({ ratio: ev.ratio });
        loading.setStatus(t(`lobby.continue.phase.${ev.phase}`));
        if (ev.stalled && lock0.canEndMatch) offerEndMatch();
      },
    });
  } catch (err) {
    offEnded();
    if (net !== lock0 || lock0.status.ended) return false; // onMatchEndedByHost already shows the notice
    console.error(err);
    await choiceDialog({ messageKey: err.key ?? 'net.continue.error.generic', choices: [{ id: 'ok', labelKey: 'save.ok' }], cancelId: 'ok' });
    window.location.reload(); // half-replayed page: back to the menu
    return false;
  }
  offEnded();
  info.continue.save = null; // [A2-net] the replayed save is not needed any more (memory)
  loading.setRestore(null);
  loading.setStatus('');
  if (info.selfId === info.hostId) {
    for (const seat of info.aiSeats ?? []) {
      createAi({
        world, commandBus, team: seat.team, race: game.races[seat.team],
        difficulty: seat.difficulty ?? AIMENU.defaultDifficulty,
        unlocks: game.unlocks[seat.team], allies: alliesOf(seat.team), resumed: true,
      });
    }
  }
  return true;
}

/** [A2-net] Host: the match / continue replay is stuck – end it for everybody? (no automatic end) */
let endOfferOpen = false;
async function offerEndMatch() {
  if (endOfferOpen || !net?.canEndMatch) return;
  endOfferOpen = true;
  const lock = net;
  const id = await choiceDialog({
    messageKey: 'net.stall.offer',
    choices: [{ id: 'wait', labelKey: 'net.stall.wait' }, { id: 'end', labelKey: 'net.stall.end', danger: true }],
    cancelId: 'wait', defaultId: 'wait',
  });
  endOfferOpen = false;
  if (id === 'end' && net === lock) lock.endMatch();
}

/** [A2-net] The host ended the match (or we did): notice, then back to the menu */
async function onMatchEndedByHost(e) {
  await choiceDialog({ messageKey: e?.self ? 'net.ended.self' : 'net.ended.byHost', choices: [{ id: 'ok', labelKey: 'save.ok' }], cancelId: 'ok' });
  window.location.reload();
}

function stopNet() {
  chatBox?.dispose(); chat?.dispose(); chatBox = null; chat = null; // [N11]
  net?.stop();
  netChannel?.leave();
  net = null;
  netChannel = null;
  window.steelMen.net = null;
}

/** lobby.onStart → same world on every client: seed and seats from the host, then the lockstep starts ticking */
async function startMultiplayer(info) {
  stopNet();
  const races = raceList();
  const s = info.settings ?? {};
  // [N5] Seats in the match: the open ones (seat.open !== false). The lobby has already packed them, so their
  // team numbers are 0..playerCount-1 and match info.localTeam / info.players. A lobby without `open` flags and
  // without settings.playerCount (older lobby) keeps the 2 seats of before.
  const inMatch = info.seats.filter((seat) => seat && seat.open !== false).sort((a, b) => a.team - b.team);
  const hasOpenFlags = info.seats.some((seat) => seat && 'open' in seat);
  const playerCount = clampPlayerCount(s.playerCount ?? (hasOpenFlags ? inMatch.length : undefined));
  const byTeam = Array.from({ length: playerCount }, (_, team) => inMatch.find((seat) => seat.team === team) ?? inMatch[team] ?? {});
  const alliances = s.alliances ?? (byTeam.every((seat) => Number.isInteger(seat.alliance)) ? byTeam.map((seat) => seat.alliance) : undefined);
  // Created right away: it listens from now on, so turns arriving while the map loads are kept
  net = new mp.Lockstep({
    channel: info.channel, world, commandBus, players: info.players, localTeam: info.localTeam, hostId: info.hostId,
    aiTeams: byTeam.map((seat, team) => (seat.controller === 'ai' ? team : -1)).filter((team) => team >= 0), // [MP-LEAVE] they idle with the host when it leaves
    startTick: info.continue ? info.continue.tick : 0, // [A2-net] continued match: the lockstep goes on after the saved tick
  });
  netChannel = info.channel;
  window.steelMen.net = net;
  net.onStallLong(() => { if (net?.canEndMatch) offerEndMatch(); }); // [A2-net] stuck for NET_CONTINUE.stallOfferMs: ask the host
  net.onEnded((e) => onMatchEndedByHost(e)); // [A2-net] everybody leaves to the menu
  // [N11] text chat next to the lockstep (same channel, topic 'chat', outside the simulation)
  chat = new Chat({ channel: info.channel, players: info.players, localTeam: info.localTeam, isAlly: areAllies });
  chatBox = new ChatBox({ chat, t, getColor: (team) => TEAMS[team]?.color });
  world.paused = false; // [I1] no frozen game after a console test
  if (info.continue) {
    if (!(await continueSavedMatch(info))) return; // [A2-net] replayed to tick T (or failed / ended: the page reloads)
  } else await startGame({
    multiplayer: true,
    map: s.map, startPicks: s.startPicks, // [MAPS] from the host's start message (startPicks keyed by packed team)
    playerCount, alliances, // [N5] the same on every client (from the host's start message)
    races: byTeam.map((seat) => seat.race ?? races[0].key),
    colors: byTeam.map((seat, team) => seat.color ?? TEAMS[team].color),
    seats: byTeam.map((seat) => (seat.playerId === info.selfId ? 'human' : seat.controller === 'human' ? 'remote' : seat.controller ?? 'ai')),
    friendlyFire: s.friendlyFire, fogOfWar: s.fogOfWar, victory: s.victory,
    superweapons: s.superweapons, energyCap: s.energyCap, populationCap: s.populationCap, oreMultiplier: s.oreMultiplier, startMultiplier: s.startMultiplier, startResearch: s.startResearch, speed: s.speed, prebuild: s.prebuild,
    startSet: s.startSet, // [N15] the host's start set (validated in startGame)
    aiDifficulty: byTeam.map((seat) => (seat.controller === 'ai' ? seat.difficulty ?? null : null)),
    aiNames: byTeam.map((seat) => seat.aiName ?? null), avatars: byTeam.map((seat) => seat.avatar ?? null), // [N6] from the host
    avatarImgs: byTeam.map((_, team) => info.avatarImgs?.[team] ?? ''), // [UISMALL] thumbnails of the humans (lobby presence)
    isHost: info.selfId === info.hostId, // AI seats run only on the host; their commands travel like a player's
    seed: info.seed,
    localTeam: info.localTeam ?? PLAYER_TEAM, // spectators are not supported yet
  });
  // [W6] barrier: every human finishes loading before tick 0 (timeout / disconnect: the match goes on, the drop rules apply)
  const lock = net;
  if (lock) {
    loading.step('players');
    const names = (teams) => teams.map((tm) => lock.nameOf(tm) || t('lobby.seat', { n: tm + 1 })).join(', ');
    simRunning = false; // no tick runs while we wait (the first empty turns must not be played before net.start())
    let res;
    try {
      res = await lock.waitForPlayers({
        onProgress: ({ ready, total }) => loading.setStatus(t('loading.waitingPlayers', { ready, total })),
      });
    } finally {
      simAccumulator = 0;
      simRunning = true; // never leave the simulation frozen, even when the barrier throws
    }
    if (res.cancelled || net !== lock) { simRunning = false; return; } // stopNet() in the meantime
    if (res.left.length) hud.message(t('loading.playerLeft', { players: names(res.left) }));
    else if (res.timedOut) hud.message(t('loading.timeout', { players: names(res.missing) }));
  }
  net?.start(); // after startSimulation: tick 0, empty bus; switches commandBus.schedule to the network
  if (net && info.localTeam != null) submitAutoAssist(); // through the lockstep: runs on every client at the same tick
}

/** "Waiting for players" / desync banner (div#net-wait in index.html) */
function updateNetOverlay() {
  const el = document.getElementById('net-wait');
  if (!el) return;
  if (!net) { el.hidden = true; return; }
  const st = net.status;
  const nameOf = (team) => net.nameOf(team) || t('lobby.seat', { n: team + 1 }); // [MP-LEAVE] lobby nickname
  const names = (teams) => teams.map(nameOf).join(', ');
  if (st.desync) {
    el.hidden = false;
    el.textContent = t('net.desync', { tick: st.desync.tick });
  } else if (st.loadStall) {
    el.hidden = false; // [A1-3] a load hangs / failed on this client: the match is held (going on would desync)
    el.textContent = t('net.loadStalled');
  } else if (st.waitingFor.length && st.stalledMs > NET.waitOverlayMs) {
    el.hidden = false;
    const left = st.waitingFor.filter((team) => st.left.includes(team));
    const key = !left.length ? 'net.waiting'
      : left.every((team) => st.leaving.includes(team)) ? 'net.playerLeftDropping' : 'net.playerLeft';
    el.textContent = t(key, { players: names(left.length ? left : st.waitingFor) });
  } else if (st.lastLeft && performance.now() - st.lastLeft.at < NET_LEAVE.noticeMs) {
    el.hidden = false; // [MP-LEAVE] short notice, also in a match that goes on
    el.textContent = t('net.playerLeftShort', { name: nameOf(st.lastLeft.team) });
  } else el.hidden = true;
}

// ---------- HUD: src/ui/Hud.js (panels, grids, selection info, bars above units) ----------


// ---------- loop: fixed-step simulation, rendering every frame ----------
//
// The simulation advances only in ticks of SIM_DT (config SIM.tickRate), whatever the frame rate: commands due
// at the tick run first (CommandBus), then the world, then the match rules. Camera, input, minimap and HUD run
// every frame with the real frame time. Moving objects are drawn between their last two tick poses
// (interpolation below), so motion stays smooth above the tick rate; animation poses (mixers) and effects
// advance inside the ticks because weapon muzzles and projectile hits depend on them.

const SIM_DT = 1 / SIM.tickRate;
let simRunning = false;   // ticks run only during a match (after all starting units exist)
let simAccumulator = 0;   // real time not simulated yet (s)

/** New match: seeds world.rng, restarts the tick counter and the command queue, starts ticking */
const damageSmoke = new DamageSmokeWiring(world);
let bloodStains = null; // [A7] created per match in startSimulation (needs world.fog from loadMap)
let gameSounds = null; // [A6] created per match in startSimulation

function startSimulation(seed) {
  damageSmoke.clear();
  bloodStains?.dispose(); bloodStains = new BloodStains(world); window.steelMen.bloodStains = bloodStains; // [A7]
  gameSounds?.dispose(); gameSounds = new GameSounds({ world }); window.steelMen.gameSounds = gameSounds; // [A6]
  setListenerPosition(controls.target, listenerRight); // [A6] distance falloff measured from the camera target
  world.startSimulation(seed);
  commandBus.reset();
  simAccumulator = 0;
  simRunning = true;
  worldVisible = true; // [W6] from now on the world is drawn
  renderer.domElement.style.visibility = '';
}

function stopSimulation() { simRunning = false; }

function simTick() {
  const perfT0 = performance.now(); // [A4] UI measurement only
  captureTransforms();
  commandBus.executeTick(world, world.tick + 1); // world.update raises world.tick to the same number
  world.update(SIM_DT);
  hqBeams.update(); // light beam above every main building (visual only)
  damageSmoke.update(); // smoke on hurt units / buildings (visual only)
  bloodStains?.update(SIM_DT); // [A7] blood stains fade (visual only)
  game.match?.update(SIM_DT);
  const perfT1 = performance.now();
  updateAis(world.tick / SIM.tickRate);
  const perfT2 = performance.now();
  perfTickMs = (perfTickMs < 0 ? 0 : perfTickMs) + (perfT2 - perfT0); // whole tick incl. AI, summed over the frame
  perfAiMs = (perfAiMs < 0 ? 0 : perfAiMs) + (perfT2 - perfT1);
  perfTicks++;
}

// --- render interpolation: only the drawn matrices are blended; position / rotation (simulation state) are never
// touched, so how often a client renders cannot change its simulation ---
const lerpState = new WeakMap(); // object -> { p: Vector3, q: Quaternion, tick } = pose before the last tick
const blended = [];               // objects whose matrix was overridden for the current frame
const _lerpP = new THREE.Vector3();
const _lerpQ = new THREE.Quaternion();

/** Root objects that move in the simulation: units and wrecks */
function* movingObjects() {
  yield* world.allUnits;
  for (const w of world.wrecks) yield w.object;
  for (const w of world.salvage) yield w.object;
}

// Before a tick: remember every moving object's pose
function captureTransforms() {
  if (!SIM.interpolate) return;
  const tick = world.tick + 1;
  for (const obj of movingObjects()) {
    let s = lerpState.get(obj);
    if (!s) lerpState.set(obj, s = { p: new THREE.Vector3(), q: new THREE.Quaternion(), tick: -1 });
    s.p.copy(obj.position);
    s.q.copy(obj.quaternion);
    s.tick = tick;
  }
}

// Before rendering: draw each object at alpha (0..1) between its pose before the last tick and now
function applyInterpolation(alpha) {
  blended.length = 0;
  if (!SIM.interpolate || alpha >= 1) return;
  const snap = SIM.interpolationSnapDistance ** 2;
  for (const obj of movingObjects()) {
    const s = lerpState.get(obj);
    // Spawned during the last tick, not captured, or jumped (teleport, crew getting out): draw as it is
    if (!s || s.tick !== world.tick || !obj.matrixAutoUpdate) continue;
    if (s.p.equals(obj.position) && s.q.equals(obj.quaternion)) continue; // did not move
    if (s.p.distanceToSquared(obj.position) > snap) continue;
    _lerpP.lerpVectors(s.p, obj.position, alpha);
    _lerpQ.slerpQuaternions(s.q, obj.quaternion, alpha);
    obj.matrix.compose(_lerpP, _lerpQ, obj.scale);
    obj.matrixAutoUpdate = false;     // renderer keeps our matrix…
    obj.matrixWorldNeedsUpdate = true; // …and recomputes the world matrices of the object and its children
    blended.push(obj);
  }
}

// After rendering: back to normal matrices (World.update recomputes them from the real poses each tick)
function restoreInterpolation() {
  for (const obj of blended) obj.matrixAutoUpdate = true;
  blended.length = 0;
}

// [N8] Pre-build countdown banner (outside the simulation)
const prebuildEl = document.createElement('div');
prebuildEl.className = 'hud-prebuild';
prebuildEl.hidden = true;
document.body.appendChild(prebuildEl);
let prebuildEndedAt = 0; // performance.now() when the phase ended; the banner shows "ended" for a moment
function updatePrebuildBanner() {
  const left = prebuildSecondsLeft(world);
  if (left > 0) {
    prebuildEl.hidden = false;
    prebuildEl.textContent = t('prebuild.countdown', { time: formatGameTime(Math.ceil(left)) });
    prebuildEl.classList.toggle('warn', left <= PREBUILD.warnSeconds);
    prebuildEl.classList.remove('ended');
    return;
  }
  const showEnded = prebuildEndedAt > 0 && performance.now() - prebuildEndedAt < PREBUILD.endedBannerMs;
  prebuildEl.hidden = !showEnded;
  if (!showEnded) return;
  prebuildEl.textContent = t('prebuild.ended');
  prebuildEl.classList.remove('warn');
  prebuildEl.classList.add('ended');
}

const clock = new THREE.Clock();
let lastSimTime = performance.now();

/**
 * Runs the ticks that are due by real time and returns the render alpha. Called every frame and, in a multiplayer
 * match, by a timer while the tab is hidden (browsers stop animation frames there; the other players would stall).
 */
function advanceSimulation(maxFrameTime, maxSteps) {
  const now = performance.now();
  const dt = Math.min((now - lastSimTime) / 1000, maxFrameTime);
  lastSimTime = now;
  if (!simRunning) return 1;
  if (world.paused) { simAccumulator = 0; return 1; } // [I1] a console harness ticks by itself (steelMen.det, ai.fastForward)
  if (matchUi.pausesSimulation) { simAccumulator = 0; return 1; } // single player: the open game menu pauses
  simAccumulator += dt * gameSpeed.value; // N4: game speed = ticks per real second, SIM_DT unchanged
  let steps = 0;
  // readyForTick: every match waits for a produced unit's model / tracked load (World.spawnDeferred, trackLoad)
  // net.canAdvance: a lockstep match also waits for every player's turn message
  while (simAccumulator >= SIM_DT && steps < maxSteps && world.readyForTick()
    && (!net || net.canAdvance(world.tick + 1))) {
    simTick();
    net?.onTick(world.tick);
    simAccumulator -= SIM_DT;
    steps++;
  }
  // Too far behind (slow machine, waiting for a model): drop the backlog instead of racing to catch up later
  if (net?.status.paused) simAccumulator = 0; // multiplayer pause: do not race to catch up after resuming
  simAccumulator = Math.min(simAccumulator, SIM_DT * maxSteps);
  return Math.min(1, simAccumulator / SIM_DT);
}

// No animation frame for a while (hidden or background tab) during a multiplayer match: keep ticking on a timer
let lastFrameTime = performance.now();
setInterval(() => {
  if (net && performance.now() - lastFrameTime > NET.hiddenPumpMs * 2) {
    const restoring = isRestoring();
    if (!restoring) setSoundMuted(true); // [A6] hidden tab: ticks without sound bursts
    try { advanceSimulation(NET.hiddenMaxFrameTime, NET.hiddenMaxSteps); }
    finally { if (!restoring) setSoundMuted(false); }
  }
}, NET.hiddenPumpMs);

renderer.setAnimationLoop(() => {
  lastFrameTime = performance.now();
  const dt = Math.min(clock.getDelta(), SIM.maxFrameTime);
  const alpha = advanceSimulation(SIM.maxFrameTime, SIM.maxStepsPerFrame);
  const swHeadless = isRestoring(); // [A9] a replaying save draws no superweapon visuals
  if (swHeadless !== superweaponFxHeadless) superweaponFx.setHeadless(superweaponFxHeadless = swHeadless);
  superweaponFx.update(dt);
  minimap.update(dt);
  statsBar.update(dt);
  input.cleanSelection();
  cameraKeys.update(dt);
  edgeScroll.update(dt);
  controls.update();
  listenerRight.setFromMatrixColumn(camera.matrixWorld, 0); // [A6] stereo pan follows the camera
  if (worldVisible && !isRestoring()) { // [W6] nothing behind the main menu; [J1] no drawing while a save replays
    world.map?.update(dt); // [A8] lava animation (visual time)
    applyInterpolation(alpha);
    renderer.render(scene, camera);
    restoreInterpolation();
  }
  hud.update(dt);
  gameSounds?.update(dt); // [A6]
  updatePrebuildBanner(); // [N8] pre-build countdown
  econAlerts?.update();   // [D2] below the pre-build banner
  swWarnings.update(); rangeRings?.update(); // [A9-F4a]
  updateNetOverlay();
  matchUi.update();     // multiplayer pause banner
  rallyMarkers.update(); // rally lines of the selected own building
  if (perfPanel.visible) { // [A4] performance overlay (F2)
    if (perfLastFrameMs) perfPanel.sample(lastFrameTime - perfLastFrameMs, perfTicks ? perfTickMs / perfTicks : -1, perfTicks ? perfAiMs / perfTicks : -1); // per-tick average of the frame
    if (++perfCountFrames >= A4_UI.perf.countsEveryFrames) {
      perfCountFrames = 0;
      perfPanel.setCounts({ units: world.mechs.length + world.crews.length + world.vehicles.length,
        players: game.match?.teams.length ?? 0, aiTeams: aiTickStats.ais });
    }
  }
  perfLastFrameMs = lastFrameTime; perfTickMs = -1; perfAiMs = -1; perfTicks = 0;
});

showMenu();
