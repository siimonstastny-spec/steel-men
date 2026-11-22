// Steel Mans – vstupní bod – SIT
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
import { loadPartCatalog } from './game/PartStock.js';
import { MainMenu } from './ui/MainMenu.js';
import { Minimap } from './ui/Minimap.js';
import { Hud } from './ui/Hud.js';
import { EdgeScroll } from './ui/EdgeScroll.js';
import { MAP, MENU, PLAYER_TEAM, TEAMS, basicLoadout, ECONOMY, START_LAYOUT, TEST_SCENE, SIM, NET, NET_LEAVE, SEATS, AIMENU } from './config.js';
import { assignStarts } from './game/MapStarts.js';
import { validMapId } from './game/MapCatalog.js';
import { loadStats, raceList, raceName, createUnlocks, getStats, unitStats, crewStats } from './data/Stats.js';
import { commandBus } from './game/commands/CommandBus.js';
import { localTeam, setLocalTeam, isLocal } from './core/LocalPlayer.js';
import { randomSeed } from './core/Rng.js';
import { preloadModels } from './core/AssetLoader.js';
import { Economy } from './game/Economy.js';
import { loadVehicle } from './units/Aircraft.js'; // aircraft → Aircraft, other vehicles → CombatVehicle loader
import { Structure } from './units/Structure.js';
import { BuildMenu, unitName } from './ui/BuildMenu.js';
import { Research } from './game/Research.js';
import { ResearchView } from './ui/ResearchView.js';
import { Match } from './game/Match.js';
import { gameSpeed, formatGameTime } from './game/GameSpeed.js';
import { validPrebuild, prebuildSecondsLeft, PREBUILD } from './game/PreBuild.js';
import { MatchUi } from './ui/MatchUi.js';
import { Production } from './game/Production.js';
import { preloadFootprints } from './game/commands/buildCommands.js';
import * as mp from './net/index.js';
import { startLoadouts } from './game/StartLoadouts.js';
import { HqBeams } from './game/HqBeams.js';
import { RallyMarkers } from './ui/RallyMarkers.js';
import { createAi, updateAis, clearAis } from './ai/index.js';
import { setAlliances, normalizeAlliances, startOrder, alliesOf, areAllies, clampPlayerCount } from './game/Alliances.js';
import { installAiConsole } from './ai/aiVsAi.js';
import { setPlayerLabels, playerLabel } from './core/PlayerLabels.js';
import { setPingNameResolver } from './ui/Pings.js';
// [N7] ping messages name AI allies by their N6 name, humans "Player N" (lobby nicknames: later)
setPingNameResolver((team) => playerLabel(team) || window.steelMans?.net?.nameOf(team) || t('ping.player', { n: team + 1 })); // [MP-LEAVE] lobby nickname
// Command executors register themselves on import (src/game/commands/CommandBus.js)
import './game/commands/unitCommands.js';
import './game/commands/productionCommands.js';
import './game/commands/matchCommands.js';
import './game/commands/diplomacyCommands.js'; // [B4] sendTribute
import { PlayerStatsBar } from './ui/PlayerStatsBar.js';
import { DiplomacyView } from './ui/DiplomacyView.js';
import { oreMultiplierFromSettings } from './game/OreMultiplier.js';
import { startMultiplierFromSettings } from './game/StartMultiplier.js'; // [D4]
import { startResearchFromSettings, applyStartResearch } from './game/StartResearch.js';
import { EconomyAlerts } from './ui/EconomyAlerts.js'; // [D2]
import { spawnProceduralPreview } from './procedural/ProcPreview.js'; // [N3] prototype, console only

const { renderer, scene, camera, controls, ground } = createScene(document.getElementById('app'));

