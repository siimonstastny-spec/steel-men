// Steel Men – localisation. Keys are flat dotted strings ('menu.newGame'); tables are in cs.js and en.js.
//   t('key')                      -> translated text (missing key: fallback language, then the key itself)
//   t('hud.population', { value: 5 }) -> '{value}' placeholders are replaced
//   setLanguage('en'), getLanguage(), onLanguageChange(fn), applyTranslations(root)
// The language is detected from the browser the first time, afterwards the one saved in the player profile wins.
// (Started as a minimal version by conversation G, extended by the settings conversation; API and keys unchanged.)
import { I18N } from '../config.js';
import { getSettings, updateSettings } from '../core/Profile.js';
import cs from './cs.js';
import en from './en.js';

export const LANGUAGES = { cs, en };
export const DEFAULT_LANGUAGE = I18N.fallback;

const listeners = new Set();
let current = null;

const supported = (lang) => I18N.languages.includes(lang);

/** First supported language of the browser's preference list, else the fallback */
export function detectLanguage() {
  const prefs = typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language] : [];
  for (const p of prefs) {
    const base = String(p ?? '').toLowerCase().split('-')[0];
    if (supported(base)) return base;
  }
  return I18N.fallback;
}

export function getLanguage() {
  if (!current) {
    const saved = getSettings().language;
    current = supported(saved) ? saved : detectLanguage();
    if (typeof document !== 'undefined') document.documentElement.lang = current;
  }
  return current;
}

/** Switches the language, saves it to the profile, updates [data-i18n] elements and notifies listeners */
export function setLanguage(lang) {
  if (!supported(lang)) return;
  const changed = lang !== getLanguage();
  current = lang;
  document.documentElement.lang = lang;
  updateSettings({ language: lang });
  applyTranslations();
  if (changed) for (const fn of listeners) fn(lang);
}

/** fn(lang) is called after the language changed; returns an unsubscribe function */
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Translates a key; unknown keys return the key itself so missing texts are easy to spot */
export function t(key, params = {}) {
  const text = LANGUAGES[getLanguage()]?.[key] ?? LANGUAGES[I18N.fallback]?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (params[name] ?? m));
}

/**
 * Fills static HTML: data-i18n="key" sets textContent, data-i18n-title / -placeholder set those attributes,
 * data-i18n-html="key" sets innerHTML (only for our own trusted strings).
 */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
