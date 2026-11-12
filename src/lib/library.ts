/**
 * The library shows what the whole team has, by kind (memory, wiki, skills, MCP servers,
 * plugins), not by which program holds it: Cube's own, and what Claude Code, Codex and Hermes
 * each bring. The programs are the team's sub-agents, so their skills and tools are the team's.
 */

export type Kind = "memory" | "wiki" | "skills" | "mcp" | "plugins";
export const KINDS: Kind[] = ["memory", "wiki", "skills", "mcp", "plugins"];
export type Source = "cube" | "claude" | "codex" | "hermes";
export const SOURCES: Source[] = ["cube", "claude", "codex", "hermes"];
export const SOURCE_NAME: Record<Source, string> = { cube: "Cube", claude: "Claude Code", codex: "Codex", hermes: "Hermes" };

/** One thing as one program has it. */
export interface Held {
  source: Source;
  name: string;
  about: string;
  /** The file to read to show it. Servers and plugins have none. */
  path?: string;
  /** For Cube's notes: user, feedback, project or reference. */
  tag?: string;
}

/** One row in the library: a thing, and every program that has it. */
export interface Entry {
  name: string;
  about: string;
  tag?: string;
  /** Who has it, Cube first. The first one is shown when the row is opened. */
  held: Held[];
}

const order = (s: Source) => SOURCES.indexOf(s);

/**
 * What the team has of one kind, as rows. A skill, server or plugin that several programs have
 * under the same name is one row that names them all. Notes are never merged: two notes with the
 * same name in two programs are two memories.
 */
export function entries(kind: Kind, held: Held[]): Entry[] {
  const sorted = [...held].sort((a, b) => order(a.source) - order(b.source));
  if (kind === "memory" || kind === "wiki") return sorted.map((h) => ({ name: h.name, about: h.about, tag: h.tag, held: [h] }));
  const rows = new Map<string, Entry>();
  for (const h of sorted) {
    const key = h.name.trim().toLowerCase();
    const row = rows.get(key);
    if (row) {
      if (!row.held.some((x) => x.source === h.source)) row.held.push(h);
      if (!row.about && h.about) row.about = h.about;
    } else {
      rows.set(key, { name: h.name, about: h.about, tag: h.tag, held: [h] });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Rows that match what was typed and, when one is picked, the program that must have them. */
export function filtered(rows: Entry[], query: string, source: Source | "all"): Entry[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (source === "all" || r.held.some((h) => h.source === source)) && (!q || r.name.toLowerCase().includes(q) || r.about.toLowerCase().includes(q)));
}

/** The programs that have at least one thing among these rows, in the usual order. */
export function sourcesOf(rows: Entry[]): Source[] {
  return SOURCES.filter((s) => rows.some((r) => r.held.some((h) => h.source === s)));
}

interface Stock {
  skills: { name: string; about: string }[];
  mcp: { name: string; about: string }[];
  plugins: { name: string; about: string }[];
}

/**
 * What each agent program has, written out for the wiki job to read: the team's sub-agents and
 * what each can do. Descriptions are cut short; the job is to know who has what, not to copy it.
 */
export function inventory(programs: Partial<Record<Exclude<Source, "cube">, Stock>>, today: string): string {
  const line = (i: { name: string; about: string }) => `- ${i.name}${i.about ? `: ${i.about.replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
  const parts = [`# What each agent program has\n\nMade by Cube on ${today}. These programs are the team's sub-agents: what they have is what the team can use.`];
  for (const source of SOURCES) {
    if (source === "cube") continue;
    const stock = programs[source];
    if (!stock) continue;
    parts.push(`## ${SOURCE_NAME[source]}`);
    for (const [title, list] of [["Skills", stock.skills], ["MCP servers", stock.mcp], ["Plugins", stock.plugins]] as const) {
      parts.push(`### ${title} (${list.length})\n\n${list.length ? list.map(line).join("\n") : "None."}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}
