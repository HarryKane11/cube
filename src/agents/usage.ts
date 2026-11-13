/**
 * How much of a plan is left. Claude Code and Codex, signed in with a subscription, count what
 * is used inside windows of time (five hours, a week) and say how full each window is. Cube
 * reads that from the programs themselves: from what they say while they run, and by asking
 * them (src-tauri/src/usage.rs). The numbers belong to the account a program is signed in
 * with, so every cube running on that program shares them.
 *
 * This file holds what can be worked out without running anything: reading each program's
 * wording into one shape, and what to show for it.
 */

export type UsageProgram = "claude" | "codex";

/** One window of time a plan counts usage in. */
export interface UsageWindow {
  /** What the program calls it: "five_hour", "seven_day", "seven_day_opus", "primary"… */
  id: string;
  /** How long the window is, when the program says. */
  minutes?: number;
  /** How full it is, 0 to 100. */
  used: number;
  /** When it starts over, in milliseconds since 1970. */
  resetsAt?: number;
  /** A name the program gives it, for windows that are about one model. */
  name?: string;
}

export interface ProgramUsage {
  /** The plan the program is signed in with, as the program names it. */
  plan?: string;
  windows: UsageWindow[];
  /** Extra usage bought beyond the plan, when there is any. */
  credits?: { balance?: string; unlimited?: boolean };
  /** Why there are no windows: signed in with an API key, or the program would not say. */
  note?: string;
  updatedAt: number;
}

const pct = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Codex: the answer to `account/rateLimits/read`, or the `rateLimits` of an update pushed during a run. */
export function codexUsage(raw: unknown, now: number): ProgramUsage | undefined {
  const o = raw as Record<string, any> | null;
  const snap = (o?.rateLimits ?? o?.rate_limits ?? o) as Record<string, any> | null | undefined;
  if (!snap || typeof snap !== "object") return undefined;
  const windows: UsageWindow[] = [];
  for (const id of ["primary", "secondary"]) {
    const w = snap[id];
    const used = pct(w?.usedPercent ?? w?.used_percent);
    if (used === undefined) continue;
    const minutes = w.windowDurationMins ?? w.window_minutes;
    const resets = w.resetsAt ?? w.resets_at;
    windows.push({ id, used, minutes: typeof minutes === "number" ? minutes : undefined, resetsAt: typeof resets === "number" ? resets * 1000 : undefined });
  }
  const credits = snap.credits && typeof snap.credits === "object" ? { balance: text(snap.credits.balance), unlimited: snap.credits.unlimited === true || undefined } : undefined;
  const plan = text(snap.planType ?? snap.plan_type);
  if (!windows.length && !plan && !credits) return undefined;
  return { plan, windows, credits: credits?.balance || credits?.unlimited ? credits : undefined, note: windows.length ? undefined : "No plan limits reported for this sign-in.", updatedAt: now };
}

const CLAUDE_WINDOWS: Record<string, number> = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, seven_day_oauth_apps: 10080 };

/** Claude Code: the answer to its `get_usage` request. Percent is 0 to 100 and times are ISO text. */
export function claudeUsage(raw: unknown, now: number): ProgramUsage | undefined {
  const o = raw as Record<string, any> | null;
  if (!o || typeof o !== "object") return undefined;
  const windows: UsageWindow[] = [];
  const limits = (o.rate_limits ?? {}) as Record<string, any>;
  for (const [id, minutes] of Object.entries(CLAUDE_WINDOWS)) {
    const used = pct(limits[id]?.utilization);
    if (used === undefined) continue;
    const at = Date.parse(limits[id].resets_at ?? "");
    windows.push({ id, used, minutes, resetsAt: Number.isFinite(at) ? at : undefined });
  }
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const used = pct(m?.utilization);
    const name = text(m?.display_name);
    if (used === undefined || !name) continue;
    const at = Date.parse(m.resets_at ?? "");
    windows.push({ id: `model:${name}`, name, used, resetsAt: Number.isFinite(at) ? at : undefined });
  }
  const plan = text(o.subscription_type);
  if (!windows.length && !plan && o.rate_limits_available === undefined) return undefined;
  return { plan, windows, note: windows.length ? undefined : "No plan limits reported for this sign-in.", updatedAt: now };
}

/**
 * Claude Code: what it says about its limits while it runs (`rate_limit_event`). Here a window's
 * fullness is a fraction of 1 and times are seconds. One event may be about one window only,
 * so it is laid over what was known.
 */
export function claudeLimitEvent(info: unknown, before: ProgramUsage | undefined, now: number): ProgramUsage | undefined {
  const o = info as Record<string, any> | null;
  if (!o || typeof o !== "object") return undefined;
  const seen: UsageWindow[] = [];
  const add = (id: string, w: any) => {
    const used = pct(typeof w?.utilization === "number" ? w.utilization * 100 : undefined);
    if (used === undefined || !CLAUDE_WINDOWS[id]) return;
    seen.push({ id, used, minutes: CLAUDE_WINDOWS[id], resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : undefined });
  };
  for (const [id, w] of Object.entries((o.unifiedWindows ?? {}) as Record<string, unknown>)) add(id, w);
  if (typeof o.rateLimitType === "string" && !seen.some((w) => w.id === o.rateLimitType)) add(o.rateLimitType, o);
  if (!seen.length) return undefined;
  const kept = (before?.windows ?? []).filter((w) => !seen.some((s) => s.id === w.id));
  return { ...before, windows: order([...kept, ...seen]), note: undefined, updatedAt: now };
}

/** Shortest window first: the one that fills soonest is what a person wants to see first. */
const order = (windows: UsageWindow[]): UsageWindow[] => [...windows].sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9) || a.id.localeCompare(b.id));

/** A window that has started over since it was read is empty again, whatever was read. */
export const usedNow = (w: UsageWindow, now: number): number => (w.resetsAt !== undefined && w.resetsAt <= now ? 0 : w.used);
export const leftNow = (w: UsageWindow, now: number): number => Math.round(100 - usedNow(w, now));

/** The window with the least left: the one a small gauge stands for. */
export function tightest(usage: ProgramUsage | undefined, now: number): UsageWindow | undefined {
  return usage?.windows.reduce<UsageWindow | undefined>((worst, w) => (!worst || usedNow(w, now) > usedNow(worst, now) ? w : worst), undefined);
}

/** What a window is called. Interface text, in English. */
export function windowName(w: UsageWindow): string {
  if (w.name) return w.name;
  const model = /^seven_day_(opus|sonnet)$/.exec(w.id)?.[1];
  if (model) return `Weekly, ${model === "opus" ? "Opus" : "Sonnet"}`;
  if (w.id === "seven_day_oauth_apps") return "Weekly, other apps";
  if (w.minutes === 300) return "5-hour window";
  if (w.minutes === 10080) return "Weekly";
  if (w.minutes && w.minutes % 1440 === 0) return `${w.minutes / 1440}-day window`;
  if (w.minutes && w.minutes % 60 === 0) return `${w.minutes / 60}-hour window`;
  return w.minutes ? `${w.minutes}-minute window` : "Usage";
}

/** How long until a window starts over, in figures any language reads: "2h 10m", "3d 5h". Empty when not known or already past. */
export function resetsIn(w: UsageWindow, now: number): string {
  if (w.resetsAt === undefined || w.resetsAt <= now) return "";
  const minutes = Math.round((w.resetsAt - now) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

/** How a gauge is colored: calm while there is room, a warning when little is left. */
export const tone = (left: number): "ok" | "low" | "out" => (left <= 5 ? "out" : left <= 25 ? "low" : "ok");
