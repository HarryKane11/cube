import { describe, expect, it } from "vitest";
import { customAdapter, parseManifest, readEvent, type Manifest } from "./custom";

describe("custom agents", () => {
  it("reads a manifest and says what is wrong with a bad one", () => {
    expect(parseManifest("mine.json", { program: "mine", args: ["run", "{prompt}"] })).toEqual({ id: "mine", name: "mine", program: "mine", args: ["run", "{prompt}"], resumeArgs: [], protocol: "text", stdin: false });
    expect(parseManifest("a.json", { name: "A", program: "a", protocol: "cube", stdin: true })).toMatchObject({ name: "A", protocol: "cube", stdin: true });
    expect(parseManifest("a.json", { args: ["{prompt}"] })).toEqual({ error: 'a.json: needs a "program" to run.' });
    expect(parseManifest("a.json", { program: "a" })).toEqual({ error: 'a.json: must take the request somewhere: put {prompt} in "args", or set "stdin" to true.' });
    expect(parseManifest("a.json", { program: "a", args: "x" })).toEqual({ error: 'a.json: "args" and "resumeArgs" must be lists of strings.' });
  });

  const m = parseManifest("mine.json", { name: "Mine", program: "mine", args: ["--model", "{model}", "{prompt}"], resumeArgs: ["--session", "{session}"], protocol: "cube", stdin: true }) as Manifest;

  it("fills in the request and adds the resume arguments only with a session", () => {
    const adapter = customAdapter(m);
    expect(adapter.command("hi", undefined, { model: "m1" }).args).toEqual(["--model", "m1", "hi"]);
    const again = adapter.command("hi", "s9", { trust: "ask" });
    expect(again.args).toEqual(["--model", "", "hi", "--session", "s9"]);
    expect(JSON.parse(again.input!)).toEqual({ t: "prompt", text: "hi", session: "s9", model: null, effort: null, trust: "ask" });
  });

  it("takes events line by line and answers a request", () => {
    const p = customAdapter(m).parser();
    expect(p.stdout('{"t":"delta","text":"Hello"}')).toEqual([{ t: "delta", text: "Hello" }]);
    expect(p.stdout('{"t":"activity","kind":"dance","label":"Warming up"}')).toEqual([{ t: "activity", kind: "other", label: "Warming up", cmd: undefined }]);
    expect(p.stdout('{"t":"ask","id":"1","tool":"Bash","input":{"command":"ls"}}')).toEqual([{ t: "ask", id: "1", tool: "Bash", input: { command: "ls" } }]);
    expect(JSON.parse(p.reply!("1", true, { command: "ls" }))).toEqual({ t: "answer", id: "1", allow: true, input: { command: "ls" } });
    expect(p.stdout("plain text")).toEqual([]);
    expect(readEvent('{"t":"shot","url":"https://example.test/x.png"}')).toBeNull();
    expect(readEvent('{"t":"send","line":"x"}')).toBeNull();
    expect(p.exit(2)).toEqual([{ t: "error", message: "Mine exited with code 2." }]);
  });

  it("treats a text program's output as the reply", () => {
    const p = customAdapter({ ...m, protocol: "text" }).parser();
    expect(p.stdout("All done.")).toEqual([{ t: "delta", text: "All done.\n" }]);
    expect(p.stdout("session_id: abc")).toEqual([{ t: "session", id: "abc" }]);
  });
});
