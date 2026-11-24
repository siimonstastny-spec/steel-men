// Steel Men – multiplayer entry point (docs/MULTIPLAYER.md). main.js / MainMenu / LobbyScreen import from here:
//   import * as mp from './net/index.js'   →   mp.createTransport(), new mp.Lobby(t), new mp.Lockstep({...})
// Start barrier [W6]: after loading the match call `await net.waitForPlayers({ onProgress })` (topic 'ready'), then net.start()
// The self-test is loaded on demand: (await import('./src/net/selftest.js')).runNetSelftest()
export { createTransport, RoomTransport, BroadcastTransport, P2PTransport } from './transports/index.js';
export { Lobby, normalizeCode, roomName } from './Lobby.js';
export { Lockstep } from './Lockstep.js';
