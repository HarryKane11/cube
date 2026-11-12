import { describe, expect, it } from "vitest";
import { SHORTCUTS, commandFor } from "./shortcuts";

const press = (key: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}) => commandFor({ key, shiftKey: false, altKey: false, ...mods });

describe("commandFor", () => {
  it("knows Cube's own shortcuts", () => {
    expect(press("k")).toEqual({ t: "switch" });
    expect(press("K")).toEqual({ t: "switch" });
    expect(press(",")).toEqual({ t: "settings" });
    expect(press("n")).toEqual({ t: "channel" });
    expect(press("N", { shiftKey: true })).toEqual({ t: "dm" });
    expect(press("I", { shiftKey: true })).toEqual({ t: "invite" });
    expect(press(".")).toEqual({ t: "stage" });
    expect(press("3")).toEqual({ t: "nth", n: 3 });
    expect(press("ArrowDown", { altKey: true })).toEqual({ t: "step", by: 1 });
    expect(press("ArrowUp", { altKey: true })).toEqual({ t: "step", by: -1 });
  });
  it("leaves the rest alone: copy, paste, and the size keys handled elsewhere", () => {
    for (const key of ["c", "v", "a", "z", "0", "=", "-", "ArrowUp"]) expect(press(key)).toBeUndefined();
    expect(press("b", { shiftKey: true })).toBeUndefined();
  });
  it("lists every shortcut once", () => {
    expect(new Set(SHORTCUTS.map((s) => s.keys)).size).toBe(SHORTCUTS.length);
  });
});
