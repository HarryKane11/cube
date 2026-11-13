/**
 * Keeps what is known of each plan's limits up to date: from what the agent programs say while
 * they run, and by asking them when the app opens or the person looks (see usage.ts for what
 * the numbers are and src-tauri/src/usage.rs for the asking).
 */
import { invoke } from "@tauri-apps/api/core";
import { useCube } from "@/state/store";
import { getHarness, inTauri } from "./runner";
import { claudeLimitEvent, claudeUsage, codexUsage, type ProgramUsage, type UsageProgram } from "./usage";

const PROGRAMS: UsageProgram[] = ["claude", "codex"];
/** An answer this fresh is not asked for again unless the person presses the button. */
const FRESH = 3 * 60_000;

/** Lays what a program just said about its limits over what was known. */
export function takeLimits(program: UsageProgram, how: "read" | "event", raw: unknown): void {
  const s = useCube.getState();
  const before = s.usage[program];
  const now = Date.now();
  const next = program === "codex" ? codexUsage(raw, now) : how === "read" ? claudeUsage(raw, now) : claudeLimitEvent(raw, before, now);
  if (!next) return;
  // An update pushed during a run may leave out what has not changed: the plan's name, the credits.
  s.setUsage(program, { ...next, plan: next.plan ?? before?.plan, credits: next.credits ?? before?.credits, windows: next.windows.length ? next.windows : (before?.windows ?? []) });
}

/** What the gauges show in the browser preview, where no program can be asked. */
const SAMPLE: Record<UsageProgram, () => ProgramUsage> = {
  claude: () => ({ plan: "max", windows: [{ id: "five_hour", minutes: 300, used: 38, resetsAt: Date.now() + 130 * 60_000 }, { id: "seven_day", minutes: 10080, used: 61, resetsAt: Date.now() + 3.2 * 86_400_000 }, { id: "seven_day_opus", minutes: 10080, used: 82, resetsAt: Date.now() + 3.2 * 86_400_000 }], updatedAt: Date.now() }),
  codex: () => ({ plan: "pro", windows: [{ id: "primary", minutes: 10080, used: 24, resetsAt: Date.now() + 5 * 86_400_000 }], updatedAt: Date.now() }),
};

let asking: Promise<void> | undefined;

/**
 * Asks each installed program that can say how much of its plan is used, and what model it uses
 * when none is picked. One round at a time. Without `force`, a program asked a moment ago is
 * left alone: asking starts the program, which takes a second or two.
 */
export function refreshUsage(force = false): Promise<void> {
  asking ??= (async () => {
    const s = useCube.getState();
    if (!inTauri) {
      for (const p of PROGRAMS) if (!s.usage[p] || force) s.setUsage(p, SAMPLE[p]());
      s.setProgramModels({ claude: "claude-opus-5-5", codex: "gpt-6-luna", hermes: "gpt-5.5" });
      return;
    }
    const models: Record<string, string> = { ...s.programModels };
    await Promise.all([
      ...PROGRAMS.filter((p) => s.available[p]).map(async (p) => {
        const known = useCube.getState().usage[p];
        if (!force && known && Date.now() - known.updatedAt < FRESH) return;
        try {
          takeLimits(p, "read", await invoke<unknown>("usage_read", { program: p }));
        } catch (e) {
          // What was known stays: an old number with its time is better than none. With nothing known, say why.
          if (!known) useCube.getState().setUsage(p, { windows: [], note: String(e instanceof Error ? e.message : e).slice(0, 200), updatedAt: Date.now() });
        }
      }),
      ...(["claude", "codex", "hermes"] as const).filter((p) => s.available[p]).map(async (p) => {
        const h = await getHarness(p).catch(() => undefined);
        if (h?.model) models[p] = h.model;
      }),
    ]);
    useCube.getState().setProgramModels(models);
  })().finally(() => { asking = undefined; });
  return asking;
}
