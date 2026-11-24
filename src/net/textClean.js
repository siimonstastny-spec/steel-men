// Steel Men – cleaning of short texts that arrive from other players (game names, nicknames in the game list).
// Removes control, line/paragraph separator, bidi override / isolate and invisible (zero-width, BOM) characters, so a
// name cannot break the layout, reorder neighbouring text or look empty-but-present. Keep this regex ASCII-escaped:
// raw U+2028 / U+2029 inside a regex literal are line terminators in JS (SyntaxError).
// eslint-disable-next-line no-control-regex
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Cleaned, trimmed text of at most `max` characters ('' for a non-string or a text of invisible characters only) */
export function cleanText(s, max) {
  return typeof s === 'string' ? s.replace(CONTROL_RE, '').trim().slice(0, max) : '';
}
