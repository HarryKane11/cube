import { useMemo, useState } from "react";
import { Face } from "@/components/bits";
import { ClockIcon, CloseIcon, PeopleIcon } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { NO_DRIVE, useCube, type Conv } from "@/state/store";
import { acceptHeld, dismissNote, fileHistory, keyOf, madeBy, nameOf, restoreDeleted, restoreVersion, setConvFiles, when, type Remote } from "@/team";

/** What is known about one file of a shared folder, for showing beside it. */
export interface About {
  /** The file's latest version on the relay. */
  remote: Remote;
  /** True when the file here is that version. */
  synced: boolean;
  /** True when someone else made that version. */
  other: boolean;
  /** "Sean's Builder · 9:28 PM" */
  label: string;
  /** Who is working on the file right now, when a teammate's Cube says so. */
  touching?: string;
}

/** The shared folder of a conversation, as the Stage needs it. `on` is false when the folder is not shared. */
export function useFolder(conv: Conv) {
  const view = useCube((s) => (conv.shared ? s.drive[conv.shared.id] : undefined));
  const base = useCube((s) => s.driveBase[conv.id]);
  const live = useCube((s) => s.driveLive[conv.id]) ?? NO_DRIVE;
  const me = useCube((s) => s.team.info?.pubkey ?? "");
  const members = useCube((s) => s.team.members);
  const lang = useCube((s) => s.settings.lang);
  const can = useCube((s) => Boolean(s.team.info && s.team.features?.includes("files")));
  const on = Boolean(conv.shared?.files && can);
  const ask = Boolean(conv.shared && can && conv.shared.files === undefined);
  return useMemo(() => {
    const about = (rel: string): About | undefined => {
      if (!on) return undefined;
      const key = keyOf(rel);
      const remote = view?.[key];
      const t = live.touched[key];
      const touching = t && t.until > Date.now() ? madeBy(t, me, members, lang) : undefined;
      if (!remote || remote.deleted) return touching ? { remote: { path: rel, sha: "", size: 0, seq: 0, pubkey: t!.pubkey, at: 0 }, synced: false, other: false, label: "", touching } : undefined;
      return { remote, synced: base?.[key] === remote.sha, other: remote.pubkey !== me, label: `${madeBy(remote, me, members, lang)} · ${when(remote.at, Date.now(), lang)}`, touching };
    };
    const deleted = on ? Object.values(view ?? {}).filter((r) => r.deleted).sort((a, b) => b.at - a.at).slice(0, 30) : [];
    return { on, ask, live, me, members, lang, about, deleted };
  }, [on, ask, view, base, live, me, members, lang]);
}

/** Beside a file's name in the list: a teammate at work on it, or whose version it is. */
export function FolderMark({ about }: { about?: About }) {
  if (!about) return null;
  if (about.touching) return <span className="size-2 flex-none animate-pulse rounded-full bg-[#0a84ff]" title={`${about.touching} is working on this`} aria-label={`${about.touching} is working on this`} />;
  if (!about.synced || !about.other) return null;
  return <span className="flex-none" title={about.label} data-notranslate><Face pubkey={about.remote.pubkey} name={about.label} size={14} /></span>;
}

const pill = "h-7 flex-none rounded-full bg-secondary px-2.5 text-xs font-semibold disabled:opacity-40";
const primary = "h-7 flex-none rounded-full bg-primary px-2.5 text-xs font-semibold text-primary-foreground disabled:opacity-40";
const card = "flex flex-none items-start gap-3 rounded-[18px] border px-3.5 py-2.5 text-[13px]";

/**
 * What the person has to know or decide about the shared folder, above the file in view: whether
 * to share it at all (asked once, for a channel that was shared before folders could be), an
 * instruction file a teammate changed, and things that happened to their files.
 */
