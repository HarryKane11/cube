import { describe, expect, it } from "vitest";
import type { Conv, Msg } from "../state/store";
import { searchMessages, snippet } from "./search";

const convs: Conv[] = [
  { id: "general", kind: "channel", name: "general", members: [], dir: "", createdAt: 0 },
  { id: "dm-writer", kind: "dm", name: "Writer", members: ["writer"], dir: "", createdAt: 0 },
];
const msg = (id: string, convId: string, author: string, text: string): Msg => ({ id, convId, author, text, ts: Number(id) });
const all = [
  msg("1", "general", "you", "Draft the launch plan for Monday"),
  msg("2", "general", "writer", "The launch plan is on the Stage."),
  msg("3", "dm-writer", "you", "Shorter please"),
  msg("4", "dm-writer", "writer", "Cut the Launch section to one page."),
];

describe("searchMessages", () => {
  it("matches every word in any case, newest first", () => {
    expect(searchMessages(all, convs, "LAUNCH plan").map((m) => m.id)).toEqual(["2", "1"]);
    expect(searchMessages(all, convs, "launch").map((m) => m.id)).toEqual(["4", "2", "1"]);
  });
  it("narrows by author and conversation", () => {
    expect(searchMessages(all, convs, "launch from:writer").map((m) => m.id)).toEqual(["4", "2"]);
    expect(searchMessages(all, convs, "from:me").map((m) => m.id)).toEqual(["3", "1"]);
    expect(searchMessages(all, convs, "launch in:#gen").map((m) => m.id)).toEqual(["2", "1"]);
  });
  it("finds nothing for an empty query", () => {
    expect(searchMessages(all, convs, "  ")).toEqual([]);
  });
});

describe("snippet", () => {
  it("keeps the matching word in view", () => {
    const long = `${"word ".repeat(60)}needle ${"tail ".repeat(60)}`;
    const s = snippet(long, "needle", 60);
    expect(s).toContain("needle");
    expect(s.length).toBeLessThanOrEqual(62);
  });
});
