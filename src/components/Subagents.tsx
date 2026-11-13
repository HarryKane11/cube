import { useEffect, useRef, useState } from "react";
import { addSubagent } from "@/agents/orchestrator";
import { runSetup } from "@/agents/setupRun";
import { nameProblem, newId, type SubAgent } from "@/agents/subagents";
import { AGENTS, PALETTES, type Palette } from "@/agents/types";
import { PropPicker } from "@/components/PropPicker";
import { Input } from "@/components/ui/input";
import { CubeStill } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";
import { dropSubagentMd } from "@/knowledge";
import { setSubagentShared } from "@/team";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";
type Draft = { name: string; role: string; brief: string; instructions: string; palette: Palette; prop?: string; uses: { mcp: string[]; skills: string[] } };
const BLANK: Draft = { name: "", role: "", brief: "", instructions: "", palette: PALETTES[0].colors as Palette, uses: { mcp: [], skills: [] } };

/** The form a sub-agent is made or changed with. A connected agent program can fill it in from a sentence or two. */
function Editor({ sub, onDone }: { sub?: SubAgent; onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>(sub ? { name: sub.name, role: sub.role, brief: sub.brief, instructions: sub.instructions, palette: sub.palette, prop: sub.prop, uses: sub.uses ?? { mcp: [], skills: [] } } : BLANK);
  const [error, setError] = useState("");
  const [want, setWant] = useState("");
  /** What the program setting it up is doing right now. Unset when none is running. */
  const [setting, setSetting] = useState<string>();
  const [missing, setMissing] = useState<string[]>([]);
  const stop = useRef<() => void>(undefined);
  useEffect(() => () => stop.current?.(), []);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const taken = () => AGENTS.filter((a) => a.id !== sub?.id).map((a) => a.name);

  const setUp = () => {
    if (!want.trim() || setting) return;
    setError("");
    setSetting("Starting");
    const run = runSetup(want, setSetting);
    stop.current = run.stop;
    run.done
      .then((made) => {
        // A name the program gave that cannot be used is left for the person to give.
        const name = made.name && !nameProblem(made.name, taken()) ? made.name : draft.name;
        set({ name, role: made.role, brief: made.brief, instructions: made.instructions, prop: made.prop ?? draft.prop, palette: made.palette ?? draft.palette, uses: { mcp: made.mcp, skills: made.skills } });
        setMissing(made.missing);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => { stop.current = undefined; setSetting(undefined); });
  };

  const save = () => {
    const name = draft.name.trim();
    const problem = nameProblem(name, taken()) ?? (draft.brief.trim() ? null : "Say what it is for: the Router and the other cubes go by that.");
    if (problem) return setError(problem);
    const ids = useCube.getState().subagents.map((s) => s.id);
    const uses = draft.uses.mcp.length || draft.uses.skills.length ? draft.uses : undefined;
    void addSubagent({ ...(sub ?? {}), id: sub?.id ?? newId(name, [...ids, ...AGENTS.map((a) => a.id)]), name, role: draft.role.trim(), brief: draft.brief.trim(), instructions: draft.instructions.trim(), palette: draft.palette, prop: draft.prop, uses });
    onDone();
  };
  const drop = (kind: "mcp" | "skills", name: string) => set({ uses: { ...draft.uses, [kind]: draft.uses[kind].filter((n) => n !== name) } });
  const field = "selectable w-full rounded-xl border bg-transparent px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const label = "text-xs font-semibold text-muted-foreground";
  const picked = [...draft.uses.mcp.map((n) => ["mcp", n] as const), ...draft.uses.skills.map((n) => ["skills", n] as const)];
  return (
    <form className="flex flex-col gap-2.5 rounded-xl border p-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="flex flex-col gap-2 rounded-xl bg-muted p-2.5">
        <textarea aria-label="What should it do?" placeholder="What should it do? Say it in your own words, and an agent program you have connected writes the rest: its name, how it works, what its cube holds, and which of your tools and skills it should use." rows={2} value={want} onChange={(e) => setWant(e.target.value)} disabled={Boolean(setting)} className={cn(field, "border-transparent bg-background")} />
        <div className="flex flex-wrap items-center gap-2">
          {setting ? (
            <>
              <button type="button" className={pill} onClick={() => stop.current?.()}>Stop</button>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground" role="status">{setting}…</span>
            </>
          ) : (
            <>
              <button type="button" className={primary} disabled={!want.trim()} onClick={setUp}>{draft.brief ? "Set up again" : "Set up with AI"}</button>
              <span className="text-xs text-muted-foreground">You can change anything it writes before you save.</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Name" placeholder="Name (what you type after @)" value={draft.name} onChange={(e) => set({ name: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} className="selectable h-9 w-[220px]" />
        <Input aria-label="Role" placeholder="Role, in a few words (Contract reviewer)" value={draft.role} onChange={(e) => set({ role: e.target.value })} className="selectable h-9 min-w-[220px] flex-1" />
      </div>
      <textarea aria-label="What it is for" placeholder="What it is for, in a sentence or two. The Router picks who gets a request by this." rows={2} value={draft.brief} onChange={(e) => set({ brief: e.target.value })} className={field} />
      <textarea aria-label="How it should work" placeholder="How it should work: what to check first, the form of its answers, what to avoid. Optional." rows={draft.instructions ? 9 : 5} value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} className={cn(field, "font-mono text-[13px]")} />
      <div className="flex flex-col gap-1.5">
        <span className={label}>What its cube holds</span>
        <PropPicker value={draft.prop} onChange={(prop) => set({ prop })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={label}>Colors</span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Colors">
          {PALETTES.map((p) => {
            const on = p.colors.join() === draft.palette.join();
            return (
              <button key={p.name} type="button" aria-pressed={on} title={p.name} className={cn("flex h-8 items-center gap-1 rounded-full border px-2", on ? "border-primary bg-primary/10" : "border-transparent bg-secondary")} onClick={() => set({ palette: p.colors })}>
                {p.colors.map((c) => <span key={c} className="size-3.5 rounded-[4px]" style={{ background: c }} />)}
              </button>
            );
          })}
        </div>
      </div>
      {picked.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={label}>Tools and skills it reaches for</span>
          <div className="flex flex-wrap gap-1.5">
            {picked.map(([kind, name]) => (
              <span key={`${kind}:${name}`} className="flex h-7 items-center gap-1 rounded-full bg-secondary pl-2.5 pr-1 text-[13px]">
                <span className="text-xs text-muted-foreground">{kind === "mcp" ? "MCP" : "Skill"}</span>
                <span className="font-medium" data-notranslate>{name}</span>
                <button type="button" aria-label={`Remove ${name}`} className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => drop(kind, name)}>
                  <span aria-hidden="true" data-notranslate>×</span>
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      {missing.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={label}>Would also help, but is not connected yet</span>
          <ul className="list-disc pl-5 text-[13px] text-muted-foreground" data-notranslate>
            {missing.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
      {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={Boolean(setting)}>{sub ? "Save" : "Add to the team"}</button>
        <button type="button" className={pill} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Sub-agents of the person's own making: each is a cube on the team with a name to call it by,
 * a purpose, and their own instructions. It runs on whichever agent program is picked for it
 * above, like the built-in roles, and can be offered to teammates.
 */
export function Subagents() {
  const subs = useCube((s) => s.subagents);
  const joined = useCube((s) => Boolean(s.team.info));
  const connected = useCube((s) => s.teamLive.connected);
  const remove = useCube((s) => s.removeSubagent);
  const openProfile = useCube((s) => s.openProfile);
  const [editing, setEditing] = useState<string | "new">();
  const [error, setError] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-muted-foreground">Make a cube of your own: say what it should do, and it is set up for you. Call it with @ like any other cube; the Router hands it what fits its purpose.</p>
      {subs.map((sub) => {
        const def = AGENTS.find((a) => a.id === sub.id);
        return editing === sub.id ? <Editor key={sub.id} sub={sub} onDone={() => setEditing(undefined)} /> : (
          <div key={sub.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
            {def && <CubeStill color={def.color} size={40} />}
            <div className="min-w-[160px] flex-1">
              <div className="font-semibold" data-notranslate>{sub.name}{sub.from && <span className="font-normal text-muted-foreground"> · from {sub.from.name}</span>}</div>
              <div className="truncate text-[13px] text-muted-foreground" data-notranslate>{sub.role || sub.brief}</div>
            </div>
            {joined && !sub.from && (
              <button type="button" aria-pressed={Boolean(sub.shared)} disabled={!connected} className={cn(pill, sub.shared && "bg-primary/15 text-primary")} title="Teammates can bring in a copy of this sub-agent" onClick={() => { setError(""); void setSubagentShared(sub.id, !sub.shared).catch((e) => setError(String(e))); }}>
                {sub.shared ? "Shared with team" : "Share with team"}
              </button>
            )}
            <button type="button" className={pill} onClick={() => openProfile(sub.id)}>Model</button>
            <button type="button" className={pill} onClick={() => setEditing(sub.id)}>Edit</button>
            <button type="button" className={pill} onClick={() => { if (sub.shared) void setSubagentShared(sub.id, false).catch(() => undefined); remove(sub.id); void dropSubagentMd(sub.name); }}>Delete</button>
          </div>
        );
      })}
      {editing === "new" ? <Editor onDone={() => setEditing(undefined)} /> : <div><button type="button" className={primary} onClick={() => setEditing("new")}>New sub-agent</button></div>}
      {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
    </div>
  );
}
