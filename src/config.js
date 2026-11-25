// Steel Men – konfigurace modelů a socketů – SIT

export const MODELS_BASE = './models/';

// How model files are served: 'glb' = plain .glb files (local server); 'base64' = each model as
// <name>.glb.txt with base64 content (claude.ai artifact build – artifacts do not serve .glb).
// tools/build-artifact.ps1 switches this to 'base64' in its dist/ copy; keep 'glb' here.
export const MODEL_ENCODING = 'glb';

// Version label on the main menu ("test version v22"): the artifact version it is published as.
// Raise it before every artifact publish (docs/HANDOFF.md, "Artefakt").
export const GAME_VERSION = 'v29';
// Game name (brand, shown in the main menu title; not translated)
export const GAME_NAME = 'STEEL MEN';
export const BASE64_MODEL_SUFFIX = '.txt';
// Model folders (path prefixes) whose textures were exported upside down (V flipped – round floor pads came out
// inside out): the loader mirrors the texture transform once per model (src/core/AssetLoader.js), team colour copies
// keep it. Robot parts are correct; vehicles are not confirmed, add '3DVehicles' if they turn out flipped too.
export const MODEL_TEXTURE_FIX = { flipV: ['3DStructures', '3DVehicles/DrillTruck'] };
// Models with a missing wall (AssetLoader.fixGeometry): capFront closes the open +Z end of the listed models
// (path prefixes) with a flat face through the vertices within `tolerance` units of the frontmost one; the face
// takes the material of the rearmost mesh (the back wall) with the same planar texture mapping
export const MODEL_GEOMETRY_FIX = {
  capFront: { paths: ['3DVehicles/DrillTruck'], tolerance: 0.5 },
};

// --- [F2] weapon accuracy (src/game/Combat.js; balance numbers are in data/stats.json rules.combat.accuracy) ---
export const ACCURACY = {
  enabled: true,            // false = old rule (accuracy − evasion, no range / movement / melee factor, miss lands beside the target)
  testShots: 1000,          // default sample size of Combat.accuracyReport (console test)
  testRangeSteps: [0, 0.25, 0.5, 0.75, 1], // shares of the weapon range probed by the report
};
// --- [F2] end ---

// Aktivní rasa (poslední písmeno v názvu modelu: X / Y / Z)
export const RACE = 'X';

// Názvy kotevních bodů tak, jak jsou skutečně v GLB souborech
export const SOCKETS = {
  torso: 'socket_TorsoMount',   // v nohách
  leftArm: 'socket_ArmLeft',    // v trupu
  rightArm: 'socket_ArmRight',  // v trupu
};

// Sestava robota pro danou rasu (sada RobotPartsBasic)
export function basicLoadout(race = RACE) {
  return {
    legs:     `RobotPartsBasic/BasicLegs${race}_Skel.glb`,
    torso:    `RobotPartsBasic/BasicTorso${race}_Skel.glb`,
    leftArm:  `RobotPartsBasic/LeftBasicHandArm${race}_Skel.glb`,
    rightArm: `RobotPartsBasic/RightBasicHandArm${race}_Skel.glb`,
  };
}

// Part stats (HP, armor, speed, weapons...) live in data/stats.json – see data/README.md

// Camera panning with WASD / arrows
export const CAMERA = {
  panSpeed: 80,               // units/s at the reference distance
  panReferenceDistance: 80,   // farther away = proportionally faster
  // Right mouse button: a short click without moving = order, holding and dragging = pan the map
  rightDragThreshold: 6,      // px – moving farther than this while holding the right button starts a pan (no order)
  rightClickMaxTime: Infinity, // s – a longer still press issues no order either (Infinity = only the distance decides)
  rightDragSpeed: 1,          // 1 = the ground under the cursor follows the mouse ("grab the map"); scales with zoom
  rightDragGrab: true,        // true = map follows the mouse, false = camera moves in the drag direction
  // Edge scrolling (src/ui/EdgeScroll.js, on/off in Settings → Game: settings.ui.edgeScroll)
  edgeScrollWidth: 8,         // px – cursor this close to a window edge pans the camera (only over the map, window focused)
  edgeScrollSpeed: 80,        // units/s at panReferenceDistance (farther away = proportionally faster, like WASD)
};

// Camera limits (src/core/CameraBounds.js): the look-at point may not leave the map
export const CAMERA_BOUNDS = {
  overshoot: 10,              // units – how far past the map edge the look-at point may go (the edge stays in view)
  insetPerDistance: 0.3,      // units kept inside the edge per unit of camera distance (view tilt / zoom: less black border)
};

// Unit collisions and blocked move orders
export const MOVEMENT = {
  collisionStiffness: 0.5,   // share of an overlap removed per frame (1 = instantly, lower = softer push)
  crewMass: 10,              // crews are pushed around by mechs (mechs use their stats mass)
  defaultMechMass: 100,      // collision mass of a mech whose stats are not loaded yet
  standingMassFactor: 25,    // a unit standing still counts this many times heavier in collisions,
                             // so walking units give way to it (targets are not shoved around by attackers)
  progressStep: 1,           // units – getting this much closer counts as progress
  progressFacing: 60,        // degrees – while turning more than this, the unit is not considered stuck
  nearTargetDistance: 40,    // within this distance of the target the unit gives up sooner
  nearGiveUpTime: 1,         // s without progress near the target (spot taken by another unit)
  giveUpTime: 4,             // s without progress further away
  // Mech collision radius = max(body, (half the arm-socket distance + arm thickness) × armRadiusFactor).
  // The radius is also the target size for weapon ranges, so keep it below the shortest melee range.
  armRadiusFactor: 0.9,      // < 1 lets arms of neighbouring mechs overlap slightly (they swing anyway)
  maxArmThickness: 5,        // units – caps the measured arm width (weapons sticking out sideways)
  maxMechRadius: 9.5,        // units – hard cap; must stay below the shortest melee weapon range (10 in
                             // stats.json), otherwise a mech touching its target could not reach it
  contactSlack: 0.5,         // units – attackers stop pushing once this close to touching the target
  bodyRadiusFactor: 0.48,    // body radius = larger side of the legs+torso bounding box × this
  ringRadiusFactor: 1.25,    // selection ring radius = collision radius × this…
  ringMinMargin: 1,          // …but at least this many units outside the collision radius
  overlapEpsilon: 1e-3,      // units – closer than this counts as "exactly on top of each other"
};

// Pathfinding (src/game/Pathfinding.js) around static obstacles (crewless mechs, later buildings)
export const PATHFINDING = {
  cellSize: 7,               // units – grid cell over the 600×600 map
  clearance: 1,              // units added to unit radius + obstacle radius when planning
  repathInterval: 1,         // s – re-plan towards a moving target at most this often
  repathMoveThreshold: 4,    // units – …and only when the target moved at least this much
  waypointReach: 3,          // units – a waypoint counts as reached within this distance
  goalTolerance: 1e-3,       // units – planned goal this close to the ordered one = goal reachable as asked
  sidePreference: 0.25,      // blocked goal: weight of "distance from the unit" when picking the free spot
                             // (0 = purely nearest to the goal, higher = prefer the side the unit comes from)
};

/**
 * Maps (src/game/Map.js, data/maps/*.json). A map file gives its size, start positions, the super node
 * and obstacles; the defaults below fill in what the file leaves out. Terrain = flat plateaus around the
 * starts and the super node, gentle hills elsewhere (two sine layers, amplitude × frequency in units).
 */
export const MAP = {
  path: './data/maps/',
  defaultMap: 'basic',
  defaultSize: 600,          // units – terrain before a map is loaded (menu background)
  segmentsPerUnit: 0.2,      // terrain mesh resolution (vertices per unit along an edge)
  terrain: {
    hillAmplitude: [6, 10],  // units – height of the two hill layers
    hillFrequency: [[0.03, 0.025], [0.011, 0.017]], // per unit, [x, z] of each layer
    flatRadius: 70,          // units – fully flat around starts / super node
    flatFalloff: 90,         // units – hills fade in over this distance beyond flatRadius
    color: 0x5f6148,         // [A8-style] dead ground
    colorHigh: 0x6e6c52,    // tint of the hill tops
    colorVariation: 0.5,     // 0 = single colour, 1 = full tint at the highest point
    symmetryGain: 1.5,       // symmetric maps average 4 rotated hill layers (lower peaks) – this restores the height
  },
  startMarker: { radius: 14, width: 1.2, opacity: 0.35, height: 0.25, color: 0xdfe6ee, segments: 48 },
  // jitter = share of radius the vertices move; sink = share of the height buried in the ground
  rock: { color: 0x726b60, roughness: 1, detail: 1, jitter: 0.25, sink: 0.15 },
  ridge: { color: 0x655f55, roughness: 1 },
  superNode: {
    platformColor: 0x4a4f57, platformHeight: 1.2, platformSegments: 40,
    crystalColor: 0x39d4ff, crystalEmissive: 0x1a8fd0, crystalEmissiveIntensity: 1.4,
    crystalCount: 6, crystalHeight: 22, crystalWidth: 4.5, crystalRingFactor: 0.55, // ring radius = coreRadius × factor
    crystalTilt: 0.25,       // rad – outer crystals lean outwards
    largeCrystalScale: 0.6, smallCrystalScale: 0.4, // outer crystals (alternating) relative to the central one
    glowColor: 0x39d4ff, glowOpacity: 0.25, glowWidth: 2,
  },
  // Sun shadows follow the camera target (the shadow box is small, the map is large)
  sunOffset: [60, 100, 40],
};

/**
 * Fog of war (src/game/FogOfWar.js) for the local player (PLAYER_TEAM). Modes (world.settings.fogOfWar):
 * 'unexplored' = black until explored, explored terrain shrouded; 'explored' = whole terrain visible but
 * enemies only within sight; 'off' = everything visible. Sight = unit stats.sightRange.
 */
export const FOG = {
  defaultMode: 'unexplored',
  modes: ['unexplored', 'explored', 'off'],
  cellSize: 10,              // units – visibility grid cell
  updateInterval: 0.2,       // s between visibility updates (not every frame)
  unexploredBrightness: 0,   // terrain multiplier: never seen
  exploredBrightness: 0.45,  // …seen before but not in sight now
  visibleBrightness: 1,
  crewlessMechsSee: false,  // a mech without crew still reveals its surroundings
  minSight: 20,              // units – every own unit sees at least this far (units with sightRange 0)
};

/**
 * Minimap (src/ui/Minimap.js) – element #minimap in the bottom-right corner, created by the minimap.
 * Click / drag = move the camera there. A damaged own unit blinks for damageFlashTime.
 */
export const MINIMAP = {
  size: 245,                 // px (square) = inner slot of the HUD v2 minimap block at scale 1 (hud2 manifest minimapInnerBase 247×245); hud.css scales it with --hud-scale
  margin: 12,                // px from the window edges (hud.css places #minimap in its frame slot, this is only the pre-CSS default)
  updateInterval: 0.1,       // s between redraws
  background: 'transparent', // the frame block behind it is the plate
  border: 'none',            // HUD v2: the frame draws the border
  borderRadius: 0,           // px
  padding: 0,                // px around the map image (HUD v2: the map fills the slot exactly)
  terrainLow: '#4f5640',
  terrainHigh: '#7d7a5a',
  obstacleColor: '#2f2b26',
  superNodeColor: '#39d4ff',
  superNodeSize: 5,          // px radius of the super node mark
  startColor: 'rgba(223, 230, 238, 0.5)',
  startSize: 4,              // px radius of start markers
  unexploredColor: 'rgba(0, 0, 0, 1)',
  shroudColor: 'rgba(0, 0, 0, 0.5)',
  mechDot: 3.5,              // px half size of a mech square
  crewDot: 2,                // px half size of a crew square
  vehicleDot: 2.5,           // px half size of a vehicle square
  structureDot: 5,           // px half size of a building square
  viewColor: '#dfe6ee',
  viewWidth: 1.2,
  viewMaxDistance: 400,      // units – camera view outline is cut this far from the camera (horizon)
  damageFlashTime: 2,        // s a damaged unit blinks
  damageBlinkRate: 6,        // blinks per second
  damageColor: '#ffd166',
  damageRing: 6,             // px radius of the blink ring
  zIndex: 4,
  // [R2] sharp rendering: backing store = size × clamp(CSS size / size × devicePixelRatio, minPixelRatio, maxPixelRatio)
  minPixelRatio: 2,          // supersampling floor (also on 1× screens: the map is drawn at 2× and downsampled)
  maxPixelRatio: 3,          // cap of the backing store (memory / terrain pre-render cost)
  resizeDebounce: 0.25,      // s after the last window resize before the canvases are rebuilt
  structureScale: 0.6,       // building squares = R2.minimap.structureHalf × this (smaller squares; units stay circles)
};

/**
 * [B3] Radar look of the minimap (PPI scope): range rings, sweep line, markers of non-own units refreshed by the sweep
 * and fading until the next pass (phosphor afterglow). Terrain and fog stay live; own units stay live.
 */
export const RADAR = {
  redrawInterval: 1 / 30,    // s between redraws (smooth sweep)
  sweepPeriod: 6,            // s per full turn
  ringsInside: 4,            // rings from the centre to the frame edge; further rings run into the corners (clipped)
  // Colour = races[race].uiColor.primary of the local player (stats.json, like the HUD); this is only the fallback
  fallbackColor: '#7dffb0',
  ringAlpha: 0.28,
  ringWidth: 1,
  crossAlpha: 0.12,
  centerAlpha: 0.9,
  centerRadius: 2.2,         // px
  frameGlowAlpha: 0.14,      // inner glow of the frame (minimap.css via --radar-color)
  sweepLineAlpha: 0.9,
  sweepLineWidth: 1.4,
  trailDegrees: 55,          // length of the fading wedge behind the line
  trailAlpha: 0.32,          // opacity of the wedge right behind the line
  trailSteps: 40,
  afterglowTime: 5.5,        // s for a blip to fade from full to afterglowMin (about one sweepPeriod)
  afterglowMin: 0.25,        // opacity just before the next pass
  hitPulseTime: 0.35,        // s of the brightening when the sweep hits a blip
  hitPulseScale: 0.6,        // extra marker size at the hit
};

// ===== Phase 0 sections: each parallel agent adds its constants ONLY inside its own section (Edit tool) =====
// --- [W9] map edge fade (src/game/MapEdgeFade.js) ---
/** The terrain fades per pixel (shader, smoothstep) into a colour along the map border; visual only */
export const MAP_EDGE_FADE = {
  width: 100,               // units from the border over which the fade runs (tune 90–120)
  color: 0x000000,          // fully this colour at the border (applied after the fog); keep equal to outsideColor
  outsideColor: 0x000000,   // scene.background = what is seen beyond the map border (SceneSetup.applyPlanetLook)
};

// --- [DET] simulation / determinism ---
/**
 * Fixed-step simulation (main.js loop, World.update). The simulation always advances in ticks of 1 / tickRate s,
 * whatever the frame rate, and draws its random numbers from one seeded generator (world.rng, src/core/Rng.js),
 * so two clients running the same commands stay identical (lockstep multiplayer, replays, desync hashes).
 */
export const SIM = {
  tickRate: 30,             // simulation ticks per second (SIM_DT = 1 / tickRate); 60 = smoother animation, 2× CPU
  maxStepsPerFrame: 5,      // catch-up ticks per rendered frame at most; a slower machine slows the game down
  maxFrameTime: 0.25,       // s – longer frame gaps (tab in background) are cut to this before catching up
  defaultSeed: 0x5eed5eed,  // world.rng seed before a match picks one (tests, console experiments)
  spawnDelayTicks: 6,     // produced units appear this many ticks after the request (async model load window)
  lockstepLoadRetries: 3,   // [A1-3] lockstep match: a failed spawn / part load is retried this often, then the match is held
  lockstepLoadRetryMs: 2000, // [A1-3] real-time pause before each retry (only delays the waiting tick, never changes the result)
  interpolate: true,        // render moving objects between the last two ticks (smooth motion above tickRate fps)
  interpolationSnapDistance: 20, // units – a jump longer than this in one tick (teleport, crew exits) is not blended
  hashPositionScale: 100,   // world.stateHash rounds positions to 1/100 unit…
  hashAngleScale: 1000,     // …angles to 1/1000 rad…
  hashValueScale: 10,       // …and HP / resources to 1/10
};
// --- [DET] end ---
// --- [CMD] unit commands ---
/** Spacing of a group sent to one point (unitCommands.js 'move'; mechs use MECH.groupSpacing) */
export const CMD_GROUPING = {
  crewSpacing: 14,      // units between crews
  vehicleSpacing: 18,   // units between vehicles
};

/**
 * Formations (unitCommands.js 'setFormation' + shaped 'move' / attackMove / patrol / guard-point; Movement.js speed cap).
 * The mode is stored on the unit (unit.formation); a command uses the mode of the majority of its units (a tie goes
 * to the mode earlier in `modes`). 'free' = the old square grid with no speed limit; the others also make the group
 * walk at the speed of its slowest member.
 */
export const FORMATION = {
  modes: ['free', 'box', 'column', 'wedge'],   // button cycles through these; i18n formation.<mode>
  defaultMode: 'free',
  minHeadingDistance: 10,   // units – closer than this from the group centre to the goal the heading is defaultHeading
  defaultHeading: { x: 0, z: -1 },   // "away from the camera"
  kindGap: 14,              // units between the blocks of mechs / vehicles / crews (one behind the other)
  wedgeLateral: 0.75,       // wedge: sideways step per rank × spacing
  wedgeBack: 0.75,          // wedge: backward step per rank × spacing
  // [A7b] P2 marching formation (src/game/Formation.js): one leader path, members hold offsets, column in narrows
  minGroupSize: 2,          // own units a selection needs for the formation button / key / facing (1 unit = no formation at all)
  marchOrders: ['move', 'attackMove'], // point orders that march as a group (patrol / guard-point keep the P1 shape only)
  dragFacing: true,         // right-drag on the ground with a shaped group selected sets the front direction (instead of panning)
  dragFacingMinDistance: 6, // units on the ground the drag must cover before it counts as a direction
  regroupDistance: 60,      // units – a member farther than this from its spot plans its own path there
  regroupExitShare: 0.5,    // …and walks in formation again once closer than regroupDistance × this (with a clear line)
  slotTolerance: 6,         // units – a member this close to its spot counts as in place (gathering)
  catchupGain: 0.8,         // 1/s – extra speed per unit of distance behind the spot (members catch up, wait when ahead)
  lagTolerance: 15,         // units – members lagging less than this do not slow the leader
  lagStop: 60,              // units – at this lag the leader walks at minLeaderFactor × group speed
  minLeaderFactor: 0.2,     // the leader never stops completely for a lagging member (a stuck one must not hold the group)
  turnRate: 0.8,            // rad/s – how fast the formation turns to a new path direction
  finalAlignDistance: 40,   // units of leader path left from which the formation turns to its final front
  finishDistance: 20,       // units – the leader ending its order this close to its spot ends the march (members walk to their spots)
  minRemaining: 40,         // units – path length a marching member reports at least (no early arrival; > every arrive distance)
  gatherTimeout: 5,         // s – at the start the leader waits at most this long for the members to take their spots
  reformDelay: 1,           // s without a fighting member before the group forms again after a fight
  reformTimeout: 5,         // s – after a fight the leader waits at most this long for the members
  checkTicks: 6,            // simulation ticks between obstacle checks of a group (corridor width, spots, regroup)
  lookahead: 60,            // units ahead of the leader up to which the corridor width is checked too (fold before the gap)
  lookaheadSamples: 3,      // points checked on the way to lookahead (evenly spaced)
  narrowLagSlowdown: false, // in a column the leader does not slow down for lagging members (they queue behind it anyway)
  trailStep: 4,             // units between recorded leader positions (the column follows them)
  trailPoints: 160,         // recorded leader positions kept (trailStep × this = longest column)
  unfoldMargin: 10,         // units the leader walks in the open beyond the column length before the shape unfolds again
  columnSpacingFactor: 1,   // column gap = the member's formation spacing × this
  leaderRadiusShare: 0.75,  // leader candidates: path radius at least this share of the widest member's (then the front rank leads)
};

/** Building placement and deleting (Construction.js, Walls.js, buildCommands.js, CommandInput.js) */
export const CMD_BUILD = {
  yawResolution: 1000,            // building rotation is sent / simulated in steps of 1 / this rad (deterministic, smooth)
  keyRotateStep: Math.PI / 24,    // rad per key press (holding the key repeats) – KEYBINDINGS.rotateBuilding, Shift = reverse
  dragRotatePerPixel: Math.PI / 120, // rad per px of sideways drag while placing (after PLACEMENT.dragRotateThreshold)
  maxDeleteBatch: 64,             // buildings one deleteStructure command may remove
};

/** Walls reach the map edge: posts may stand flush with it, the last segment is cut to what fits */
export const CMD_WALL = {
  edgeMargin: 0,                  // units – walls stay this far inside the map edge (buildings: PLACEMENT.mapMargin)
  edgeEpsilon: 0.001,             // units – safety gap so a post at the edge is not rejected by rounding
  minTrimmedLength: 6,            // units – a cut segment shorter than this is left out
  trimTolerance: 0.01,            // units – a segment is "cut" when it is shorter than WALL.postSpacing by more than this
  previewCropStep: 0.1,           // units – the preview model is re-cut when the cut length changes by this much
};
// --- [CMD] end ---
// --- [PROD] production commands ---
// --- [PROD] end ---
// --- [ARMS] universal arms (src/game/PartStock.js): one stock item per arm type, mounted on either side ---
export const ARMS = {
  slot: 'arm',                // part slot of the factory / stock (one item "arm of type X")
  canonicalSlot: 'leftArm',   // stock key = the model of this side; the other side's model is derived from it
  sidePrefix: { leftArm: 'Left', rightArm: 'Right' }, // model file name prefix per mech slot
};
// --- [ARMS] end ---
// --- [BUILD] construction commands ---
// --- [BUILD] end ---
// --- [NET] multiplayer (docs/MULTIPLAYER.md) ---
/**
 * Lockstep multiplayer (src/net/). Only player commands travel; every client runs the same simulation.
 * One turn = turnTicks simulation ticks; commands given during turn T run at the start of turn T + inputDelayTurns.
 * The room capability drops messages, does not keep order and allows ~40 messages/s (emit + presence) of ≤ 4 KiB.
 */
// [W6] Loading screen (src/ui/LoadingScreen.js, css --loading-fade must equal fadeMs)
export const LOADING = {
  backgroundImage: '',   // path of the loading picture, e.g. 'data/image/loading.jpg' ('' = none, plain dark background)
  fadeMs: 250,           // fade-out time
  paintTimeoutMs: 100,   // show(): paint is awaited at most this long (hidden tabs run no animation frames)
};

