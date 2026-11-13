import { describe, expect, it } from "vitest";
import type { Msg } from "../state/store";
import { due, nextRun, repeatOf, suggestSchedules, type Schedule } from "./schedule";
import { clashing, missedSince, statsFor } from "./stats";

const base: Schedule = { id: "s", convId: "general", text: "Brief me", time: "09:00", days: [1, 2, 3, 4, 5], on: true };
// 12 Nov 2026 is a Thursday.
const at = (h: number, m = 0, day = 12) => new Date(2026, 10, day, h, m);

describe("schedules", () => {
  it("run once their time has come, once a day, on their days", () => {
    expect(due([base], at(8, 59))).toEqual([]);
    expect(due([base], at(9, 0))).toEqual([base]);
    expect(due([base], at(17, 30))).toEqual([base]);
    expect(due([{ ...base, last: "2026-11-12" }], at(17, 30))).toEqual([]);
    expect(due([base], at(10, 0, 14))).toEqual([]);
    expect(due([{ ...base, on: false }], at(10))).toEqual([]);
    expect(due([{ ...base, days: [], once: "2026-11-12" }], at(10))).toHaveLength(1);
    expect(due([{ ...base, days: [], once: "2026-11-13" }], at(10))).toEqual([]);
  });
  it("say when they run next and how often", () => {
    expect(nextRun(base, at(8))).toBe("Today at 09:00");
    expect(nextRun({ ...base, last: "2026-11-12" }, at(10))).toBe("Tomorrow at 09:00");
    expect(nextRun({ ...base, last: "2026-11-13" }, at(10, 0, 13))).toBe("Monday at 09:00");
    expect(nextRun({ ...base, on: false }, at(8))).toBe("Off");
    expect([repeatOf(base), repeatOf({ ...base, days: [] }), repeatOf({ ...base, days: [0, 6] }), repeatOf({ ...base, days: [1, 3] })]).toEqual(["Weekdays", "Every day", "Weekends", "Mon, Wed"]);
  });
});

describe("schedules Cube offers", () => {
  it("come from the tools that are connected, one per kind", () => {
    const offered = suggestSchedules(["Google Calendar", "google-calendar-2", "Linear", "figma"], "en");
    expect(offered.map((s) => s.key)).toEqual(["calendar", "issues"]);
    expect(offered[0]).toMatchObject({ time: "08:30", days: [1, 2, 3, 4, 5] });
    expect(suggestSchedules([], "en")).toEqual([]);
  });
  it("are worded in the person's language and left out once scheduled", () => {
    const [ko] = suggestSchedules(["gmail"], "ko");
    expect(ko.text).toContain("메일");
    expect(suggestSchedules(["gmail"], "ko", [{ ...base, text: ko.text }])).toEqual([]);
  });
});

const msg = (id: string, author: string, more: Partial<Msg> = {}): Msg => ({ id, convId: "general", author, text: "x", ts: Number(id), ...more });

describe("stats", () => {
  it("counts a role's runs, time, tokens and requests", () => {
    const messages = [
      msg("1", "you"),
      msg("2", "builder", { took: 4000, usage: { in: 100, out: 10, cost: 0.02 }, asks: [{ id: "a", title: "Run", detail: "", state: "allowed" }, { id: "b", title: "Run", detail: "", state: "denied" }] }),
      msg("3", "builder", { took: 2000, error: "boom" }),
      msg("4", "builder", { stopped: true, took: 99000 }),
      msg("5", "builder", { aside: true }),
      msg("6", "writer", { took: 1000 }),
    ];
    expect(statsFor(messages, "builder", 10)).toEqual({ runs: 3, done: 1, stopped: 1, failed: 1, asks: 2, allowed: 1, avgMs: 3000, tokensIn: 100, tokensOut: 10, cost: 0.02, week: 3 });
  });
  it("sums up what was missed, and who clashes over a file", () => {
    const convs = [{ id: "general", kind: "channel" as const, name: "general", members: [], dir: "", createdAt: 0 }, { id: "quiet", kind: "channel" as const, name: "quiet", members: [], dir: "", createdAt: 0 }];
    const files = { general: [{ rel: "a.md", path: "/a.md", kind: "md" as const, mtime: 50, size: 1 }, { rel: "old.md", path: "/old.md", kind: "md" as const, mtime: 5, size: 1 }] };
    const missed = missedSince([msg("5", "builder"), msg("20", "you"), msg("30", "builder"), msg("40", "writer", { error: "x" })], files, convs, 10);
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ replies: 2, by: ["builder", "writer"], files: ["a.md"], failed: 1 });
    expect(clashing({ builder: ["/s/a.md"], designer: ["/s/b.md"] }, "designer", "/s/a.md", {})).toEqual(["builder"]);
    expect(clashing({ builder: ["/s/a.md"] }, "builder", "/s/a.md", { "/s/a.md": true })).toEqual(["you"]);
  });
});
