import { describe, expect, it } from "vitest";
import { parseCsv } from "../lib/files";
import { ADAPTERS } from "./adapters";

// The sample lines below are trimmed copies of real output captured from each CLI.

describe("codex adapter", () => {
  const sends = (evs: { t: string; line?: string }[]) => evs.filter((e) => e.t === "send").map((e) => JSON.parse(e.line!));

  it("opens the app server, then a thread sized by trust, then a turn with the request", () => {
    const run = ADAPTERS.codex.command("hi", undefined, { trust: "ask", model: "gpt-x", effort: "high" });
    expect(run.args).toEqual(["app-server"]);
    expect(JSON.parse(run.input!).method).toBe("initialize");
    const p = run.parser!;
    expect(sends(p.stdout('{"id":1,"result":{"userAgent":"cube"}}'))).toEqual([
      { method: "initialized" },
      { id: 2, method: "thread/start", params: { approvalPolicy: "untrusted", sandbox: "read-only", model: "gpt-x" } },
    ]);
    const started = p.stdout('{"id":2,"result":{"thread":{"id":"t-1"}}}');
    expect(started[0]).toEqual({ t: "session", id: "t-1" });
    // Along with the turn it asks how much of the plan is left: that needs no turn of its own.
    expect(sends(started)).toEqual([{ id: 9, method: "account/rateLimits/read" }, { id: 3, method: "turn/start", params: { threadId: "t-1", input: [{ type: "text", text: "hi", text_elements: [] }], effort: "high" } }]);
  });

  it("passes on the plan's limits, the model it runs on and its list of steps", () => {
    const p = ADAPTERS.codex.command("hi", undefined, {}).parser!;
    p.stdout('{"id":1,"result":{}}');
    expect(p.stdout('{"id":2,"result":{"thread":{"id":"t-1"},"model":"gpt-x"}}')).toContainEqual({ t: "model", model: "gpt-x" });
    const limits = { rateLimits: { planType: "pro", primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1800000000 } } };
    expect(p.stdout(JSON.stringify({ id: 9, result: limits }))).toEqual([{ t: "limits", program: "codex", how: "read", raw: limits }]);
    expect(p.stdout(JSON.stringify({ method: "account/rateLimits/updated", params: limits }))).toEqual([{ t: "limits", program: "codex", how: "event", raw: limits }]);
    expect(p.stdout(JSON.stringify({ method: "turn/plan/updated", params: { threadId: "t-1", turnId: "u", plan: [{ step: "Read the code", status: "completed" }, { step: "Fix it", status: "inProgress" }, { step: "Test", status: "pending" }] } }))).toEqual([
      { t: "todo", items: [{ text: "Read the code", state: "done" }, { text: "Fix it", state: "doing" }, { text: "Test", state: "pending" }] },
    ]);
  });

  it("resumes a session, and starts a new thread when the old one is gone", () => {
    const p = ADAPTERS.codex.command("hi", "old", { trust: "free" }).parser!;
    expect(sends(p.stdout('{"id":1,"result":{}}'))[1]).toEqual({ id: 2, method: "thread/resume", params: { threadId: "old", approvalPolicy: "never", sandbox: "danger-full-access", model: null } });
    expect(sends(p.stdout('{"id":2,"error":{"code":-32600,"message":"no such thread"}}'))[0].method).toBe("thread/start");
  });

  it("streams text, names what it does and ends with the turn", () => {
    const p = ADAPTERS.codex.command("hi").parser!;
    expect(p.stdout('{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"Fir"}}')).toEqual([{ t: "delta", text: "Fir" }]);
    // A second message in the same run starts a new paragraph.
    expect(p.stdout('{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m2","text":""}}}')).toEqual([{ t: "delta", text: "\n\n" }]);
    expect(p.stdout(`{"method":"item/started","params":{"item":{"type":"commandExecution","id":"e1","command":"/bin/zsh -lc 'cat hello.md'"}}}`)).toEqual([
      { t: "activity", kind: "run", label: "Running cat hello.md", cmd: "/bin/zsh -lc 'cat hello.md'" },
    ]);
    expect(p.stdout('{"method":"item/started","params":{"item":{"type":"fileChange","id":"f1","changes":[{"path":"/s/hello.md","kind":{"type":"add"},"diff":""}]}}}')).toEqual([
      { t: "activity", kind: "edit", label: "Writing hello.md" },
      { t: "file", path: "/s/hello.md" },
    ]);
    p.stdout('{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"inputTokens":120,"outputTokens":8}}}}');
    expect(p.stdout('{"method":"turn/completed","params":{"turn":{"id":"u1","status":"completed","error":null}}}')).toEqual([{ t: "usage", in: 120, out: 8 }, { t: "end" }]);
    expect(p.exit(0)).toEqual([]);
  });

  it("asks before a command and answers in the form Codex expects", () => {
    const p = ADAPTERS.codex.command("hi").parser!;
    const ask = p.stdout(`{"method":"item/commandExecution/requestApproval","id":0,"params":{"itemId":"e1","command":"/bin/zsh -lc 'date > probe.txt'","cwd":"/s"}}`);
    expect(ask).toEqual([{ t: "ask", id: "0", tool: "Bash", input: { command: "date > probe.txt", description: undefined } }]);
    expect(JSON.parse(p.reply!("0", true, {}))).toEqual({ id: 0, result: { decision: "accept" } });
    p.stdout('{"method":"item/started","params":{"item":{"type":"fileChange","id":"f1","changes":[{"path":"/s/a.md","kind":{"type":"update","move_path":null},"diff":""}]}}}');
    expect(p.stdout('{"method":"item/fileChange/requestApproval","id":"r2","params":{"itemId":"f1"}}')).toEqual([{ t: "ask", id: "r2", tool: "Edit", input: { file_path: "/s/a.md" } }]);
    expect(JSON.parse(p.reply!("r2", false, {}))).toEqual({ id: "r2", result: { decision: "decline" } });
  });

  it("passes on a question and keys the answer by the question's id", () => {
    const p = ADAPTERS.codex.command("hi").parser!;
    const ask = p.stdout('{"method":"item/tool/requestUserInput","id":7,"params":{"questions":[{"id":"q1","header":"Tone","question":"Which tone?","options":[{"label":"Warm","description":"Friendly"}]}]}}');
    expect(ask[0]).toEqual({ t: "ask", id: "7", tool: "AskUserQuestion", input: { questions: [{ question: "Which tone?", multiSelect: false, options: [{ label: "Warm", description: "Friendly" }] }] } });
    expect(JSON.parse(p.reply!("7", true, { answers: { "Which tone?": "Warm" } }))).toEqual({ id: 7, result: { answers: { q1: { answers: ["Warm"] } } } });
  });

  it("refuses requests it does not handle, and reports a turn that failed or was cut short", () => {
    const p = ADAPTERS.codex.command("hi").parser!;
    expect(sends(p.stdout('{"method":"mcpServer/elicitation/request","id":9,"params":{}}'))).toEqual([{ id: 9, error: { code: -32601, message: "Not supported by Cube." } }]);
    expect(p.stdout('{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"Out of credits."}}}}')).toEqual([{ t: "error", message: "Out of credits." }, { t: "end" }]);
    expect(ADAPTERS.codex.command("hi").parser!.exit(1)).toEqual([{ t: "error", message: "Codex stopped before it finished (code 1)." }]);
  });

  it("skips lines that are not JSON", () => {
    expect(ADAPTERS.codex.parser().stdout("Reading additional input from stdin...")).toEqual([]);
  });
});

