// Steel Men – map pings and lost-part alerts [N7] (docs/notes/n7-ping.md).
//   Ping:  PING.modifier + left click on the scene or the minimap (submitPing) -> command 'ping' -> every client
//          whose local team is an ally of the sender shows a pulsing ring in the scene and on the minimap for
//          PING.durationMs and a HUD line "Ally X marked a spot" (click = camera there). Own pings show no line.
//   Part:  ModularMech.onPartDamaged dispatches PING.partLostEvent when an arm of a mech is shot off. Own mechs
//          get a HUD alert (click = camera on the robot) and a badge above the robot; the arm lying on the ground is
//          marked on the minimap (own team only) until it is picked up or destroyed.
// Nothing in here touches the simulation or its hash: it only reads the world and listens to events.
import * as THREE from 'three';
import { PING, SIM, TEAMS } from '../config.js';
import { commandBus } from '../game/commands/CommandBus.js';
import '../game/commands/pingCommands.js'; // registers the 'ping' command wherever this file is imported
import { localTeam, isLocal } from '../core/LocalPlayer.js';
import { areAllies } from '../game/Alliances.js';
import { t } from '../i18n/i18n.js';
import { play } from '../audio/Sound.js';

const COORD_DECIMALS = 100; // points are sent rounded to 0.01
const MS_PER_SEC = 1000;
const FULL_CYCLE = 1;
const HALF_TURN = 2;
const _v = new THREE.Vector3();

// ---------- shared state (module level, like LocalPlayer): the minimap reads it without any wiring ----------

/** Pings that are on screen: { team, x, z, born (ms) } */
const pings = [];
/** Lost arm wreck -> team of the mech it fell off (the minimap marks it for that team only) */
const wreckOwners = new WeakMap();
/** Last executed ping tick per sender team (receive-side anti-spam) */
const lastPingTick = new Map();
let lastSubmitMs = -Infinity;
let nameResolver = null;
let current = null; // the live Pings instance (a new game replaces it)

const nowMs = () => performance.now();

/** Lets main.js give real player names: fn(team) -> string | null (null = "Player N") */
export function setPingNameResolver(fn) { nameResolver = fn; }

/** Is the ping modifier held in this pointer event? */
export function isPingClick(e) {
  const m = PING.modifier;
  return m === 'alt' ? e.altKey : m === 'shift' ? e.shiftKey : e.ctrlKey || e.metaKey;
}

/**
 * Sends a ping of the local team at a ground point { x, z } (world units). Returns false when the cooldown
 * (PING.submitCooldownMs) swallowed it.
 */
export function submitPing(point) {
  const now = nowMs();
  if (now - lastSubmitMs < PING.submitCooldownMs) return false;
  lastSubmitMs = now;
  const round = (v) => Math.round(v * COORD_DECIMALS) / COORD_DECIMALS;
  commandBus.submit({ type: PING.commandType, team: localTeam(), point: { x: round(point.x), z: round(point.z) } });
  return true;
}

const teamColor = (team) => TEAMS[team]?.color ?? PING.fallbackColor;
const pingAlpha = (p, now) => Math.min(FULL_CYCLE, (PING.durationMs - (now - p.born)) / PING.fadeOutMs);

function prune(now) {
  for (let i = pings.length - 1; i >= 0; i--) if (now - pings[i].born >= PING.durationMs) pings.splice(i, 1);
}

