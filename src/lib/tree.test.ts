import { describe, expect, it } from "vitest";
import { buildTree, changesSince, quoteOf, searchFiles } from "./tree";

describe("buildTree", () => {
  it("nests files under their folders, folders first, in name order", () => {
    const tree = buildTree(["readme.md", "src/app.ts", "src/lib/util.ts", "a.txt", "src/2.ts", "src/10.ts"]);
    expect(tree.map((n) => n.name)).toEqual(["src", "a.txt", "readme.md"]);
    const src = tree[0];
    expect(src.dir).toBe(true);
    expect(src.children.map((n) => n.name)).toEqual(["lib", "2.ts", "10.ts", "app.ts"]);
    expect(src.children[0].children[0]).toMatchObject({ name: "util.ts", rel: "src/lib/util.ts", dir: false });
  });

  it("keeps a file and a folder with the same name apart", () => {
    const tree = buildTree(["notes", "notes/today.md"]);
    expect(tree.map((n) => [n.name, n.dir])).toEqual([["notes", true], ["notes", false]]);
  });
});

describe("changesSince", () => {
  const base = { at: 1, files: { "a.md": { mtime: 10 }, "b.md": { mtime: 20 } } };

  it("marks new files as added and rewritten ones as changed", () => {
    expect(changesSince([{ rel: "a.md", mtime: 10 }, { rel: "b.md", mtime: 25 }, { rel: "c.md", mtime: 30 }], base)).toEqual({ "b.md": "changed", "c.md": "added" });
  });

  it("reports nothing before there is a baseline", () => {
    expect(changesSince([{ rel: "a.md", mtime: 10 }], undefined)).toEqual({});
  });
});

describe("quoteOf", () => {
  it("names the file and lines and fences the code with its language", () => {
    expect(quoteOf("src/app.py", 3, 4, "x = 1\ny = 2\n")).toBe("In `src/app.py` (lines 3-4):\n```py\nx = 1\ny = 2\n```\n");
    expect(quoteOf("Makefile", 7, 7, "all:")).toBe("In `Makefile` (line 7):\n```\nall:\n```\n");
  });

  it("uses a longer fence when the code itself contains one", () => {
    expect(quoteOf("a.md", 1, 3, "```js\nx\n```")).toBe("In `a.md` (lines 1-3):\n````md\n```js\nx\n```\n````\n");
  });
});

describe("searchFiles", () => {
  const files = [
    { rel: "b.md", text: "Launch plan\nnothing here" },
    { rel: "a.py", text: "x = 1\n  print('Plan B')\nplan = 2" },
  ];

  it("matches any case for a lower-case query, in file then line order", () => {
    expect(searchFiles(files, "plan")).toEqual([
      { rel: "a.py", line: 2, col: 10, text: "print('Plan B')" },
      { rel: "a.py", line: 3, col: 1, text: "plan = 2" },
      { rel: "b.md", line: 1, col: 8, text: "Launch plan" },
    ]);
  });

  it("matches exactly when the query has a capital letter", () => {
    expect(searchFiles(files, "Plan").map((f) => `${f.rel}:${f.line}`)).toEqual(["a.py:2"]);
  });

  it("finds nothing for an empty query and stops at the limit", () => {
    expect(searchFiles(files, "  ")).toEqual([]);
    expect(searchFiles(files, "plan", 2)).toHaveLength(2);
  });
});
