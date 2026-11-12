import type { AgentDef, Palette } from "./types";

/**
 * Sub-agents the person makes in Cube: a name, what it is for, how it should work and its
 * colors. A sub-agent is a role like the built-in ones (it runs on an agent program the person
 * picks for it), and it can be shared with the team so that a teammate brings in a copy.
 */
export interface SubAgent {
  id: string;
  /** How it is called with @. Letters and digits of any script, no spaces. */
  name: string;
  /** One short phrase shown next to the name. */
  role: string;
  /** What it is for, told to the agent itself, to its teammates and to the Router. */
  brief: string;
  /** How it should go about its work, in the person's words. Given to the agent at the start of a conversation. */
  instructions: string;
  palette: Palette;
  /** Brought in from a teammate: who made it. */
  from?: { name: string; pubkey: string };
  /** Offered to the team: teammates can bring in a copy. */
  shared?: boolean;
}

/** A sub-agent as a teammate offers it, after it has been checked. */
export interface SharedAgent {
  /** The teammate's key and the sub-agent's id there: what tells one offer from another. */
  key: string;
  by: string;
  byName: string;
  name: string;
  role: string;
  brief: string;
  instructions: string;
  palette: Palette;
}

export const NAME_RULE = /^\p{L}[\p{L}\p{N}]{1,19}$/u;
const HEX = /^#[0-9a-f]{6}$/i;
const LIMITS = { role: 80, brief: 600, instructions: 8000 };

/** What is wrong with a name for a sub-agent, or null. `taken` are the names already in use. */
export function nameProblem(name: string, taken: string[]): string | null {
  if (!NAME_RULE.test(name)) return "A name is 2 to 20 letters or digits, starting with a letter, with no spaces: it is what you type after @.";
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase()) || ["you", "here", "channel", "everyone"].includes(name.toLowerCase())) return "That name is already in use.";
  return null;
}

/** An id for a new sub-agent, unlike any in `taken`. */
export function newId(name: string, taken: string[]): string {
  const base = `sub-${name.toLowerCase().replace(/[^a-z0-9]/g, "") || "agent"}`;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The color a cube is known by has to be its own, since a cube's look is found by it. This nudges
 * a color that another cube already has until it is free.
 */
export function ownColor(color: string, taken: string[]): string {
  const used = new Set(taken.map((c) => c.toLowerCase()));
  let n = parseInt(color.slice(1), 16);
  let out = color.toLowerCase();
  while (used.has(out)) {
    n = (n + 1) % 0x1000000;
    out = `#${n.toString(16).padStart(6, "0")}`;
  }
  return out;
}

/** A sub-agent as the role the rest of Cube works with. `color` must already be its own. */
export function toDef(sub: SubAgent, color: string): AgentDef {
  return {
    id: sub.id,
    name: sub.name,
    role: sub.role || "Sub-agent",
    brief: sub.brief,
    color,
    palette: [color, sub.palette[1], sub.palette[2]],
    prefers: ["claude", "codex", "hermes", "api"],
    keywords: [],
    instructions: sub.instructions.trim() || undefined,
    custom: true,
  };
}

/** What is published when a sub-agent is offered to the team. Nothing about where or how it runs here. */
export function offer(sub: SubAgent): string {
  return JSON.stringify({ agent: { id: sub.id, name: sub.name, role: sub.role, brief: sub.brief, instructions: sub.instructions, palette: sub.palette } });
}

/**
 * A teammate's offer, read with suspicion: every field checked for type and length, or nothing.
 * The instructions are text that would steer an agent on this computer, so they are only ever
 * shown and brought in by hand, never applied by themselves.
 */
export function readOffer(body: unknown, by: string, byName: string): SharedAgent | null {
  const a = (body as { agent?: Record<string, unknown> } | null)?.agent;
  if (!a || typeof a !== "object") return null;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v.trim() : null);
  const id = text(a.id, 128);
  const name = text(a.name, 40);
  const role = text(a.role ?? "", LIMITS.role);
  const brief = text(a.brief, LIMITS.brief);
  const instructions = text(a.instructions ?? "", LIMITS.instructions);
  const palette = Array.isArray(a.palette) && a.palette.length === 3 && a.palette.every((c) => typeof c === "string" && HEX.test(c)) ? (a.palette as Palette) : null;
  if (!id || !name || !NAME_RULE.test(name) || role === null || !brief || instructions === null || !palette) return null;
  return { key: `${by}:${id}`, by, byName, name, role, brief, instructions, palette };
}

/** A copy of a teammate's sub-agent as one of the person's own, under a name that is free here. */
export function adopt(shared: SharedAgent, takenNames: string[], takenIds: string[]): SubAgent {
  let name = shared.name;
  for (let n = 2; nameProblem(name, takenNames); n++) name = `${shared.name.slice(0, 18)}${n}`;
  return { id: newId(name, takenIds), name, role: shared.role, brief: shared.brief, instructions: shared.instructions, palette: shared.palette, from: { name: shared.byName, pubkey: shared.by } };
}
