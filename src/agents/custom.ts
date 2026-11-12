import type { ActKind, Adapter, Ev, Parser, RunOpts } from "./types";

/**
 * A program of the person's own, connected to Cube as an agent. It is described by a small JSON
 * file in ~/CubeSpaces/.agents. See docs/custom-agents.md for the whole contract.
 */
export interface Manifest {
  id: string;
  name: string;
  program: string;
  /** Arguments for a run. `{prompt}`, `{session}`, `{model}` and `{trust}` are filled in. */
  args: string[];
  /** Extra arguments added when Cube has a session id from an earlier run. */
  resumeArgs: string[];
  /**
   * "text": whatever the program prints is the reply.
   * "cube": the program prints one JSON event per line and reads answers from its input.
   */
  protocol: "text" | "cube";
  /** Send the request as a JSON line on the program's input instead of (or besides) arguments. */
  stdin: boolean;
}

const words = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** A manifest file's content as a manifest, or what is wrong with it. */
export function parseManifest(file: string, json: unknown): Manifest | { error: string } {
  const o = json as Record<string, unknown> | null;
  const bad = (what: string) => ({ error: `${file}: ${what}` });
  if (!o || typeof o !== "object") return bad("is not a JSON object.");
  if (typeof o.program !== "string" || !o.program.trim()) return bad('needs a "program" to run.');
  const args = o.args === undefined ? [] : words(o.args);
  const resumeArgs = o.resumeArgs === undefined ? [] : words(o.resumeArgs);
  if (!args || !resumeArgs) return bad('"args" and "resumeArgs" must be lists of strings.');
  const protocol = o.protocol === undefined ? "text" : o.protocol;
  if (protocol !== "text" && protocol !== "cube") return bad('"protocol" must be "text" or "cube".');
  const stdin = Boolean(o.stdin);
  if (!stdin && !args.some((a) => a.includes("{prompt}"))) return bad('must take the request somewhere: put {prompt} in "args", or set "stdin" to true.');
  const id = file.replace(/\.json$/, "");
  return { id, name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : id, program: o.program.trim(), args, resumeArgs, protocol, stdin };
}

const ACTS: ActKind[] = ["think", "read", "edit", "run", "search", "other"];
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** One line a program printed in the "cube" protocol, as the event it stands for. Anything else is dropped. */
export function readEvent(line: string): Ev | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  switch (o?.t) {
    case "session": return text(o.id) ? { t: "session", id: o.id } : null;
    case "delta": return text(o.text) ? { t: "delta", text: o.text } : null;
    case "activity": return text(o.label) ? { t: "activity", kind: ACTS.includes(o.kind) ? o.kind : "other", label: o.label, cmd: text(o.cmd) || undefined } : null;
    case "file": return text(o.path) ? { t: "file", path: o.path } : null;
    // Only pictures carried in the line itself: a program cannot make Cube load something from the network.
    case "shot": return text(o.url).startsWith("data:image/") ? { t: "shot", url: o.url, label: text(o.label) || "Screen" } : null;
    case "ask": return text(o.id) && text(o.tool) ? { t: "ask", id: o.id, tool: o.tool, input: o.input ?? {} } : null;
    case "usage": return { t: "usage", in: Number(o.in) || undefined, out: Number(o.out) || undefined, cost: Number(o.cost) || undefined };
    case "error": return { t: "error", message: text(o.message) || "The agent reported a problem." };
    case "end": return { t: "end" };
    default: return null;
  }
}

/** How Cube starts and reads a custom agent. */
export function customAdapter(m: Manifest): Adapter {
  const parser = (): Parser => {
    const errLines: string[] = [];
    let failed = false;
    return {
      stdout(line) {
        if (m.protocol === "cube") {
          const ev = readEvent(line);
          if (ev?.t === "error") failed = true;
          return ev ? [ev] : [];
        }
        const session = line.match(/^session_id:\s*(\S+)\s*$/);
        return session ? [{ t: "session", id: session[1] }] : [{ t: "delta", text: `${line}\n` }];
      },
      stderr(line) {
        if (line.trim()) errLines.push(line.trim());
        return [];
      },
      exit(code) {
        return code && !failed ? [{ t: "error", message: errLines.slice(-3).join("\n") || `${m.name} exited with code ${code}.` }] : [];
      },
      reply: (id, allow, input) => JSON.stringify({ t: "answer", id, allow, input: input ?? {} }),
    };
  };
  return {
    command(prompt, sessionId, opts?: RunOpts) {
      const fill = (arg: string) => arg.replace(/\{prompt\}/g, prompt).replace(/\{session\}/g, sessionId ?? "").replace(/\{model\}/g, opts?.model ?? "").replace(/\{trust\}/g, opts?.trust ?? "edits");
      const args = [...m.args, ...(sessionId ? m.resumeArgs : [])].map(fill);
      const input = m.stdin ? `${JSON.stringify({ t: "prompt", text: prompt, session: sessionId ?? null, model: opts?.model ?? null, effort: opts?.effort ?? null, trust: opts?.trust ?? "edits" })}\n` : undefined;
      return { program: m.program, args, input };
    },
    parser,
  };
}
