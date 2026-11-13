import { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { KEPT_CHANNELS, createChannel, deleteChannel } from "@/agents/orchestrator";
import { inTauri } from "@/agents/runner";
import { ChannelPeople } from "@/components/ChannelPeople";
import { RightClick } from "@/components/ui/context-menu";
import { SHORTCUTS, commandFor } from "@/lib/shortcuts";
import { nameOf, openDm, renameChannel } from "@/team";
import { AGENTS, agentById } from "@/agents/types";
import { Face, PersonAvatar } from "@/components/bits";
import { BookIcon, GearIcon, HashIcon, HomeIcon, InboxIcon, PanelIcon, PlusIcon, SearchIcon, LockIcon } from "@/components/icons";
import { useInboxCount } from "@/components/Inbox";
import { Palette } from "@/components/Palette";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Cube, CubeStill } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useCube, type Conv } from "@/state/store";
import { showUpdate, useUpdate } from "@/update";

const WORD: Record<string, string> = { thinking: "thinking", working: "working", needs: "needs you", stuck: "stuck", done: "done" };

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
    : conv.person
      ? [unread > 0 && { label: "Mark as read", onSelect: () => useCube.setState((s) => ({ unread: { ...s.unread, [conv.id]: 0 } })) }, folder, "-" as const, { label: "Delete conversation…", danger: true, onSelect: () => setDialog("delete") }]
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

