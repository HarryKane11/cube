import { describe, expect, it } from "vitest";
import { appendBlock, replaceBlock, splitBlocks } from "./mdBlocks";

const doc = "# Title\n\nFirst paragraph\nstill first.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n";

describe("splitBlocks", () => {
  it("finds each top-level block, keeping lists, tables and fenced code whole", () => {
    const got = splitBlocks(doc).map((b) => doc.slice(b.start, b.end));
    expect(got).toEqual([
      "# Title",
      "First paragraph\nstill first.",
      "- one\n- two",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "```js\nconst x = 1;\n\nconst y = 2;\n```",
    ]);
  });

  it("is empty for an empty document", () => {
    expect(splitBlocks("")).toEqual([]);
    expect(splitBlocks("\n\n")).toEqual([]);
  });
});

describe("replaceBlock", () => {
  it("changes one block and leaves the rest byte for byte", () => {
    const [, para] = splitBlocks(doc);
    const next = replaceBlock(doc, para, "Rewritten.\n");
    expect(next).toBe(doc.replace("First paragraph\nstill first.", "Rewritten."));
  });

  it("removes a block when the replacement is empty", () => {
    const text = "one\n\ntwo\n\nthree\n";
    const [, two, three] = splitBlocks(text);
    expect(replaceBlock(text, two, "  ")).toBe("one\n\nthree\n");
    expect(replaceBlock(text, three, "")).toBe("one\n\ntwo\n");
    expect(replaceBlock("only\n", splitBlocks("only\n")[0], "")).toBe("");
  });
});

describe("appendBlock", () => {
  it("adds a block after a blank line", () => {
    expect(appendBlock("one\n", "two")).toBe("one\n\ntwo\n");
    expect(appendBlock("", "first")).toBe("first\n");
    expect(appendBlock("one\n", "  ")).toBe("one\n");
  });
});
