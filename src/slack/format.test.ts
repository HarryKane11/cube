import { describe, expect, it } from "vitest";
import { fromSlack, missingScopes, slackId, threadRoot, toSlack } from "./format";

describe("fromSlack", () => {
  it("takes the bot's mention out and writes other markup as plain text", () => {
    expect(fromSlack("<@UBOT> 요약해 줘 <https://example.com/doc|이 문서> 그리고 <@U123> 에게 <#C1|general>", "UBOT")).toBe("요약해 줘 이 문서 (https://example.com/doc) 그리고 @U123 에게 #general");
    expect(fromSlack("a &lt; b &amp;&amp; c &gt; d <https://x.example/p>", "UBOT")).toBe("a < b && c > d https://x.example/p");
  });
});

describe("toSlack", () => {
  it("turns markdown bold, links, headings and bullets into Slack's form", () => {
    expect(toSlack("## 결과\n\n**완료**했어요. [보고서](https://example.com/r) 참고.\n- 하나\n- 둘")).toBe("*결과*\n\n*완료*했어요. <https://example.com/r|보고서> 참고.\n• 하나\n• 둘");
  });

  it("escapes what Slack reserves, so a reply cannot mention everyone or fake a link", () => {
    expect(toSlack("<!channel> a & b <https://evil.example|click>")).toBe("&lt;!channel&gt; a &amp; b &lt;https://evil.example|click&gt;");
  });

  it("leaves code as it is, but for the reserved characters", () => {
    expect(toSlack("Run `a **b** <c>` then:\n```\n# not a heading\n- **x**\n```")).toBe("Run `a **b** &lt;c&gt;` then:\n```\n# not a heading\n- **x**\n```");
  });
});

describe("slackId", () => {
  it("gives a Slack message the same id every time", () => {
    expect(slackId("C1", "1794460000.000100")).toBe("sl-C1-1794460000.000100");
  });
});

describe("threadRoot", () => {
  const messages = [
    { id: "a", slack: { channel: "C1", ts: "100.1" } },
    { id: "b", parentId: "a", slack: { channel: "C1", ts: "100.1" } },
    { id: "c", slack: { channel: "D9", ts: "200.2" } },
    { id: "d" },
  ];
  it("finds the request a Slack thread hangs under", () => {
    expect(threadRoot(messages, "C1", "100.1")?.id).toBe("a");
    expect(threadRoot(messages, "D9", "200.2")?.id).toBe("c");
  });
  it("knows no thread the team was never called into", () => {
    expect(threadRoot(messages, "C1", "999.9")).toBeUndefined();
    expect(threadRoot(messages, "C2", "100.1")).toBeUndefined();
    expect(threadRoot(messages, "C1", "")).toBeUndefined();
  });
});

describe("missingScopes", () => {
  it("names what an app installed from the first manifest lacks", () => {
    expect(missingScopes(["app_mentions:read", "chat:write", "im:history", "users:read"])).toEqual(["channels:history", "groups:history", "files:write"]);
  });
  it("is empty for an app with everything, whatever else it has", () => {
    expect(missingScopes(["app_mentions:read", "chat:write", "im:history", "users:read", "channels:history", "groups:history", "files:write", "reactions:write"])).toEqual([]);
  });
});
