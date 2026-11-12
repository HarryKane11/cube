import { useMemo, useState, useEffect } from "react";
import { setSeparate, stopAgent, undoRestore } from "@/agents/orchestrator";
import { agentById, type AgentDef } from "@/agents/types";
import { EngineLabel, Face } from "@/components/bits";
import { ChannelPeople } from "@/components/ChannelPeople";
import { refreshMembers } from "@/team";
import { Composer } from "@/components/Composer";
import { BranchIcon, CloseIcon, HashIcon, LockIcon, PinIcon, StageIcon, PeopleIcon } from "@/components/icons";
import { authorName } from "@/agents/types";
import { MessageItem, ThreadSummary } from "@/components/MessageItem";
import { ChatContainerContent, ChatContainerRoot } from "@/components/ui/chat-container";
import { ScrollButton } from "@/components/ui/scroll-button";
import { Cube, CubeStill } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useActiveConv, useCube, useStageOpen, type Conv, type Msg } from "@/state/store";

function Header({ conv, paneOpen }: { conv: Conv; paneOpen: boolean }) {
  const live = useCube((s) => s.live);
  const setStage = useCube((s) => s.setStage);
  const openProfile = useCube((s) => s.openProfile);
  const fileCount = useCube((s) => s.files[conv.id]?.length ?? 0);
  const members = conv.members.map((id) => agentById(id)).filter((a): a is AgentDef => Boolean(a));
  const dm = conv.kind === "dm" ? members[0] : undefined;
  const separate = useCube((s) => Boolean(s.trees[conv.id]));
  const [problem, setProblem] = useState("");
  const [people, setPeople] = useState(false);
  const inTeam = useCube((s) => Boolean(s.team.info));
  const teamMembers = useCube((s) => s.team.members);
  const inChannel = useCube((s) => (conv.shared ? s.teamLive.convMembers?.[conv.shared.id] : undefined));
  // Who else is here: everyone in the team for a channel shared with all of it, the invited ones for a private one.
  const here = !conv.shared || conv.person ? [] : conv.shared.private ? teamMembers.filter((m) => inChannel?.includes(m.pubkey)) : teamMembers;
  useEffect(() => {
    if (conv.shared?.private) refreshMembers(conv.shared.id);
  }, [conv.shared?.id, conv.shared?.private]);
  // ⇧⌘I asks for this from anywhere in the window.
  useEffect(() => {
    const open = () => { if (!dm && inTeam && !conv.person) setPeople(true); };
    window.addEventListener("cube:invite", open);
    return () => window.removeEventListener("cube:invite", open);
  }, [dm, inTeam, conv.person]);
  return (
    <header className="flex min-h-[62px] items-center gap-2.5 border-b px-5 py-2.5" data-tauri-drag-region>
      {dm ? <Cube color={dm.color} status={live[dm.id]?.status ?? "idle"} size={40} /> : conv.person ? (
        <Face pubkey={conv.person.pubkey} name={conv.name} size={36} />
      ) : <HashIcon className="text-muted-foreground" width={22} height={22} />}
      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-2 truncate font-heading text-[19px] font-bold leading-tight tracking-[-0.02em]">
          <span className="truncate">{conv.name}</span>
          {conv.shared && !conv.person && (
            <button type="button" className="flex h-5 flex-none items-center gap-1 rounded-full bg-primary/15 px-2 text-[11px] font-semibold tracking-normal text-primary" title={conv.shared.private ? "Only the people invited into this channel see it. Cubes here ask before they run anything." : "What is said here goes to everyone in your team. Cubes here ask before they run anything."} onClick={() => setPeople(true)}>
              {conv.shared.private ? <><LockIcon width={12} height={12} /> Private</> : <><PeopleIcon width={12} height={12} /> Shared with team</>}
            </button>
          )}
        </h1>
        {dm ? (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {dm.role} · runs on <EngineLabel agent={dm} />
          </p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {conv.person ? "Direct message. Your cubes answer here only when you name one with @." : <>{members.map((m) => m.name).join(", ")} and you</>}
          </p>
        )}
      </div>
      {here.length > 0 && (
        <button type="button" className="flex h-8 flex-none items-center gap-1.5 rounded-full bg-secondary pl-1.5 pr-2.5 text-[13px] font-semibold" title={`${here.map((m) => m.name).join(", ")}`} aria-label={`People in this channel: ${here.map((m) => m.name).join(", ")}`} onClick={() => setPeople(true)}>
          <span className="flex -space-x-1.5" aria-hidden="true">
            {here.slice(0, 3).map((m) => (
              <Face key={m.pubkey} pubkey={m.pubkey} name={m.name} size={22} className="ring-2 ring-secondary" />
            ))}
          </span>
          <span className="tabular-nums" data-notranslate>{here.length}</span>
        </button>
      )}
      {!dm && inTeam && !conv.person && (
        <button type="button" className="flex h-8 flex-none items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-semibold" title="Share this channel and invite people into it" onClick={() => setPeople(true)}>
          <PeopleIcon width={15} height={15} /> Invite
        </button>
      )}
      {!dm && <ChannelPeople conv={conv} open={people} onOpenChange={setPeople} />}
      {!dm && members.length > 1 && (
        <button
          type="button"
          aria-pressed={separate}
          title={problem || (separate ? "Separate copies are on: each cube works in its own copy of this folder, and you merge what you want. Click to turn off." : "Separate copies: let each cube work in its own copy of this folder, so cubes working at the same time never write over each other.")}
          className={cn("flex h-8 flex-none items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold", separate ? "bg-foreground text-background" : "bg-secondary", problem && "text-destructive")}
          onClick={() => void setSeparate(conv.id, !separate).then((p) => setProblem(p ?? ""))}
        >
          <BranchIcon width={15} height={15} /> {separate ? "Separate copies" : "Copies"}
        </button>
      )}
      {!dm && (
        <div className="flex -space-x-2">
          {members.map((m) => (
            <button type="button" key={m.id} className="rounded-xl" aria-label={`Open ${m.name}'s profile`} title={m.name} onClick={() => openProfile(m.id)}>
              <CubeStill color={m.color} size={30} />
            </button>
          ))}
        </div>
      )}
      {dm && (
        <button type="button" className="flex h-8 items-center rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => openProfile(dm.id)}>
          Profile
        </button>
      )}
      {!paneOpen && (
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setStage(conv.id, "open")}>
          <StageIcon width={15} height={15} /> Stage{fileCount > 0 && <span className="text-muted-foreground tabular-nums">{fileCount}</span>}
        </button>
      )}
    </header>
  );
}

