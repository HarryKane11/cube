import { useEffect, useMemo, useRef, useState } from "react";
import { createChat, takerOf } from "@/agents/orchestrator";
import { AGENTS, ROUTER, agentById, nameIn } from "@/agents/types";
import { timeOf } from "@/components/bits";
import { ClockIcon, CloseIcon, OpenIcon, SendIcon, StageIcon } from "@/components/icons";
import { ImportSession } from "@/components/ImportSession";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { Cube, CubeStill } from "@/cube/Cube";
import { CubeMark, SolvingMark } from "@/cube/CubeMark";
import { cn } from "@/lib/utils";
import { inboxEntries } from "@/lib/inbox";
import { missedSince } from "@/lib/stats";
import { useCube, labelOf } from "@/state/store";

/** How long the mark is seen being solved at the least, how long the Router is given to bring a cube in after it spoke, how long the solved cube is looked at, and when to stop waiting and open the chat anyway. In milliseconds. */
const SOLVING_AT_LEAST = 1100;
const ROUTER_PAUSE = 700;
const SOLVED_FOR = 950;
const GIVE_UP_AFTER = 25_000;

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
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
  const openInbox = useCube((s) => s.openInbox);
  const openLibrary = useCube((s) => s.openLibrary);
  const offered = useCube((s) => s.suggestions).filter((x) => x.state === "new").slice(-3).reverse();
  const setSuggestion = useCube((s) => s.setSuggestion);
  const [draft, setDraft] = useState("");
  const [importing, setImporting] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  // Only what waits on the person. A choice a cube already made waits on nobody: it is looked over in the inbox.
  const todo = useMemo(() => inboxEntries({ messages, notes, decisions, cleared }).filter((e) => e.kind !== "decision"), [messages, notes, decisions, cleared]);
  const missed = useMemo(() => missedSince(messages, files, convs, seenAt), [messages, files, convs, seenAt]);

  /** A request made here that no cube has taken yet: the chat it started (once it is made) and when it was asked. */
  const [asking, setAsking] = useState<{ convId?: string; at: number; /** What was asked, to show it back. */ text: string }>();
  const calm = useCube((s) => s.settings.calm);
  const lang = useCube((s) => s.settings.lang);
  const taker = useCube((s) => (asking?.convId ? takerOf(s.messages, asking.convId) : undefined));
  // The Router speaks first and brings a cube in a moment later: its own line is not the answer
  // to who took it until that moment has passed.
  const [settled, setSettled] = useState<string>();
  useEffect(() => {
    if (!asking?.convId || !taker) return setSettled(undefined);
    // The cube is seen being solved for a moment even when the answer is there at once.
    const wait = Math.max(taker === ROUTER ? ROUTER_PAUSE : 0, SOLVING_AT_LEAST - (Date.now() - asking.at));
    const timer = window.setTimeout(() => setSettled(taker), wait);
    return () => window.clearTimeout(timer);
  }, [asking, taker]);
  // Solved in the colors of the cube that took it, the mark is looked at for a moment, then the chat opens.
  useEffect(() => {
    if (!asking?.convId) return;
    const convId = asking.convId;
    const timer = window.setTimeout(() => { setAsking(undefined); setActive(convId); }, settled ? SOLVED_FOR : GIVE_UP_AFTER);
    return () => window.clearTimeout(timer);
  }, [asking, settled, setActive]);
  const tookIt = settled ? agentById(settled) : undefined;
  const palette = useCube((s) => (tookIt ? (s.palettes[tookIt.id] ?? tookIt.palette) : undefined));

  // The folder the chat will work in, when the person chose one of their own that is still open.
  const workspace = useCube((s) => (s.workspaces.some((w) => w.dir === s.settings.workspace && !w.missing) ? s.settings.workspace : undefined));
  // Cube is drawn here as everywhere else: the flat mark, or the cube that turns, as the person set it.
  const turning = useCube((s) => s.settings.cubeLook?.shape === "cube");
  const cubeColor = AGENTS.find((a) => a.id === ROUTER)?.color ?? "#888888";
  const start = () => {
    if (!draft.trim() || asking) return;
    // What is asked from Home starts a chat of its own, so #general is not where everything lands.
    if (calm || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      void createChat(draft, { workspace });
    } else {
      // The person stays here and watches the cube being solved until one of the team takes the request.
      setAsking({ at: Date.now(), text: draft.trim() });
      void createChat(draft, { stay: true, workspace }).then((convId) => setAsking((a) => (a && convId ? { ...a, convId } : undefined)));
    }
    setDraft("");
  };

  const row = "flex min-h-10 w-full items-center gap-2 rounded-xl px-1.5 text-left hover:bg-accent";
  const label = "flex items-center justify-between px-1.5 pb-1 text-xs font-semibold text-muted-foreground";
  const quiet = "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground";
  // A plain list under its heading, with no box around it: the rows line up with the heading above them.
  const list = "flex flex-col";

  return (
    <main className="min-h-0 overflow-auto rounded-[22px] border bg-ground">
      <div className="mx-auto flex min-h-full max-w-[860px] flex-col items-center px-6 pb-8 pt-10" data-tauri-drag-region>
        {/* The box to ask in sits in the middle of the screen: what is above it and what is below it get the same room. */}
        <div className="flex w-full flex-1 basis-0 flex-col items-center justify-end gap-5 pb-5">
          {asking ? (
            // What was just asked stays in sight, as the person's own words, and the cube is seen
            // taking it in: it is clear the request went somewhere, and to whom.
            <div className="flex w-full max-w-[520px] flex-col gap-3" role="status">
              <div className="flex justify-end">
                <p className="home-said selectable line-clamp-4 max-w-[84%] whitespace-pre-wrap rounded-[18px] bg-muted px-3.5 py-2 text-[15px] [overflow-wrap:anywhere]" data-notranslate>{asking.text}</p>
              </div>
              <div className="flex items-center gap-3">
                {turning ? (
                  // Cube as a cube that turns: it works on the request, then gives way to the cube that took it.
                  <span className={cn("flex-none transition-transform duration-500 ease-out", tookIt && "scale-110")}>
                    <Cube color={tookIt && settled !== ROUTER ? tookIt.color : cubeColor} status={settled ? "idle" : "working"} size={88} />
                  </span>
                ) : (
                  <SolvingMark size={88} colors={settled === ROUTER ? undefined : palette} solved={settled === ROUTER} className={cn("flex-none transition-transform duration-500 ease-out", tookIt && "scale-110")} title="Cube" />
                )}
                <p className="home-hmm flex min-h-9 items-center gap-1.5 rounded-[18px] border bg-background px-3.5 py-1.5 text-[14px] text-muted-foreground">
                  {tookIt ? (
                    <>Taken by <span className="font-semibold text-foreground" data-notranslate>{nameIn(tookIt, lang)}</span></>
                  ) : (
                    <>
                      <span>Hmm…</span>
                      <span className="flex items-center gap-1" aria-hidden="true">
                        {[0, 1, 2].map((i) => <span key={i} className="home-dot size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 0.16}s` }} />)}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* The app's own mark, still: the cubes that move are in the conversations, where the work is. */}
              {turning ? <span className="mb-1"><Cube color={cubeColor} status="idle" size={104} /></span> : <CubeMark size={104} className="mb-1" title="Cube" />}
              <h1 className="text-center font-heading text-[24px] font-bold leading-tight tracking-[-0.03em]">{greeting()}, {name.trim() || "there"}</h1>
            </>
          )}
        </div>

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
          <button type="submit" aria-label="Start a chat" disabled={!draft.trim() || Boolean(asking)} className="flex size-10 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-35">
            <SendIcon width={18} height={18} strokeWidth={2.25} />
          </button>
        </form>
        <div className="flex w-full flex-1 basis-0 flex-col items-center gap-5 pt-2">
        <div className="flex w-full max-w-[640px] items-center justify-between gap-3 px-2">
          <WorkspacePicker />
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {asking ? "Finding the right cube…" : workspace ? "The cubes work in this folder directly." : "It starts a new chat with the team."}
          </p>
        </div>

        {/* Under the box, only what waits on the person. Channels are in the sidebar; schedules and files are in the Library, one click from here. */}
        {/* While the person writes, it steps out of the way: the box and what they are saying are all there is. It keeps its room, so nothing jumps. */}
        <div className={cn("flex w-full max-w-[640px] flex-col gap-4 transition-opacity duration-150", draft.trim() && "pointer-events-none opacity-0")} aria-hidden={draft.trim() ? true : undefined}>
          {todo.length > 0 && (
            <section aria-label="Inbox">
              <div className={label}>
                <span>Inbox</span>
                <button type="button" className={quiet} onClick={openInbox}>Open the inbox</button>
              </div>
              <ul className={list}>
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
              <ul className={list}>
                {missed.map((m) => (
                  <li key={m.conv.id}>
                    <button type="button" className={row} onClick={() => setActive(m.conv.id)}>
                      <span className="flex -space-x-1.5">{m.by.slice(0, 4).map((id) => { const a = agentById(id); return a ? <CubeStill key={id} color={a.color} size={22} /> : null; })}</span>
                      <span className="font-medium">{labelOf(m.conv)}</span>
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
          {/* What the wiki job found worth doing next. Starting one opens a chat with it; the rest can be let go. */}
          {offered.length > 0 && (
            <section aria-label="Suggested next">
              <div className={label}><span>Suggested next</span></div>
              <ul className={list}>
                {offered.map((x) => (
                  <li key={x.id} className="flex min-h-10 items-center gap-2 px-1.5 py-1">
                    <span className="selectable min-w-0 flex-1 [overflow-wrap:anywhere]" data-notranslate>{x.text}</span>
                    <button type="button" className="h-7 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => { setSuggestion(x.id, "taken"); void createChat(x.text); }}>Start</button>
                    <button type="button" aria-label="Dismiss" title="Dismiss" className="flex size-7 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setSuggestion(x.id, "dismissed")}>
                      <CloseIcon width={12} height={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {todo.length === 0 && missed.length === 0 && offered.length === 0 && (
            <p className="text-center text-[13px] text-muted-foreground">Nothing to do right now. When a cube needs your OK, asks something or gets stuck, it shows up here.</p>
          )}
          <ImportSession open={importing} onOpenChange={setImporting} />
          <div className="flex flex-wrap justify-center gap-1">
            <button type="button" className={quiet} onClick={() => openLibrary("schedules")}>
              <ClockIcon width={15} height={15} /> Schedules{scheduled > 0 && <span className="tabular-nums" data-notranslate>{scheduled}</span>}
            </button>
            <button type="button" className={quiet} onClick={() => openLibrary("files")}>
              <StageIcon width={15} height={15} /> Files
            </button>
            <button type="button" className={quiet} onClick={() => setImporting(true)}>
              <OpenIcon width={15} height={15} /> Bring in a session
            </button>
          </div>
        </div>
        </div>
      </div>
    </main>
  );
}
