import { useState } from "react";
import { addSubagent } from "@/agents/orchestrator";
import { nameProblem } from "@/agents/subagents";
import { AGENTS, ENGINES, MODEL_HINTS, ROLE_DEFAULTS, type AgentDef, type AgentKind } from "@/agents/types";
import { leftNow, resetsIn, windowName } from "@/agents/usage";
import { BrandMark } from "@/components/bits";
import { CheckIcon } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNow, useRunsOn } from "@/components/UsageBits";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

const KINDS = Object.keys(ENGINES) as AgentKind[];

/**
 * Under a cube's name in the sidebar: the agent program and the model it runs on, in full.
 * Pressing it opens, right there, what can be changed about it: the program, the model, and for
 * a cube the person made, its name. A choice applies as it is made; nothing has to be saved.
 */
export function RunsOnPicker({ agent }: { agent: AgentDef }) {
  const { engine, model, usage } = useRunsOn(agent);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`${agent.name} runs on ${ENGINES[engine].name}${model ? `, ${model}` : ""}. Change`}
        className={cn("pointer-events-auto relative -ml-1 flex max-w-full items-center gap-1 rounded-md px-1 text-[11px] font-normal leading-[18px] text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", open && "bg-foreground/10 text-foreground")}
      >
        <BrandMark kind={engine} className="size-3 flex-none opacity-70" />
        <span className="min-w-0 truncate" data-notranslate>{model || ENGINES[engine].name}</span>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-64 gap-3 p-3">
        {open && <Choices agent={agent} engine={engine} usage={usage} />}
      </PopoverContent>
    </Popover>
  );
}

function Choices({ agent, engine, usage }: { agent: AgentDef; engine: AgentKind; usage: ReturnType<typeof useRunsOn>["usage"] }) {
  const sub = useCube((s) => s.subagents.find((x) => x.id === agent.id));
  const available = useCube((s) => s.available);
  const setEngine = useCube((s) => s.setEngine);
  const setModel = useCube((s) => s.setModel);
  const picked = useCube((s) => s.models[`${agent.id}:${engine}`]?.model?.trim() ?? "");
  // What the program uses when nothing is picked: the role's own model, else the program's setting.
  const fallback = useCube((s) => ROLE_DEFAULTS[agent.id]?.[engine]?.model ?? s.programModels[engine] ?? "");
  const ran = useCube((s) => s.ran[`${agent.id}:${engine}`] ?? "");
  const [name, setName] = useState(sub?.name ?? "");
  const [error, setError] = useState("");
  const [other, setOther] = useState("");
  const now = useNow();
  const label = "text-[11px] font-semibold text-muted-foreground";
  const options = [...new Set([picked, ran, ...MODEL_HINTS[engine]].filter((m) => m && m !== fallback))];

  const rename = () => {
    const next = name.trim();
    if (!sub || next === sub.name) return;
    const problem = nameProblem(next, AGENTS.filter((a) => a.id !== agent.id).map((a) => a.name));
    if (problem) return setError(problem);
    setError("");
    void addSubagent({ ...sub, name: next });
  };
  const option = (value: string, text: string, note?: string) => (
    <button type="button" key={value || "default"} role="menuitemradio" aria-checked={picked === value} className="flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-accent" onClick={() => setModel(agent.id, engine, { model: value })}>
      <span className="flex size-3.5 flex-none items-center justify-center text-primary">{picked === value && <CheckIcon width={13} height={13} strokeWidth={2.5} />}</span>
      <span className="min-w-0 flex-1 truncate" data-notranslate={value ? "" : undefined}>{text}</span>
      {note && <span className="min-w-0 max-w-[110px] flex-none truncate text-xs text-muted-foreground" data-notranslate>{note}</span>}
    </button>
  );

  return (
    <>
      {sub && (
        <div className="flex flex-col gap-1">
          <span className={label}>Name</span>
          <input aria-label="Name" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} onBlur={rename} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); rename(); } }} autoCapitalize="off" autoCorrect="off" spellCheck={false} className="selectable h-8 rounded-lg border bg-transparent px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          {error && <span className="text-xs text-destructive" role="alert">{error}</span>}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className={label}>Agent program</span>
        <div className="flex flex-wrap gap-1 rounded-[10px] bg-secondary p-0.5" role="group" aria-label="Agent program">
          {KINDS.filter((k) => available[k] || k === engine).map((k) => (
            <button type="button" key={k} aria-pressed={engine === k} disabled={!available[k]} className={cn("flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground disabled:opacity-35", engine === k && "bg-background font-semibold text-foreground shadow-sm")} onClick={() => setEngine(agent.id, k)}>
              <BrandMark kind={k} className="size-3" /> {ENGINES[k].name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-0.5" role="menu" aria-label="Model">
        <span className={cn(label, "pb-0.5")}>Model</span>
        {option("", "Default", fallback)}
        {options.map((m) => option(m, m))}
        <input aria-label="Another model" placeholder="Another model, then Enter" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && other.trim()) { e.preventDefault(); setModel(agent.id, engine, { model: other.trim() }); setOther(""); } }} autoCapitalize="off" autoCorrect="off" spellCheck={false} className="selectable mt-1 h-8 rounded-lg border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </div>
      {Boolean(usage?.windows.length) && (
        <div className="flex flex-col gap-1 border-t pt-2.5">
          <span className={label}>Plan usage</span>
          {usage!.windows.map((w) => {
            const when = resetsIn(w, now);
            return (
              <span key={w.id} className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
                <span className="min-w-0 truncate">{windowName(w)}</span>
                <span className="flex flex-none items-baseline gap-1 text-muted-foreground">
                  <span className="font-semibold text-foreground" data-notranslate>{leftNow(w, now)}%</span>
                  <span>left</span>
                  {when && <span data-notranslate>· {when}</span>}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}
