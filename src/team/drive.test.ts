import { describe, expect, it } from "vitest";
import { copyName, fold, isInstructions, keyOf, madeBy, plan, readFileEvent, readList, retry, validPath, QUIET_MS, type Local, type Remote, type Step } from "./drive";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const ME = "1".repeat(64);
const SEAN = "2".repeat(64);
const NOW = 1_800_000_000_000;

const file = (rel: string, sha: string, extra: Partial<Local> = {}): Local => ({ rel, size: 10, mtime: NOW - 60_000, sha, ...extra });
const remote = (path: string, sha: string, extra: Partial<Remote> = {}): Remote => ({ path, sha, size: 10, seq: 5, pubkey: SEAN, at: NOW - 1000, ...(sha ? {} : { deleted: true }), ...extra });
const run = (local: Local[], remotes: Remote[], base: Record<string, string> = {}, opts: { gone?: boolean; accepted?: boolean } = {}): Step[] =>
  plan({ local, remote: Object.fromEntries(remotes.map((r) => [keyOf(r.path), r])), base, me: ME, now: NOW, gone: () => opts.gone ?? true, accepted: () => opts.accepted ?? false });

describe("what has to happen for a folder and the relay to agree", () => {
  it("sends up a file the relay has never seen", () => {
    expect(run([file("notes.md", A)], [])).toEqual([{ do: "upload", key: "notes.md", rel: "notes.md", path: "notes.md", base: "" }]);
  });

  it("takes a file a teammate added", () => {
    const r = remote("plan.md", A);
    expect(run([], [r])).toEqual([{ do: "download", key: "plan.md", rel: "plan.md", remote: r }]);
  });

  it("remembers agreement, and then has nothing to do", () => {
    expect(run([file("plan.md", A)], [remote("plan.md", A)])).toEqual([{ do: "settle", key: "plan.md", sha: A }]);
    expect(run([file("plan.md", A)], [remote("plan.md", A)], { "plan.md": A })).toEqual([]);
  });

  it("tells a change made here from one made there by what the two last agreed on", () => {
    // Changed here: the relay still has what this copy started from.
    expect(run([file("plan.md", B)], [remote("plan.md", A)], { "plan.md": A })).toEqual([{ do: "upload", key: "plan.md", rel: "plan.md", path: "plan.md", base: A }]);
    // Changed there: this copy is still what was agreed on, and may be replaced only while it stays so.
    const r = remote("plan.md", B);
    expect(run([file("plan.md", A)], [r], { "plan.md": A })).toEqual([{ do: "download", key: "plan.md", rel: "plan.md", remote: r, expect: A }]);
  });

  it("merges when both sides changed, from the version both started from", () => {
    const r = remote("plan.md", C);
    expect(run([file("plan.md", B)], [r], { "plan.md": A })).toEqual([{ do: "merge", key: "plan.md", rel: "plan.md", remote: r, base: A }]);
    // Never agreed before (the same name made on both sides): there is no common start.
    expect(run([file("plan.md", B)], [r])).toEqual([{ do: "merge", key: "plan.md", rel: "plan.md", remote: r }]);
  });

  it("shares a delete made here only once the file has stayed gone, and never over a newer version", () => {
    const r = remote("plan.md", A);
    expect(run([], [r], { "plan.md": A })).toEqual([{ do: "drop", key: "plan.md", rel: "plan.md", path: "plan.md", base: A }]);
    // A save that replaces the file makes it vanish for a moment.
    expect(run([], [r], { "plan.md": A }, { gone: false })).toEqual([]);
    // They changed it after this copy was deleted: their version comes back.
    const newer = remote("plan.md", B);
    expect(run([], [newer], { "plan.md": A })).toEqual([{ do: "download", key: "plan.md", rel: "plan.md", remote: newer }]);
  });

  it("follows a teammate's delete only when this copy is the version they deleted", () => {
    const gone = remote("plan.md", "");
    expect(run([file("plan.md", A)], [gone], { "plan.md": A })).toEqual([{ do: "remove", key: "plan.md", rel: "plan.md", expect: A }]);
    // Changed here since: the work is kept and goes up as the file again.
    expect(run([file("plan.md", B)], [gone], { "plan.md": A })).toEqual([{ do: "upload", key: "plan.md", rel: "plan.md", path: "plan.md", base: "" }]);
    // Gone on both sides: only the memory of it is cleared.
    expect(run([], [gone], { "plan.md": A })).toEqual([{ do: "settle", key: "plan.md", sha: "" }]);
  });

  it("waits for a file that was written a moment ago", () => {
    const fresh = file("draft.md", A, { mtime: NOW - (QUIET_MS - 500) });
    expect(run([fresh], [])).toEqual([{ do: "wait", key: "draft.md", rel: "draft.md", path: "draft.md" }]);
    // What comes down does not wait: this copy is not the one being written.
    const r = remote("draft.md", B);
    expect(run([fresh], [r], { "draft.md": A })[0].do).toBe("download");
  });

  it("holds an instruction file a teammate changed until the person says yes", () => {
    const r = remote("CLAUDE.md", B);
    expect(run([], [r])).toEqual([{ do: "hold", key: "claude.md", rel: "CLAUDE.md", remote: r }]);
    expect(run([file("CLAUDE.md", A)], [r], { "claude.md": A })).toEqual([{ do: "hold", key: "claude.md", rel: "CLAUDE.md", remote: r }]);
    expect(run([], [r], {}, { accepted: true })[0].do).toBe("download");
    // This person's own, coming back from another of their computers or after a restore, is not held.
    expect(run([], [remote("CLAUDE.md", B, { pubkey: ME })])[0].do).toBe("download");
    // And their own change to it goes up like any other.
    expect(run([file("CLAUDE.md", C)], [remote("CLAUDE.md", A)], { "claude.md": A })[0].do).toBe("upload");
  });

  it("leaves alone what is never shared or could not be read", () => {
    expect(run([file("server.pem", A, { skip: "secret" }), file("huge.mov", A, { skip: "big" }), { rel: "locked.md", size: 1, mtime: 0 }], [remote("huge.mov", B)])).toEqual([]);
  });

  it("treats two spellings of a name as one file", () => {
    const r = remote("README.md", A);
    expect(run([file("readme.md", A)], [r])).toEqual([{ do: "settle", key: "readme.md", sha: A }]);
    // The same Korean name, composed and decomposed.
    expect(keyOf("보고서.md".normalize("NFD"))).toBe(keyOf("보고서.md".normalize("NFC")));
  });
});

