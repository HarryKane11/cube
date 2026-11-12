import { describe, expect, it } from "vitest";
import { MAX_AVATAR, validAvatar } from "./avatar";

describe("validAvatar", () => {
  it("takes a small bitmap given as a data address", () => {
    expect(validAvatar("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe(true);
    expect(validAvatar("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(validAvatar("data:image/webp;base64,UklGRg==")).toBe(true);
  });
  it("takes nothing else: a web address, SVG, other text, or one that is too long", () => {
    expect(validAvatar("https://example.com/me.png")).toBe(false);
    expect(validAvatar("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(validAvatar("data:image/png;base64,ab cd")).toBe(false);
    expect(validAvatar("data:text/html;base64,PGI+")).toBe(false);
    expect(validAvatar(`data:image/jpeg;base64,${"A".repeat(MAX_AVATAR)}`)).toBe(false);
    expect(validAvatar("")).toBe(false);
    expect(validAvatar(undefined)).toBe(false);
  });
});