function RenameChannel({ conv, onClose }: { conv: Conv; onClose: () => void }) {
  const [name, setName] = useState(conv.name);
  const [error, setError] = useState("");
  const save = () => void renameChannel(conv.id, name).then(onClose).catch((e) => setError(String(e)));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename channel</DialogTitle>
          <DialogDescription>{conv.shared ? "The new name shows for everyone who has this channel." : "Only the name changes. The folder and what was said stay as they are."}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Input autoFocus aria-label="Channel name" value={name} onChange={(e) => setName(e.target.value)} className="selectable h-9" />
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
          <DialogTitle>{conv.person ? "Delete this conversation?" : "Delete this channel?"}</DialogTitle>
          <DialogDescription>
            {conv.shared
              ? "You leave the channel and it is removed from this Cube. The team keeps what was said in it. Its folder on this Mac goes to the Trash, from where you can take the files back."
              : "Its messages are removed from Cube and cannot be brought back. Its folder goes to the Trash, from where you can take the files back."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-[13px]"><span className="font-semibold" data-notranslate>{conv.person ? conv.name : `#${conv.name}`}</span><span className="text-muted-foreground" data-notranslate> · {count}</span> <span className="text-muted-foreground">messages</span></p>
        {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
        <DialogFooter>
          <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={onClose}>{error ? "Close" : "Keep"}</button>
          {!error && <button type="button" className="h-8 rounded-full bg-destructive px-3 text-[13px] font-semibold text-white disabled:opacity-40" disabled={busy} onClick={remove}>{conv.person ? "Delete conversation" : "Delete channel"}</button>}
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
  const agent = conv.kind === "dm" ? agentById(conv.members[0]) : undefined;
  const live = useCube((s) => (agent ? s.live[agent.id] : undefined));
  const status = live?.status ?? "idle";
  if (rail) {
    // The narrow sidebar: one icon per conversation, with a dot when something waits there.
    return (
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${agent || conv.person ? conv.name : `#${conv.name}`}${unread ? `, ${unread} unread` : ""}`}
        title={agent || conv.person ? conv.name : `#${conv.name}`}
        className={cn("relative flex size-10 items-center justify-center rounded-xl", active ? "bg-secondary" : "hover:bg-accent")}
        onClick={() => setActive(conv.id)}
      >
        {agent ? <Cube color={agent.color} status={status} size={30} /> : conv.person ? <Initial name={conv.name} size={28} pubkey={conv.person.pubkey} /> : <HashIcon className="text-muted-foreground" width={17} height={17} />}
        {(unread > 0 || status === "needs") && <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-[10px] px-2 text-left",
        agent || conv.person ? "min-h-[40px]" : "min-h-[32px]",
        active ? "bg-secondary font-semibold" : "hover:bg-accent",
        unread > 0 && "font-semibold",
      )}
      onClick={() => setActive(conv.id)}
    >
      {agent ? <Cube color={agent.color} status={status} size={32} /> : conv.person ? <Initial name={conv.name} size={28} pubkey={conv.person.pubkey} /> : conv.shared?.private ? <LockIcon className="mx-1.5 text-muted-foreground" width={16} height={16} /> : <HashIcon className="mx-1.5 text-muted-foreground" width={16} height={16} />}
      <span className="min-w-0 flex-1 truncate">{conv.name}</span>
      {!agent && busy && <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-label="Agents are working here" />}
      {agent && WORD[status] && !unread && (
        <span className={cn("text-xs font-normal text-muted-foreground", status === "needs" && "font-semibold text-primary", status === "stuck" && "font-semibold text-destructive")}>
          {WORD[status]}
        </span>
      )}
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
      const order = [...s.convs.filter((c) => c.kind === "channel" && !c.person), ...s.convs.filter((c) => c.person), ...s.convs.filter((c) => c.kind === "dm")];
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
  const railButton = "flex size-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground";
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
    return (
      <nav className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto pb-3 pt-9 [scrollbar-width:none]" aria-label="Workspace">
        <button type="button" aria-label="Show the sidebar" title="Show the sidebar (⌘B)" className={railButton} onClick={() => setSetting("sidebar", true)}>
          <PanelIcon width={17} height={17} />
        </button>
        <button type="button" aria-label="Search" title="Search (⌘K)" className={railButton} onClick={() => setSwitching(true)}>
          <SearchIcon width={17} height={17} />
        </button>
        <button type="button" aria-label="Home" title="Home" aria-current={view === "home" ? "page" : undefined} className={cn(railButton, view === "home" && "bg-secondary text-foreground")} onClick={goHome}>
          <HomeIcon width={17} height={17} />
        </button>
        <button type="button" aria-label={`Inbox${waiting ? `, ${waiting} waiting` : ""}`} title="Inbox" aria-current={view === "inbox" ? "page" : undefined} className={cn(railButton, "relative", view === "inbox" && "bg-secondary text-foreground")} onClick={openInbox}>
          <InboxIcon width={17} height={17} />
          {waiting > 0 && <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}
        </button>
        <button type="button" aria-label="Library" title="Library" aria-current={view === "library" ? "page" : undefined} className={cn(railButton, view === "library" && "bg-secondary text-foreground")} onClick={openLibrary}>
          <BookIcon width={17} height={17} />
        </button>
        <span className="my-1 h-px w-6 flex-none bg-border" />
        {convs.filter((c) => c.kind === "channel" && !c.person).map((c) => <Row conv={c} rail key={c.id} />)}
        {convs.filter((c) => c.person).map((c) => <Row conv={c} rail key={c.id} />)}
        {convs.filter((c) => c.kind === "dm").map((c) => <Row conv={c} rail key={c.id} />)}
        <button type="button" aria-label={newer ? "Settings, an update is ready" : "Settings"} title={newer ? `Update to ${newer}` : "Settings"} aria-current={view === "settings" ? "page" : undefined} className={cn(railButton, "relative mt-auto flex-none", view === "settings" && "bg-secondary text-foreground")} onClick={newer ? openUpdate : openSettings}>
          <GearIcon />
          {newer && <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />}
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
        <img src="/cube-icon.png" width={38} height={38} alt="" className="pointer-events-none" />
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[17px] font-bold leading-tight tracking-[-0.02em]">Cube</div>
          <div className="text-xs text-muted-foreground">Local workspace</div>
        </div>
        <button type="button" aria-label="Hide the sidebar" title="Hide the sidebar (⌘B)" className="flex size-7 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setSetting("sidebar", false)}>
          <PanelIcon width={15} height={15} />
        </button>
      </div>

      <button type="button" className="flex h-8 items-center gap-2 rounded-[10px] bg-secondary/70 px-2.5 text-[13px] text-muted-foreground hover:bg-secondary" onClick={() => setSwitching(true)}>
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
        onClick={openLibrary}
      >
        <BookIcon className="mx-1.5 text-muted-foreground" width={16} height={16} /> Library
      </button>

      <div className="flex items-center justify-between">
        <div className={label}>Channels</div>
        <button type="button" aria-label="New channel" title="New channel" className="mt-3 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setCreating(true)}>
          <PlusIcon width={15} height={15} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {convs.filter((c) => c.kind === "channel" && !c.person).map((c) => <Row conv={c} key={c.id} />)}
      </div>

      <div className="flex items-center justify-between">
        <div className={label}>Direct messages</div>
        {inTeam && (
          <button type="button" aria-label="New message to a teammate" title="New message to a teammate" className="mt-3 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setDmOpen(true)}>
            <PlusIcon width={15} height={15} />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        {convs.filter((c) => c.person).map((c) => <Row conv={c} key={c.id} />)}
        {convs.filter((c) => c.kind === "dm").map((c) => <Row conv={c} key={c.id} />)}
      </div>
      {extras}

      {newer && (
        <button type="button" className="mt-auto flex min-h-[32px] items-center gap-2 rounded-[10px] bg-primary/10 px-2.5 text-left text-[13px] font-semibold text-primary hover:bg-primary/15" onClick={openUpdate}>
          <span className="size-2 flex-none rounded-full bg-primary" aria-hidden="true" />
          <span className="min-w-0 truncate">{`Update to ${newer}`}</span>
        </button>
      )}
      <div className={cn("flex items-center gap-2 px-2 pt-3", !newer && "mt-auto")}>
        <PersonAvatar size={28} />
        <span className="min-w-0 flex-1 truncate font-medium">{name || "You"}</span>
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
