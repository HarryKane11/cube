import { useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { send } from "@/agents/orchestrator";
import { AGENTS, ORCH, ROUTER, agentById, isLeadRole, type AgentDef, type Status } from "@/agents/types";
import { timeOf } from "@/components/bits";
import { ClockIcon, HashIcon, InboxIcon, RewindIcon, SendIcon, StageIcon } from "@/components/icons";
import { Schedules } from "@/components/Schedules";
import { Glyph } from "@/components/Glyph";
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

type Tab = "todo" | "missed" | "schedules" | "files" | "channels";

/** The landing view: the team, one box to ask it for something, and what waits on the person. */
export function Home() {
  const name = useCube((s) => s.name);
  const convs = useCube((s) => s.convs);
  const messages = useCube((s) => s.messages);
  const files = useCube((s) => s.files);
  const unread = useCube((s) => s.unread);
  const notes = useCube((s) => s.notes);
  const decisions = useCube((s) => s.decisions);
  const cleared = useCube((s) => s.cleared);
  const schedules = useCube((s) => s.schedules);
  const seenAt = useCube((s) => s.seenAt);
  const setSeen = useCube((s) => s.setSeen);
  const setActive = useCube((s) => s.setActive);
  const select = useCube((s) => s.select);
  const jumpTo = useCube((s) => s.jumpTo);
  const openProfile = useCube((s) => s.openProfile);
  const openInbox = useCube((s) => s.openInbox);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Tab>();
  const [leadHop, setLeadHop] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  const todo = useMemo(() => inboxEntries({ messages, notes, decisions, cleared }), [messages, notes, decisions, cleared]);
  const missed = useMemo(() => missedSince(messages, files, convs, seenAt), [messages, files, convs, seenAt]);
  const recent = useMemo(
    () => convs.flatMap((c) => (files[c.id] ?? []).map((f) => ({ conv: c, file: f }))).sort((a, b) => b.file.mtime - a.file.mtime).slice(0, 8),
    [convs, files],
  );
  const channels = convs.filter((c) => c.kind === "channel");
  const lead = agentById(ORCH);
  // The Router stands with the team, at the left end; the rest keep their order.
  const team = [...AGENTS.filter((a) => a.id === ROUTER), ...AGENTS.filter((a) => !isLeadRole(a.id))].slice(0, SPOTS.length);

  const start = () => {
    if (!draft.trim()) return;
    send("general", draft);
    setDraft("");
    setActive("general");
  };

  const tabs: { id: Tab; name: string; icon: ComponentType<SVGProps<SVGSVGElement>>; count: number }[] = [
    { id: "todo", name: "To do", icon: InboxIcon, count: todo.length },
    { id: "missed", name: "While you were away", icon: RewindIcon, count: missed.length },
    { id: "schedules", name: "Schedules", icon: ClockIcon, count: schedules.filter((s) => s.on).length },
    { id: "files", name: "Files", icon: StageIcon, count: 0 },
    { id: "channels", name: "Channels", icon: HashIcon, count: channels.reduce((n, c) => n + (unread[c.id] ?? 0), 0) },
  ];
  // Until the person picks, show whatever has something in it, most pressing first.
  const tab: Tab = picked ?? (todo.length ? "todo" : missed.length ? "missed" : "files");
  const row = "flex min-h-10 w-full items-center gap-2 rounded-xl px-1.5 text-left hover:bg-accent";
  const empty = "py-3 text-center text-muted-foreground";

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

        <h1 className="text-center font-heading text-[28px] font-bold leading-tight tracking-[-0.03em]">{greeting()}, {name.trim() || "there"}</h1>

        <form className="flex w-full max-w-[640px] items-center gap-2 rounded-[24px] border bg-background p-2 pl-5 shadow-sm focus-within:ring-2 focus-within:ring-ring" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <input
            ref={box}
            id="home-ask"
            aria-label="What should the team work on?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What should the team work on?"
            className="selectable h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <button type="submit" aria-label="Send to #general" disabled={!draft.trim()} className="flex size-10 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-35">
            <SendIcon width={18} height={18} strokeWidth={2.25} />
          </button>
        </form>
        <p className="-mt-3 text-xs text-muted-foreground">It goes to #general. Tap a cube to talk to it alone.</p>

        <div className="flex flex-wrap justify-center gap-1.5" role="tablist" aria-label="What to look at">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={cn("flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold", tab === t.id ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground")}
              onClick={() => setPicked(t.id)}
            >
              <t.icon width={15} height={15} />
              {t.name}
              {t.count > 0 && <span className={cn("rounded-full px-1.5 text-[11px] leading-[18px] tabular-nums", tab === t.id ? "bg-background/20" : "bg-primary text-primary-foreground")}>{t.count}</span>}
            </button>
          ))}
        </div>

        <section className="w-full max-w-[640px] rounded-[22px] border bg-background px-4 py-3" role="tabpanel">
          {tab === "todo" && (
            todo.length === 0 ? <p className={empty}>Nothing to do right now. When a cube needs your OK, asks something or gets stuck, it shows up here.</p> : (
              <ul className="flex flex-col">
                {todo.slice(0, 5).map((e) => {
                  const a = agentById(e.agentId);
                  return (
                    <li key={e.id}>
                      <button type="button" className={row} onClick={() => (e.msgId ? jumpTo(e.msgId) : openInbox())}>
                        {a && <CubeStill color={a.color} size={28} />}
                        <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                        <span className="flex-none text-xs text-muted-foreground">{timeOf(e.ts)}</span>
                      </button>
                    </li>
                  );
                })}
                <li><button type="button" className="mt-1 h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={openInbox}>Open the inbox</button></li>
              </ul>
            )
          )}
          {tab === "missed" && (
            missed.length === 0 ? <p className={empty}>Nothing new since you were last here.</p> : (
              <ul className="flex flex-col">
                {missed.map((m) => (
                  <li key={m.conv.id}>
                    <button type="button" className={row} onClick={() => setActive(m.conv.id)}>
                      <span className="flex -space-x-2">{m.by.slice(0, 4).map((id) => { const a = agentById(id); return a ? <CubeStill key={id} color={a.color} size={26} /> : null; })}</span>
                      <span className="font-medium">{m.conv.kind === "dm" ? m.conv.name : `#${m.conv.name}`}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                        {[m.replies ? `${m.replies} ${m.replies === 1 ? "reply" : "replies"}` : "", m.files.length ? `${m.files.length} ${m.files.length === 1 ? "file" : "files"} changed` : ""].filter(Boolean).join(" · ")}
                      </span>
                      {m.failed > 0 && <span className="text-xs font-semibold text-destructive">{m.failed} failed</span>}
                    </button>
                  </li>
                ))}
                <li><button type="button" className="mt-1 h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setSeen(Date.now())}>Got it</button></li>
              </ul>
            )
          )}
          {tab === "schedules" && <Schedules />}
          {tab === "files" && (
            recent.length === 0 ? <p className={empty}>Files your team makes will be listed here, newest first.</p> : (
              <ul className="flex flex-col">
                {recent.map(({ conv, file }) => {
                  const by = file.by ? agentById(file.by) : undefined;
                  return (
                    <li key={`${conv.id}/${file.rel}`}>
                      <button type="button" className={row} onClick={() => { select(conv.id, file.rel, true); setActive(conv.id); }}>
                        <Glyph kind={file.kind} name={file.rel} />
                        <span className="min-w-0 flex-1 truncate font-medium">{file.rel}</span>
                        <span className="flex-none truncate text-xs text-muted-foreground">{conv.kind === "dm" ? conv.name : `#${conv.name}`}{by && ` · ${by.name}`}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          )}
          {tab === "channels" && (
            <ul className="flex flex-col">
              {channels.map((c) => (
                <li key={c.id}>
                  <button type="button" className={row} onClick={() => setActive(c.id)}>
                    <HashIcon className="text-muted-foreground" width={16} height={16} />
                    <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                    <span className="flex -space-x-2">{c.members.slice(0, 7).map((id) => { const a = agentById(id); return a ? <CubeStill key={id} color={a.color} size={22} /> : null; })}</span>
                    {(unread[c.id] ?? 0) > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-bold leading-[18px] text-primary-foreground tabular-nums">{unread[c.id]}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
