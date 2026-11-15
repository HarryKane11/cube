import { describe, expect, it } from "vitest";
import type { Conv } from "@/state/store";
import { forgetChannelSessions } from "@/state/store";
import { channelJobPrompt, transcript } from "./jobs";
import { CHANNEL_MEMORY, channelMemoryDir, dreamerOf, keepsOwnMemory, notesFor, othersRead, saidHere } from "./scope";
import { useCube } from "@/state/store";
import { engineIsAuto, knowledgeEngine, knowledgeModel } from "./index";

const conv = (id: string, extra: Partial<Conv> = {}): Conv => ({ id, kind: "channel", name: id, members: [], dir: `/s/${id}`, createdAt: 0, ...extra });
const dm = conv("dm-builder", { kind: "dm" });
const chat = conv("chat-1", { chat: true });
const team = conv("cube", { cube: true });
const local = conv("design");
const shared = conv("general", { shared: { id: "r1", since: 1 } });
const teammate = conv("p-kim", { shared: { id: "r2", since: 1, private: true }, person: { pubkey: "k" } });

describe("whose memory a conversation's words go to", () => {
  it("keeps the person's own chats personal, and gives every channel a memory of its own from the start", () => {
    for (const c of [dm, chat, team]) expect(keepsOwnMemory(c)).toBe(false);
    for (const c of [local, shared, teammate]) expect(keepsOwnMemory(c)).toBe(true);
    expect(channelMemoryDir(local)).toBe(`/s/design/${CHANNEL_MEMORY}`);
  });

  it("knows where other people read what a cube says", () => {
    expect([dm, chat, team, local].some(othersRead)).toBe(false);
    expect(othersRead(shared) && othersRead(teammate)).toBe(true);
  });

  it("learns from this side's lines and leaves a teammate's to their own Cube", () => {
    expect(saidHere({})).toBe(true);
    expect(saidHere({ from: { pubkey: "k", name: "Kim" } })).toBe(false);
    // Someone in Slack is answered by this person's cubes, so their line is learned here.
    expect(saidHere({ from: { pubkey: "", name: "Lee" }, slack: { channel: "C", ts: "1" } })).toBe(true);
  });
});

describe("notes an agent is told", () => {
  const byConv = (id: string) => [dm, chat, team, local, shared, teammate].find((c) => c.id === id);
  const notes = [
    { id: "a", convId: "dm-builder" },
    { id: "b", convId: "general" },
    { id: "c" },
    { id: "d", convId: "dm-builder", self: true },
    { id: "e", convId: "chat-1", self: true },
    { id: "f", convId: "gone" },
  ];
  const ids = (c: Conv) => notesFor(notes, c, byConv).map((n) => n.id);

  it("tells a channel only what was learned in it and what the person wrote by hand", () => {
    expect(ids(shared)).toEqual(["b", "c"]);
    expect(ids(teammate)).toEqual(["c"]);
  });

  it("keeps a channel's notes out of the person's own chats", () => {
    expect(ids(dm)).toEqual(["a", "c", "d", "e", "f"]);
  });
});

describe("a channel's memory job", () => {
  it("marks a teammate's lines as context", () => {
    const got = transcript([
      { convId: "general", where: "#general", who: "Kane", text: "We ship on Fridays.", ts: 1, mine: true },
      { convId: "general", where: "#general", who: "Kim", text: "Agreed.", ts: 2, mine: false },
    ]);
    expect(got.text).toContain("**Kane:** We ship on Fridays.");
    expect(got.text).toContain("**Kim (teammate; context only):** Agreed.");
  });

  it("is told the folder goes to everyone, to keep only what was said there, and to stay inside it", () => {
    const p = channelJobPrompt({ dir: "/s/general/cube-memory", place: "#general", person: "Kane", today: "2026-11-15", shared: true });
    expect(p).toContain("Work only inside this folder");
    expect(p).toContain("Everyone in the conversation has this folder");
    expect(p).toContain("Nothing about anyone's private life, and nothing you know from anywhere but the material in front of you");
    expect(p).toContain("teammate; context only");
    expect(p).toContain("ADDED: n");
    expect(p).not.toContain("\\`");
    expect(channelJobPrompt({ dir: "/d", place: "#design", person: "Kane", today: "2026-11-15", shared: false })).toContain("When the conversation is shared, this folder goes to everyone in it.");
  });
});

describe("sessions from before memory was kept by conversation", () => {
  it("start over in every channel and stay in the person's own chats", () => {
    const sessions = { "general:builder:claude": "s1", "design:writer:codex:copy": "s2", "dm-builder:builder:claude": "s3", "chat-1:router:claude": "s4", "generalx:builder:claude": "s5" };
    const told = { "general:builder:claude": ["n1"], "dm-builder:builder:claude": ["n2"] };
    const got = forgetChannelSessions([dm, chat, team, local, shared, teammate], sessions, told);
    expect(got.sessions).toEqual({ "dm-builder:builder:claude": "s3", "chat-1:router:claude": "s4", "generalx:builder:claude": "s5" });
    expect(got.told).toEqual({ "dm-builder:builder:claude": ["n2"] });
  });
});

describe("who dreams over a shared channel", () => {
  const members = ["aa", "bb", "cc", "dd"];
  it("is the same answer on every member's Mac, whatever order they list the members in", () => {
    expect(dreamerOf(members, "general", "2026-11-15")).toBe(dreamerOf([...members].reverse(), "general", "2026-11-15"));
  });
  it("changes from day to day, so no one Cube has it every day", () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    expect(new Set(days.map((d) => dreamerOf(members, "general", d))).size).toBeGreaterThan(1);
  });
});

describe("the program background work runs on", () => {
  it("is picked by Cube when the person has not, with a small model", () => {
    useCube.setState((s) => ({ available: { claude: true, codex: true }, knowledge: { ...s.knowledge, engine: "", model: "" } }));
    expect(knowledgeEngine()).toBe("claude");
    expect(engineIsAuto()).toBe(true);
    expect(knowledgeModel()).toEqual({ model: "haiku" });
    useCube.setState({ available: { codex: true, hermes: true } });
    // Hermes is never picked unasked: it cannot be fenced for a channel's memory.
    expect(knowledgeEngine()).toBe("codex");
    expect(knowledgeModel()).toEqual({ effort: "low" });
  });
  it("is the person's choice once they made one", () => {
    useCube.setState((s) => ({ available: { claude: true, hermes: true }, knowledge: { ...s.knowledge, engine: "hermes", model: "x" } }));
    expect(knowledgeEngine()).toBe("hermes");
    expect(knowledgeModel()).toEqual({ model: "x" });
  });
});
