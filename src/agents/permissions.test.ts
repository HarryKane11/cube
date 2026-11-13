import { describe, expect, it } from "vitest";
import { ADAPTERS } from "./adapters";
import { allowedBy, describeAsk, questionsOf, ruleFor, ruleLabel } from "./permissions";
import { trustFor, type Trust } from "./types";

describe("describeAsk", () => {
  it("words a request so a person can judge it", () => {
    expect(describeAsk("Bash", { command: "pnpm test" })).toEqual({ title: "Run a command", detail: "pnpm test" });
    expect(describeAsk("WebFetch", { url: "https://example.com" })).toEqual({ title: "Open a web page", detail: "https://example.com" });
    expect(describeAsk("mcp__claude-in-chrome__navigate", { url: "https://example.com" })).toEqual({
      title: "Use the browser: navigate",
      detail: '{"url":"https://example.com"}',
    });
  });
});

// The request below is a trimmed copy of what Claude Code really sent.
describe("questions from an agent", () => {
  const input = { questions: [{ question: "Do you prefer tea or coffee?", header: "Drink", options: [{ label: "Tea", description: "You prefer tea." }, { label: "Coffee" }], multiSelect: false }] };

  it("reads the question and its suggested answers", () => {
    expect(questionsOf("AskUserQuestion", input)).toEqual([
      { question: "Do you prefer tea or coffee?", multi: false, options: [{ label: "Tea", description: "You prefer tea." }, { label: "Coffee", description: undefined }] },
    ]);
  });

  it("is not a question when another tool asks, or when the shape is off", () => {
    expect(questionsOf("Bash", { command: "ls" })).toBeNull();
    expect(questionsOf("AskUserQuestion", { questions: "nope" })).toBeNull();
  });

  it("can never be answered by a lasting rule", () => {
    expect(ruleFor("AskUserQuestion", input)).toBeNull();
    expect(allowedBy(["tool:AskUserQuestion"], "AskUserQuestion", input)).toBe(false);
  });
});

describe("always-allow rules", () => {
  it("keeps the subcommand, so allowing `git status` does not allow `git push`", () => {
    expect(ruleFor("Bash", { command: "git status --short" })?.rule).toBe("command:git status");
    expect(allowedBy(["command:git status"], "Bash", { command: "git status" })).toBe(true);
    expect(allowedBy(["command:git status"], "Bash", { command: "git push --force" })).toBe(false);
  });

  it("never covers a command that chains, pipes, redirects or substitutes", () => {
    for (const command of ["git status && rm -rf .", "git status; curl x", "git status | sh", "git status > out", "git $(whoami)", "git `id`"]) {
      expect(ruleFor("Bash", { command })).toBeNull();
      expect(allowedBy(["command:git status", "command:git"], "Bash", { command })).toBe(false);
    }
  });

  it("offers no lasting rule for commands that delete, fetch or run other code", () => {
    for (const command of ["rm -rf build", "sudo make install", "curl https://example.com", "python3 script.py", "sh run.sh"]) {
      expect(ruleFor("Bash", { command })).toBeNull();
    }
  });

  it("groups file changes, and a whole MCP server, under one rule each", () => {
    expect(ruleFor("Write", { file_path: "/a" })?.rule).toBe("edits");
    expect(allowedBy(["edits"], "Edit", { file_path: "/b" })).toBe(true);
    expect(ruleFor("mcp__claude-in-chrome__navigate", {})).toEqual({ rule: "server:claude-in-chrome", label: "Always allow the browser" });
    expect(allowedBy(["server:claude-in-chrome"], "mcp__claude-in-chrome__left_click", {})).toBe(true);
    expect(allowedBy(["server:claude-in-chrome"], "mcp__computer-use__left_click", {})).toBe(false);
  });

  it("allows nothing when the role has no rules", () => {
    expect(allowedBy([], "Bash", { command: "ls" })).toBe(false);
    expect(allowedBy([], "WebSearch", { query: "x" })).toBe(false);
  });

  it("names stored rules for the profile", () => {
    expect(["edits", "command:pnpm test", "server:claude-in-chrome", "tool:WebFetch"].map(ruleLabel)).toEqual([
      "Change files",
      "Run pnpm test",
      "Use the browser",
      "Open web pages",
    ]);
  });
});

