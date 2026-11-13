/**
 * What an agent did, put where it did it. While it writes a reply an agent also reads files,
 * runs commands and searches; each of those steps is recorded with how much of the reply had
 * been written by then. This lays the reply out in that order: what it said, what it then did,
 * what it said next, so a long piece of work can be followed and looked into step by step.
 */

export type Part<A> = { kind: "text"; text: string } | { kind: "acts"; acts: A[] };

const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Where the reply may be cut near `pos`. A cut inside a fenced block of code would break the
 * block in two, so it moves to just after the block (or to the end, while the block is still
 * being written).
 */
function cutAt(text: string, pos: number): number {
  let open = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const end = offset + line.length + 1;
    if (offset >= pos && !open) return pos;
    if (FENCE.test(line)) {
      // The line that closes a block which was open at `pos`: cut after it.
      if (open && end > pos) return Math.min(end, text.length);
      open = !open;
    }
    offset = end;
  }
  return open ? text.length : pos;
}

/**
 * The reply as parts in the order they happened: stretches of text, and between them the steps
 * taken at that point, grouped. Null when the steps were not recorded with their place (messages
 * from before this was kept), so the caller can show them the old way.
 */
export function timeline<A extends { at?: number }>(text: string, acts: A[]): Part<A>[] | null {
  if (!acts.length || !acts.some((a) => a.at !== undefined)) return null;
  const parts: Part<A>[] = [];
  let cursor = 0;
  let last = 0;
  for (const act of acts) {
    // A step never comes before the one recorded ahead of it, whatever its number says.
    last = Math.max(last, cutAt(text, Math.min(Math.max(act.at ?? last, 0), text.length)));
    const before = text.slice(cursor, last);
    // Blank space between two steps is not a stretch of text: the steps stay in one group.
    if (before.trim()) {
      parts.push({ kind: "text", text: before.trim() });
      cursor = last;
    }
    const group = parts[parts.length - 1];
    if (group?.kind === "acts") group.acts.push(act);
    else parts.push({ kind: "acts", acts: [act] });
  }
  const rest = text.slice(cursor);
  if (rest.trim()) parts.push({ kind: "text", text: rest.trim() });
  return parts;
}

/**
 * The steps worth listing. An agent thinks between every two things it does, and saying so each
 * time says nothing: thinking is left out wherever there is a step to show, and a step is not
 * repeated straight after itself. Thinking alone is one line.
 */
export function listed<A extends { kind?: string; label: string }>(acts: A[]): A[] {
  const done = acts.filter((a) => a.kind !== "think");
  const base = done.length ? done : acts.slice(0, 1);
  return base.filter((a, i) => i === 0 || a.label !== base[i - 1].label);
}
