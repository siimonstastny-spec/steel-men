// Steel Mans – konfigurace modelů a socketů – SIT

export const MODELS_BASE = './models/';

// How model files are served: 'glb' = plain .glb files (local server); 'base64' = each model as
// <name>.glb.txt with base64 content (claude.ai artifact build – artifacts do not serve .glb).
// tools/build-artifact.ps1 switches this to 'base64' in its dist/ copy; keep 'glb' here.
export const MODEL_ENCODING = 'glb';

// Version label on the main menu ("test version v22"): the artifact version it is published as.
// Raise it before every artifact publish (docs/HANDOFF.md, "Artefakt").
export const GAME_VERSION = 'v22.1';
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
    color: 0x6b7350,
    colorHigh: 0x7d7a5a,     // tint of the hill tops
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
  maxCommandBytes: 1024,     // a bigger local command is refused (never sent, never executed)
  maxChunksPerSend: 4,       // a backlog of unacknowledged turns goes out in at most this many messages at once
  resendMs: 200,             // nothing sent for this long (stalled / waiting): resend the unacknowledged turns + acks
  maxTurnsAhead: 64,         // a received turn this far beyond the executed one is ignored (garbage / old match)
  pingSmoothing: 0.2,        // exponential smoothing of the measured round trip (0..1, higher = faster reaction)
  hiddenPumpMs: 100,         // hidden tab (no animation frames): main.js runs due ticks on this timer (browsers may slow it to 1 s)
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
  broadcastPrefix: 'steel-mans-net-',
  broadcastHeartbeatMs: 1000, // presence re-sent this often
  broadcastPeerTimeoutMs: 4000, // a tab silent for this long has left
  // Embedding in a foreign page (src/input/EmbedGuard.js, itch.io iframe): keys that would scroll the host page
  embedScrollKeys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End'],
  // P2PTransport (static web: WebRTC, signalling over public Nostr relays; vendor/trystero, docs/notes/p2p-transport.md)
  p2p: {
    appId: 'steel-mans-rts-v1',  // Trystero namespace; change it when the wire format breaks (old clients never meet)
    strategy: 'nostr',           // signalling strategy vendored in vendor/trystero/ (only 'nostr' is shipped)
    // wss:// signalling relays. Trystero's own default list is a random set of obscure relays (many dead), so we pin
    // well-known public ones; empty = Trystero's default list. Verify with relayCheck.js (docs/notes/g-web-iframe.md).
    relayUrls: [
      'wss://nostr.oxtr.dev',
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://offchain.pub',
      'wss://nostr.mom',
      'wss://relay.snort.social',
    ],
    relayRedundancy: 5,          // relays used at once from the default list
    warnOnRelayFailure: false,   // Trystero console warnings about single relays (noisy; one dead relay is normal)
    relayTimeoutMs: 10000,       // join(): no relay socket open by then = P2PError net.p2p.error.relays
    relayPollMs: 100,            // how often join() checks the relay sockets
    handshakeTimeoutMs: 10000,   // Trystero peer handshake after the data channel opened
    lobbyJoinTimeoutMs: 25000,   // transport.joinTimeoutMs hint: finding the host over relays + WebRTC takes 2–15 s
    stunUrls: [                  // public STUN (address discovery only, no traffic goes through them)
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ],
    turnServers: [],             // optional TURN relays {urls, username, credential} for strict NAT (none yet)
    topics: ['lobby', 'turn', 'hash', 'start'], // receivers registered as soon as a room is joined
    relayCheckTimeoutMs: 5000,   // relayCheck.js: a relay not answering a subscription (EOSE) by then counts as dead
    relayCheckKind: 20078,       // relayCheck.js: ephemeral event kind in the test subscription (any valid kind works)
  },
};
// --- [NET] end ---
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
  placement: { minRadius: 30, step: 8, maxRadius: 220, angles: 24, gap: 7, frontConeDot: 0.5, frontClearFrom: 40, defenseSearchRadius: 40, passRadius: 5 },
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
  { color: '#d6b21e' },
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
  deleteUnit: ['Delete'],     // destroy the selected own units (mech explodes, crew evacuates)
  stanceRanged: ['KeyR'],
  stanceMelee: ['KeyF'],
  behaviourAggressive: ['KeyJ'], // behaviour of idle units (BEHAVIOUR): mechs only
  behaviourDefensive: ['KeyK'],  // mechs and crews
  behaviourPassive: ['KeyL'],    // mechs and crews
  repair: ['KeyO'],              // start field repair / stop it while repairing
  rotateBuilding: ['KeyT'],      // while placing a building: turn it by PLACEMENT.rotateStep (Shift = the other way)
  idleCrew: [],                  // select the next idle crew + centre the camera (no default key – set in Settings → Controls)
  idleBuilder: [],               // same for idle builder vehicles
  fullscreen: [],                // toggle browser fullscreen (no default key – set in Settings → Controls)
  diplomacy: ['KeyU'],           // [B4] open / close the diplomacy menu (src/ui/DiplomacyView.js)
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
  // Once the path has ended (≤ pathEndReach left), the crew boards when the mech's EDGE (centre − radius) is
  // within boardRange + edgeBuffer (≈ one nav cell, PATHFINDING.cellSize).
  board: {
    pathEndReach: 3,         // units – path length left that counts as "the walk is over"
    edgeBuffer: 7,           // units – extra reach over boardRange, measured from the mech's edge
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
    maxLife: 30,             // s – safety limit for a projectile that never arrives
    segments: [10, 8],       // sphere width / height segments
    shapes: { orb: { stretch: 1 }, shell: { stretch: 1.8 }, missile: { stretch: 3.2 } },
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
  storageKey: 'steelMans.newGame',  // localStorage key of the last new-game choice
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
  storageKey: 'steelMans.profile',
  legacyKeys: ['steelMans.newGame'], // older keys migrated into the profile (last new-game choice)
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

/** Defaults of the player settings saved in the profile (see Settings screen) */
export const SETTINGS_DEFAULTS = {
  language: null,                 // null = detect from the browser the first time
  nickname: '',                   // empty = UI shows the translated "Player"
  keybindings: {},                // action -> list of KeyboardEvent.code, only the remapped ones
  mouse: { rotateSensitivity: 1, zoomSensitivity: 1, panSensitivity: 1, invertRotate: false, invertZoom: false, invertPan: false },
  audio: { master: 0.8, effects: 1, music: 0.6 },
  graphics: { quality: 'full' },  // 'full' | 'reduced' (see GRAPHICS)
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
  qualities: ['full', 'reduced'],
  presets: {
    full: { pixelRatioCap: 2, pixelRatioScale: 1, shadows: true, shadowMapSize: 2048, shadowType: 'PCFSoftShadowMap', antialiasHint: true },
    // reduced = render at a lower resolution (downscale) and cheaper, smaller shadows
    reduced: { pixelRatioCap: 1, pixelRatioScale: 0.6, shadows: true, shadowMapSize: 512, shadowType: 'BasicShadowMap', antialiasHint: false },
  },
  minPixelRatio: 0.4,
};

/** Remappable actions shown in Settings → Controls (order = display order). Camera keys are fixed to camera actions. */
export const KEY_ACTIONS = {
  camera: ['cameraForward', 'cameraBack', 'cameraLeft', 'cameraRight'],
  commands: ['eject', 'dropLeft', 'dropRight', 'attackMove', 'guard', 'patrol', 'cancel', 'move', 'stop', 'deleteUnit', 'stanceRanged', 'stanceMelee',
    'behaviourAggressive', 'behaviourDefensive', 'behaviourPassive', 'repair', 'rotateBuilding',
    'idleCrew', 'idleBuilder', 'fullscreen', 'diplomacy'],
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

/** Sound hook (src/audio/Sound.js). eventName -> file (relative to sounds/); empty = silent. */
export const AUDIO = {
  basePath: 'sounds/',
  maxDistance: 250,        // units – sounds farther from the camera are silent (positional events)
  falloffExponent: 1.5,
  // Sound event of each kind of shot (Combat.js): keys of `events`
  shotEvents: { melee: 'meleeHit', energy: 'shotLaser', projectile: 'shotCannon', hitscan: 'shotRifle' },
  // eventName -> file. Empty = no sound, nothing is loaded (no sound files exist yet).
  // Planned files: ui/click.ogg, weapons/rifle.ogg, weapons/cannon.ogg, weapons/laser.ogg, fx/explosion.ogg,
  // weapons/melee.ogg, fx/arm_drop.ogg, fx/mech_destroyed.ogg, ui/order.ogg, fx/crew_board.ogg
  events: {
    uiClick: '',
    shotRifle: '',
    shotCannon: '',
    shotLaser: '',
    explosion: '',
    meleeHit: '',
    armDropped: '',
    mechDestroyed: '',
    orderAck: '',
    crewBoard: '',
  },
  categories: { uiClick: 'effects', orderAck: 'effects' }, // everything not listed here is 'effects'; music goes through playMusic
  musicTracks: { menu: '', game: '' }, // empty = no music (planned: music/menu.ogg, music/game.ogg)
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
  // Command grid (bottom left): command name per slot, row by row; null = empty slot
  commandGrid: {
    columns: 4,
    layout: [
      // eject / dropLeft / dropRight are not in the grid any more: robot panel EJECT buttons + KEYBINDINGS (eject = E,
      // dropLeft / dropRight have no default key, the player binds them in Settings → Controls)
      'move', 'attackMove', 'guard', 'patrol',
      'stop', 'stanceRanged', 'stanceMelee', 'repairUnit',
      'deleteUnit', 'behaviourAggressive', 'behaviourDefensive', 'behaviourPassive',
      'repair',
    ],
  },
  // Command icons (text glyphs – replace with images later)
  commandIcons: {
    move: '➜', attackMove: '⚔', guard: '🛡', patrol: '⇄', stop: '■', stanceRanged: '◎', stanceMelee: '✊',
    deleteUnit: '✖',
    behaviourAggressive: '🔥', behaviourDefensive: '⛨', behaviourPassive: '☮', repair: '🔧', stopRepair: '⏹',
    repairUnit: '🛠',
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
  scaleMin: 0.8,             // --hud-scale = clamp(min(W / baseWidth, H / baseHeight), scaleMin, scaleMax)
  scaleMax: 1.25,
  // Margin of the frame artwork per side up to its SOLID metal edge (base px, alpha > 200 measured in the hud2 frame pieces:
  // left tl 13 / sl 13 / bl 14 / deco 13, right tr 13 / sr 13 / br 13, top tl 11 / ta 12 / tc 11 / tb 12 / tr 11, bottom
  // bl 20 / bm 20 / br 20; the faint outer glow at alpha 40 reaches 8–10 px further and gets cropped). The HUD root is pushed
  // out by it so the solid edge lies on the screen edge; --hud-scale is computed from the extended area:
  // W / (baseWidth − left − right), H / (baseHeight − top − bottom).
  frameBleed: { left: 13, right: 13, top: 11, bottom: 20 }, // [css] --hud-ml / -mr / -mt / -mb
  frameBackdrop: 14,         // [css] black strip under the frame along the 4 screen edges: this much (base px) beyond the bleed (rounded corners, gaps)
  idleButtonScale: 0.8,      // [css] size of the idle crew / idle builder buttons relative to their frame slot (--hud-idle-scale)
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
  energyCaps: [200, 400, 600, 800, 1000], // new-game choice of the energy storage cap (world.settings.economy.energyCap)
  defaultEnergyCap: 400,
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
  // Test scene only (TEST_SCENE.structures)
  robotPartFactory: { forward: -75, side: -70 },
  robotAssemblyBay: { forward: -75, side: 70 },
};

/**
 * Test scene (main.js): extra finished buildings the player gets at the start so robot production can be tried
 * at once (part factory + assembly bay). Empty list = a normal start (rules.economy.startUnits only).
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
  validColor: 0x4cc38a,
  invalidColor: 0xd63c2f,
  opacity: 0.45,
  mapMargin: 15,             // units – buildings stay this far inside the map edge
  depositClearance: 14,      // units kept free around ore deposits (and the super node platform) for the DrillTrucks
  rotateStep: Math.PI / 2,   // rad per press of KEYBINDINGS.rotateBuilding (snapped to STRUCTURE.yawStep)
  // Drag to rotate: press the left button on the spot (pins the building), drag sideways, release = place it
  dragRotateThreshold: 12,   // px of horizontal drag before the building starts turning (a plain click just places it)
  dragRotatePixels: 60,      // px of further drag per rotateStep
  dragRotateDirection: -1,   // 1 / -1: which way a drag to the right turns the building (-1 = clockwise from above)
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
  partLostEvent: 'steelmans:partLost',
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
  mineCursor: 'copy',        // CSS cursor over an ore deposit while a harvester is selected (CommandInput)
  cargoRestFactor: 1,        // a part carried by a vehicle rests with its lowest point at this fraction of the vehicle height
  minimapMarkScale: 1.25,    // minimap unit / building markers: 1.25 = 25 % larger (Minimap.js)
};
// --- [N2UI] end ---

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
export const MAPS = {
  list: [
    { id: 'gen_01AI', file: 'basic' },
    { id: 'Map02', file: 'map02' },
    { id: 'Map03', file: 'map03' },
  ],
  aliases: { basic: 'gen_01AI' },
  defaultMap: 'gen_01AI',
  ascii: {
    cellSize: 7,               // units per character (current map 900 units ≈ 130 characters)
    chars: { wall: '#', grass: '?', concrete: '.', start: 'S', field: 'o', fieldCore: '+', rift: '-' },
    padChar: '#',              // short rows / non-square grids are padded with this
    wallHeight: 18,            // units – height of '#' blocks
    wallHeightJitter: 0.25,    // ± share of wallHeight per block (fixed per map, visual only)
    riftDepth: 6,              // units the terrain sinks under '-' cells (visual; ground units cannot enter)
    // Ground tint per cell type, mixed into the terrain colour by tintStrength
    colors: { grass: 0x5f6e44, concrete: 0x8b8a83, field: 0x6f6447, fieldCore: 0x7d613c, rift: 0x1d1b19, wall: 0x4f4a42 },
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
  },
};
// --- [MAPS] end ---

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
