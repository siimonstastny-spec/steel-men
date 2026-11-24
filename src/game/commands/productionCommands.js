// Steel Men – production, research and bay service commands (executed by world.production, src/game/Production.js).
// Import this module once (BuildMenu.js / main.js) so the commands register. Every command carries `team`;
// buildings are referenced by eid. Schemas:
//   { type: 'queueUnit',        team, producer, kind: 'vehicle'|'crew', unitId? }   unitId = vehicle id (kind 'vehicle')
//   { type: 'queuePart',        team, producer, slot, path }                          slot = PART_SLOTS ('legs' | 'torso' | 'arm'),
//                                                                                     path = parts.json model (an arm of either side = "arm of this type")
//   { type: 'queueMech',        team, producer, loadout: { legs, torso, leftArm, rightArm } }  parts from the stock: leftArm / rightArm are the
//                                                                                     left / right model of ANY stocked arm type (both sides may use the
//                                                                                     same type if 2 are in stock), arms may be null
//   (serviceSwap below: slot stays 'leftArm' | 'rightArm', path = model of that side; the stock entry is shared)
//   { type: 'queueResearch',    team, producer, researchId }
//   { type: 'queueAnalysis',    team, producer, lootKey }                             lootKey = Research.analyses(team)[i].key
//   { type: 'cancelProduction', team, itemId }                                        refund rules.production.cancelRefund
//   { type: 'setAssemblyDraft', team, bay, on }                                       parts being chosen: no service entry
//   { type: 'serviceRepair',    team, bay }
//   { type: 'serviceSwap',      team, bay, slot, path }                               path null = remove the arm
//   { type: 'serviceCancel',    team, bay }
//   { type: 'serviceRelease',   team, bay }
//   { type: 'setRally',         team, structure, points: [{x, z}], append? }             [R4] rally chain of a unit-producing building
//                                                                                     (append = Shift: add to the chain; points [] clears it)
//   { type: 'setSpawnStance',   team, structure, mode }                                  [R4] mode 'aggressive'|'defensive'|'passive'|null
//   New units get the stance and walk the chain when they appear (Production, deterministic in the tick).
//   { type: 'releaseBayCrew',   team, bay }                                              [N2] crews waiting in the bay walk out (BayCrew.js)
// Before submitting, world.production.check(cmd) tells whether it would run ({ ok, reason, cost, supply }).
import { registerCommand } from './CommandBus.js';

const TYPES = [
  'queueUnit', 'queuePart', 'queueMech', 'queueResearch', 'queueAnalysis', 'cancelProduction',
  'setAssemblyDraft', 'serviceRepair', 'serviceSwap', 'serviceCancel', 'serviceRelease',
  'setRally', 'setSpawnStance', 'releaseBayCrew',
];

for (const type of TYPES) {
  registerCommand(type, {
    validate: (world, cmd) => Boolean(world.production?.check(cmd).ok),
    execute: (world, cmd) => { world.production.apply(cmd); },
  });
}

export const PRODUCTION_COMMANDS = TYPES;
