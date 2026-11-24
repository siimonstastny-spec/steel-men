// Steel Men – display identities of the players of the running match (docs/notes/n6-ainames.md).
// main.js fills the table once per match; the HUD, the match screens and the stats read it. A computer player has a
// call sign and an avatar index; the local human and remote humans have no avatar and use their nickname elsewhere,
// so for them `playerLabel` returns '' and the caller falls back to its own text.
//
//   setPlayerLabels([{ name, avatar }, ...])   index = team; name '' / null = no own label; avatar = whole number | null
//   playerLabel(team)                          call sign of a computer player, else ''
//   playerAvatarIndex(team)                    avatar index or null
//   clearPlayerLabels()
//
// [UISMALL] human players: an entry { human: true, image } marks a team as a human (image = data URL of the uploaded
// picture or ''/null = neutral silhouette), so the HUD can show a head silhouette / picture for it:
//   playerIsHuman(team)   true for an entry with human: true
//   playerImage(team)     validated data URL of a human's picture, '' when none
//   cleanAvatarImage(s)   the data URL when it is a small image data URL (UI_SMALL.humanAvatar), else ''
import { cleanAiIdentity } from '../ai/AiProfiles.js';
import { UI_SMALL } from '../config.js';

const IMAGE_RE = new RegExp(UI_SMALL.humanAvatar.dataUrlPattern);

/** Only a short base64 image data URL passes (it ends up in an <img src> and in the lobby state over the network) */
export function cleanAvatarImage(value, maxLength = UI_SMALL.humanAvatar.maxDataLength) {
  return typeof value === 'string' && value.length <= maxLength && IMAGE_RE.test(value) ? value : '';
}

let labels = [];
let humans = [];

export function setPlayerLabels(list) {
  const entries = Array.isArray(list) ? list : [];
  labels = entries.map((e) => {
    const id = cleanAiIdentity({ aiName: e?.name, avatar: e?.avatar });
    return id ? { name: id.name, avatar: id.avatar } : null;
  });
  humans = entries.map((e) => (e?.human === true ? { image: cleanAvatarImage(e.image) } : null));
}

export function clearPlayerLabels() { labels = []; humans = []; }

export function playerIsHuman(team) { return Boolean(humans[team]); }

export function playerImage(team) { return humans[team]?.image ?? ''; }

export function playerLabel(team) { return labels[team]?.name ?? ''; }

export function playerAvatarIndex(team) { return labels[team]?.avatar ?? null; }
