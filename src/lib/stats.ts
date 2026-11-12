import type { Artifact, Conv, Msg } from "../state/store";

/** What a role has done so far, counted from its messages. */
export interface Stats {
  runs: number;
  done: number;
  stopped: number;
  failed: number;
  /** Requests for an OK, and how many the person allowed. */
  asks: number;
  allowed: number;
  /** Average time per finished run, in milliseconds. 0 when unknown. */
  avgMs: number;
  tokensIn: number;
  tokensOut: number;
  /** In US dollars, for the runs whose engine reported a price. */
  cost: number;
  /** Runs in the last seven days. */
  week: number;
}

export function statsFor(messages: Msg[], agentId: string, now = Date.now()): Stats {
  const s: Stats = { runs: 0, done: 0, stopped: 0, failed: 0, asks: 0, allowed: 0, avgMs: 0, tokensIn: 0, tokensOut: 0, cost: 0, week: 0 };
  let timed = 0;
  let total = 0;
  for (const m of messages) {
    if (m.author !== agentId || m.streaming || m.aside) continue;
    s.runs++;
    if (now - m.ts < 7 * 86_400_000) s.week++;
    if (m.stopped) s.stopped++;
    else if (m.error) s.failed++;
    else s.done++;
    for (const a of m.asks ?? []) {
      if (a.questions || a.plan !== undefined) continue;
      s.asks++;
      if (a.state === "allowed") s.allowed++;
    }
    if (m.took && !m.stopped) { timed++; total += m.took; }
    s.tokensIn += m.usage?.in ?? 0;
    s.tokensOut += m.usage?.out ?? 0;
    s.cost += m.usage?.cost ?? 0;
  }
  s.avgMs = timed ? Math.round(total / timed) : 0;
  return s;
}

/** What happened in one conversation while the person was away. */
export interface Missed {
  conv: Conv;
  replies: number;
  /** Who replied, most recent last. */
  by: string[];
  files: string[];
  failed: number;
}

/** Replies, changed files and failed runs since a moment, per conversation, busiest first. Quiet ones are left out. */
export function missedSince(messages: Msg[], files: Record<string, Artifact[]>, convs: Conv[], since: number): Missed[] {
  return convs
    .map((conv): Missed => {
      const mine = messages.filter((m) => m.convId === conv.id && m.ts > since && m.author !== "you" && !m.streaming);
      return {
        conv,
        replies: mine.length,
        by: [...new Set(mine.map((m) => m.author))],
        files: (files[conv.id] ?? []).filter((f) => f.mtime > since).map((f) => f.rel),
        failed: mine.filter((m) => m.error).length,
      };
    })
    .filter((m) => m.replies > 0 || m.files.length > 0)
    .sort((a, b) => b.replies + b.files.length - (a.replies + a.files.length));
}

/**
 * Who else is working on a file an agent is about to change: other agents that touched it during
 * their current run, and "you" when the person has unsaved edits in it.
 */
export function clashing(touched: Record<string, string[]>, agentId: string, path: string, dirty: Record<string, boolean>): string[] {
  const others = Object.entries(touched).filter(([id, paths]) => id !== agentId && paths.includes(path)).map(([id]) => id);
  return dirty[path] ? [...others, "you"] : others;
}
