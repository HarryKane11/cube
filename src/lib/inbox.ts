import type { Decision, Note } from "../agents/notes";
import { agentById } from "../agents/types";
import type { Msg } from "../state/store";

export type EntryKind = "ask" | "question" | "plan" | "reply" | "stuck" | "note" | "decision";

/** One thing waiting on the person, wherever in Cube it came up. */
export interface Entry {
  id: string;
  kind: EntryKind;
  agentId: string;
  convId?: string;
  msgId?: string;
  /** The id of the ask, note or decision behind this entry. */
  ref?: string;
  title: string;
  detail: string;
  ts: number;
}

interface From {
  messages: Msg[];
  notes: Note[];
  decisions: Decision[];
  cleared: Record<string, boolean>;
}

const ORDER: Record<EntryKind, number> = { ask: 0, question: 0, plan: 0, stuck: 1, reply: 1, decision: 2, note: 2 };

/**
 * Everything the person is being waited on for: requests for an OK, questions, plans, replies that
 * end in a question, runs that failed, notes to keep or forget, and choices agents made alone.
 * Things that block an agent come first; within a group, newest first.
 */
export function inboxEntries({ messages, notes, decisions, cleared }: From): Entry[] {
  const out: Entry[] = [];
  const name = (id: string) => agentById(id)?.name ?? id;
  // The newest top-level message of each conversation: if a cube left a question or an error there, it still waits.
  const last = new Map<string, Msg>();
  for (const m of messages) {
    if (!m.parentId && !m.aside) last.set(m.convId, m);
    for (const a of m.asks ?? []) {
      if (a.state !== "waiting") continue;
      const kind: EntryKind = a.plan !== undefined ? "plan" : a.questions ? "question" : "ask";
      const title = kind === "plan" ? `${name(m.author)} has a plan for you` : kind === "question" ? `${name(m.author)} has a question` : `${name(m.author)} needs your OK: ${a.title.toLowerCase()}`;
      out.push({ id: `ask:${a.id}`, kind, agentId: m.author, convId: m.convId, msgId: m.id, ref: a.id, title, detail: a.plan ?? a.questions?.[0]?.question ?? a.detail, ts: m.ts });
    }
    if (m.plan && !m.streaming) out.push({ id: `plan:${m.id}`, kind: "plan", agentId: m.author, convId: m.convId, msgId: m.id, title: `${name(m.author)} has a plan for you`, detail: m.text, ts: m.ts });
  }
  for (const m of last.values()) {
    if (m.author === "you" || m.streaming || m.plan || m.asks?.some((a) => a.state === "waiting")) continue;
    if (m.error) out.push({ id: `stuck:${m.id}`, kind: "stuck", agentId: m.author, convId: m.convId, msgId: m.id, title: `${name(m.author)} hit a problem`, detail: m.error, ts: m.ts });
    else if (/\?\s*$/.test(m.text)) out.push({ id: `reply:${m.id}`, kind: "reply", agentId: m.author, convId: m.convId, msgId: m.id, title: `${name(m.author)} asked you something`, detail: m.text, ts: m.ts });
  }
  for (const d of decisions) {
    if (d.state === "new") out.push({ id: `decision:${d.id}`, kind: "decision", agentId: d.agentId, convId: d.convId, msgId: d.msgId, ref: d.id, title: `${name(d.agentId)} made a call on its own`, detail: d.text, ts: d.ts });
  }
  for (const n of notes) {
    if (n.state === "pending") out.push({ id: `note:${n.id}`, kind: "note", agentId: n.agentId, convId: n.convId, ref: n.id, title: `${name(n.agentId)} wants to remember this`, detail: n.text, ts: n.ts });
  }
  return out.filter((e) => !cleared[e.id]).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.ts - a.ts);
}
