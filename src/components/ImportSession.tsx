import { useEffect, useMemo, useState } from "react";
import { importedContext } from "@/agents/context";
import { createImportedChat } from "@/agents/orchestrator";
import { sessionRead, sessionsList, type SessionInfo } from "@/agents/runner";
import { BrandMark } from "@/components/bits";
import { SearchIcon } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const PROGRAM: Record<SessionInfo["program"], string> = { claude: "Claude Code", codex: "Codex" };

const folderOf = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;
const whenOf = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Brings the context of a session from Claude or Codex into Cube: the person picks one, Cube
 * reads what was said in it, and a chat starts with that as its cubes' background. The session
 * itself is only read.
 */
export function ImportSession({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [list, setList] = useState<SessionInfo[]>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setList(undefined);
    setError("");
    setQuery("");
    void sessionsList()
      .then((found) => { if (alive) setList(found); })
      .catch((e) => { if (alive) { setError(String(e)); setList([]); } });
    return () => { alive = false; };
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }, [list, query]);

  const take = async (s: SessionInfo) => {
    if (busy) return;
    setBusy(s.id);
    setError("");
    try {
      const context = importedContext(await sessionRead(s.path));
      if (!context) return setError("Nothing was said in that session yet.");
      await createImportedChat({ program: PROGRAM[s.program], title: s.title, cwd: s.cwd, at: Date.now(), context });
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Bring in a session</DialogTitle>
          <DialogDescription>Pick a session from Claude or Codex. Cube reads what was said in it and starts a chat with that as background. The session is not changed, and your cubes work in the chat's own folder.</DialogDescription>
        </DialogHeader>
        <label className="flex h-9 items-center gap-2 rounded-xl bg-muted px-2.5">
          <SearchIcon width={15} height={15} className="flex-none text-muted-foreground" />
          <input aria-label="Find a session" placeholder="Find a session" value={query} onChange={(e) => setQuery(e.target.value)} autoCapitalize="off" spellCheck={false} className="selectable h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
        </label>
        <ul className="-mx-1 flex max-h-[46vh] min-h-[120px] flex-col overflow-auto" aria-label="Sessions">
          {list === undefined && <li className="px-2 py-3 text-[13px] text-muted-foreground">Looking for sessions…</li>}
          {list !== undefined && shown.length === 0 && <li className="px-2 py-3 text-[13px] text-muted-foreground">{list.length ? "Nothing matches." : "No sessions found."}</li>}
          {shown.map((s) => (
            <li key={`${s.program}:${s.id}`}>
              <button type="button" disabled={Boolean(busy)} className={cn("flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-accent disabled:opacity-60", busy === s.id && "bg-accent")} onClick={() => void take(s)}>
                <BrandMark kind={s.program} className="size-4 flex-none" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" data-notranslate>{s.title}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate" title={s.cwd} data-notranslate>{folderOf(s.cwd)} · {whenOf(s.updated)}</span>
                    {s.live && <span className="flex-none rounded-full bg-primary/10 px-1.5 font-semibold text-primary">Running now</span>}
                  </span>
                </span>
                {busy === s.id && <span className="flex-none text-xs text-muted-foreground">Reading…</span>}
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
        <p className="text-xs text-muted-foreground">What was said goes to the agent programs your cubes run on. Keys and passwords that Cube recognizes are hidden first.</p>
      </DialogContent>
    </Dialog>
  );
}
