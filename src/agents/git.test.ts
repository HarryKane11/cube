import { describe, expect, it } from "vitest";
import { parsePr, parseStatus, q, saveAll } from "./git";
import { branchOf, rootOf, treeOf } from "./trees";

describe("git helpers", () => {
  it("quote a string as one shell word", () => {
    expect(q("it's a `test` $HOME")).toBe(`'it'\\''s a \`test\` $HOME'`);
    expect(saveAll("it's done")).toContain(`-m 'it'\\''s done'`);
  });
  it("read the branch, how far ahead it is and what is uncommitted", () => {
    expect(parseStatus("## main...origin/main [ahead 2]\n M a.md\n?? b.md\n")).toEqual({ branch: "main", ahead: 2, dirty: 2 });
    expect(parseStatus("## No commits yet on main\n")).toEqual({ branch: "main", ahead: 0, dirty: 0 });
    expect(parseStatus("## feat/x\n")).toEqual({ branch: "feat/x", ahead: 0, dirty: 0 });
  });
  it("read a pull request and its checks", () => {
    const pr = parsePr(JSON.stringify({ number: 7, url: "https://example.test/pr/7", title: "Add x", statusCheckRollup: [{ name: "build", conclusion: "SUCCESS" }, { name: "test", conclusion: "FAILURE" }, { name: "lint", status: "IN_PROGRESS", conclusion: "" }, { context: "deploy", state: "ERROR" }] }));
    expect(pr).toEqual({ number: 7, url: "https://example.test/pr/7", title: "Add x", failing: ["test", "deploy"], pending: 1, passing: 1 });
    expect(parsePr("no pull requests found")).toBeNull();
  });
  it("name each cube's branch and copy", () => {
    expect(branchOf("builder")).toBe("cube/builder");
    expect(rootOf("/Users/x/CubeSpaces/general")).toBe("/Users/x/CubeSpaces");
    expect(treeOf("/Users/x/CubeSpaces", "general", "builder")).toBe("/Users/x/CubeSpaces/.trees/general/builder");
  });
});
