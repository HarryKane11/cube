import { refreshEngines } from "@/agents/orchestrator";
import { AGENTS, ENGINES, pickEngine, type AgentKind } from "@/agents/types";
import { BrandMark } from "@/components/bits";
import { ChevronIcon } from "@/components/icons";
import { Cube } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

const KINDS = Object.keys(ENGINES) as AgentKind[];

/** The built-in and custom agents are offered once they are set up; the installed programs always are. */
export const shownEngine = (k: AgentKind, current: AgentKind, available: Partial<Record<AgentKind, boolean>>) =>
  (k !== "api" && k !== "custom" && k !== "remote") || k === current || Boolean(available[k]);

/** Which agent programs were found on this computer, with a way to look again. */
export function EnginesFound() {
  const available = useCube((s) => s.available);
  const none = !KINDS.some((k) => available[k]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {KINDS.map((k) => (
          <span key={k} className={cn("flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium", !available[k] && "text-muted-foreground")}>
            <BrandMark kind={k} /> {ENGINES[k].name}
            <span className={cn("text-xs", available[k] ? "text-primary" : "text-muted-foreground")}>{available[k] ? "found" : "not found"}</span>
          </span>
        ))}
        <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => void refreshEngines()}>
          Check again
        </button>
      </div>
      {none && (
        <p className="text-[13px] text-destructive" role="alert">
          No agent program was found. Install Claude Code or Codex and sign in to it, then check again.
        </p>
      )}
    </div>
  );
}

/** One row per role: its cube, what it does, and which engine powers it. */
export function RoleEngines() {
  const available = useCube((s) => s.available);
  const engines = useCube((s) => s.engines);
  const setEngine = useCube((s) => s.setEngine);
  const openProfile = useCube((s) => s.openProfile);
  const onboarded = useCube((s) => s.onboarded);
  // The roster grows when the person makes a sub-agent.
  useCube((s) => s.subagents);
  return (
    <ul className="flex flex-col">
      {AGENTS.map((a) => {
        const current = engines[a.id] ?? pickEngine(a, available);
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
            <Cube color={a.color} status="idle" size={44} />
            <div className="min-w-[140px] flex-1">
              <div className="font-semibold">{a.name}</div>
              <div className="text-[13px] text-muted-foreground">{a.role}</div>
            </div>
            <div className="flex rounded-[10px] bg-secondary p-0.5" role="group" aria-label={`Engine for ${a.name}`}>
              {KINDS.filter((k) => shownEngine(k, current, available)).map((k) => (
                <button
                  type="button"
                  key={k}
                  disabled={!available[k]}
                  aria-pressed={current === k}
                  title={available[k] ? ENGINES[k].name : `${ENGINES[k].name} was not found on this computer`}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground disabled:opacity-35",
                    current === k && "bg-background font-semibold text-foreground shadow-sm",
                  )}
                  onClick={() => setEngine(a.id, k)}
                >
                  <BrandMark kind={k} className="size-3" /> {ENGINES[k].name.split(" ")[0]}
                </button>
              ))}
            </div>
            {onboarded && (
              <button type="button" aria-label={`Open ${a.name}'s profile`} title="Model, setup and notes" className="flex size-8 items-center justify-center rounded-full bg-secondary" onClick={() => openProfile(a.id)}>
                <ChevronIcon width={15} height={15} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
