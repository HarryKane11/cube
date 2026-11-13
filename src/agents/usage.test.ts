import { describe, expect, it } from "vitest";
import { claudeLimitEvent, claudeUsage, codexUsage, leftNow, resetsIn, tightest, tone, windowName } from "./usage";

const NOW = 1_800_000_000_000;

describe("codexUsage", () => {
  it("reads the answer to account/rateLimits/read, whatever length its windows are", () => {
    const u = codexUsage({ rateLimits: { planType: "pro", primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: NOW / 1000 + 3600 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "12.50" } } }, NOW);
    expect(u).toEqual({ plan: "pro", windows: [{ id: "primary", used: 24, minutes: 10080, resetsAt: NOW + 3_600_000 }], credits: { balance: "12.50", unlimited: undefined }, note: undefined, updatedAt: NOW });
    expect(windowName(u!.windows[0])).toBe("Weekly");
  });

  it("reads the same numbers as a session file writes them", () => {
    const u = codexUsage({ rate_limits: { plan_type: "plus", primary: { used_percent: 61.5, window_minutes: 300, resets_at: NOW / 1000 + 60 }, secondary: { used_percent: 10, window_minutes: 10080 } } }, NOW);
    expect(u?.windows.map((w) => [w.id, w.used, w.minutes])).toEqual([["primary", 61.5, 300], ["secondary", 10, 10080]]);
    expect(windowName(u!.windows[0])).toBe("5-hour window");
  });

  it("says so when the sign-in has no plan windows", () => {
    expect(codexUsage({ rateLimits: { planType: "api" } }, NOW)?.note).toBeTruthy();
    expect(codexUsage(null, NOW)).toBeUndefined();
    expect(codexUsage({}, NOW)).toBeUndefined();
  });
});

describe("claudeUsage", () => {
  it("reads get_usage: percent as it is, times from text", () => {
    const u = claudeUsage({ subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 38, resets_at: new Date(NOW + 7_800_000).toISOString() }, seven_day: { utilization: 61, resets_at: null }, seven_day_opus: null, model_scoped: [{ display_name: "Fable", utilization: 12, resets_at: new Date(NOW + 1000).toISOString() }] } }, NOW);
    expect(u?.plan).toBe("max");
    expect(u?.windows.map((w) => [w.id, w.used, w.resetsAt])).toEqual([["five_hour", 38, NOW + 7_800_000], ["seven_day", 61, undefined], ["model:Fable", 12, NOW + 1000]]);
    expect(windowName(u!.windows[2])).toBe("Fable");
  });

  it("says so for a sign-in without plan limits", () => {
    expect(claudeUsage({ subscription_type: null, rate_limits_available: false }, NOW)).toMatchObject({ windows: [], note: expect.any(String) });
    expect(claudeUsage(undefined, NOW)).toBeUndefined();
  });
});

describe("claudeLimitEvent", () => {
  it("lays an event about one window over what was known, a fraction read as a percent", () => {
    const before = claudeUsage({ subscription_type: "max", rate_limits: { five_hour: { utilization: 38 }, seven_day: { utilization: 61 } } }, NOW - 1000);
    const after = claudeLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82, resetsAt: NOW / 1000 + 600 }, before, NOW);
    expect(after?.plan).toBe("max");
    expect(after?.windows.map((w) => [w.id, Math.round(w.used)])).toEqual([["five_hour", 82], ["seven_day", 61]]);
    expect(after?.windows[0].resetsAt).toBe(NOW + 600_000);
  });

  it("takes every window when the event carries them all", () => {
    const u = claudeLimitEvent({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 }, seven_day: { utilization: 0.5, resetsAt: 2 } } }, undefined, NOW);
    expect(u?.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day"]);
  });

  it("gives nothing for an event with no window in it", () => {
    expect(claudeLimitEvent({ status: "allowed" }, undefined, NOW)).toBeUndefined();
    expect(claudeLimitEvent({ rateLimitType: "overage", utilization: 0.3 }, undefined, NOW)).toBeUndefined();
  });
});

describe("what a gauge shows", () => {
  const usage = { windows: [{ id: "five_hour", minutes: 300, used: 38, resetsAt: NOW + 130 * 60_000 }, { id: "seven_day", minutes: 10080, used: 82, resetsAt: NOW + 3 * 86_400_000 + 5 * 3_600_000 }], updatedAt: NOW };

  it("stands for the window with the least left", () => {
    expect(tightest(usage, NOW)?.id).toBe("seven_day");
    expect(leftNow(usage.windows[1], NOW)).toBe(18);
    expect(tightest(undefined, NOW)).toBeUndefined();
  });

  it("counts a window that has started over as empty again", () => {
    expect(leftNow(usage.windows[0], NOW + 131 * 60_000)).toBe(100);
    expect(tightest({ ...usage, windows: [usage.windows[0], { ...usage.windows[1], resetsAt: NOW - 1 }] }, NOW)?.id).toBe("five_hour");
  });

  it("says when a window starts over, and warns when little is left", () => {
    expect(resetsIn(usage.windows[0], NOW)).toBe("2h 10m");
    expect(resetsIn(usage.windows[1], NOW)).toBe("3d 5h");
    expect(resetsIn({ id: "x", used: 1, resetsAt: NOW + 20_000 }, NOW)).toBe("1m");
    expect(resetsIn({ id: "x", used: 1 }, NOW)).toBe("");
    expect([tone(60), tone(20), tone(3)]).toEqual(["ok", "low", "out"]);
  });
});
