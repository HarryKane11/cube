import { useEffect, useState } from "react";
import { LockIcon, PeopleIcon } from "@/components/icons";
import { InviteLinkBox } from "@/components/People";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useCube, type Conv } from "@/state/store";
import { addToConv, askInvite, hasChannels, hasFiles, nameOf, refreshMembers, removeFromConv, setConvFiles, shareConv } from "@/team";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";
const NO_ONE: string[] = [];

/**
 * Who a channel is shared with, from the channel itself: share it with the whole team or with
 * invited people only, add teammates, and make a link that brings a new person straight into it.
 */
export function ChannelPeople({ conv, open, onOpenChange }: { conv: Conv; open: boolean; onOpenChange: (open: boolean) => void }) {
  const team = useCube((s) => s.team);
  const live = useCube((s) => s.teamLive);
  const openSettings = useCube((s) => s.openSettings);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const shared = conv.shared;
  const inChannel = (shared && live.convMembers?.[shared.id]) || NO_ONE;
  const me = team.info?.pubkey ?? "";
  const staff = team.me?.role === "owner" || team.me?.role === "admin";
  const channels = hasChannels();
  const canLink = staff || (channels && team.memberInvites !== false);
  const link = shared && live.inviteFor === shared.id ? live.invite : undefined;

  useEffect(() => {
    if (open && shared) refreshMembers(shared.id);
    if (open) setError("");
  }, [open, shared?.id]);

  const run = (job: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    job().catch((e) => setError(String(e))).finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {shared?.private ? <LockIcon width={16} height={16} /> : <PeopleIcon width={16} height={16} />}
            <span data-notranslate>#{conv.name}</span>
          </DialogTitle>
          <DialogDescription>
            {!team.info ? "Join a team first. Then this channel can be shared with it, or with the people you invite."
              : !shared ? "This channel is only on this Mac. Share it to work in it with other people. What was said so far stays here."
                : shared.private ? "Only the people invited into this channel see it. Whoever runs the team's relay can still read what is stored there."
                  : "Everyone in the team sees this channel."}
          </DialogDescription>
        </DialogHeader>

        {!team.info && <div><button type="button" className={primary} onClick={() => { onOpenChange(false); openSettings(); }}>Open Settings</button></div>}

        {team.info && !shared && (
          <div className="flex flex-col gap-2">
            <button type="button" className="flex items-start gap-3 rounded-xl border p-3 text-left hover:bg-accent disabled:opacity-40" disabled={busy || !live.connected} onClick={() => run(() => shareConv(conv.id, false))}>
              <PeopleIcon width={18} height={18} className="mt-0.5 flex-none" />
              <span><span className="block font-semibold">Whole team</span><span className="block text-[13px] text-muted-foreground">Every member of the team sees it and can write in it.{hasFiles() ? " The files in its folder are shared with them too." : ""}</span></span>
            </button>
            <button type="button" className="flex items-start gap-3 rounded-xl border p-3 text-left hover:bg-accent disabled:opacity-40" disabled={busy || !live.connected || !channels} onClick={() => run(() => shareConv(conv.id, true))}>
              <LockIcon width={18} height={18} className="mt-0.5 flex-none" />
              <span><span className="block font-semibold">Invited people only</span><span className="block text-[13px] text-muted-foreground">{channels ? "Only you and the people you add see it. This cannot be changed later." : "The team's relay is an earlier version that cannot do this yet."}{channels && hasFiles() ? " The files in its folder are shared with them too." : ""}</span></span>
            </button>
            {!live.connected && <p className="text-[13px] text-muted-foreground">Not connected to the team right now.</p>}
          </div>
        )}

        {team.info && shared && (
          <div className="flex flex-col gap-4">
            {shared.private && (
              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-muted-foreground">In this channel</h3>
                <ul className="flex flex-col">
                  {inChannel.map((key) => (
                    <li key={key} className="flex items-center gap-2 border-b py-1.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate" data-notranslate>{nameOf(key, team.members)}{key === me && <span className="text-muted-foreground"> (you)</span>}</span>
                      <button type="button" className={pill} disabled={busy} onClick={() => run(async () => { await removeFromConv(conv.id, key); if (key === me) onOpenChange(false); })}>{key === me ? "Leave" : "Remove"}</button>
                    </li>
                  ))}
                  {inChannel.length === 0 && <li className="py-1.5 text-[13px] text-muted-foreground">Asking the relay who is here…</li>}
                </ul>
              </section>
            )}

            {!shared.private && (
              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-muted-foreground">In this channel: the whole team</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {team.members.map((m) => (
                    <li key={m.pubkey} className="rounded-full bg-secondary px-2.5 py-0.5 text-[13px]" data-notranslate>{nameOf(m.pubkey, team.members)}{m.pubkey === me ? " (you)" : ""}</li>
                  ))}
                </ul>
              </section>
            )}

            {shared.private && team.members.some((m) => !inChannel.includes(m.pubkey)) && (
              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-muted-foreground">Add teammates</h3>
                <ul className="flex flex-col">
                  {team.members.filter((m) => !inChannel.includes(m.pubkey)).map((m) => (
                    <li key={m.pubkey} className="flex items-center gap-2 border-b py-1.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate" data-notranslate>{nameOf(m.pubkey, team.members)}</span>
                      <button type="button" className={pill} disabled={busy || !live.connected} onClick={() => run(() => addToConv(conv.id, m.pubkey))}>Add</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {hasFiles() && (
              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-muted-foreground">Files</h3>
                <div className="flex items-center gap-3">
                  <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                    {shared.files
                      ? "This channel's folder is shared: files added, changed or deleted here reach everyone in the channel, and every version is kept. Files that look like keys or passwords stay on this Mac."
                      : "This channel's folder is only on this Mac. Share it and everyone in the channel works on the same files."}
                  </p>
                  <button type="button" className={shared.files ? pill : primary} onClick={() => setConvFiles(conv.id, !shared.files)}>{shared.files ? "Stop sharing files" : "Share the folder"}</button>
                </div>
              </section>
            )}

            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-muted-foreground">Someone new</h3>
              {canLink ? (
                <>
                  <p className="mb-2 text-[13px] text-muted-foreground">A link works once and for seven days. Whoever opens it first joins the team and lands in this channel, and also sees the channels shared with the whole team. Send it to one person, over a channel you trust.</p>
                  <InviteLinkBox link={link} disabled={!live.connected} subject={`#${conv.name}`} onMake={(uses) => { setError(""); void askInvite(conv.id, uses).catch((e) => setError(String(e))); }} />
                </>
              ) : (
                <p className="text-[13px] text-muted-foreground">{channels ? "In this team only the owner and admins bring new people in. Ask one of them for a link." : "The team's relay is an earlier version: only the owner and admins can make invite links, in Settings > People."}</p>
              )}
            </section>
          </div>
        )}

        {(error || (open && live.problem)) && <p className={cn("text-[13px] text-destructive")} role="alert" data-notranslate>{error || live.problem}</p>}
      </DialogContent>
    </Dialog>
  );
}
