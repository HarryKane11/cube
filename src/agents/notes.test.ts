import { describe, expect, it } from "vitest";
import { leftLately, notesBlock, splitNotes, type Note } from "./notes";

describe("splitNotes", () => {
  it("takes NOTE lines out of a reply and returns them separately", () => {
    const { text, notes } = splitNotes("Done, the plan is on the Stage.\n\nNOTE: Launch plans stay on one page.");
    expect(text).toBe("Done, the plan is on the Stage.");
    expect(notes).toEqual(["Launch plans stay on one page."]);
  });

  it("accepts several notes, list markers and lower case", () => {
    const { text, notes } = splitNotes("First.\n- NOTE: Use British spelling.\nnote: Dates as 12 Nov 2026.\nLast.");
    expect(notes).toEqual(["Use British spelling.", "Dates as 12 Nov 2026."]);
    expect(text).toBe("First.\n\nLast.");
  });

  it("hides a note that is still being written, so it never flashes in the bubble", () => {
    expect(splitNotes("All set.\n\nNOTE: Launch pl").text).toBe("All set.");
    expect(splitNotes("All set.\n\nNOTE:").notes).toEqual([]);
  });

  it("leaves ordinary text alone, including the word note inside a sentence", () => {
    const reply = "Please note: the numbers are from March.\nA NOTE: in the middle of a line stays.";
    expect(splitNotes(reply)).toEqual({ text: reply, notes: [], decisions: [] });
  });
});

describe("notesBlock", () => {
  const note = (text: string): Note => ({ id: text, agentId: "writer", text, ts: 0, state: "kept" });

  it("lists approved notes for the agent, and says nothing when there are none", () => {
    expect(notesBlock("Sam", [])).toBe("");
    expect(notesBlock("Sam", [note("One page."), note("British spelling.")])).toBe(
      "Notes Sam approved for you to remember. Follow them:\n- One page.\n- British spelling.",
    );
  });
});

describe("the Orchestrator's plan", () => {
  it("is taken out of the message, so the names in it start nobody", async () => {
    const { splitPlan } = await import("./notes");
    const said = "Here is how we do it.\n\nPLAN\n1. @Researcher: find the facts\n2. @Writer + @Designer: draft and lay out\n3. @Reviewer: check. Repeat 2-3 until it passes, at most 3 times\n\n@Researcher find what people say about it on the forum.";
    const { text, steps } = splitPlan(said);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(steps[1].text).toBe("@Writer + @Designer: draft and lay out");
    expect(text).toBe("Here is how we do it.\n\n@Researcher find what people say about it on the forum.");
    expect(splitPlan("No plan here.\n1. just a list")).toEqual({ text: "No plan here.\n1. just a list", steps: [] });
    expect(splitPlan("PLAN\n1. @Writer: dra").steps).toEqual([{ n: 1, text: "@Writer: dra" }]);
  });
  it("names the step being handed out", () => {
    expect(splitNotes("STEP: 2\n@Writer draft it.")).toEqual({ text: "\n@Writer draft it.".trimEnd(), notes: [], decisions: [], step: 2 });
  });
});

describe("the Router's line", () => {
  it("is its own answer, a hand-off, or nothing for the team", async () => {
    const { routerSaid } = await import("./notes");
    expect(routerSaid("네, Cube예요. 문서나 조사, 코드처럼 필요한 일을 말씀해 주세요.")).toBe("answer");
    expect(routerSaid("@Writer 불러올게요!")).toBe("pass");
    expect(routerSaid("팀장님(@Orchestrator)한테 물어볼게요!")).toBe("pass");
    expect(routerSaid("SKIP")).toBe("skip");
    expect(routerSaid(" `SKIP` ")).toBe("skip");
    // Said nothing: the request still has to reach someone.
    expect(routerSaid("  ")).toBe("pass");
    // An address is not a name.
    expect(routerSaid("Write to help@example.com for that.")).toBe("answer");
  });

  it("says which it is in its first word, which is not shown", async () => {
    const { routerLine, routerSaid } = await import("./notes");
    expect(routerLine("ANSWER 네, Cube예요.")).toEqual({ mark: "answer", text: "네, Cube예요." });
    expect(routerLine("PASS @Writer 불러올게요!")).toEqual({ mark: "pass", text: "@Writer 불러올게요!" });
    expect(routerLine("`PASS`: I'll ask the team lead, @Orchestrator.")).toEqual({ mark: "pass", text: "I'll ask the team lead, @Orchestrator." });
    // A line written the old way, with no word in front, is taken as it is.
    expect(routerLine("@Writer 불러올게요!")).toEqual({ text: "@Writer 불러올게요!" });
    // A sentence that only starts like the word is a sentence.
    expect(routerLine("Passing this to the team.")).toEqual({ text: "Passing this to the team." });
    // While the word is still arriving, none of it is shown.
    expect(routerLine("PA").text).toBe("");
    expect(routerLine("ANSW").text).toBe("");
    expect(routerSaid("ANSWER 네, Cube예요. 필요한 일을 말씀해 주세요.")).toBe("answer");
    expect(routerSaid("PASS 팀장님(@Orchestrator)한테 물어볼게요!")).toBe("pass");
  });

  it("may leave a reaction of its own, which is not part of the line", async () => {
    const { routerLine, routerSaid } = await import("./notes");
    expect(routerLine("PASS @Writer 불러올게요!\nREACT: 🙌")).toEqual({ mark: "pass", react: "🙌", text: "@Writer 불러올게요!" });
    expect(routerLine("ANSWER 축하해요! 다음 일도 말씀해 주세요.\nREACT: 🎉\n")).toEqual({ mark: "answer", react: "🎉", text: "축하해요! 다음 일도 말씀해 주세요." });
    // A skin tone and a joined emoji are still one emoji.
    expect(routerLine("ANSWER 네!\nREACT: 👍🏽").react).toBe("👍🏽");
    // Words, or more than one emoji, are not a reaction: the line is taken out and nothing is left on the message.
    expect(routerLine("ANSWER 네!\nREACT: thumbs up")).toEqual({ mark: "answer", react: undefined, text: "네!" });
    expect(routerLine("ANSWER 네!\nREACT: 👍🎉").react).toBeUndefined();
    // While the last line is still arriving, none of it is shown.
    expect(routerLine("ANSWER 네!\nREA").text).toBe("네!");
    expect(routerSaid("PASS 팀장님(@Orchestrator)한테 물어볼게요!\nREACT: 👀")).toBe("pass");
  });

  it("still passes the request on when it says so and names nobody", async () => {
    const { routerSaid } = await import("./notes");
    expect(routerSaid("PASS 각 팀원에게 자기소개를 부탁해볼게요!")).toBe("pass");
    // Without the word, the same sentence cannot be told from an answer.
    expect(routerSaid("각 팀원에게 자기소개를 부탁해볼게요!")).toBe("answer");
  });
});