/** Called by Minimap.#draw: pulsing rings of the pings + markers of lost arms of the local team */
export function drawMinimapMarks(ctx, toMini, world) {
  const now = nowMs();
  prune(now);
  ctx.save();
  for (const p of pings) {
    const [x, y] = toMini(p.x, p.z);
    const phase = ((((now - p.born) / MS_PER_SEC) * PING.minimapPulsesPerSec) % FULL_CYCLE);
    ctx.strokeStyle = teamColor(p.team);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = PING.minimapLineWidth;
    ctx.globalAlpha = Math.max(0, pingAlpha(p, now)) * (FULL_CYCLE - phase);
    ctx.beginPath();
    ctx.arc(x, y, PING.minimapRingMaxPx * phase, 0, Math.PI * HALF_TURN);
    ctx.stroke();
    ctx.globalAlpha = Math.max(0, pingAlpha(p, now));
    ctx.beginPath();
    ctx.arc(x, y, PING.minimapCenterPx, 0, Math.PI * HALF_TURN);
    ctx.fill();
  }
  const bright = Math.floor(now / (PING.partMarkerBlinkMs / HALF_TURN)) % HALF_TURN === 0;
  ctx.globalAlpha = bright ? FULL_CYCLE : PING.partMarkerDimAlpha;
  ctx.lineWidth = PING.partMarkerLineWidth;
  ctx.strokeStyle = PING.partMarkerOutline;
  for (const w of world.wrecks ?? []) {
    const owner = wreckOwners.get(w);
    if (owner === undefined || !isLocal(owner) || w.collected || w.destroyed || !w.object) continue;
    const [x, y] = toMini(w.object.position.x, w.object.position.z);
    const s = PING.partMarkerHalf;
    ctx.fillStyle = teamColor(owner);
    ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- scene layer + HUD alerts ----------

export class Pings {
  /**
   * @param {object} deps  { world, camera, dom (canvas), focus(Vector3) – centres the camera }
   */
  constructor({ world, camera, dom, focus }) {
    current?.dispose();
    current = this;
    this.world = world;
    this.camera = camera;
    this.dom = dom;
    this.focus = focus;
    this.rings = new Map();   // ping -> element
    this.badges = new Map();  // mech -> { el, until (ms) }
    this.layer = document.createElement('div');
    this.layer.id = 'ping-layer';
    document.body.appendChild(this.layer);
    this.alertBox = document.createElement('div');
    this.alertBox.id = 'hud-alerts';
    document.body.appendChild(this.alertBox);
    this.alertBox.addEventListener('pointerdown', (e) => this.#onAlertPointer(e));

    this.offExecuted = commandBus.onExecuted((cmd, tick) => this.#onCommand(cmd, tick));
    this.onPartLost = (e) => this.#onPartLost(e.detail);
    window.addEventListener(PING.partLostEvent, this.onPartLost);
  }

  dispose() {
    this.offExecuted?.();
    window.removeEventListener(PING.partLostEvent, this.onPartLost);
    this.layer.remove();
    this.alertBox.remove();
    pings.length = 0;
    lastPingTick.clear();
    if (current === this) current = null;
  }

  // ---------- events ----------

  #onCommand(cmd, tick) {
    if (cmd.type !== PING.commandType || !areAllies(localTeam(), cmd.team)) return;
    const last = lastPingTick.get(cmd.team);
    if (last !== undefined && tick >= last && tick - last < PING.receiveCooldownSec * SIM.tickRate) return; // spam
    lastPingTick.set(cmd.team, tick);
    const now = nowMs();
    pings.push({ team: cmd.team, x: cmd.point.x, z: cmd.point.z, born: now });
    while (pings.length > PING.maxActive) pings.shift();
    play(PING.sound);
    if (cmd.team !== localTeam()) {
      const name = nameResolver?.(cmd.team) ?? t('ping.player', { n: cmd.team + 1 });
      this.#alert(t('ping.allyMarked', { name }), { x: cmd.point.x, z: cmd.point.z });
    }
  }

  #onPartLost({ mech, slot, wreck } = {}) {
    if (!mech) return;
    if (wreck) wreckOwners.set(wreck, mech.team);
    if (!isLocal(mech)) return;
    this.#alert(t('alert.partLost', { robot: mech.name, part: t(`part.${slot}`) }), mech);
    play(PING.alertSound, { position: mech.position });
    this.#badge(mech);
  }

  // ---------- HUD alerts ----------

  /** Adds a line; target = a unit (follows its position) or a point { x, z }; a click centres the camera there */
  #alert(text, target) {
    const el = document.createElement('div');
    el.className = 'hud-alert';
    el.textContent = text;
    el.title = t('alert.click');
    this.alertBox.appendChild(el);
    el._target = target;
    el._until = nowMs() + PING.alertDurationMs;
    while (this.alertBox.children.length > PING.alertMax) this.alertBox.firstChild.remove();
  }

  #onAlertPointer(e) {
    const el = e.target.closest('.hud-alert');
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const p = el._target?.position ?? el._target;
    if (!p) return;
    const x = p.x;
    const z = p.z;
    this.focus?.(new THREE.Vector3(x, this.world.heightAt?.(x, z) ?? 0, z));
  }

  // ---------- badge above a robot that lost a part ----------

  #badge(mech) {
    let b = this.badges.get(mech);
    if (!b) {
      const el = document.createElement('div');
      el.className = 'ping-badge';
      el.textContent = PING.badgeText;
      this.layer.appendChild(el);
      b = { el, until: 0 };
      this.badges.set(mech, b);
    }
    b.until = nowMs() + PING.badgeDurationMs;
  }

  // ---------- per frame ----------

  update() {
    const now = nowMs();
    prune(now);
    const rect = this.dom.getBoundingClientRect();

    // Rings in the scene
    for (const p of pings) {
      let el = this.rings.get(p);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ping-ring';
        el.style.setProperty('--ping-color', teamColor(p.team));
        el.style.setProperty('--ping-size', `${PING.sceneRingPx}px`);
        el.style.setProperty('--ping-border', `${PING.sceneRingBorderPx}px`);
        el.style.setProperty('--ping-duration', `${PING.durationMs}ms`);
        el.style.setProperty('--ping-fade', `${PING.fadeOutMs}ms`);
        el.innerHTML = '<i></i><i></i>';
        this.layer.appendChild(el);
        this.rings.set(p, el);
      }
      this.#place(el, _v.set(p.x, this.world.heightAt?.(p.x, p.z) ?? 0, p.z), rect);
    }
    for (const [p, el] of this.rings) {
      if (!pings.includes(p)) { el.remove(); this.rings.delete(p); }
    }

    // Badges
    for (const [mech, b] of this.badges) {
      if (now >= b.until || mech.destroyed || mech.removed) { b.el.remove(); this.badges.delete(mech); continue; }
      const top = (mech.bodyHeight ?? (mech.aimHeight ?? 1) * HALF_TURN) + PING.badgeHeightOffset;
      this.#place(b.el, _v.copy(mech.position).setY(mech.position.y + top), rect, mech.inside || mech.visible === false);
    }

    // Alerts
    for (const el of [...this.alertBox.children]) if (now >= el._until) el.remove();
  }

  /** Projects a world point to the screen and positions an element there (hidden behind the camera / off canvas) */
  #place(el, world, rect, hide = false) {
    const p = world.project(this.camera);
    const x = rect.left + ((p.x + 1) / HALF_TURN) * rect.width;
    const y = rect.top + ((1 - p.y) / HALF_TURN) * rect.height;
    const off = hide || p.z > 1 || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
    if (el.hidden !== off) el.hidden = off;
    if (!off) el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
  }
}