describe("what the relay says about files", () => {
  const event = (kind: string, body: unknown, extra = {}) => ({ seq: 9, id: "e", pubkey: SEAN, created_at: 1_800_000_000, kind, body: JSON.stringify(body), ...extra });

  it("reads a put and a drop, and nothing malformed", () => {
    expect(readFileEvent(event("file.put", { conv: "c1", path: "a/plan.md", sha: A, size: 12, by: { agent: "Builder", color: "#0a84ff" } }))).toEqual({ sharedId: "c1", remote: { path: "a/plan.md", sha: A, size: 12, seq: 9, pubkey: SEAN, at: 1_800_000_000_000, by: { agent: "Builder", color: "#0a84ff" } } });
    expect(readFileEvent(event("file.drop", { conv: "c1", path: "a/plan.md" }))?.remote).toMatchObject({ sha: "", deleted: true });
    for (const bad of [{ conv: "c1", path: "../x", sha: A, size: 1 }, { conv: "c1", path: "x", sha: "nope", size: 1 }, { conv: "", path: "x", sha: A, size: 1 }, { conv: "c1", path: ".env", sha: A, size: 1 }, { conv: "c1", path: "x", sha: A }]) {
      expect(readFileEvent(event("file.put", bad))).toBeNull();
    }
    expect(readFileEvent(event("msg.post", { conv: "c1" }))).toBeNull();
    expect(readFileEvent(event("file.put", { conv: "c1", path: "x", sha: A, size: 1 }, { redacted: true }))).toBeNull();
  });

  it("keeps the newest version of each file, whatever order the news comes in", () => {
    const first = remote("plan.md", A, { seq: 3 });
    const second = remote("Plan.md", B, { seq: 7 });
    const view = fold(fold({}, [second]), [first]);
    expect(view["plan.md"]).toBe(second);
    expect(fold(view, [first])).toBe(view);
    expect(fold(view, [remote("../x", A, { seq: 99 })])).toBe(view);
  });

  it("reads a list and a history, deletions included", () => {
    const list = readList([{ path: "a.md", sha: A, size: 3, seq: 4, pubkey: SEAN, created_at: 1_800_000_000, by: null }, { path: "b.md", sha: null, size: 0, seq: 6, pubkey: ME, created_at: 1_800_000_001, deleted: true }, { path: "c.md", sha: "x", seq: 1, pubkey: ME }, null]);
    expect(list.map((r) => [r.path, r.sha, Boolean(r.deleted)])).toEqual([["a.md", A, false], ["b.md", "", true]]);
    expect(readList(undefined)).toEqual([]);
  });
});