describe("a picture a cube asks for", () => {
  it("is taken out of the reply, with its file name and what it shows", () => {
    const said = splitNotes("그려 드릴게요, 잠시만요.\n\nIMAGE: cube-mascot.png | A friendly translucent blue cube with two dot eyes, soft glow, dark navy background, flat illustration\n");
    expect(said.text).toBe("그려 드릴게요, 잠시만요.");
    expect(said.pictures).toEqual([{ name: "cube-mascot.png", description: "A friendly translucent blue cube with two dot eyes, soft glow, dark navy background, flat illustration" }]);
  });
  it("gets a name when none was given, and keeps a bar that belongs to the description", () => {
    expect(splitNotes("IMAGE: a red kite | blue sky, seen from below").pictures).toEqual([{ name: "picture.png", description: "a red kite | blue sky, seen from below" }]);
  });
  it("is not there for a reply without one, or with nothing to draw", () => {
    expect(splitNotes("No picture here.").pictures).toBeUndefined();
    expect(splitNotes("IMAGE:").pictures).toBeUndefined();
    expect(splitNotes("IMAGE: x.png | ").pictures).toBeUndefined();
  });
});

describe("what the Orchestrator says about its plan", () => {
  it("reads the step it hands out, and that the plan was carried through", () => {
    expect(splitNotes("STEP: 2\n@Writer draft it.").step).toBe(2);
    expect(splitNotes("STEP: 2\n@Writer draft it.").planDone).toBeUndefined();
    const done = splitNotes("STEP: done\nEverything is in report.md.");
    expect(done.planDone).toBe(true);
    expect(done.step).toBeUndefined();
    expect(done.text).toBe("\nEverything is in report.md.".trimEnd());
  });

  it("does not take an answer without the line for a finished plan", () => {
    expect(splitNotes("I could not reach the API, so the plan stops here.").planDone).toBeUndefined();
  });
});

describe("leftLately", () => {
  const msgs: { convId: string; reactions?: Record<string, string[]> }[] = [
    { convId: "a", reactions: { ":kirby:": ["router"], "✅": ["router"] } },
    { convId: "a", reactions: { "👍": ["you"], "👀": ["router"] } },
    { convId: "b", reactions: { "🎉": ["router"] } },
    { convId: "a" },
    { convId: "a", reactions: { ":kirby:": ["router", "you"] } },
  ];

  it("lists what the cube itself chose in this conversation, oldest first", () => {
    expect(leftLately(msgs, "a", "router")).toEqual([":kirby:", ":kirby:"]);
  });

  it("leaves out the plain marks, other people's reactions and other conversations", () => {
    expect(leftLately(msgs, "a", "you")).toEqual(["👍", ":kirby:"]);
    expect(leftLately(msgs, "b", "router")).toEqual(["🎉"]);
    expect(leftLately(msgs, "a", "writer")).toEqual([]);
  });

  it("recalls only the last few", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ convId: "a", reactions: { [`:e${i}:`]: ["router"] } }));
    expect(leftLately(many, "a", "router")).toEqual([":e4:", ":e5:", ":e6:", ":e7:", ":e8:", ":e9:"]);
  });
});