export const NET = {
  minPumpMs: 16,             // [MP-POLISH] lower bound of the Lockstep pump() timer interval (ms)
  turnTicks: 3,              // ticks per turn (3 ticks at SIM.tickRate 30 = 100 ms); one turn message per turn
  inputDelayTurns: 2,        // a command runs this many turns after the turn it was given in (hides latency)
  hashEveryTurns: 10,        // world.stateHash() is compared every this many turns (desync detection)
  hashCarry: 3,              // each turn message repeats our last N hashes (a lost hash message is not fatal)
  hashKeepTurns: 120,        // turns of hashes kept for comparison and desyncReport()
  historyTurns: 600,         // executed turns kept for desyncReport() (60 s at the defaults)
  maxMessageBytes: 4096,     // room limit for one message (UTF-8 bytes of its JSON)
  messageHeadroomBytes: 384, // room left in a message for the header (acks, ping, hashes) when packing turns
  maxCommandBytes: 2048,     // (~300 unit ids in one command; must fit one message part: maxMessageBytes - headroom) a bigger local command is split by its `units` list (maxCommandChunks), else refused (never sent, never executed)
  maxCommandChunks: 16,      // [A1-3] a too-big command is sent as at most this many chunks ({…, units: part, chunk: [i, n]}); CommandBus joins them back
  maxChunksPerSend: 4,       // a backlog of unacknowledged turns goes out in at most this many messages at once
  resendMs: 200,             // nothing sent for this long (stalled / waiting): resend the unacknowledged turns + acks
  maxTurnsAhead: 64,         // a received turn this far beyond the executed one is ignored (garbage / old match)
  pingSmoothing: 0.2,        // exponential smoothing of the measured round trip (0..1, higher = faster reaction)
  readyResendMs: 250,        // [W6] loading barrier: how often an unfinished client repeats its `ready` message (ms)
  readyTimeoutMs: 120000,    // [W6] loading barrier: longest wait for the other humans before the match goes on (ms)
  hiddenPumpMs: 100,        // hidden tab (no animation frames): main.js runs due ticks on this timer (browsers may slow it to 1 s)
  hiddenMaxFrameTime: 1.5,   // s – real-time gap one hidden-tab pump may catch up…
  hiddenMaxSteps: 45,        // …in at most this many ticks
  waitOverlayMs: 400,       // status.stalledMs above this = main.js shows "waiting for players"
  // Testing robustness (BroadcastTransport only; URL ?netDrop=0.2&netLatency=150&netJitter=50 overrides)
  debugDropRate: 0,          // 0..1 – share of topic messages silently lost
  debugLatencyMs: 0,         // added one-way delay of every topic message
  debugJitterMs: 0,          // + random 0..jitter ms per message (reorders messages)
  // Lobby / game code
  codeLength: 5,             // characters of a game code (= room name)
  codeAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', // no 0/O, 1/I/L – easy to read aloud
  roomPrefix: 'sm-',         // room name = prefix + lower-case code (room grammar ^[a-z0-9][a-z0-9_.-]{0,47}$)
  roomUseTimeoutMs: 5000,    // claude.use('room') not answering by then = no room (outside an artifact: fallback to BroadcastChannel / P2P; inside one: multiplayer unavailable, no fallback)
  probe: {                   // netProbe.js: network self-test of the lobby (relays use NET.p2p.relayCheckTimeoutMs)
    iceMs: 4000,             // collecting ICE candidates (host / srflx) this long at most
    dbMs: 4000,              // claude.use('db') + one read at most
  },
  diagIdChars: 4,           // lobby network diagnostics line: this many leading characters of our peer id are shown
  selfIdTimeoutMs: 4000,     // waiting for our own peer label in the room's peer list
  joinTimeoutMs: 6000,       // lobby.join: no host found in the room by then = error
  createProbeMs: 800,        // lobby.create: listen this long whether the random code is already in use
  lobbyResendMs: 2000,       // the host re-sends the lobby state this often (lost messages, late joiners)
  startDelayMs: 1500,        // startAtMs = host clock + this (clients use it for a short countdown)
  startRepeat: 3,            // the 'start' message is sent this many times…
  startRepeatMs: 300,        // …this far apart (lost messages)
  // BroadcastTransport (two tabs of one browser, local testing)
  broadcastPrefix: 'steel-men-net-',
  broadcastHeartbeatMs: 1000, // presence re-sent this often
  broadcastPeerTimeoutMs: 4000, // a tab silent for this long has left
  // Embedding in a foreign page (src/input/EmbedGuard.js, itch.io iframe): keys that would scroll the host page
  embedScrollKeys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End'],
  // P2PTransport (static web: WebRTC, signalling over public Nostr relays; vendor/trystero, docs/notes/p2p-transport.md)
  p2p: {
    appId: 'steel-men-rts-v1',  // Trystero namespace; change it when the wire format breaks (old clients never meet)
    strategy: 'nostr',           // signalling strategy vendored in vendor/trystero/ (only 'nostr' is shipped)
    // wss:// signalling relays. Trystero's own default list is a random set of obscure relays (many dead), so we pin
    // well-known public ones; empty = Trystero's default list. Verify with relayCheck.js (docs/notes/g-web-iframe.md).
    relayUrls: [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://offchain.pub',
      'wss://nostr.mom',
      'wss://relay.snort.social',
    ],
    relayRedundancy: 5,          // relays used at once from the default list
    warnOnRelayFailure: false,   // Trystero console warnings about single relays (noisy; one dead relay is normal)
    relayTimeoutMs: 10000,       // join(): no relay socket open by then = P2PError net.p2p.error.relays
    outboxMax: 16,               // sends made before the first peer connected are held (max count, flushed to the first peer)
    outboxTtlMs: 15000,          // ...and dropped when older than this
    relayPollMs: 100,            // how often join() checks the relay sockets
    handshakeTimeoutMs: 10000,   // Trystero peer handshake after the data channel opened
    lobbyJoinTimeoutMs: 25000,   // transport.joinTimeoutMs hint: finding the host over relays + WebRTC takes 2–15 s
    // [LOBBY_LIST] P2PSignalWatch: a peer that talks to us but sends no offer / answer this long = other password
    passwordSuspectMs: 6000,
    signalWatchMaxFrameChars: 65536, // relay frames longer than this are not inspected
    signalWatchMaxPeers: 32,         // peers tracked by one watch
    stunUrls: [                  // public STUN (address discovery only, no traffic goes through them)
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ],
    turnServers: [],             // optional TURN relays {urls, username, credential} for strict NAT (none yet)
    topics: ['lobby', 'turn', 'hash', 'start', 'ready', 'chat', 'save', 'cont'], // [A2-net] save transfer + continue sync; receivers registered as soon as a room is joined
    relayCheckTimeoutMs: 5000,   // relayCheck.js: a relay not answering a subscription (EOSE) by then counts as dead
    relayCheckKind: 20078,       // relayCheck.js: ephemeral event kind in the test subscription (any valid kind works)
  },
  // [LOBBY_LIST] list of open games over the same Nostr relays (src/net/LobbyDirectory.js, docs/notes/lobby-list.md)
  directory: {
    topicSuffix: 'lobby-dir-v1', // Nostr `x` tag = p2p.appId + ':' + this (ephemeral kind derived from it by Trystero)
    relayCount: 6,               // first N relays of p2p.relayUrls (host and viewer use the same list)
    announceMs: 8000,            // host of a public game re-announces this often
    entryTtlMs: 25000,           // viewer drops an entry not refreshed for this long
    sweepMs: 2000,               // viewer checks expiry (and refreshes its status line) this often
    replyJitterMs: 800,          // host answers a viewer's query after a random 0..this ms (many hosts do not answer at once)
    replyMinIntervalMs: 2000,    // ...and sends at most once per this interval (queries flood = no flood of answers)
    offlineAfterMs: 8000,        // viewer: no relay open by then = "cannot reach the game list"
    reconnectMinMs: 2000,        // relay socket reconnect backoff: first wait…
    reconnectMaxMs: 30000,       // …doubling up to this
    reconnectJitter: 0.5,        // + random 0..this share of the wait
    maxEntries: 100,             // viewer keeps at most this many games (one per sender key; full = oldest refresh dropped)
    tombstoneMs: 30000,          // viewer: after 'closed', a delayed older 'game' of that sender + code is ignored this long
    maxContentChars: 1024,       // event content longer than this is ignored
    maxFrameChars: 4096,         // relay frame longer than this is ignored before parsing
    maxClockSkewS: 120,          // event created_at further than this from our clock is ignored (replays)
    seenMax: 512,                // event ids remembered for dedup across relays
    mapIdMaxLength: 64,
    buildMaxLength: 16,          // GAME_VERSION string; another value = greyed out entry
    subIdLength: 16,             // characters of our Nostr subscription id
    keyChars: 16,                // entry.key = this many leading characters of the sender's pubkey (UI list key)
  },
};
// --- [NET] end ---
// --- [CHAT] [N11] text chat in multiplayer (src/net/Chat.js, src/ui/ChatBox.js, docs/notes/n11-chat.md) ---
export const CHAT = {
  topic: 'chat',            // transport topic, outside the lockstep (never touches the simulation)
  teamPrefix: '/t ',        // typed prefix = team message (Shift+Enter does the same); '/a ' = everyone
  allPrefix: '/a ',
  maxLength: 200,           // characters of one message (longer is cut)
  minIntervalMs: 700,       // sender: at least this between two messages (faster is refused)
  burstCount: 5,            // receiver: more than this many messages from one peer ...
  burstWindowMs: 5000,      // ... within this window are dropped
  maxNameLength: 24,        // sender name shown (lobby nickname, cut)
  visibleLines: 8,          // lines shown over the map
  lineTtlMs: 12000,         // a line fades after this
  fadeMs: 1500,             // fade-out duration at the end of the ttl
  historyMax: 50,           // lines kept (reopening the field shows the recent ones again)
  scopeTeamColor: '#7fd0ff',// colour of team-only lines
};
// --- [CHAT] end ---
// --- [NET_LEAVE] a player leaving a running multiplayer match (src/net/Lockstep.js, docs/notes/mp-leave.md) ---
export const NET_LEAVE = {
  commandType: 'playerLeft', // CommandBus command injected by the lockstep in the drop turn (game/commands/matchCommands.js)
  graceMs: 1500,             // the coordinator waits this long after a player vanished before dropping it (acks settle)
  minPlayersToContinue: 2,   // [MP-LEAVE2] sides needed to go on without the leaver: still playing connected humans + AI teams (while the host stays); observers not counted
  maxNameLength: 32,         // lobby nickname carried in Lockstep players (same limit as the lobby)
  maxRelayTurns: 64,         // at most this many of a leaver's turns relayed to the others in one message
  noticeMs: 5000,            // main.js shows "Player X disconnected" this long (status.lastLeft)
  desyncConfirmMs: 5000,     // a hash mismatch is reported after this long, unless the odd player left meanwhile
                             // (≥ BroadcastTransport peer timeout NET.broadcastPeerTimeoutMs)
};
// --- [NET_LEAVE] end ---
// --- [NET_LEAVE_WIN] a player leaves a running MP match (src/net/Lockstep.js, docs/notes/b6-mp-qa.md) ---
export const NET_LEAVE_WIN = {
  minPlayingHumans: 1, // still playing connected humans (observers not counted) needed to drop a vanished player
                       // (a host takes its AI teams along); a single side left then wins at once instead of waiting.
                       // Fewer (e.g. an observer host + its AI) = the match waits (paused)
};
// --- [NET_LEAVE_WIN] end ---
// --- [LOBBY] lobby screen ---
export const LOBBY = {
  codeMaxLength: 16,     // max characters of the join-code input
  copyFeedbackMs: 1500,  // how long the copy button shows "Copied"
  // [LOBBY_LIST] game name, visibility, password (docs/notes/lobby-list.md)
  nameMaxLength: 40,           // characters of a game name (lobby state, directory entry)
  passwordMaxLength: 64,       // characters of a game password (Trystero `password`; never stored, never published)
  visibilities: ['public', 'code'], // 'public' = in the game list (P2P only), 'code' = join by code only
  defaultVisibility: 'public',
  passwordGraceMs: 3000,       // join: after a "wrong password" signal, wait this long for the host state before failing
  kickedMax: 32,               // host: at most this many kicked player ids kept in the lobby state (oldest dropped)
};
// --- [LOBBY] end ---
// --- [AIMENU] computer player choice in New game and the lobby ---
export const AIMENU = {
  difficulties: ['easy', 'normal', 'hard'], // i18n keys: ai.difficulty.<id> (+ .hint)
  defaultDifficulty: 'normal',
};
// --- [AIMENU] end ---
// --- [AI] classic computer player (src/ai/, data/ai/*.json, docs/AI.md) ---
/**
 * Technical constants of the AI. Everything that differs between difficulties or factions is data
 * (data/ai/difficulty.json, buildOrders.json, armies.json, defense.json). Times are simulation seconds,
 * distances world units.
 */
export const AI = {
  dataPath: './data/ai/',
  perceptionInterval: 0.5,        // s – how often the team's knowledge (own units, seen enemies, memory) is refreshed
  intervals: { strategy: 1, economy: 2, construction: 1, production: 1, military: 1, scout: 3, research: 3, maintenance: 2 }, // × difficulty.thinkScale
  maxUpdateStep: 1,               // s – a longer gap between update() calls is cut to this (tab in background)
  apmBurst: 6,                    // commands the rate limiter may send at once after a quiet period
  memorySeconds: 150,             // a mobile enemy unseen for this long is forgotten (structures stay until seen gone)
  baseRadius: 150,                // enemies this close to an own structure are a threat to the base
  threatForgetSeconds: 8,         // no enemy near the base for this long = threat over
  rallyDistance: 75,              // army gathers this far in front of the HQ (towards the map centre)
  gatherRadius: 45,               // units within this distance of the rally point count as gathered
  gatherTimeout: 45,              // s – a wave starts anyway after waiting this long for stragglers
  waveReorderInterval: 8,         // s – an attacking wave gets its attack-move again this often (new target / idle units)
  arrivalRadius: 50,              // wave reached its target point (nothing known there any more → next target)
  boardReserveSeconds: 25,        // a mech promised to a crew is not given to another crew for this long
  buildResultTimeout: 12,         // s – a placement command without a result by then is forgotten
  failedSpotSeconds: 60,          // a spot the simulation refused is avoided for this long
  orphanSeconds: 15,              // an unfinished own building nobody worked on for this long gets a builder
  // Building spots: rings around the HQ; `gap` = free space kept around every building (paths); the cone in front of
  // the HQ (cos > frontConeDot, farther than frontClearFrom) stays free for the army and the defences
  // E1: base buildings keep a crew passage (Construction #passageGap: nav cell + 2 × (crew radius + clearance));
  // passRadius = crew radius used before any own crew exists
  // [A1-5] denseSpacing = units between spots along a ring once a building found no spot (more than `angles` per ring)
  placement: { minRadius: 30, step: 8, maxRadius: 220, angles: 24, gap: 7, frontConeDot: 0.5, frontClearFrom: 40, defenseSearchRadius: 40, passRadius: 5, denseSpacing: 10 },
  // No spot found for a building: the next search reaches radiusGrowth farther (up to maxRadiusLimit, the front cone
  // is allowed from the 2nd failure), retries wait retryBase × 2^(failures-1) s (≤ retryMax); after giveUpAfter
  // failures the building id is not wanted any more for giveUpSeconds (reactive builds only; the log notes it once)
  noSpot: { radiusGrowth: 60, maxRadiusLimit: 400, retryBase: 10, retryMax: 120, giveUpAfter: 4, giveUpSeconds: 300 },
  // Research (src/ai/managers/Research.js, data/ai/research.json)
  research: { salvageRadius: 260, salvageEnemyRadius: 90, salvageOrderSeconds: 40 },
  // Repairs (src/ai/managers/Maintenance.js): a mech has this long to get into its bay; arm wrecks this close are
  // collected by armless mechs; trucks repair units / buildings within fieldRadius of the base or rally point
  maintenance: { bayTimeout: 60, collectRadius: 70, fieldRadius: 200, truckReserveSeconds: 6, builderFreeSeconds: 8 },
  // Squads (Military): harass squad settles on a target this long; artillery stops this share of its range behind
  // the wave and shoots what is within range × artilleryReach
  harassRetarget: 15,
  harassArrival: 40,
  artilleryStandoff: 0.8,
  artilleryReach: 1.05,
  // Enemy composition (Perception): a seen unit's weapon classes / armour are kept this long for the counters
  compositionSeconds: 300,
  wallShiftStep: 12,              // a defence wall line that does not fit is moved outwards by this much…
  wallTries: 4,                   // …this many times before the item is skipped
  turretWaitSeconds: 150,         // turrets wait this long for their wall posts to be finished
  partStatsCacheSeconds: 30,      // part stats are re-read this often (research changes them)
  // [A1-5] robots while energy is tight: a part with an energy cost that could not be ordered (resources / budget)
  // makes new plans ore-only for energyTightSeconds; a plan needing energy, waiting longer than planStaleSeconds
  // with energy tight, is dropped (X / Z: every ranged arm costs energy – the first plan blocked all parts)
  mechEnergy: { energyTightSeconds: 30, planStaleSeconds: 45 },
  starvedSeconds: 20,             // a resource we lacked within this time counts as "short"
  scoutWaypointRadius: 40,        // a scout waypoint is done when explored or this close
  superNodeSafeRadius: 120,       // harvesting at the super node needs no known enemy army within this radius
  strengthHpCap: 4000,            // hp used in the strength formula is capped (buildings would dominate it)
  // v3 (docs/notes/ai-v3.md). Bays: the bay rally point is sent again when bb.rally moved rallyMove or more (a sent one
  // counts for resendSeconds); a crew sent into a bay counts as on its way for joinSeconds before its order shows
  bays: { rallyMove: 20, resendSeconds: 6, joinSeconds: 6 },
  // Help an attacked ally (difficulty.squads.helpAllies): its base within radius of ours, home strength at least
  // minShare × the attackers; keepHome = share of the home units (nearest our HQ) that stays; the help point moves
  // only by repoint or more (each move = new orders)
  allyHelp: { radius: 650, minShare: 0.3, keepHome: 0.3, repoint: 40 },
  // Allied AIs gang up: an enemy team an ally attacks (allyBoard entry not older than seconds) counts as nearer by factor
  allyFocus: { seconds: 60, factor: 0.6 },
  // Super node squad (difficulty.squads.superNode): stands offset × node radius from the node centre towards our base;
  // leaves when the known enemy army near the node is stronger than maxDangerRatio × the squad
  superNodeHold: { offset: 1.0, maxDangerRatio: 1.5 },
  // v4 (docs/notes/ai-v4.md): a placement the game refused is logged once per building + reason within this time
  econ: { refusalNoteSeconds: 30 },
  // D2: a team without a main building (start set 1, or a lost HQ): the HQ's missing energy has to come from power plants
  // whose income is cut to noHqIncomeFactor – wanted so the gap closes within energySeconds, at most maxPlants in all
  hqRecovery: { energySeconds: 120, maxPlants: 6 },
  // v5: recon before an attack – the scout is done this close to the enemy building / start it looks at;
  // research "waits" log lines: the same kind of reason at most once per noteSeconds
  recon: { arriveRadius: 70 },
  researchNoteSeconds: 60,
  fastForward: { chunkTicks: 150, reportEverySeconds: 60 }, // AI vs AI console mode (src/ai/aiVsAi.js)
  // R3 (docs/notes/r3-air-ai.md): enemy aircraft are forgotten (no anti-air wishes) after forgetSeconds unseen;
  // aircraft of a going wave escort the ground units: they attack-move escortLead units ahead of the ground centre
  // towards the target and go for the target itself once the ground units are within escortRelease of it
  // E1 (docs/notes/e1-ai-air.md): an aircraft blocked by a full population cancels one queued crew / combat vehicle
  // at most every releaseCooldown s (after difficulty.air.releaseAfter s of waiting)
  air: { forgetSeconds: 240, escortLead: 30, escortRelease: 150, releaseCooldown: 6 },
  // E1: a finished unit's population counts until it enters the world, at most this long (s) – the game frees it at
  // completion, the unit appears SIM.spawnDelayTicks later or once its model loaded (a check in between let the AI
  // go over its cap; fastForward runs whole chunks before a model load resolves)
  spawnPopulationSeconds: 20,
  // v20: a crew walking to a robot that gets no closer by `progress` units within `seconds` is stopped; that crew +
  // robot pair is avoided for avoidSeconds (log line on the 1st and every noteEvery-th case)
  // E1: a robot mechFails different crews could not reach is avoided by all crews for avoidSeconds; the last keepSpots
  // cases are kept for the console (military.stuckSpots, neighbours within spotRadius)
  boardStuck: { seconds: 20, progress: 4, avoidSeconds: 120, noteEvery: 10, mechFails: 2, keepSpots: 10, spotRadius: 25, crewSpotRadius: 45 },
};
// --- [AI] end ---
// --- [A2-ai] AI taking over a game in progress (src/ai/Resume.js, docs/notes/a2-ai.md) ---
export const AI_RESUME = {
  // Defence plan items that already stand are skipped: a tower within placement.defenseSearchRadius of its planned
  // point, a straight wall with a post within half its length + slack of its centre, an edge wall with a post within
  // wallShiftStep × ceil(wallTries / 2) + slack of the point edgeProbePosts posts out along it
  defense: { slack: 20, edgeProbePosts: 2 },
  // Army units farther than baseRadius × awayRadiusFactor from the base on an attack order = the previous owner's wave
  // (adopted when at least difficulty.attack.minWave); units on releaseOrders (orders the AI never gives) go home
  military: { awayRadiusFactor: 2, releaseOrders: ['patrol', 'guard'] },
};
// --- [A2-ai] end ---
// --- [LOADOUT] starting robot loadouts (src/game/StartLoadouts.js) ---
// Per slot a list of part sets in order of preference: the first one the faction may produce (canProduce) and has a
// model of wins, so one template gives every faction its own robot. Frame / Alien are never picked.
export const LOADOUT = {
  fallbackSet: 'Basic',             // used when no listed set fits the faction
  player: ['universal', 'duelist', 'brawler'], // robots at the player's start (the second mixes melee + ranged)
  enemy: ['duelist', 'gunner'],     // enemy test squad (same faction as the enemy player)
  templates: {
    // Plain all-round robot: basic body, shield arm + machine gun
    universal: { legs: ['Basic'], torso: ['Basic'], leftArm: ['Shield'], rightArm: ['GattlingGun'] },
    // Melee: heavy legs + armour, hammer/fist and blade
    brawler: {
      legs: ['HighStrength', 'HTHupgrade', 'PowerShield', 'JumpJet'],
      torso: ['Armor', 'SelfRepair'],
      leftArm: ['HammerHand', 'PowerFist', 'ElectroGrip', 'BladeArm'],
      rightArm: ['Axe', 'KatanaSword', 'ElectroGrip', 'BladeArm'],
    },
    // Ranged: weapon legs and torso, missiles / blaster, machine gun when the faction has nothing better
    gunner: {
      legs: ['PowerGun', 'Laser', 'BlastPulse', 'Steady'],
      torso: ['DrunkMissile', 'Tracer', 'Flak'],
      leftArm: ['HomingMissile', 'GattlingGun'],
      rightArm: ['EnergyBlaster', 'GattlingGun'],
    },
    // Mixed: one melee arm and one ranged arm (to try the stance switch)
    duelist: {
      legs: ['Sonar', 'Steady', 'JumpJet'],
      torso: ['SelfRepair', 'Armor', 'JetPack'],
      leftArm: ['KatanaSword', 'Axe', 'ElectroGrip'],
      rightArm: ['EnergyBlaster', 'GattlingGun'],
    },
  },
};
// --- [LOADOUT] end ---
// --- [MISC] test reminders (minimap orders, carried parts) ---
export const MISC = {
  cargoScale: 1, // a part carried by a builder keeps its size from the robot (1 = unchanged; was VEHICLE.cargoScale 0.45)
};
// --- [MISC] end ---
// --- [R2] visual reminders 16, 17, 20–22, 24, 25, 27 (docs/notes/r2-visual.md) – visual only, never touches the simulation ---
export const R2 = {
  // 24: empty space outside the map (scene background + the fog that fades the terrain into it)
  void: { color: 0x0b0e12, fogNear: 500, fogFar: 1600 },
  // 17: minimap markers – buildings small squares, units circles; sizes (px at refHeight) scale with the window height
  minimap: {
    refHeight: 1080, minScale: 0.7, maxScale: 2.2,
    structureHalf: 3,        // half side of a building square
    mechRadius: 3, vehicleRadius: 2.6, crewRadius: 1.8,
  },
  // 20: idle look-around of turrets on wall posts / point defence (the aiming yaw of the simulation is untouched)
  idleLook: {
    amplitudeDeg: 55,        // sweep to each side of the resting direction
    periodSeconds: 14,       // one full left-right-left sweep
    speedDeg: 25,            // max visual turn speed while idle
  },
  // 21: a part node is mapped to a skeleton node only when their rest positions are this close (units of the model);
  // farther nodes (flak turret on the torso) get no animation instead of borrowing a random limb's clip
  animBindMaxDistance: 6,
  // 25: straight narrow beam rising from the main building (hq) in the player's colour
  hqBeam: {
    radius: 0.9, height: 420, segments: 10, opacity: 0.55, pulse: 0.2, pulseSpeed: 2.2,
    startFactor: 0.5,        // beam starts at this fraction of the building's body height
    coreRadiusFactor: 0.35,  // brighter thin core inside
  },
};
// --- [R2] end ---
// --- [R3] build grid order, salvage drop-off ---
// Row of the building grid per building role (BuildMenu.buildRole derives the role from stats.json: an explicit
// `role` field wins, else the data decides – produces / income / storage / hq / requiresTier / wallSegment / mountOn /
// weapons). Roles missing here go to the last row.
export const BUILD_GRID = {
  // Each row starts on a new grid line (padded with empty slots to HUD.optionGrid.columns)
  roleRow: {
    hq: 1, crew: 1, vehicle: 1, aircraft: 1,
    power: 2, storage: 2,
    part: 3, mech: 3,
    research: 4, advancedResearch: 4,
    pointDefense: 5,
    wall: 6, turret: 6,
  },
  // Order of roles inside a row (unlisted roles keep the data order after these)
  roleOrder: ['hq', 'crew', 'vehicle', 'aircraft', 'power', 'storage', 'part', 'mech', 'research', 'advancedResearch', 'pointDefense', 'wall', 'turret'],
  lastRow: 7,
};
// Buildings (besides rules.salvageResearch.stockOnlyTo) where a builder unloads a carried part into the shared part stock
export const SALVAGE_DROP = {
  stockBuildings: ['robotAssemblyBay'],
};
// --- [R3] end ---
// --- [R1] combat reminders (docs/notes/r1-combat.md): fire from the fog, melee at buildings, target priority, spawn spots ---
// Reaction of an idle armed unit hit by an enemy it cannot see, with no enemy in sight (UnitCombat.fogReaction)
export const FOG_REACTION = {
  advanceMax: 60,            // units – aggressive: attack-move this far towards where the shot came from (at most up to the shooter)
  dodgeMin: 10,              // units – defensive: step back from the shooter at least this far…
  dodgeMax: 40,              // units – …and at most this far
  dodgeMargin: 8,            // units beyond the shooter's longest weapon range the step tries to reach
  dodgeWait: 3,              // s – defensive: wait this long out of reach before walking back home
  mapMargin: 5,              // units – advance / dodge points stay this far inside the map edge
  lostChaseTime: 25,         // s – aggressive: the walk to a target's last known position is dropped after this long
};
// Automatic target choice (Combat.pickTarget): cost = edge distance + class penalty − threat bonus, lowest wins.
// Only automatic choices use it (idle, attack-move / patrol / guard, targets of opportunity) – never a player's attack order.
export const TARGET_PRIORITY = {
  armedPenalty: 0,           // units – units that can fight back (weapons with damage: mechs, armed vehicles, turrets)
  unarmedPenalty: 80,        // units – mechs without weapons or crew, trucks, unarmed crews…
  structurePenalty: 160,     // units – buildings and walls without weapons (larger than any sight range: last choice)
  dpsWeight: 1.5,            // units of distance one point of DPS is worth (a dangerous unit a bit further away wins)
  dpsBonusMax: 40,           // units – cap of the threat bonus
  retargetClassGap: 1,       // an automatic attack switches when a target this many classes better appears (armed < unarmed < structure)
};
// Melee against buildings (Combat.edgeDistance measures to the footprint box, not a circle)
export const MELEE_STRUCTURE = {
  reachBonus: 2,             // units – extra melee reach against a building (pathfinding clearance + grid slop)
};
// Spawn / deploy spot around a producing building (Structure.findSpawnPoint)
export const SPAWN_SPOT = {
  defaultRadius: 9.5,        // units – radius assumed for the produced unit (= MOVEMENT.maxMechRadius: fits every unit)
  sampleStep: 8,             // units between candidate spots along a ring around the building
  ringStep: 10,              // units between rings
  rings: 4,                  // rings tried around the building before giving up
  edgeGap: 1,                // units beyond radius + PATHFINDING.clearance between the building and the first ring
  reserveTicks: 15,          // ticks a taken spot stays reserved (unit appears SIM.spawnDelayTicks later)
  mapMargin: 5,              // units – spots stay this far inside the map edge
};
// --- [R1] end ---
// --- [R4] rally points and spawn stance of unit-producing buildings (docs/notes/r4-gather.md) ---
export const RALLY = {
  maxPoints: 8,              // points of one rally chain (Shift + right click adds one)
  applyTimeoutTicks: 1200,   // ticks Production waits for a produced unit to appear before it forgets it (model never loaded)
  spawnModes: ['aggressive', 'defensive', 'passive'], // order of the stance button; a crew refuses 'aggressive' (Crew.setBehaviour)
  stanceIcons: { aggressive: '🔥', defensive: '⛨', passive: '☮' },
  // Line + marker of the selected own building (src/ui/RallyMarkers.js)
  marker: {
    color: 0x7fffa0,
    opacity: 0.8,
    height: 0.6,             // units above the terrain
    ringRadius: 2.4,         // units
    ringWidth: 0.5,          // units
    ringSegments: 20,
    poleHeight: 7,           // units – vertical pole on the last point
    maxPoints: 128,          // rings drawn per frame
    maxSegments: 1024,       // line segments drawn per frame (legs are subdivided to follow the terrain)
    legStep: 4,              // units – length of one line piece along a leg
  },
};
// --- [R4] end ---
// --- [R6] terrain under buildings (reminder 18), auto assist of idle HoverTrucks (reminder 19) – docs/notes/r6-terrain.md ---
// A building stands on flattened ground: the terrain under its footprint is levelled to the middle of its height range.
// Placement is refused where the footprint spans more than maxHeightDelta (steep slope) – simulation, preview and AI alike.
export const TERRAIN_FLATTEN = {
  maxHeightDelta: 4,         // units – highest minus lowest terrain point under the footprint above which nothing may be built
  maxSlope: 0.15,            // height per unit of the longest footprint side – a big building may span more than maxHeightDelta (39 → 5.85)
  sampleStep: 2.5,           // units between height samples over the footprint (the footprint edges / corners are always sampled)
  margin: 2.5,               // units – the levelled area reaches this far beyond the footprint box (the terrain mesh is a 5-unit grid)
  heightResolution: 100,     // the level is rounded to 1 / this (identical number on every client)
};
// Idle HoverTrucks help on their own when the team's setAutoAssist is on (simulated from the setAutoAssist command)
export const AUTO_ASSIST = {
  radius: 90,                // units – the truck only looks for work this far from where it stands
  scanInterval: 1,           // s between two looks of an idle truck (fixed sim step, deterministic)
  repairMechs: false,        // mechs power down while repaired (bad in a fight) – only vehicles and buildings are repaired
  defaultOn: true,           // profile default of ui.autoAssist (SETTINGS_DEFAULTS is not mine: see the note)
};
// --- [R6] end ---
// --- [MINOR_FIXES] small defects from docs/notes/verify-night.md (docs/notes/minor-fixes.md) ---
export const MINOR_FIXES = {
  salvageReachSlack: 6,      // units – extra pickupRange for a truck that stands at the end of its path (wreck beside a wall:
                             // the path ends at the nearest free grid cell, which can be farther than pickupRange)
  salvageGiveUpTime: 3,      // s – a truck at the end of its path and still out of reach drops the salvage order
};
// --- [MINOR_FIXES] end ---
// --- [R5] pause (reminder 14, docs/notes/r5-pause.md): solo = game menu open, multiplayer = lockstep pause ---
export const PAUSE = {
  commandType: 'pause',      // control entry inside a lockstep turn (never reaches the CommandBus)
  maxNameLength: 24,         // nickname carried with a pause request (chars)
  soloPausesWithMenu: true,  // single player: the in-game menu (and the settings opened from it) pauses the game
  pendingMs: 3000,           // [MP-POLISH] how long the requester's "pausing" window waits for the real pause
  bannerPollMs: 250,         // [MP-POLISH] banner refresh when no animation frame comes (hidden tab)
};
// --- [R5] end ---
// --- [N2] crews waiting in an assembly bay (src/game/BayCrew.js, docs/notes/n2-baycrew.md) ---
export const BAY_CREW = {
  capacity: 5,               // crews one assembly bay holds in its queue (FIFO: a new mech takes the first one)
  entryRange: 12,            // units – gap between the crew's edge and the bay footprint at which the crew goes in
  boardInstantly: true,      // a mech made in the bay with a queued crew skips rules.crew.boardTime (active at once)
  releaseIcon: '⏏',          // grid button "let the crews out" (RobotProduction)
};
// --- [N2] end ---
// --- [TEAM] fog / local team ---
// Seats of a new game: who controls each team. 'human' = this computer, 'ai' = computer opponent (not implemented
// yet: behaves like a passive enemy), 'remote' = another player over the network (lockstep room).
export const SEATS = {
  controllers: ['human', 'ai', 'remote'],
  defaults: ['human', 'ai'], // index = team; teams beyond the list default to defaultOther
  defaultOther: 'ai',
};
// --- [TEAM] end ---

