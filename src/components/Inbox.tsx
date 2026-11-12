import { useMemo, useState } from "react";
import { answerAsk, approvePlan } from "@/agents/orchestrator";
import { agentById } from "@/agents/types";
import { timeOf } from "@/components/bits";
import { CubeStill } from "@/cube/Cube";
import { inboxEntries, type Entry } from "@/lib/inbox";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

/** How many things wait on the person right now. */
export function useInboxCount(): number {
  const messages = useCube((s) => s.messages);
  const notes = useCube((s) => s.notes);
  const decisions = useCube((s) => s.decisions);
  const cleared = useCube((s) => s.cleared);
  return useMemo(() => inboxEntries({ messages, notes, decisions, cleared }).length, [messages, notes, decisions, cleared]);
}

const pill = "h-7 rounded-full px-3 text-[13px] font-semibold";

function Row({ e }: { e: Entry }) {
  const convs = useCube((s) => s.convs);
  const jumpTo = useCube((s) => s.jumpTo);
  const setActive = useCube((s) => s.setActive);
  const openProfile = useCube((s) => s.openProfile);
  const keepNote = useCube((s) => s.keepNote);
  const forgetNote = useCube((s) => s.forgetNote);
  const setDecision = useCube((s) => s.setDecision);
  const clearEntry = useCube((s) => s.clearEntry);
  const setQuote = useCube((s) => s.setQuote);
  const agent = agentById(e.agentId);
  const conv = convs.find((c) => c.id === e.convId);
  const open = () => (e.msgId ? jumpTo(e.msgId) : conv ? setActive(conv.id) : agent && openProfile(agent.id));
  const change = () => {
    if (!conv || !agent) return;
    open();
    setQuote({ convId: conv.id, text: `${conv.kind === "channel" ? `@${agent.name} ` : ""}About your choice "${e.detail}": ` });
    if (e.ref) setDecision(e.ref, "ok");
  };
  return (
    <li className="flex items-start gap-3 border-b py-3 last:border-b-0">
      {agent && <CubeStill color={agent.color} size={38} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <button type="button" className="text-left" onClick={open}>
          <span className="block font-semibold">{e.title}</span>
          <span className="block text-xs text-muted-foreground">{conv ? (conv.kind === "dm" ? `Direct message with ${conv.name}` : `#${conv.name}`) : "Added by hand"} · {timeOf(e.ts)}</span>
        </button>
        {e.detail && <p className={cn("selectable line-clamp-4 whitespace-pre-wrap rounded-xl bg-muted px-3 py-1.5 text-[13px] [overflow-wrap:anywhere]", e.kind === "ask" && "font-mono", e.kind === "stuck" && "bg-destructive/10 text-destructive")}>{e.detail}</p>}
        <div className="flex flex-wrap gap-1.5">
          {e.kind === "ask" && e.msgId && e.ref && (
            <>
              <button type="button" className={cn(pill, "bg-primary text-primary-foreground")} onClick={() => answerAsk(e.msgId!, e.ref!, "once")}>Allow</button>
              <button type="button" className={cn(pill, "bg-secondary")} onClick={() => answerAsk(e.msgId!, e.ref!, "deny")}>Don't allow</button>
            </>
          )}
          {e.kind === "plan" && e.msgId && (
            <button type="button" className={cn(pill, "bg-primary text-primary-foreground")} onClick={() => (e.ref ? answerAsk(e.msgId!, e.ref, "once") : approvePlan(e.msgId!))}>Approve and start</button>
          )}
          {e.kind === "note" && e.ref && (
            <>
              <button type="button" className={cn(pill, "bg-primary text-primary-foreground")} onClick={() => keepNote(e.ref!)}>Keep</button>
              <button type="button" className={cn(pill, "bg-secondary")} onClick={() => forgetNote(e.ref!)}>Forget</button>
            </>
          )}
          {e.kind === "decision" && e.ref && (
            <>
              <button type="button" className={cn(pill, "bg-primary text-primary-foreground")} onClick={() => setDecision(e.ref!, "ok")}>That's fine</button>
              <button type="button" className={cn(pill, "bg-secondary")} onClick={change}>Change it</button>
            </>
          )}
          {(e.kind === "question" || e.kind === "reply" || e.kind === "stuck" || e.kind === "plan") && (
            <button type="button" className={cn(pill, e.kind === "plan" ? "bg-secondary" : "bg-primary text-primary-foreground")} onClick={open}>{e.kind === "plan" ? "Read it" : e.kind === "stuck" ? "Open" : "Answer"}</button>
          )}
          {(e.kind === "reply" || e.kind === "stuck") && <button type="button" className={cn(pill, "bg-secondary")} onClick={() => clearEntry(e.id)}>Clear</button>}
        </div>
      </div>
    </li>
  );
}

/** One place for everything that waits on the person, and the record of what cubes chose by themselves. */
export function Inbox() {
  const messages = useCube((s) => s.messages);
  const notes = useCube((s) => s.notes);
  const decisions = useCube((s) => s.decisions);
  const cleared = useCube((s) => s.cleared);
  const jumpTo = useCube((s) => s.jumpTo);
  const setDecision = useCube((s) => s.setDecision);
  const [tab, setTab] = useState<"waiting" | "calls">("waiting");
  const entries = useMemo(() => inboxEntries({ messages, notes, decisions, cleared }), [messages, notes, decisions, cleared]);
  const calls = useMemo(() => [...decisions].reverse(), [decisions]);
  const seg = (on: boolean) => cn("h-7 rounded-lg px-3 text-[13px] font-medium text-muted-foreground", on && "bg-background font-semibold text-foreground shadow-sm");
  return (
    <main className="min-h-0 overflow-auto rounded-[22px] border bg-ground">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-6" data-tauri-drag-region>
        <header className="flex items-end gap-3 pt-2">
          <h1 className="flex-1 font-heading text-[30px] font-bold leading-tight tracking-[-0.03em]">Inbox</h1>
          <div className="flex rounded-[10px] bg-secondary p-0.5" role="group" aria-label="What to show">
            <button type="button" aria-pressed={tab === "waiting"} className={seg(tab === "waiting")} onClick={() => setTab("waiting")}>Waiting on you{entries.length ? ` ${entries.length}` : ""}</button>
            <button type="button" aria-pressed={tab === "calls"} className={seg(tab === "calls")} onClick={() => setTab("calls")}>Calls cubes made</button>
          </div>
        </header>
        <section className="rounded-[22px] border bg-background px-5 py-2">
          {tab === "waiting" ? (
            entries.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">Nothing waits on you. Requests for your OK, questions, plans, failed runs and things to look over all land here.</p>
            ) : (
              <ul>{entries.map((e) => <Row e={e} key={e.id} />)}</ul>
            )
          ) : calls.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">When a cube chooses something you did not specify, it says so and the choice is listed here.</p>
          ) : (
            <ul>
              {calls.map((d) => {
                const agent = agentById(d.agentId);
                return (
                  <li key={d.id} className="flex items-start gap-3 border-b py-2.5 last:border-b-0">
                    {agent && <CubeStill color={agent.color} size={30} />}
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => jumpTo(d.msgId)}>
                      <span className="selectable block [overflow-wrap:anywhere]">{d.text}</span>
                      <span className="text-xs text-muted-foreground">{agent?.name ?? d.agentId} · {new Date(d.ts).toLocaleDateString([], { month: "short", day: "numeric" })} {timeOf(d.ts)}</span>
                    </button>
                    {d.state === "new" ? (
                      <button type="button" className={cn(pill, "flex-none bg-secondary")} onClick={() => setDecision(d.id, "ok")}>That's fine</button>
                    ) : (
                      <span className="flex-none text-xs text-muted-foreground">Looked over</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
