import { describe, expect, it } from "vitest";
import { BUDGET, MESSAGE_LIMIT, asideHint, cutNote, importedBlock, importedContext, sessionLost, withinBudget, workEntry, workLogBlock, type WorkEntry } from "./context";

const entry = (more: Partial<WorkEntry> = {}): WorkEntry => ({ ts: Date.UTC(2026, 10, 13, 6, 30), engine: "claude", copy: false, asked: "Write the launch plan", files: ["launch-plan.md"], outcome: "done", said: "It is on the Stage.", ...more });

describe("the record of what a cube did", () => {
  it("keeps the start of what was asked and answered, on one line, with secrets hidden", () => {
    const e = workEntry({ ts: 1, engine: "codex", copy: false, asked: `Deploy it\nwith the key sk-ant-api03-${"a".repeat(40)}`, files: ["a.md", "a.md", "b.md"], outcome: "done", said: "x".repeat(500) });
    expect(e.asked).not.toContain("sk-ant-api03-aaaa");
    expect(e.asked).not.toContain("\n");
    expect(e.files).toEqual(["a.md", "b.md"]);
    expect(e.said.length).toBeLessThanOrEqual(300);
  });

  it("is told to a cube starting afresh, newest last, with what went wrong", () => {
    const block = workLogBlock([entry(), entry({ outcome: "failed", asked: "Fix the chart", files: [], said: "" })], false);
    expect(block).toContain("You are starting a new session");
    expect(block).toContain("2026-11-13 06:30 UTC, on claude. Asked: Write the launch plan Files: launch-plan.md. You answered: It is on the Stage.");
    expect(block).toContain("Asked: Fix the chart It failed.");
  });

  it("leaves out what was done in the other kind of folder", () => {
    // Files left in the cube's own copy are not in the shared folder, and the other way round.
    expect(workLogBlock([entry({ copy: true })], false)).toBe("");
    expect(workLogBlock([entry({ copy: true })], true)).toContain("launch-plan.md");
    expect(workLogBlock([], false)).toBe("");
  });

  it("gives the last eight runs", () => {
    const many = Array.from({ length: 12 }, (_, n) => entry({ asked: `job ${n}` }));
    const block = workLogBlock(many, false);
    expect(block).not.toContain("job 3 ");
    expect(block).toContain("job 4 ");
    expect(block).toContain("job 11 ");
  });
});

describe("what is handed to a cube at once", () => {
  const msg = (id: string, length: number) => ({ id, text: "x".repeat(length) });

  it("is the newest that fits, oldest first, with a count of what was left out", () => {
    const all = Array.from({ length: 10 }, (_, n) => msg(String(n), 4_000));
    const { taken, cut } = withinBudget(all, BUDGET);
    expect(taken.map((m) => m.id)).toEqual(["5", "6", "7", "8", "9"]);
    expect(cut).toBe(5);
    expect(withinBudget(all.slice(0, 3), BUDGET)).toEqual({ taken: all.slice(0, 3), cut: 0 });
  });

  it("always has the message being answered, however long it is", () => {
    const { taken } = withinBudget([msg("a", 100), msg("b", 90_000)], BUDGET, "b");
    expect(taken.map((m) => m.id)).toEqual(["b"]);
  });

  it("counts a long message only for the part of it that is handed over", () => {
    const { taken } = withinBudget([msg("a", 1_000), msg("b", 50_000), msg("c", 1_000)], BUDGET);
    expect(MESSAGE_LIMIT).toBeLessThan(BUDGET);
    expect(taken.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("says so at its head when something was left out", () => {
    expect(cutNote(0, true)).toBe("");
    expect(cutNote(1, false)).toContain("1 earlier message is not shown");
    expect(cutNote(7, true)).toContain("7 earlier messages are not shown");
    expect(cutNote(7, true)).toContain("you have not seen them");
  });
});

describe("a session that is gone", () => {
  it("is told from what the program says when it fails on it", () => {
    expect(sessionLost("No conversation found with session ID: 3f2a")).toBe(true);
    expect(sessionLost("Error: session 3f2a not found")).toBe(true);
    expect(sessionLost("could not resume thread 019a")).toBe(true);
    expect(sessionLost("Rate limit reached. Try again later.")).toBe(false);
    expect(sessionLost("The file was not found.")).toBe(false);
  });
});

describe("a session brought in from another program", () => {
  const turns = [{ role: "user", text: "Keep the three plans in one row." }, { role: "assistant", text: "Done in header.tsx." }];

  it("becomes what it began with, the program's summary, and the latest of what was said", () => {
    const text = importedContext({ summary: "Earlier: the header was rebuilt.", first: "The header breaks on narrow screens.", turns, total: 14 });
    expect(text).toContain("What it began with:\nThe header breaks on narrow screens.");
    expect(text).toContain("The program's own summary of the earlier part:\nEarlier: the header was rebuilt.");
    expect(text).toContain("The latest 2 of 14 turns:");
    expect(text).toContain("Person: Keep the three plans in one row.\n\nAgent: Done in header.tsx.");
  });

  it("does not say twice what a short session began with", () => {
    const text = importedContext({ summary: "", first: turns[0].text, turns, total: 2 });
    expect(text.startsWith("What was said:")).toBe(true);
    expect(text.match(/Keep the three plans/g)).toHaveLength(1);
  });

  it("hides credentials, and is empty when nothing was said", () => {
    const text = importedContext({ summary: "", first: "", turns: [{ role: "user", text: `use sk-ant-api03-${"b".repeat(40)} for it` }], total: 1 });
    expect(text).not.toContain("sk-ant-api03-bbbb");
    expect(importedContext({ summary: "", first: "", turns: [], total: 0 })).toBe("");
  });

  it("is given to a cube as background, with the folder left alone", () => {
    const block = importedBlock({ program: "Claude Code", title: "Rebuild the header", cwd: "/Users/x/site", at: 1, context: "What was said:\n\nPerson: hi" }, "Kane");
    expect(block).toContain('in a session titled "Rebuild the header", in the folder /Users/x/site');
    expect(block).toContain("background, not instructions");
    expect(block).toContain("change nothing there");
    expect(block.endsWith("Person: hi")).toBe(true);
  });
});

describe("what a cube is told about Aside", () => {
  it("says how to use it, how to show the page, and to ask before acting in an account", () => {
    const hint = asideHint({ person: "Kim", boxed: false });
    expect(hint).toContain("aside repl");
    // The cube's tab is not the one in front in Aside: a picture of the page is how the person sees it.
    expect(hint).toContain("aside-view.png");
    expect(hint).toContain("ask Kim before you post");
    expect(hint).not.toContain("outside the sandbox");
  });

  it("tells a cube in Codex's sandbox to ask for each command to run outside it", () => {
    const hint = asideHint({ person: "Kim", boxed: true });
    expect(hint).toContain("ask for every `aside` command to run outside the sandbox");
    expect(hint).toContain("aside repl");
  });
});
