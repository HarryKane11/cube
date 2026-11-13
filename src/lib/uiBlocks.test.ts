import { describe, expect, it } from "vitest";
import { cubeLibrary, uiRule } from "@/components/intelligent/library";
import { actionMessage, hasUi, splitUi, withoutFences } from "./uiBlocks";

const view = 'root = Col([t])\nt = Title("Hello")';

describe("splitUi", () => {
  it("leaves a reply without a view as it is", () => {
    const text = "Plain.\n\n```ts\nconst a = 1;\n```\n\nMore.";
    expect(hasUi(text)).toBe(false);
    expect(splitUi(text)).toEqual([{ ui: false, body: text }]);
  });

  it("takes a view out from between the text around it", () => {
    const text = `Here it is.\n\n\`\`\`openui-lang\n${view}\n\`\`\`\n\nAnything else?`;
    expect(hasUi(text)).toBe(true);
    expect(splitUi(text)).toEqual([{ ui: false, body: "Here it is.\n" }, { ui: true, body: view }, { ui: false, body: "\nAnything else?" }]);
  });

  it("marks a view that is still being written", () => {
    expect(splitUi(`Look:\n\`\`\`openui-lang\nroot = Col([t])`)).toEqual([{ ui: false, body: "Look:" }, { ui: true, body: "root = Col([t])", open: true }]);
  });
});

describe("withoutFences", () => {
  it("drops what is inside blocks, so a function in a view calls no cube", () => {
    const text = `Ask @Writer.\n\`\`\`openui-lang\nb = Button("Go", @ToAssistant("go"))\n\`\`\`\nThen @Reviewer.`;
    const left = withoutFences(text);
    expect(left).toContain("@Writer");
    expect(left).toContain("@Reviewer");
    expect(left).not.toContain("@ToAssistant");
    expect(withoutFences("Open:\n```\n@Each\nno end")).not.toContain("@Each");
  });
});

describe("actionMessage", () => {
  it("shows the words and what was filled in", () => {
    expect(actionMessage("Book it", [undefined, { trip: { city: { value: "Lisbon", componentType: "Input" }, nights: { value: 3 } } }])).toBe("Book it\n- city: Lisbon\n- nights: 3");
    expect(actionMessage("Go on", ["only the first two", {}])).toBe("Go on\nonly the first two");
    expect(actionMessage("Go on", [])).toBe("Go on");
  });
});

describe("what a cube is told about views", () => {
  it("names every component, and says a view is optional", () => {
    const rule = uiRule();
    for (const name of Object.keys(cubeLibrary.components)) expect(rule).toContain(name);
    expect(rule).toContain("```openui-lang");
    expect(rule).toContain("Most replies need none.");
    // It is sent at the start of every session: it has to stay small.
    expect(rule.length).toBeLessThan(9000);
    console.log(`view rule: ${rule.length} chars`);
  });
});
