import { describe, expect, it } from "vitest";
import { uiScaleForKey } from "./uiScale";

describe("screen size shortcuts", () => {
  it("accepts plus with or without Shift and steps back down", () => {
    expect(uiScaleForKey(100, "+")).toBe(110);
    expect(uiScaleForKey(100, "=")).toBe(110);
    expect(uiScaleForKey(110, "-")).toBe(100);
  });

  it("keeps repeated zoom keys within a usable range", () => {
    let scale = 100;
    for (let i = 0; i < 20; i++) scale = uiScaleForKey(scale, "+")!;
    expect(scale).toBe(150);
    for (let i = 0; i < 20; i++) scale = uiScaleForKey(scale, "-")!;
    expect(scale).toBe(80);
  });

  it("restores the default from either end of the range", () => {
    expect(uiScaleForKey(80, "0")).toBe(100);
    expect(uiScaleForKey(150, "0")).toBe(100);
  });

  it("leaves unrelated shortcuts alone", () => {
    expect(uiScaleForKey(100, "k")).toBeUndefined();
    expect(uiScaleForKey(100, "b")).toBeUndefined();
  });
});
