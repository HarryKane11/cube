import { useEffect, useState } from "react";
import { ChevronDown, Folder, FolderOpen, FolderPlus, Monitor, Moon, Sun } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { KEPT_CHANNELS, closeWorkspace, createChannel, deleteChannel, openWorkspace } from "@/agents/orchestrator";
import { inTauri } from "@/agents/runner";
import { ChannelPeople } from "@/components/ChannelPeople";
import { RightClick } from "@/components/ui/context-menu";
import { SHORTCUTS, commandFor } from "@/lib/shortcuts";
import { nameOf, openDm, renameChannel } from "@/team";
import { AGENTS, ROUTER, agentById } from "@/agents/types";
import { Face, PersonAvatar } from "@/components/bits";
import { BookIcon, GearIcon, HashIcon, HomeIcon, InboxIcon, PanelIcon, PlusIcon, SearchIcon, LockIcon, ThreadIcon } from "@/components/icons";
import { useInboxCount } from "@/components/Inbox";
import { Palette } from "@/components/Palette";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Cube, CubeStill } from "@/cube/Cube";
import { CubeMark } from "@/cube/CubeMark";
import { RunsOnPicker } from "@/components/RunsOnPicker";
import { UsageRing } from "@/components/UsageBits";
import { cn } from "@/lib/utils";
import { useCube, type Conv, type Workspace, labelOf, workspaceName } from "@/state/store";
import { showUpdate, useUpdate } from "@/update";

const WORD: Record<string, string> = { needs: "needs you", stuck: "stuck" };
/** How many chats the sidebar lists before the rest are folded away. */
const SHOWN_CHATS = 6;
/** Chats, the newest first: the one just started is the one looked for. */
const chatsOf = (convs: Conv[]): Conv[] => convs.filter((c) => c.chat && !c.cube).sort((a, b) => b.createdAt - a.createdAt);

/** Chats that work in a folder Cube made for them: the ones that are in no workspace. */
const looseOf = (chats: Conv[]): Conv[] => chats.filter((c) => !c.workspace);

/**
 * The folders to list: those open as workspaces, in the order they were opened, then any a chat
 * still names that was closed since, so its chats are not lost from sight.
 */
const foldersOf = (open: Workspace[], chats: Conv[]): string[] => [...new Set([...open.map((w) => w.dir), ...chats.flatMap((c) => (c.workspace ? [c.workspace] : []))])];

/**
 * A section's heading in the sidebar. Pressing it folds the section away, or opens it again;
 * which ones are folded is kept. A folded section still shows what is unread and what is open.
 */
function FoldHead({ id, title, className }: { id: string; title: string; className: string }) {
  const folded = useCube((s) => Boolean(s.settings.folded?.includes(id)));
  const setSetting = useCube((s) => s.setSetting);
  const toggle = () => {
    const now = useCube.getState().settings.folded ?? [];
    setSetting("folded", folded ? now.filter((x) => x !== id) : [...now, id]);
  };
  return (
    <button type="button" aria-expanded={!folded} className={cn(className, "group/fold flex min-w-0 items-center gap-1 text-left outline-none hover:text-foreground focus-visible:text-foreground")} onClick={toggle}>
      <span className="truncate">{title}</span>
      <ChevronDown size={12} strokeWidth={2.25} className={cn("flex-none transition-[transform,opacity] duration-150", folded ? "-rotate-90" : "opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100")} />
    </button>
  );
}

