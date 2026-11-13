import { describe, expect, it } from "vitest";
import { listed, timeline } from "./timeline";

const act = (label: string, at?: number) => ({ label, at });
const shape = (parts: ReturnType<typeof timeline<{ label: string; at?: number }>>) => parts?.map((p) => (p.kind === "text" ? p.text : p.acts.map((a) => a.label)));

describe("timeline", () => {
  it("puts each step where it happened in the reply", () => {
    const text = "I will look at the file.\n\nIt has two bugs. Fixing them now.\n\nDone.";
    const first = text.indexOf("\n\nIt has");
    const second = text.indexOf("\n\nDone");
    expect(shape(timeline(text, [act("Reading a.ts", first), act("Editing a.ts", second), act("Running tests", second)]))).toEqual([
      "I will look at the file.",
      ["Reading a.ts"],
      "It has two bugs. Fixing them now.",
      ["Editing a.ts", "Running tests"],
      "Done.",
    ]);
  });

  it("starts with the steps taken before anything was said, and ends with those after", () => {
    expect(shape(timeline("Here is what I found.", [act("Thinking", 0), act("Reading", 0), act("Writing notes.md", 21)]))).toEqual([["Thinking", "Reading"], "Here is what I found.", ["Writing notes.md"]]);
    expect(shape(timeline("", [act("Thinking", 0)]))).toEqual([["Thinking"]]);
  });

  it("keeps steps in one group across blank space", () => {
    expect(shape(timeline("One.\n\nTwo.", [act("a", 4), act("b", 6)]))).toEqual(["One.", ["a", "b"], "Two."]);
  });

  it("does not cut a block of code in two", () => {
    const text = "Before.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter.";
    const inside = text.indexOf("const b");
    expect(shape(timeline(text, [act("Running", inside)]))).toEqual(["Before.\n\n```ts\nconst a = 1;\nconst b = 2;\n```", ["Running"], "After."]);
    // While the block is still being written the step waits at the end.
    const open = "Before.\n\n```ts\nconst a = 1;";
    expect(shape(timeline(open, [act("Running", 15)]))).toEqual([open, ["Running"]]);
  });

  it("holds the order steps were recorded in, and stays inside the text", () => {
    expect(shape(timeline("One. Two.", [act("a", 5), act("b", 2), act("c", 999)]))).toEqual(["One.", ["a", "b"], "Two.", ["c"]]);
  });

  it("says nothing for steps recorded without their place", () => {
    expect(timeline("Text.", [act("old")])).toBeNull();
    expect(timeline("Text.", [])).toBeNull();
  });
});

describe("listed", () => {
  const think = { kind: "think", label: "Thinking it through" };
  const read = (name: string) => ({ kind: "read", label: `Reading ${name}` });

  it("leaves out the thinking between steps", () => {
    expect(listed([think, read("a.ts"), think, read("b.ts"), think]).map((a) => a.label)).toEqual(["Reading a.ts", "Reading b.ts"]);
  });

  it("keeps one line when thinking is all there was", () => {
    expect(listed([think, think, think])).toEqual([think]);
    expect(listed([])).toEqual([]);
  });

  it("does not say the same step twice in a row", () => {
    expect(listed([read("a.ts"), read("a.ts"), read("b.ts"), read("a.ts")]).map((a) => a.label)).toEqual(["Reading a.ts", "Reading b.ts", "Reading a.ts"]);
  });
});
