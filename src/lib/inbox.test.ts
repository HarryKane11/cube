import { describe, expect, it } from "vitest";
import type { Msg } from "../state/store";
import { inboxEntries } from "./inbox";

const msg = (id: string, author: string, text: string, more: Partial<Msg> = {}): Msg => ({ id, convId: "general", author, text, ts: Number(id), ...more });
const none = { notes: [], decisions: [], cleared: {} };

describe("inboxEntries", () => {
  it("lists what blocks an agent first, then questions, then things to look over", () => {
    const messages = [
      msg("1", "you", "Ship it"),
      msg("2", "builder", "", { asks: [{ id: "a1", title: "Run a command", detail: "pnpm test", state: "waiting" }, { id: "a0", title: "Run a command", detail: "ls", state: "allowed" }] }),
      msg("3", "writer", "Which tone do you want?", { convId: "dm-writer" }),
    ];
    const entries = inboxEntries({
      ...none,
      messages,
      decisions: [{ id: "d1", agentId: "builder", convId: "general", msgId: "2", text: "Used SQLite.", ts: 9, state: "new" }, { id: "d2", agentId: "builder", convId: "general", msgId: "2", text: "Old.", ts: 1, state: "ok" }],
      notes: [{ id: "n1", agentId: "writer", text: "British spelling.", ts: 5, state: "pending" }],
    });
    expect(entries.map((e) => e.id)).toEqual(["ask:a1", "reply:3", "decision:d1", "note:n1"]);
    expect(entries[0].title).toBe("Builder needs your OK: run a command");
  });
  it("drops a question once the person has answered, and anything they cleared", () => {
    const asked = msg("1", "writer", "Which tone?");
    expect(inboxEntries({ ...none, messages: [asked, msg("2", "you", "Warm")] })).toEqual([]);
    expect(inboxEntries({ ...none, messages: [asked], cleared: { "reply:1": true } })).toEqual([]);
  });
  it("shows plans and failed runs", () => {
    const entries = inboxEntries({
      ...none,
      messages: [
        msg("1", "builder", "", { asks: [{ id: "p", title: "Has a plan for you", detail: "", plan: "1. Do it", state: "waiting" }] }),
        msg("2", "reviewer", "", { convId: "dm-reviewer", error: "Codex exited with code 1." }),
      ],
    });
    expect(entries.map((e) => e.kind)).toEqual(["plan", "stuck"]);
  });
});
