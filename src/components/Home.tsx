import { useMemo, useRef, useState } from "react";
import { send } from "@/agents/orchestrator";
import { AGENTS, ORCH, ROUTER, agentById, isLeadRole, type AgentDef, type Status } from "@/agents/types";
import { timeOf } from "@/components/bits";
import { ClockIcon, SendIcon, StageIcon } from "@/components/icons";
import { Cube, CubeStill } from "@/cube/Cube";
import { inboxEntries } from "@/lib/inbox";
import { missedSince } from "@/lib/stats";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

const WORD: Record<string, string> = { thinking: "thinking", working: "working", needs: "needs you", stuck: "stuck", done: "done" };

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Where each teammate stands around the team cube: left to right, in an arch. Offsets are from the center, in px. */
const SPOTS: [number, number][] = [[-318, 34], [-222, -22], [-126, 30], [126, 30], [222, -22], [318, 34]];

/** One cube of the group on the home screen. It bobs gently, hops when pressed, then does what pressing it means. */
function Buddy({ agent, size, x, y, i, onPick }: { agent: AgentDef; size: number; x: number; y: number; i: number; onPick: () => void }) {
  const status = useCube((s) => (s.live[agent.id]?.status ?? "idle") as Status);
  const [hop, setHop] = useState(false);
  const press = () => {
    if (hop) return;
    setHop(true);
    // Let the hop be seen before the screen changes.
    window.setTimeout(() => { setHop(false); onPick(); }, 260);
  };
  return (
    <button
      type="button"
      aria-label={`${agent.name}: ${agent.role}`}
      title={`${agent.name}: ${agent.role}`}
      className={cn("buddy buddy-sub group absolute left-1/2 top-1/2 flex flex-col items-center gap-0.5 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring", status !== "idle" && "buddy-busy")}
      // The ones standing closer to the team cube pick up its steps sooner, so the group trails after it.
      style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`, ["--lag" as string]: (Math.abs(x) / 96) * 0.3 + i * 0.03 }}
      onClick={press}
    >
      <span className={cn("buddy-bob block", hop && "buddy-hop")} style={{ animationDelay: `${-i * 0.55}s`, animationDuration: hop ? undefined : `${3.2 + (i % 3) * 0.5}s` }}>
        <Cube color={agent.color} status={status} size={size} />
      </span>
      <span className="text-xs font-semibold text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground group-[.buddy-busy]:text-foreground">{agent.name}</span>
      <span className={cn("h-4 text-[11px] leading-4", status === "needs" ? "font-semibold text-primary" : status === "stuck" ? "font-semibold text-destructive" : "text-muted-foreground")}>{WORD[status] ?? ""}</span>
    </button>
  );
}

/** The team's own cube, in the middle and larger than the rest. It works whenever anyone on the team does. */
function LeadCube({ agent }: { agent: AgentDef }) {
  const status = useCube((s) => {
    const own = s.live[agent.id]?.status ?? "idle";
    if (own !== "idle" && own !== "done") return own;
    return Object.values(s.live).some((l) => l.status === "thinking" || l.status === "working") ? "working" : own;
  }) as Status;
  return <Cube color={agent.color} status={status} size={132} />;
}

/** The landing view: the team, one box to ask it for something, and what waits on the person. */
export function Home() {
  const name = useCube((s) => s.name);
  const convs = useCube((s) => s.convs);
  const messages = useCube((s) => s.messages);
  const files = useCube((s) => s.files);
  const notes = useCube((s) => s.notes);
  const decisions = useCube((s) => s.decisions);
  const cleared = useCube((s) => s.cleared);
  const scheduled = useCube((s) => s.schedules.filter((x) => x.on).length);
  const seenAt = useCube((s) => s.seenAt);
  const setSeen = useCube((s) => s.setSeen);
  const setActive = useCube((s) => s.setActive);
  const jumpTo = useCube((s) => s.jumpTo);
  const openProfile = useCube((s) => s.openProfile);
  const openInbox = useCube((s) => s.openInbox);
  const openLibrary = useCube((s) => s.openLibrary);
  const [draft, setDraft] = useState("");
  const [leadHop, setLeadHop] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  const todo = useMemo(() => inboxEntries({ messages, notes, decisions, cleared }), [messages, notes, decisions, cleared]);
  const missed = useMemo(() => missedSince(messages, files, convs, seenAt), [messages, files, convs, seenAt]);
  const lead = agentById(ORCH);
  // The Router stands with the team, at the left end; the rest keep their order.
  const team = [...AGENTS.filter((a) => a.id === ROUTER), ...AGENTS.filter((a) => !isLeadRole(a.id))].slice(0, SPOTS.length);

  const start = () => {
    if (!draft.trim()) return;
    send("general", draft);
    setDraft("");
    setActive("general");
  };

  const row = "flex min-h-10 w-full items-center gap-2 rounded-xl px-1.5 text-left hover:bg-accent";
  const label = "flex items-center justify-between px-1.5 pb-1 text-xs font-semibold text-muted-foreground";
  const quiet = "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground";
  const card = "flex flex-col rounded-[18px] border bg-background px-2.5 py-1.5";

  return (
    <main className="min-h-0 overflow-auto rounded-[22px] border bg-ground">
      <div className="mx-auto flex min-h-full max-w-[860px] flex-col items-center gap-5 px-6 pb-8 pt-10" data-tauri-drag-region>
        <div className="relative h-[236px] w-full max-w-[760px]" role="group" aria-label="Your team">
          {lead && (
            <button
              type="button"
              aria-label={`${lead.name}: ${lead.role}`}
              title={`${lead.name}: ${lead.role}`}
              className="buddy absolute left-1/2 top-1/2 rounded-3xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ transform: "translate(-50%, -58%)" }}
              onClick={() => {
                // The team cube stands for everyone: pressing it puts the cursor in the box that talks to the whole team.
                setLeadHop(true);
                window.setTimeout(() => setLeadHop(false), 260);
                box.current?.focus();
              }}
            >
              <span className={cn("buddy-bob buddy-lead block", leadHop && "buddy-hop")}><LeadCube agent={lead} /></span>
            </button>
          )}
          {team.map((a, i) => (
            <Buddy key={a.id} agent={a} size={a.id === ROUTER ? 56 : 66} x={SPOTS[i][0]} y={SPOTS[i][1]} i={i} onPick={() => (isLeadRole(a.id) ? openProfile(a.id) : setActive(`dm-${a.id}`))} />
          ))}
        </div>

        <h1 className="text-center font-heading text-[24px] font-bold leading-tight tracking-[-0.03em]">{greeting()}, {name.trim() || "there"}</h1>

        <form className="flex w-full max-w-[640px] items-center gap-2 rounded-[24px] border bg-background p-2 pl-5 shadow-sm focus-within:ring-2 focus-within:ring-ring" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <input
            ref={box}
            id="home-ask"
            aria-label="What should the team work on?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What should the team work on?"
            className="selectable h-10 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          <button type="submit" aria-label="Send to #general" disabled={!draft.trim()} className="flex size-10 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-35">
            <SendIcon width={18} height={18} strokeWidth={2.25} />
          </button>
        </form>
        <p className="-mt-3 text-xs text-muted-foreground">It goes to #general. Tap a cube to talk to it alone.</p>

        {/* Under the box, only what waits on the person. Channels are in the sidebar; schedules and files are in the Library, one click from here. */}
        <div className="flex w-full max-w-[640px] flex-col gap-4">
          {todo.length > 0 && (
            <section aria-label="Inbox">
              <div className={label}>
                <span>Inbox</span>
                <button type="button" className={quiet} onClick={openInbox}>Open the inbox</button>
              </div>
              <ul className={card}>
                {todo.slice(0, 5).map((e) => {
                  const a = agentById(e.agentId);
                  return (
                    <li key={e.id}>
                      <button type="button" className={row} onClick={() => (e.msgId ? jumpTo(e.msgId) : openInbox())}>
                        {a && <CubeStill color={a.color} size={24} />}
                        <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                        <span className="flex-none text-xs text-muted-foreground">{timeOf(e.ts)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {missed.length > 0 && (
            <section aria-label="While you were away">
              <div className={label}>
                <span>While you were away</span>
                <button type="button" className={quiet} onClick={() => setSeen(Date.now())}>Got it</button>
              </div>
              <ul className={card}>
                {missed.map((m) => (
                  <li key={m.conv.id}>
                    <button type="button" className={row} onClick={() => setActive(m.conv.id)}>
                      <span className="flex -space-x-1.5">{m.by.slice(0, 4).map((id) => { const a = agentById(id); return a ? <CubeStill key={id} color={a.color} size={22} /> : null; })}</span>
                      <span className="font-medium">{m.conv.kind === "dm" ? m.conv.name : `#${m.conv.name}`}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                        {[m.replies ? `${m.replies} ${m.replies === 1 ? "reply" : "replies"}` : "", m.files.length ? `${m.files.length} ${m.files.length === 1 ? "file" : "files"} changed` : ""].filter(Boolean).join(" · ")}
                      </span>
                      {m.failed > 0 && <span className="text-xs font-semibold text-destructive">{m.failed} failed</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {todo.length === 0 && missed.length === 0 && (
            <p className="text-center text-[13px] text-muted-foreground">Nothing to do right now. When a cube needs your OK, asks something or gets stuck, it shows up here.</p>
          )}
          <div className="flex justify-center gap-1">
            <button type="button" className={quiet} onClick={() => openLibrary("schedules")}>
              <ClockIcon width={15} height={15} /> Schedules{scheduled > 0 && <span className="tabular-nums" data-notranslate>{scheduled}</span>}
            </button>
            <button type="button" className={quiet} onClick={() => openLibrary("files")}>
              <StageIcon width={15} height={15} /> Files
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
