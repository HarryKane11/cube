import { beforeEach, describe, expect, it } from "vitest";
import type { Live } from "@/state/store";
import { busyCubes, checkForUpdate, installUpdate, progressOf, showUpdate, useUpdate, type UpdateApi } from "./index";

const reset = (patch: Partial<ReturnType<typeof useUpdate.getState>> = {}) =>
  useUpdate.setState({ current: "0.1.0", updates: true, phase: "idle", version: "", notes: "", progress: 0, error: "", show: 0, ...patch });

const api = (over: Partial<UpdateApi> = {}): UpdateApi => ({ check: async () => null, install: async () => undefined, ...over });

beforeEach(() => reset());

describe("checking for an update", () => {
  it("shows the newer version it finds", async () => {
    await checkForUpdate(false, api({ check: async () => ({ version: "0.2.0", notes: "Faster cubes" }) }));
    expect(useUpdate.getState()).toMatchObject({ phase: "found", version: "0.2.0", notes: "Faster cubes" });
  });

  it("says Cube is current when there is nothing newer", async () => {
    await checkForUpdate(false, api());
    expect(useUpdate.getState().phase).toBe("current");
  });

  it("tells the person why a check they asked for failed", async () => {
    await checkForUpdate(false, api({ check: async () => { throw "Could not reach the update server."; } }));
    expect(useUpdate.getState()).toMatchObject({ phase: "failed", error: "Could not reach the update server." });
  });

  it("keeps quiet when the check Cube makes by itself fails", async () => {
    reset({ phase: "found", version: "0.2.0" });
    await checkForUpdate(true, api({ check: async () => { throw "offline"; } }));
    expect(useUpdate.getState()).toMatchObject({ phase: "found", version: "0.2.0", error: "" });
  });

  it("never shows 'checking' for a quiet check", async () => {
    let seen = "";
    await checkForUpdate(true, api({ check: async () => { seen = useUpdate.getState().phase; return null; } }));
    expect(seen).toBe("idle");
  });

  it("does not ask at all in a copy that does not update itself", async () => {
    reset({ updates: false });
    let asked = false;
    await checkForUpdate(false, api({ check: async () => { asked = true; return null; } }));
    expect(asked).toBe(false);
    expect(useUpdate.getState().phase).toBe("idle");
  });

  it("leaves an install that is under way alone", async () => {
    reset({ phase: "installing", version: "0.2.0" });
    await checkForUpdate(false, api());
    expect(useUpdate.getState().phase).toBe("installing");
  });
});

describe("installing an update", () => {
  it("installs only a version a check found", async () => {
    let installed = 0;
    const counting = api({ install: async () => { installed += 1; } });
    await installUpdate(counting);
    expect(installed).toBe(0);
    reset({ phase: "found", version: "0.2.0" });
    await installUpdate(counting);
    expect(installed).toBe(1);
    // Cube restarts from here, so the screen stays on "installing".
    expect(useUpdate.getState().phase).toBe("installing");
  });

  it("says why an install failed, and can be tried again after another check", async () => {
    reset({ phase: "found", version: "0.2.0" });
    await installUpdate(api({ install: async () => { throw "The update was not signed by Cube, so it was not installed."; } }));
    expect(useUpdate.getState()).toMatchObject({ phase: "failed", error: "The update was not signed by Cube, so it was not installed." });
    await checkForUpdate(false, api({ check: async () => ({ version: "0.2.0", notes: "" }) }));
    expect(useUpdate.getState().phase).toBe("found");
  });
});

describe("what a restart would interrupt", () => {
  it("counts cubes that are thinking, working or waiting for an answer", () => {
    const live: Record<string, Live> = {
      a: { status: "working", statement: "" },
      b: { status: "thinking", statement: "" },
      c: { status: "needs", statement: "" },
      d: { status: "idle", statement: "" },
      e: { status: "done", statement: "" },
      f: { status: "stuck", statement: "" },
    };
    expect(busyCubes(live)).toBe(3);
    expect(busyCubes({})).toBe(0);
  });
});

describe("download progress", () => {
  it("is a share of the whole, or unknown when the server gives no size", () => {
    expect(progressOf(50, 200)).toBe(0.25);
    expect(progressOf(300, 200)).toBe(1);
    expect(progressOf(50, 0)).toBe(-1);
  });
});

describe("asking to be shown the update", () => {
  it("counts up, so Settings can tell a new request from an old one", () => {
    showUpdate();
    showUpdate();
    expect(useUpdate.getState().show).toBe(2);
  });
});
