// Steel Mans – keeps scroll positions when a panel's markup is rewritten (innerHTML collapses the content, the
// browser clamps scrollTop to 0 and the list "jumps to the top" on every refresh).
//   setHtmlKeepScroll(el, html)
// Remembered before the rewrite and restored after it (the browser clamps to the new maximum, so a vanished row
// only scrolls the list up by what is missing):
//   - the nearest scroller at or above `el` that carries data-scroll-key (it is not replaced, only its content),
//   - every descendant with data-scroll-key (replaced by the rewrite; matched by key, keys must be unique inside `el`).
// Call it only when the markup really changed (the callers already compare signatures); no per-frame cost otherwise.

const KEY = 'data-scroll-key';
const SELECTOR = `[${KEY}]`;
const tops = new Map();  // reused between calls
const lefts = new Map();

export function setHtmlKeepScroll(el, html) {
  const host = el.closest(SELECTOR); // may be el itself or an outer scroller
  const hostTop = host ? host.scrollTop : 0;
  const hostLeft = host ? host.scrollLeft : 0;
  tops.clear();
  lefts.clear();
  for (const n of el.querySelectorAll(SELECTOR)) {
    if (n === host) continue;
    const k = n.getAttribute(KEY);
    tops.set(k, n.scrollTop);
    lefts.set(k, n.scrollLeft);
  }
  el.innerHTML = html;
  if (host) {
    if (host.scrollTop !== hostTop) host.scrollTop = hostTop;
    if (host.scrollLeft !== hostLeft) host.scrollLeft = hostLeft;
  }
  if (!tops.size) return;
  for (const n of el.querySelectorAll(SELECTOR)) {
    if (n === host) continue;
    const k = n.getAttribute(KEY);
    if (!tops.has(k)) continue;
    n.scrollTop = tops.get(k);
    n.scrollLeft = lefts.get(k);
  }
}