export function FolderNotices({ conv, count }: { conv: Conv; count: number }) {
  const folder = useFolder(conv);
  if (folder.ask) {
    return (
      <div className={card}>
        <PeopleIcon width={16} height={16} className="mt-0.5 flex-none text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Work on this channel's files together?</p>
          <p className="text-muted-foreground">
            {count > 0 ? "The files in this folder go to everyone in the channel, and what they and their cubes make shows up here." : "What the people in this channel and their cubes make shows up here, and what you make reaches them."}
            {" "}Files that look like keys or passwords stay on this Mac.
          </p>
        </div>
        <button type="button" className={primary} onClick={() => setConvFiles(conv.id, true)}>Share the folder</button>
        <button type="button" className={pill} onClick={() => setConvFiles(conv.id, false)}>Not now</button>
      </div>
    );
  }
  if (!folder.on || (folder.live.held.length === 0 && folder.live.notes.length === 0)) return null;
  return (
    <div className="flex flex-none flex-col gap-2">
      {folder.live.held.map((h) => (
        <div key={h.key} className={card}>
          <Face pubkey={h.remote.pubkey} name={nameOf(h.remote.pubkey, folder.members)} size={20} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" data-notranslate title={h.rel}>{h.rel}</p>
            <p className="text-muted-foreground"><span>Changed by</span> <span data-notranslate>{madeBy(h.remote, folder.me, folder.members, folder.lang)}</span><span>. Your cubes read this file as their instructions, so the new version waits for your OK.</span></p>
          </div>
          <button type="button" className={primary} onClick={() => acceptHeld(conv.id, h.key, h.remote.sha)}>Use their version</button>
        </div>
      ))}
      {folder.live.notes.map((n) => (
        <div key={n.id} className={cn(card, "items-center")}>
          <p className="min-w-0 flex-1 text-muted-foreground">{n.text}</p>
          <button type="button" aria-label="Dismiss" title="Dismiss" className="flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => dismissNote(conv.id, n.id)}>
            <CloseIcon width={11} height={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

const WHY: Record<string, string> = { big: "over 10 MB", secret: "looks like a key or a password", name: "has a name that cannot be shared" };

/** Under the file list: that the folder is shared and whether it is up to date, what stays on this Mac, and deleted files to bring back. */
export function FolderFoot({ conv }: { conv: Conv }) {
  const folder = useFolder(conv);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  if (!folder.on) return null;
  const { skipped, moving } = folder.live;
  const link = "rounded-md px-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";
  return (
    <div className="flex flex-none items-center gap-1.5 border-t px-2.5 py-1.5 text-xs text-muted-foreground">
      <span className="flex-none" title="Shared folder"><PeopleIcon width={12} height={12} /></span>
      {/* The list is narrow: the words give way to what can be pressed. */}
      <span className="min-w-0 flex-1 truncate">{moving > 0 ? "Syncing…" : skipped.length === 0 && folder.deleted.length === 0 ? "Shared folder" : ""}</span>
      {skipped.length > 0 && (
        <Popover>
          <PopoverTrigger className={link}>{skipped.length === 1 ? "1 not shared" : `${skipped.length} not shared`}</PopoverTrigger>
          <PopoverContent side="top" align="end" className="max-h-64 w-72 overflow-auto text-[13px]">
            <p className="font-semibold">These stay on this Mac</p>
            <ul className="flex flex-col gap-1">
              {skipped.map((f) => (
                <li key={f.rel} className="flex flex-col">
                  <span className="truncate" data-notranslate title={f.rel}>{f.rel}</span>
                  <span className="text-xs text-muted-foreground">{WHY[f.why] ?? f.why}</span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      {folder.deleted.length > 0 && (
        <Popover onOpenChange={() => setError("")}>
          <PopoverTrigger className={link}>Deleted</PopoverTrigger>
          <PopoverContent side="top" align="end" className="max-h-72 w-80 overflow-auto text-[13px]">
            <p className="font-semibold">Deleted files</p>
            <ul className="flex flex-col">
              {folder.deleted.map((r) => (
                <li key={r.path} className="flex items-center gap-2 border-b py-1.5 last:border-b-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" data-notranslate title={r.path}>{r.path}</span>
                    <span className="block truncate text-xs text-muted-foreground" data-notranslate>{madeBy(r, folder.me, folder.members, folder.lang)} · {when(r.at, Date.now(), folder.lang)}</span>
                  </span>
                  <button
                    type="button"
                    className={pill}
                    disabled={busy === r.path}
                    onClick={() => {
                      setBusy(r.path);
                      setError("");
                      restoreDeleted(conv.id, r.path).catch((e) => setError(String(e instanceof Error ? e.message : e))).finally(() => setBusy(""));
                    }}
                  >
                    Bring back
                  </button>
                </li>
              ))}
            </ul>
            {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** A file's versions: who made each and when. An earlier one can be put back; the one it replaces stays in the list. */
export function FileHistory({ conv, rel, about }: { conv: Conv; rel: string; about?: About }) {
  const me = useCube((s) => s.team.info?.pubkey ?? "");
  const members = useCube((s) => s.team.members);
  const lang = useCube((s) => s.settings.lang);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Remote[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(0);
  if (!about || !about.remote.seq) return null;
  const load = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setError("");
    setVersions(undefined);
    fileHistory(conv.id, about.remote.path).then(setVersions).catch((e) => setError(String(e)));
  };
  const now = Date.now();
  return (
    <Popover open={open} onOpenChange={load}>
      <PopoverTrigger className="flex h-7 flex-none items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground" title="Who changed this file, and when">
        <ClockIcon width={13} height={13} /> History
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="max-h-80 w-80 overflow-auto text-[13px]">
        <p className="font-semibold">Versions of this file</p>
        {!versions && !error && <p className="text-muted-foreground">Asking the relay…</p>}
        {versions && (
          <ul className="flex flex-col">
            {versions.map((v, i) => (
              <li key={v.seq} className="flex items-center gap-2 border-b py-1.5 last:border-b-0">
                <Face pubkey={v.pubkey} name={nameOf(v.pubkey, members)} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate" data-notranslate>{madeBy(v, me, members, lang)}</span>
                  <span className="block truncate text-xs text-muted-foreground"><span data-notranslate>{when(v.at, now, lang)}</span>{v.deleted ? <> · <span>deleted</span></> : i === 0 ? <> · <span>current</span></> : null}</span>
                </span>
                {!v.deleted && i > 0 && v.sha !== versions[0].sha && (
                  <button
                    type="button"
                    className={pill}
                    disabled={busy !== 0}
                    onClick={() => {
                      setBusy(v.seq);
                      setError("");
                      restoreVersion(conv.id, rel, v).then(() => setOpen(false)).catch((e) => setError(String(e instanceof Error ? e.message : e))).finally(() => setBusy(0));
                    }}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
            {versions.length === 0 && <li className="py-1.5 text-muted-foreground">No versions yet.</li>}
          </ul>
        )}
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