// Teams: index = unit.team; color = colour painted onto the team's models (see TEAM_COLOR) and team rings
// PLAYER_TEAM = default local seat only. UI code uses localTeam() from src/core/LocalPlayer.js instead.
export const PLAYER_TEAM = 0;
// [N5] one entry per seat, MAX_PLAYERS entries (blue, red, green, yellow); seats past the player count are not in the match
export const TEAMS = [
  { nameKey: 'common.player', color: '#3a5ccc' },  // nameKey = i18n key of the team name (t(nameKey))
  { nameKey: 'common.enemy', color: '#c8302c' },
  { color: '#3f9e4d' },                            // no nameKey: SelectionPanel falls back to its generic name
  { color: '#e8a21a' },                            // orange-yellow = default of seat 4, the faction W (races.W.uiColor.primary)
];

/**
 * The "team blue" painted into every model texture (measured from the textures: hue ~222°,
 * saturation ~0.58, value ~0.55). Pixels within hueRange (+ soft edge) and above minSaturation
 * get the team colour. Widen hueRange if some blue stays, narrow it if other colours change.
 */
export const TEAM_COLOR = {
  referenceHue: 222,         // degrees
  hueRange: 24,              // full effect within ±hueRange of referenceHue
  hueSoftness: 12,           // fade out over the next degrees (keeps cyan glass / lights untouched)
  minSaturation: 0.12,       // greys and whites are not team colour
  saturationSoftness: 0.1,
  referenceSaturation: 0.58, // average of the team blue – maps exactly onto the team colour
  referenceValue: 0.55,
};

/**
 * Key bindings – KeyboardEvent.code values, i.e. PHYSICAL key positions. They work the same on Czech
 * (QWERTZ) and English layouts: the key left of "1" etc. Remap here; each action takes a list of keys.
 * Control groups: groupModifier + controlGroups[i] = save group i+1, controlGroups[i] alone = select it,
 * pressing it twice quickly also centres the camera on the group.
 */
export const KEYBINDINGS = {
  cameraForward: ['KeyW', 'ArrowUp'],
  cameraBack: ['KeyS', 'ArrowDown'],
  cameraLeft: ['KeyA', 'ArrowLeft'],
  cameraRight: ['KeyD', 'ArrowRight'],
  eject: ['KeyE'],
  dropLeft: [],               // drop the left arm of the single selected own mech (no default key – set in Settings → Controls)
  dropRight: [],              // same for the right arm
  debugXp: ['KeyX'],
  // Targeted orders: press the key (or the button), then left-click the target; right click / cancel aborts
  attackMove: ['KeyQ'],       // click ground = attack-move there, click enemy = attack it
  guard: ['KeyG'],            // click own unit = guard it, click ground = hold that spot
  patrol: ['KeyP'],           // click ground = patrol between the mech and that point
  cancel: ['Escape'],
  move: ['KeyM'],             // targeted: click ground = move there (same as a right click)
  stop: ['KeyH'],             // drop the current order of the selected units (halt)
  formation: [],              // cycle the formation of the selected units (no default key – set in Settings → Controls)
  deleteUnit: ['Delete'],     // destroy the selected own units (mech explodes, crew evacuates)
  wallGate: [],               // [H1] rebuild the selected full wall segments into gates (no default key – set in Settings → Controls)
  stanceRanged: ['KeyR'],
  stanceMelee: ['KeyF'],
  behaviourAggressive: ['KeyJ'], // behaviour of idle units (BEHAVIOUR): mechs only
  behaviourDefensive: ['KeyK'],  // mechs and crews
  behaviourPassive: ['KeyL'],    // mechs and crews
  repair: ['KeyO'],              // start field repair / stop it while repairing
  rotateBuilding: ['KeyT'],      // while placing a building: turn it by PLACEMENT.rotateStep (Shift = the other way)
  launchSuperweapon: [],         // [A9-F4a] own superweapon: start targeting (empty = panel button only)
  idleCrew: [],                  // select the next idle crew + centre the camera (no default key – set in Settings → Controls)
  idleBuilder: [],               // same for idle builder vehicles
  idleDrill: [],                 // same for idle drill trucks (harvest ability, no order)
  fullscreen: [],                // toggle browser fullscreen (no default key – set in Settings → Controls)
  diplomacy: ['KeyU'],           // [B4] open / close the diplomacy menu (src/ui/DiplomacyView.js)
  stockWindow: ['KeyI'],         // [F1] open / close the part stock window (src/ui/StockWindow.js)
  chat: ['Enter', 'NumpadEnter'], // [N11] open the chat line (multiplayer only; Shift+Enter in the field = team chat)
  groupModifier: 'ctrl',      // 'ctrl' | 'shift' | 'alt'
  controlGroups: [
    ['Digit1', 'Numpad1'], ['Digit2', 'Numpad2'], ['Digit3', 'Numpad3'],
    ['Digit4', 'Numpad4'], ['Digit5', 'Numpad5'], ['Digit6', 'Numpad6'],
    ['Digit7', 'Numpad7'], ['Digit8', 'Numpad8'], ['Digit9', 'Numpad9'],
  ],
  doubleTapTime: 0.35,        // s – second press within this time centres the camera
};

// Pohyb, sběr a zničení robota
export const MECH = {
  walkAnimRefSpeed: 18, // move speed at which the walk animation plays at walkAnimScale
  minWalkAnimRate: 0.4, // walk clip never plays slower than this (keeps the legs moving while turning on the spot)
  aimHeightFactor: 0.6, // shots aim at this fraction of the body (legs + torso) height
  hitReactCooldown: 4,  // s between hit-reaction animations (rapid fire would freeze the mech)
  hitReactMinDamage: 0.12, // a hit must take at least this share of the part's max HP to stagger the mech
  hitReactChance: 0.5,  // …and then staggers it with this chance
  autoChaseLeash: 1.5,  // auto-acquired targets are dropped beyond sightRange × this
  groupSpacing: 28,     // distance between mechs when a group is ordered to one point
  modelYawOffset: 0,    // natočení modelu vůči směru pohybu (+Z)
  pickupRange: 12,      // vzdálenost, ze které robot namontuje vrak ruky
  pickupHpRatio: 0.5,   // podíl max HP, který se ruce po namontování obnoví
  hulkSinkDelay: 6,     // s, než trosky zničeného robota zapadnou do země
  sinkSpeed: 4,         // jednotek / s
  sinkDepth: 40,        // units below the terrain at which a sinking hulk / debris is removed
  walkAnimScale: 1.2,   // rychlost přehrávání animace chůze
};

// Units arriving at a move target (mechs and crews)
export const ARRIVE_DISTANCE = 0.5; // units – a move order is done this close to its target

// Crew squads (Crew.js) – non-balance settings; balance is in stats.json → crew
export const CREW = {
  minRunAnimRate: 0.4,       // run clip never plays slower than this (keeps legs moving while turning)
  animFadeTime: 0.2,         // s – cross-fade between idle and run
  ringMargin: 2,             // units – ring radius = farthest formation member + this
  aimHeightFactor: 0.5,      // shots aim at this fraction of a figure's height
  // Boarding a mech whose own spot is blocked (next to a building / wall / other empty mechs): pathfinding ends
  // the walk at the nearest free cell, which may be farther than rules.crew.boardRange from the mech's centre.
  // [H2] The crew boards when the edge of the mech's LEG circle (centre − footRadius) is within
  // boardRange + edgeBuffer – at any moment of the walk, not only at its end (a wide-bodied mech, e.g. JetPack,
  // keeps the crew farther from the centre than boardRange, so the centre distance never got small enough).
  board: {
    pathEndReach: 3,         // units – (unused since [H2], kept for old saves of the setting)
    edgeBuffer: 10,          // units – extra reach over boardRange, measured from the leg circle's edge
  },
  // Running away (crew ejected from a destroyed mech, or a defensive crew under fire): away from the enemies
  // the squad can see (sightRange) until none of them is closer than safeDistance
  flee: {
    safeDistance: 100,       // units – beyond most weapon ranges
    step: 30,                // units – how far ahead the next flee point is set
    replanInterval: 0.5,     // s – the direction is recomputed this often (enemies move)
    maxTime: 20,             // s – gives up running after this long
    mapMargin: 10,           // units – flee points stay this far inside the map edge
  },
};

/**
 * Selection ring (own units, shown when selected) and team ring (other teams, always shown) on the
 * ground under mechs and crews. Widths are measured inwards from the outer radius.
 */
export const RINGS = {
  activeColor: 0x4cc38a,     // selected mech with crew / selected crew
  noCrewColor: 0x8a96a3,     // selected mech without crew (inactive)
  selectionWidth: 0.6,       // units
  selectionOpacity: 0.85,
  height: 0.3,               // units above the ground (avoids z-fighting with the terrain)
  mechSegments: 48,
  crewSegments: 40,
  mechTeamRing: { inset: 0.8, width: 0.6, opacity: 0.7 },   // inset = gap inside the selection ring's outer edge
  crewTeamRing: { inset: 0.7, width: 0.5, opacity: 0.7 },
};

/**
 * Attack clips borrowed from another part set (MechAnimator.attack): set -> set whose clips play instead.
 * SniperLaser's own clips (anim118–123) swing the barrel ~55° inwards across the body at the shot, so the
 * rifle points at the mech's own chest; the GattlingGun clips (anim79/80) hold the barrel straight forward.
 * Remove an entry to go back to the set's own clips.
 */
export const ATTACK_CLIP_SET = {
  SniperLaser: 'GattlingGun',
};

// RTS orders of mechs (ModularMech): attack-move, guard, patrol
export const ORDERS = {
  engaging: ['attackMove', 'patrol', 'guard'],     // orders that stop to fight enemies they meet, then resume
  // Only a plain move / collect may give up when blocked (MOVEMENT.giveUpTime). Attack, attack-move,
  // patrol and guard never give up: an attack walks to a free spot around its target, attack-move and
  // patrol step aside and try again (near their goal a blocked spot counts as reached).
  giveUpWhenBlocked: ['move', 'collect'],
  detourWhenBlocked: ['attackMove', 'patrol'],
  brakeAtGoal: ['move', 'attackMove', 'patrol', 'guard'],        // slow down to stop exactly at the goal
  attackRepositionTime: 1.5, // s without getting closer to the target -> try another spot around it
  approachSlots: 8,          // directions around the target an attacker may approach from
  approachGap: 0.5,          // units between the edges of the attacker and the target at an approach spot
  detourDistance: 25,        // units – how far attack-move / patrol step aside when blocked
  detourReach: 3,            // units – the side step counts as done this close to its point…
  detourTimeout: 3,          // s – …or after this long
  guardRadius: 60,           // units – guard engages enemies this close to the guarded unit / point
  guardChaseRadius: 90,      // units – …and drops them (returns) once they get this far from it
  guardFollowTolerance: 20,  // units between the edges of the guard and the guarded unit before it follows
  guardHoldDistance: 3,      // units – a point guard stands still this close to its spot
  patrolArriveDistance: 3,   // units – a patrol point counts as reached within this distance
};

/**
 * Order queue (src/units/OrderQueue.js): an order given with Shift held waits until the current one is done,
 * an order without Shift replaces the queue. A guard order ends only when the guarded unit is gone, so orders
 * queued behind a point guard never start; after a patrol only move / patrol orders are taken (as patrol points).
 */
export const ORDER_QUEUE = {
  maxLength: 16,                              // queued orders per unit (current one not counted)
  patrolWaypointOrders: ['move', 'patrol'],   // Shift + these after a patrol add a patrol point
  // Queue shown on the ground for the selected own units: line through the order targets + a ring at each
  marker: {
    color: 0x7fd4ff,
    patrolColor: 0xffd27f,
    opacity: 0.75,
    height: 0.6,           // units above the terrain
    ringRadius: 2.2,       // units
    ringWidth: 0.5,        // units
    ringSegments: 20,
    maxPoints: 256,        // line vertices / rings drawn per frame (all selected units together)
  },
};

/**
 * Behaviour modes of idle units (unit.setBehaviour). Explicit orders (attack, attack-move, guard, patrol)
 * always win. Defaults are balance: stats.json → rules.combat.defaultBehaviour (mechs), rules.crew.defaultBehaviour.
 *  aggressive – attacks enemies in sight and fires at will (mechs only)
 *  defensive  – mech: fights back only when attacked, then returns to where it stood;
 *               crew: runs away from the attacker, then returns
 *  passive    – never fights / runs on its own (a mech does not even shoot back)
 */
export const BEHAVIOUR = {
  mechModes: ['aggressive', 'defensive', 'passive'],
  crewModes: ['defensive', 'passive'],
  defensiveChaseRadius: 70,  // units – a defending mech drops its attacker once it gets this far from home
  homeArriveDistance: 4,     // units – a unit returning home stops this close to its spot
};

/**
 * Targeted orders: only pendingCursor is used (cursor while picking the target). Labels and tooltips of
 * all order buttons are in the i18n tables (cmd.*), the buttons are in the HUD command grid (HUD.commandGrid).
 * Key hints come from KEYBINDINGS; the pending button is outlined by hud.css (--hud-pending).
 */
export const ORDER_BUTTONS = {
  pendingCursor: 'crosshair',
};

// Parts falling off a mech: torn-off arms (ArmWreck) and legs / torso thrown off a destroyed mech
// (SalvageWreck – the drop chance is balance: stats.json → rules.salvageDrop)
export const WRECK = {
  gravity: 30,               // units/s²
  flingSpeed: 8,             // sideways speed away from the mech
  flingUp: 10,               // upward speed
  minFlingDirection: 1e-4,   // squared length below which the fling direction is picked at random
  salvageTilt: { legs: 1.5, torso: 1.2 }, // rad – how far a thrown-off part falls over
  salvageTiltTime: 0.6,      // s to fall over
};

/**
 * Where shots leave a weapon part: nodes of the part model whose name matches one of these patterns
 * (socket_Launch_1 on arms and legs, hash-named sockets like socket_1bfcbd52 on weapon torsos).
 * Several muzzles take turns within a burst. A part without such a node fires from the centre of its
 * geometry (never from the part origin, which for torsos and legs sits at the hip).
 */
export const MUZZLE = {
  socketPatterns: [/^socket_Launch/i, /^socket_[0-9a-f]{8}$/i],
};

/** Wiring of Effects.damageSmoke to every hurt unit / building (src/game/DamageSmokeWiring.js). Visual only. */
export const DAMAGE_SMOKE = {
  scanEveryTicks: 6,    // how often the unit lists are scanned for newly hurt targets
  registerBelow: 0.62,  // start tracking below this hp fraction (a bit above data/explosions.json damage threshold)
  releaseAbove: 0.75,   // stop tracking (repaired) above this fraction (hysteresis)
  maxActive: 48,        // cap of smoking targets; the rest wait until a slot frees
};

/**
 * Combat visuals built from the static models in models/explosion/ (they have no animation – every
 * effect is animated here: scale, fade, spin, texture scroll). Model sizes: fireBall radius 7.5,
 * shockDome / empBlast radius ~13, spiral ~28 tall. Balance (durations of stun / burn) is in stats.json.
 *
 * One-shot effect = list of layers: { model, delay, duration, scaleFrom, scaleTo, opacityFrom, opacityTo,
 *   height (fraction of the unit's aim height, or units for impacts), spin (rad/s), color, flatten (y scale
 *   factor), scroll (texture offset per s) }. All scales are multiplied by the effect's size argument.
 */
export const VFX = {
  models: {
    fireBall: 'explosion/FireBall3D.glb',
    shockDome: 'explosion/ShockDome3D.glb',
    empBlast: 'explosion/EMPBlast.glb',
    spiral: 'explosion/Spiral.glb',
  },
  additive: true,            // additive blending – fire glows instead of looking like a solid ball
  renderOrder: 10,           // drawn after the units
  // Mech destroyed: fireball at the body, ground shock wave, rising spiral of fire
  mechExplosion: [
    { model: 'fireBall', duration: 1.0, scaleFrom: 0.3, scaleTo: 2.0, opacityFrom: 1, opacityTo: 0, height: 1.2, spin: 2, scroll: 0.6 },
    { model: 'fireBall', delay: 0.25, duration: 0.8, scaleFrom: 0.2, scaleTo: 1.4, opacityFrom: 0.9, opacityTo: 0, height: 2, spin: -3, scroll: 0.8 },
    { model: 'shockDome', duration: 0.7, scaleFrom: 0.2, scaleTo: 2.2, opacityFrom: 0.5, opacityTo: 0, height: 0, flatten: 0.25 },
    { model: 'spiral', delay: 0.1, duration: 1.4, scaleFrom: 0.4, scaleTo: 1.2, opacityFrom: 0.8, opacityTo: 0, height: 0, spin: 4, scroll: 1 },
  ],
  // Splash weapon impact (size = splashRadius / referenceRadius); physical damage
  splashImpact: [
    { model: 'fireBall', duration: 0.5, scaleFrom: 0.3, scaleTo: 1, opacityFrom: 1, opacityTo: 0, height: 2, spin: 3, scroll: 0.8 },
    { model: 'shockDome', duration: 0.4, scaleFrom: 0.3, scaleTo: 1, opacityFrom: 0.6, opacityTo: 0, height: 0, flatten: 0.2 },
  ],
  // Energy splash / stun weapons (EMP, pulse)
  energyImpact: [
    { model: 'empBlast', textured: false, duration: 0.6, scaleFrom: 0.2, scaleTo: 1, opacityFrom: 0.9, opacityTo: 0, height: 0, spin: 5, color: '#3aa8ff' },
    { model: 'shockDome', textured: false, duration: 0.5, scaleFrom: 0.2, scaleTo: 1, opacityFrom: 0.5, opacityTo: 0, height: 0, flatten: 0.3, color: '#1f6fd0' },
  ],
  // Wreck on the ground shot to 0 HP (World.destroyWreck); size multiplier by part kind
  wreckExplosion: [
    { model: 'fireBall', duration: 0.7, scaleFrom: 0.2, scaleTo: 1.1, opacityFrom: 1, opacityTo: 0, height: 3, spin: 3, scroll: 0.8 },
    { model: 'shockDome', duration: 0.5, scaleFrom: 0.2, scaleTo: 1, opacityFrom: 0.5, opacityTo: 0, height: 0, flatten: 0.25 },
  ],
  wreckExplosionSize: { arm: 0.6, legs: 0.9, torso: 0.9 },
  splashReferenceRadius: 13, // splash radius at which the impact layers have scale 1 (radius of the dome)
  minImpactSize: 0.3,        // tiny splashes (missiles) still show a visible puff
  // Status indicators that follow a unit while the status lasts
  // (height = fraction of the unit's aim height; the head of a mech is at ~1.7)
  stunIndicator: { model: 'empBlast', textured: false, scale: 0.3, flatten: 0.35, height: 1.8, spin: 6, color: '#3aa8ff', opacity: 0.7, pulseSpeed: 10, pulse: 0.15 },
  burnIndicator: { model: 'fireBall', scale: 0.28, height: 0.7, spin: 4, opacity: 0.9, flickerSpeed: 18, flicker: 0.25, spread: 0.35, scroll: 1.2 },
  crewIndicatorScale: 0.4,   // indicators on crew squads are this much smaller than on mechs
  // Mech being repaired in the field (ModularMech.startRepair)
  repairIndicator: { model: 'spiral', textured: false, scale: 0.35, height: 0.2, spin: 2.5, color: '#5fe08a', opacity: 0.45, pulseSpeed: 3, pulse: 0.1 },
  /**
   * Travelling projectiles (Effects.projectile). Size = weapon projectileSize (radius in units, picked to match
   * the barrel / warhead of the weapon model), defaultSize when the weapon has none. Shape = weapon
   * projectileShape, or by damage type (energy -> orb, physical -> shell). stretch = length / width along
   * the flight direction.
   */
  projectile: {
    defaultSize: 0.6,
    sizeScale: 1.6,          // global multiplier of every projectile radius (weapon projectileSize x this)
    maxLife: 30,             // s – safety limit for a projectile that never arrives
    segments: [10, 8],       // sphere width / height segments
    maxInstances: 256,       // batched draw capacity; more live projectiles still fly and hit, they just are not drawn
    coreWhite: 0.55,         // 0..1 – the bright core is the colour mixed this much towards white
    // stretch = length / width along the flight; glow = halo radius / core radius; glowOpacity = halo strength;
    // color = optional fixed colour of the shape (else the colour passed by the shooter: energy / physical)
    shapes: {
      orb:     { stretch: 1,   glow: 2.4, glowOpacity: 0.45 },
      shell:   { stretch: 2.2, glow: 1.8, glowOpacity: 0.35, color: '#ffc45a' },
      missile: { stretch: 3.6, glow: 1.9, glowOpacity: 0.4,  color: '#ff7f3a' },
      bolt:    { stretch: 6,   glow: 2.2, glowOpacity: 0.5 },
    },
    defaultShape: { energy: 'orb', physical: 'shell' },
  },
  tracerLife: 0.12,          // s – instant shot line fades out in this time
};

/** Název sady dílu z cesty, např. 'RobotPartsBasic/...' -> 'Basic' */
export const setFromPath = (path) => path.split('/')[0].replace('RobotParts', '');

// i18n keys of the mech part names – show them with t(PART_LABELS[slot]) (texts in src/i18n/cs.js, en.js)
export const PART_LABELS = {
  legs: 'part.legs',
  torso: 'part.torso',
  leftArm: 'part.leftArm',
  rightArm: 'part.rightArm',
};

/**
 * Start menu (src/ui/MainMenu.js). Default team colours come from TEAMS; the menu's own look
 * (backgrounds, accents) is in src/ui/menu.css as CSS variables on #menu.
 */
export const MENU = {
  storageKey: 'steelMen.newGame',  // localStorage key of the last new-game choice
  // Default game rules of a new game (the last choice is remembered). Friendly fire options apply
  // only when enabled: artilleryOnly = only artillery/area hits hurt own units, reduced = lower damage.
  friendlyFire: { enabled: false, artilleryOnly: false, reduced: false },
  teamPalette: [                    // preset team colours (any other can be picked with the custom swatch); nameKey = i18n key
    { color: '#3a5ccc', nameKey: 'color.blue' },
    { color: '#c8302c', nameKey: 'color.red' },
    { color: '#3f9b4a', nameKey: 'color.green' },
    { color: '#e0b31e', nameKey: 'color.yellow' },
    { color: '#e0861e', nameKey: 'color.orange' },
    { color: '#8a4fd0', nameKey: 'color.purple' },
    { color: '#1fa5a5', nameKey: 'color.teal' },
    { color: '#d0509a', nameKey: 'color.pink' },
    { color: '#e8a21a', nameKey: 'color.amber' }, // default colour of the faction W (TEAMS[3], races.W.uiColor.primary)
  ],
  fogModes: ['unexplored', 'explored', 'off'],  // world.settings.fogOfWar values (logic: map / fog of war)
  defaultFogMode: FOG.defaultMode,
  // Economy choices of a new game (values: ECONOMY.energyCaps, ECONOMY.defaultEnergyCap, ORE_MULTIPLIER)
};

/**
 * Match end (src/game/Victory.js conditions, src/game/Match.js, src/game/MatchStats.js, src/ui/MatchUi.js).
 * `conditions` = ids offered in the new-game menu (each needs an entry in Victory.js CONDITIONS and the i18n keys
 * victory.<id> / victory.<id>.hint); add e.g. 'kingOfTheHill' there later. The choice is kept in the profile.
 */
export const VICTORY = {
  conditions: ['destruction', 'mainBuilding'],
  defaultCondition: 'destruction',
  checkInterval: 0.25,            // s of game time between win-condition checks and stat samples
  mainBuildingFlag: 'hq',         // stats.json structures[id] flag that marks a main building (condition 'mainBuilding')
  countUnfinishedBuildings: false, // does a construction site keep a team alive (condition 'destruction')?
  crewlessMechsCount: true,       // does a mech without a crew count as a combat unit?
  combatVehicleMinWeapons: 1,     // a vehicle with at least this many weapons (stats.weapons) is a combat unit
  builderKeepsAlive: true,        // a living unit with the 'construct' ability keeps a team alive (start set 1 has no buildings)
};

/** Match statistics: resource flows (Economy.onFlow kind) that count as "gathered" */
export const MATCH_STATS = {
  gatherKinds: ['mined', 'income'], // mined = trucks at deposits, income = passive building income
  spendKinds: ['spend'],            // pay(); refunds are subtracted from spent
  refundKinds: ['refund'],
  unitKinds: ['mech', 'crew', 'vehicle', 'structure'], // categories of produced / lost units, in table order
  maxSecondsShown: 359999,          // cap of the duration display (99:59:59)
};

/** Game menu (Esc when there is nothing to cancel, or the HUD button) and the end-of-match screen (src/ui/MatchUi.js) */
export const MATCH_UI = {
  menuButtonIcon: '☰',
  // Extra key that always opens the game menu, even while an order is pending (Esc cancels the order first)
  menuKeys: ['F10'],
};

/** Local player profile (src/core/Profile.js): one localStorage key holding nickname, language, settings, last new game */
export const PROFILE = {
  storageKey: 'steelMen.profile',
  legacyProfileKey: 'steelMans.profile',                  // profile key of the game before the rename (taken over once, kept)
  legacyKeys: ['steelMans.newGame', 'steelMen.newGame'], // older keys migrated into the profile (last new-game choice)
  version: 1,
  nicknameMaxLength: 24,
  defaultNickname: '',               // empty = UI shows the translated "Player"
};

/** Languages: key = i18n table (src/i18n/<key>.js); the first one is the fallback when the browser language is unknown */
export const I18N = {
  languages: ['cs', 'en'],
  fallback: 'en',
  names: { cs: 'Čeština', en: 'English' },  // each language written in itself
};

/** Advanced graphics options of the Full preset (the shipped default of settings.graphics.advanced; see GRAPHICS) */
const GRAPHICS_FULL = {
  pixelRatioCap: 2, pixelRatioScale: 1, shadows: true, shadowMapSize: 2048, shadowType: 'PCFSoftShadowMap',
  buildingDetail: 'high', buildingShadows: true, buildingAnimations: 'full',
};

