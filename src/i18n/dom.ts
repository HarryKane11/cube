import { EXACT, PATTERNS } from "./ko";
import type { Lang } from "./index";

/**
 * Shows Cube's own words in another language without touching what people and cubes wrote.
 *
 * The app is written in English. In Korean, this module rewrites the app's text on the page as it
 * appears: text nodes and a few attributes, looked up in a dictionary. Anything inside a region
 * that holds someone's content (messages, documents, the editor, the terminal) is left alone.
 */

/** Regions whose text is content, not interface. */
const CONTENT = "[data-notranslate], .md, .doc, .sheet, .monaco-editor, .xterm, pre, code, textarea, [contenteditable]";
const ATTRS = ["placeholder", "title", "aria-label", "alt"];

interface Rec {
  /** The English the app put there. */
  src: string;
  /** What is shown instead. */
  out: string;
}

const texts = new WeakMap<Text, Rec>();
const attrs = new WeakMap<Element, Record<string, Rec>>();
const cache = new Map<string, string | null>();
let lang: Lang = "en";
let observer: MutationObserver | null = null;

const same = (s: string) => translate(s) ?? s;

/** Puts a translation where the English was. One that starts with "^" attaches to the word before it. */
function place(text: string, core: string, out: string): string {
  return out.startsWith("^") ? text.trimStart().replace(core, () => out.slice(1)) : text.replace(core, () => out);
}

/** The Korean for a piece of interface text, or null when there is none. Outer spaces are kept. */
export function translate(text: string): string | null {
  const core = text.trim();
  if (!core || !/[A-Za-z]/.test(core)) return null;
  const hit = cache.get(core);
  if (hit !== undefined) return hit === null ? null : place(text, core, hit);
  let out: string | null = EXACT[core] ?? null;
  if (out === null) {
    for (const [re, make] of PATTERNS) {
      const m = core.match(re);
      if (m) { out = make(m, same); break; }
    }
  }
  // "2 replies · 1 file changed": pieces joined by a dot are translated one by one.
  if (out === null && core.includes(" · ")) {
    const parts = core.split(" · ");
    const done = parts.map((p) => translate(p));
    if (done.some((d) => d !== null)) out = done.map((d, i) => d ?? parts[i]).join(" · ");
  }
  if (cache.size < 5000) cache.set(core, out);
  return out === null ? null : place(text, core, out);
}

/** Interface text in the current language, for words that never reach the page (a system notification). */
export const say = (text: string) => (lang === "ko" ? (translate(text) ?? text) : text);

function doText(node: Text): void {
  const now = node.nodeValue ?? "";
  const rec = texts.get(node);
  if (lang === "en") {
    if (rec && now === rec.out) node.nodeValue = rec.src;
    texts.delete(node);
    return;
  }
  if (rec && now === rec.out) return;
  // Controls that sit inside a document ("Add a row" in a sheet) are the app's own words, marked data-ui.
  const inContent = node.parentElement?.closest(CONTENT);
  if (inContent && !(node.parentElement?.closest("[data-ui]") && inContent.contains(node.parentElement.closest("[data-ui]")))) return;
  const out = translate(now);
  if (out === null || out === now) return;
  texts.set(node, { src: now, out });
  node.nodeValue = out;
}

function doAttrs(el: Element): void {
  if (el.closest(".monaco-editor, .xterm, [data-notranslate]")) return;
  let recs = attrs.get(el);
  for (const name of ATTRS) {
    const now = el.getAttribute(name);
    if (now === null) continue;
    const rec = recs?.[name];
    if (lang === "en") {
      if (rec && now === rec.out) el.setAttribute(name, rec.src);
      continue;
    }
    if (rec && now === rec.out) continue;
    const out = translate(now);
    if (out === null || out === now) continue;
    recs = recs ?? {};
    recs[name] = { src: now, out };
    attrs.set(el, recs);
    el.setAttribute(name, out);
  }
  if (lang === "en") attrs.delete(el);
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  doAttrs(root as Element);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else doAttrs(n as Element);
  }
}

/** Switches the app's own words to a language, now and for everything drawn from here on. */
export function setLanguage(next: Lang): void {
  lang = next;
  document.documentElement.lang = next;
  observer?.disconnect();
  observer = null;
  walk(document.body);
  if (next === "en") return;
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") doText(m.target as Text);
      else if (m.type === "attributes") doAttrs(m.target as Element);
      else m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