const world = new World(scene, ground);
const hqBeams = new HqBeams(world); // src/game/HqBeams.js – team-coloured beam above each HQ
applySavedKeybindings();            // remapped keys from the player profile
initGraphics(renderer, scene);      // full / reduced graphics from the profile (live-updates on change)
initMouseSettings(controls);        // mouse sensitivity / invert from the profile
installEmbedGuard();                // iframe (itch.io): keyboard focus, no page scroll / text selection; lives with the page
const cameraKeys = new CameraKeys(camera, controls);
const input = new CommandInput(camera, renderer.domElement, world, { onFocus: (p) => cameraKeys.focus(p), controls }); // right drag = pan
const minimap = new Minimap(world, camera, { onFocus: (p) => cameraKeys.focus(p) }); // #minimap, bottom right
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

// Game menu (Esc / ☰) and the end-of-match screen; quit = reload (the start menu remembers the last choice)
const matchUi = new MatchUi({
  teamName: (i) => (playerLabel(i) || (isLocal(i) ? (getSettings().nickname || t('common.player'))
    : t(areAllies(i, localTeam()) ? 'common.ally' : 'common.enemy'))) + ` (${raceName(raceOf(i))})`,
  openSettings: (returnTo) => game.menu?.openSettingsFrom(returnTo),
  quit: () => window.location.reload(),
  net: () => net,                                               // multiplayer pause goes through the lockstep
  nickname: () => getSettings().nickname || t('common.player'), // "{name} paused the game"
});
input.onGameMenu = () => matchUi.toggleMenu();
// [B4] player score bar above the minimap and the diplomacy menu (U / HUD button)
const nameOf = (team) => playerLabel(team) || (isLocal(team) ? (getSettings().nickname || t('common.player'))
  : window.steelMans?.net?.nameOf?.(team) || t('ping.player', { n: team + 1 }));
const statsBar = new PlayerStatsBar({ nameOf });
const diplomacy = new DiplomacyView({ nameOf });
let econAlerts = null; // [D2] no main building / low energy; created at the first match (needs loaded stats)

