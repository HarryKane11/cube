import { useMemo, useState, useEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { openPath } from "@tauri-apps/plugin-opener";
import { inTauri } from "@/agents/runner";
import { setSeparate, stopAgent, undoRestore } from "@/agents/orchestrator";
import { agentById, type AgentDef } from "@/agents/types";
import { EngineLabel, Face } from "@/components/bits";
import { ChannelPeople } from "@/components/ChannelPeople";
import { refreshMembers } from "@/team";
import { Composer } from "@/components/Composer";
import { BranchIcon, CloseIcon, HashIcon, LockIcon, MoreIcon, OpenIcon, PinIcon, StageIcon, PeopleIcon, ThreadIcon } from "@/components/icons";
import { authorName } from "@/agents/types";
import { MessageItem } from "@/components/MessageItem";
import { ChatContainerContent, ChatContainerRoot } from "@/components/ui/chat-container";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollButton } from "@/components/ui/scroll-button";
import { Cube, CubeStill } from "@/cube/Cube";
import { CubeMark } from "@/cube/CubeMark";
import { cn } from "@/lib/utils";
import { useActiveConv, useCube, useStageOpen, type Conv, type Msg, labelOf } from "@/state/store";

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

  const canInvite = !dm && inTeam && !conv.person;
  const canSeparate = !dm && members.length > 1;
  const folder = inTauri && Boolean(conv.dir);
  const copiesAbout = separate
    ? "Separate copies are on: each cube works in its own copy of this folder, and you merge what you want. Click to turn off."
    : "Separate copies: let each cube work in its own copy of this folder, so cubes working at the same time never write over each other.";
  const toggleCopies = () => void setSeparate(conv.id, !separate).then((p) => setProblem(p ?? ""));
  // The header holds the name and what is looked at every day. Everything else is one click away, without a filled button of its own.
  const ghost = "flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground";
  // A badge gives way before it is cut: with little room its words end in an ellipsis.
  const badge = "flex h-[18px] min-w-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold [&>svg]:flex-none";
  const title = "truncate font-heading text-[17px] font-bold leading-tight tracking-[-0.02em]";
  return (
    <header className="flex min-h-[52px] items-center gap-2 border-b px-5 py-2" data-tauri-drag-region>
      {/* The name keeps a width of its own: what stands beside it is what gives way. */}
      {dm ? (
        <button type="button" className="-ml-1.5 flex min-w-0 max-w-[50%] flex-none items-center gap-2 rounded-lg px-1.5 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" title="Open profile" onClick={() => openProfile(dm.id)}>
          <Cube color={dm.color} status={live[dm.id]?.status ?? "idle"} size={28} />
          <h1 className={title}>{conv.name}</h1>
        </button>
      ) : (
        <div className="flex min-w-0 max-w-[50%] flex-none items-center gap-2">
          {conv.person
            ? <Face pubkey={conv.person.pubkey} name={conv.name} size={26} />
            : conv.shared?.private
              ? <LockIcon className="flex-none text-muted-foreground" width={18} height={18} />
              : conv.cube
                ? <CubeMark size={24} className="flex-none" />
              : conv.chat
                ? <ThreadIcon className="flex-none text-muted-foreground" width={18} height={18} />
                : <HashIcon className="flex-none text-muted-foreground" width={18} height={18} />}
          <h1 className={title}>{conv.name}</h1>
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
        {dm && <span className="flex min-w-0 items-center gap-1">{dm.role} · runs on <EngineLabel agent={dm} /></span>}
        {/* Who sees the channel sits beside its name, so it is never out of sight. */}
        {conv.shared && !conv.person && (
          <button type="button" className={cn(badge, "bg-primary/15 text-primary")} title={conv.shared.private ? "Only the people invited into this channel see it. Cubes here ask before they run anything." : "What is said here goes to everyone in your team. Cubes here ask before they run anything."} onClick={() => setPeople(true)}>
            {conv.shared.private ? <><LockIcon width={11} height={11} /> <span className="truncate">Private</span></> : <><PeopleIcon width={11} height={11} /> <span className="truncate">Shared with team</span></>}
          </button>
        )}
        {/* Separate copies change where the cubes write, so while they are on the header says so. */}
        {separate && (
          <button type="button" className={cn(badge, "bg-secondary text-foreground")} title={copiesAbout} onClick={toggleCopies}>
            <BranchIcon width={11} height={11} /> <span className="truncate">Separate copies</span>
          </button>
        )}
        {conv.person && <span className="truncate">Direct message. Your cubes answer here only when you name one with @.</span>}
        {/* A chat in a folder of the person's own says which: what its cubes change is changed there. */}
        {conv.workspace && <span className="truncate" title={conv.workspace}><span>Folder</span><span data-notranslate> · {conv.workspace.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")}</span></span>}
        {/* A chat that began from another program's session says where it came from. */}
        {conv.imported && <span className="truncate" title={conv.imported.cwd}><span>{`From ${conv.imported.program}`}</span>{conv.imported.cwd ? <span data-notranslate> · {conv.imported.cwd.split("/").filter(Boolean).pop()}</span> : null}</span>}
        {problem && <span className="truncate text-destructive" role="alert" title={problem} data-notranslate>{problem}</span>}
      </div>
      {!dm && (
        <DropdownMenu>
          <DropdownMenuTrigger className={ghost} aria-label="Members of this channel" title="Members">
            <PeopleIcon width={16} height={16} />
            <span className="tabular-nums" data-notranslate>{members.length + here.length}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Cubes</DropdownMenuLabel>
              {members.map((m) => (
                <DropdownMenuItem key={m.id} onClick={() => openProfile(m.id)}>
                  <CubeStill color={m.color} size={22} /> {m.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {here.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>People</DropdownMenuLabel>
                  {here.map((m) => (
                    <DropdownMenuItem key={m.pubkey} onClick={() => setPeople(true)}>
                      <Face pubkey={m.pubkey} name={m.name} size={20} className="mx-px" /> <span className="truncate" data-notranslate>{m.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {canInvite && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setPeople(true)}>
                  <PeopleIcon width={16} height={16} className="mx-[3px]" /> {conv.shared ? "Invite people…" : "Share and invite…"}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!dm && <ChannelPeople conv={conv} open={people} onOpenChange={setPeople} />}
      {!paneOpen && (
        <button type="button" className={ghost} aria-label="Show Stage" title="Show Stage" onClick={() => setStage(conv.id, "open")}>
          <StageIcon width={16} height={16} />{fileCount > 0 && <span className="tabular-nums" data-notranslate>{fileCount}</span>}
        </button>
      )}
      {(canSeparate || folder) && (
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(ghost, "px-1.5")} aria-label="More" title="More">
            <MoreIcon width={18} height={18} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {canSeparate && (
              <DropdownMenuCheckboxItem checked={separate} title={copiesAbout} closeOnClick onClick={toggleCopies}>
                <BranchIcon width={16} height={16} /> Separate copies
              </DropdownMenuCheckboxItem>
            )}
            {folder && (
              <DropdownMenuItem onClick={() => void openPath(conv.dir).catch(() => undefined)}>
                <OpenIcon width={16} height={16} /> Show folder in Finder
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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

/**
 * The conversation follows what is new while the person is at its end, and stays where they are
 * once they scroll up to read. Sending something is asking to see what comes back, so their own
 * message takes the conversation to its end from wherever they were.
 */
function FollowOwn({ last }: { last?: Msg }) {
  const { scrollToBottom } = useStickToBottomContext();
  const seen = useRef(last?.id);
  useEffect(() => {
    if (last && last.id !== seen.current && last.author === "you") void scrollToBottom();
    seen.current = last?.id;
  }, [last?.id]);
  return null;
}

function Empty({ conv }: { conv: Conv }) {
  const dm = conv.kind === "dm" ? agentById(conv.members[0]) : undefined;
  return (
    <div className="m-auto flex max-w-[320px] flex-col items-center gap-1.5 px-6 text-center">
      {dm && <Cube color={dm.color} status="idle" size={96} />}
      {conv.cube && <CubeMark size={72} className="mb-1" />}
      <h2 className="font-heading text-[17px] font-bold tracking-[-0.02em]">{dm || conv.person ? `Just you and ${dm ? dm.name : conv.name}` : conv.cube ? "Just you and your whole team" : conv.chat ? conv.name : `This is the start of #${conv.name}`}</h2>
      <p className="text-muted-foreground">
        {dm
          ? `Anything you write here goes straight to ${dm.name}. What it makes shows up on the Stage.`
          : conv.cube
            ? "Say what you need, as you would to one person. Cube works out which of your cubes should take it, and they answer here."
          : conv.imported
            ? `Brought in from ${conv.imported.program}. Say what the team should do next.`
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
        <FollowOwn last={roots[roots.length - 1]} />
        <ChatContainerContent className={cn("min-h-full gap-3.5 py-4", column)}>
          {roots.length === 0 && <Empty conv={conv} />}
          {/* Replies live in the thread: the message says that there are some, and the panel beside it shows them. */}
          {roots.map((m) => <MessageItem msg={m} replies={replies.get(m.id)} key={m.id} />)}
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
      <header className="flex min-h-[52px] items-center gap-2 border-b px-5 py-2" data-tauri-drag-region>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[17px] font-bold leading-tight tracking-[-0.02em]">Thread</h2>
          <p className="truncate text-xs text-muted-foreground">{labelOf(conv)}</p>
        </div>
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => openThread(undefined)}>
          <CloseIcon width={14} height={14} /> Back to Stage
        </button>
      </header>
      <ChatContainerRoot className="min-h-0 flex-1" key={root.id}>
        <FollowOwn last={replies[replies.length - 1]} />
        <ChatContainerContent className="gap-3 py-4">
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
