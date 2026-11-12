import { describe, expect, it } from "vitest";
import { translate } from "./dom";

describe("Korean interface text", () => {
  it("looks whole pieces up and keeps the spaces around them", () => {
    expect(translate("Inbox")).toBe("받은 큐브함");
    // A particle attaches to the name before it: "Builder" + " needs your OK" reads "Builder가 …".
    expect(translate(" needs your OK")).toBe("가 확인을 기다려요");
    expect(translate("  · live ")).toBe("  · 실시간 ");
  });

  it("builds sentences that carry a name, a number or a file", () => {
    expect(translate("Builder is running pnpm test")).toBe("Builder: pnpm test 실행 중");
    expect(translate("Writer is searching the web")).toBe("Writer: 웹 검색 중");
    expect(translate("Designer is waiting for your OK")).toBe("Designer가 확인을 기다려요");
    expect(translate("Builder needs your OK: run a command")).toBe("Builder가 확인을 기다려요: 명령 실행");
    expect(translate("3 replies")).toBe("답글 3개");
    expect(translate("Message #general. Type @ to hand work to a cube")).toBe("#general에 메시지 보내기. @로 큐브에게 일을 맡겨요");
    expect(translate("This is the start of #launch")).toBe("#launch 채널의 시작이에요");
    expect(translate("Today at 09:00")).toBe("오늘 09:00");
  });

  it("translates pieces joined by a dot one by one, and leaves what it does not know", () => {
    expect(translate("2 replies · 1 file changed (a.md)")).toBe("답글 2개 · 파일 1개 변경 (a.md)");
    expect(translate("notes.md")).toBeNull();
    expect(translate("오늘 할 일")).toBeNull();
    expect(translate("12:30")).toBeNull();
  });
});