/** Defaults of the player settings saved in the profile (see Settings screen) */
export const SETTINGS_DEFAULTS = {
  language: null,                 // null = detect from the browser the first time
  nickname: '',                   // empty = UI shows the translated "Player"
  keybindings: {},                // action -> list of KeyboardEvent.code, only the remapped ones
  mouse: { rotateSensitivity: 1, zoomSensitivity: 1, panSensitivity: 1, invertRotate: false, invertZoom: false, invertPan: false },
  audio: { master: 0.8, effects: 1, music: 0.6, ui: 0.8 }, // [A6] ui = UI clicks + announcement jingles
  // quality: 'full' | 'reduced' | 'custom' (always derived from `advanced`, see GRAPHICS); advanced: the individual options
  graphics: { quality: 'full', advanced: { ...GRAPHICS_FULL } },
  ui: { alwaysShowHealthBars: false, alwaysShowBuildProgress: false, edgeScroll: true, autoAssist: true }, // autoAssist → setAutoAssist command at match start; copied to world.settings.ui by main.js; edgeScroll is read live
};

/** Mouse: base values multiplied by the sensitivity setting (OrbitControls rotateSpeed / zoomSpeed) */
export const MOUSE = {
  baseRotateSpeed: 1,
  baseZoomSpeed: 1,
  sensitivityRange: { min: 0.2, max: 3, step: 0.1 },
};

/** Graphics quality presets (src/core/Graphics.js) */
export const GRAPHICS = {
  qualities: ['full', 'medium', 'reduced'],
  presets: {
    full: { ...GRAPHICS_FULL, antialiasHint: true },
    // medium = slightly lower resolution, smaller shadows, buildings animated only near the camera
    medium: {
      pixelRatioCap: 1.5, pixelRatioScale: 0.8, shadows: true, shadowMapSize: 1024, shadowType: 'PCFShadowMap',
      buildingDetail: 'medium', buildingShadows: true, buildingAnimations: 'near', antialiasHint: true,
    },
    // reduced = render at a lower resolution (downscale) and cheaper, smaller shadows, simple buildings without shadows
    reduced: {
      pixelRatioCap: 1, pixelRatioScale: 0.6, shadows: true, shadowMapSize: 512, shadowType: 'BasicShadowMap',
      buildingDetail: 'low', buildingShadows: false, buildingAnimations: 'off', antialiasHint: false,
    },
  },
  minPixelRatio: 0.4,
  customQuality: 'custom',  // quality id shown when the advanced options match no preset (not selectable)
  // Advanced options (Settings → Graphics → Advanced). Order = display order; `values` = allowed choices (select box),
  // type 'boolean' = checkbox. i18n: `settings.graphics.adv.<key>`, choice labels `settings.graphics.adv.<key>.<value>`.
  advanced: {
    pixelRatioScale: { values: [1, 0.8, 0.6, 0.5, 0.4], percent: true },   // render resolution scale (× device pixel ratio)
    pixelRatioCap: { values: [2, 1.5, 1] },                                // max device pixel ratio used
    shadows: { type: 'boolean' },
    shadowMapSize: { values: [2048, 1024, 512] },
    shadowType: { values: ['PCFSoftShadowMap', 'PCFShadowMap', 'BasicShadowMap'] },
    // procedural buildings (see BUILDING_LOD): detail level by camera distance; auto = follows the frame time
    buildingDetail: { values: ['high', 'medium', 'low', 'auto'] },
    buildingShadows: { type: 'boolean' },                                  // buildings cast shadows
    buildingAnimations: { values: ['full', 'near', 'off'] },               // animated parts + glow meshes: LOD0 range full / reduced / none
  },
};

/** Remappable actions shown in Settings → Controls (order = display order). Camera keys are fixed to camera actions. */
// Categories = vertical tabs of Settings → Controls (order = tab order; i18n key `settings.controls.<id>`).
// Only the 'camera' category is a camera action (may use WASD / arrows); everything else is "command" for validation.
export const KEY_CATEGORIES = [
  { id: 'camera', actions: ['cameraForward', 'cameraBack', 'cameraLeft', 'cameraRight'] },
  { id: 'commands', actions: ['eject', 'dropLeft', 'dropRight', 'attackMove', 'guard', 'patrol', 'cancel', 'move', 'stop', 'deleteUnit', 'stanceRanged', 'stanceMelee',
    'behaviourAggressive', 'behaviourDefensive', 'behaviourPassive', 'repair', 'formation', 'wallGate'] },
  { id: 'general', actions: ['rotateBuilding', 'idleCrew', 'idleBuilder', 'idleDrill', 'fullscreen', 'diplomacy', 'stockWindow', 'chat'] },
];
export const KEY_ACTIONS = {
  camera: KEY_CATEGORIES.find((c) => c.id === 'camera').actions,
  commands: KEY_CATEGORIES.filter((c) => c.id !== 'camera').flatMap((c) => c.actions),
};
// Keys reserved for the camera: never allowed on command actions (WASD + arrows)
export const CAMERA_RESERVED_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
// Keys that cannot be bound at all (browser / control group keys are also protected via collision check)
export const FORBIDDEN_KEYS = ['F5', 'F11', 'F12', 'Tab', 'MetaLeft', 'MetaRight', 'ContextMenu'];

/** Colour check for two players (Settings / New game): colours closer than this are refused. */
export const COLOR_SIMILARITY = {
  // Distance in CIE Lab (ΔE76): ~2 = barely noticeable, ~10 = clearly different at a glance, 35+ = unmistakable
  minDeltaE: 28,
};

/** Hover highlight of units, buildings and wrecks (src/core/Highlight.js, MechPart.js): emissive glow */
export const HIGHLIGHT = {
  color: 0xffaa00,
  intensity: 0.15, // 0 = none, 1 = full emissive colour
};

/**
 * [A6] Sound engine (src/audio/Sound.js + Synth.js, docs/notes/a6-audio-engine.md). Sounds are synthesized with WebAudio
 * from data/sounds.json (event table, synth patches, weapon -> event map); any event can be switched to a file there.
 * Audio only: nothing here may influence the simulation.
 */
export const AUDIO = {
  dataUrl: './data/sounds.json', // event table + patches + weapon map
  basePath: 'sounds/',           // file events / music: paths are relative to this
  maxDistance: 250,              // units – positional sounds farther from the listener are skipped (no nodes created)
  falloffExponent: 1.5,          // gain = (1 - d / maxDistance) ^ exponent
  panWidth: 0.6,                 // stereo pan at max distance straight to the side (0 = no panning)
  panMin: 0.03,                  // |pan| below this creates no StereoPanner node
  // weaponSoundEvent() fallback for weapons missing from data/sounds.json → weapons (events by weapon data)
  weaponFallback: {
    melee: 'meleeHit', area: 'shotPulse', artillery: 'shotArtillery', flame: 'shotFlame', energyProjectile: 'shotPlasma',
    energy: 'shotLaser', rocket: 'shotRocket', projectile: 'shotCannon', gatling: 'shotGatling', hitscan: 'shotRifle',
  },
  rocketShapes: ['missile', 'rocket'],  // projectileShape values that sound like a rocket
  flameEffects: ['burn'],               // weapon effect types that sound like fire
  flameIdPart: 'flame',                 // weapon ids containing this sound like fire
  gatlingMinBurst: 6,                   // hitscan weapons with burst >= this (or any spread) sound like a gatling
  // Mix / limits (audio time = AudioContext.currentTime, never simulation time)
  maxVoices: 24,                 // simultaneous event sounds; when full the quietest × lowest priority voice is stolen
  defaultMaxPerEvent: 4,         // per event, unless the event sets maxPerEvent
  defaultMinIntervalMs: 40,      // repeats of one event inside this window merge into the running voice
  mergeGainBoost: 1.12,          // merged repeat: gain × this on the running voice …
  mergeMaxBoost: 1.6,            // … up to this total
  minAudibleGain: 0.005,         // effective gain below this = skipped
  stealFadeSec: 0.025,           // fade-out of a stolen voice
  envFloor: 0.0001,              // exponential ramps cannot reach 0: they go to this
  stopTailSec: 0.03,             // sources stop this long after their envelope ends
  defaultPitchVar: 0.04,         // per-play random pitch variation (±fraction) when the patch does not set pitchVar
  defaultGainVar: 0.08,          // per-play random gain variation (±fraction)
  maxLayers: 3,                  // layers per patch (more are ignored)
  defaultCategory: 'effects',    // event without category
  // Noise buffers (generated once per AudioContext)
  noiseSeconds: 1,
  crunchHoldSamples: 6,          // 'crunch' noise = sample & hold every N samples (8-bit style)
  pulseHarmonics: 48,            // harmonics of the pulse25 / pulse12 PeriodicWaves
  // Master limiter (keeps a big battle from clipping)
  compressor: { threshold: -14, knee: 8, ratio: 6, attack: 0.003, release: 0.2 },
  musicTracks: { menu: '', game: '' }, // track -> file under basePath; empty = no music (planned: music/menu.ogg, music/game.ogg)
};

/**
 * [A6] Where game / UI events trigger Sound.play (src/audio/GameSounds.js, UiSounds.js, Effects.js, EconomyAlerts.js,
 * BuildMenu.js). Everything here is presentation only – never read by the simulation.
 */
export const SOUND_HOOKS = {
  // GameSounds: local-team announcements found by polling the world (read only)
  pollIntervalSec: 0.25,       // real seconds between two looks at the world (construction finished, HP lost)
  attackCooldownSec: 25,       // real seconds between two "base under attack" announcements
  attackMinHpLoss: 1,          // HP a local unit / building must lose between two polls to count as attacked
  silentTickGap: 15,           // more sim ticks than this between two polls (hidden tab, fast-forward): changes are taken silently
  productionEvents: {          // Production item kind -> announcement of the local team (kinds not listed: silent)
    vehicle: 'unitReady', crew: 'unitReady', mech: 'unitReady', research: 'researchComplete', analysis: 'researchComplete',
  },
  // Effects.burst: sound of an explosion without an explicit `sound` option, by its size multiplier
  burstLargeSize: 1.5,         // size >= this = explosionLarge, smaller = explosionSmall
  // UiSounds: delegated document listeners
  clickSelector: 'button, .menu-btn, [role="button"]',
  ignoreSelector: ':disabled, .empty, [aria-disabled="true"]',
  hoverThrottleMs: 90,         // at most one hover sound per this many ms
  lowPowerCooldownMs: 20000,   // EconomyAlerts: shortest gap between two lowPower sounds (energy flickering around the limit)
  // Refusal notices (BuildMenu.notify): sound of a refusal, and of a refusal for missing resources
  refusalSound: 'uiError',
  fundsSound: 'lowFunds',
};

/**
 * In-game HUD (src/ui/Hud.js and its panels, styles in src/ui/hud.css). Faction tint comes from
 * stats.json → races[*].uiColor { primary, accent } and is set as CSS variables --hud-primary / --hud-accent.
 */
export const HUD = {
  refreshInterval: 0.15,     // s between redraws of the text panels (overlays above units redraw every frame)
  fallbackColor: { primary: '#4cc38a', accent: '#9cc7ff' }, // race without uiColor
  // Part / HP colours: 100 % = full, above warn = warn, above critical = critical, missing part = missing
  hpColors: { full: '#4cc38a', warn: '#f0a030', critical: '#d63c2f', missing: '#111418' },
  hpThresholds: { warn: 0.5, critical: 0.01 },
  // Option grid (left): building, production inside buildings, robot parts
  optionGrid: { columns: 4, rows: 4 },
  // Command grid (bottom left): FIXED layout per unit kind, row by row (4 columns); null = no button. Nothing is
  // rearranged at runtime. All kinds share one master slot map, so a command sits on the same slot for every kind:
  //   row 1 movement (move, attackMove, guard, patrol) · row 2 behaviours + delete · row 3 mech-only (stance, repair)
  //   and builder-only (repairUnit) · row 4 empty except stop (= "Cancel order") on the last slot, bottom right.
  // Repair / repairUnit do NOT share a slot with ranged / melee: one mech can have both stance (mixed weapons) and repair.
  // A selection of several kinds shows the overlay of their layouts (slot by slot, no collisions by construction).
  // Kinds: mech · crew · vehicle (any vehicle) · repairVehicle (vehicle with the repair ability) · combatVehicle (armed
  // vehicle, takes combat orders) · structure (own building: only delete). A command whose kind is not selected is hidden.
  // eject / dropLeft / dropRight are not in the grid: robot panel EJECT buttons + KEYBINDINGS (eject = E, drop arms
  // have no default key, the player binds them in Settings → Controls).
  commandGrid: {
    columns: 4,
    hotkeyMaxLength: 3,      // key hints longer than this (e.g. "Delete") are only in the tooltip, not in the cell corner
    layouts: {
      mech: [
        'move', 'attackMove', 'guard', 'patrol',
        'behaviourAggressive', 'behaviourDefensive', 'behaviourPassive', 'deleteUnit',
        'stanceRanged', 'stanceMelee', 'repair', null,
        null, null, 'formation', 'stop',
      ],
      crew: [
        'move', null, null, null,
        null, 'behaviourDefensive', 'behaviourPassive', 'deleteUnit',
        null, null, null, null,
        null, null, 'formation', 'stop',
      ],
      vehicle: [
        'move', null, null, null,
        null, null, null, 'deleteUnit',
        null, null, null, null,
        null, null, 'formation', 'stop',
      ],
      repairVehicle: [
        null, null, null, null,
        null, null, null, null,
        null, null, null, 'repairUnit',
        null, null, null, null,
      ],
      combatVehicle: [
        'move', 'attackMove', 'guard', 'patrol',
        'behaviourAggressive', 'behaviourDefensive', 'behaviourPassive', 'deleteUnit',
        null, null, null, null,
        null, null, 'formation', 'stop',
      ],
      structure: [
        null, null, null, null,
        null, null, null, 'deleteUnit',
        null, null, null, null,
        'wallGate', null, null, null,
      ],
    },
    // [H1] commands drawn only while enabled (a disabled one leaves its slot empty instead of a greyed button)
    hiddenWhenDisabled: ['wallGate'],
  },
  // Command icons (text glyphs – replace with images later)
  commandIcons: {
    move: '➜', attackMove: '⚔', guard: '🛡', patrol: '⇄', stop: '■', stanceRanged: '◎', stanceMelee: '✊',
    deleteUnit: '✖',
    behaviourAggressive: '🔥', behaviourDefensive: '⛨', behaviourPassive: '☮', repair: '🔧', stopRepair: '⏹',
    repairUnit: '🛠',
    formation: '▦',
    wallGate: '⛩',
  },
  // Production queue (top left, under the resources): sequential per producer (hangar, training)
  production: {
    maxQueue: 5,             // items per producer
    timeScale: 1,            // build time multiplier (stats.json buildTime × this); < 1 speeds up testing
  },
  // Overlays above units: health bar and progress (boarding, production)
  overlays: {
    barWidth: { mech: 56, crew: 30, production: 60, vehicle: 40, structure: 80 }, // px
    barHeight: 5,             // px
    heightOffset: { mech: 4, crew: 2, vehicle: 2, structure: 3 },  // units above the unit's body top
    productionHeight: 12,     // units above the ground at the spawn point of the item being produced
    damagedShowTime: 3,       // s a bar stays visible after the unit took damage
    progressColor: '#6ea8fe',
    enemyBorder: '#c8302c',
    ownBorder: 'rgba(0, 0, 0, 0.8)',
  },
  // Idle crew button (Age of Empires style): crew outside a mech with no order
  idleCrew: {
    minIdleTime: 1.5,        // s without an order before a crew counts as idle
  },
  // Selected unit panel (bottom centre): see HUD_PANELS below
  // Wreck tooltip (hover a part lying on the ground)
  wreckTooltip: { offsetX: 16, offsetY: 16 }, // px from the cursor
};

/**
 * HUD v2 layout (src/ui/Hud.js, src/ui/hud.css; artwork data/image/ui/hud2, geometry from its manifest.json). All sizes are
 * "base px" at 1920×1080; the CSS multiplies them by --hud-scale. CSS only knows the geometry that never changes in code.
 */
export const HUD_V2 = {
  baseWidth: 1920,           // reference resolution of the artwork
  baseHeight: 1080,
  scaleMin: 0.8,             // DEPRECATED, unused since A5 (Hud.js uses UI_SCALE.scaleMin); --hud-scale = clamp(min(W / baseWidth, H / baseHeight), scaleMin, scaleMax)
  scaleMax: 1.25,
  // Margin of the frame artwork per side up to its SOLID metal edge (base px, alpha > 200 measured in the hud2 frame pieces:
  // left tl 13 / sl 13 / bl 14 / deco 13, right tr 13 / sr 13 / br 13, top tl 11 / ta 12 / tc 11 / tb 12 / tr 11, bottom
  // bl 20 / bm 20 / br 20; the faint outer glow at alpha 40 reaches 8–10 px further and gets cropped). The HUD root is pushed
  // out by it so the solid edge lies on the screen edge; --hud-scale is computed from the extended area:
  // W / (baseWidth − left − right), H / (baseHeight − top − bottom).
  frameBleed: { left: 13, right: 13, top: 11, bottom: 20 }, // [css] --hud-ml / -mr / -mt / -mb
  frameBackdrop: 14,         // [css] black strip under the frame along the 4 screen edges: this much (base px) beyond the bleed (rounded corners, gaps)
  // [css] idle crew / builder / drill truck buttons (--hud-idle-left / -size / -gap): three squares side by side in the slot
  // x 42…178 above the command grid (3 × 40 + 2 × 8 = 136); their bottom edge stays at idleTopFromBottom − 60
  idleButton: { left: 42, size: 40, gap: 8 },
  scalePrecision: 1000,      // --hud-scale is rounded to 1 / scalePrecision (no noisy values on every resize pixel)
  // Production panel (production_top + mid strip + production_bottom, panel top-left at panelTop). The numbers marked [css]
  // are published by Hud.js as CSS variables (--hud-prod-*, --hud-idle-from-bottom) – hud.css has no copy of them.
  production: {
    panelTop: 62,            // [css] base y of the panel's top edge
    topHeight: 256,          // [css] production_top
    bottomHeight: 133,       // [css] production_bottom
    rowHeight: 40,           // [css] production_mid = one queue row
    columnTop: 43,           // [css] y (panel coordinates) where the title / grid column starts
    gridEnd: 316,            // y (panel coordinates) where the 4×4 grid ends
    flowGap: 2,              // gap between the grid and the content below it (extras, queue)
    plainBottom: 356,        // y (panel coordinates) up to which the plain inner area reaches with no mid strip
    flowStart: 318,          // y (panel coordinates) of the first row below the grid
  },
  idleTopFromBottom: 359,    // [css] base px from the bottom edge to the top of the idle buttons (the panel must end above them)
  panelBottomGap: 6,         // base px kept free between the production panel and the idle buttons
};

/**
 * HUD v2 selection panels (src/ui/SelectionPanel.js, RobotPanel.js, CenterPanel.js; styles src/ui/selection-panel.css).
 * Artwork and coordinates: data/image/ui/hud2/manifest.json (robotPanel, panels.centerPanel, hazardStripe).
 * Robot panel = robot-panel-left + repeated robot-panel-mid + robot-panel-right, as wide as the bottom-centre container
 * (--hud-bc-w). Rectangles are in image pixels (height 480, x in left-piece coordinates, label right edges as insets from
 * the right edge of the panel); they are written to the DOM as CSS variables and multiplied by --rp-u
 * (one image pixel in CSS px = displayHeight / image height × --hud-scale, reduced when the container is narrower than minWidth).
 */
export const HUD_PANELS = {
  imageDir: 'data/image/ui/hud2/',
  robot: {
    image: { h: 480, left: 940, mid: 214, right: 312, minWidth: 1352 }, // manifest robotPanel.pieces / minWidth
    pieces: { left: 'robot-panel-left.png', mid: 'robot-panel-mid.png', right: 'robot-panel-right.png' },
    displayHeight: 320,       // CSS px at --hud-scale 1
    // Rectangles { x, y, w, h } in image pixels
    titleSlot: { x: 109, y: 41, w: 178, h: 27 },
    // Left column, top to bottom (manifest robotPanel.leftColumn)
    column: [
      { slot: 'leftArm', iconBox: { x: 80, y: 101, w: 84, h: 79 }, nameSlot: { x: 182, y: 104, w: 137, h: 22 }, ejectSlot: { x: 176, y: 156, w: 136, h: 15 } },
      { slot: 'rightArm', iconBox: { x: 80, y: 202, w: 84, h: 79 }, nameSlot: { x: 182, y: 205, w: 137, h: 22 }, ejectSlot: { x: 176, y: 257, w: 136, h: 15 } },
      { slot: 'crew', iconBox: { x: 80, y: 303, w: 84, h: 79 }, nameSlot: { x: 182, y: 306, w: 137, h: 22 }, ejectSlot: { x: 176, y: 358, w: 136, h: 15 } },
    ],
    // Hologram masks, positioned in the image (manifest robotPanel.masks); head = crew present
    masks: {
      head: { file: 'robot-mask-head.png', x: 513, y: 29, w: 50, h: 69, present: 'crew' },
      torso: { file: 'robot-mask-torso.png', x: 491, y: 72, w: 97, h: 146, present: 'torso' },
      leftArm: { file: 'robot-mask-leftArm.png', x: 586, y: 72, w: 65, h: 192, present: 'leftArm' },
      rightArm: { file: 'robot-mask-rightArm.png', x: 429, y: 71, w: 64, h: 192, present: 'rightArm' },
      legs: { file: 'robot-mask-legs.png', x: 442, y: 216, w: 201, h: 221, present: 'legs' },
    },
    // Labels on the right in image order (manifest robotPanel.labels): left edge x, top y, height h, right = inset from the panel's right edge
    labels: [
      { slot: 'crew', header: { x: 800, y: 35, h: 18, right: 93.9 }, body: { x: 795, y: 56, h: 47, right: 44.6 } },
      { slot: 'torso', header: { x: 800, y: 119, h: 18, right: 93.9 }, body: { x: 795, y: 142, h: 46, right: 44.6 } },
      { slot: 'rightArm', header: { x: 800, y: 203, h: 18, right: 93.9 }, body: { x: 795, y: 226, h: 47, right: 44.6 } },
      { slot: 'leftArm', header: { x: 800, y: 290, h: 18, right: 93.9 }, body: { x: 795, y: 312, h: 47, right: 44.6 } },
      { slot: 'legs', header: { x: 800, y: 375, h: 18, right: 93.9 }, body: { x: 795, y: 398, h: 42, right: 44.6 } },
    ],
    minFontPx: 11,            // text never below this (CSS px)
    ejectGrow: 12,            // image px the EJECT button extends upwards beyond its manifest slot (bigger click target)    crewAvatarSize: 64,       // px attribute of the generated crew avatar svg (CSS stretches it to the icon box)
    glyphs: { melee: '✊', ranged: '🔫', empty: '✕' }, // text icons of arm boxes (replace by images later)
  },
  center: {
    height: 183,              // CSS px at --hud-scale 1 (center_panel_* images)
    left: 142, mid: 49, right: 269,
    margins: { left: 44, top: 41, right: 66, bottom: 14 },
    minInnerWidth: 150,       // px at scale 1 – narrowest inner area (a single small unit)
    headerHeight: 20,         // title line above the content (px at scale 1)
    memberWidth: 72,          // group member cell width / height (px at scale 1)
    memberHeight: 48,
    memberGap: 4,
    statRows: 5,              // single unit: stat lines per column (more stats → more columns)
  },
  // Crew avatar index: hash of the crew name modulo this (avatars are generated badges, see Avatar.js)
  crewAvatarVariants: 24,
};

/**
 * Economy and construction – non-balance settings (balance: stats.json → rules.economy / rules.construction,
 * structures, vehicles, races[*].construction / population). Code: src/game/Economy.js, Construction.js,
 * OreDeposit.js, src/units/Vehicle.js, Structure.js, src/ui/BuildMenu.js.
 */
export const ECONOMY = {
  // new-game choice of the energy storage cap (world.settings.economy.energyCap); 'infinite' = no cap
  energyCaps: [200, 400, 600, 800, 1000, 1500, 2000, 'infinite'],
  defaultEnergyCap: 400,
  // [W5b] new-game choice of the population limit on top of the population of buildings
  // (world.settings.economy.populationCap); 'infinite' = no extra limit (behaviour before W5b)
  populationCaps: [100, 200, 300, 400, 500, 'infinite'],
  defaultPopulationCap: 'infinite',
  infinite: 'infinite',                    // settings value of an unlimited cap (JSON-safe, unlike Infinity)
  // [W5b] with an unlimited energy cap the shares of the cap (start energy, low energy, AI stock shares) are taken
  // of this reference cap (+ the team's EnergyBank storage) instead
  infiniteCapReference: 400,
  // [W5b] infinite resources: every non-energy account (and energy with an unlimited cap) holds this fixed amount
  // (AI reads a real number); the UI shows it as ∞ (src/ui/formatAmount.js)
  infiniteAmount: 99999999999999,
  // [W5b] resources of a cost paid only when the item really starts (production / research: first in its queue;
  // construction: the first builder works on it) – queued items take none of it
  deferredResources: ['energy'],
  messageTime: 2.5,                        // s a "not enough resources" message stays on screen
};

// --- [D1] energy power rules (src/game/Economy.js; balance numbers: stats.json → rules.economy, structures energyUse) ---
export const ECONOMY_POWER = {
  lowEnergyShare: 0.1,      // stored energy below this share of the cap = "low energy"
  recoverShare: 0.12,       // low energy ends once the store is back at this share (hysteresis: towers do not flicker)
  lowWorkRate: 0.25,        // consumers of a low-energy team work (and draw) at this rate; towers switch off
};
// --- [D1] end ---

/**
 * [B1] Ore multiplier of a new game / lobby (settings key `oreMultiplier`): scales the starting amount of every ore
 * deposit; 'infinite' = deposits never run out (replaces the old `infiniteDeposits` checkbox). Code: src/game/OreMultiplier.js,
 * Economy.js, OreDeposit.js, the New game and lobby screens.
 */
export const ORE_MULTIPLIER = {
  options: [0.5, 1, 2, 4, 'infinite'],
  default: 1,
  infinite: 'infinite',
};

/**
 * [D4] Starting resources multiplier of a new game / lobby (settings key `startMultiplier`): scales every player's
 * starting resources; 'infinite' = resources never run out. Code: src/game/StartMultiplier.js, Economy.js, New game and lobby.
 */
export const START_MULTIPLIER = {
  options: [0.5, 1, 2, 4, 'infinite'],
  default: 1,
  infinite: 'infinite',
};

/**
 * Starting research of a new game / lobby (settings key `startResearch`): every team starts with all research up to
 * this tier completed (0 = none). Code: src/game/StartResearch.js.
 */
export const START_RESEARCH = {
  options: [0, 1, 2, 3],
  default: 0,
  none: 0,
};

/**
 * Robot production through buildings (src/ui/RobotProduction.js, src/game/PartStock.js): the part factory
 * (stats.produces 'part') makes single parts into the team's part stock, the assembly bay (produces 'mech')
 * builds a mech from stocked parts in rules.mechAssembly time. Costs and times are in stats.json.
 */
export const ROBOT_PRODUCTION = {
  cancelReturnsParts: true,   // a cancelled assembly (or a destroyed bay) puts its parts back into the stock
  setIconLetters: 3,          // letters of a part set shown as the icon of its grid button
  partIcon: '⚙',
  mechIcon: '🤖',
  requiredSlots: ['legs', 'torso'], // arms are optional: a mech assembled without one leaves the bay without it
  noArmIcon: '∅',
  // Service of a mech driven into the bay (src/game/Repair.js, RobotProduction service page)
  serviceIcons: { repair: '🔧', stop: '⏹', release: '⏏', removeArm: '∅' },
};

/** Assembly hologram in the assembly bay (src/units/MechHologram.js): preview of the chosen parts, mech being assembled */
export const HOLOGRAM = {
  partColor: 0x5fd7ff,       // installed / chosen part
  partOpacity: 0.55,
  frameColor: 0x9fb4c8,      // Frame placeholder: part not installed yet (or a slot left empty)
  frameOpacity: 0.3,
  frameWireframe: true,
  pulse: 0.25,               // ± share of the opacity
  pulseSpeed: 3,             // rad/s
  heightOffset: 0.5,         // units above the bay's model top (the pad)
};

