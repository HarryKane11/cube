import { describe, expect, it } from "vitest";
import { translate } from "./dom";

describe("Korean interface text", () => {
  it("looks whole pieces up and keeps the spaces around them", () => {
    expect(translate("Inbox")).toBe("할 일");
    // A particle attaches to the name before it: "Builder" + " needs your OK" reads "Builder가 …".
    expect(translate(" needs your OK")).toBe("가 확인을 기다려요");
    expect(translate("  · live ")).toBe("  · 실시간 ");
  });

  it("builds sentences that carry a name, a number or a file", () => {
    expect(translate("Builder is running pnpm test")).toBe("빌더: pnpm test 실행 중");
    expect(translate("Writer is searching the web")).toBe("라이터: 웹 검색 중");
    expect(translate("Designer is waiting for your OK")).toBe("디자이너가 확인을 기다려요");
    expect(translate("Builder needs your OK: run a command")).toBe("빌더가 확인을 기다려요: 명령 실행");
    expect(translate("3 replies")).toBe("답글 3개");
    expect(translate("Message #general. Type @ to hand work to a cube")).toBe("#general에 메시지 보내기. @로 큐브에게 일을 맡겨요");
    expect(translate("This is the start of #launch")).toBe("#launch 채널의 시작이에요");
    expect(translate("Today at 09:00")).toBe("오늘 09:00");
  });

  it("words what the updater says, with the version in it", () => {
    expect(translate("Version 0.1.0")).toBe("버전 0.1.0");
    expect(translate("Cube 0.2.0 is ready to install.")).toBe("Cube 0.2.0 버전을 설치할 수 있어요.");
    expect(translate("Update to 0.2.0")).toBe("0.2.0 버전으로 업데이트");
    expect(translate("Downloading… 42%")).toBe("내려받는 중… 42%");
    expect(translate("3 cubes are working. Restarting stops them.")).toBe("큐브 3개가 작업 중이에요. 다시 시작하면 작업이 멈춰요.");
    expect(translate("Check for updates")).toBe("업데이트 확인");
  });

  it("calls the built-in cubes by their Korean names, alone or inside a sentence", () => {
    expect(translate("Researcher")).toBe("리서처");
    expect(translate(" Orchestrator ")).toBe(" 오케스트레이터 ");
    // A file or a longer word that only contains a name is not a cube.
    expect(translate("Writer.md")).toBeNull();
    expect(translate("Writers")).toBeNull();
  });

  it("translates pieces joined by a dot one by one, and leaves what it does not know", () => {
    expect(translate("2 replies · 1 file changed (a.md)")).toBe("답글 2개 · 파일 1개 변경 (a.md)");
    expect(translate("notes.md")).toBeNull();
    expect(translate("오늘 할 일")).toBeNull();
    expect(translate("12:30")).toBeNull();
  });
});