// Debug handle for the browser console, e.g. steelMans.input.selection, steelMans.game.playerRace
// commandBus: steelMans.commandBus.submit({...}); world.stateHash() / world.rng / world.tick for determinism checks
// startGame(settings): console tests of N players, e.g. steelMans.startGame({ playerCount: 4, alliances: [0, 0, 1, 1], … })
window.steelMans = { world, input, scene, camera, controls, game, minimap, hud, edgeScroll, commandBus, gameSpeed, startGame, statsBar, diplomacy };
installAiConsole(); // steelMans.ai.start / fastForward / report / log / stop (AI vs AI test)
// [N3] procedural factory preview: p = await steelMans.spawnProceduralPreview('Y', '#c8302c', {x, y, z}); p.dispose()
window.steelMans.spawnProceduralPreview = (race = 'X', color = '#3a5ccc', pos = { x: 0, y: 0, z: 0 }, opts) =>
  spawnProceduralPreview(scene, pos, race, color, opts);

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
      () => new ModularMech(loadout, { name: `Robot ${n} (${raceName(race)})`, team, race }).load(),
      (mech) => { const p = structure.nextSpawnPoint(); return world.addMech(mech, p.x, p.z, p.yaw); },
    );
  },
  /** Trained crew squad in front of the training building */
  crew(structure) {
    const { team } = structure;
    const race = raceOf(team);
    const n = ++crewCount;
    return world.spawnDeferred(
      () => new Crew(race, { name: `Posádka ${n} (${raceName(race)})`, team }).load(),
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
      () => new Crew(race, { name: `Posádka ${n} (${raceName(race)})`, team }).load(),
      (crew) => world.addCrew(crew, at.x, at.z, at.yaw ?? Math.PI),
    );
  },
  mech: (team, race, loadout, at) => {
    const n = ++spawnCount;
    return world.spawnDeferred(
      () => new ModularMech(loadout, { name: `Robot ${n} (${raceName(race)})`, team, race }).load(),
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
  for (const race of new Set(races)) {
    const crew = crewStats(race);
    paths.push(crew.model, crew.animationSource, ...Object.values(basicLoadout(race)));
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
 * Starting units of a team (stats.json → rules.economy.startUnits) at its start position (START_LAYOUT):
 * finished buildings (Outpost) and vehicles (HoverTruck, DrillTruck).
 * @returns {{load, add}[]} jobs for loadThenAdd
 */
function startingBaseJobs(team, race, base) {
  const start = getStats().rules.economy?.startUnits ?? {};
  const spot = (id, i) => START_LAYOUT[id]
    ?? { ...START_LAYOUT.fallback, side: START_LAYOUT.fallback.side + i * START_LAYOUT.fallback.step };
  return [
    ...(start.structures ?? []).map((id, i) => ({
      load: () => new Structure(id, race, { team, complete: true, yaw: base.yaw, name: unitName('structures', id) }).load(),
      add: (s) => { const { x, z } = startOffset(base, spot(id, i)); return world.addStructure(s, x, z); },
    })),
    ...(start.vehicles ?? []).map((id, i) => ({
      load: () => loadVehicle(id, race, { team, name: unitName('vehicles', id) }), // armed ones are CombatVehicles
      add: (v) => { const { x, z } = startOffset(base, spot(id, i)); return world.addVehicle(v, x, z, base.yaw); },
    })),
  ];
}

/** Test scene: the player also gets the finished robot production buildings (TEST_SCENE.structures) */
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
 *   [N5] playerCount (2–4, missing = 2) = seats 0..playerCount-1 take part; alliances[team] = alliance id (missing =
 *   everybody alone); races / colors / seats / aiDifficulty are read for those seats only. Test units: seats 0 and 1
 *   as before, the other seats get only their starting base.
 */
async function startGame(settings) {
  stopSimulation();
  clearAis();
  if (!settings.multiplayer) stopNet(); // a single-player start ends any previous lockstep match
  setLocalTeam(settings.localTeam ?? PLAYER_TEAM); // single player sits at seat 0; multiplayer: the seat this client took
  world.multiplayer = Boolean(settings.multiplayer); // cheats (debugXp / debugDamage) are refused in multiplayer
  commandBus.reset();
  gameSpeed.reset(settings.speed); // N4: invalid / missing = 1×
  game.prebuild = validPrebuild(settings.prebuild); // [N8] minutes, 0 = off
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
  world.settings.ui = { ...world.settings.ui, ...getSettings().ui }; // alwaysShowHealthBars, alwaysShowBuildProgress
  // Team colours are set before any unit loads, so every model is painted once in the chosen colour
  (settings.colors ?? []).slice(0, playerCount).forEach((color, team) => { if (color) world.setTeamColor(team, color); });
  // Seed first: map start assignment and deposit placement depend on it (multiplayer: the host's seed, same everywhere)
  const urlSeed = new URLSearchParams(window.location.search).get('seed');
  const seed = settings.seed ?? (urlSeed !== null ? Number(urlSeed) : randomSeed());
  const map = await world.loadMap(validMapId(settings.map)); // terrain, obstacles, super node, fog of war
  // Start positions: picks from the menu / host first; 2 players on their own = start 0 and the opposite one (as before)
  const order = assignStarts({ map, count: playerCount, alliances: game.alliances, picks: settings.startPicks, seed });
  game.bases = order.map((i) => map.startPositions[i]);
  world.teamStarts = [...game.bases]; // AI: own / allied starts are not scouted (Perception.otherStarts)
  spawnBase = game.bases[PLAYER_TEAM];
  enemyBase = game.bases[ENEMY_TEAM];
  // Economy: accounts with the starting resources, energy cap and deposits from the new-game menu
  world.settings.economy = {
    energyCap: settings.energyCap ?? ECONOMY.defaultEnergyCap,
    oreMultiplier: oreMultiplierFromSettings(settings), // [B1] 0.5 | 1 | 2 | 4 | 'infinite'
    startMultiplier: startMultiplierFromSettings(settings), // [D4] starting resources 0.5 | 1 | 2 | 4 | 'infinite'
  };
  await loadStats();
  world.economy = new Economy(world, { races: game.races, ...world.settings.economy });
  map.placeDeposits?.(seed); // ASCII maps: deposits on random field cells from the match seed
  world.economy.setupDeposits(map);
  // Research per team (src/game/Research.js): no sharing with allies, unlocks go into game.unlocks[team]
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
  await Promise.all([...new Set(game.races)].map((race) => preloadFootprints(race)));
  cameraKeys.focus(game.bases[localTeam()] ?? spawnBase);
  try {
    // Starting base of every seat in seat order, then the test buildings of seat 0 (2 players: the order of before,
    // so entity ids and state hashes are unchanged)
    await loadThenAdd([
      ...game.races.flatMap((race, team) => startingBaseJobs(team, race, game.bases[team])),
      ...testStructureJobs(PLAYER_TEAM, playerRace, spawnBase),
    ]);
  } catch (err) { console.error(err); }
  await init(playerRace, enemyRace);
  // Everything that later productions may need goes into the model cache in the background
  preloadModels(matchModelPaths(game.races)).catch((err) => console.warn(err));
  // ?seed=123 in the URL fixes the seed (determinism checks: same seed + same commands = same world.stateHash())
  startSimulation(seed);
  // Idle HoverTrucks repair / finish nearby work if this player wants it (profile; a command, so every client agrees)
  commandBus.submit({ type: 'setAutoAssist', team: localTeam(), on: getSettings().ui?.autoAssist ?? true });
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
}

async function init(RACE, enemyRace) {
  try {
    // Test units of seat 0 (PLAYER_TEAM) and the enemy seat; added in a fixed order (loadThenAdd)
    const catalog = await loadPartCatalog();
    await loadStats();
    const myLoadouts = startLoadouts(RACE, catalog).player;
    const enemyLoadouts = startLoadouts(enemyRace, catalog).enemy;
    const [mechs] = await Promise.all([
      loadThenAdd(myLoadouts.map((l) => ({
        load: () => new ModularMech(l, { race: RACE, team: PLAYER_TEAM }).load(),
        add: (mech) => {
          mech.name = `Robot ${spawnCount + 1} (${raceName(RACE)})`;
          const { x, z } = nextSpawn();
          return world.addMech(mech, x, z, spawnBase.yaw); // facing the enemy (−Z)
        },
      }))),
    ]);

    // Crews: robots 1 and 2 are manned, the third crew waits at the training area
    const crews = await loadThenAdd([0, 1, 2].map((i) => ({
      load: () => new Crew(RACE, { name: `Posádka ${i + 1} (${raceName(RACE)})`, team: PLAYER_TEAM }).load(),
      add: (crew) => { const { x, z, yaw = Math.PI } = nextCrewSpawn(); return world.addCrew(crew, x, z, yaw); },
    })));
    mechs[0].boardCrew(crews[0]);
    mechs[1].boardCrew(crews[1]);
    if (isLocal(mechs[1])) input.select(mechs[1]);
    await loadThenAdd(enemyJobs(enemyRace, enemyLoadouts));

    // Construction, building production and paid production (cost / population) – src/ui/BuildMenu.js;
    // everything is produced in buildings, robots in the part factory + assembly bay (RobotProduction).
    // The menus belong to the local player; the units appear through the deterministic spawners.
    const me = localTeam();
    game.buildMenu = new BuildMenu({
      world, input, hud, race: raceOf(me), unlocks: game.unlocks[me],
      placementYaw: () => (game.bases[me] ?? spawnBase).yaw,
    });
    game.robotProduction = new RobotProduction({ buildMenu: game.buildMenu, catalog });
    game.buildMenu.robotProduction = game.robotProduction;
    game.buildMenu.researchView = new ResearchView({ buildMenu: game.buildMenu, research: world.research });
    hud.start({ race: raceOf(me), buildMenu: game.buildMenu });
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
  try {
    await loadStats();
    const races = raceList();
    if (races.length === 0) throw new Error('stats.json has no races');
    game.menu = new MainMenu(document.getElementById('menu'), {
      races, teams: TEAMS, onStart: startGame,
      multiplayer: { createTransport: mp.createTransport, Lobby: mp.Lobby },
      onMultiplayerStart: (info) => startMultiplayer(info).catch((err) => { console.error(err); hud.message(t('menu.errorLoading')); }),
    });
  } catch (err) {
    console.error(err);
    hud.message(t('menu.errorLoading'));
  }
}

// ---------- multiplayer: lockstep over src/net (docs/MULTIPLAYER.md) ----------

let net = null; // Lockstep during a multiplayer match, otherwise null
let netChannel = null;

function stopNet() {
  net?.stop();
  netChannel?.leave();
  net = null;
  netChannel = null;
  window.steelMans.net = null;
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
  });
  netChannel = info.channel;
  window.steelMans.net = net;
  await startGame({
    multiplayer: true,
    map: s.map, startPicks: s.startPicks, // [MAPS] from the host's start message (startPicks keyed by packed team)
    playerCount, alliances, // [N5] the same on every client (from the host's start message)
    races: byTeam.map((seat) => seat.race ?? races[0].key),
    colors: byTeam.map((seat, team) => seat.color ?? TEAMS[team].color),
    seats: byTeam.map((seat) => (seat.playerId === info.selfId ? 'human' : seat.controller === 'human' ? 'remote' : seat.controller ?? 'ai')),
    friendlyFire: s.friendlyFire, fogOfWar: s.fogOfWar, victory: s.victory,
    energyCap: s.energyCap, oreMultiplier: s.oreMultiplier, startMultiplier: s.startMultiplier, startResearch: s.startResearch, speed: s.speed, prebuild: s.prebuild,
    aiDifficulty: byTeam.map((seat) => (seat.controller === 'ai' ? seat.difficulty ?? null : null)),
    aiNames: byTeam.map((seat) => seat.aiName ?? null), avatars: byTeam.map((seat) => seat.avatar ?? null), // [N6] from the host
    avatarImgs: byTeam.map((_, team) => info.avatarImgs?.[team] ?? ''), // [UISMALL] thumbnails of the humans (lobby presence)
    isHost: info.selfId === info.hostId, // AI seats run only on the host; their commands travel like a player's
    seed: info.seed,
    localTeam: info.localTeam ?? PLAYER_TEAM, // spectators are not supported yet
  });
  net?.start(); // after startSimulation: tick 0, empty bus; switches commandBus.schedule to the network
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
function startSimulation(seed) {
  world.startSimulation(seed);
  commandBus.reset();
  simAccumulator = 0;
  simRunning = true;
}

function stopSimulation() { simRunning = false; }

function simTick() {
  captureTransforms();
  commandBus.executeTick(world, world.tick + 1); // world.update raises world.tick to the same number
  world.update(SIM_DT);
  hqBeams.update(); // light beam above every main building (visual only)
  game.match?.update(SIM_DT);
  updateAis(world.tick / SIM.tickRate);
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
  if (matchUi.pausesSimulation) { simAccumulator = 0; return 1; } // single player: the open game menu pauses
  simAccumulator += dt * gameSpeed.value; // N4: game speed = ticks per real second, SIM_DT unchanged
  let steps = 0;
  // readyForTick: a lockstep match waits for a produced unit's model (World.spawnDeferred)
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
    advanceSimulation(NET.hiddenMaxFrameTime, NET.hiddenMaxSteps);
  }
}, NET.hiddenPumpMs);

renderer.setAnimationLoop(() => {
  lastFrameTime = performance.now();
  const dt = Math.min(clock.getDelta(), SIM.maxFrameTime);
  const alpha = advanceSimulation(SIM.maxFrameTime, SIM.maxStepsPerFrame);
  minimap.update(dt);
  statsBar.update(dt);
  input.cleanSelection();
  cameraKeys.update(dt);
  edgeScroll.update(dt);
  controls.update();
  applyInterpolation(alpha);
  renderer.render(scene, camera);
  restoreInterpolation();
  hud.update(dt);
  updatePrebuildBanner(); // [N8] pre-build countdown
  econAlerts?.update();   // [D2] below the pre-build banner
  updateNetOverlay();
  matchUi.update();     // multiplayer pause banner
  rallyMarkers.update(); // rally lines of the selected own building
});

showMenu();
