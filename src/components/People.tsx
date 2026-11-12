import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";
import { inTauri } from "@/agents/runner";
import { Section, Switch } from "@/components/Settings";
import { Input } from "@/components/ui/input";
import type { SharedAgent } from "@/agents/subagents";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";
import { adoptAgent, askInvite, joinTeam, leaveTeam, nameOf, openDm, removeMember, setConvOpen, setMemberInvites, shareConv, unshareConv } from "@/team";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";
const ROLE = { owner: "Owner", admin: "Admin", member: "Member" } as const;
const NO_OFFERS: SharedAgent[] = [];

/** An invite link as a QR code, for showing on a screen or dropping into a message. Black on white, so any camera reads it. */
export function InviteQr({ link }: { link: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  }, [link]);
  // The markup is made here from the link's bits, not taken from anywhere.
  return <div className="size-[168px] flex-none overflow-hidden rounded-xl bg-white" role="img" aria-label="Invite link as a QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Sub-agents teammates offer. Bringing one in makes a copy that runs here, on this person's own agent programs. */
function Offers() {
  // The same empty list every time: a new one on each read would make the list draw itself forever.
  const offers = useCube((s) => s.team.agents) ?? NO_OFFERS;
  const mine = useCube((s) => s.subagents);
  const [open, setOpen] = useState<string>();
  if (!offers.length) return null;
  return (
    <Section title="Sub-agents from teammates">
      <p className="mb-1 text-[13px] text-muted-foreground">A teammate made these and offers them to the team. Bringing one in copies its description and instructions; it then runs on your Mac, with your agent programs. Read the instructions first: they will steer an agent that works for you.</p>
      <ul className="flex flex-col">
        {offers.map((a) => {
          const have = mine.some((s) => s.from?.pubkey === a.by && s.name.startsWith(a.name.slice(0, 18)));
          return (
            <li key={a.key} className="border-b py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[180px] flex-1">
                  <div className="font-medium" data-notranslate>{a.name} <span className="font-normal text-muted-foreground">· {a.byName}</span></div>
                  <div className="text-[13px] text-muted-foreground" data-notranslate>{a.role || a.brief}</div>
                </div>
                <button type="button" className={pill} onClick={() => setOpen(open === a.key ? undefined : a.key)}>{open === a.key ? "Hide" : "Read"}</button>
                <button type="button" className={primary} disabled={have} onClick={() => void adoptAgent(a)}>{have ? "Brought in" : "Bring in"}</button>
              </div>
              {open === a.key && (
                <div className="selectable mt-2 rounded-xl bg-secondary/60 p-3 text-[13px]" data-notranslate>
                  <p>{a.brief}</p>
                  {a.instructions && <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{a.instructions}</pre>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

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
  // A link made for one channel is shown in that channel, not here.
  const teamInvite = live.inviteFor ? undefined : live.invite;
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
              {m.pubkey !== team.info?.pubkey && team.features?.includes("channels") && <button type="button" className={pill} onClick={() => void openDm(m.pubkey).catch((e) => setLive({ problem: String(e) }))}>Message</button>}
              {canManage && m.pubkey !== team.info?.pubkey && m.role === "member" && <button type="button" className={pill} onClick={() => void removeMember(m.pubkey).catch((e) => setLive({ problem: String(e) }))}>Remove</button>}
            </li>
          ))}
        </ul>
      </Section>

      {team.me?.role === "owner" && team.features?.includes("channels") && (
        <Section title="Who can invite">
          <Switch
            label="Members can invite new people"
            hint="On: anyone in a channel can make a link that brings a new person into the team and that channel. Off: only you and admins bring new people in. Adding people who are already in the team to a channel is always open to its members."
            checked={team.memberInvites !== false}
            onChange={(on) => void setMemberInvites(on).catch((e) => setLive({ problem: String(e) }))}
          />
        </Section>
      )}

      {canManage && (
        <Section title="Invite someone">
          <p className="mb-3 text-[13px] text-muted-foreground">An invite link works once and for seven days. Send it to one person, over a channel you trust: whoever opens it first joins as a member and can read every channel shared with the whole team, from its beginning.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={primary} disabled={!live.connected} onClick={() => { setCopied(false); void askInvite().catch((e) => setLive({ problem: String(e) })); }}>Make an invite link</button>
            {teamInvite && (
              <>
                <code className="selectable min-w-0 flex-1 truncate rounded-lg bg-secondary px-2.5 py-1.5 text-xs" data-notranslate>{teamInvite}</code>
                <button type="button" className={pill} onClick={() => void navigator.clipboard.writeText(teamInvite ?? "").then(() => setCopied(true))}>{copied ? "Copied" : "Copy link"}</button>
              </>
            )}
          </div>
          {teamInvite && (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <InviteQr link={teamInvite} />
              <p className="min-w-[200px] flex-1 text-[13px] text-muted-foreground">The same link as a QR code. Your teammate pastes the link into Settings &gt; People &gt; Join a team in their Cube. Whoever has the link or a picture of this code can join once, so do not post it where others can see it.</p>
            </div>
          )}
        </Section>
      )}
    </>
  );
}

/** Which channels the team sees. Sharing starts with what is said next; earlier messages stay on this Mac. */
function Sharing() {
  const convs = useCube((s) => s.convs);
  const connected = useCube((s) => s.teamLive.connected);
  const channels = useCube((s) => Boolean(s.team.features?.includes("channels")));
  const [error, setError] = useState("");
  // A conversation with one teammate is not a channel to share or stop sharing.
  const list = convs.filter((c) => c.kind === "channel" && !c.person);
  return (
    <Section title="Shared channels">
      <p className="mb-1 text-[13px] text-muted-foreground">
        Share a channel with the whole team, or only with the people you invite into it. From then on your messages and your cubes' answers go there, with anything that looks like a credential hidden. Earlier messages stay here. In a shared channel your cubes always ask before they run a command, because part of what they read there was written by other people. To invite people, open the channel and press Invite.
      </p>
      <div className={cn(!connected && "opacity-60")}>
        {list.map((c) => (
          <div key={c.id} className="contents">
          <div className="flex flex-wrap items-center gap-2 border-b py-3">
            <div className="min-w-[160px] flex-1">
              <div className="font-medium" data-notranslate>#{c.name}</div>
              <div className="text-[13px] text-muted-foreground">{!c.shared ? "Only on this Mac" : c.shared.private ? "Private: only invited people" : c.shared.since ? "Shared with your team" : "A teammate's channel"}</div>
            </div>
            {c.shared ? (
              <button type="button" className={pill} onClick={() => { setError(""); unshareConv(c.id); }}>Stop sharing</button>
            ) : (
              <>
                <button type="button" className={pill} disabled={!connected} onClick={() => { setError(""); void shareConv(c.id).catch((e) => setError(String(e))); }}>Whole team</button>
                <button type="button" className={pill} disabled={!connected || !channels} title={channels ? undefined : "The team's relay is an earlier version that cannot do this yet."} onClick={() => { setError(""); void shareConv(c.id, true).catch((e) => setError(String(e))); }}>Invited only</button>
              </>
            )}
          </div>
          {c.shared && (
            <div className="pl-6">
              <Switch
                label="Teammates can call my cubes here"
                hint="A teammate who names one of your cubes gets its answer in a thread, and the Router decides whether a message with no name wants an answer. Cubes started this way read and reply; they ask you before changing a file or running a command."
                checked={Boolean(c.shared.open)}
                onChange={(on) => setConvOpen(c.id, on)}
              />
            </div>
          )}
          </div>
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
  return joined ? <><Members /><Sharing /><Offers /></> : <Join />;
}
