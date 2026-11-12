import { describe, expect, it } from "vitest";
import { notesBlock, splitNotes, type Note } from "./notes";

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