/** Where the starting units stand, relative to the start position: forward = towards the map centre, side = to the right */
export const START_LAYOUT = {
  matterConverter: { forward: -75, side: 0 }, // main building (stats.json hq: true)
  hoverTruck: { forward: -30, side: -45 },
  drillTruck: { forward: -30, side: 45 },
  fallback: { forward: -30, side: 0, step: 20 }, // unit ids without their own spot: in a row, step apart
  // Start sets 3–4 (START_SETS, stats.json → rules.economy.startSets) and the test scene
  robotPartFactory: { forward: -75, side: -70 },
  robotAssemblyBay: { forward: -75, side: 70 },
  vehicleFactory: { forward: -120, side: 0 },  // behind the main building
  startMech: { forward: -30, side: 0 },        // between the two trucks (set 4)
  startCrew: { forward: -12, side: 0 },        // in front of the mech; boards it at once
};

/** Start sets (src/game/StartSets.js; data in stats.json → rules.economy.startSets / startSetOrder / defaultStartSet) */
export const START_SETS = {
  armPlaceholder: '$startArm', // a mech slot with this value takes stats.json races.<race>.startArm
  mechSlots: ['legs', 'torso', 'leftArm', 'rightArm'],
};

/**
 * Test scene (main.js, only with ?test=1 or steelMen.startTestScene()): extra finished buildings the player gets
 * so robot production can be tried at once (part factory + assembly bay). A normal start uses the start sets.
 */
export const TEST_SCENE = {
  structures: ['robotPartFactory', 'robotAssemblyBay'],
};

/** Research (src/game/Research.js, src/ui/ResearchView.js); balance is in stats.json → research, rules.research */
export const RESEARCH = {
  deliveryCheckInterval: 0.5, // s between checks for captured parts brought to a research facility
  researchIcon: '🔬',
  analysisIcon: '🔍',
  doneIcon: '✔',
  lockedIcon: '🔒',
  analysisTab: 'salvage',     // id of the "salvage analysis" tab next to the tier tabs
  iconLetters: 3,             // letters of a research name shown as its grid icon
};

// [A9-research] Research tiers 2–4, Data network and the match option "superweapons" (src/game/Research.js,
// src/data/Stats.js canProduce, docs/notes/a9-f1-research.md); balance is in stats.json → research, rules.research
export const RESEARCH_A9 = {
  networkCheckInterval: 0.5,   // s of sim time between checks of Data network nodes (node building built / destroyed)
  networkEffect: 'dataNetwork', // research effect type that makes a team a Data network member ({ nodeStructures })
  sharedEffectTypes: ['modify', 'rule'], // effects of common research an allied node gets (no unlocks, no tiers)
  // canProduce also checks stats requiresTier for these exclusive groups (structures keep the buildCommands /
  // BuildMenu check, which shows the tier reason instead of hiding the building)
  tierCheckedGroups: ['vehicles', 'partSets'],
  superweaponFlags: ['superweapon', 'superweaponProgram'], // stats fields of items hidden while superweapons are off
  programFlag: 'superweaponProgram', // research field: superweapon program (tier rule requiresCompletedFlag, not shared, not a start research)
  superweaponsSetting: 'superweapons', // world.settings key of the lobby option (missing = on)
};

// [A9-superweapons] Superweapons: charge, launch command, warning, impact (src/game/Superweapons.js,
// src/game/commands/superweaponCommands.js, docs/notes/a9-f3-superweapons.md); balance is in stats.json →
// structures[id].superweapon and rules.superweapons
export const SUPERWEAPON = {
  commandType: 'launchSuperweapon',
  options: [true, false],    // values of the lobby / new-game combobox (world.settings[RESEARCH_A9.superweaponsSetting])
  defaultEnabled: true,
  seedEidFactor: 31,         // FX seed = building eid × this + launch tick (docs/notes/b3-common.md)
  launchHeightFactor: 1,     // FX start point of the shot: building origin + bodyHeight × this
  lethalDamage: 1e9,         // damage that kills a crew squad whatever its armour (neutron bomb)
};

// [A9-buildings] Enhancer auras, target designation, building self-repair, cloak / detection, vehicle wreck analysis
// (src/game/Auras.js, src/game/Stealth.js, Research.js, docs/notes/a9-f2-buildings.md); balance is in stats.json →
// structures[*].aura, rules.auras, rules.stealth, rules.repair.structureSelfRepair
export const AURAS = {
  recomputeTicks: 15,          // sim ticks between aura / designation recomputes (15 at 30 Hz = 0.5 s)
  ruleRefreshTicks: 60,        // sim ticks between re-reads of team research rules (self-repair, cloak while moving)
  maxTeams: 31,                // team bit masks (designation / detection) use 1 << allianceLeader(team)
  // building fields whose finished buildings draw their energyUse all the time (Economy.update, like towers)
  passiveConsumerFields: ['aura', 'archeology'],
  // aura types that apply only to buildings / only to units (others: both)
  structureOnlyTypes: ['construction'],
  unitOnlyTypes: ['sightRange'],
};
export const STEALTH = {
  updateTicks: 3,              // sim ticks between cloak / detection updates (also on every shot: Stealth.noteFired)
  moveEpsilon: 0.5,            // units/s – a unit faster than this counts as moving (cloaks without whileMoving drop)
  abilityType: 'cloak',        // ability that cloaks ({ whileMoving, duration, cooldown, breaksOnAttack })
  detectionType: 'detection',  // ability that reveals cloaked enemies ({ radius })
  designationStat: 'designationRange', // unit stat that also detects (target designation, e.g. targetingVehicle)
};
export const ARCHEOLOGY = {
  vehicleLootPrefix: 'salvageVehicle:', // loot key prefix of an analysed vehicle wreck (part loot keys stay 'salvage<set:kind>')
  vehicleLootKind: 'vehicle',           // loot.kind of a vehicle wreck (part loot: 'legs' | 'torso' | 'arm')
};

/** Vehicles (src/units/Vehicle.js) – visuals and collisions; stats are in stats.json → vehicles */
export const VEHICLE = {
  modelScale: 1.5,           // vehicle models are small next to the mechs
  radiusFactor: 0.42,        // collision radius = longer side of the model footprint × this
  collisionMass: 60,         // mass in unit collisions (mechs use their stats mass, crews MOVEMENT.crewMass)
  hoverHeight: 1.2,          // units – movementType 'hover' floats this high above the terrain
  ringMargin: 1,             // units – selection ring radius = collision radius + this
  ringSegments: 40,
  aimHeightFactor: 0.5,      // shots aim at this fraction of the model height
  explosionSize: 0.6,        // VFX.mechExplosion scale when a vehicle is destroyed
  cargoScale: 0.45,          // a carried salvage wreck (legs / torso) is shown on the truck at this size
  cargoHeightFactor: 0.8,    // …standing on the truck at this fraction of the vehicle height
  // Armed vehicles (src/units/CombatVehicle.js); balance (weapons, turret turn speed) is in stats.json
  combat: {
    autoChaseLeash: 1.5,          // auto-acquired targets are dropped beyond sightRange × this (as MECH.autoChaseLeash)
    turretRetargetInterval: 0.25, // s – an idle turret looks for a new target of opportunity this often
    minMoveAnimRate: 0.4,         // move clip (alien tank legs) never plays slower than this
  },
};

/** Structures (src/units/Structure.js) – visuals and footprint; stats are in stats.json → structures */
export const STRUCTURE = {
  // Global building model scale (mech ≈ 31 u tall → Outpost ≈ 42 u visible, part factory ≈ 21 u);
  // a single building can be tuned with stats.json → structures[id].modelScale (multiplier, default 1)
  modelScale: 1.0,
  footprintPadding: 1,       // units added around the model's ground box for the pathfinding obstacle
  yawStep: Math.PI / 2,      // buildings are rotated in 90° steps (pathfinding boxes are axis-aligned)
  constructionMinHeight: 0.15, // model height share shown when construction starts (grows to 1)
  spawnGap: 10,              // units in front of the footprint where produced units appear
  ringWidth: 0.8,            // units – selection outline width
  aimHeightFactor: 0.4,
  explosionSize: 1.6,        // VFX.mechExplosion scale when a structure is destroyed
  animClipIndex: 0,          // idle animation played (looped) once a building is complete
  // Buildings with stats `sunTracking` (solar panels): the idle clip is one full turn; every such building shows the
  // same world-space heading at the same moment (shared clock, building yaw compensated), slowed down by this factor
  sunTrackingSpeed: 1 / 3,
};

/** Placement preview of a building (HoverTruck build menu) */
export const PLACEMENT = {
  validColor: 0x6dff8a,      // hologram on a free spot – light green for every team (team colours may be red)
  invalidColor: 0xff2a1f,    // hologram on a blocked spot – red for every team
  opacity: 0.45,
  mapMargin: 15,             // units – buildings stay this far inside the map edge
  depositClearance: 14,      // units kept free around ore deposits (and the super node platform) for the DrillTrucks
  rotateStep: Math.PI / 2,   // rad per press of KEYBINDINGS.rotateBuilding (snapped to STRUCTURE.yawStep)
  // Drag to rotate: press the left button on the spot (pins the building), drag sideways, release = place it
  dragRotateThreshold: 12,   // px of horizontal drag before the building starts turning (a plain click just places it)
  dragRotatePixels: 60,      // px of further drag per rotateStep
  dragRotateDirection: -1,   // 1 / -1: which way a drag to the right turns the building (-1 = clockwise from above)
  // [hologram] preview look (src/game/PlacementHologram.js): validColor / invalidColor (never the team colour), see-through, bright fresnel edge, scan lines
  hologramOpacity: 0.28,     // 0..1 – transparency of the faces seen straight on
  hologramRim: 0.75,         // added opacity / brightness at the silhouette edges (fresnel)
  hologramRimPower: 2.2,     // fresnel sharpness (higher = thinner bright edge)
  hologramLineDensity: 0.16, // scan lines per world unit of height
  hologramLineSpeed: 0.12,   // line cycles per second (they drift upwards)
  hologramLineStrength: 0.35, // 0..1 – how much brighter a scan line is
  hologramGlow: 1.15,        // colour brightness multiplier (the hologram glows a little)
  hologramLineSharpness: 0.6, // 0..1 – scan line threshold (higher = thinner lines)
  hologramRimAlpha: 2.0,     // how much more the fresnel edge raises opacity than brightness
};

/**
 * Walls (src/game/Walls.js): posts (stats.json structures with placement 'wall') joined by wall segments
 * (their `wallSegment` id), turrets on posts (placement 'post') and armed buildings (src/units/DefenseStructure.js).
 * Costs, HP and weapons are in stats.json.
 */
export const WALL = {
  postSpacing: 48,           // units between neighbouring posts (the segment model is stretched to fit exactly)
  snapRadius: 18,            // units – a click this close to an own post starts / ends the wall on it
  maxSegments: 12,           // segments per placed wall line
  singlePostFactor: 0.5,     // a line shorter than postSpacing × this places one post only
  snappedMinFactor: 0.6,     // a line ending on an existing post: each segment between postSpacing × min…max
  snappedMaxFactor: 1.4,
  shapeStepFactor: 1,        // pathfinding circles along a diagonal segment every (half thickness × this) units
  axisTolerance: 1e-3,       // rad – a segment this close to an axis is one pathfinding box instead of circles
  turretSnapRadius: 22,      // units – turret placement picks the own post nearest to the cursor within this
  turretRetargetInterval: 0.25, // s – an armed building looks for a new target this often
  previewHoverOpacity: 0.3,  // preview of the post under the cursor before the wall start is set
};

// [N3] Wall placement by dragging (src/input/CommandInput.js, WallPlacement in src/game/Walls.js)
export const WALL_DRAG = {
  startPx: 6,                // px – the mouse must travel this far with the button held for a press to count as a drag (else it is a click)
  maxSegments: 12,           // segments of a dragged line at most (also capped by WALL.maxSegments); the cursor is clamped to this reach
};

// --- [H1] gates ---
// A finished full wall segment is rebuilt into a gate by the command grid button 'wallGate' (command upgradeGate,
// src/game/commands/buildCommands.js). The gate structure id is stats.json structures[segment].gateUpgrade.
export const GATE = {
  minLengthFactor: 0.6,      // a segment shorter than WALL.postSpacing × this is no "full" one (cut segments – trim – never are)
  maxBatch: 64,              // segments per upgradeGate command at most
  openCheckTicks: 3,         // [A1] the open state (visual only) of a gate is re-evaluated every N ticks (phase = eid)
};
// --- [H1] end ---

/** Ore deposits (src/game/OreDeposit.js); amount / rate are map data (data/maps/*.json) */
export const ORE_DEPOSIT = {
  crystalColor: 0xd99a3a, crystalEmissive: 0x7a4310, crystalEmissiveIntensity: 0.6,
  crystalCount: 5,           // crystals around the central one
  crystalHeight: 10, crystalWidth: 2.6,
  ringFactor: 0.8,           // outer crystals stand at radius × this
  outerScale: 0.6,
  tilt: 0.3,                 // rad – outer crystals lean outwards
  minScale: 0.25,            // crystals shrink to this size as the deposit runs out
  depletedOpacity: 0.25,     // look of an exhausted deposit
  infiniteAmountLabel: '∞',
};

// --- [N4] game clock and game speed (docs/notes/n4-clock.md) ---
// Kept at the end of the file on purpose: it extends SETTINGS_DEFAULTS, which is declared above.
/** Game speed: only the number of simulation ticks per real second changes, the fixed step 1 / SIM.tickRate never does */
export const GAME_SPEED = {
  options: [0.75, 1, 1.5, 2], // selectable multipliers (new game, lobby, in-game menu)
  default: 1,
  commandType: 'speed',       // control entry inside a lockstep turn (like PAUSE.commandType; never reaches the CommandBus)
  symbol: '×',                // label = value + symbol, e.g. "1.5×"
};
/** Game clock in the HUD: simulation ticks / SIM.tickRate (a pause stops it) */
export const GAME_CLOCK = {
  defaultVisible: true,       // profile default of settings.ui.showClock
  secondsPerMinute: 60,
  minutesPerHour: 60,
};
SETTINGS_DEFAULTS.ui.showClock = GAME_CLOCK.defaultVisible; // Profile.js only keeps keys that exist in the defaults
// --- [N4] end ---

// --- [N5] 2–4 players and alliances in the simulation (src/game/Alliances.js, docs/notes/n5a-sim.md) ---
export const MAX_PLAYERS = 4;  // seats of a match = TEAMS entries (TEAMS above has exactly this many)
export const PLAYERS = {
  min: 2,                      // fewest players of a match (a settings value below is clamped to min..MAX_PLAYERS)
  default: 2,                  // settings.playerCount missing = this many players (the 1-on-1 of earlier versions)
};
// --- [N5] end ---

// --- [N5b] players and alliances in the menus and HUD (docs/notes/n5b-ui.md, contract docs/notes/n5-contract.md) ---
// The maximum number of players is TEAMS.length (N5a keeps TEAMS in step with MAX_PLAYERS); nothing here repeats it.
export const PLAYERS_UI = {
  minPlayers: 2,               // fewest players of a game (new game and lobby)
  defaultPlayerCount: 2,       // player count of a fresh new-game menu
  defaultOpenSeats: 2,         // lobby: seats that are open in a freshly created lobby (the host opens more)
  minAlliances: 2,             // a game needs at least this many different alliances (otherwise nobody can win)
  allianceLetters: 'ABCD',     // label of alliance id n = letter n (past the end: the number n + 1)
  // Quick alliance choices by player count (alliance id of each seat in order); "everybody alone" is always offered
  presets: {
    3: { id: 'twoVsOne', alliances: [0, 0, 1] },
    4: { id: 'twoVsTwo', alliances: [0, 0, 1, 1] },
  },
  minimapAllyOutline: '#ffffff', // outline of an allied (not own) unit on the minimap; the fill stays the team colour
  minimapAllyOutlineWidth: 1,    // px
};
// --- [N5b] end ---

// --- [N7] map pings and lost-part alerts (src/ui/Pings.js, src/game/commands/pingCommands.js, docs/notes/n7-ping.md) ---
export const PING = {
  commandType: 'ping',           // command on the CommandBus (no simulation effect, only a UI event on allied clients)
  modifier: 'alt',               // 'alt' | 'shift' | 'ctrl': modifier + left click on the scene / minimap = ping
  durationMs: 5000,              // how long a ping stays
  submitCooldownMs: 1500,        // local anti-spam: pings sent faster than this are not submitted
  receiveCooldownSec: 1,         // anti-spam on receipt: per sender team, in game time (a faster ping is ignored)
  maxActive: 8,                  // pings shown at once (the oldest goes first)
  sceneRingPx: 64,               // diameter of the ring in the scene
  sceneRingBorderPx: 3,
  minimapRingMaxPx: 16,          // radius of the pulse on the minimap at its widest
  minimapPulsesPerSec: 1.2,
  minimapLineWidth: 2,
  minimapCenterPx: 2,            // radius of the centre dot on the minimap
  fallbackColor: '#ffffff',
  fadeOutMs: 600,                // last part of the lifetime: the ping fades out
  maxCoord: 100000,              // points farther from the origin than this are dropped by validate
  // Alerts (HUD, top centre, under the clock)
  alertDurationMs: 8000,
  alertMax: 3,                   // alerts shown at once
  // Lost part (arm shot off): event of ModularMech.onPartDamaged, badge above the robot, marker of the part on the minimap
  partLostEvent: 'steelmen:partLost',
  badgeText: '⚠',
  badgeDurationMs: 10000,
  badgeHeightOffset: 1.4,        // world units above the top of the robot
  partMarkerHalf: 3,             // px, half the side of the diamond marking a lost part on the minimap
  partMarkerOutline: '#ffffff',
  partMarkerLineWidth: 1,
  partMarkerBlinkMs: 600,        // marker pulses (visible / dim) with this period
  partMarkerDimAlpha: 0.45,
  sound: 'ping',                 // Sound.js event of a received ping (silently ignored when the hook has no such event)
  alertSound: 'partLost',
};
// --- [N7] end ---

// --- [N6] computer players: call signs and generated avatars (src/ai/AiProfiles.js, src/ui/Avatar.js, docs/notes/n6-ainames.md) ---
export const AI_PLAYERS = {
  // Call signs in the style of the machines: short, language neutral, no real people or brands. The avatar of a name is
  // its index in this list (so the list order is part of saved/online state: only append new names at the end).
  names: [
    'Anvil', 'Bastion', 'Cinder', 'Dagger', 'Ember', 'Forge', 'Gantry', 'Hammer',
    'Ingot', 'Jackal', 'Kiln', 'Lancer', 'Mantis', 'Onyx', 'Piston', 'Quarry',
    'Rivet', 'Sable', 'Talon', 'Umbra', 'Vulcan', 'Warden', 'Xenon', 'Zenith',
  ],
  nameMaxLength: 32,           // longest accepted name from the network (same limit as a nickname)
  seedRange: 0x100000000,      // solo: a fresh menu seed is a random whole number below this
  seedStep: 0x9e3779b1,        // seed + team * step = start of the name search of that seat (spreads neighbouring seeds)
  hashBasis: 2166136261,       // FNV-1a start value (string -> seed, e.g. the lobby code)
  hashPrime: 16777619,         // FNV-1a multiplier
  avatar: {
    viewBox: 32,               // the avatar is drawn on a square of this size and scaled
    sizes: { menu: 24, lobby: 24, stats: 18 }, // px per place of use
    pips: 3,                   // 1..pips small bars under the monogram (index-dependent, makes avatars of equal letters differ)
    pipWidth: 5, pipHeight: 2, pipGap: 2, pipY: 22, // geometry of the bars (viewBox units)
    letterY: 17,               // baseline of the monogram (viewBox units)
    letterSize: 14,            // font size of the monogram (viewBox units)
    strokeWidth: 2,            // outline of the shape (viewBox units)
    darkText: '#10161c',       // monogram colour on a light team colour
    lightText: '#f2f6fa',      // monogram colour on a dark team colour
    lightLuminance: 0.5,       // relative luminance above this counts as a light colour
    fallbackColor: '#888888',  // team colour that is not a plain #rrggbb
  },
};
// --- [N6] end ---

// --- [N8] crew evacuation and the pre-build phase (src/game/PreBuild.js, docs/notes/n8-flee-prebuild.md) ---
/** Crew that jumped out of a destroyed mech (Crew.flee with evacuate): runs from known enemies, then to its own HQ */
export const CREW_EVAC = {
  awareRange: 160,           // units – enemies the team sees (fog) this close to the squad count as threats
  hqBias: 0.6,               // weight of the direction to the own HQ added to the escape direction (0 = ignore HQ)
  hqMinDot: 0,               // the HQ pulls only when it lies at most 90° off the escape direction (cos of the angle)
  hqStandOff: 14,            // units – the squad stops this far outside the HQ's radius
  alarmDistance: 70,         // units – a known enemy this close while walking to the HQ starts a new run
  alarmInterval: 0.5,        // s – how often the walk to the HQ looks for such an enemy
};
/** Optional pre-build phase: units stay in a square around their start, no attacks, buildings only inside the square */
export const PREBUILD = {
  options: [0, 1, 2, 3, 5],  // minutes offered in the new-game menu and the lobby (0 = off)
  default: 0,
  halfSize: 140,             // units – half the side of the square around a team's start (map basic: starts 600 apart)
  edgeMargin: 2,             // units – units are kept this far inside the edge (on top of their radius)
  warnSeconds: 10,           // HUD countdown turns to the warning style (blinking) for the last seconds
  endedBannerMs: 3000,       // real ms the "pre-build over" text stays in the top banner
};
// --- [N8] end ---

// --- [N5FIX] observer after elimination, surrender removes the team, allies repair buildings (docs/notes/n5-fix.md) ---
export const ALLY_REPAIR = {
  structures: true,   // a repair vehicle may repair an ally's FINISHED building (never finish an unfinished one)
  units: false,       // allies' mechs / vehicles stay with their owner (no external repair across seats)
  cursor: 'cell',     // CSS cursor over a unit the selected repair vehicles can repair (own or ally), CommandInput
};
// --- [N5FIX] end ---

// --- [N2UI] user reminders: mining cursor, carried part rest height, minimap marker size (docs/notes/n2-reminders-ui.md) ---
export const N2_UI = {
  cargoRestFactor: 1,        // a part carried by a vehicle rests with its lowest point at this fraction of the vehicle height
  minimapMarkScale: 1.25,    // minimap unit / building markers: 1.25 = 25 % larger (Minimap.js)
};
// --- [N2UI] end ---

// --- [N5] one ore-deposit icon: HUD resource bar (Hud.js ICONS.ore) + mining cursor (CommandInput sets --cursor-mine) ---
// A glyph (emoji / character). An image path (.svg/.png/…) works for the cursor, but the HUD prints ICONS.ore as text,
// so keep a glyph unless Hud.js learns to draw images.
export const ORE_ICON = '⛏';
export const ORE_ICON_CURSOR = { size: 32, fontSize: 24, baselineY: 25, hotspot: 16, fallback: 'copy', imagePattern: /\.(svg|png|webp|gif|cur)$/i };
// --- [N5] end ---

// --- [N1B] mining reach at the end of the path, repair tolerance (docs/notes/n1b-wireup.md) ---
export const N1B = {
  harvestReachSlack: 8,      // units – extra harvester range for a truck standing at the end of its path (the deposit core is an
                             // inflated pathfinding obstacle: the path ends at the nearest free cell, farther than the range)
  harvestGiveUpTime: 3,      // s – a truck at the end of its path and still out of reach (even with slack) drops the order
  repairFullTolerance: 0.5,  // HP – a vehicle / building missing less than this counts as full (the UI shows rounded HP)
};
// --- [N1B] end ---

// --- [UISMALL] wall cost label at the cursor and the human player's avatar (docs/notes/ui-small.md) ---
export const UI_SMALL = {
  wallTip: {
    offsetX: 18,               // px right of the cursor
    offsetY: 22,               // px below the cursor
  },
  humanAvatar: {
    size: 64,                  // px: an uploaded picture is cropped to the centre square and scaled to size x size
    mime: 'image/jpeg',        // format of the stored data URL (must match dataUrlPattern)
    qualitySteps: [0.85, 0.7, 0.5, 0.3], // tried in order until the data URL fits maxDataLength
    netSize: 32,               // px: the thumbnail sent to the other players of a lobby (shown at most at AI_PLAYERS.avatar.sizes)
    netQualitySteps: [0.7, 0.5, 0.3, 0.15],
    netMaxLength: 1500,        // chars of that data URL: a room message / presence is limited to ~4 KiB (NET.maxMessageBytes)
    maxDataLength: 12000,     // chars of the stored / network data URL (a 64x64 JPEG is ~2-4 kB)
    background: '#ffffff',     // under transparent parts of an uploaded picture (JPEG has no alpha)
    maxFileBytes: 8000000,     // larger files are refused without being decoded
    dataUrlPattern: '^data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$', // the only thing allowed into an <img src>
    previewColor: '#3ea6ff',   // team colour of the preview in Settings (the real team colour is used in games)
    // Neutral head silhouette (viewBox units of AI_PLAYERS.avatar.viewBox)
    head: { cx: 16, cy: 12.5, r: 5.5 },
    shoulders: { cx: 16, halfWidth: 8.5, bottom: 27, height: 7.5 },
    inkOpacity: 0.85,          // head and shoulders over the team colour
  },
};
SETTINGS_DEFAULTS.avatar = '';  // data URL of the uploaded picture, '' = silhouette (Profile.js validates it)
// --- [UISMALL] end ---

// --- [HOLOIDLE] idle builder button next to the idle crew button (Hud.js), enemy bay hologram (RobotProduction.js) ---
export const IDLE_BUILDER = {
  minIdleTime: 1.5,          // s without an order before a builder vehicle (construct ability) counts as idle
  icon: '🔧',                // button face (the idle crew button uses 👷)
};
// Idle drill truck (harvest ability, no order – a mining truck keeps its harvest order, so it is not counted)
export const IDLE_DRILL = {
  minIdleTime: 1.5,          // s without an order before a drill truck counts as idle
  icon: '⛏',                 // button face
};
// --- [HOLOIDLE] end ---

// --- [SELSET] double-click select, prefer combat units on drag, settings Save (docs/notes/select-settings.md) ---
export const SELECTION = {
  doubleClickTime: 0.35,       // s – second left click on the same own unit within this time selects all of its type on screen
  preferCombatDefault: true,   // profile default of settings.ui.preferCombatOnDrag
  screenMargin: 1,             // NDC half-extent a unit must project into to count as "on screen" (1 = the whole viewport)
};
SETTINGS_DEFAULTS.ui.preferCombatOnDrag = SELECTION.preferCombatDefault; // Profile.js only keeps keys that exist in the defaults
// --- [SELSET] end ---

// --- [MAPS] map list, ASCII maps, map preview and start picks (docs/notes/maps.md) ---
/**
 * Map registry (src/game/Map.js GameMap.load resolves ids). `file` = data/maps/<file>.json. Old ids keep working
 * through `aliases`. ASCII maps (a "rows" array in the file) are turned into map data by src/game/AsciiMap.js.
 */
