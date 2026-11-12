import { describe, expect, it } from "vitest";
import { dueJob, finished, jobPrompt, summaryOf, transcript, type Clock, type Line } from "./jobs";

const line = (convId: string, who: string, text: string, ts: number): Line => ({ convId, where: convId === "general" ? "#general" : "Direct message with Builder", who, text, ts });
const T = Date.UTC(2026, 10, 12, 9, 0, 0);

describe("transcript", () => {
  it("groups lines by conversation, oldest first, and says where the next run starts", () => {
    const got = transcript([
      line("general", "Builder", "Done.", T + 2000),
      line("dm", "You", "Use pnpm, not npm.", T + 1000),
      line("general", "You", "Build the page.", T),
    ]);
    expect(got.count).toBe(3);
    expect(got.upTo).toBe(T + 2000);
    expect(got.text).toBe("# Conversations in Cube\n\n## #general (2026-11-12)\n\n**You:** Build the page.\n\n**Builder:** Done.\n\n## Direct message with Builder (2026-11-12)\n\n**You:** Use pnpm, not npm.\n");
  });

  it("takes the oldest lines that fit and leaves the rest for next time", () => {
    const got = transcript([line("general", "You", "a".repeat(60), T), line("general", "You", "b".repeat(60), T + 1), line("general", "You", "c".repeat(60), T + 2)], 150);
    expect(got.count).toBe(2);
    expect(got.upTo).toBe(T + 1);
    expect(got.text).not.toContain("ccc");
  });

  it("always takes at least one line, however long, and is empty for nothing", () => {
    expect(transcript([line("general", "You", "x".repeat(500), T)], 100).count).toBe(1);
    expect(transcript([])).toEqual({ text: "", upTo: 0, count: 0 });
  });
});

describe("jobPrompt", () => {
  const o = { dir: "/k", person: "Kane", today: "2026-11-12" };
  it("tells every job the rules that keep it inside the folder and free of secrets", () => {
    for (const job of ["memory", "skills", "wiki"] as const) {
      const p = jobPrompt(job, o);
      expect(p).toContain("Work only inside this folder");
      expect(p).toContain("Do not run programs");
      expect(p).toContain("Never keep a secret");
      expect(p).toContain("ADDED: n");
    }
  });
  it("hands the memory job one batch of imported notes at a time, when some are waiting", () => {
    expect(jobPrompt("memory", o)).not.toContain("memory/imported/claude");
    const p = jobPrompt("memory", { ...o, batch: "memory/imported/claude-02.md" });
    expect(p).toContain("and memory/imported/claude-02.md");
    expect(p).toContain("Leave the other files under memory/imported/ for later runs");
  });
  it("tells the wiki job to bring the programs' abilities together by purpose, not by program", () => {
    const p = jobPrompt("wiki", o);
    expect(p).toContain("an inventory of the skills, MCP servers and plugins each agent program has");
    expect(p).toContain("not by program");
    expect(p).toContain("which program has each");
  });
  it("writes in the language it is told to", () => {
    expect(jobPrompt("wiki", { ...o, language: "Korean" })).toContain("Write in Korean");
  });
});

describe("summaryOf", () => {
  it("reads the counts and the closing sentence", () => {
    expect(summaryOf("I read the inbox.\n\nADDED: 2\nUPDATED: 1\nREMOVED: 0\nKept the pnpm preference and the release date.")).toBe("2 added, 1 updated, 0 removed. Kept the pnpm preference and the release date.");
  });
  it("tells a job that did its work from one that only talked", () => {
    expect(finished("ADDED: 0\nUPDATED: 0\nREMOVED: 0\nNothing was worth keeping.")).toBe(true);
    expect(finished("I could not write files, so nothing was added.")).toBe(false);
    expect(finished("ADDED: 2")).toBe(false);
  });
  it("copes with a job that only wrote a sentence, or nothing", () => {
    expect(summaryOf("Nothing new was worth keeping.")).toBe("Nothing new was worth keeping.");
    expect(summaryOf("")).toBe("Finished without a summary.");
  });
});

describe("dueJob", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const base: Clock = { now: T, last: {}, unread: { memory: 0, skills: 0 }, newest: 0, imported: false, memoryChangedAt: 0 };

  it("runs memory once conversation with enough new in it has gone quiet", () => {
    expect(dueJob({ ...base, unread: { memory: 20, skills: 0 }, newest: T - 10 * MIN })).toBe("memory");
    // Still going: wait.
    expect(dueJob({ ...base, unread: { memory: 20, skills: 0 }, newest: T - MIN })).toBeNull();
    // Too little to bother, and memory ran recently.
    expect(dueJob({ ...base, unread: { memory: 3, skills: 0 }, newest: T - 10 * MIN, last: { memory: T - HOUR } })).toBeNull();
    // A little, but it has been waiting for hours.
    expect(dueJob({ ...base, unread: { memory: 3, skills: 0 }, newest: T - 10 * MIN, last: { memory: T - 7 * HOUR } })).toBe("memory");
  });

  it("works imports in right away, but not twice in a row", () => {
    expect(dueJob({ ...base, imported: true })).toBe("memory");
    expect(dueJob({ ...base, imported: true, last: { memory: T - 30_000 } })).toBeNull();
    // The next batch follows soon after, without waiting the ten minutes conversation waits.
    expect(dueJob({ ...base, imported: true, last: { memory: T - 2 * MIN } })).toBe("memory");
  });

  it("rewrites the wiki only after memory changed, and not more than every few hours", () => {
    expect(dueJob({ ...base, last: { memory: T - 20 * MIN }, memoryChangedAt: T - 20 * MIN })).toBe("wiki");
    expect(dueJob({ ...base, last: { memory: T - 20 * MIN, wiki: T - HOUR }, memoryChangedAt: T - 20 * MIN })).toBeNull();
    // A memory run that changed nothing gives the wiki nothing to do.
    expect(dueJob({ ...base, last: { memory: T - 20 * MIN, wiki: T - 5 * HOUR }, memoryChangedAt: T - 9 * HOUR })).toBeNull();
  });

  it("looks for skills once enough new work has piled up, at most twice a day", () => {
    const worked = { ...base, unread: { memory: 0, skills: 60 }, newest: T - 10 * MIN };
    expect(dueJob(worked)).toBe("skills");
    expect(dueJob({ ...worked, last: { skills: T - HOUR } })).toBeNull();
    expect(dueJob({ ...worked, unread: { memory: 0, skills: 10 } })).toBeNull();
    expect(dueJob(base)).toBeNull();
  });
});