// The request line below is a trimmed copy of what Claude Code really sent.
describe("claude permission protocol", () => {
  const request =
    '{"type":"control_request","request_id":"r-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"date > probe.txt"},"tool_use_id":"tu1"}}';

  it("turns a permission request into an ask event", () => {
    expect(ADAPTERS.claude.parser().stdout(request)).toEqual([{ t: "ask", id: "r-1", tool: "Bash", input: { command: "date > probe.txt" } }]);
  });

  it("answers with the original input when allowed and a reason when not", () => {
    const allow = JSON.parse(ADAPTERS.claude.reply!("r-1", true, { command: "ls" }));
    expect(allow).toEqual({ type: "control_response", response: { subtype: "success", request_id: "r-1", response: { behavior: "allow", updatedInput: { command: "ls" } } } });
    const deny = JSON.parse(ADAPTERS.claude.reply!("r-1", false, {}));
    expect(deny.response.response.behavior).toBe("deny");
    expect(deny.response.response.message).toMatch(/did not allow/);
  });

  it("refuses control requests it does not know at once, so the agent never hangs on one", () => {
    const [ev] = ADAPTERS.claude.parser().stdout('{"type":"control_request","request_id":"r-2","request":{"subtype":"something_new"}}');
    expect(ev.t).toBe("send");
    expect(JSON.parse((ev as { line: string }).line).response).toMatchObject({ subtype: "error", request_id: "r-2" });
  });

  it("sends the prompt on stdin and says when the turn is over", () => {
    const cmd = ADAPTERS.claude.command("hello");
    expect(cmd.args).not.toContain("hello");
    expect(JSON.parse(cmd.input!)).toEqual({ type: "user", message: { role: "user", content: "hello" } });
    expect(ADAPTERS.claude.parser().stdout('{"type":"result","is_error":false,"result":"Done.","session_id":"s"}').slice(-1)).toEqual([{ t: "end" }]);
  });
});

describe("conversation modes", () => {
  it("lets the mode decide, and in Manual falls back to the role's own setting", () => {
    expect(trustFor("auto", "ask")).toBe("auto");
    expect(trustFor("bypass", "ask")).toBe("free");
    expect(trustFor("manual", "ask")).toBe("ask");
    expect(trustFor("manual", undefined)).toBe("edits");
    // A role can no longer be set to skip asking by itself: only the mode can do that.
    expect(trustFor("manual", "free")).toBe("edits");
  });
});

describe("trust levels", () => {
  it("map to each program's own modes", () => {
    const mode = (trust: Trust) => {
      const args = ADAPTERS.claude.command("x", undefined, { trust }).args;
      return args[args.indexOf("--permission-mode") + 1];
    };
    expect([mode("ask"), mode("edits"), mode("auto"), mode("free")]).toEqual(["manual", "acceptEdits", "auto", "bypassPermissions"]);
    const codex = (trust: Trust) => {
      const sent = ADAPTERS.codex.command("x", undefined, { trust }).parser!.stdout('{"id":1,"result":{}}');
      const start = sent.map((e) => (e.t === "send" ? JSON.parse(e.line) : null)).find((m) => m?.method === "thread/start");
      return `${start.params.sandbox}/${start.params.approvalPolicy}`;
    };
    expect([codex("ask"), codex("edits"), codex("auto"), codex("free"), codex("plan")]).toEqual([
      "read-only/untrusted", "workspace-write/untrusted", "workspace-write/on-request", "danger-full-access/never", "read-only/never",
    ]);
    expect(mode("plan")).toBe("plan");
    expect(ADAPTERS.hermes.command("x", undefined, { trust: "free" }).args).toContain("--yolo");
    expect(ADAPTERS.hermes.command("x", undefined, { trust: "edits" }).args).not.toContain("--yolo");
  });
});