describe("claude adapter", () => {
  it("streams text deltas and names tools from their input", () => {
    const p = ADAPTERS.claude.parser();
    expect(p.stdout('{"type":"system","subtype":"init","session_id":"s-1"}')).toEqual([{ t: "session", id: "s-1" }]);
    expect(p.stdout('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}')).toEqual([{ t: "delta", text: "Hel" }]);
    const tool = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"/s/readme.md"}}]}}';
    expect(p.stdout(tool)).toEqual([
      { t: "activity", kind: "edit", label: "Writing readme.md" },
      { t: "file", path: "/s/readme.md" },
    ]);
    // The same tool block arrives again with partial messages on; it must not repeat.
    expect(p.stdout(tool)).toEqual([]);
  });

  it("uses the final result only when nothing was streamed, and surfaces errors", () => {
    const quiet = ADAPTERS.claude.parser();
    expect(quiet.stdout('{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s-2"}')).toEqual([
      { t: "session", id: "s-2" },
      { t: "delta", text: "Done." },
      { t: "end" },
    ]);
    const failed = ADAPTERS.claude.parser();
    expect(failed.stdout('{"type":"result","is_error":true,"result":"Credit balance is too low"}')).toEqual([{ t: "error", message: "Credit balance is too low" }, { t: "end" }]);
  });
});

