import { describe, expect, it } from "vitest";
import { AGENTS, agentById, mayCallLead, paletteOf, pickEngine, route } from "./types";

const everyone = AGENTS.map((a) => a.id);

describe("route", () => {
  it("hands a request to the role its words point to, in English and Korean", () => {
    expect(route("Fix the bug in the login script", everyone)).toBe("builder");
    expect(route("경쟁사 가격을 조사해서 비교해줘", everyone)).toBe("researcher");
    expect(route("Draft a one-page plan and a summary email", everyone)).toBe("writer");
    expect(route("랜딩 페이지 디자인 시안 만들어줘", everyone)).toBe("designer");
    expect(route("Review this and verify the numbers", everyone)).toBe("reviewer");
    // "Write" alone must not pull code work to the Writer.
    expect(route("Write a tiny script hello.py that prints hello", everyone)).toBe("builder");
  });

  it("returns null when nothing matches, so the caller can fall back", () => {
    expect(route("안녕 얘들아", everyone)).toBeNull();
    expect(route("hello", everyone)).toBeNull();
  });

  it("only considers roles that are in the conversation", () => {
    expect(route("Fix the bug in the login script", ["writer", "designer"])).toBeNull();
    expect(route("summarize the code", ["writer"])).toBe("writer");
  });
});

describe("pickEngine", () => {
  const builder = agentById("builder")!;

  it("uses the role's first choice when it is installed", () => {
    expect(pickEngine(builder, { codex: true, claude: true })).toBe("codex");
  });

  it("falls back to the next installed engine", () => {
    expect(pickEngine(builder, { claude: true })).toBe("claude");
  });

  it("still names an engine when none is installed", () => {
    expect(pickEngine(builder, {})).toBe("codex");
  });
});

describe("paletteOf", () => {
  it("gives a role's cube three sticker colors and leaves other colors plain", () => {
    expect(paletteOf(agentById("writer")!.color)).toHaveLength(3);
    expect(paletteOf("#C7C7CC")).toBeNull();
  });
});

describe("keyword routing, used when there is no Router", () => {
  it("does not take one syllable inside another word for a role's keyword", async () => {
    const { route } = await import("./types");
    const members = ["researcher", "writer", "builder", "designer", "reviewer"];
    // "탐색" (explore) has "색" (color) in it, which used to send this to the Designer.
    expect(route("피클이라는 에이전트 관련 여론은 dc에서 탐색해볼래?", members)).toBe("researcher");
    expect(route("버튼 색상을 바꿔줘", members)).toBe("designer");
  });
});

describe("who may call the Orchestrator by naming it", () => {
  it("lets the Router, always", () => {
    expect(mayCallLead(true, false)).toBe(true);
    expect(mayCallLead(true, true)).toBe(true);
  });

  it("lets a teammate when no plan would bring the Orchestrator back", () => {
    // The Orchestrator handed one thing straight over, or the person asked the teammate themselves.
    expect(mayCallLead(false, false)).toBe(true);
  });

  it("does not start it twice for a teammate working on its plan", () => {
    // It is called back by itself when everyone it named has finished.
    expect(mayCallLead(false, true)).toBe(false);
  });
});
