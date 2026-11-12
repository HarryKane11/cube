import type { ActKind, Adapter, AgentKind, Ev, Parser, RunOpts } from "./types";

const base = (p: unknown) => (typeof p === "string" ? p.split("/").pop() || p : "a file");
const clip = (s: string, n = 64) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Codex wraps commands as `/bin/zsh -lc '…'`; show only what it actually ran. */
function shortCommand(cmd: unknown): string {
  if (typeof cmd !== "string") return "a command";
  const m = cmd.match(/-lc\s+['"]([\s\S]*)['"]\s*$/);
  return clip((m ? m[1] : cmd).replace(/\s+/g, " ").trim(), 56);
}

function parseJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** What Codex is told about asking and its sandbox, for each level of trust. */
const CODEX_TRUST: Record<NonNullable<RunOpts["trust"]>, { approvalPolicy: string; sandbox: string }> = {
  ask: { approvalPolicy: "untrusted", sandbox: "read-only" },
  edits: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  auto: { approvalPolicy: "never", sandbox: "workspace-write" },
  free: { approvalPolicy: "never", sandbox: "danger-full-access" },
  plan: { approvalPolicy: "never", sandbox: "read-only" },
};

/** The command inside Codex's `/bin/zsh -lc '…'` wrapper. */
function innerCommand(cmd: unknown): string {
  if (typeof cmd !== "string") return "";
  const m = cmd.match(/-lc\s+(['"])([\s\S]*)\1\s*$/);
  return (m ? m[2] : cmd).trim();
}

/**
 * `codex app-server`: JSON-RPC over stdin and stdout, one message per line. Cube opens a thread
 * (or resumes one), starts a turn with the request, and reads what happens as notifications.
 * When Codex needs the person's OK it sends a request of its own and waits for the answer.
 */
function codexParser(prompt: string, sessionId: string | undefined, opts: RunOpts | undefined): Parser {
  const trust = CODEX_TRUST[opts?.trust ?? "edits"];
  const rpc = (id: number, method: string, params: unknown): Ev => ({ t: "send", line: JSON.stringify({ id, method, params }) });
  let spoke = false;
  let failed = false;
  let ended = false;
  let warning = "";
  let usage: { in?: number; out?: number } | undefined;
  // What each open request was about, so the answer can be put in the form that request wants.
  const asked = new Map<string, { id: unknown; kind: "command" | "files" | "questions"; questions?: any[] }>();
  const changed = new Map<string, string[]>();
  const startThread = (): Ev => rpc(2, "thread/start", { ...trust, model: opts?.model ?? null });
  const end = (): Ev[] => {
    if (ended) return [];
    ended = true;
    return [...(usage ? [{ t: "usage" as const, ...usage }] : []), { t: "end" }];
  };
  return {
    stdout(line) {
      const o = parseJson(line);
      if (!o) return [];
      const out: Ev[] = [];
      const p = o.params ?? {};
      const it = p.item;
      if (o.id === 1 && o.result) {
        out.push({ t: "send", line: JSON.stringify({ method: "initialized" }) });
        out.push(sessionId ? rpc(2, "thread/resume", { threadId: sessionId, ...trust, model: opts?.model ?? null }) : startThread());
      } else if (o.id === 2 && o.result?.thread?.id) {
        out.push({ t: "session", id: o.result.thread.id });
        out.push(rpc(3, "turn/start", { threadId: o.result.thread.id, input: [{ type: "text", text: prompt, text_elements: [] }], effort: opts?.effort ?? null }));
      } else if (o.id === 2 && o.error && sessionId) {
        // The old thread is gone (cleared, or made by another version): start over rather than fail.
        sessionId = undefined;
        out.push(startThread());
      } else if ((o.id === 1 || o.id === 2 || o.id === 3) && o.error) {
        failed = true;
        out.push({ t: "error", message: o.error.message ?? "Codex refused the request." }, ...end());
      } else if (o.method && o.id !== undefined) {
        // A request from Codex: it waits until this is answered.
        const id = String(o.id);
        if (o.method === "item/commandExecution/requestApproval") {
          asked.set(id, { id: o.id, kind: "command" });
          out.push({ t: "ask", id, tool: "Bash", input: { command: innerCommand(p.command) || p.reason || "a command", description: p.reason ?? undefined } });
        } else if (o.method === "item/fileChange/requestApproval") {
          asked.set(id, { id: o.id, kind: "files" });
          out.push({ t: "ask", id, tool: "Edit", input: { file_path: (changed.get(p.itemId) ?? []).join(", ") || p.grantRoot || p.reason || "files" } });
        } else if (o.method === "item/tool/requestUserInput" && Array.isArray(p.questions)) {
          asked.set(id, { id: o.id, kind: "questions", questions: p.questions });
          const questions = p.questions.map((q: any) => ({ question: q.question, multiSelect: false, options: (q.options ?? []).map((x: any) => ({ label: x.label, description: x.description })) }));
          out.push({ t: "ask", id, tool: "AskUserQuestion", input: { questions } });
        } else {
          out.push({ t: "send", line: JSON.stringify({ id: o.id, error: { code: -32601, message: "Not supported by Cube." } }) });
        }
      } else if (o.method === "item/agentMessage/delta" && typeof p.delta === "string") {
        out.push({ t: "delta", text: p.delta });
        spoke = true;
      } else if (o.method === "item/started" && it) {
        if (it.type === "agentMessage" && spoke) {
          out.push({ t: "delta", text: "\n\n" });
        } else if (it.type === "commandExecution") {
          out.push({ t: "activity", kind: "run", label: `Running ${shortCommand(it.command)}`, cmd: typeof it.command === "string" ? it.command : undefined });
        } else if (it.type === "fileChange") {
          const paths: string[] = [];
          for (const c of it.changes ?? []) {
            out.push({ t: "activity", kind: "edit", label: `${(c.kind?.type ?? c.kind) === "add" ? "Writing" : "Editing"} ${base(c.path)}` });
            if (typeof c.path === "string") {
              paths.push(c.path);
              out.push({ t: "file", path: c.path });
            }
          }
          changed.set(it.id, paths);
        } else if (it.type === "webSearch") {
          out.push({ t: "activity", kind: "search", label: "Searching the web" });
        } else if (it.type === "mcpToolCall") {
          out.push({ t: "activity", kind: "other", label: `Using ${it.server ? `${String(it.server).replace(/[_-]/g, " ")}: ` : ""}${it.tool ?? "a tool"}` });
        } else if (it.type === "reasoning") {
          out.push({ t: "activity", kind: "think", label: "Thinking it through" });
        }
      } else if (o.method === "item/completed" && it?.type === "mcpToolCall") {
        out.push(...shots(it.result?.content, `${it.server ?? "tool"} · ${it.tool ?? "result"}`));
      } else if (o.method === "thread/tokenUsage/updated" && p.tokenUsage?.total) {
        usage = { in: p.tokenUsage.total.inputTokens, out: p.tokenUsage.total.outputTokens };
      } else if (o.method === "error" && p.error) {
        if (p.willRetry) warning = p.error.message ?? warning;
        else {
          failed = true;
          out.push({ t: "error", message: p.error.message ?? "Codex stopped with an error." });
        }
      } else if (o.method === "turn/completed") {
        const turn = p.turn ?? {};
        if (turn.status === "failed" && !failed) {
          failed = true;
          out.push({ t: "error", message: turn.error?.message ?? (warning || "Codex stopped with an error.") });
        }
        out.push(...end());
      }
      return out;
    },
    stderr() {
      return [];
    },
    exit(code) {
      if (!ended && !failed) return [{ t: "error", message: warning || `Codex stopped before it finished${code ? ` (code ${code})` : ""}.` }];
      return [];
    },
    reply(id, allow, input) {
      const was = asked.get(id);
      asked.delete(id);
      if (was?.kind === "questions") {
        // Answers come back keyed by the question's text; Codex wants them keyed by its id.
        const given = (input as any)?.answers ?? {};
        const answers = Object.fromEntries((was.questions ?? []).map((q: any) => [q.id, { answers: allow && given[q.question] ? [String(given[q.question])] : [] }]));
        return JSON.stringify({ id: was.id, result: { answers } });
      }
      return JSON.stringify({ id: was?.id ?? id, result: { decision: allow ? "accept" : "decline" } });
    },
  };
}

const codex: Adapter = {
  command(prompt, sessionId, opts) {
    const init = { id: 1, method: "initialize", params: { clientInfo: { name: "cube", title: "Cube", version: "0.1.0" }, capabilities: null } };
    return { program: "codex", args: ["app-server"], input: JSON.stringify(init) + "\n", parser: codexParser(prompt, sessionId, opts) };
  },
  parser() {
    return codexParser("", undefined, undefined);
  },
};

/** Pictures inside a tool result, in either the Anthropic or the MCP shape. */
function shots(content: unknown, label: string): Ev[] {
  if (!Array.isArray(content)) return [];
  const out: Ev[] = [];
  for (const c of content) {
    if (c?.type !== "image") continue;
    const data = c.source?.data ?? c.data;
    const mime = c.source?.media_type ?? c.mimeType ?? "image/png";
    if (typeof data === "string" && data) out.push({ t: "shot", url: `data:${mime};base64,${data}`, label });
  }
  return out;
}

/** `mcp__server__tool` → what a person would call it. */
function mcpTool(name: string): { kind: ActKind; label: string } {
  const [, server = "", tool = ""] = name.split("__");
  const what = tool.replace(/_/g, " ") || "a tool";
  if (/chrome|browser|playwright|puppeteer|ego/i.test(server)) return { kind: "search", label: `Using the browser: ${what}` };
  if (/computer|desktop|screen/i.test(server)) return { kind: "run", label: `Using the computer: ${what}` };
  return { kind: "other", label: `Using ${server.replace(/[_-]/g, " ")}: ${what}` };
}

function claudeTool(name: string, input: any): { kind: ActKind; label: string; file?: string; cmd?: string } {
  if (name.startsWith("mcp__")) return mcpTool(name);
  switch (name) {
    case "Write":
      return { kind: "edit", label: `Writing ${base(input?.file_path)}`, file: input?.file_path };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "edit", label: `Editing ${base(input?.file_path ?? input?.notebook_path)}`, file: input?.file_path };
    case "Read":
      return { kind: "read", label: `Reading ${base(input?.file_path)}` };
    case "Bash":
      return { kind: "run", label: input?.description ? clip(String(input.description)) : `Running ${shortCommand(input?.command)}`, cmd: typeof input?.command === "string" ? input.command : undefined };
    case "Grep":
    case "Glob":
      return { kind: "read", label: "Searching the files" };
    case "WebSearch":
      return { kind: "search", label: "Searching the web" };
    case "WebFetch":
      return { kind: "search", label: "Reading a web page" };
    case "TodoWrite":
      return { kind: "other", label: "Updating its plan" };
    case "Task":
    case "Agent":
      return { kind: "other", label: "Handing part of this to a helper" };
    default:
      return { kind: "other", label: `Using ${name}` };
  }
}

/**
 * `claude -p` with JSON lines both ways. Text arrives as deltas, tools as content blocks, and
 * when a tool needs the person's OK Claude Code sends a `control_request` and waits for our answer.
 */
const claude: Adapter = {
  command(prompt, sessionId, opts) {
    const mode = { ask: "manual", edits: "acceptEdits", auto: "auto", free: "bypassPermissions", plan: "plan" }[opts?.trust ?? "edits"];
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-mode", mode, "--permission-prompt-tool", "stdio",
    ];
    if (opts?.model) args.push("--model", opts.model);
    if (opts?.effort) args.push("--effort", opts.effort);
    // Only settings that live in the conversation folder apply: none of the person's own skills, hooks or MCP servers.
    if (opts?.plain) args.push("--setting-sources", "project");
    if (sessionId) args.push("--resume", sessionId);
    return { program: "claude", args, input: JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n" };
  },
  reply(id, allow, input) {
    const response = allow ? { behavior: "allow", updatedInput: input ?? {} } : { behavior: "deny", message: "The person did not allow this. Do not try it another way; carry on without it or ask them what to do." };
    return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  },
  parser() {
    let spoke = false;
    let finished = false;
    const seenTools = new Set<string>();
    const toolLabels = new Map<string, string>();
    const errLines: string[] = [];
    return {
      stdout(line) {
        const o = parseJson(line);
        if (!o) return [];
        const out: Ev[] = [];
        if (o.type === "system" && o.subtype === "init" && o.session_id) {
          out.push({ t: "session", id: o.session_id });
        } else if (o.type === "stream_event" && o.event) {
          const e = o.event;
          if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
            out.push({ t: "delta", text: e.delta.text });
            spoke = true;
          } else if (e.type === "content_block_start" && e.content_block?.type === "thinking") {
            out.push({ t: "activity", kind: "think", label: "Thinking it through" });
          } else if (e.type === "content_block_start" && e.content_block?.type === "text" && spoke) {
            out.push({ t: "delta", text: "\n\n" });
          }
        } else if (o.type === "assistant" && Array.isArray(o.message?.content)) {
          for (const block of o.message.content) {
            if (block?.type !== "tool_use" || seenTools.has(block.id)) continue;
            seenTools.add(block.id);
            const tool = claudeTool(String(block.name), block.input);
            toolLabels.set(block.id, tool.label);
            out.push({ t: "activity", kind: tool.kind, label: tool.label, cmd: tool.cmd });
            if (typeof tool.file === "string") out.push({ t: "file", path: tool.file });
          }
        } else if (o.type === "user" && Array.isArray(o.message?.content)) {
          // Tool results come back as a user turn. Any picture in them goes to the Stage.
          for (const block of o.message.content) {
            if (block?.type === "tool_result") out.push(...shots(block.content, toolLabels.get(block.tool_use_id) ?? "Screen"));
          }
        } else if (o.type === "control_request" && o.request_id) {
          if (o.request?.subtype === "can_use_tool") {
            out.push({ t: "ask", id: o.request_id, tool: String(o.request.tool_name), input: o.request.input });
          } else {
            // Anything else Cube does not handle: say so at once, so Claude Code never waits on it.
            out.push({ t: "send", line: JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: o.request_id, error: "Not supported by Cube." } }) });
          }
        } else if (o.type === "result") {
          finished = true;
          if (o.session_id) out.push({ t: "session", id: o.session_id });
          if (o.usage || typeof o.total_cost_usd === "number") {
            const u = o.usage ?? {};
            const read = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            out.push({ t: "usage", in: read || undefined, out: u.output_tokens, cost: typeof o.total_cost_usd === "number" ? o.total_cost_usd : undefined });
          }
          if (o.is_error) out.push({ t: "error", message: String(o.result ?? "Claude Code stopped with an error.") });
          else if (!spoke && typeof o.result === "string" && o.result) out.push({ t: "delta", text: o.result });
          out.push({ t: "end" });
        }
        return out;
      },
      stderr(line) {
        if (line.trim()) errLines.push(line.trim());
        return [];
      },
      exit(code) {
        if (code && !finished) return [{ t: "error", message: errLines.slice(-3).join("\n") || `Claude Code exited with code ${code}.` }];
        return [];
      },
    };
  },
};

/** `hermes chat -q … -Q`: prints only the final reply, then a `session_id:` line. No live events. */
const hermes: Adapter = {
  command(prompt, sessionId, opts) {
    const args = ["chat", "-q", prompt, "-Q"];
    if (opts?.model) args.push("-m", opts.model);
    if (opts?.trust === "free") args.push("--yolo");
    if (sessionId) args.push("--resume", sessionId);
    return { program: "hermes", args };
  },
  parser() {
    const errLines: string[] = [];
    const session = (line: string): Ev[] | null => {
      const m = line.match(/^session_id:\s*(\S+)/);
      return m ? [{ t: "session", id: m[1] }] : null;
    };
    return {
      stdout(line) {
        return session(line) ?? [{ t: "delta", text: line + "\n" }];
      },
      stderr(line) {
        const s = session(line);
        if (s) return s;
        if (line.trim()) errLines.push(line.trim());
        return [];
      },
      exit(code) {
        if (code) return [{ t: "error", message: errLines.join("\n").replace(/^Error:\s*/, "") || `Hermes exited with code ${code}.` }];
        return [];
      },
    };
  },
};

export const ADAPTERS: Record<Exclude<AgentKind, "api" | "custom" | "remote">, Adapter> = { codex, claude, hermes };
