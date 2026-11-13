import { describe, expect, it } from "vitest";
import { cubeMd, noteBody, workspaceFacts, type CubeMdInput } from "./cubemd";
import { suggestionsOf, summaryOf } from "./jobs";

const base: CubeMdInput = {
  today: "2026-11-13",
  dir: "/Users/x/CubeSpaces/.knowledge",
  person: "Kane",
  teammates: ["Sean"],
  cubes: [{ name: "Writer", about: "Writes documents" }],
  conversations: ["#general", "출시 일정"],
  programs: [{ name: "Claude Code", mcp: [{ name: "Linear", about: "Issues and projects" }], skills: [{ name: "pdf", about: "Reads PDF files" }], plugins: [] }],
  skills: [{ name: "release-notes", about: "How release notes are written here" }],
  memory: [{ name: "prefers-short-replies", about: "Wants answers in a few lines" }, { name: "old-note", about: "An older fact" }],
  recent: [{ name: "prefers-short-replies", text: "Kane wants answers in a few lines." }],
  wiki: [],
  ontology: false,
};

describe("CUBE.md", () => {
  it("lists who is here, the tools by program, the skills and what is remembered", () => {
    const md = cubeMd(base);
    expect(md).toContain("# CUBE.md");
    expect(md).toContain("- Writer: Writes documents");
    expect(md).toContain("### Claude Code\n\n- Linear: Issues and projects");
    expect(md).toContain("- release-notes: How release notes are written here");
    // The newest note is there in full; the others by what they are about.
    expect(md).toContain("### prefers-short-replies\n\nKane wants answers in a few lines.");
    expect(md).toContain("- old-note: An older fact");
    expect(md).not.toContain("- prefers-short-replies: Wants answers");
  });

  it("says so when ontology.md is not written yet, and points to it once it is", () => {
    expect(cubeMd(base)).toContain("ontology.md is not written yet");
    expect(cubeMd({ ...base, ontology: true })).toContain("ontology.md says how the people");
  });

  it("counts what does not fit in a list instead of listing it", () => {
    const many = Array.from({ length: 45 }, (_, n) => ({ name: `page-${n}`, about: "" }));
    const md = cubeMd({ ...base, wiki: many });
    expect(md).toContain("- page-39");
    expect(md).not.toContain("- page-40");
    expect(md).toContain("…and 5 more.");
  });

  it("copies a note in without its front matter, cut when it is long", () => {
    expect(noteBody("---\nname: a\ntype: user\n---\n\nThe fact.")).toBe("The fact.");
    expect(noteBody("x".repeat(900))).toContain("[…cut, the rest is in the note]");
  });
});

describe("what Cube tells the wiki job about the workspace", () => {
  it("names people, cubes, channels, chats and schedules as facts", () => {
    const facts = workspaceFacts({ today: "2026-11-13", person: "Kane", teammates: ["Sean"], cubes: base.cubes, channels: [{ name: "general", shared: true, cubes: ["Writer"] }], chats: ["출시 일정 정리"], schedules: [{ text: "@Writer Brief me", when: "Weekdays at 09:00", where: "#general" }] });
    expect(facts).toContain("source: workspace");
    expect(facts).toContain("- Sean: a teammate.");
    expect(facts).toContain("- #general (shared with teammates): Writer");
    expect(facts).toContain("- 출시 일정 정리");
    expect(facts).toContain("- Weekdays at 09:00, in #general: @Writer Brief me");
  });
});

describe("what the wiki job offers to do next", () => {
  const said = "Pages updated.\nSUGGEST: @Writer 다음 주 출시 공지 초안을 써 주세요.\n`SUGGEST:` Schedule a weekly check of open issues.\nSUGGEST: @Writer 다음 주 출시 공지 초안을 써 주세요.\nADDED: 1\nUPDATED: 2\nREMOVED: 0\nThe project page has the new date.";
  it("is read from its SUGGEST lines, each once, three at most", () => {
    expect(suggestionsOf(said)).toEqual(["@Writer 다음 주 출시 공지 초안을 써 주세요.", "Schedule a weekly check of open issues."]);
    expect(suggestionsOf("ADDED: 0\nUPDATED: 0\nREMOVED: 0\nNothing changed.")).toEqual([]);
    expect(suggestionsOf("SUGGEST: a\nSUGGEST: b\nSUGGEST: c\nSUGGEST: d")).toHaveLength(3);
  });
  it("is not taken for the job's closing sentence", () => {
    expect(summaryOf("ADDED: 1\nUPDATED: 0\nREMOVED: 0\nAdded a page.\nSUGGEST: Do the next thing.")).toBe("1 added, 0 updated, 0 removed. Added a page.");
  });
});
