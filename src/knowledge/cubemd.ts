/**
 * CUBE.md: the one file a cube starts from. It says what this workspace has right now (who is
 * here, the tools connected through the agent programs, the skills, the newest of what is
 * remembered, the wiki) and points to ontology.md, which says how those things are connected.
 *
 * Cube writes it from what it already knows, with no model in between, so it is exact and costs
 * nothing to keep current. This file holds only the text: what goes in, and how it reads.
 */

export interface CubeMdItem {
  name: string;
  about: string;
}

export interface CubeMdInput {
  today: string;
  /** The knowledge folder, where CUBE.md and everything it points to live. */
  dir: string;
  person: string;
  teammates: string[];
  cubes: CubeMdItem[];
  /** Channels and chats by the name they are shown with. */
  conversations: string[];
  /** What each agent program has, by the program's name as people know it. */
  programs: { name: string; mcp: CubeMdItem[]; skills: CubeMdItem[]; plugins: CubeMdItem[] }[];
  /** Cube's own skills. */
  skills: CubeMdItem[];
  /** Every note in memory, newest first. */
  memory: CubeMdItem[];
  /** The newest notes in full, so the most recent of what was learned needs no second read. */
  recent: { name: string; text: string }[];
  wiki: CubeMdItem[];
  /** Whether ontology.md has been written yet. */
  ontology: boolean;
}

/** The most lines of one list. What does not fit is counted, and is in the file the list points to. */
const MOST = 40;
/** The most of one recent note that is copied in. */
const NOTE_LIMIT = 700;

const one = (s: string, limit = 160) => s.replace(/\s+/g, " ").trim().slice(0, limit);
function list(items: CubeMdItem[], empty: string, most = MOST, about = 160): string {
  if (!items.length) return empty;
  const shown = items.slice(0, most).map((i) => `- ${i.name}${i.about ? `: ${one(i.about, about)}` : ""}`).join("\n");
  return items.length > most ? `${shown}\n- …and ${items.length - most} more.` : shown;
}

/** A note without its front matter, cut to what is worth copying in. */
export function noteBody(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return body.length > NOTE_LIMIT ? `${body.slice(0, NOTE_LIMIT).trimEnd()}\n[…cut, the rest is in the note]` : body;
}

export function cubeMd(i: CubeMdInput): string {
  const parts: string[] = [
    `# CUBE.md\n\nWhat this workspace has, written by Cube on ${i.today} from what is set up on this computer. Cube rewrites it whenever that changes, so do not edit it: change the files it points to. Paths are inside ${i.dir}.`,
    `## Who is here\n\n- ${i.person || "The person"} is who the team works for.${i.teammates.length ? `\n- Teammates, each with cubes of their own: ${i.teammates.join(", ")}.` : ""}\n\nThe cubes:\n${list(i.cubes, "None.")}\n\nConversations: ${i.conversations.length ? i.conversations.slice(0, MOST).join(", ") : "none yet"}.`,
  ];

  const tools = i.programs.filter((p) => p.mcp.length);
  parts.push(`## Tools connected\n\nMCP servers the agent programs have. A tool belongs to the program that has it: a cube running on that program can use it, and whoever hands out work should give the job to such a cube.\n\n${tools.length ? tools.map((p) => `### ${p.name}\n\n${list(p.mcp, "None.")}`).join("\n\n") : "None found."}`);

  const programSkills = i.programs.filter((p) => p.skills.length || p.plugins.length);
  parts.push(`## Skills\n\nProcedures that worked, to follow the same way again. Cube's own are in skills/<name>/SKILL.md; read one before doing what it describes.\n\n${list(i.skills, "Cube has none of its own yet.")}${programSkills.length ? `\n\nWhat each agent program brings of its own. A program knows its own skills in full; this is so that everyone knows who has which.\n\n${programSkills.map((p) => `### ${p.name}\n\n${list([...p.skills, ...p.plugins.map((x) => ({ name: `${x.name} (plugin)`, about: x.about }))], "None.", 25, 70)}`).join("\n\n")}` : ""}`);

  parts.push(`## What is remembered\n\n${i.memory.length ? `${i.memory.length} notes about ${i.person || "the person"} and their work, listed in memory/MEMORY.md.` : "Nothing yet."}${i.recent.length ? `\n\nThe newest, in full:\n\n${i.recent.map((n) => `### ${n.name}\n\n${n.text}`).join("\n\n")}` : ""}${i.memory.length > i.recent.length ? `\n\nThe rest, by what each is about:\n${list(i.memory.slice(i.recent.length), "")}` : ""}`);

  parts.push(`## Wiki\n\nWhat is remembered, arranged for reading. wiki/index.md links to every page.\n\n${list(i.wiki, "No pages yet.")}`);

  parts.push(`## How things are connected\n\n${i.ontology
    ? "ontology.md says how the people, cubes, projects, files, tools and terms of this workspace are connected: who works on what, which tool holds which data, what a word means here. Read it when a request depends on such a connection, and read only the part that applies."
    : "ontology.md is not written yet. Cube writes it with the wiki, once background work is turned on in Settings."}`);

  return `${parts.join("\n\n")}\n`;
}

export interface FactsInput {
  today: string;
  person: string;
  teammates: string[];
  cubes: CubeMdItem[];
  channels: { name: string; shared: boolean; cubes: string[] }[];
  chats: string[];
  schedules: { text: string; when: string; where: string }[];
}

/**
 * What Cube itself knows about the workspace, written out for the wiki job, which keeps
 * ontology.md: who is here, which conversations there are, what runs on a schedule. These are
 * facts, not things learned from what was said, and the job is told so.
 */
export function workspaceFacts(i: FactsInput): string {
  const parts = [
    `# What Cube knows about this workspace\n\nMade by Cube on ${i.today}, from the app's own state. These are facts (source: workspace), not things learned from conversation.`,
    `## People\n\n- ${i.person || "The person"}: the person this workspace belongs to.${i.teammates.map((t) => `\n- ${t}: a teammate.`).join("")}`,
    `## Cubes\n\n${list(i.cubes, "None.")}`,
    `## Channels\n\n${i.channels.length ? i.channels.slice(0, MOST).map((c) => `- #${c.name}${c.shared ? " (shared with teammates)" : ""}: ${c.cubes.join(", ") || "no cubes"}`).join("\n") : "None."}`,
  ];
  if (i.chats.length) parts.push(`## Chats, by what each began with\n\n${i.chats.slice(0, MOST).map((c) => `- ${one(c, 80)}`).join("\n")}`);
  if (i.schedules.length) parts.push(`## Schedules\n\n${i.schedules.slice(0, MOST).map((s) => `- ${s.when}, in ${s.where}: ${one(s.text, 200)}`).join("\n")}`);
  return `${parts.join("\n\n")}\n`;
}
