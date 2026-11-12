import { useEffect, useState } from "react";
import { createChannel } from "@/agents/orchestrator";
import { AGENTS, agentById } from "@/agents/types";
import { PersonAvatar } from "@/components/bits";
import { BookIcon, GearIcon, HashIcon, HomeIcon, InboxIcon, PanelIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { useInboxCount } from "@/components/Inbox";
import { Palette } from "@/components/Palette";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Cube, CubeStill } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useCube, type Conv } from "@/state/store";

const WORD: Record<string, string> = { thinking: "thinking", working: "working", needs: "needs you", stuck: "stuck", done: "done" };

function Unread({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-bold leading-[18px] text-primary-foreground tabular-nums">{n}</span>;
}

function Row({ conv, rail }: { conv: Conv; rail?: boolean }) {
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
        aria-label={`${agent ? conv.name : `#${conv.name}`}${unread ? `, ${unread} unread` : ""}`}
        title={agent ? conv.name : `#${conv.name}`}
        className={cn("relative flex size-10 items-center justify-center rounded-xl", active ? "bg-secondary" : "hover:bg-accent")}
        onClick={() => setActive(conv.id)}
      >
        {agent ? <Cube color={agent.color} status={status} size={30} /> : <HashIcon className="text-muted-foreground" width={17} height={17} />}
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
        agent ? "min-h-[40px]" : "min-h-[32px]",
        active ? "bg-secondary font-semibold" : "hover:bg-accent",
        unread > 0 && "font-semibold",
      )}
      onClick={() => setActive(conv.id)}
    >
      {agent ? <Cube color={agent.color} status={status} size={32} /> : <HashIcon className="mx-1.5 text-muted-foreground" width={16} height={16} />}
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
  const openInbox = useCube((s) => s.openInbox);
  const openLibrary = useCube((s) => s.openLibrary);
  const waiting = useInboxCount();
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const wide = useCube((s) => s.settings.sidebar);
  const setSetting = useCube((s) => s.setSetting);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitching((v) => !v);
      } else if (e.key.toLowerCase() === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const s = useCube.getState();
        s.setSetting("sidebar", !s.settings.sidebar);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const label = "px-2 pb-1 pt-4 text-xs font-semibold text-muted-foreground";
  const railButton = "flex size-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground";
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
        {convs.filter((c) => c.kind === "channel").map((c) => <Row conv={c} rail key={c.id} />)}
        {convs.filter((c) => c.kind === "dm").map((c) => <Row conv={c} rail key={c.id} />)}
        <button type="button" aria-label="Settings" title="Settings" aria-current={view === "settings" ? "page" : undefined} className={cn(railButton, "mt-auto flex-none", view === "settings" && "bg-secondary text-foreground")} onClick={openSettings}>
          <GearIcon />
        </button>
        <Palette open={switching} onOpenChange={setSwitching} />
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
        {convs.filter((c) => c.kind === "channel").map((c) => <Row conv={c} key={c.id} />)}
      </div>

      <div className={label}>Direct messages</div>
      <div className="flex flex-col gap-0.5">
        {convs.filter((c) => c.kind === "dm").map((c) => <Row conv={c} key={c.id} />)}
      </div>

      <div className="mt-auto flex items-center gap-2 px-2 pt-3">
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
