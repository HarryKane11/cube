import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCube } from "@/state/store";
import { joinTeam } from "@/team";

/**
 * An invite that was clicked somewhere outside Cube. A link alone joins nothing: the person
 * sees which server it leads to, picks the name teammates will see, and says yes.
 */
export function JoinFromLink() {
  const pending = useCube((s) => s.teamLive.pending);
  const team = useCube((s) => s.team.info);
  const myName = useCube((s) => s.name);
  const setLive = useCube((s) => s.setTeamLive);
  const openSettings = useCube((s) => s.openSettings);
  const [name, setName] = useState(myName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!pending) return null;
  const host = pending.replace(/^cube\+wss?:\/\//, "").replace(/\/#invite=.*$/, "");
  const close = () => { setError(""); setLive({ pending: undefined }); };
  const join = () => {
    setBusy(true);
    setError("");
    joinTeam(pending, name).then(close).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{team ? "You are already in a team" : "Join this team?"}</DialogTitle>
          <DialogDescription>
            {team
              ? "This Cube is in one team at a time. To accept this invite, leave your team first in Settings > People, then open the link again."
              : "You opened an invite link. Joining lets you see the channels shared with you there; your cubes keep running on this Mac only."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-[13px]"><span className="text-muted-foreground">Server</span> <code className="selectable rounded bg-secondary px-1.5 py-0.5 text-xs" data-notranslate>{host}</code></p>
        {team ? (
          <DialogFooter>
            <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={close}>Close</button>
            <button type="button" className="h-8 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground" onClick={() => { close(); openSettings(); }}>Open Settings</button>
          </DialogFooter>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); join(); }}>
            <Input autoFocus aria-label="Your name in the team" placeholder="Your name in the team" value={name} onChange={(e) => setName(e.target.value)} className="selectable h-9" />
            {error && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
            <DialogFooter>
              <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={close}>Not now</button>
              <button type="submit" className="h-8 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-40" disabled={busy || !name.trim()}>{busy ? "Joining…" : "Join"}</button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
