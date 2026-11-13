/**
 * Where the next chat begun on Home works: in a folder of its own that Cube makes for it, or in a
 * folder of the person's own that they opened as a workspace, the way a project folder is opened
 * in a coding agent. The choice is kept, so the next chat starts in the same place.
 */
import { useState } from "react";
import { Check, ChevronDown, Folder, FolderPlus } from "lucide-react";
import { openWorkspace } from "@/agents/orchestrator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

/** A path as the person would say it: their home folder is `~`. */
export const shortPath = (dir: string): string => dir.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

export function WorkspacePicker() {
  const workspaces = useCube((s) => s.workspaces);
  const chosen = useCube((s) => s.settings.workspace);
  const setSetting = useCube((s) => s.setSetting);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A folder that was closed or is gone is not where a chat can start.
  const now = workspaces.find((w) => w.dir === chosen && !w.missing);
  const row = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-40";
  const pick = (dir: string | undefined) => { setSetting("workspace", dir); setOpen(false); };
  const add = () => {
    setError("");
    setBusy(true);
    // The system's own folder dialog: the folder is chosen there, never typed here.
    void openWorkspace().then((problem) => { if (problem) setError(problem); else setOpen(false); }).finally(() => setBusy(false));
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setError(""); }}>
      <PopoverTrigger
        aria-label={now ? `The chat works in the folder ${now.name}. Change` : "The chat gets a folder of its own. Change"}
        className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Folder size={14} strokeWidth={2} className="flex-none" />
        {now ? <span className="min-w-0 truncate" data-notranslate>{now.name}</span> : <span className="min-w-0 truncate">A folder of its own</span>}
        <ChevronDown size={12} strokeWidth={2} className="flex-none" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 gap-0.5 p-1">
        <button type="button" className={row} aria-pressed={!now} onClick={() => pick(undefined)}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] font-semibold">A folder of its own</span>
            <span className="text-xs text-muted-foreground">Cube makes one for the chat and keeps checkpoints you can go back to.</span>
          </span>
          {!now && <Check size={14} strokeWidth={2.25} className="flex-none" />}
        </button>
        {workspaces.map((w) => (
          <button type="button" key={w.dir} className={row} aria-pressed={now?.dir === w.dir} disabled={w.missing} onClick={() => pick(w.dir)}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-semibold" data-notranslate>{w.name}</span>
              <span className="truncate text-xs text-muted-foreground" title={w.dir}>
                {w.missing ? "Not found" : <span data-notranslate>{shortPath(w.dir)}</span>}
              </span>
            </span>
            {now?.dir === w.dir && <Check size={14} strokeWidth={2.25} className="flex-none" />}
          </button>
        ))}
        <div className="-mx-1 my-1 h-px bg-border" />
        <button type="button" className={cn(row, "text-[13px] font-medium")} disabled={busy} onClick={add}>
          <FolderPlus size={14} strokeWidth={2} className="flex-none text-muted-foreground" />
          Open a folder…
        </button>
        {error && <p className="px-2 pb-1 text-xs text-destructive" role="alert">{error}</p>}
        {now && !now.git && <p className="px-2 pb-1 text-xs text-muted-foreground">This folder is not a git repository: what a cube changes there cannot be taken back.</p>}
      </PopoverContent>
    </Popover>
  );
}