/** Modes a map can be offered in (MAPS.list[].modes); MAP_MODE_ANY is only a validation argument = no mode filter */
export const MAP_MODES = { campaign: 'campaign', skirmish: 'skirmish', multiplayer: 'multiplayer' };
export const MAP_MODE_ANY = 'any';
export const MAPS = {
  // list item: { id, file (data/maps/<file>.json, a sub-folder is allowed: 'campaign/c_m01'), modes? (MAP_MODES values, default defaultModes) }
  list: [
    { id: 'gen_01AI', file: 'basic' },
    // Naming: Map<players>_<creation order among maps with that player count>; list sorted by players, then order
    { id: 'Map2_01', file: 'map2_01' },
    { id: 'Map2_02', file: 'map2_02', modes: [MAP_MODES.skirmish, MAP_MODES.multiplayer] }, // Calorian basin (Mercury, from mission M1; docs/maps)
    { id: 'Map4_01', file: 'map4_01' },
    { id: 'Map4_02', file: 'map4_02' },   // same layout as Map4_01 on Mercury
    { id: 'Map6_01', file: 'map6_01' },   // destroyed city (Venus)
    { id: 'Map6_02', file: 'map6_02' },   // ruined wasteland (Mars)
    { id: 'Map8_01', file: 'map8_01' },   // city (Earth)
    // Campaign HELIOVRT (generated by tools/gen-maps.ps1 from docs/maps/blueprints; never offered in menus / lobby)
    { id: 'C_M01', file: 'campaign/c_m01', modes: [MAP_MODES.campaign] },
    { id: 'C_M04', file: 'campaign/c_m04', modes: [MAP_MODES.campaign] },
  ],
  // Old ids (saved profiles, lobby settings) keep working
  aliases: { basic: 'gen_01AI', Map02: 'Map2_01', Map03: 'Map4_01', Map04: 'Map6_01', Map05: 'Map8_01', Map06: 'Map6_02' },
  defaultMap: 'gen_01AI',
  defaultModes: [MAP_MODES.skirmish, MAP_MODES.multiplayer], // maps without "modes" (must contain the default map's modes)
  // Per-map ore richness (map file key "oreMultiplier"): scales the starting amount of every deposit of the map
  // (incl. the super node); multiplies with the lobby ORE_MULTIPLIER. 1 = unchanged, <1 poorer, >1 richer map
  oreMultiplier: { default: 1, min: 0.25, max: 4 },
  ascii: {
    cellSize: 7,               // units per character (current map 900 units ≈ 130 characters)
    chars: { wall: '#', grass: '?', concrete: '.', start: 'S', field: 'o', fieldCore: '+', rift: '-' },
    padChar: '#',              // short rows / non-square grids are padded with this
    wallHeight: 12.3,          // units – height of '#' blocks ([A8] 1.5 × mech height, PROC_MAP_FX; simulation: LOS / wall stops)
    wallHeightJitter: 0.12,    // ± share of wallHeight per block (fixed per map; stays above LOS.minHeight)
    riftDepth: 6,              // units the terrain sinks under '-' cells (visual; ground units cannot enter)
    // Ground tint per cell type, mixed into the terrain colour by tintStrength
    colors: { grass: 0x5a5c48, concrete: 0x757672, field: 0x5c5440, fieldCore: 0x66523a, rift: 0x1a1918, wall: 0x2f302f }, // [A8-style] dead, desaturated
    tintStrength: 0.75,
    terrain: { hillAmplitude: [2, 3], flatRadius: 80, flatFalloff: 60 }, // gentler hills than MAP.terrain
    // Starts are pushed away from walls until no '#' cell is within startClearance (room for the base behind the
    // start: START_LAYOUT matterConverter forward −75), at most startMaxShift
    startClearance: 100,       // units
    startMaxShift: 120,        // units
    // Ore fields ('o' + '+' connected areas): deposits = round(cells / cellsPerDeposit) in [1, maxPerField],
    // placed on '+' cells (else 'o') from the match seed, at least minSpacing cells apart
    cellsPerDeposit: 100,
    maxPerField: 4,
    minSpacing: 5,             // cells
    deposit: { radius: 7, amount: 6000, rateFactor: 1, maxHarvesters: 3 },
    // superNode "auto" (default): the field whose centre is nearest the map centre becomes the super node when it
    // is closer than superNodeMaxCenterShare × map size; "none" = no super node; { col, row } = that cell
    superNodeMaxCenterShare: 0.12,
    superNode: { radius: 40, coreRadius: 12, ore: { amount: 40000, rateFactor: 2, maxHarvesters: 8 } },
    riftMovementTypes: ['hover', 'air'], // stats mobility.movementType that may cross '-' cells
  },
  preview: {
    size: 260,                 // px (square) of the map preview in New game / lobby
    startRadius: 9,            // px – clickable start marker
    hitRadius: 14,             // px – click within this distance picks the start
    startFill: 'rgba(223, 230, 238, 0.25)',
    startStroke: '#dfe6ee',
    labelColor: '#0b0f14',
    labelFont: 'bold 11px sans-serif',
    selectedStroke: '#ffd166',
    fieldColor: 'rgba(214, 160, 70, 0.55)', // ore fields of non-ASCII maps (deposit circles)
    depositRadius: 3,          // px – deposit dot on non-ASCII maps
    planetLabelFont: 'bold 12px sans-serif', // planet name in the corner of the preview (maps with a planet)
    planetLabelColor: '#ffffff',
    planetLabelShadow: 'rgba(0, 0, 0, 0.8)',
    planetLabelPad: 8,         // px from the corner
  },
};

/**
 * Planet looks. A map file may name one in "planet" (key of MAP_PLANETS); maps without it look as before.
 * colors  – ground tint per cell type (replace MAPS.ascii.colors, also used by the minimap / preview); wall = tint under '#'
 * ridge   – colour of the wall blocks (replaces MAP.ridge.color)
 * sky     – scene background + fog colour and fog distance (units; none = no fog, far distance used for the background only)
 * sun     – directional light colour + intensity;  hemi – ambient (sky colour, ground colour, intensity)
 * i18n key of the planet name: `${MAP_PLANET_I18N_PREFIX}<planet>` (shown in map selection)
 */
export const MAP_PLANET_I18N_PREFIX = 'planet.';
export const MAP_PLANETS = {
  earth: {
    colors: { grass: 0x5f6150, concrete: 0x7a7b79, field: 0x5f5842, fieldCore: 0x6b563a, rift: 0x1a1918, wall: 0x2e3032 }, // [A8-style] dead, built-up
    ridge: 0x6b6d70,
    sky: { color: 0x9fb8c9, fogNear: 700, fogFar: 2200 },
    sun: { color: 0xfff4e0, intensity: 2.2 },
    hemi: { sky: 0xdde8ff, ground: 0x3a3326, intensity: 0.9 },
  },
  mars: {
    colors: { grass: 0x8c5a3e, concrete: 0x926c52, field: 0x6a4a3a, fieldCore: 0x784a30, rift: 0x241410, wall: 0x3a2a26 }, // [A8-style]
    ridge: 0x7d3b28,
    sky: { color: 0xc98b66, fogNear: 450, fogFar: 1500 },
    sun: { color: 0xffc99a, intensity: 2.0 },
    hemi: { sky: 0xf0b890, ground: 0x4a2a1e, intensity: 0.85 },
  },
  venus: {
    colors: { grass: 0x76744a, concrete: 0x8a8456, field: 0x6b6040, fieldCore: 0x7a6330, rift: 0x24220f, wall: 0x3a3820 }, // [A8-style]
    ridge: 0x7a7030,
    sky: { color: 0xb9ae52, fogNear: 180, fogFar: 950 },
    sun: { color: 0xf2e08a, intensity: 1.3 },
    hemi: { sky: 0xd8cf7a, ground: 0x4a4420, intensity: 0.8 },
  },
  mercury: {
    colors: { grass: 0x6a6968, concrete: 0x8a8885, field: 0x5e564f, fieldCore: 0x6c5e4c, rift: 0x121212, wall: 0x3a3938 }, // [A8-style]
    ridge: 0x5c5b59,
    sky: { color: 0x050506, fogNear: null, fogFar: null }, // black sky, no fog
    sun: { color: 0xffffff, intensity: 3.2 },
    hemi: { sky: 0xb8b8c0, ground: 0x2a2826, intensity: 0.35 },
  },
  // New planets (campaign maps): all values are estimates, to be tuned by eye
  moon: { // grey regolith, black sky without fog, cold hard light
    colors: { grass: 0x6e6e70, concrete: 0x8c8c8e, field: 0x5f5b58, fieldCore: 0x6c635a, rift: 0x0e0e10, wall: 0x38383b },
    ridge: 0x58585b,
    sky: { color: 0x020203, fogNear: null, fogFar: null },
    sun: { color: 0xe8f0ff, intensity: 3.0 },
    hemi: { sky: 0xa8b0c0, ground: 0x242426, intensity: 0.3 },
  },
  asteroid: { // black rock, black space; a rift is starry darkness
    colors: { grass: 0x3c3a3a, concrete: 0x55524f, field: 0x4a4038, fieldCore: 0x5a4a38, rift: 0x000000, wall: 0x1e1d1d },
    ridge: 0x2e2c2c,
    sky: { color: 0x000000, fogNear: null, fogFar: null },
    sun: { color: 0xfff0dc, intensity: 2.6 },
    hemi: { sky: 0x8890a0, ground: 0x181616, intensity: 0.28 },
  },
  interior: { // bunker: dark background, short dark fog, artificial warm light, concrete walls
    colors: { grass: 0x4a4944, concrete: 0x6a6964, field: 0x57503f, fieldCore: 0x64543a, rift: 0x0c0c0b, wall: 0x2a2a28 },
    ridge: 0x5e5d58,
    sky: { color: 0x0b0a09, fogNear: 250, fogFar: 900 },
    sun: { color: 0xffd9a0, intensity: 1.4 },
    hemi: { sky: 0xe0c090, ground: 0x2a2620, intensity: 0.7 },
  },
  station: { // like interior, colder and metallic
    colors: { grass: 0x4b4f55, concrete: 0x6b7077, field: 0x55524a, fieldCore: 0x625640, rift: 0x080a0c, wall: 0x25292e },
    ridge: 0x6f767f,
    sky: { color: 0x07090c, fogNear: 300, fogFar: 1000 },
    sun: { color: 0xd8e6ff, intensity: 1.5 },
    hemi: { sky: 0xb8d0f0, ground: 0x22262c, intensity: 0.7 },
  },
};
// --- [MAPS] end ---

// --- [A8-terrain] terrain type layer of a map (docs/blocks/A8.md; speed / path cost: [A14-terrain] below) ---
// Map file key "terrainTypes": { cellSize, cols, rows: string[] } – one RLE string per grid row (row 0 = −Z, column 0 = −X),
// "<count><code>" pairs (count omitted = 1), e.g. "40s12d3l"; the grid is the navigation grid (ASCII maps: the padded
// character grid). Maps without the key (or with a wrong size) are all `solid`. Index = position in `types`.
// Map file key "lavaCracks": [{ points: [[col, row], …], width }] – flat lava fissures (grid cells, floats; visual only).
export const MAP_TERRAIN = {
  types: ['solid', 'dust', 'rubble', 'mud', 'ice', 'lavaEdge'],
  codes: { solid: 's', dust: 'd', rubble: 'r', mud: 'm', ice: 'i', lavaEdge: 'l' },
  defaultType: 'solid',
  // tint of each type on the terrain / minimap (mixed into the planet ground colour; solid = no extra tint)
  colors: { solid: null, dust: 0xb08a5a, rubble: 0x5a5550, mud: 0x3d3326, ice: 0xb8d4e0, lavaEdge: 0x7a2a12 },
  tintStrength: 0.45,
};
// --- [A8-terrain] end ---

// --- [A14-terrain] terrain difficulty: speed factor per terrain type and chassis class, weighted A* (docs/notes/a14-terrain-sim.md) ---
// Numbers live in stats.json rules.terrain.speed[type][class] (missing = 1, 0 = impassable); the type list is MAP_TERRAIN.types.
export const TERRAIN_COST = {
  weightedPath: true,      // false = A* with uniform cost (as before A14; read when findPath runs); speed factors still apply
  classes: ['legs', 'wheels', 'tracks', 'hover', 'air'], // chassis classes (index = column of the factor table)
  weightedClasses: ['legs', 'wheels', 'tracks', 'hover'], // classes with a cost grid (air flies straight, never weighted)
  movementClasses: ['hover', 'air'], // mobility.movementType values that are a class of their own
  legsClass: 'legs',       // mechs and crews (stats with loadCapacity / squadSize)
  defaultChassis: 'tracks', // ground vehicle without mobility.chassis
  unweightedClass: 'air',  // factor always 1 whatever the data says
  escapeFactor: 0.25,      // speed factor on an impassable cell (0 in data) – the unit drives out instead of sticking there
  sampleStep: 0.5,         // cells – step of the terrain cost samples along a segment (line of sight shortcuts)
  shortcutTolerance: 0.02, // share – a straight shortcut may cost this much more than the planned path (sampling noise)
  shortcutSlack: 1,        // cells (× the cheapest cell cost) added to that limit when smoothing: the unit / goal is not
                           // at a cell centre, the A* costs are measured between centres
};
// --- [A14-terrain] end ---

// --- [A14-ui] terrain label at the cursor (src/ui/TerrainLabel.js, docs/notes/a14-terrain-ui.md) ---
export const TERRAIN_UI = {
  offsetX: 16,            // px from the cursor (right)
  offsetY: 36,            // px from the cursor (down; below the wreck tooltip offset)
  pickInterval: 0.1,      // s between ground raycasts (camera moves under a still cursor)
  maxClasses: 3,          // classes listed in one label
  hideTypes: ['solid'],   // types shown only when a unit is selected
  decimals: 2,            // max decimals of the multiplier
};
// --- [A14-ui] end ---

// --- [A8-style] near-future map look: stone walls, lava cracks, terrain type tint (src/game/Map.js, docs/notes/a8-map-visual.md) ---
export const MAP_STYLE = {
  wallChunk: 360,        // units – walls / rocks are merged into one mesh per square chunk of this size (draw calls + culling)
  wallSeed: 101,         // seed offset of the uneven wall tops (+ obstacle index)
  wallSink: 0.5,         // units the wall base is buried below the lowest terrain point of its footprint
  rockWidthFactor: 1.8,  // rock block width = radius × factor (blocks of stone instead of icosahedrons)
  lavaStep: 4,           // units – cracks are resampled to this step so the flat ribbon follows the terrain
  lavaLift: 0.45,        // units above the terrain (lava ribbon)
  rimLift: 0.6,          // units above the terrain (glow rim, above the lava)
  rimWidthFactor: 2.2,   // rim ribbon width = crack width × factor
  lavaRenderOrder: 1,
  rimRenderOrder: 2,
  minimapLava: { color: 'rgba(255, 110, 30, 0.9)', minWidth: 1 }, // px – crack lines on the minimap / preview
};
// --- [A8-style] end ---

// --- [SHIFT_BATCH] Shift + click on a production button queues several pieces (BuildMenu / RobotProduction) ---
export const SHIFT_BATCH = {
  count: 5, // pieces queued by one Shift + left click (each one is a normal queueUnit / queuePart command)
};
// --- [SHIFT_BATCH] end ---

// --- [B4] diplomacy menu, resource tribute to allies, player stats above the minimap (docs/notes/b4-diplomacy.md) ---
export const DIPLOMACY = {
  commandType: 'sendTribute',        // src/game/commands/diplomacyCommands.js (loss in stats.json rules.diplomacy.tributeLoss)
  maxAmount: 1000000,                // sanity cap of one tribute command (whole units)
  flowKinds: { sent: 'tributeSent', received: 'tributeReceived' }, // Economy.add kinds → MatchStats tribute record
  ui: {
    steps: [10, 100, 500],           // +/- buttons of the amount picker (Shift + click = ×shiftStepFactor)
    shiftStepFactor: 10,
    defaultAmount: 100,
    refreshMs: 500,                  // live values while the menu is open (own resources, preview, states)
    fallbackColor: '#808080',        // swatch of a team without a valid #rrggbb colour
    percent: 100,                    // share → percent in the loss hint
  },
};
export const PLAYER_STATS_BAR = {
  refreshSeconds: 1,                 // values are re-read this often (real seconds, UI only)
  // "value" of a team = weighted MatchStats: resources gathered + enemy kills + finished research
  score: { gathered: 0.1, unitKill: 10, structureKill: 25, research: 50 },
  compactFrom: 10000,                // values from here on are shown as 12.3k
  compactDivisor: 1000,
  compactDecimals: 1,
  fallbackColor: '#808080',          // swatch of a team without a valid #rrggbb colour
};
// --- [W3] queue frame above the player statistics (src/ui/QueueFrame.js, queue.css) ---
export const QUEUE_FRAME = {
  right: 25,                         // [css] base px from the right edge (same as #player-stats-bar)
  width: 255,                        // [css] base px (same as #player-stats-bar)
  gapAboveStats: 6,                  // base px between the frame and the top of the statistics bar
  statsBottom: 305,                  // base px from the bottom edge to the bottom of the statistics bar (hud.css #player-stats-bar)
  maxHeight: 360,                    // [css] base px; more groups scroll inside the frame
  cell: 38,                          // [css] base px: one queue item icon
  maxBuildsShown: 12,                // constructions of the builders listed (the rest is counted)
  progressDecimals: 0,               // seconds left in a tooltip
  percent: 100,
};
// --- [W3] end ---
// --- [B4] end ---

// --- [D2] economy alerts (src/ui/EconomyAlerts.js) ---
export const ECONOMY_ALERTS = {
  refreshMs: 250,                    // DOM refresh interval of the alert banners
  flowDecimals: 1,                   // decimals of income/drain per second in the energy tooltip
};
// --- [D2] end ---

// --- [N6-jump] jet movement ([R2]: JetPack torso 'flight', JumpJet legs 'hopRun' – docs/notes/n6-jumpjet.md) ---
export const JUMP_JET = {
  flight: {                          // short flight over any obstacle (walls, cliffs, rifts, buildings)
    defaultSpeed: 30,                // units/s – horizontal flight speed when the ability has no `speed`
    defaultHeight: 30,               // units – cruise height above the takeoff → landing line when no `height`
    minDuration: 1.2,                // s – shortest flight (takeoff + landing still show)
    climbShare: 0.3,                 // share of the flight time spent climbing (and the same share descending)
    pathPenalty: 25,                 // units – extra path cost of one flight, so a short walk around is preferred
    rangeSlack: 12,                  // units – takeoff may be this much farther than planned (≥ 1.5 nav cells)
    takeoffFacing: 20,               // degrees – the mech first turns to the landing point within this angle
  },
  hop: {                             // running hop over a low obstacle (rift) without stopping
    defaultHeight: 5,                // units – apex of the hop arc when the ability has no `height` (visual only)
    pathPenalty: 3,                  // units – extra path cost of one hop (a walk around of equal length wins)
    leaveDistance: 20,               // units – off the hop line farther than this (pushed / re-routed) ends the hop
  },
};
// --- [N6-jump] end ---

// --- [N7] aircraft and anti-air (src/units/Aircraft.js, Movement.followPath, Combat.hitsLayer – docs/notes/n7-air.md) ---
export const AIR = {
  movementType: 'air',               // stats mobility.movementType of flying units (data value)
  // Aircraft fly clear over everything on the ground: tallest model (Outpost ≈ 42 u, Aircraft Hangar ≈ 35 u, mech ≈ 31 u)
  // plus a margin (measured from the GLB bounds, see docs/notes/e2-flight-ui.md)
  tallestGround: 42,                 // units – tallest ground model (building) the aircraft must clear
  clearance: 18,                     // units – margin above it (the aircraft's own half height included)
  flightHeight: 60,                  // units above the terrain under the aircraft = tallestGround + clearance
  climbRate: 24,                     // units/s – take-off climb after leaving the hangar (≈ 2.5 s to flightHeight)
  enforceGroundTargets: true,        // true = weapons without "ground" in targets (Flak torso) cannot shoot ground units (R3: user decision, Flak = anti-air only)
  minimapBlipScale: 1.3,             // aircraft triangle on the minimap × R2.minimap.vehicleRadius
  crash: {                           // destroyed aircraft fall to the ground before exploding (visual only, Aircraft.destroy)
    gravity: 40,                     // units/s² – fall acceleration
    driftSpeed: 8,                   // units/s – forward drift along the heading while falling
    pitchDeg: 60,                    // nose-down tilt reached at the end of the fall
    rollDeg: 270,                    // total roll over the fall (direction from the unit's eid parity)
    maxTime: 5,                      // s – safety limit of the fall
    explosionSize: 1.3,              // VEHICLE.explosionSize × this when it hits the ground
    minAltitude: 1,                  // units – aircraft destroyed lower than this explode at once
  },
};
// --- [N7] end ---

// --- [N7-los] line of sight over tall map obstacles + wall snapping to them (Combat.hasLineOfSight, Walls.planLine) ---
export const LOS = {
  enabled: true,
  minHeight: 10,          // units – map obstacles at least this tall block shots and stop wall lines (ASCII walls ≈ 10.8–13.8)
  clearance: 0.5,         // units – a shot passing this much above the top edge is not blocked
  wallGap: 0.5,           // units – gap left between a wall line's last post and the obstacle it stops at
};
// --- [N7-los] end ---

// --- [W7] mech collision bodies: shoulder circle + foot circle (Movement / Pathfinding – docs/notes/w7-crew-collision.md) ---
// A mech has two circles: `radius` (shoulders: body + arms, unchanged) touches other mechs and everything as tall as
// its shoulders or taller; `footRadius` (legs only) touches everything lower (crews, vehicles, low buildings / walls,
// rifts). Both are measured from the model in ModularMech.#createRings; data may override them per part
// (parts.<set>.legs.collision.footRadius, parts.<set>.torso.collision.shoulderHeight).
export const MECH_COLLISION = {
  footRadiusFactor: 0.48,            // foot radius = larger side of the legs' bounding box × this (= MOVEMENT.bodyRadiusFactor)
  minFootRadius: 3,                  // units – foot radius never smaller than this
  shoulderHeightFactor: 1,           // shoulder height = arm-socket height above the feet × this
  unknownObstacleHeight: Infinity,   // height of a pathfinding obstacle without a known height (rocks, ridges, ore cores): tall
};
// --- [W7] end ---

// --- [H2] mech collision: boarding (docs/notes/h2-mech-collision.md) ---
// The two circles (shoulders `radius`, legs `footRadius`) come from [W7]. A crew boards when it is within reach of
// the LEGS' circle edge (CREW.board), or when it is pressed against the mech as close as collision allows.
export const MECH_COLLISION_H2 = {
  boardContactSlack: 1.5,  // units – crew counts as "touching" the mech this close to the collision contact distance
};
// --- [H2] end ---

// --- [18] procedural buildings (src/procedural, docs/notes/proc-style-kit.md) ---
// A structure with a procedural model (src/procedural/registry.js) uses it instead of its GLB; the footprint still
// comes from the GLB. `window.steelMen.procedural = false` (before a building loads) switches back for comparison.
export const PROC_BUILDINGS = {
  enabled: true,
};

// Visual state of procedural buildings (ProcModel.setPowered / setDamage, docs/notes/b1-building-core.md). Visual only.
export const PROC_STATE = {
  damageStart: 0.7,          // hp ratio below which the paint starts to darken
  minPaint: 0.3,             // paint colour scale at 0 hp
  teamKeep: 0.6,             // share of the darkening that team-coloured surfaces escape (the colour stays readable)
  damageSteps: 16,           // quantisation of the damage look (instance attribute / material changes only per step)
  powerSteps: 8,             // quantisation of the power fade (emissive of the static body)
  offGlow: 0.08,             // emissive scale of the static body (windows, neon) when unpowered (glow layers go to 0)
  fadeSeconds: 0.6,          // power fade duration (full → off and back)
  gateUnpoweredSpeed: 0.15,  // wall gate leaf speed without power, × WALL_ANIM.gateSpeed (slow manual opening; visual only)
};

// --- [proc-robot] procedural combat robots (src/units/ProcMechVisual.js, docs/notes/proc-robot-wire.md) ---
// Display only: the GLB parts stay the (hidden) simulation body, so on / off never changes the simulation.
// A robot is drawn procedurally when its owner's race is listed and every mounted part has a registered
// stats.json procModel; otherwise the GLB parts are drawn. window.steelMen.procedural = false turns it off too.
// --- [W-skin] hand-made GLB robot parts drawn over the stand-in simulation body (src/units/GlbSkinVisual.js,
// docs/notes/w-glb-skin.md). Display only; win over PROC_ROBOTS when every mounted part of the robot has a skin.
// Skin meshes follow the stand-in rig node with the same `_partNN` suffix. shift = skin part's socket minus the stand-in
// socket (part space, model units; from the designer's Assembly_*.glb), offset = whole skin in mech space (feet on ground).
export const GLB_SKINS = {
  enabled: true,
  teamColorTag: 'team-palette',  // glTF material extras.runtimeColor that takes the owner's colour
  races: {
    W: {
      offset: [0, -0.87, 0],     // skin soles 0.87 above the stand-in's (measured in game)
      sets: {
        Basic: {
          legs:     { path: 'RobotPartsMercuryDraft/BasicLegsW_Skel.glb',      shift: [0, 0, 0] },
          torso:    { path: 'RobotPartsMercuryDraft/BasicTorsoW_Skel.glb',     shift: [-0.1, -0.2, -0.3] },
          leftArm:  { path: 'RobotPartsMercuryDraft/BasicArmW_Left_Skel.glb',  shift: [1.1, -0.1, 1.6] },
          rightArm: { path: 'RobotPartsMercuryDraft/BasicArmW_Right_Skel.glb', shift: [-1.0, -0.1, 1.6] },
        },
      },
    },
  },
};

// --- [W-skin-tex] procedural textures of the GLB skins (src/units/GlbSkinTexture.js, docs/notes/w-skin-texture.md) ---
// Display only. Canvas textures generated once, shared by every robot; UVs generated once per shared geometry by a
// per-triangle box projection in part space. kinds = glTF material name -> texture kind. Values of the kinds are linear
// multipliers (map × material colour), absolute roughness / metalness (the material's own factors are replaced).
export const GLB_SKIN_TEXTURE = {
  enabled: true,
  seed: 0x3e5c,              // deterministic pattern generator (no Math.random)
  tileSize: 14,              // model units covered by one texture tile (robot ≈ 32 units tall)
  anisotropy: 4,
  normalScale: 0.9,          // material.normalScale of textured skin materials
  kinds: {
    W_Graphite_Titanium: 'graphite',
    W_Brushed_Titanium: 'brushed',
    W_TeamColour_Accent: 'team',
    W_Photon_Emissive: 'photon',
  },
  // tile layout (shared by all kinds, in tile units 0..1)
  layout: {
    diamondsPerTile: 4,      // rhombus panels across one tile
    seamKeep: 0.78,          // share of rhombus edges drawn as seams (the rest merge panels)
    insetChance: 0.35,       // panel gets a raised inner rhombus plate
    insetScale: 0.56,
    glowDotChance: 0.22,     // panel gets a glowing rhombus point (graphite emissive)
    glowDotSize: 0.011,
    traces: 22,              // engraved circuit traces (logo rays: straight runs, 45° bends, ring pad at the end)
    traceSegments: [2, 4],
    traceLength: [0.035, 0.13],
    traceBundle: [1, 3],     // parallel lines per trace
    traceSpacing: 0.0085,
    traceGlowChance: 0.3,    // trace also lit in the emissive map (graphite)
    padRadius: 0.006,
    brushLines: 900,         // brushed titanium streaks per tile
  },
  // line widths in tile units
  seamWidth: 0.0045,
  traceWidth: 0.0026,
  glowWidth: 0.0018,
  height: { base: 0.5, seam: 0.12, trace: 0.36, inset: 0.64, pad: 0.4 },
  normalStrength: 2.2,       // height gradient → normal slope
  kindsSetup: {
    graphite: {
      size: 1024, seams: true, insets: true, traces: 1, brush: 0,
      color: 0.92, toneVar: 0.09, seamColor: 0.32, traceColor: 0.72, insetColor: 1.0,
      roughness: 0.26, roughVar: 0.05, seamRough: 0.6, traceRough: 0.42, metalness: 0.88, seamMetal: 0.5,
      emissive: { color: '#ff6a12', intensity: 1.6, traces: true, dots: true },
    },
    brushed: {
      size: 1024, seams: true, insets: false, traces: 0.4, brush: 1,
      color: 0.95, toneVar: 0.05, seamColor: 0.38, traceColor: 0.78, insetColor: 1.0,
      roughness: 0.25, roughVar: 0.03, seamRough: 0.55, traceRough: 0.4, metalness: 0.8, seamMetal: 0.5,
      brushColor: 0.1, brushRough: 0.12,
      emissive: null,
    },
    team: {
      size: 512, seams: true, insets: false, traces: 0, brush: 0,
      color: 1.0, toneVar: 0.03, seamColor: 0.45, traceColor: 0.85, insetColor: 1.0,
      roughness: 0.3, roughVar: 0.04, seamRough: 0.6, traceRough: 0.45, metalness: 0.5, seamMetal: 0.3,
      emissive: null,
    },
    photon: {
      size: 256, maps: false,  // emissive map only (keeps the model's colour, roughness and emissive colour)
      emissive: { base: 0.72, lines: 6, lineWidth: 0.02 }, // lit base, brighter 45° laser lines
    },
  },
  // faction emblem decal (one plane per robot, shared geometry / material); placed by a ray on the slot's skin meshes
  emblem: {
    enabled: true,
    slot: 'torso',
    center: [0, 3.1],        // x, y in part space where the ray is cast (along -z from the front, torso front = +z)
    size: 2.4,               // model units
    lift: 0.03,              // above the surface (also polygonOffset)
    texSize: 512,
    color: '#ffffff',        // emissive tint (the canvas carries the logo's orange-gold gradient)
    intensity: 1.1,
    rays: 40,
  },
};

