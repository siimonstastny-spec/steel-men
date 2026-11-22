// Steel Mans – keeps the game usable inside a foreign page (itch.io iframe): the game window takes keyboard focus on
// click, scrolling keys do not scroll the host page, text selection and drag-and-drop do not break the controls.
//   const guard = installEmbedGuard();   // once, at start (main.js); guard.dispose() removes everything
// Text fields, selects and anything inside a visible menu keep their normal behaviour.
import { NET } from '../config.js';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const STYLE_ID = 'embed-guard-style';

/** True when the page runs inside a frame (itch.io, claude.ai artifact…); cross-origin parents throw on access */
export function isEmbedded() {
  try { return window.self !== window.top; } catch { return true; }
}

export function installEmbedGuard() {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `html, body { overscroll-behavior: none; }
body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
${EDITABLE}, .selectable { -webkit-user-select: text; user-select: text; }`;
  document.head.appendChild(style);

  const menuOpen = () => document.getElementById('menu')?.hidden === false;
  // selectstart targets are often text nodes (no closest()): start from the parent element
  const editable = (e) => !!(e.target?.closest ? e.target : e.target?.parentElement)?.closest?.(EDITABLE);

  // A click gives the iframe keyboard focus (without it the host page keeps receiving the keys)
  const onPointerDown = () => { try { window.focus(); } catch { /* sandboxed */ } };
  // Arrows, Space, PageUp/Down… would scroll the host page; Space on a focused button must still click it
  const onKeyDown = (e) => {
    if (!NET.embedScrollKeys.includes(e.code) || editable(e) || menuOpen()) return;
    if (e.code === 'Space' && e.target?.closest?.('button, a, summary')) return;
    e.preventDefault();
  };
  const onSelectStart = (e) => { if (!editable(e)) e.preventDefault(); };
  const onDragStart = (e) => { if (!editable(e)) e.preventDefault(); };

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('selectstart', onSelectStart);
  document.addEventListener('dragstart', onDragStart);

  return {
    dispose() {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('selectstart', onSelectStart);
      document.removeEventListener('dragstart', onDragStart);
      style.remove();
    },
  };
}
