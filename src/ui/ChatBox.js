// [N11] Chat UI: recent lines over the map (left, fade out), Enter opens the input line. Hidden in single player
// (simply do not create it). Keys come from KEYBINDINGS.chat; while the input is focused CommandInput / CameraKeys
// ignore keys (they skip events from input elements), so typing never issues orders.
//   const box = new ChatBox({ chat, t, getColor });   // chat = net/Chat.js, t = i18n, getColor(team) -> css colour
//   box.dispose()
// i18n keys (cs/en in docs/notes/n11-chat.md): chat.placeholder, chat.target.all, chat.target.team, chat.scope.team, chat.rate
import { CHAT, KEYBINDINGS } from '../config.js';
import { esc } from './hudUtil.js';

const matches = (codes, code) => (codes ?? []).includes(code);

export class ChatBox {
  constructor({ chat, t, getColor = () => '#ddd', parent = document.body }) {
    this.chat = chat;
    this.t = t;
    this.getColor = getColor;
    this.lines = [];             // { el, at }
    this.open = false;
    this.team = false;
    this.root = document.createElement('div');
    this.root.className = 'chat-box';
    this.root.style.setProperty('--chat-team', CHAT.scopeTeamColor);
    this.root.style.setProperty('--chat-fade', `${CHAT.fadeMs}ms`);
    this.root.innerHTML = `<div class="chat-lines"></div>
      <form class="chat-form" autocomplete="off"><span class="chat-target"></span>
      <input class="chat-input" type="text" maxlength="${CHAT.maxLength}" spellcheck="false"></form>`;
    parent.appendChild(this.root);
    this.linesEl = this.root.querySelector('.chat-lines');
    this.form = this.root.querySelector('form');
    this.input = this.root.querySelector('input');
    this.targetEl = this.root.querySelector('.chat-target');
    this.input.placeholder = t('chat.placeholder');
    this.#setTeam(false);
    this.onKey = (e) => this.#onKey(e);
    this.onSubmit = (e) => { e.preventDefault(); this.#submit(); };
    this.onBlur = () => { if (this.open) this.#close(); }; // a click on the map would otherwise leave the chat "open"
    window.addEventListener('keydown', this.onKey, true); // capture: before other handlers
    this.form.addEventListener('submit', this.onSubmit);
    this.input.addEventListener('blur', this.onBlur);
    this.off = chat.onMessage((m) => this.#add(m));
    this.timer = setInterval(() => this.#tick(), 250);
  }

  #onKey(e) {
    if (this.open) {
      if (e.target !== this.input || e.isComposing) return; // IME composition: the key belongs to the IME
      if (matches(KEYBINDINGS.cancel, e.code)) { e.preventDefault(); e.stopPropagation(); this.#close(); return; }
      if (matches(KEYBINDINGS.chat, e.code)) { // chat key submits; Shift+key = team message
        e.preventDefault();
        if (e.shiftKey) this.#setTeam(true);
        this.#submit();
      }
      return;
    }
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || !this.chat.canSend) return;
    if (e.target?.closest?.('input, select, textarea') || document.getElementById('menu')?.hidden === false) return;
    if (!matches(KEYBINDINGS.chat, e.code)) return;
    e.preventDefault();
    this.#setTeam(e.shiftKey);
    this.#openInput();
  }

  #setTeam(on) {
    this.team = on;
    this.root.classList.toggle('team', on);
    this.targetEl.textContent = this.t(on ? 'chat.target.team' : 'chat.target.all');
  }

  #openInput() {
    this.open = true;
    this.root.classList.add('open');
    this.input.value = '';
    this.input.focus();
    this.#tick();
  }

  #close() {
    this.open = false;
    this.root.classList.remove('open');
    this.input.blur();
    this.input.value = '';
    this.#tick();
  }

  #submit() {
    let text = this.input.value;
    let team = this.team;
    if (text.startsWith(CHAT.teamPrefix)) { team = true; text = text.slice(CHAT.teamPrefix.length); }
    else if (text.startsWith(CHAT.allPrefix)) { team = false; text = text.slice(CHAT.allPrefix.length); }
    if (!text.trim()) { this.#close(); return; }
    const r = this.chat.send(text, team ? 'team' : 'all');
    if (!r.ok && r.reason === 'rate') { this.input.placeholder = this.t('chat.rate'); return; } // keep the text, try again
    this.input.placeholder = this.t('chat.placeholder');
    this.#close();
  }

  #add(m) {
    const el = document.createElement('div');
    el.className = `chat-line${m.scope === 'team' ? ' team' : ''}`;
    el.style.setProperty('--chat-color', this.getColor(m.team));
    const scope = m.scope === 'team' ? `<span class="chat-scope">${esc(this.t('chat.scope.team'))}</span>` : '';
    el.innerHTML = `${scope}<span class="chat-name">${esc(m.name || `#${m.team + 1}`)}:</span> ${esc(m.text)}`;
    this.linesEl.appendChild(el);
    this.lines.push({ el, at: performance.now() });
    while (this.lines.length > CHAT.historyMax) this.lines.shift().el.remove();
    this.#tick();
  }

  #tick() {
    const now = performance.now();
    const n = this.lines.length;
    for (let i = 0; i < n; i++) {
      const { el, at } = this.lines[i];
      const age = now - at;
      el.classList.toggle('hidden-line', age > CHAT.lineTtlMs + CHAT.fadeMs || i < n - CHAT.visibleLines);
      el.classList.toggle('fading', age > CHAT.lineTtlMs);
    }
  }

  dispose() {
    window.removeEventListener('keydown', this.onKey, true);
    this.form.removeEventListener('submit', this.onSubmit);
    this.input.removeEventListener('blur', this.onBlur);
    this.off?.();
    clearInterval(this.timer);
    this.root.remove();
    this.lines.length = 0;
  }
}