describe("claude adapter, beyond the reply", () => {
  it("passes on the model, the plan's limits and its list of steps", () => {
    const p = ADAPTERS.claude.parser();
    expect(p.stdout('{"type":"system","subtype":"init","session_id":"s-1","model":"claude-opus-5-5"}')).toEqual([{ t: "session", id: "s-1" }, { t: "model", model: "claude-opus-5-5" }]);
    const info = { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1800000000 };
    expect(p.stdout(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info }))).toEqual([{ t: "limits", program: "claude", how: "event", raw: info }]);
    const todo = { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "TodoWrite", input: { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }] } }] } };
    expect(p.stdout(JSON.stringify(todo))).toEqual([{ t: "todo", items: [{ text: "Read", state: "done" }, { text: "Write", state: "doing" }] }]);
  });
});

describe("run options", () => {
  it("passes the role's model and effort to each program in its own way", () => {
    expect(ADAPTERS.claude.command("hi", undefined, { model: "sonnet", effort: "high" }).args).toEqual(
      expect.arrayContaining(["--model", "sonnet", "--effort", "high"]),
    );
    // Codex takes its model with the thread and its effort with the turn: see the codex adapter tests.
    expect(ADAPTERS.hermes.command("hi", undefined, { model: "m-1" }).args).toEqual(["chat", "-q", "hi", "-Q", "-m", "m-1"]);
  });

  it("adds nothing when the role has no choices of its own", () => {
    expect(ADAPTERS.claude.command("hi", undefined, {}).args).toEqual(ADAPTERS.claude.command("hi").args);
    expect(ADAPTERS.codex.command("hi", undefined, { plain: false }).args).toEqual(ADAPTERS.codex.command("hi").args);
  });

  it("starts without the person's own setup when asked", () => {
    expect(ADAPTERS.claude.command("hi", undefined, { plain: true }).args).toEqual(expect.arrayContaining(["--setting-sources", "project"]));
  });
});

describe("pictures from tools", () => {
  it("turns an image in a Claude tool result into a shot named after the tool that made it", () => {
    const p = ADAPTERS.claude.parser();
    p.stdout('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu9","name":"mcp__claude-in-chrome__screenshot","input":{}}]}}');
    const result = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu9","content":[{"type":"text","text":"ok"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]}}';
    expect(p.stdout(result)).toEqual([{ t: "shot", url: "data:image/png;base64,AAAA", label: "Using the browser: screenshot" }]);
  });

  it("ignores tool results that carry only text", () => {
    const p = ADAPTERS.claude.parser();
    expect(p.stdout('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"plain text"}]}}')).toEqual([]);
  });

  it("reads MCP-shaped images from a finished Codex tool call", () => {
    const p = ADAPTERS.codex.parser();
    const done = '{"method":"item/completed","params":{"item":{"id":"i7","type":"mcpToolCall","server":"computer-use","tool":"screenshot","result":{"content":[{"type":"image","data":"BBBB","mimeType":"image/jpeg"}]}}}}';
    expect(p.stdout(done)).toEqual([{ t: "shot", url: "data:image/jpeg;base64,BBBB", label: "computer-use · screenshot" }]);
  });
});

describe("hermes adapter", () => {
  it("reads the reply from stdout and the session id from either stream", () => {
    const p = ADAPTERS.hermes.parser();
    expect(p.stdout("Hello there.")).toEqual([{ t: "delta", text: "Hello there.\n" }]);
    expect(p.stderr("session_id: 20261112_062311_63c16c")).toEqual([{ t: "session", id: "20261112_062311_63c16c" }]);
  });

  it("reports stderr as the error when it exits with a failure code", () => {
    const p = ADAPTERS.hermes.parser();
    p.stderr("Error: model_not_found");
    expect(p.exit(1)).toEqual([{ t: "error", message: "model_not_found" }]);
    expect(ADAPTERS.hermes.parser().exit(0)).toEqual([]);
  });
});

describe("parseCsv", () => {
  it("handles quoted cells with commas and escaped quotes", () => {
    expect(parseCsv('name,note\n"Kim, J","said ""hi"""\n')).toEqual([
      ["name", "note"],
      ["Kim, J", 'said "hi"'],
    ]);
  });

  it("switches to tabs when the first line has one", () => {
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});