describe("names, people and refusals", () => {
  it("accepts plain paths only", () => {
    for (const ok of ["notes.md", "src/app.py", "보고서/1분기 요약.md"]) expect(validPath(ok)).toBe(true);
    for (const bad of ["", "/abs", "a/../b", ".git/config", "a\\b", "a/\u0007", "end. ", "dot.", "node_modules/x", "~$x.docx", "a..b.md", "a/b/c/d/e/f/g/h/i", "x".repeat(301), 5]) expect(validPath(bad)).toBe(false);
  });

  it("knows the files agent programs read as instructions, wherever they sit", () => {
    for (const p of ["CLAUDE.md", "docs/Agents.md", "GEMINI.md", "a/b/claude.local.md"]) expect(isInstructions(p)).toBe(true);
    for (const p of ["README.md", "claude.md.bak", "my-agents.md"]) expect(isInstructions(p)).toBe(false);
  });

  it("names the copy kept when two versions could not be put together", () => {
    expect(copyName("docs/plan.md", "Kane")).toBe("docs/plan (Kane).md");
    expect(copyName("Makefile", "Kane")).toBe("Makefile (Kane)");
    expect(copyName("a.b/readme", "Sean / K.")).toBe("a.b/readme (Sean  K)");
    expect(copyName("x.md", "  ")).toBe("x (copy).md");
  });

  it("says who a version is from", () => {
    const members = [{ pubkey: ME, name: "Kane", role: "owner" as const }, { pubkey: SEAN, name: "Sean", role: "member" as const }];
    expect(madeBy({ pubkey: SEAN, by: { agent: "Builder" } }, ME, members, "ko")).toBe("Sean의 Builder");
    expect(madeBy({ pubkey: SEAN, by: { agent: "Builder" } }, ME, members, "en")).toBe("Sean's Builder");
    expect(madeBy({ pubkey: SEAN }, ME, members, "ko")).toBe("Sean");
    expect(madeBy({ pubkey: ME, by: { agent: "Writer" } }, ME, members, "ko")).toBe("Writer");
    expect(madeBy({ pubkey: ME }, ME, members, "ko")).toBe("나");
  });

  it("knows which refusals are worth trying again", () => {
    expect(retry("stale")).toBe("now");
    expect(retry("unchanged")).toBe("now");
    expect(retry("quota")).toBe("never");
    expect(retry("too_big")).toBe("never");
    expect(retry("rate_limited")).toBe("later");
    expect(retry("offline")).toBe("later");
  });
});
