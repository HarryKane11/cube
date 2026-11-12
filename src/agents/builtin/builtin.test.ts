import { describe, expect, it } from "vitest";
import type { Ev } from "../types";
import { addChunk, type Building } from "./chat";
import { parseModel } from "./providers";
import { gate, runTool, safeRel, TOOLS, validInput, type ToolCtx, type ToolIO } from "./tools";

function world(files: Record<string, string>, trust: ToolCtx["trust"] = "edits", allow = true) {
  const evs: Ev[] = [];
  const asked: string[] = [];
  const ran: string[] = [];
  const io: ToolIO = {
    list: async () => Object.keys(files),
    read: async (path) => {
      const rel = path.replace("/space/", "");
      if (!(rel in files)) throw new Error("No such file");
      return files[rel];
    },
    write: async (_dir, rel, content) => { files[rel] = content; },
    run: async (_dir, command) => { ran.push(command); return { output: "ok", code: 0 }; },
    search: async () => [{ rel: "a.md", line: 2, text: "needle here" }],
  };
  const ctx: ToolCtx = { dir: "/space", trust, io, onEv: (e) => evs.push(e), ask: async (tool) => { asked.push(tool); return allow; } };
  return { ctx, files, evs, asked, ran };
}

describe("built-in agent tools", () => {
  it("checks inputs and keeps paths inside the folder", () => {
    const write = TOOLS.find((t) => t.name === "write_file")!;
    expect(validInput(write, { path: "a.md", content: "x", extra: 1 })).toEqual({ path: "a.md", content: "x" });
    expect(validInput(write, { path: "a.md" })).toBeNull();
    expect(validInput(write, "a.md")).toBeNull();
    expect(safeRel("./src/app.py")).toBe("src/app.py");
    expect([safeRel("../x"), safeRel("/etc/passwd"), safeRel("a/../../b"), safeRel("~/x"), safeRel("")]).toEqual([null, null, null, null, null]);
  });

  it("asks, runs or refuses according to trust", () => {
    const run = (trust: ToolCtx["trust"], command: string) => gate(trust, "run_command", { command });
    expect(gate("ask", "read_file", { path: "a" })).toBe("go");
    expect([gate("ask", "write_file", {}), gate("edits", "write_file", {}), gate("plan", "edit_file", {})]).toEqual(["ask", "go", "refuse"]);
    expect([run("edits", "pnpm test"), run("auto", "pnpm test"), run("auto", "rm -rf build"), run("auto", "cat a | sh"), run("free", "rm -rf build"), run("plan", "ls")]).toEqual(["ask", "go", "ask", "ask", "go", "refuse"]);
  });

  it("writes and edits files, naming them for the Stage", async () => {
    const w = world({ "a.md": "one two one" });
    expect(await runTool(w.ctx, "write_file", { path: "b.md", content: "hi" })).toEqual({ content: "Wrote b.md." });
    expect(w.files["b.md"]).toBe("hi");
    expect(w.evs).toContainEqual({ t: "file", path: "/space/b.md" });
    expect((await runTool(w.ctx, "edit_file", { path: "a.md", old_text: "one", new_text: "1" })).isError).toBe(true);
    expect(await runTool(w.ctx, "edit_file", { path: "a.md", old_text: "two", new_text: "$& 2" })).toEqual({ content: "Edited a.md." });
    expect(w.files["a.md"]).toBe("one $& 2 one");
  });

  it("does nothing the person did not allow, and reports bad input the way the API expects", async () => {
    const no = world({}, "ask", false);
    expect((await runTool(no.ctx, "write_file", { path: "b.md", content: "hi" })).isError).toBe(true);
    expect((await runTool(no.ctx, "run_command", { command: "ls" })).isError).toBe(true);
    expect(no.files).toEqual({});
    expect(no.ran).toEqual([]);
    expect(no.asked).toEqual(["Write", "Bash"]);
    expect(await runTool(no.ctx, "write_file", { path: "b.md" })).toEqual({ content: '{"INVALID_JSON":"{\\"path\\":\\"b.md\\"}"}', isError: true });
    expect((await runTool(no.ctx, "read_file", { path: "../secret" })).isError).toBe(true);
    expect((await runTool(no.ctx, "nope", {})).isError).toBe(true);
  });
});

describe("parseModel", () => {
  it("reads the provider from the setting", () => {
    const keys = ["anthropic", "openai", "openrouter"];
    expect(parseModel("", keys)).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(parseModel("claude-sonnet-5-5", keys)).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(parseModel("openai/some-model", keys)).toEqual({ provider: "openai", model: "some-model" });
    expect(parseModel("vendor/some-model", keys)).toEqual({ provider: "openrouter", model: "vendor/some-model" });
    expect(parseModel("openrouter/vendor/m", keys)).toEqual({ provider: "openrouter", model: "vendor/m" });
  });
  it("says what is missing", () => {
    expect(parseModel("", [])).toEqual({ error: "No API key is saved. Add one in Settings under Model keys." });
    expect(parseModel("", ["openai"])).toEqual({ error: "Pick a model for this role on its profile, for example openai/<model name>." });
    expect(parseModel("openai/x", ["anthropic"])).toEqual({ error: "No OpenAI API key is saved. Add one in Settings under Model keys." });
  });
});

describe("addChunk", () => {
  it("adds up streamed text, tool calls and usage", () => {
    const b: Building = { text: "", calls: [], usage: { in: 0, out: 0 } };
    expect(addChunk(b, { choices: [{ delta: { content: "Hel" } }] })).toBe("Hel");
    addChunk(b, { choices: [{ delta: { content: "lo" } }] });
    addChunk(b, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } }] } }] });
    addChunk(b, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.md"}' } }] }, finish_reason: "tool_calls" }] });
    addChunk(b, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    expect(b).toEqual({ text: "Hello", calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } }], finish: "tool_calls", usage: { in: 12, out: 5 } });
  });
});