export const PROC_ROBOTS = {
  enabled: true,
  races: ['W'],
  charredFactor: 0.25,       // colour multiplier of a destroyed robot's paint (like MechPart DARK_FACTOR)
  // Procedural attack layer over GLB mechs (src/procedural/robots/GlbAttackFx.js): muzzle flash (no recoil: GLB nodes are never touched) of the
  // firing part, for weapons whose GLB set has no attack clip (MechAnimator fallback / redirect). Visual only.
  glbFx: {
    fallbackClip: 'attackidlestill', // MechAnimator CLIPS.attackFallback – a weapon whose clip is this (or redirected) gets the layer
    maxAttacks: 4,           // simultaneous attacks of one mech (2 arms + torso + legs)
    maxFlashes: 6,           // pooled flash meshes per mech (shared geometry / materials; none is created per shot)
    flashTime: 0.08,         // s a flash stays
    // weapon → kind: melee gets nothing; first match wins: projectileShape, class, a projectileColor (laser) → 'beam', else 'gun'
    byShape: { missile: 'launcher', bolt: 'blaster', shell: 'gun', orb: 'blaster' },
    byClass: { area: 'pulse', artillery: 'launcher' },
    // color flash tint (stats projectileColor wins), radius / length = flash size in mech units,
    // lead = share of attackTime before the first shot, share = shots spread over it
    kinds: {
      gun: { color: '#ffe08a', radius: 0.9, length: 2.4, lead: 0.15, share: 0.75 },
      launcher: { color: '#ffb347', radius: 1.5, length: 3.2, lead: 0.2, share: 0.7 },
      blaster: { color: '#66e0ff', radius: 1.1, length: 2.2, lead: 0.2, share: 0.6 },
      beam: { color: '#ff7a3a', radius: 1.3, length: 4.5, lead: 0.55, share: 0.2 },
      pulse: { color: '#9ad0ff', radius: 3.2, length: 1.6, lead: 0.5, share: 0.1 },
    },
  },
};

// --- [18P] procedural building performance (src/procedural/BuildingBatcher.js, docs/notes/proc-perf.md) ---
// Finished buildings of the same type / style are drawn as InstancedMesh per LOD (draw calls grow with the number of
// building types, not buildings). LOD0 = everything incl. animated parts and glow meshes (a few buildings near the
// camera), LOD1 = no small parts / animations / glow meshes, LOD2 = coarse silhouette. Visual only.
export const BUILDING_LOD = {
  enabled: true,             // false = every building keeps its own meshes (window.steelMen.batching = false does the same)
  levels: 3,                 // LOD0..LOD2 (geometry sets built by PartBuilder.buildLods)
  // Part kept in LOD n when its largest side ≥ share × largest side of the whole building (explicit `detail` wins)
  partMinShare: [0, 0.02, 0.08],
  roundedSegments: [null, 1, 0],   // rounded boxes per LOD: as built / chamfer / plain box
  hysteresis: 0.12,          // a building leaves its LOD only after the distance passed the limit by this share
  maxFull: 8,                // at most this many buildings at LOD0 at once (the nearest ones)
  fullRankSlack: 2,          // a building at LOD0 keeps it while its rank is below maxFull + slack
  updateFrames: 10,          // LOD decision every N rendered frames (immediately after a quality change)
  idleFrames: 240,           // an empty instance group is released after this many rendered frames
  initialCapacity: 16,       // instances per group at first (doubles when full)
  emblemMaxLod: 1,           // faction sign is drawn up to this LOD
  // By effective level (high | medium | low): distance (camera → building, model units) up to which LOD0 / LOD1 is
  // used (full 0 = never LOD0, no animated parts and no glow meshes), panel texture size (px)
  quality: {
    high: { full: 140, mid: 330, textureSize: 256 },
    medium: { full: 140, mid: 220, textureSize: 256 },
    low: { full: 140, mid: 150, textureSize: 128 },
  },
  animations: { full: 1, near: 0.5, off: 0 },   // buildingAnimations: share of the level's LOD0 range (off = no animated parts, no glow meshes)
  order: ['high', 'medium', 'low'],   // best → worst (the auto mode walks along it)
  // auto: frame time (ms) EMA; slower than degradeMs for degradeSeconds → one level down, faster than upgradeMs for
  // upgradeSeconds → one level up; maxFrameMs clamps a single frame (hidden tab, loading)
  auto: { degradeMs: 30, upgradeMs: 19, degradeSeconds: 3, upgradeSeconds: 12, maxFrameMs: 250, smoothing: 0.08 },
};
// --- [18P] end ---

// --- [18T] procedural buildings: faction emblem + team paint (src/procedural/ProcModules.js, docs/notes/proc-teamcolor-kit.md) ---
// Emblem: the sign is always drawn on a NEUTRAL plate (part of the decal texture, 1 draw call); team paint never touches it.
//   mode 'faction' = emblem in the faction logo colour (style.emblem.color, constant for every building of the race, the
//   team colour does not repaint it); 'team' = emblem in the team colour (old behaviour). Read when a material is created
//   (change it before the first building loads / reload the page). The plate colour is style.emblem.plate (dark | light).
export const PROC_EMBLEM = {
  mode: 'faction',          // 'faction' | 'team'
  glyphFill: 0.74,          // share of the decal quad the sign itself covers (the rest is plate)
  plate: {
    grow: 1,                // decal quad size × this (1 = the placement `size`; > 1 makes the plate bigger than the old decal)
    margin: 0.02,           // plate edge inset (share of the quad)
    radius: 0.16,           // corner radius (share of the quad)
    rim: 0.05,              // rim width (share of the quad)
    alpha: 0.97,
    dark: { base: '#15171b', rim: '#3d424b' },
    light: { base: '#d6d8da', rim: '#8b9098' },
  },
  boost: { neon: 1.25, paint: 1 },   // faction colour multiplier (neon is unlit and tone-mapping is off; 'team' mode uses PROC_MODULES.emblem.neonBoost)
};

// Team paint: coloured surfaces of a building. They are ordinary vertices of the building's static geometry with the
// team mask (aSurface.x = 1) of the shared paint shader → no extra draw call or material; the colour is uTeamColor /
// the instance attribute aInst, so batching, LOD and staticOnly work unchanged and setTeamColor repaints everything.
export const PROC_TEAM_PAINT = {
  target: { min: 0.15, max: 0.30 },   // share of the visible surface area of a building painted in the team colour
  paint: { metal: 0.15, rough: 0.38 },   // lacquer: lit, no emission
  paintWhite: '#f2f2f2',              // diffuse of team paint (× team colour)
  shadeWhite: '#b4b4b4',              // darker team paint (alternating stripes, panel cores)
  // style.teamPaint is merged over these; mode → [stripe share, panel share] of the painted area (kit.team.mix)
  defaults: { mode: 'mixed', share: 0.2, stripes: 2, stripeKind: 'band', panelKind: 'inset', banner: 'flag', trim: 1, roofMark: 1 },
  modeMix: { stripes: [0.7, 0.3], panels: [0.3, 0.7], mixed: [0.5, 0.5] },
  maxStripes: 6,
  // coarsest BUILDING_LOD level the element still appears in (2 = even the far silhouette: team colour must read from the RTS camera)
  lod: { stripe: 1, panel: 2, trim: 2, banner: 2, roofMark: 2 },
  emblemClear: 0.15,                  // gap kept between team paint and an emblem decal (teamStripe `avoid`)
  stripe: { depth: 0.05, gap: 0.3, fineShare: 0.3, slashWidth: 1.0, minSegment: 0.3 },   // gap = share of a band's height; slash = stripe width in heights
  panel: { depth: 0.07, frame: 0.12, rivetR: 0.07, rivetInset: 0.22, lowerShare: 0.14, coreShare: 0.55, segments: 20 },
  trim: { h: 0.22, t: 0.14, tubeSegments: 4, ringSegments: 40 },
  banner: {
    poleR: 0.07, poleSegments: 6, clothTopShare: 0.92,
    flagLen: 0.5, flagH: 0.28, clothT: 0.05, pennantLen: 0.55, pennantH: 0.22, orbR: 0.1, finW: 0.3, finT: 0.06,
  },
  roofMark: { h: 0.12, frame: 0.12, chevronArm: 0.34, chevronAngle: 0.62, stripeShare: 0.12, discCore: 0.45, rhombusCore: 0.55, segments: 28 },
  share: { downFacing: -0.5, teamMask: 0.5 },   // teamPaintShare(): skip triangles with normal.y below this; team = aSurface.x ≥ teamMask
};
// --- [18T] end ---

// --- [F1] part stock window and selling parts (src/ui/StockWindow.js, src/game/commands/stockCommands.js, docs/notes/f1-inventory.md) ---
export const PART_SALE = {
  commandType: 'sellPart',           // { type, team, path, count } – count 1..stock
  requiredProducers: ['part', 'mech'], // selling needs an own finished building producing any of these (part factory / assembly bay)
  refreshMs: 500,                    // live refresh of an open window (stock / resources change in the simulation)
  percent: 100,
  windowIcon: '▦',                   // button icon in the factory / assembly bay panel
  maxCountClamp: 9999,               // upper bound accepted for `count` of a command (sanity)
};

// --- [ICON] building icons rendered at runtime (src/ui/IconRenderer.js, docs/notes/icon-renderer.md) ---
export const ICON_RENDERER = {
  size: 96,                         // px, default icon edge
  perFrame: 1,                      // icons rendered per animation frame (minimum, even when a frame is already slow)
  maxPerFrame: 6,                   // [B5] cap per frame while a backlog waits
  frameBudgetMs: 6,                 // [B5] extra icons are rendered in the same frame only while this time budget is not used up
  fov: 26,                          // deg
  fitMargin: 1.12,                  // > 1: free space around the bounding sphere
  viewDir: [0.8, 0.7, 1],           // camera direction from the model centre (+Z = gate side, front-right, above)
  targetLift: 0.04,                 // share of radius the look-at point is lowered
  nearMin: 0.1,                     // camera near plane lower bound
  farInitial: 5000,                 // camera far plane before the first fit
  hemi: { sky: 0xdfe8ff, ground: 0x4a4a52, intensity: 1.6 },
  sun: { color: 0xfff1dc, intensity: 2.6, pos: [-1.2, 2, 1.4] },
  emblemColorFallback: '#ffffff',
  // [B2-1] units / robots / parts (IconScenes.js): fitted by the projected bounding box (fitMargin = share of free space)
  unit: { viewDir: [0.9, 0.55, 1], fitMargin: 1.06 },    // vehicles stand on the ground, jets / hovers float without extra border
  robot: { viewDir: [0.8, 0.45, 1], fitMargin: 1.06 },
  part: {
    fitMargin: 1.08,
    viewDir: { legs: [0.8, 0.45, 1], torso: [0.8, 0.5, 1], arm: [0.9, 0.25, 1] },   // by part kind
    mirrorLeftArm: true,            // the left arm is seen from its own side (x of viewDir mirrored)
  },
  crew: {                           // crew squad icon (no model): team-coloured disc with a helmeted bust and the race emblem
    background: '#23272e', silhouette: '#aeb4bd', visor: '#10131a', ringWidth: 5, discRadius: 46,
    head: { x: 50, y: 37, r: 14 },
    visorBox: { x: 40, y: 34, w: 20, h: 7 },
    shoulders: { left: 22, right: 78, bottom: 90, top: 58, neckY: 60 },
    emblem: { x: 39, y: 66, size: 22 },
  },
  hiddenBoneScale: 1e-4,            // scale of bones hidden in a single-part icon (0 would be a degenerate matrix)
};

// --- [GENBLAST] death blast of a power generator (Combat.structureBlast; balance in stats.json structures.powerGenerator.explosion) ---
export const GENERATOR_BLAST = {
  delay: 0.4,                 // s between the building being destroyed and the blast (chains ripple from generator to generator)
  visualSizePerRadius: 0.07,  // effect size = blast radius × this (VFX layers are made for size 1 ≈ fireball radius 15)
  heightUnit: 8,              // layer heights (VFX `height`) × this = units above the reactor centre
  layers: [
    { model: 'fireBall', duration: 1.4, scaleFrom: 0.3, scaleTo: 2.0, opacityFrom: 1, opacityTo: 0, height: 0.5, spin: 2, scroll: 0.6 },
    { model: 'fireBall', delay: 0.3, duration: 1.1, scaleFrom: 0.2, scaleTo: 1.5, opacityFrom: 0.9, opacityTo: 0, height: 1.5, spin: -3, scroll: 0.8 },
    { model: 'shockDome', duration: 1.0, scaleFrom: 0.2, scaleTo: 2.6, opacityFrom: 0.6, opacityTo: 0, height: 0, flatten: 0.3 },
    { model: 'spiral', delay: 0.1, duration: 1.8, scaleFrom: 0.4, scaleTo: 1.4, opacityFrom: 0.8, opacityTo: 0, height: 0, spin: 4, scroll: 1 },
  ],
};
// --- [GENBLAST] end ---
// --- [LOBBY_LIST] last multiplayer game setup (Profile.js getLobbyPrefs / saveLobbyPrefs); the password is never stored ---
// name: null = default t('lobby.defaultName', {name}) that follows the current nickname; visibility: one of LOBBY.visibilities
SETTINGS_DEFAULTS.lobby = { name: null, visibility: LOBBY.defaultVisibility };
// --- [LOBBY_LIST] end ---
// --- [I1] determinism ---
// Console harness steelMen.det (src/debug/DeterminismHarness.js, docs/notes/i1-determinism.md). Debug only, never
// read by the simulation.
export const DETERMINISM = {
  seed: 42,                    // match seed of the reference runs (same as ?seed=42)
  humanPoints: 24,             // human/human: checkpoints…
  humanInterval: 300,          // …every this many ticks (24 × 300 = 7200 ticks = 4 min)
  attackTick: 90,              // human/human: attackMove of every side's fighters to the other base executes in this tick
  aiSeconds: 1800,             // AI vs AI: default length (game seconds)
  aiPoints: 24,                // AI vs AI: checkpoints spread over the length
  chunkTicks: 300,             // own ticking: ticks between yields to the browser (model loads, rendering)
  spPollMs: 250,               // game-loop mode: how often the harness checks whether the run is over
  delayJitterSteps: 4,         // artificial load delay: delay × (1 + call index mod steps) / steps – uneven, not random
  dbName: 'steelMen.det',      // IndexedDB database of saved runs (per-tick data does not fit into localStorage)
  snapshotEvery: 150,          // ticks between entity snapshots (5 s): compare() diffs single units at the first one after a split
  perTickParts: true,          // subsystem hashes after EVERY tick (exact first differing subsystem; ≈ +10 % run time)
  stopAfterSnapshots: 2,       // live compare: snapshots taken after the first differing tick before the run stops
};
// Watchdog of World.trackLoad / spawnDeferred: a load that has not settled after this long is given up (console.error)
// so a hanging request cannot freeze the match forever. Real time only releases the stall; the simulation never reads it.
SIM.loadTimeoutMs = 20000;
// --- [I1] end ---

// --- [I2] ---
export const CREW_ANIM = {
  phaseStep: 0.618034,  // golden ratio: member index -> evenly spread, deterministic animation phase (Crew)
};
// --- [I2] end ---

// --- [b5-crew] procedural crew member (src/procedural/crew/ProcCrew.js, docs/notes/b5-crew-venus.md) ---
// Visual only. One crew member as a ProcUnit (UnitKit: LOD0 skinned, far LOD instanced by the UnitBatcher). Model units =
// the GLB crew (≈ 7 high, feet on y = 0, forward +Z); Crew applies stats.crew.modelScale (0.5). The simulation never reads
// the model: Crew.bodyHeight / aimHeight keep coming from the GLB box (see the note), so on / off changes no sim value.
export const PROC_CREW = {
  enabled: true,
  races: ['Z'],                  // races (style keys) that have a procedural crew; the others keep the GLB
  height: 7.0,                   // model units, reference height of the figure (informative; shape below adds up to it)
  defaultTeamColor: '#3a5ccc',
  segments: { sphere: [10, 7], limb: 8, joint: [8, 6] },   // wSeg × hSeg of spheres, sides of limb cylinders (base for variants without `seg`)
  pillowSubdiv: 2,               // [b4-crew-slim] subdivision per face of the cheap rounded box (segs: 0): 12 · n² = 48 triangles
  // [b6-crew] shape variants by style silhouette (kit.style.silhouette of data/buildingStyles.json; never by race). A variant
  // overrides parts of `shape` below: torso / head / visor / shoulder / pack / chest / belt (false = none) / foot, plus limbSeg /
  // jointSeg. `kind` picks the primitive: torso ellipsoid(default) | rounded | tapered | prism; head dome(default) | rounded |
  // tapered | facet; visor ellipsoid(default) | slab; shoulder pad sphere(default) | rounded | slab | facet; pack sphere(default) |
  // box | prism. Unknown silhouette = defaultVariant. Head top must stay ≈ height (7.0 ± 3 %), feet on y = 0 (legs untouched).
  defaultVariant: 'round',
  variants: {
    // [b4-crew-slim] `lean: true` = open limb ends hidden inside joints / pads, no hip ball; `seg` = sphere segments [w, h] per part,
    // belt / packCap = sides of those cylinders; handSeg = hand ball. segs: 0 of a rounded box = cheap 48-triangle pillow.
    round: {                     // = the base shape below (ellipsoid torso, dome helmet, ball pads, ball pack); ≈ 730 triangles
      lean: true,
      limbSeg: 6,
      jointSeg: [6, 4],
      jointScale: 0.92,          // knee / elbow ball radius × this: its low-poly vertices stay inside the hex limb (no spiky ring)
      handSeg: [8, 4],
      seg: { torso: [8, 6], head: [10, 6], pad: [6, 4], pack: [6, 3], visor: [6, 3], belt: 8, packCap: 6 },
    },
    rounded: {                   // ≈ 760 triangles
      lean: true,
      limbSeg: 6,
      jointSeg: [6, 4],
      jointScale: 0.92,
      handSeg: [6, 4],
      torso: { kind: 'rounded', w: 1.9, h: 2.05, d: 1.35, radius: 0.42, segs: 1 },
      chest: { z: 0.7, w: 1.0 },
      belt: false,
      head: { kind: 'rounded', w: 1.4, h: 1.3, d: 1.3, radius: 0.4, segs: 1 },
      visor: { kind: 'slab', w: 1.0, h: 0.34, d: 0.2, y: 0.05, z: 0.62, glowZ: 0.76 },
      shoulder: { kind: 'rounded', x: 1.22, w: 0.95, h: 0.62, d: 0.9, radius: 0.24, segs: 0, padY: 0.1 },
      pack: { kind: 'box', w: 1.05, h: 1.5, d: 0.75, radius: 0.25, segs: 0, y: 1.2, z: -0.95, capScale: 0.6, capH: 0.14, glowZ: -1.32 },
    },
    angular: {
      limbSeg: 6,
      jointSeg: [6, 4],
      torso: { kind: 'tapered', w: 1.55, topW: 2.15, h: 2.1, d: 1.3 },
      chest: { z: 0.68, w: 1.0 },
      belt: false,
      head: { kind: 'tapered', w: 1.4, topW: 1.0, h: 1.24, d: 1.3, crest: { w: 0.2, h: 0.26, d: 0.95, z: -0.05, sink: 0.08 } },
      visor: { kind: 'slab', w: 1.1, h: 0.28, d: 0.2, y: 0.08, z: 0.62, glowZ: 0.76 },
      shoulder: { kind: 'slab', x: 1.4, w: 1.0, h: 0.45, d: 1.0, tilt: 0.28, padY: 0.18 },
      pack: { kind: 'box', w: 1.2, h: 1.4, d: 0.85, radius: 0, y: 1.2, z: -1.0, capScale: 0.5, capH: 0.16, glowZ: -1.45 },
      foot: { w: 0.8, d: 1.3, z: 0.35 },
    },
    faceted: {
      limbSeg: 6,
      jointSeg: [6, 4],
      torso: { kind: 'prism', rTop: 0.98, rBottom: 0.76, h: 2.1, sides: 6 },
      chest: { z: 0.8, w: 0.8 },
      belt: false,
      head: { kind: 'facet', wSeg: 6, hSeg: 4 },
      visor: { kind: 'slab', w: 0.95, h: 0.3, d: 0.2, y: 0.05, z: 0.7, glowZ: 0.82 },
      shoulder: { kind: 'facet', x: 1.2, wSeg: 5, hSeg: 3 },
      pack: { kind: 'prism', rTop: 0.5, rBottom: 0.6, h: 1.5, sides: 6, y: 1.2, z: -0.95, capScale: 0.6, capH: 0.14, glowZ: -1.55 },
    },
  },
  shape: {
    hipY: 3.3,                   // hip joint height above the ground
    hipX: 0.5,                   // hip joint x
    pelvis: { w: 1.5, h: 0.5, d: 1.0, y: 0.1 },
    thigh: { len: 1.55, rTop: 0.42, rBottom: 0.34 },
    knee: { r: 0.36 },
    shin: { len: 1.45, rTop: 0.33, rBottom: 0.27 },
    foot: { w: 0.7, h: 0.3, d: 1.1, z: 0.25, drop: 0.15 },   // drop: foot centre below the ankle (ankle = shin end)
    torso: { y: 0.25, cy: 1.05, rx: 0.95, ry: 1.1, rz: 0.72 },   // torso bone above the hip; ellipsoid centre / radii
    chest: { w: 0.95, h: 0.7, d: 0.14, y: 1.25, z: 0.66 },       // team plate on the chest
    belt: { r: 0.85, h: 0.22, y: 0.05 },
    neck: { y: 2.15, r: 0.25, h: 0.35 },
    head: { y: 2.65, r: 0.72, sy: 1.0, sz: 1.05 },
    visor: { rx: 0.52, ry: 0.27, rz: 0.3, y: 0.05, z: 0.5, glowR: 0.1, glowZ: 0.78 },
    shoulder: { x: 1.1, y: 1.7, padR: 0.5, padSy: 0.75, padY: 0.08 },   // team pad sphere on the shoulder joint
    upperArm: { len: 1.3, rTop: 0.3, rBottom: 0.25 },
    elbow: { r: 0.27 },
    forearm: { len: 1.2, rTop: 0.25, rBottom: 0.22 },
    hand: { r: 0.3 },
    armRest: 0.08,               // rad, arms hang slightly outwards
    pack: { y: 1.25, z: -0.95, r: 0.55, sy: 1.15, capR: 0.36, capH: 0.12, glowR: 0.3, glowZ: -0.5 },
  },
  motion: {
    moveEpsilon: 0.3,            // units/s – below this the member idles
    runRefSpeed: 7,              // units/s – stride rate 1× (same reference as stats.crew.runAnimRefSpeed)
    minRate: 0.6,                // lowest stride rate while moving (CREW.minRunAnimRate)
    cyclesPerSecond: 1.5,        // full strides (left + right step) per second at rate 1
    blendRate: 8,                // 1/s – smoothing between idle and run
  },
  run: { thigh: 0.75, knee: 1.1, arm: 0.65, elbow: 0.9, lean: 0.14, twist: 0.12, bob: 0.45 },   // rad / model units
  idle: { breath: 0.025, breathRate: 0.35, look: 0.25, lookRate: 0.12, armSway: 0.03, swayRate: 0.3, packPulse: 0.15, packRate: 1.1 },
  preview: { gap: 9, rowGap: 14, squad: 5, spacing: 5, maxDelta: 0.1, switchEvery: 3, runSpeed: 10,   // console preview (UI only)
    compareRaces: ['X', 'Y', 'Z', 'W'], compareSquad: 3 },   // spawnCrewCompare: races side by side (proc front, GLB behind), members each
};
// --- [b5-crew] end ---

