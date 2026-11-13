import { useEffect, useState } from "react";
import { ENGINES, ROLE_DEFAULTS, type AgentDef, type AgentKind } from "@/agents/types";
import { leftNow, resetsIn, tightest, tone, windowName, type ProgramUsage, type UsageProgram, type UsageWindow } from "@/agents/usage";
import { useEngine } from "@/components/bits";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

const TONE = { ok: "text-primary", low: "text-amber-500", out: "text-destructive" } as const;
const FILL = { ok: "bg-primary", low: "bg-amber-500", out: "bg-destructive" } as const;

/** The time now, read again every minute: gauges count down to when a window starts over. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/**
 * What a role runs on right now: the agent program, and the model as far as it is known (the
 * one picked for it, else the role's own, else what the program said it ran last, else the
 * program's own setting). Empty model when nothing says.
 */
export function useRunsOn(agent: AgentDef): { engine: AgentKind; model: string; usage?: ProgramUsage } {
  const engine = useEngine(agent);
  const model = useCube((s) => s.models[`${agent.id}:${engine}`]?.model?.trim() || ROLE_DEFAULTS[agent.id]?.[engine]?.model || s.ran[`${agent.id}:${engine}`] || s.programModels[engine] || "");
  const usage = useCube((s) => (engine === "claude" || engine === "codex" ? s.usage[engine] : undefined));
  return { engine, model, usage };
}

/** How much is left, as a small ring: full when nothing is used, drained as the plan's window fills. */
export function Ring({ left, size = 14 }: { left: number; size?: number }) {
  const r = 5;
  const round = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} className={cn("flex-none -rotate-90", TONE[tone(left)])} aria-hidden="true">
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.18" />
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={`${(Math.max(left, 0) / 100) * round} ${round}`} />
    </svg>
  );
}

/**
 * At the end of a cube's row in the sidebar: a ring for the tightest window of the plan it draws
 * on. Resting the pointer on it says how much of each window is left.
 */
export function UsageRing({ agent }: { agent: AgentDef }) {
  const { engine, usage } = useRunsOn(agent);
  const now = useNow();
  const worst = tightest(usage, now);
  if (!worst || !usage) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="pointer-events-auto relative flex flex-none items-center p-0.5" />} aria-label={`${windowName(worst)}: ${leftNow(worst, now)}% left`}>
        <Ring left={leftNow(worst, now)} size={14} />
      </TooltipTrigger>
      <TooltipContent side="right" className="flex-col items-start gap-1 py-2">
        <span className="font-semibold" data-notranslate>{ENGINES[engine].name}{usage.plan ? ` · ${usage.plan}` : ""}</span>
        {usage.windows.map((w) => {
          const when = resetsIn(w, now);
          return (
            <span key={w.id} className="flex w-full items-baseline justify-between gap-4 tabular-nums">
              <span>{windowName(w)}</span>
              <span className="flex items-baseline gap-1">
                <span className="font-semibold" data-notranslate>{leftNow(w, now)}%</span>
                <span>left</span>
                {when && <span className="opacity-70" data-notranslate>· {when}</span>}
              </span>
            </span>
          );
        })}
      </TooltipContent>
    </Tooltip>
  );
}

function Bar({ w, now }: { w: UsageWindow; now: number }) {
  const left = leftNow(w, now);
  const when = resetsIn(w, now);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="min-w-0 truncate font-medium">{windowName(w)}</span>
        <span className="flex flex-none items-baseline gap-1.5 tabular-nums">
          <span className={cn("font-semibold", TONE[tone(left)])} data-notranslate>{left}%</span>
          <span className="text-muted-foreground">left</span>
        </span>
      </div>
      <span className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={windowName(w)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}>
        <span className={cn("block h-full rounded-full transition-[width]", FILL[tone(left)])} style={{ width: `${Math.max(left, 0)}%` }} />
      </span>
      {when && <span className="text-xs text-muted-foreground">Starts over in <span data-notranslate>{when}</span></span>}
    </div>
  );
}

/** Every window of a program's plan, each as a bar of what is left, with when it starts over. */
export function UsageBars({ program }: { program: UsageProgram }) {
  const usage = useCube((s) => s.usage[program]);
  const now = useNow();
  if (!usage) return <p className="text-[13px] text-muted-foreground">Not checked yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      {usage.windows.map((w) => <Bar key={w.id} w={w} now={now} />)}
      {!usage.windows.length && <p className="text-[13px] text-muted-foreground" data-notranslate>{usage.note ?? "Not reported."}</p>}
      {usage.credits && (usage.credits.unlimited || usage.credits.balance) && (
        <p className="text-[13px] text-muted-foreground">Extra usage: <span className="font-medium text-foreground" data-notranslate>{usage.credits.unlimited ? "unlimited" : usage.credits.balance}</span></p>
      )}
    </div>
  );
}

/** When the numbers were read, in words. */
export function ReadAt({ program }: { program: UsageProgram }) {
  const at = useCube((s) => s.usage[program]?.updatedAt);
  const now = useNow();
  if (!at) return null;
  const minutes = Math.round((now - at) / 60_000);
  return <span className="text-xs text-muted-foreground">{minutes < 1 ? "Checked just now" : <>Checked <span data-notranslate>{minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`}</span> ago</>}</span>;
}