/** Pinned messages of a conversation, one click away from wherever they are. */
function Pinned({ pinned }: { pinned: Msg[] }) {
  const [open, setOpen] = useState(false);
  const jumpTo = useCube((s) => s.jumpTo);
  const patchMsg = useCube((s) => s.patchMsg);
  if (!pinned.length) return null;
  return (
    <div className="relative border-b px-5 py-1" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button type="button" aria-expanded={open} className="flex h-7 items-center gap-1.5 rounded-full px-2 text-[13px] font-semibold text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(!open)}>
        <PinIcon width={14} height={14} /> {pinned.length === 1 ? "1 pinned message" : `${pinned.length} pinned messages`}
      </button>
      {open && (
        <ul className="absolute left-4 top-full z-20 mt-1 max-h-[320px] w-[min(440px,90%)] overflow-auto rounded-2xl border bg-popover p-1 shadow-md" aria-label="Pinned messages">
          {pinned.map((m) => (
            <li key={m.id} className="flex items-start gap-1 rounded-xl hover:bg-accent">
              <button type="button" className="min-w-0 flex-1 px-2.5 py-1.5 text-left" onClick={() => { jumpTo(m.id); setOpen(false); }}>
                <span className="block text-xs font-semibold">{authorName(m.author)}</span>
                <span className="line-clamp-2 text-[13px] text-muted-foreground">{m.text}</span>
              </button>
              <button type="button" aria-label="Unpin" title="Unpin" className="m-1 flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground" onClick={() => patchMsg(m.id, { pinned: false })}>
                <CloseIcon width={11} height={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Says so when two cubes, or a cube and the person, are changing the same file at the same time. */
function Clashes({ convId }: { convId: string }) {
  const clashes = useCube((s) => s.clashes[convId]);
  const dropClash = useCube((s) => s.dropClash);
  if (!clashes?.length) return null;
  const pill = "h-7 flex-none rounded-full bg-background px-3 font-semibold";
  return (
    <>
      {clashes.map((c) => {
        const agents = c.who.filter((w) => w !== "you");
        const mine = c.who.includes("you");
        const names = agents.map((id) => authorName(id));
        return (
          <div key={c.id} className="mx-3 mb-1 flex flex-wrap items-center gap-2 rounded-2xl bg-destructive/10 px-3 py-2 text-[13px]" role="alert">
            <span className="min-w-[180px] flex-1">
              {mine
                ? `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} changing ${c.rel}, which has edits of yours that are not saved. Saving will overwrite what ${names.length === 1 ? "it writes" : "they write"}.`
                : `${names.join(" and ")} are both changing ${c.rel}. Whoever saves last wins.`}
            </span>
            {agents.slice(mine ? 0 : 1).map((id) => (
              <button type="button" key={id} className={pill} onClick={() => { stopAgent(convId, id); dropClash(convId, c.id); }}>Stop {authorName(id)}</button>
            ))}
            {!mine && <button type="button" className={pill} title="From their next run on, each cube works in its own copy of the folder" onClick={() => void setSeparate(convId, true).then(() => dropClash(convId, c.id))}>Give each its own copy</button>}
            <button type="button" className="h-7 flex-none rounded-full px-2 font-semibold text-muted-foreground" onClick={() => dropClash(convId, c.id)}>Dismiss</button>
          </div>
        );
      })}
    </>
  );
}

function Empty({ conv }: { conv: Conv }) {
  const dm = conv.kind === "dm" ? agentById(conv.members[0]) : undefined;
  return (
    <div className="m-auto flex max-w-[320px] flex-col items-center gap-1.5 px-6 text-center">
      {dm && <Cube color={dm.color} status="idle" size={96} />}
      <h2 className="font-heading text-lg font-bold tracking-[-0.02em]">{dm || conv.person ? `Just you and ${dm ? dm.name : conv.name}` : `This is the start of #${conv.name}`}</h2>
      <p className="text-muted-foreground">
        {dm
          ? `Anything you write here goes straight to ${dm.name}. What it makes shows up on the Stage.`
          : "Say what you need. Start with @ to pick who gets it. Agents here can hand work to each other and reply in threads."}
      </p>
    </div>
  );
}

export function Conversation() {
  const conv = useActiveConv();
  const all = useCube((s) => s.messages);
  const messages = useMemo(() => all.filter((m) => m.convId === conv.id), [all, conv.id]);
  const roots = useMemo(() => messages.filter((m) => !m.parentId), [messages]);
  const replies = useMemo(() => {
    const map = new Map<string, Msg[]>();
    for (const m of messages) if (m.parentId) map.set(m.parentId, [...(map.get(m.parentId) ?? []), m]);
    return map;
  }, [messages]);

  const pinned = useMemo(() => messages.filter((m) => m.pinned), [messages]);
  const focusId = useCube((s) => s.focus?.id);
  const openThread = useCube((s) => s.openThread);
  // Jumping to a reply (from search, the Inbox or a notification) opens the thread it is in.
  useEffect(() => {
    const parent = focusId ? messages.find((m) => m.id === focusId)?.parentId : undefined;
    if (parent) openThread(parent);
  }, [focusId]);

  const stageOpen = useStageOpen(conv.id);
  const threadOpen = useCube((s) => Boolean(s.threadId));
  const paneOpen = stageOpen || threadOpen;
  const undo = useCube((s) => s.undo[conv.id]);
  const setUndo = useCube((s) => s.setUndo);
  // With nothing beside it the conversation gets the whole window, so keep the text in a readable column.
  const column = paneOpen ? "" : "mx-auto w-full max-w-[860px]";

  return (
    <main className={cn("flex min-h-0 min-w-0 flex-col border bg-background", paneOpen ? "rounded-l-[22px] border-r-0" : "rounded-[22px]")}>
      <Header conv={conv} paneOpen={paneOpen} />
      <Pinned pinned={pinned} />
      <ChatContainerRoot className="relative min-h-0 flex-1" key={conv.id}>
        <ChatContainerContent className={cn("min-h-full gap-2 py-4", column)}>
          {roots.length === 0 && <Empty conv={conv} />}
          {roots.map((m) => {
            const rs = replies.get(m.id) ?? [];
            return (
              <div className="flex flex-col gap-1" key={m.id}>
                <MessageItem msg={m} />
                {/* Replies live in the thread: the conversation shows that there are some, and the panel beside it shows them. */}
                <ThreadSummary root={m} replies={rs} />
              </div>
            );
          })}
        </ChatContainerContent>
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <ScrollButton className="pointer-events-auto shadow-sm" />
        </div>
      </ChatContainerRoot>
      <div className={column}>
        <Clashes convId={conv.id} />
        {undo && (
          <div className="mx-3 mb-1 flex items-center gap-2 rounded-2xl bg-primary/10 px-3 py-2 text-[13px]" role="status">
            <span className="min-w-0 flex-1">{undo.label}</span>
            <button type="button" className="h-7 flex-none rounded-full bg-background px-3 font-semibold" onClick={() => void undoRestore(conv.id)}>Undo</button>
            <button type="button" className="h-7 flex-none rounded-full px-2 font-semibold text-muted-foreground" onClick={() => setUndo(conv.id, undefined)}>Dismiss</button>
          </div>
        )}
        <Composer conv={conv} key={`composer-${conv.id}`} />
      </div>
    </main>
  );
}

/** One thread, opened beside the conversation: the first message, every reply, and a reply box. */
export function ThreadPanel() {
  const conv = useActiveConv();
  const threadId = useCube((s) => s.threadId);
  const openThread = useCube((s) => s.openThread);
  const all = useCube((s) => s.messages);
  const root = all.find((m) => m.id === threadId);
  const replies = useMemo(() => all.filter((m) => m.parentId === threadId), [all, threadId]);
  if (!root) return null;
  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-r-[22px] border bg-background" aria-label="Thread">
      <header className="flex min-h-[62px] items-center gap-2 border-b px-5 py-2.5" data-tauri-drag-region>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[19px] font-bold leading-tight tracking-[-0.02em]">Thread</h2>
          <p className="text-xs text-muted-foreground">{conv.kind === "dm" ? conv.name : `#${conv.name}`}</p>
        </div>
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => openThread(undefined)}>
          <CloseIcon width={14} height={14} /> Back to Stage
        </button>
      </header>
      <ChatContainerRoot className="min-h-0 flex-1" key={root.id}>
        <ChatContainerContent className="gap-1 py-4">
          <MessageItem msg={root} inPanel />
          <div className="mx-5 my-2 flex items-center gap-3 text-xs text-muted-foreground">
            {replies.length === 1 ? "1 reply" : `${replies.length} replies`}
            <span className="h-px flex-1 bg-border" />
          </div>
          {replies.map((r) => <MessageItem msg={r} inPanel key={r.id} />)}
        </ChatContainerContent>
      </ChatContainerRoot>
      <Composer conv={conv} parentId={root.id} key={`composer-${root.id}`} />
    </section>
  );
}