/** One folder of the person's own in the sidebar: its name, then the chats that work in it. */
function WorkspaceGroup({ dir, chats }: { dir: string; chats: Conv[] }) {
  const known = useCube((s) => s.workspaces.find((w) => w.dir === dir));
  const setSetting = useCube((s) => s.setSetting);
  const goHome = useCube((s) => s.goHome);
  const [folded, setFolded] = useState(false);
  const [all, setAll] = useState(false);
  const [error, setError] = useState("");
  const usable = Boolean(known && !known.missing);
  // A chat is begun on Home: the folder is chosen there, and the person says what to do in it.
  const startHere = () => { setSetting("workspace", dir); goHome(); };
  const items = [
    usable && { label: "New chat here", onSelect: startHere },
    inTauri && usable && { label: "Show folder in Finder", onSelect: () => void openPath(dir).catch(() => undefined) },
    // Only the system's folder dialog can open a folder: the person picks it there again.
    !known && { label: "Open this folder again…", onSelect: () => void openWorkspace().then((problem) => setError(problem ?? "")) },
    "-" as const,
    known && { label: "Close workspace", onSelect: () => void closeWorkspace(dir) },
  ];
  const state = !known ? "Closed" : known.missing ? "Not found" : "";
  return (
    <div className="flex flex-col gap-0.5">
      <RightClick items={items}>
        <div className="group/ws flex min-h-[30px] items-center rounded-[10px] pr-1 hover:bg-accent">
          <button type="button" aria-expanded={!folded} title={dir} className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setFolded(!folded)}>
            {folded ? <Folder size={15} strokeWidth={2} className={cn("mx-1.5 flex-none text-muted-foreground", !usable && "opacity-50")} /> : <FolderOpen size={15} strokeWidth={2} className={cn("mx-1.5 flex-none text-muted-foreground", !usable && "opacity-50")} />}
            <span className={cn("min-w-0 truncate font-medium", !usable && "text-muted-foreground")} data-notranslate>{known?.name ?? workspaceName(dir)}</span>
            {state && <span className="flex-none text-xs text-muted-foreground">{state}</span>}
          </button>
          {usable && (
            <button type="button" aria-label="New chat in this folder" title="New chat in this folder" className="flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/ws:opacity-100" onClick={startHere}>
              <PlusIcon width={15} height={15} />
            </button>
          )}
        </div>
      </RightClick>
      {error && <p className="px-3.5 text-xs text-destructive" role="alert">{error}</p>}
      {!folded && (
        <div className="ml-[17px] flex flex-col gap-0.5 border-l pl-1">
          {(all ? chats : chats.slice(0, SHOWN_CHATS)).map((c) => <Row conv={c} key={c.id} />)}
          {!chats.length && <p className="px-2 py-1 text-xs text-muted-foreground">{usable ? "No chats here yet." : ""}</p>}
          {chats.length > SHOWN_CHATS && (
            <button type="button" className="flex min-h-[28px] items-center rounded-[10px] px-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${chats.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Every shortcut with what it does. */
export function ShortcutList() {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 text-[13px]">
      {SHORTCUTS.map((s) => (
        <div key={s.keys} className="contents">
          <dt><kbd className="rounded-md bg-secondary px-1.5 py-0.5 font-sans text-xs font-semibold" data-notranslate>{s.keys}</kbd></dt>
          <dd className="text-muted-foreground">{s.does}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A teammate where a cube would be: their picture, or the first letter of their name. */
function Initial({ name, size, pubkey }: { name: string; size: number; pubkey?: string }) {
  return <Face pubkey={pubkey ?? "?"} name={name} size={size} className="mx-0.5" />;
}

/** Picks the teammate to write to. */
function NewDm({ onClose }: { onClose: () => void }) {
  const team = useCube((s) => s.team);
  const [error, setError] = useState("");
  const others = team.members.filter((m) => m.pubkey !== team.info?.pubkey);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>A conversation between you and one teammate. Your cubes are there too, and answer only when you name one with @.</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[50vh] flex-col overflow-auto">
          {others.map((m) => (
            <li key={m.pubkey}>
              <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent" onClick={() => void openDm(m.pubkey).then(onClose).catch((e) => setError(String(e)))}>
                <Initial name={m.name} size={28} pubkey={m.pubkey} />
                <span className="min-w-0 flex-1 truncate" data-notranslate>{nameOf(m.pubkey, team.members)}</span>
              </button>
            </li>
          ))}
          {others.length === 0 && <li className="py-2 text-[13px] text-muted-foreground">Nobody else is in the team yet. Invite someone from a channel, or in Settings.</li>}
        </ul>
        {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

function Unread({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-bold leading-[18px] text-primary-foreground tabular-nums">{n}</span>;
}

/** A conversation in the sidebar, with what can be done to it on a right click. */
function Row({ conv, rail }: { conv: Conv; rail?: boolean }) {
  const unread = useCube((s) => s.unread[conv.id] ?? 0);
  const inTeam = useCube((s) => Boolean(s.team.info));
  const openProfile = useCube((s) => s.openProfile);
  const [dialog, setDialog] = useState<"people" | "rename" | "delete">();
  const agent = conv.kind === "dm" ? agentById(conv.members[0]) : undefined;
  const folder = inTauri && conv.dir ? { label: "Show folder in Finder", onSelect: () => void openPath(conv.dir).catch(() => undefined) } : undefined;
  const items = agent
    ? [{ label: "Open profile", onSelect: () => openProfile(agent.id) }, folder]
    : conv.cube
      ? [{ label: "Open profile", onSelect: () => openProfile(ROUTER) }, unread > 0 && { label: "Mark as read", onSelect: () => useCube.setState((s) => ({ unread: { ...s.unread, [conv.id]: 0 } })) }, folder]
    : conv.person || conv.chat
      ? [conv.chat && { label: "Rename…", onSelect: () => setDialog("rename") }, unread > 0 && { label: "Mark as read", onSelect: () => useCube.setState((s) => ({ unread: { ...s.unread, [conv.id]: 0 } })) }, folder, "-" as const, { label: "Delete conversation…", danger: true, onSelect: () => setDialog("delete") }]
      : [
        inTeam && { label: conv.shared ? "Invite people…" : "Share and invite…", onSelect: () => setDialog("people") },
        { label: "Rename…", onSelect: () => setDialog("rename") },
        unread > 0 && { label: "Mark as read", onSelect: () => useCube.setState((s) => ({ unread: { ...s.unread, [conv.id]: 0 } })) },
        folder,
        "-" as const,
        !KEPT_CHANNELS.includes(conv.id) && { label: "Delete channel…", danger: true, onSelect: () => setDialog("delete") },
      ];
  return (
    <>
      <RightClick items={items}><RowButton conv={conv} rail={rail} /></RightClick>
      {!agent && dialog === "people" && <ChannelPeople conv={conv} open onOpenChange={(o) => { if (!o) setDialog(undefined); }} />}
      {!agent && dialog === "rename" && <RenameChannel conv={conv} onClose={() => setDialog(undefined)} />}
      {!agent && dialog === "delete" && <DeleteChannel conv={conv} onClose={() => setDialog(undefined)} />}
    </>
  );
}

const THEME_CHOICES = [
  { v: "light", label: "Light", Icon: Sun },
  { v: "system", label: "System", Icon: Monitor },
  { v: "dark", label: "Dark", Icon: Moon },
] as const;

/** Light, the system's own, or dark, one press away at the foot of the sidebar. The same setting as under Settings > Look. */
function ThemeSwitch() {
  const theme = useCube((s) => s.settings.theme);
  const setSetting = useCube((s) => s.setSetting);
  return (
    <div className="flex flex-none rounded-lg bg-secondary p-0.5" role="group" aria-label="Appearance">
      {THEME_CHOICES.map(({ v, label, Icon }) => (
        <button type="button" key={v} aria-pressed={theme === v} aria-label={label} title={label} className={cn("flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground", theme === v && "bg-background text-foreground shadow-sm")} onClick={() => setSetting("theme", v)}>
          <Icon size={14} strokeWidth={2} />
        </button>
      ))}
    </div>
  );
}

function RenameChannel({ conv, onClose }: { conv: Conv; onClose: () => void }) {
  const [name, setName] = useState(conv.name);
  const [error, setError] = useState("");
  const save = () => void renameChannel(conv.id, name).then(onClose).catch((e) => setError(String(e)));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{conv.chat ? "Rename chat" : "Rename channel"}</DialogTitle>
          <DialogDescription>{conv.shared ? "The new name shows for everyone who has this channel." : "Only the name changes. The folder and what was said stay as they are."}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Input autoFocus aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="selectable h-9" />
          {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
          <DialogFooter>
            <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={onClose}>Cancel</button>
            <button type="submit" className="h-8 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-40" disabled={!name.trim() || name.trim() === conv.name}>Rename</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteChannel({ conv, onClose }: { conv: Conv; onClose: () => void }) {
  const count = useCube((s) => s.messages.filter((m) => m.convId === conv.id).length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = () => {
    setBusy(true);
    void deleteChannel(conv.id).then((problem) => (problem ? setError(problem) : onClose())).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{conv.person || conv.chat ? "Delete this conversation?" : "Delete this channel?"}</DialogTitle>
          <DialogDescription>
            {conv.shared
              ? "You leave the channel and it is removed from this Cube. The team keeps what was said in it. Its folder on this Mac goes to the Trash, from where you can take the files back."
              : conv.workspace
                ? "Its messages are removed from Cube and cannot be brought back. The folder it worked in is yours: it stays as it is."
                : "Its messages are removed from Cube and cannot be brought back. Its folder goes to the Trash, from where you can take the files back."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-[13px]"><span className="font-semibold" data-notranslate>{labelOf(conv)}</span><span className="text-muted-foreground" data-notranslate> · {count}</span> <span className="text-muted-foreground">messages</span></p>
        {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
        <DialogFooter>
          <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={onClose}>{error ? "Close" : "Keep"}</button>
          {!error && <button type="button" className="h-8 rounded-full bg-destructive px-3 text-[13px] font-semibold text-white disabled:opacity-40" disabled={busy} onClick={remove}>{conv.person || conv.chat ? "Delete conversation" : "Delete channel"}</button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowButton({ conv, rail }: { conv: Conv; rail?: boolean }) {
  const active = useCube((s) => s.view === "conv" && s.activeId === conv.id);
  const unread = useCube((s) => s.unread[conv.id] ?? 0);
  const setActive = useCube((s) => s.setActive);
  const busy = useCube((s) => Object.values(s.live).some((l) => l.convId === conv.id && (l.status === "thinking" || l.status === "working")));
  const agent = conv.kind === "dm" ? agentById(conv.members[0]) : conv.cube ? agentById(ROUTER) : undefined;
  const live = useCube((s) => (agent ? s.live[agent.id] : undefined));
  const status = live?.status ?? "idle";
  if (rail) {
    // The narrow sidebar: one icon per conversation, with a dot when something waits there.
    return (
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${agent ? conv.name : labelOf(conv)}${unread ? `, ${unread} unread` : ""}`}
        title={agent ? conv.name : labelOf(conv)}
        className={cn("relative flex size-10 items-center justify-center rounded-xl", active ? "bg-secondary" : "hover:bg-accent")}
        onClick={() => setActive(conv.id)}
      >
        {agent ? <Cube color={agent.color} status={status} size={30} /> : conv.cube ? <CubeMark size={24} /> : conv.person ? <Initial name={conv.name} size={28} pubkey={conv.person.pubkey} /> : conv.chat ? <ThreadIcon className="text-muted-foreground" width={17} height={17} /> : <HashIcon className="text-muted-foreground" width={17} height={17} />}
        {(unread > 0 || status === "needs") && <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}
      </button>
    );
  }
  if (agent) {
    // A cube's row has two lines: its name, and under it what it runs on, in full. The row itself
    // opens the conversation; what it runs on is a control of its own, so the row is not one button.
    return (
      <div className={cn("relative flex min-h-[44px] w-full items-center gap-2 rounded-[10px] px-2 py-1", active ? "bg-secondary" : "hover:bg-accent")}>
        <button type="button" aria-current={active ? "page" : undefined} aria-label={`${conv.name}${unread ? `, ${unread} unread` : ""}`} className="absolute inset-0 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setActive(conv.id)} />
        <span className="pointer-events-none relative mx-0.5 flex-none"><Cube color={agent.color} status={status} size={26} /></span>
        <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate leading-5", (active || unread > 0) && "font-semibold")}>{conv.name}</span>
          <RunsOnPicker agent={agent} />
        </span>
        {/* A cube at work shows it by moving. Words are kept for when it waits on the person or cannot go on. */}
        {(status === "needs" || status === "stuck") && !unread ? (
          <span className={cn("pointer-events-none relative text-xs", status === "needs" ? "font-semibold text-primary" : "font-semibold text-destructive")}>{WORD[status]}</span>
        ) : (
          <UsageRing agent={agent} />
        )}
        <span className="pointer-events-none relative empty:hidden"><Unread n={unread} /></span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        // A cube, a teammate and a channel are all one line of the same height: the list reads as one column.
        "flex min-h-[32px] w-full items-center gap-2 rounded-[10px] px-2 text-left",
        active ? "bg-secondary font-semibold" : "hover:bg-accent",
        unread > 0 && "font-semibold",
      )}
      onClick={() => setActive(conv.id)}
    >
      {conv.cube ? <CubeMark size={22} className="mx-[3px] flex-none" /> : conv.person ? <Face pubkey={conv.person.pubkey} name={conv.name} size={20} className="mx-1" /> : conv.shared?.private ? <LockIcon className="mx-1.5 text-muted-foreground" width={16} height={16} /> : conv.chat ? <ThreadIcon className="mx-1.5 text-muted-foreground" width={16} height={16} /> : <HashIcon className="mx-1.5 text-muted-foreground" width={16} height={16} />}
      <span className="min-w-0 flex-1 truncate" data-notranslate={conv.chat ? "" : undefined}>{conv.name}</span>
      {busy && <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-label="Agents are working here" />}
      <Unread n={unread} />
    </button>
  );
}

function NewChannel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>(AGENTS.map((a) => a.id));
  const [error, setError] = useState("");
  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const create = async () => {
    const problem = await createChannel(name, members);
    if (problem) return setError(problem);
    setName("");
    setError("");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
          <DialogDescription>A channel has its own folder and its own Stage. Agents in it can hand work to each other.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="channel-name" className="text-[13px] font-semibold">Name</label>
            <Input id="channel-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="launch-week" autoFocus className="selectable" />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[13px] font-semibold">Agents</legend>
            <div className="flex flex-wrap gap-2">
              {AGENTS.map((a) => {
                const on = members.includes(a.id);
                return (
                  <button
                    type="button"
                    key={a.id}
                    aria-pressed={on}
                    className={cn("flex items-center gap-1.5 rounded-full border py-0.5 pl-1 pr-3 font-medium", on ? "border-primary bg-primary/10" : "text-muted-foreground")}
                    onClick={() => toggle(a.id)}
                  >
                    <CubeStill color={a.color} size={30} />
                    {a.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <button type="submit" className="h-9 rounded-full bg-primary px-4 font-semibold text-primary-foreground">Create channel</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Sidebar() {
  const convs = useCube((s) => s.convs);
  const view = useCube((s) => s.view);
  const name = useCube((s) => s.name);
  const goHome = useCube((s) => s.goHome);
  const openSettings = useCube((s) => s.openSettings);
  // A newer Cube that a check found. Shown until it is installed.
  const newer = useUpdate((s) => (s.phase === "found" ? s.version : ""));
  const openUpdate = () => { showUpdate(); openSettings(); };
  const openInbox = useCube((s) => s.openInbox);
  const openLibrary = useCube((s) => s.openLibrary);
  const waiting = useInboxCount();
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  const [allChats, setAllChats] = useState(false);
  const chats = chatsOf(convs);
  const workspaces = useCube((s) => s.workspaces);
  const loose = looseOf(chats);
  const folders = foldersOf(workspaces, chats);
  const [wsError, setWsError] = useState("");
  const turning = useCube((s) => s.settings.cubeLook?.shape === "cube");
  // What is folded away, and what a folded section still shows: a conversation with something unread, and the open one.
  const foldedIds = useCube((s) => s.settings.folded);
  const unreadOf = useCube((s) => s.unread);
  const openId = useCube((s) => (s.view === "conv" ? s.activeId : ""));
  const isFolded = (...ids: string[]) => ids.some((id) => foldedIds?.includes(id));
  const kept = (list: Conv[], ...ids: string[]) => (isFolded(...ids) ? list.filter((c) => (unreadOf[c.id] ?? 0) > 0 || c.id === openId) : list);
  const inTeam = useCube((s) => Boolean(s.team.info));
  const wide = useCube((s) => s.settings.sidebar);
  const setSetting = useCube((s) => s.setSetting);

  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.isComposing) return;
      const cmd = commandFor(e);
      if (!cmd) return;
      e.preventDefault();
      const s = useCube.getState();
      // The order conversations are listed in, so a number or an arrow means what the eye sees.
      const order = [...chatsOf(s.convs), ...s.convs.filter((c) => c.kind === "channel" && !c.person && !c.chat), ...s.convs.filter((c) => c.person), ...s.convs.filter((c) => c.kind === "dm")];
      if (cmd.t === "switch") setSwitching((v) => !v);
      else if (cmd.t === "sidebar") s.setSetting("sidebar", !s.settings.sidebar);
      else if (cmd.t === "settings") s.openSettings();
      else if (cmd.t === "channel") setCreating(true);
      else if (cmd.t === "dm") { if (s.team.info) setDmOpen(true); }
      else if (cmd.t === "invite") window.dispatchEvent(new Event("cube:invite"));
      else if (cmd.t === "help") setHelp((v) => !v);
      else if (cmd.t === "nth") { const to = order[cmd.n - 1]; if (to) s.setActive(to.id); }
      else if (cmd.t === "step") {
        const at = s.view === "conv" ? order.findIndex((c) => c.id === s.activeId) : -1;
        const to = order[at < 0 ? 0 : (at + cmd.by + order.length) % order.length];
        if (to) s.setActive(to.id);
      } else if (cmd.t === "stage" && s.view === "conv") {
        const id = s.activeId;
        const open = s.stage[id] ? s.stage[id] === "open" : (s.files[id]?.length ?? 0) + (s.shots[id]?.length ?? 0) > 0 || Boolean(s.follow[id]);
        s.setStage(id, open ? "closed" : "open");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const label = "px-2 pb-1 pt-4 text-xs font-semibold text-muted-foreground";
  const sublabel = "px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground/80";
  // What a shortcut can open, whichever form the sidebar is in.
  const extras = (
    <>
      {dmOpen && <NewDm onClose={() => setDmOpen(false)} />}
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>⌘ is Ctrl on Windows and Linux.</DialogDescription>
          </DialogHeader>
          <ShortcutList />
        </DialogContent>
      </Dialog>
    </>
  );

  if (!wide) {
    // Hidden, the sidebar takes no room at all. One button beside the window's own brings it back, and ⌘B does the same.
    return (
      <nav aria-label="Workspace">
        <button type="button" aria-label="Show the sidebar" title="Show the sidebar (⌘B)" className="fixed left-[78px] top-[7px] z-30 flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setSetting("sidebar", true)}>
          <PanelIcon width={16} height={16} />
          {waiting > 0 && <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-primary" />}
        </button>
        <Palette open={switching} onOpenChange={setSwitching} />
        <NewChannel open={creating} onOpenChange={setCreating} />
        {extras}
      </nav>
    );
  }
  return (
    <nav className="flex min-h-0 flex-col px-2.5 pb-3 pt-9" aria-label="Workspace">
      <div className="flex items-center gap-2 px-1.5 pb-3" data-tauri-drag-region>
        {/* The mark and the name are the way home, as in most apps. */}
        <button type="button" aria-label="Home" title="Home" className="-m-1 flex min-w-0 flex-1 items-center gap-2 rounded-xl p-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={goHome}>
          {/* Cube as the person set it: the cube that turns, with its face, or the flat mark, which at this size leaves its figure off. */}
          {turning
            ? <span className="pointer-events-none mx-0.5 flex-none"><Cube color={agentById(ROUTER)?.color ?? "#888888"} status="idle" size={34} prop={null} /></span>
            : <CubeMark size={34} plain className="pointer-events-none mx-0.5 flex-none" />}
          <span className="min-w-0 flex-1">
            <span className="block font-heading text-[17px] font-bold leading-tight tracking-[-0.02em]">Cube</span>
            <span className="block text-xs text-muted-foreground">Local workspace</span>
          </span>
        </button>
        <button type="button" aria-label="Hide the sidebar" title="Hide the sidebar (⌘B)" className="flex size-7 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setSetting("sidebar", false)}>
          <PanelIcon width={15} height={15} />
        </button>
      </div>

      {/* Only the list scrolls. The name of the app above it and the person's own row below it stay where they are. */}
      <div className="-mx-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2 [scrollbar-width:none]">
      <button type="button" className="flex h-8 flex-none items-center gap-2 rounded-[10px] bg-secondary/70 px-2.5 text-[13px] text-muted-foreground hover:bg-secondary" onClick={() => setSwitching(true)}>
        <SearchIcon width={15} height={15} /> Search
        <kbd className="ml-auto font-sans text-xs">⌘K</kbd>
      </button>

      <button
        type="button"
        aria-current={view === "home" ? "page" : undefined}
        className={cn("mt-2 flex min-h-[32px] items-center gap-2 rounded-[10px] px-2 text-left", view === "home" ? "bg-secondary font-semibold" : "hover:bg-accent")}
        onClick={goHome}
      >
        <HomeIcon className="mx-1.5 text-muted-foreground" width={16} height={16} /> Home
      </button>
      <button
        type="button"
        aria-current={view === "inbox" ? "page" : undefined}
        className={cn("flex min-h-[32px] items-center gap-2 rounded-[10px] px-2 text-left", view === "inbox" ? "bg-secondary font-semibold" : "hover:bg-accent", waiting > 0 && "font-semibold")}
        onClick={openInbox}
      >
        <InboxIcon className="mx-1.5 text-muted-foreground" width={16} height={16} /> Inbox
        <Unread n={waiting} />
      </button>
      <button
        type="button"
        aria-current={view === "library" ? "page" : undefined}
        className={cn("flex min-h-[32px] items-center gap-2 rounded-[10px] px-2 text-left", view === "library" ? "bg-secondary font-semibold" : "hover:bg-accent")}
        onClick={() => openLibrary()}
      >
        <BookIcon className="mx-1.5 text-muted-foreground" width={16} height={16} /> Library
      </button>

      {/* Where chats are: those in a folder Cube made for them first, then one group for each folder of the person's own. */}
      <div className="flex items-center justify-between">
        <FoldHead id="workspaces" title="Workspaces" className={label} />
        <div className="mt-3 flex items-center gap-0.5">
          <button type="button" aria-label="Open a folder" title="Open a folder" className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => { setWsError(""); void openWorkspace().then((problem) => { if (problem) setWsError(problem); else goHome(); }); }}>
            <FolderPlus size={15} strokeWidth={2} />
          </button>
          <button type="button" aria-label="New chat" title="New chat" className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={goHome}>
            <PlusIcon width={15} height={15} />
          </button>
        </div>
      </div>
      {wsError && <p className="px-2 pb-1 text-xs text-destructive" role="alert">{wsError}</p>}
      <div className="flex flex-col gap-0.5">
        {kept(allChats ? loose : loose.slice(0, SHOWN_CHATS), "workspaces").map((c) => <Row conv={c} key={c.id} />)}
        {!isFolded("workspaces") && loose.length > SHOWN_CHATS && (
          <button type="button" className="flex min-h-[28px] items-center rounded-[10px] px-3.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setAllChats(!allChats)}>
            {allChats ? "Show fewer" : `Show all ${loose.length}`}
          </button>
        )}
        {!isFolded("workspaces") && folders.map((dir) => <WorkspaceGroup dir={dir} chats={chats.filter((c) => c.workspace === dir)} key={dir} />)}
        {/* Folded, the folders go too; a chat in one that has something unread, or is open, stays in sight. */}
        {isFolded("workspaces") && kept(chats.filter((c) => c.workspace), "workspaces").map((c) => <Row conv={c} key={c.id} />)}
        {!isFolded("workspaces") && !loose.length && !folders.length && <p className="px-2 py-1 text-xs text-muted-foreground">Ask for something on Home, or open a folder to work in.</p>}
      </div>

      <div className="flex items-center justify-between">
        <FoldHead id="channels" title="Channels" className={label} />
        <button type="button" aria-label="New channel" title="New channel" className="mt-3 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setCreating(true)}>
          <PlusIcon width={15} height={15} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {kept(convs.filter((c) => c.kind === "channel" && !c.person && !c.chat), "channels").map((c) => <Row conv={c} key={c.id} />)}
      </div>

      <div className="flex items-center justify-between">
        <FoldHead id="dms" title="Direct messages" className={label} />
        {inTeam && (
          <button type="button" aria-label="New message to a teammate" title="New message to a teammate" className="mt-3 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setDmOpen(true)}>
            <PlusIcon width={15} height={15} />
          </button>
        )}
      </div>
      {/* People and cubes are written to in the same way, and are not the same thing: each has its own part of the list. */}
      {convs.some((c) => c.person) && (
        <>
          {!isFolded("dms") && <FoldHead id="people" title="People" className={sublabel} />}
          <div className="flex flex-col gap-0.5">
            {kept(convs.filter((c) => c.person), "dms", "people").map((c) => <Row conv={c} key={c.id} />)}
          </div>
        </>
      )}
      {!isFolded("dms") && <FoldHead id="cubes" title="Cubes" className={sublabel} />}
      <div className="flex flex-col gap-0.5">
        {kept(convs.filter((c) => c.cube), "dms", "cubes").map((c) => <Row conv={c} key={c.id} />)}
        {kept(convs.filter((c) => c.kind === "dm"), "dms", "cubes").map((c) => <Row conv={c} key={c.id} />)}
      </div>
      {extras}
      </div>

      {newer && (
        <button type="button" className="mt-2 flex min-h-[32px] flex-none items-center gap-2 rounded-[10px] bg-primary/10 px-2.5 text-left text-[13px] font-semibold text-primary hover:bg-primary/15" onClick={openUpdate}>
          <span className="size-2 flex-none rounded-full bg-primary" aria-hidden="true" />
          <span className="min-w-0 truncate">{`Update to ${newer}`}</span>
        </button>
      )}
      <div className="flex flex-none items-center gap-2 px-2 pt-2">
        <PersonAvatar size={28} />
        <span className="min-w-0 flex-1 truncate font-medium">{name || "You"}</span>
        <ThemeSwitch />
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          aria-current={view === "settings" ? "page" : undefined}
          className={cn("flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground", view === "settings" && "bg-secondary text-foreground")}
          onClick={openSettings}
        >
          <GearIcon />
        </button>
      </div>

      <NewChannel open={creating} onOpenChange={setCreating} />
      <Palette open={switching} onOpenChange={setSwitching} />
    </nav>
  );
}
