/**
 * The three background jobs that keep Cube's knowledge: memory (what is worth remembering from
 * what was said), skills (procedures worth doing the same way again) and the wiki (memory
 * arranged for reading). This file holds what can be worked out without running anything: what
 * to hand a job, what to tell it, and when one is due.
 */

export type JobKind = "memory" | "skills" | "wiki";
export const JOBS: JobKind[] = ["memory", "skills", "wiki"];

export const JOB_ABOUT: Record<JobKind, { name: string; about: string }> = {
  memory: { name: "Memory", about: "Reads new conversations and keeps what is worth remembering" },
  skills: { name: "Skills", about: "Turns ways of working that proved themselves into skills, improves and tidies them" },
  wiki: { name: "Wiki", about: "Arranges what is remembered, and what each agent program can do, into pages you can read" },
};

/** One finished run of a job, as shown in Settings. */
export interface JobRun {
  job: JobKind;
  at: number;
  /** How long it took, in seconds. */
  took: number;
  ok: boolean;
  /** What the job said it did, or what went wrong. */
  summary: string;
}

export interface Line {
  convId: string;
  /** How the conversation reads in a heading: "#general", "Direct message with Builder". */
  where: string;
  who: string;
  text: string;
  ts: number;
}

/** The most text of new conversation handed to one run. Older lines wait for the next. */
export const TRANSCRIPT_LIMIT = 80_000;

/**
 * New conversation lines as one markdown document, grouped by conversation, oldest first. When
 * there is more than fits, the oldest lines are the ones that fit (the rest come next time).
 * Returns the text and the time of the last line included, which is where the next run starts.
 */
export function transcript(lines: Line[], limit = TRANSCRIPT_LIMIT): { text: string; upTo: number; count: number } {
  const sorted = [...lines].sort((a, b) => a.ts - b.ts);
  const taken: Line[] = [];
  let size = 0;
  for (const l of sorted) {
    const cost = l.text.length + l.who.length + 8;
    if (taken.length && size + cost > limit) break;
    taken.push(l);
    size += cost;
  }
  if (!taken.length) return { text: "", upTo: 0, count: 0 };
  const groups = new Map<string, Line[]>();
  for (const l of taken) groups.set(l.convId, [...(groups.get(l.convId) ?? []), l]);
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const parts = [...groups.values()].map((g) => `## ${g[0].where} (${day(g[0].ts)}${day(g[g.length - 1].ts) !== day(g[0].ts) ? ` to ${day(g[g.length - 1].ts)}` : ""})\n\n${g.map((l) => `**${l.who}:** ${l.text.trim()}`).join("\n\n")}`);
  return { text: `# Conversations in Cube\n\n${parts.join("\n\n")}\n`, upTo: taken[taken.length - 1].ts, count: taken.length };
}

const COMMON = (dir: string, person: string, today: string, language: string) => `You look after the long-term knowledge of a workspace called Cube, where one person (${person}) works with a team of AI agents. You are in the knowledge folder, ${dir}. Work only inside this folder: read, create and change files there and nothing else. Use your file tools; if a shell is the only way you have to read and write files, use it for that alone (listing, reading, writing or patching files in this folder). Do not run programs, install anything, use the network, or touch anything outside the folder. Today is ${today}.

The folder:
- memory/*.md: one durable fact per file. memory/MEMORY.md is the index, one line per note: \`- [name](file.md): one-line hook\`.
- memory/imported/: notes brought in from other agent programs (Claude Code, Codex, Hermes), in batches. Source material; never edit it.
- skills/<name>/SKILL.md: procedures agents follow. Front matter \`name\` and \`description\`, then the steps.
- wiki/*.md: pages for the person to read. wiki/index.md links to all of them.
- inbox/: new material for this run.

Rules for everything you write:
- Write in ${language}: the notes, the skills and the pages. File names stay in English, in short-kebab-case.
- Never keep a secret: no keys, passwords or tokens, even if the material contains one.
- To remove a note, a wiki page or a skill, overwrite the file (for a skill, its SKILL.md) with the single word DELETE; Cube removes it afterwards.
- When you are done, end with exactly three lines, \`ADDED: n\`, \`UPDATED: n\`, \`REMOVED: n\`, then one sentence on what changed. If nothing was worth changing, say so; that is a fine outcome.`;

