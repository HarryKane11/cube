/**
 * Permission requests: how Cube words what an agent wants to do, and the "always allow"
 * rules a person can give a role. Cube matches the rules itself; nothing here is handed to
 * the agent programs, so a rule means the same thing whichever program runs the role.
 */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** True for the tools that only change files. */
export const isEditTool = (tool: string) => EDIT_TOOLS.includes(tool);

/** The plan inside a request, when the agent is done planning and asks to start. */
export function planOf(tool: string, input: any): string | null {
  return tool === "ExitPlanMode" ? String(input?.plan ?? "").trim() : null;
}

/** Commands too open-ended to allow for good: they delete, change rights, fetch or run other code. */
const NEVER_ALWAYS = new Set([
  "rm", "sudo", "su", "sh", "bash", "zsh", "fish", "eval", "exec", "chmod", "chown", "kill", "killall", "dd",
  "curl", "wget", "ssh", "scp", "python", "python3", "node", "ruby", "perl", "osascript", "open", "xargs", "env",
]);

/** `mcp__server__tool` → its server and tool. Null for a built-in tool. */
function mcpParts(tool: string): { server: string; what: string } | null {
  if (!tool.startsWith("mcp__")) return null;
  const [, server = "", name = ""] = tool.split("__");
  return { server, what: name.replace(/_/g, " ") || "a tool" };
}

function serverName(server: string): string {
  if (/chrome|browser|playwright|puppeteer|ego/i.test(server)) return "the browser";
  if (/computer|desktop|screen/i.test(server)) return "the computer";
  return server.replace(/[_-]/g, " ");
}

/** The words a simple command starts with, or null when the line chains, pipes, redirects or substitutes. */
function commandHead(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const line = command.trim();
  if (!line || /[;&|<>$`(){}\n\\]/.test(line)) return null;
  const [first, second] = line.split(/\s+/);
  if (!/^[A-Za-z][\w.-]*$/.test(first) || NEVER_ALWAYS.has(first)) return null;
  // `git status`, `pnpm test`: keep the subcommand so one OK does not cover `git push`.
  return second && /^[a-z][a-z:-]*$/.test(second) ? `${first} ${second}` : first;
}

/** One question an agent puts to the person, with the answers it suggests. */
export interface Question {
  question: string;
  options: { label: string; description?: string }[];
  /** More than one option may be picked. */
  multi: boolean;
}

/** The questions inside a request, when the "tool" is the agent asking the person something. */
export function questionsOf(tool: string, input: any): Question[] | null {
  if (tool !== "AskUserQuestion" || !Array.isArray(input?.questions)) return null;
  const list = input.questions
    .filter((q: any) => typeof q?.question === "string")
    .map((q: any): Question => ({
      question: q.question,
      multi: Boolean(q.multiSelect),
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o: any) => typeof o?.label === "string")
        .map((o: any) => ({ label: o.label, description: typeof o.description === "string" ? o.description : undefined })),
    }));
  return list.length ? list : null;
}

/** What an agent is asking to do, in words a person can judge at a glance. */
export function describeAsk(tool: string, input: any): { title: string; detail: string } {
  const mcp = mcpParts(tool);
  if (mcp) {
    const args = input && Object.keys(input).length ? JSON.stringify(input) : "";
    return { title: `Use ${serverName(mcp.server)}: ${mcp.what}`, detail: clip(args, 600) };
  }
  switch (tool) {
    case "AskUserQuestion":
      return { title: "Has a question for you", detail: "" };
    case "ExitPlanMode":
      return { title: "Has a plan for you", detail: "" };
    case "Bash":
      return { title: "Run a command", detail: String(input?.command ?? "") };
    case "Write":
      return { title: "Write a file", detail: String(input?.file_path ?? "") };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { title: "Change a file", detail: String(input?.file_path ?? input?.notebook_path ?? "") };
    case "Read":
      return { title: "Read a file outside this folder", detail: String(input?.file_path ?? "") };
    case "WebFetch":
      return { title: "Open a web page", detail: String(input?.url ?? "") };
    case "WebSearch":
      return { title: "Search the web", detail: String(input?.query ?? "") };
    default:
      return { title: `Use ${tool}`, detail: clip(input ? JSON.stringify(input) : "", 600) };
  }
}

/** The lasting rule a person could give for this request, if one is safe to offer. */
export function ruleFor(tool: string, input: any): { rule: string; label: string } | null {
  const mcp = mcpParts(tool);
  if (mcp) return { rule: `server:${mcp.server}`, label: `Always allow ${serverName(mcp.server)}` };
  // A question is for the person every time; no rule can answer it.
  if (tool === "AskUserQuestion" || tool === "ExitPlanMode") return null;
  if (tool === "Bash") {
    const head = commandHead(input?.command);
    return head ? { rule: `command:${head}`, label: `Always allow ${head}` } : null;
  }
  if (EDIT_TOOLS.includes(tool)) return { rule: "edits", label: "Always allow file changes" };
  if (tool === "WebFetch") return { rule: "tool:WebFetch", label: "Always allow web pages" };
  if (tool === "WebSearch") return { rule: "tool:WebSearch", label: "Always allow web searches" };
  return { rule: `tool:${tool}`, label: `Always allow ${tool}` };
}

/** True when one of the role's rules covers this request, so nobody has to be asked. */
export function allowedBy(rules: string[], tool: string, input: any): boolean {
  const mine = ruleFor(tool, input)?.rule;
  if (!mine) return false;
  if (rules.includes(mine)) return true;
  // A rule for `git` also covers `git status`.
  return mine.startsWith("command:") && rules.includes(mine.split(" ")[0]);
}

/** A stored rule, in words, for the list on a role's profile. */
export function ruleLabel(rule: string): string {
  if (rule === "edits") return "Change files";
  const [kind, name = ""] = [rule.slice(0, rule.indexOf(":")), rule.slice(rule.indexOf(":") + 1)];
  if (kind === "command") return `Run ${name}`;
  if (kind === "server") return `Use ${serverName(name)}`;
  if (name === "WebFetch") return "Open web pages";
  if (name === "WebSearch") return "Search the web";
  return `Use ${name}`;
}