// --- [J2] save ui ---
export const SAVE_UI = {
  nameMaxLength: 60,           // longest name of a saved game
  savedToastMs: 2500,          // how long the "saved" confirmation stays
  notifyStorageKey: 'steelMen.saveIncompatSeen', // localStorage: ids of incompatible saves the user already decided about
};
// --- [J2] end ---
// --- [A2-ui] continue lobby ---
export const LOBBY_CONTINUE = {
  pickMode: 'pick',                    // SaveLoadView.openList({ mode }) – the row button returns the save
  pickFilter: 'mp',                    // SaveLoadView.openList({ filter }) – multiplayer saves only
  phases: ['send', 'receive', 'replay', 'sync'], // phases of lobby.onContinueProgress (i18n lobby.continue.phase.<phase>)
  dragMime: 'text/x-steelmen-seat',    // dataTransfer type of a seat dragged by its grip
  percent: 100,                        // ratio -> percent
  dragTimeoutMs: 30000,                // a seat drag that never reports its end (aborted, focus lost) is dropped after this long
  dragGuardEvents: ['blur', 'pointerup', 'pointercancel', 'dragend'], // window events that end a seat drag (not 'drop': the seat row handles it first)
};
// --- [A2-ui] end ---
// --- [A2-net] multiplayer saves / continue lobby (src/net/SaveTransfer.js, src/net/MpContinue.js, docs/notes/a2-net.md) ---
export const NET_CONTINUE = {
  topic: 'save',             // transport topic of the save transfer host → clients (lobby, before the start)
  syncTopic: 'cont',         // transport topic of the end-of-replay hash exchange (after the start, before the lockstep)
  chunkChars: 3000,          // base64 characters of the save per chunk message (+ framing stays < NET.maxMessageBytes)
  maxSaveBytes: 32 * 1024 * 1024, // a transfer announcing more (gzip bytes) is refused by the clients
  pumpMs: 100,               // sender: one send round this often…
  chunksPerPump: 3,          // …with at most this many chunk messages (room capability ≈ 40 messages/s per client)
  ackMs: 250,                // receiver: acknowledgement at most this often (and repeated while incomplete)
  maxMissingReported: 48,    // receiver: missing chunk indices listed in one acknowledgement
  stallMs: 20000,            // no progress of the transfer for this long (either side) = net.continue.error.timeout
  syncResendMs: 400,         // end-of-replay hash re-sent this often until every player's arrived
  syncLingerMs: 15000,       // …and still answered this long after this client finished (late players)
  stallOfferMs: 45000,       // load / replay / sync / lockstep stuck this long = the host is offered to end the match
  endRepeat: 4,              // the host's "match ended" notice is sent this many times…
  endRepeatMs: 250,          // …this far apart
  aiFallbackDifficulty: 'normal', // AI that takes over a seat of a human who did not come back (original AI: its own difficulty)
  passGapAcks: 2,            // sender: a new pass over the still missing chunks waits this many ack intervals
  maxKeyLength: 64,          // receiver: longest i18n key accepted from the host's "transfer given up" message
  maxIdLength: 64,           // receiver: longest transfer id accepted (the id is "<code>-<base36>")
  base64Block: 0x8000,       // bytes per String.fromCharCode call while encoding the save
  hashRadix: 16,             // textHash is written in this base
  maxHashWords: 8,           // sync hash message: most 32-bit words of the world hash a peer may send
};
// --- [A2-net] end ---
// --- [J1] save games ---
// Saved game = replay: match settings + seed + every non-AI command from tick 0 (src/game/SaveGame.js,
// src/core/SaveStore.js, docs/notes/j1-save-core.md). Loading checks SIM_VERSION and the data fingerprint, never GAME_VERSION.
// Raise SIM_VERSION with every change that alters the simulation (combat, balance code, AI decisions, command
// executors, determinism fixes); text / UI / visual-only releases keep it, so saves stay loadable.
export const SIM_VERSION = 6; // 6 = A9 (research T2/T3, super tier, Data network, new buildings / parts, vehicle tiers); 5 = A14 (terrain speed factor per chassis, weighted A*); 4 = A8 (ASCII map wall height 12.3 ± 12 % → line of sight / wall stops); 3 = A7 (crew morale bail-out, melee sweep vs wrecks, formation P2 march); 2 = A1 (simBody of structures, AI production / placement, chunked commands) after v28
export const SAVE = {
  format: 'steelmen-save',      // marker of a save object / .smsave file
  formatVersion: 1,             // layout of the save object (not the simulation)
  hashEveryTicks: 300,          // checkpoint (stateHash + subsystem hash + command hash) every this many ticks (10 s)
  autosaveSeconds: 300,         // default autosave interval in game time
  autosaveCheckMs: 1000,        // how often (real time) the autosave timer looks at world.tick
  minAutosaveTicks: 1800,       // autosaveNow does nothing before this tick (1 min): a short new match keeps the old autosave
  replayChunkMs: 40,            // restore: simulate this long (real time) between yields to the browser (progress, loads)
  replayWaitMs: 4,              // restore: pause while a tick waits for a model / tracked load (readyForTick)
  progressStartShare: 0.03,     // restore progress reported once the match is set up (the rest = replayed ticks)
  fileExtension: '.smsave',
  fileMime: 'application/x-steelmen-save',
  fileNameMax: 60,              // exported file name: save name cut to this length
  revokeUrlMs: 10000,           // exportFile: the download URL is released this long after the click (late downloads)
  dbName: 'steelMen.saves',     // IndexedDB database (one object store)
  dbStore: 'saves',
  dbVersion: 1,
  autoSlot: 'auto',             // id of the single autosave (put(save, {slot: 'auto'}) overwrites it)
  restoreSlot: '__restore',     // hidden record: a save to restore after a page reload (scheduleRestore)
  restoreFlagKey: 'steelMen.restorePending', // sessionStorage flag of scheduleRestore
  // Data files whose content changes the simulation: their canonical JSON goes into the fingerprint, together with
  // the map file of the match. explosions.json (visual only) is left out.
  fingerprintFiles: [
    './data/stats.json', './parts.json', './data/buildingStyles.json',
    './data/ai/difficulty.json', './data/ai/buildOrders.json', './data/ai/armies.json', './data/ai/defense.json',
    './data/ai/research.json',
  ],
};
// --- [J1] end ---

// --- [B1-W3] work effects of procedural trucks (build sparks, repair glints, harvest dust; visual only) ---
export const PROC_WORK_FX = {
  enabled: true,
  seed: 0x5eed1234,           // own PRNG of the effects (never world.rng)
  additiveCap: 768,           // pool size: sparks, repair glints, flashes (one Points for all trucks)
  normalCap: 768,             // pool size: dust, debris
  maxFrameDt: 0.1,            // s – longest render step the particles integrate (tab switch, breakpoints)
  minLevel: 0.05,             // work level (0..1) below which nothing is emitted
  minPointPx: 1,              // px – smallest drawn point
  minViewDepth: 0.1,          // units – view depth floor in the point-size formula
  pointRadiusNorm: 4,         // shader: squared distance from the sprite centre is scaled by this (circle edge at r = 0.5)
  fadeInShare: 0.1,           // share of the life a particle takes to fade in
  minFrameGap: 0.0001,        // s – two onBeforeRender calls closer than this belong to the same frame
  pointScaleFallback: 600,   // px scale used when the camera is not a perspective one
  repairColor: '#46f0c8',     // repair glints (green-blue); build sparks use the unit style weaponGlow
  repairCoreMix: 0.45,        // repair glint colour mixed toward white
  sparkCoreMix: 0.55,         // spark colour mixed toward white (hot core)
  dustColor: '#9a8a72',       // base dust colour
  dustAccentMix: 0.12,        // share of the style palette accent in the dust colour (stays style driven)
  debrisDarken: 0.45,         // debris = dust colour × this
  // Per kind (work kind of ProcDriver): list of emitters. rate = particles/s at level 1,
  // life/size/speed = [min, max], up = initial upward share, spread = horizontal speed, gravity (units/s², + = down),
  // drag = 1/s velocity damping, alpha = peak opacity, grow = size multiplier at death, group = 'add' | 'norm'.
  kinds: {
    build: [
      { id: 'spark', color: 'weapon', group: 'add', rate: 64, life: [0.2, 0.55], size: [0.05, 0.11], speed: [1.6, 4.2], up: 0.7, spread: 1, gravity: 7.5, drag: 0.8, alpha: 1, grow: 0.4, jitter: 0.06 },
      { id: 'flash', color: 'weapon', group: 'add', rate: 10, life: [0.05, 0.14], size: [0.35, 0.6], speed: [0, 0.2], up: 0, spread: 0.2, gravity: 0, drag: 0, alpha: 0.7, grow: 1.6, jitter: 0.04 },
    ],
    repair: [
      { id: 'glint', color: 'repair', group: 'add', rate: 30, life: [0.5, 1.1], size: [0.07, 0.14], speed: [0.2, 0.9], up: 1.1, spread: 0.55, gravity: -0.9, drag: 1.2, alpha: 0.9, grow: 0.3, jitter: 0.18 },
      { id: 'flash', color: 'repair', group: 'add', rate: 5, life: [0.1, 0.25], size: [0.3, 0.5], speed: [0, 0.1], up: 0, spread: 0.1, gravity: 0, drag: 0, alpha: 0.55, grow: 1.5, jitter: 0.05 },
    ],
    harvest: [
      { id: 'dust', color: 'dust', group: 'norm', rate: 34, life: [0.7, 1.5], size: [0.28, 0.5], speed: [0.6, 2.0], up: 0.45, spread: 1, gravity: -0.15, drag: 1.6, alpha: 0.5, grow: 2.6, jitter: 0.25 },
      { id: 'debris', color: 'debris', group: 'norm', rate: 12, life: [0.35, 0.8], size: [0.05, 0.1], speed: [1.5, 3.6], up: 1.2, spread: 1, gravity: 9, drag: 0.3, alpha: 1, grow: 0.8, jitter: 0.1 },
    ],
  },
};
// --- [B1-W3] end ---

// --- [A7] blood stains (src/game/BloodStains.js): decals where crew squads die, display only ---
export const BLOOD_STAINS = {
  enabled: true,                 // no gore setting in the options yet; false = nothing is drawn
  event: 'steelmen:crewDied',    // window CustomEvent dispatched by Crew on death, detail { crew }
  max: 96,                       // instances in the one InstancedMesh (the oldest stain is replaced when full)
  lifetime: 70,                  // seconds a stain stays (visual time), the last fadeTime of it fades out
  fadeTime: 15,
  alpha: 0.8,                    // peak opacity
  size: [2.2, 4.2],              // stain diameter, world units (random per stain)
  scatter: 1.6,                  // random offset from the member's place, world units
  perMember: 1,                  // stains per squad member
  heightOffset: 0.06,            // above the terrain (z-fighting)
  slopeOffset: 1.2,              // extra lift per unit of slope × radius (stain on a slope)
  normalStep: 0.8,               // sampling distance for the terrain normal
  polygonOffset: -2,             // factor and units of the material's polygon offset
  renderOrder: 1,
  color: '#7d0f0f',
  sizeHalf: 0.5,                 // half of the stain size: radius used for the slope lift
  // canvas texture (own fixed PRNG: same look every run); radii / distances are shares of the texture size
  texture: {
    size: 128, blobs: 7, droplets: 14, seed: 90817,
    mainRadius: 0.3, mainAlpha: 1,
    blobSpread: 0.2, blobRadius: [0.08, 0.2], blobAlpha: 0.9,
    dropletDistance: [0.25, 0.47], dropletRadius: [0.02, 0.06], dropletAlpha: 0.95,
    gradientMid: 0.6, gradientMidAlpha: 0.8, // soft edge: colour stop and its alpha share
  },
};
// --- [A7] end ---

// --- [B5-muzzles] procedural muzzle fit (debug probe src/procedural/debug/MuzzleProbe.js) ---
export const PROC_MUZZLE = {
  probeRaces: ['X', 'Y', 'Z', 'W'],  // styles the probe builds (W shows modelRace X)
  tolerance: 0.1,                    // world units – max distance model socket ↔ stats simBody muzzle
  teamColor: 0x3a7bd5,               // paint of the probe models (never shown)
  digits: 3,                         // decimals in the printed table
  // Build-time fit of a procedural vehicle's main weapon to its stats simBody muzzle (src/procedural/units/MuzzleFit.js,
  // UnitModules turret() / weapon()). Budgets in MODEL units keep the model's look: what is left over stays a deviation
  // (docs/notes/b5-muzzles.md lists those exceptions with proposed data values)
  fit: {
    enabled: true,
    aircraft: false,       // jets / bombers: the default sim muzzle (radius ahead) is the wing span, not a gun – no fit
    stretch: [0.7, 1.6],   // barrel length factor range (cannon / gun / laser / plasma / lightning)
    lift: 0.3,             // max trunnion shift up / down
    slide: 0.4,            // max weapon shift along the barrel (rest after stretching; the only z fit of missile pods)
    pivotShift: 0.6,       // max turret shift along the hull (simBody.muzzle.pivotZ only)
  },
  // Wall turrets (WallTurretProc) fitted to stats simBody.muzzles (byRace): barrels move inside the head (up to its half
  // height − barrel radius), a rest of the height is taken by the pedestal (± share of its height), length × stretch,
  // barrel x towards the data (± xShift, GLB model units); fewer data muzzles than barrels → one barrel per data muzzle
  wall: { stretch: [0.7, 1.6], xShift: 0.3, pedestalShare: 0.4 },
};
// --- [B5-muzzles] end ---

// --- [B5-map-fx] procedural map materials (src/procedural/maps/MapMaterials.js, docs/notes/b5-map-fx.md) ---
// Visual only (own seeded noise, no world.rng). Dark stone walls + glowing lava in fissures for the A8 map restyle.
export const PROC_MAP_FX = {
  mechHeight: 8.2,               // world units – height of a procedural mech (stats simBody.bodyHeight 7.8–8.7), reference for walls
  wallHeightFactor: 1.5,         // default wall height = mechHeight × this
  stone: {
    textureSize: 256,            // px (square), tileable; colour + normal + roughness
    tileWorld: 6,                // world units one texture tile covers (blocks ≈ tileWorld / blockRows tall)
    blockRows: 4,                // block courses per tile
    blocksPerRow: [2, 3],        // block count range per course
    mortarWidth: 0.045,          // share of a course height
    bevel: 0.18,                 // share of a block's size over which the edge rounds off
    noiseAmount: 0.35,           // fine height / colour noise
    normalStrength: 3.2,
    colorDark: '#1f2024', colorLight: '#3b3c42', colorTint: '#2c2a2f', // block colours range (dark basalt)
    roughness: [0.78, 1.0],
    anisotropy: 4,
    seed: 7301,
    wallSegmentLength: 4,        // geometry subdivision along a wall (jagged top / crack lines)
    jag: 0.06,                   // top edge unevenness, share of the wall height
    metalness: 0.05,
    noisePeriods: [8, 16, 32, 64],  // lattice sizes of the tileable noise octaves
    blockWidthJitter: [0.6, 1.4],   // relative block width range inside a course
    colorMix: { shade: 0.8, fine: 0.2, tint: 0.4 },  // block colour: dark→light by shade+fine noise, tint share
    mortarDim: 0.45, mortarHeight: 0.1,              // colour multiplier where height < mortarHeight
    crackDepth: 0.18, crackWidth: 0.025, crackDim: 0.35, // dark crack lines (second noise near 0.5)
    roughFromHeight: 0.6,           // roughness: share from (1 − height), rest from fine noise
  },
  lava: {
    layerMix: [0.6, 0.4], warpMix: [0.65, 0.35],     // shader: weights of the two noise layers (a, b)
    layerScale: { a2: 2.1, b1: 1.7, b2: 3.9 }, driftScale: { a2: 1.7, b2: 0.6 }, // octave scales / relative drift speeds
    heatRange: [0.35, 1.0],         // smoothstep range where mid → hot colour
    seedScale: 0.731, seedMod: 1000, // noise offset = (seed % seedMod) × seedScale
    colorHot: '#ffd060', colorMid: '#ff6a10', colorCrust: '#1a0804',
    noiseScale: 0.11,            // noise cells per world unit
    flowSpeed: [0.18, 0.07],     // noise drift (units of noise space per second) x / z
    warp: 0.7,                   // domain warp of the flow
    crustLow: 0.5, crustHigh: 0.66, // smoothstep range of the dark crust over the noise value
    pulseAmount: 0.22, pulseSpeed: 1.3,
    intensity: 1.6,              // emissive multiplier (>1 = bright over tone mapping)
    edgeCrust: 0.3,              // ribbon geometry: crust grows towards the ribbon edges (0 = off)
    seed: 4417,
    timeWrap: 4096,              // seconds after which the time uniform wraps
  },
  rim: {
    color: '#ff5a10', intensity: 1.4, falloff: 2.0, pulseAmount: 0.25, pulseSpeed: 0.9, waveScale: 0.15, // waveScale: pulse phase per world unit
    polygonOffset: -2,           // factor and units
  },
  ribbon: { lift: 0.05, minSegments: 1 }, // createLavaRibbonGeometry: height above y 0, extra subdivision
};
// --- [B5-map-fx] end ---

// --- [B4] model budget (src/procedural/debug/ModelBudget.js, docs/notes/b4-budget-tool.md) ---
// Limits of the triangle / draw call budget of every model the game can draw (target 60 FPS on a GTX 1650). Read by the
// console measuring tool only (never by the game); `unitTri` / `robotTri` / `crewTri` count the LOD0 model, buildings the batched LODs.
export const PROC_BUDGET = {
  unitTri: 2000,            // vehicle, LOD0 (skinned model close to the camera)
  robotTri: 2500,           // robot, LOD0 – heaviest part combination per style
  crewTri: 800,             // crew member, LOD0
  buildingDrawCalls: 12,    // building, LOD1 and coarser: draw calls of one building (static body + emblem + frozen far parts)
  buildingTri: 20000,       // building, LOD0: informative only (a row over it is marked "info", not counted in overLimit)
  lodLevels: [1, 2],        // far LOD levels of units / crew / robots that are measured (0 = the skinned LOD0 model)
  teamColor: '#3a5ccc',     // team colour the measured models are built with
  styles: null,             // style keys to measure; null = every style of data/buildingStyles.json that is also a race of stats.json
  percentile: 0.9,          // suggested buildingTri = this percentile of the measured LOD0 building triangle counts
  yieldEvery: 12,           // models measured between two yields to the event loop (the console stays responsive)
};
// --- [B4] end ---

// --- [A5] UI scaling below full HD (docs/roadmap/13-ui-scaling.md, docs/blocks/A5.md) ---
// Detail levels of the HUD by window height (CSS px, innerHeight): class on #hud-root, also used by menu / lobby / dialog CSS
// as the same breakpoints (@media cannot read var(), so CSS repeats these values with a "= UI_SCALE.…" comment).
export const UI_SCALE = {
  scaleMin: 0.7,               // replaces HUD_V2.scaleMin when the compact level is on (Hud.js #applyScale)
  breakpoints: {               // window height (CSS px): below `compact` → .hud-compact, below `tiny` → .hud-tiny
    compact: 800,
    tiny: 650,
    hysteresis: 20,            // a level is left only when the height is this much past the breakpoint (no flicker)
  },
  narrowWidth: 1100,           // window width (CSS px) below which the HUD is at least compact (4:3, narrow windows)
  fontMain: 12,                // px floor for main numbers (resources, HP)
  fontSmall: 11,               // px floor for small text (labels, hints)
  hitTarget: 32,               // px floor of a clickable target (padding grows, not the image)
  dialogFont: 14,              // px font of tooltips and dialogs (not scaled)
  userScales: ['auto', '0.75', '1', '1.25'], // settings.ui.hudScale (strings: Profile keeps only the default's type): 'auto' or a multiplier over the automatic scale
  userScaleDefault: 'auto',
  // One-time "turn on full screen" offer (c8): when not in fullscreen and the window is smaller than this
  fullscreenOffer: { width: 1280, height: 720 },
};
SETTINGS_DEFAULTS.ui.hudScale = UI_SCALE.userScaleDefault;  // Profile.js only keeps keys that exist in the defaults
SETTINGS_DEFAULTS.ui.fullscreenOffered = false;            // the c8 offer was shown once (never again)
// --- [A5] end ---

// --- [B3] superweapon effects (src/procedural/fx/SuperweaponFx.js) ---
// Visual only. Colours are data keyed by race code ('default' fallback); the code never names a faction.
export const PROC_SUPERWEAPON_FX = {
  maxEffects: 8,               // simultaneously running launch/impact effects (extra ones are dropped)
  pools: { glow: 900, smoke: 600, debris: 160 }, // particle capacity per batched InstancedMesh
  sphereDetail: [0, 1, 0],     // IcosahedronGeometry detail of the glow / smoke / debris particle spheres
  segments: 16,                // radial segments of cylinders / rings / domes
  sphereRows: 8,               // height segments of the shared shape sphere
  rim: { centerLevel: 0.1, power: 2.2 }, // fresnel of domes: centre brightness (0..1) and rim sharpness (volume instead of a flat disc)
  renderOrder: 12,             // after VFX.renderOrder (units, normal explosions)
  gravity: 26,                 // world units / s^2 for debris
  drag: 0.6,                   // particle velocity damping per second
  glowFadePower: 1.6,
  smokeFadeStart: 0.55,        // age ratio where smoke starts shrinking
  smokeOpacity: 0.62,
  debrisOpacity: 1,
  // Colours per race: core (white-hot), glow (main), accent (secondary), smoke, dust (ground)
  colors: {
    default: { core: 0xffffff, glow: 0xffa040, accent: 0xff5a20, smoke: 0x2a2724, dust: 0x6b5a45 },
    X: { core: 0xffffff, glow: 0xffc860, accent: 0xff7a20, smoke: 0x2b2824, dust: 0x75603f },
    W: { core: 0xffffff, glow: 0xffd23a, accent: 0xe8a010, smoke: 0x2b2824, dust: 0x75603f }, // amber glow
    Y: { core: 0xf0ffff, glow: 0x70e0ff, accent: 0x2a8cff, smoke: 0x1f2a30, dust: 0x4f6068 },
    Z: { core: 0xfff0f0, glow: 0xff6a50, accent: 0xc01818, smoke: 0x2a1c1a, dust: 0x6a4a40 },
  },
  phaseColors: { core: 0xf4eaff, glow: 0x9a6bff, accent: 0x3c6bff }, // phaseCharge is always blue-violet
  neutronColors: { core: 0xffffff, glow: 0xe8f2ff, accent: 0xbcd8ff }, // neutronBomb is always white
  orbital: {
    skyHeight: 520,            // where the targeting beam / bomb starts above the target
    beamRadius: 0.9,           // thin targeting beam radius
    beamPulse: 7,              // pulses per second of the targeting beam
    headSize: 7,               // bright falling head
    columnRadiusFactor: 0.34,  // impact column radius / blast radius
    columnHeightFactor: 14,    // impact column height / blast radius
    columnLife: 1.0,
    columnBrightness: 0.4,     // impact column brightness (was overexposed at 1)
    columnFadePower: 3,
    flashLife: 0.7,
    flashSizeFactor: 0.9,
    waveLife: 1.6,
    waveSizeFactor: 1.15,
    smoke: 150, sparks: 120, debris: 36,
    smokeLife: [3.5, 6], smokeSize: [0.1, 0.34], smokeSpeed: [0.15, 0.7], smokeRise: [6, 20],
    smokeSpread: 0.25, smokeDrag: 1.2,   // smoke start spread (x R) and velocity damping
    spark: { speedMin: 8, speedRMax: 1.1, upMin: 6, upRMax: 1.3, life: [0.7, 1.7], size: 0.12, sizeEnd: 0.02, gravityShare: 0.5, spread: 2 }, // size x R
    debrisFx: { speedMin: 10, speedRMax: 1.3, up: [16, 60], life: [1.6, 3.2], size: 0.6, sizeEnd: 0.5, drag: 0.15, spread: 4 },
    beamParticleRate: 90, beamRampMin: 0.2, beamWidthGrow: 0.6, markerRingShrink: 0.15, markerBrightness: 0.6, headStretch: 1.6,
    headParticle: { jitter: 2, height: 20, rise: 20, life: 0.5, size: 2.4, sizeEnd: 0.2 },
    columnGrow: 0.6, columnGlowWidth: 1.8, columnGlowShare: 0.5,
    flashMin: 0.35, flashLift: 0.3, flashHaloSize: 1.5, flashHaloShare: 0.45,
    waveDomeHeight: 0.35, waveDomeWidth: 0.8, waveDomeShare: 0.25, waveLift: 0.5,
  },
  tectonic: {
    crackCount: 28,            // dust/crack puffs per second of flight (scaled by distance)
    crackPerUnit: 0.9,         // + puffs per world unit of path
    crackSize: [1.6, 4.2],
    crackLife: [1.6, 3.2],
    glowSize: 1.4,             // glowing fissure head
    eruptSmoke: 130, eruptDebris: 70, eruptSparks: 60,
    columnLife: 1.8,
    columnRadiusFactor: 0.3,
    columnHeightFactor: 0.9,
    ringLife: 1.4,
    ringSizeFactor: 1.05,
    debrisSpeed: [20, 52], debrisUp: [26, 60], debrisSize: [0.5, 1.7],
    smokeSpread: 0.3, smokeDrag: 0.9, smokeSpeed: [0.1, 0.55], smokeRise: [10, 1.4], // speed x R; rise: min, max x R
    debrisLife: [2, 4.5], debrisDrag: 0.1, debrisSpread: 0.25,
    spark: { speedMin: 4, speedRMax: 0.6, upMin: 20, upRMax: 1.4, life: [0.8, 1.8], size: 0.09, sizeEnd: 0.02, gravityShare: 0.6, spread: 0.2 },
    fissurePulseHz: 18, fissureBase: 0.35, fissureAmp: 0.4, fissureRadius: 0.55, fissureLift: 0.2,
    crackDust: { speedMin: 2, speedRange: 5, rise: 2, riseRange: 6, jitter: 3, lift: 0.6, drag: 1.3, tintMin: 0.7, tintRange: 0.3, trailBack: 0.02 },
    crackSpark: { chance: 0.5, speedShare: 0.4, rise: 3, riseRange: 5, life: 0.5, lifeRange: 0.5, size: 0.9, sizeEnd: 0.1, lift: 0.4 },
    columnRise: 0.35, columnGrow: 0.6, columnGlowShare: 0.8, capSize: 1.1, capHeight: 0.6, ringLift: 0.4, ringDustBoost: 1.4, innerRing: 0.6, innerRingShare: 0.6,
    smokeLife: [3, 6], smokeSize: [0.1, 0.3],
  },
  phase: {
    arcHeight: 0.22,           // arc apex height / horizontal distance
    arcMin: 40,
    ballSize: 3.2,
    trailRate: 60,             // trail sparks per second
    trailLife: 0.7,
    flashLife: 0.55,
    flashSizeFactor: 0.6,
    implodeLife: 1.1,          // sphere shrinks to a point (starts big, collapses)
    implodeSizeFactor: 1.0,
    ringLife: 1.6,
    ringSizeFactor: 1.1,
    sparks: 140, smoke: 40,
    ballPulseHz: 30, ballPulseAmp: 0.15, ballHaloSize: 1.8, ballHaloShare: 0.5,
    trailSpeed: 1, trailSpeedRange: 3, trailUp: 0.3, trailSizeShare: 0.7, trailSizeEnd: 0.1, trailDrag: 1.5, trailLifeJitter: 0.6, trailLifeRange: 0.8,
    flashLift: 4, flashMin: 0.4, flashHaloSize: 1.6, flashHaloShare: 0.4,
    implodeShrink: 0.98, implodeMin: 0.5, implodeLift: 0.3, implodeBrightMin: 0.35, implodeShellShare: 0.8, implodeCoreSize: 0.55,
    burst: { speedMin: 6, speedRMax: 1.3, upRMin: -0.2, upRMax: 0.7, life: [0.6, 1.5], size: 0.08, sizeEnd: 0.01, spread: 1 },
    puff: { speedMin: 2, speedRMax: 0.3, upMin: 1, upMax: 8, life: [2, 3.5], size: 0.1, sizeEnd: 0.25, spread: 0.2 },
    ringLift: 0.5, ringWallHeight: 0.6, ringGlowShare: 0.25, ringDomeWidth: 0.7, ringDomeHeight: 0.5, ringDomeShare: 0.18,
  },
  neutron: {
    riseFraction: 0.3,         // share of the flight time spent climbing straight up
    turnFraction: 0.2,         // share spent turning over at the apex
    apexHeight: 260,
    bodyLength: 9, bodyRadius: 0.9,
    trailRate: 80, trailLife: 0.9,
    flashLife: 0.5,
    flashSizeFactor: 1.0,
    domeLife: 1.6,
    domeSizeFactor: 1.0,
    haloLife: 0.9,
    sparks: 60,
    spark: { speedMin: 6, speedRMax: 0.9, upMin: 2, upRMax: 0.6, life: [0.8, 1.6], size: 0.08, sizeEnd: 0.02, spread: 0.1 },
    bodyHalf: 0.5, noseSize: 2.4, noseShare: 0.9, apexDescent: 0.7, turnLift: 0.25,
    trailSpeed: 2, trailSpeedRange: 4, trailBack: 8, trailLifeJitter: 0.6, trailLifeRange: 0.8, trailSize: 2.8, trailSizeEnd: 0.2, trailDrag: 1.4,
    smokeChance: 0.4, smokeSpeedShare: 0.3, smokeLifeMul: 2, smokeSize: 2, smokeSizeEnd: 5, smokeColor: [0.85, 0.88, 0.92],
    flashLift: 0.2, flashMin: 0.5, flashScale: 1.2, domeInnerScale: 0.82, domeShare: 0.85, domeInnerShare: 0.5, haloScale: 1.2, haloLift: 0.4,
  },
  demo: { spacing: 120, flightTime: 3.2, radius: 30 },
};
// --- [B3] end ---