/** What a job is told. `batch` is the one file of imported notes the memory job works in this time, if any are waiting. */
export function jobPrompt(job: JobKind, o: { dir: string; person: string; today: string; batch?: string; language?: string }): string {
  const head = COMMON(o.dir, o.person, o.today, o.language ?? "the language the person uses in the material");
  if (job === "memory") {
    return `${head}

Your job now: memory.
1. Read every file in inbox/${o.batch ? `, and ${o.batch}: notes another agent program kept, each starting with a \`<!-- note: … -->\` line. Work in what is durable from them and set \`source\` to that program. Leave the other files under memory/imported/ for later runs` : ""}.
2. Keep what will matter in later work, one fact per file in memory/, named in short-kebab-case.md, in this form:

---
name: short-kebab-case
description: one line that tells a reader whether this note matters to what they are doing
type: user | feedback | project | reference
source: cube | claude | codex | hermes
updated: ${o.today}
---

The fact. For feedback and project notes add a **Why:** line and a **How to apply:** line.

   - user: who the person is, their role, what they know, what they prefer.
   - feedback: how they want work done; corrections they made; approaches they confirmed. Record what was said, and mark your own reading of it as yours.
   - project: ongoing work, goals, decisions and the reasons for them. Turn "next week" into a date.
   - reference: where things are (links, dashboards, documents, names of systems).
3. Keep only what is durable and would change how an agent works. Not the state of a task, not what a file or the code already records, not a summary of a finished piece of work.
4. Prefer changing an existing note to adding a near-copy. When the new material shows a note to be wrong or out of date, fix it or remove it.
5. Rewrite memory/MEMORY.md so it lists every note in memory/ (not the imported ones).`;
  }
  if (job === "skills") {
    return `${head}

Your job now: skills. A skill is a procedure an agent should follow the same way next time. Its description is all an agent sees when deciding whether to open it, so it must say when to use it.
1. Read inbox/ (recent work), memory/ and the existing skills.
2. Add a skill where the material shows a way of doing something that was worked out with effort and will come up again: several steps, a step that failed first, a correction from the person, a check that caught a mistake. At most three new skills in one run. Nothing for one-off tasks, and nothing an agent would do well without being told.
3. Improve existing skills where the material shows a step failing, a better order, a missing check or a correction. Add a dated line under a "## Changes" heading saying what changed and why.
4. Tidy: merge skills that say nearly the same thing; remove ones that are wrong or that nothing would ever call for.

A skill file:

---
name: short-kebab-case (the same as its folder)
description: When to use this, in one or two sentences, with the words someone would use when asking for it.
---

# Title

When this applies, the steps in order, what goes wrong and how to tell, and how to check the result.`;
  }
  return `${head}

Your job now: the wiki. It is the one place that puts together what the whole team knows and can do. The team is ${o.person}, the cubes, and the agent programs the cubes run on (Claude Code, Codex, Hermes), which are the team's sub-agents: what any of them remembers or can do belongs here, brought together, not kept apart by program.
1. Read memory/ (the notes there, which already take in what each program remembered; not memory/imported/, which is worked into memory first) and inbox/, which holds an inventory of the skills, MCP servers and plugins each agent program has.
2. Keep these pages up to date, each only if there is something to say: a page about the person; one page per project; how the person likes work done; people and teams; tools and systems; a glossary of the terms that are particular to their work.
3. Keep one page on what the team can do, from the inventory: arranged by what the ability is for (writing documents, browsing, data, deployment, design and so on), not by program. Under each, name the skills, MCP servers and plugins that serve it and say which program has each, so that whoever hands out work can tell who to give it to. When several programs have the same skill, say so once. Leave out what nobody would ever need to choose between; do not copy descriptions.
4. Every statement must come from memory or the inventory. Do not guess, and do not fill gaps. Where two notes disagree, say so on the page.
5. Write prose and short lists under clear headings. Link pages to each other with relative links. End each page with "Last updated: ${o.today}".
6. Rewrite wiki/index.md: every page, with one line on what it holds. Remove pages that nothing supports any more.`;
}

/** True when a job ended the way it was told to, with its three count lines. Without them it did not do the work. */
export const finished = (text: string) => /^\s*ADDED:\s*\d+/mi.test(text) && /^\s*UPDATED:\s*\d+/mi.test(text) && /^\s*REMOVED:\s*\d+/mi.test(text);

/** The counts and the closing sentence a job ends with, as one line for the log. */
export function summaryOf(text: string): string {
  const count = (k: string) => text.match(new RegExp(`^\\s*${k}:\\s*(\\d+)`, "mi"))?.[1];
  const [added, updated, removed] = [count("ADDED"), count("UPDATED"), count("REMOVED")];
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const last = [...lines].reverse().find((l) => !/^(ADDED|UPDATED|REMOVED):/i.test(l)) ?? "";
  const counts = added !== undefined || updated !== undefined || removed !== undefined ? `${added ?? 0} added, ${updated ?? 0} updated, ${removed ?? 0} removed. ` : "";
  return `${counts}${last.replace(/^[#>*\-\s]+/, "").slice(0, 240)}`.trim() || "Finished without a summary.";
}

export interface Clock {
  now: number;
  /** When each job last finished well. */
  last: Partial<Record<JobKind, number>>;
  /** Conversation lines the memory job and the skills job have not read yet. */
  unread: { memory: number; skills: number };
  /** When the newest conversation line was written. */
  newest: number;
  /** True when raw imports are waiting to be worked into memory. */
  imported: boolean;
  /** When memory last actually changed (a run that added, updated or removed something, or an import). */
  memoryChangedAt: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Which job should run now when Cube keeps things up by itself, or null. Memory goes first, once
 * conversation has gone quiet with enough new in it. The wiki follows when memory has changed,
 * and skills when enough new work has piled up; each at most a few times a day.
 */
export function dueJob(c: Clock): JobKind | null {
  const since = (job: JobKind) => c.now - (c.last[job] ?? 0);
  const quiet = c.now - c.newest > 3 * MIN;
  const memoryDue = c.imported || (quiet && (c.unread.memory >= 12 || (c.unread.memory > 0 && since("memory") > 6 * HOUR)));
  // Imports are worked in batch after batch; conversation waits at least ten minutes between runs.
  if (memoryDue && since("memory") > (c.imported ? MIN : 10 * MIN)) return "memory";
  if (c.memoryChangedAt > (c.last.wiki ?? 0) && since("wiki") > 3 * HOUR) return "wiki";
  if (quiet && c.unread.skills >= 40 && since("skills") > 12 * HOUR) return "skills";
  return null;
}
