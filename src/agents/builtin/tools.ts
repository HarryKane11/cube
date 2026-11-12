import { ruleFor } from "../permissions";
import type { Ev, Trust } from "../types";

/** One thing the built-in agent can do in the conversation folder. Every parameter is a string. */
export interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: "string"; description: string }>;
  required: string[];
}

const p = (description: string) => ({ type: "string" as const, description });

export const TOOLS: ToolDef[] = [
  { name: "list_files", description: "List the files in the conversation's shared folder, as paths relative to it.", properties: {}, required: [] },
  { name: "read_file", description: "Read a text file from the shared folder.", properties: { path: p("Path relative to the shared folder, e.g. notes.md or src/app.py") }, required: ["path"] },
  { name: "search_files", description: "Find text across the files in the shared folder. Returns matching lines with their file and line number.", properties: { query: p("The text to look for") }, required: ["query"] },
  { name: "write_file", description: "Create a file in the shared folder, or replace its whole content. The person sees it on the Stage at once.", properties: { path: p("Path relative to the shared folder"), content: p("The full content of the file") }, required: ["path", "content"] },
  { name: "edit_file", description: "Replace one exact piece of text in a file. `old_text` must appear exactly once in the file.", properties: { path: p("Path relative to the shared folder"), old_text: p("The exact text to replace"), new_text: p("What to put in its place") }, required: ["path", "old_text", "new_text"] },
  { name: "run_command", description: "Run a shell command in the shared folder and get what it printed. Use it to run and test what you build.", properties: { command: p("The command line to run") }, required: ["command"] },
];

/** What the tools need from the computer. The app passes the real thing; tests pass a stand-in. */
export interface ToolIO {
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<string>;
  /** Writes a file inside `dir`, making it and its folders if needed. */
  write(dir: string, rel: string, content: string): Promise<void>;
  run(dir: string, command: string): Promise<{ output: string; code: number | null }>;
  search(dir: string, query: string): Promise<{ rel: string; line: number; text: string }[]>;
}

export interface ToolCtx {
  dir: string;
  trust: Trust;
  io: ToolIO;
  onEv(ev: Ev): void;
  /** Puts a request in front of the person and resolves with their answer. */
  ask(tool: string, input: unknown): Promise<boolean>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** The tool's input with every required field present as a string, or null when the model sent something else. */
export function validInput(tool: ToolDef, input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const given = input as Record<string, unknown>;
  for (const key of tool.required) if (typeof given[key] !== "string") return null;
  return Object.fromEntries(Object.entries(given).filter(([k, v]) => k in tool.properties && typeof v === "string")) as Record<string, string>;
}

/** A path the model gave, as a plain path inside the folder. Null when it tries to leave it. */
export function safeRel(path: string): string | null {
  const rel = path.trim().replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || rel.startsWith("~") || rel.split("/").some((part) => part === ".." || part === "")) return null;
  return rel;
}

/**
 * Whether a step waits for the person: "ask" for an OK first, "refuse" in Plan mode, "go" otherwise.
 * In Auto, simple commands run by themselves and only the open-ended ones (deleting, fetching,
 * running other code, chains and pipes) still ask.
 */
export function gate(trust: Trust, tool: string, input: Record<string, string>): "go" | "ask" | "refuse" {
  const changes = tool === "write_file" || tool === "edit_file";
  const runs = tool === "run_command";
  if (!changes && !runs) return "go";
  if (trust === "plan") return "refuse";
  if (trust === "free") return "go";
  if (trust === "ask") return "ask";
  if (changes) return "go";
  if (trust === "auto") return ruleFor("Bash", { command: input.command }) ? "go" : "ask";
  return "ask";
}

const base = (rel: string) => rel.split("/").pop() || rel;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s);

/** Runs one tool call and returns what the model should be told. Never throws. */
export async function runTool(ctx: ToolCtx, name: string, input: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: `There is no tool named ${name}.`, isError: true };
  const args = validInput(tool, input);
  // The same shape the API asks for when a tool's input did not arrive as valid JSON.
  if (!args) return { content: JSON.stringify({ INVALID_JSON: JSON.stringify(input ?? null) }), isError: true };
  const rel = "path" in tool.properties ? safeRel(args.path) : "";
  if (rel === null) return { content: "Use a path inside the shared folder, like notes.md or src/app.py.", isError: true };
  const way = gate(ctx.trust, name, args);
  if (way === "refuse") return { content: "Plan mode: nothing may be changed or run yet. Reply with your plan instead.", isError: true };
  try {
    if (name === "list_files") {
      ctx.onEv({ t: "activity", kind: "read", label: "Looking at the files" });
      const files = await ctx.io.list(ctx.dir);
      return { content: files.length ? clip(files.slice(0, 400).join("\n"), 20_000) : "The folder is empty." };
    }
    if (name === "read_file") {
      ctx.onEv({ t: "activity", kind: "read", label: `Reading ${base(rel)}` });
      return { content: clip(await ctx.io.read(`${ctx.dir}/${rel}`), 120_000) || "(the file is empty)" };
    }
    if (name === "search_files") {
      ctx.onEv({ t: "activity", kind: "read", label: "Searching the files" });
      const hits = await ctx.io.search(ctx.dir, args.query);
      return { content: hits.length ? hits.slice(0, 120).map((h) => `${h.rel}:${h.line}: ${h.text}`).join("\n") : "Nothing matches." };
    }
    if (name === "run_command") {
      if (way === "ask" && !(await ctx.ask("Bash", { command: args.command }))) return { content: "The person did not allow this command. Carry on without it or ask them what to do.", isError: true };
      ctx.onEv({ t: "activity", kind: "run", label: `Running ${args.command.replace(/\s+/g, " ").slice(0, 56)}`, cmd: args.command });
      const done = await ctx.io.run(ctx.dir, args.command);
      return { content: `${done.output || "(no output)"}\n[${done.code === null ? "stopped: it ran too long" : `exit code ${done.code}`}]`, isError: done.code !== 0 };
    }
    const path = `${ctx.dir}/${rel}`;
    if (way === "ask" && !(await ctx.ask(name === "write_file" ? "Write" : "Edit", { file_path: path }))) return { content: "The person did not allow this change. Carry on without it or ask them what to do.", isError: true };
    if (name === "write_file") {
      ctx.onEv({ t: "activity", kind: "edit", label: `Writing ${base(rel)}` });
      ctx.onEv({ t: "file", path });
      await ctx.io.write(ctx.dir, rel, args.content);
      return { content: `Wrote ${rel}.` };
    }
    const before = await ctx.io.read(path);
    const count = before.split(args.old_text).length - 1;
    if (!args.old_text || count !== 1) return { content: count ? `old_text appears ${count} times in ${rel}. Include more of the surrounding text so it matches once.` : `old_text was not found in ${rel}. Read the file again and copy the text exactly.`, isError: true };
    ctx.onEv({ t: "activity", kind: "edit", label: `Editing ${base(rel)}` });
    ctx.onEv({ t: "file", path });
    await ctx.io.write(ctx.dir, rel, before.replace(args.old_text, () => args.new_text));
    return { content: `Edited ${rel}.` };
  } catch (e) {
    return { content: String(e), isError: true };
  }
}
