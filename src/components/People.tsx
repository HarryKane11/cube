import { useState } from "react";
import { inTauri } from "@/agents/runner";
import { Section, Switch } from "@/components/Settings";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";
import { askInvite, joinTeam, leaveTeam, nameOf, removeMember, shareConv, unshareConv } from "@/team";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";
const ROLE = { owner: "Owner", admin: "Admin", member: "Member" } as const;

/** Before joining: paste an invite link, pick the name teammates will see. */
function Join() {
  const myName = useCube((s) => s.name);
  const [link, setLink] = useState("");
  const [name, setName] = useState(myName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const join = () => {
    setBusy(true);
    setError("");
    joinTeam(link, name).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  return (
    <Section title="Join a team">
      <p className="mb-3 text-[13px] text-muted-foreground">
        A team shares channels through a small server it runs itself, the relay. Paste the invite link a teammate gave you. Your cubes keep running on this Mac only: teammates see what is said in shared channels, and nothing they write can start a cube here.
      </p>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); join(); }}>
        <Input autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Invite link" placeholder="cube+wss://relay.example.com/#invite=…" value={link} onChange={(e) => setLink(e.target.value)} className="selectable h-9" data-notranslate />
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Your name in the team" placeholder="Your name in the team" value={name} onChange={(e) => setName(e.target.value)} className="selectable h-9 w-[240px]" />
          <button type="submit" className={primary} disabled={busy || !link.trim() || !name.trim()}>{busy ? "Joining…" : "Join"}</button>
        </div>
      </form>
      {error && <p className="pt-2 text-[13px] text-destructive" role="alert">{error}</p>}
      <p className="pt-3 text-[13px] text-muted-foreground">Setting up a relay for your team takes one command: see relay/README.md.</p>
    </Section>
  );
}

function Members() {
  const team = useCube((s) => s.team);
  const live = useCube((s) => s.teamLive);
  const setLive = useCube((s) => s.setTeamLive);
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const canManage = team.me?.role === "owner" || team.me?.role === "admin";
  if (!team.info) return null;
  return (
    <>
      <Section title="Your team">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3">
          <div className="min-w-[200px] flex-1">
            <div className="font-medium" data-notranslate>{team.info.workspace}</div>
            <div className="text-[13px] text-muted-foreground">
              <span data-notranslate>{team.info.host}</span> · {live.connected ? <span className="font-semibold text-primary">Connected</span> : <span className="font-semibold text-destructive">Not connected</span>}
              {team.me && <> · {ROLE[team.me.role]}</>}
            </div>
          </div>
          {leaving ? (
            <>
              <span className="text-[13px]">Leave, and delete your key for this team?</span>
              <button type="button" className="h-8 rounded-full bg-destructive px-3 text-[13px] font-semibold text-white" onClick={() => void leaveTeam().finally(() => setLeaving(false))}>Leave</button>
              <button type="button" className={pill} onClick={() => setLeaving(false)}>Stay</button>
            </>
          ) : <button type="button" className={pill} onClick={() => setLeaving(true)}>Leave team</button>}
        </div>
        {live.problem && <p className="pt-2 text-[13px] text-destructive" role="alert" data-notranslate>{live.problem}</p>}
        <ul className="flex flex-col">
          {team.members.map((m) => (
            <li key={m.pubkey} className="flex items-center gap-3 border-b py-2.5 last:border-b-0">
              <span className="flex size-8 flex-none items-center justify-center rounded-full bg-secondary font-semibold" aria-hidden="true" data-notranslate>{m.name.charAt(0).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" data-notranslate>{nameOf(m.pubkey, team.members)}{m.pubkey === team.info?.pubkey && <span className="font-normal text-muted-foreground"> (you)</span>}</div>
                <div className="text-[13px] text-muted-foreground">{ROLE[m.role]} · <span className="font-mono text-xs" data-notranslate title={m.pubkey}>{m.pubkey.slice(0, 12)}…</span></div>
              </div>
              {canManage && m.pubkey !== team.info?.pubkey && m.role === "member" && <button type="button" className={pill} onClick={() => void removeMember(m.pubkey).catch((e) => setLive({ problem: String(e) }))}>Remove</button>}
            </li>
          ))}
        </ul>
      </Section>

      {canManage && (
        <Section title="Invite someone">
          <p className="mb-3 text-[13px] text-muted-foreground">An invite link works once and for seven days. Send it to one person, over a channel you trust: whoever opens it first joins as a member and can read every shared channel, from its beginning.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={primary} disabled={!live.connected} onClick={() => { setCopied(false); void askInvite().catch((e) => setLive({ problem: String(e) })); }}>Make an invite link</button>
            {live.invite && (
              <>
                <code className="selectable min-w-0 flex-1 truncate rounded-lg bg-secondary px-2.5 py-1.5 text-xs" data-notranslate>{live.invite}</code>
                <button type="button" className={pill} onClick={() => void navigator.clipboard.writeText(live.invite ?? "").then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
              </>
            )}
          </div>
        </Section>
      )}
    </>
  );
}

/** Which channels the team sees. Sharing starts with what is said next; earlier messages stay on this Mac. */
function Sharing() {
  const convs = useCube((s) => s.convs);
  const connected = useCube((s) => s.teamLive.connected);
  const [error, setError] = useState("");
  const channels = convs.filter((c) => c.kind === "channel");
  return (
    <Section title="Shared channels">
      <p className="mb-1 text-[13px] text-muted-foreground">
        A shared channel goes to everyone in the team, from the moment you share it: your messages and your cubes' answers, with anything that looks like a credential hidden. Earlier messages stay here. In a shared channel your cubes always ask before they run a command, because part of what they read there was written by other people.
      </p>
      <div className={cn(!connected && "opacity-60")}>
        {channels.map((c) => (
          <Switch
            key={c.id}
            label={`#${c.name}`}
            hint={c.shared ? (c.shared.since ? "Shared with your team" : "A teammate's channel") : "Only on this Mac"}
            checked={Boolean(c.shared)}
            onChange={(on) => {
              setError("");
              if (on) void shareConv(c.id).catch((e) => setError(String(e)));
              else unshareConv(c.id);
            }}
          />
        ))}
      </div>
      {error && <p className="pt-2 text-[13px] text-destructive" role="alert" data-notranslate>{error}</p>}
    </Section>
  );
}

/** Settings > People: the team this Cube is in, who else is, and which channels they see. */
export function People() {
  const joined = useCube((s) => Boolean(s.team.info));
  if (!inTauri) return <Section title="People"><p className="text-[13px] text-muted-foreground">Teams are joined from the Cube desktop app, where your key can be kept in the Keychain.</p></Section>;
  return joined ? <><Members /><Sharing /></> : <Join />;
}
