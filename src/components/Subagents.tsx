import { useState } from "react";
import { addSubagent } from "@/agents/orchestrator";
import { nameProblem, newId, type SubAgent } from "@/agents/subagents";
import { AGENTS, PALETTES, type Palette } from "@/agents/types";
import { Input } from "@/components/ui/input";
import { CubeStill } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";
import { setSubagentShared } from "@/team";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";
const BLANK = { name: "", role: "", brief: "", instructions: "", palette: PALETTES[0].colors as Palette };

/** The form a sub-agent is made or changed with. */
function Editor({ sub, onDone }: { sub?: SubAgent; onDone: () => void }) {
  const [draft, setDraft] = useState(sub ? { name: sub.name, role: sub.role, brief: sub.brief, instructions: sub.instructions, palette: sub.palette } : BLANK);
  const [error, setError] = useState("");
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = () => {
    const name = draft.name.trim();
    const taken = AGENTS.filter((a) => a.id !== sub?.id).map((a) => a.name);
    const problem = nameProblem(name, taken) ?? (draft.brief.trim() ? null : "Say what it is for: the Router and the other cubes go by that.");
    if (problem) return setError(problem);
    const ids = useCube.getState().subagents.map((s) => s.id);
    void addSubagent({ ...(sub ?? {}), id: sub?.id ?? newId(name, [...ids, ...AGENTS.map((a) => a.id)]), name, role: draft.role.trim(), brief: draft.brief.trim(), instructions: draft.instructions.trim(), palette: draft.palette });
    onDone();
  };
  const field = "selectable w-full rounded-xl border bg-transparent px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <form className="flex flex-col gap-2.5 rounded-xl border p-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Name" placeholder="Name (what you type after @)" value={draft.name} onChange={(e) => set({ name: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} className="selectable h-9 w-[220px]" />
        <Input aria-label="Role" placeholder="Role, in a few words (Contract reviewer)" value={draft.role} onChange={(e) => set({ role: e.target.value })} className="selectable h-9 min-w-[220px] flex-1" />
      </div>
      <textarea aria-label="What it is for" placeholder="What it is for, in a sentence or two. The Router picks who gets a request by this." rows={2} value={draft.brief} onChange={(e) => set({ brief: e.target.value })} className={field} />
      <textarea aria-label="How it should work" placeholder="How it should work: what to check first, the form of its answers, what to avoid. Optional." rows={5} value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} className={cn(field, "font-mono text-[13px]")} />
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
      {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primary}>{sub ? "Save" : "Add to the team"}</button>
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
      <p className="text-[13px] text-muted-foreground">Make a cube of your own: give it a name, say what it is for and how it should work. Call it with @ like any other cube; the Router hands it what fits its purpose.</p>
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
            <button type="button" className={pill} onClick={() => { if (sub.shared) void setSubagentShared(sub.id, false).catch(() => undefined); remove(sub.id); }}>Delete</button>
          </div>
        );
      })}
      {editing === "new" ? <Editor onDone={() => setEditing(undefined)} /> : <div><button type="button" className={primary} onClick={() => setEditing("new")}>New sub-agent</button></div>}
      {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
    </div>
  );
}
