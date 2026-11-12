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

const STEP_LINE = /^[ \t]*STEP:[ \t]*(\d+)[ \t]*$/gim;

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

/**
 * Agents end a reply with `NOTE: …` lines when they learned something worth remembering.
 * Those lines are not part of the message: this takes them out and returns them separately.
 * Works on half-written text too, so a note never flashes in the bubble while it streams.
 */
export function splitNotes(text: string): { text: string; notes: string[]; decisions: string[]; step?: number } {
  const notes: string[] = [];
  const decisions: string[] = [];
  let step: number | undefined;
  const take = (into: string[]) => (_line: string, body: string) => {
    const said = body.trim();
    if (said) into.push(said);
    return "";
  };
  // `DECIDED:` lines work the same way: they report a choice the agent made by itself.
  // `STEP: 2` says which step of its plan the Orchestrator is handing out now.
  const rest = text.replace(NOTE_LINE, take(notes)).replace(DECIDED_LINE, take(decisions)).replace(STEP_LINE, (_line, n: string) => { step = Number(n); return ""; });
  const out = { text: rest.replace(/\n{3,}/g, "\n\n").trimEnd(), notes, decisions };
  return step === undefined ? out : { ...out, step };
}

/** The part of a prompt that tells an agent what the person approved for it to remember. */
export function notesBlock(person: string, notes: Note[]): string {
  if (!notes.length) return "";
  return `Notes ${person} approved for you to remember. Follow them:\n${notes.map((n) => `- ${n.text}`).join("\n")}`;
}
