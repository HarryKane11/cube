/** Something an agent learned about how the person wants things done. Kept only after the person says so. */
export interface Note {
  id: string;
  /** The role it belongs to. */
  agentId: string;
  text: string;
  ts: number;
  /** "pending": the agent proposed it. "kept": the person approved it, so the agent is told from now on. */
  state: "pending" | "kept";
  /** Where the agent wrote it. Unset when the person added it by hand. */
  convId?: string;
  /** Cube wrote it for itself about how the person talks with it. Kept without asking, since it only shapes Cube's manner; the person can take it away. */
  self?: boolean;
}

/** A choice an agent made by itself, without being told which way to go. The person looks these over afterwards. */
export interface Decision {
  id: string;
  agentId: string;
  convId: string;
  /** The reply it was made in. */
  msgId: string;
  text: string;
  ts: number;
  /** "new": not looked at yet. "ok": the person is fine with it. */
  state: "new" | "ok";
}

/** One emoji, as people put on a message: a pictograph with what may follow it (a skin tone, a joined second one), or a flag. */
const ONE_EMOJI = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*)$/u;
/** `SELF: they joke around, and like short answers` on a line of its own: something Cube picked up about how the person talks with it. */
const SELF_LINE = /^[ \t]*`?SELF:[ \t]*([^\n`]*)`?[ \t]*$/gm;
/** `REACT: 🎉` or `REACT: :party_parrot:` on a line of its own: the reaction the cube leaves on the message it answered. */
const REACT_LINE = /^[ \t]*`?REACT:[ \t]*([^\n`]*)`?[ \t]*$/gm;
/** The same at the very end of a reply, after its last sentence: `…ready when you are. REACT: 🎉`. */
const REACT_TAIL = /[ \t]+`?REACT:[ \t]*([^\s`]*)`?[ \t]*$/;
/** One of the workspace's own emoji, as it is written. */
const OWN_EMOJI = /^:[\p{L}\p{N}_+'-]{1,40}:$/u;
const STEP_LINE = /^[ \t]*STEP:[ \t]*(\d+|done)[ \t]*$/gim;

/** One step of a plan the Orchestrator wrote. */
export interface PlanStep {
  n: number;
  text: string;
}

/**
 * Takes the plan out of an Orchestrator message: a line `PLAN` followed by numbered lines.
 * The plan is shown as its own card, and the names in it are not hand-offs: only what is
 * written outside the plan starts a teammate. Works on half-written text too.
 */
export function splitPlan(text: string): { text: string; steps: PlanStep[] } {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^[ \t]*(?:#+[ \t]*)?\**PLAN\**:?[ \t]*$/i.test(l));
  if (at < 0) return { text, steps: [] };
  const steps: PlanStep[] = [];
  let end = at + 1;
  for (; end < lines.length; end++) {
    const m = lines[end].match(/^[ \t]*(\d+)[.)][ \t]+(.+)$/);
    if (m) steps.push({ n: Number(m[1]), text: m[2].trim() });
    else if (lines[end].trim() && steps.length) break;
    else if (lines[end].trim()) break;
  }
  if (!steps.length) return { text, steps: [] };
  const rest = [...lines.slice(0, at), ...lines.slice(end)].join("\n");
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), steps };
}

const NOTE_LINE = /^[ \t]*(?:[-*][ \t]*)?NOTE:[ \t]*(.*)$/gim;
const DECIDED_LINE = /^[ \t]*(?:[-*][ \t]*)?DECIDED:[ \t]*(.*)$/gim;
const IMAGE_LINE = /^[ \t]*(?:[-*][ \t]*)?IMAGE:[ \t]*(.*)$/gim;

/** A picture a cube asks Cube to draw: the file to save it as, and what it shows. */
export interface Picture {
  name: string;
  description: string;
}

/** `IMAGE: cat.png | a cat on a red sofa` as a picture. Without a name it is called picture.png. */
function pictureOf(body: string): Picture | undefined {
  const said = body.trim().replace(/^`|`$/g, "");
  const bar = said.indexOf("|");
  const named = bar > 0 && /\.(png|jpe?g|webp)\s*$/i.test(said.slice(0, bar));
  const description = (named ? said.slice(bar + 1) : said).trim();
  if (description.length < 3) return undefined;
  return { name: named ? said.slice(0, bar).trim() : "picture.png", description };
}

/**
 * Agents end a reply with `NOTE: …` lines when they learned something worth remembering.
 * Those lines are not part of the message: this takes them out and returns them separately.
 * Works on half-written text too, so a note never flashes in the bubble while it streams.
 */
export function splitNotes(text: string): { text: string; notes: string[]; decisions: string[]; step?: number; /** The Orchestrator said its plan was carried through. */ planDone?: boolean; /** The reaction the cube leaves on the message it answered: one emoji, or one of the workspace's own as `:name:`. */ react?: string; /** What Cube picked up about how the person talks with it. Read only from Cube's own replies. */ selves?: string[]; pictures?: Picture[] } {
  const notes: string[] = [];
  const decisions: string[] = [];
  const pictures: Picture[] = [];
  let step: number | undefined;
  let planDone = false;
  let react: string | undefined;
  const selves: string[] = [];
  const take = (into: string[]) => (_line: string, body: string) => {
    const said = body.trim();
    if (said) into.push(said);
    return "";
  };
  // `DECIDED:` lines work the same way: they report a choice the agent made by itself.
  // `STEP: 2` says which step of its plan the Orchestrator is handing out now, `STEP: done` that the plan was carried through.
  // `IMAGE: name.png | what it shows` asks Cube to draw a picture: the line is a request, not part of the reply.
  const rest = text
    .replace(NOTE_LINE, take(notes))
    .replace(DECIDED_LINE, take(decisions))
    .replace(STEP_LINE, (_line, n: string) => { if (/^done$/i.test(n)) planDone = true; else step = Number(n); return ""; })
    .replace(SELF_LINE, (_line, body: string) => { const said = body.trim().slice(0, 240); if (said) selves.push(said); return ""; })
    .replace(REACT_LINE, (_line, body: string) => { const emoji = body.trim(); if (ONE_EMOJI.test(emoji) || OWN_EMOJI.test(emoji)) react = emoji; return ""; })
    .replace(IMAGE_LINE, (_line, body: string) => { const pic = pictureOf(body); if (pic) pictures.push(pic); return ""; });
  // A cube often writes its reaction at the end of its last sentence, not on a line of its own.
  // It is the same thing: taken off the reply, and kept when it is an emoji. What is still being
  // written of it goes too, so it never shows while the reply streams.
  const tail = REACT_TAIL.exec(rest);
  const body = tail ? rest.slice(0, tail.index) : rest;
  if (tail && !react && (ONE_EMOJI.test(tail[1]) || OWN_EMOJI.test(tail[1]))) react = tail[1];
  const out = { text: body.replace(/\n{3,}/g, "\n\n").trimEnd(), notes, decisions };
  return { ...out, ...(step === undefined ? {} : { step }), ...(planDone ? { planDone } : {}), ...(react ? { react } : {}), ...(selves.length ? { selves } : {}), ...(pictures.length ? { pictures } : {}) };
}

/** The part of a prompt that tells an agent what the person approved for it to remember. */
export function notesBlock(person: string, notes: Note[]): string {
  if (!notes.length) return "";
  return `Notes ${person} approved for you to remember. Follow them:\n${notes.map((n) => `- ${n.text}`).join("\n")}`;
}

/** The words the Router may open its line with, to say what kind of line it is. */
const ROUTER_MARKS = ["ANSWER", "PASS", "SKIP"];

/**
 * The Router's line without the words that are for Cube. It may open with `ANSWER` (it answers
 * by itself) or `PASS` (it brings someone in), and may end with a line `REACT: <emoji>`: the
 * reaction it leaves on the message it read. A line with neither is taken as it is. While such
 * a word is still being written, nothing of it is shown.
 */
export function routerLine(text: string): { mark?: "answer" | "pass"; react?: string; text: string } {
  let body = text;
  let react: string | undefined;
  const r = body.match(/(^|\n)[ \t]*`?REACT:[ \t]*([^\n]*)/);
  if (r && r.index !== undefined) {
    const emoji = r[2].replace(/`/g, "").trim();
    if (ONE_EMOJI.test(emoji)) react = emoji;
    body = body.slice(0, r.index) + body.slice(r.index + r[0].length);
  } else {
    body = body.replace(/\n[ \t]*`?(?:R|RE|REA|REAC|REACT)$/, "");
  }
  const m = body.match(/^\s*`?(ANSWER|PASS)\b`?[ \t]*[:.\-–—]?\s*/);
  if (m) return { mark: m[1] === "PASS" ? "pass" : "answer", react, text: body.slice(m[0].length).trimEnd() };
  const start = body.trim().replace(/^`/, "");
  if (start && ROUTER_MARKS.some((word) => word.startsWith(start))) return { react, text: "" };
  return react ? { react, text: body.trimEnd() } : { text: body };
}

/**
 * What the Router's line amounts to. `skip`: nothing in the message is for the team. `answer`:
 * the Router answered it itself, which it does for questions about Cube and the team. `pass`:
 * it names someone to bring in, says it is passing the request on, or says nothing, so the
 * request still has to reach a cube.
 */
export function routerSaid(text: string): "skip" | "answer" | "pass" {
  // `SKIP` is read from what was written: the line with its opening word taken off has nothing left of it.
  if (/^\s*`?SKIP\b/i.test(text)) return "skip";
  const line = routerLine(text);
  const said = line.text.trim();
  // An @ that starts a word is a name; one inside a word is an address.
  if (!said || /(^|[^\p{L}\p{N}])@[\p{L}\p{N}]/u.test(said)) return "pass";
  // "I'll ask the team" with no name in it: the Router meant to hand the request over, and it must not end there.
  if (line.mark === "pass") return "pass";
  return "answer";
}

/** The marks Cube leaves by itself (seen, done): not a cube's own choice. */
const PLAIN_MARKS = new Set(["✅", "👀"]);
/** How many of its last reactions a cube is reminded of. */
const REACTIONS_RECALLED = 6;

/**
 * The reactions this cube chose in this conversation lately, oldest first. A cube does not see
 * reactions in what it reads, and Cube itself starts every message afresh: without this it has
 * no way to know it is leaving the same one again.
 */
export function leftLately(messages: { convId: string; reactions?: Record<string, string[]> }[], convId: string, agentId: string): string[] {
  const left: string[] = [];
  for (const m of messages) {
    if (m.convId !== convId || !m.reactions) continue;
    for (const [emoji, who] of Object.entries(m.reactions)) {
      if (!PLAIN_MARKS.has(emoji) && who.includes(agentId)) left.push(emoji);
    }
  }
  return left.slice(-REACTIONS_RECALLED);
}
