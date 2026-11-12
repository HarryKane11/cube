import type { Conv, Msg } from "../state/store";

/**
 * Finds messages by their words. Every word must be in the text, in any order and any case.
 * `from:writer` keeps one author's messages ("me" is the person), `in:general` one conversation's.
 * Newest first.
 */
export function searchMessages(messages: Msg[], convs: Conv[], query: string, limit = 40): Msg[] {
  const words: string[] = [];
  let from: string | undefined;
  let within: string | undefined;
  for (const part of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (part.startsWith("from:") && part.length > 5) from = part.slice(5).replace(/^@/, "");
    else if (part.startsWith("in:") && part.length > 3) within = part.slice(3).replace(/^#/, "");
    else words.push(part);
  }
  if (!words.length && !from && !within) return [];
  const convIds = within === undefined ? null : new Set(convs.filter((c) => c.name.toLowerCase().startsWith(within!)).map((c) => c.id));
  const out: Msg[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (!m.text.trim()) continue;
    if (convIds && !convIds.has(m.convId)) continue;
    if (from && !(from === "me" || from === "you" ? m.author === "you" : m.author.startsWith(from))) continue;
    const hay = m.text.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push(m);
  }
  return out;
}

/** The part of a message around the first matching word, short enough for one line of a result list. */
export function snippet(text: string, query: string, width = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const word = query.toLowerCase().split(/\s+/).find((w) => w && !w.includes(":"));
  const at = word ? flat.toLowerCase().indexOf(word) : -1;
  if (at < 0 || flat.length <= width) return flat.length > width ? flat.slice(0, width - 1) + "…" : flat;
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  return (start > 0 ? "…" : "") + flat.slice(start, start + width) + (start + width < flat.length ? "…" : "");
}
