import { driveDrop, driveGet, driveMerge, drivePut, driveScan, driveTrash, inTauri, teamAsk, teamRequest, type DriveFail } from "@/agents/runner";
import { agentById } from "@/agents/types";
import { NO_DRIVE, useCube, type Conv } from "@/state/store";
import { copyName, fold, keyOf, plan, readList, retry, validPath, type Local, type Remote, type Step } from "./drive";

/**
 * Keeps each shared channel's folder on this computer and the relay's copy of it the same.
 *
 * Every few seconds, and whenever the relay says a file changed, the folder is looked at, `plan`
 * says what differs, and the steps are carried out one file at a time. The Rust side does the
 * reading, hashing, sending and writing; this side only decides.
 */

const store = () => useCube.getState();
const uid = () => Math.random().toString(36).slice(2, 10);

/** True when the relay keeps files, so a channel's folder can be shared. */
export const hasFiles = () => Boolean(store().team.features?.includes("files"));

/** Has the Stage look at a conversation's folder again, after files came down. Set by whoever starts the team connection. */
let look: ((convId: string) => Promise<void> | void) | undefined;

/** Conversations being brought in step right now, and those that should be looked at again as soon as that is done. */
const running = new Set<string>();
const again = new Set<string>();
/** Shared channels whose file list has been fetched over this connection. */
const listed = new Set<string>();
/** How many looks in a row a file that used to be here has been missing: `conv:key` → count. */
const absent = new Map<string, number>();
/** Versions of instruction files the person said yes to: `conv:key:sha`. */
const accepted = new Set<string>();
/** Files the relay would not take, so they are not sent over and over: `conv:key` → the version refused, and until when. */
const refused = new Map<string, { sha: string; until: number }>();
/** When each file being worked on here was last announced: `conv:key` → time. */
const announced = new Map<string, number>();
/** What the last look found in each folder, for asking about one file between looks. */
const lastLook = new Map<string, Map<string, Local>>();
const timers = new Map<string, number>();
/** When the last announcements went out, to keep them few. */
let recent: number[] = [];

const PER_PASS = 30;
const convOf = (sharedId: string) => store().convs.find((c) => c.shared?.id === sharedId);
const on = (c: Conv | undefined): c is Conv => Boolean(c?.shared?.files && c.dir && store().teamLive.connected && store().team.info && hasFiles());

function note(convId: string, text: string, rel?: string): void {
  const live = store().driveLive[convId] ?? NO_DRIVE;
  if (live.notes.some((n) => n.text === text)) return;
  store().setDriveLive(convId, { notes: [...live.notes, { id: uid(), text, rel }].slice(-6) });
}

export function dismissNote(convId: string, id: string): void {
  const live = store().driveLive[convId] ?? NO_DRIVE;
  store().setDriveLive(convId, { notes: live.notes.filter((n) => n.id !== id) });
}

/** Which of this person's cubes made the file as it is now, if one did. */
function madeHere(convId: string, rel: string): { agent: string; color?: string } | undefined {
  const id = store().authors[`${convId}:${rel}`];
  const agent = id ? agentById(id) : undefined;
  return agent ? { agent: agent.name, color: agent.color } : undefined;
}

/** Tells the channel that a file is being worked on here. At most once every ten seconds per file; nobody keeps it. */
function announce(conv: Conv, key: string, path: string, rel: string): void {
  const id = `${conv.id}:${key}`;
  const now = Date.now();
  if (now - (announced.get(id) ?? 0) < 10_000) return;
  // Well under what the relay allows a connection, however many files a cube is writing.
  recent = recent.filter((t) => now - t < 60_000);
  if (recent.length >= 20) return;
  recent.push(now);
  announced.set(id, now);
  const by = madeHere(conv.id, rel);
  // The id marks any refusal as an answer nobody waits for, so it is dropped instead of shown as a problem with the team.
  void teamAsk({ t: "file.touch", id: "q-touch", conv: conv.shared!.id, path, on: true, ...(by ? { by } : {}) }).catch(() => undefined);
}

/** A teammate's Cube says a file is being worked on, or no longer. Believed for a short while only. */
export function touched(v: Record<string, unknown>): void {
  const conv = convOf(String(v.conv ?? ""));
  if (!conv || !validPath(v.path) || typeof v.pubkey !== "string" || v.pubkey === store().team.info?.pubkey) return;
  const live = store().driveLive[conv.id] ?? NO_DRIVE;
  const next = { ...live.touched };
  const key = keyOf(v.path);
  const by = v.by as { agent?: unknown; color?: unknown } | null | undefined;
  if (v.on === false) delete next[key];
  else next[key] = { pubkey: v.pubkey, until: Date.now() + 25_000, ...(by && typeof by.agent === "string" ? { by: { agent: by.agent.slice(0, 80), ...(typeof by.color === "string" && /^#[0-9a-fA-F]{6}$/.test(by.color) ? { color: by.color } : {}) } } : {}) };
  store().setDriveLive(conv.id, { touched: next });
}

/** Folds a file event (anyone's, ours included) into the channel's folder view and has the folder looked at soon. */
export function fileEvent(sharedId: string, remote: Remote): void {
  store().setDrive(sharedId, fold(store().drive[sharedId] ?? {}, [remote]));
  const conv = convOf(sharedId);
  if (!conv) return;
  // Whoever wrote a new version is done touching it.
  const live = store().driveLive[conv.id];
  const key = keyOf(remote.path);
  if (live?.touched[key]?.pubkey === remote.pubkey) {
    const touchedNow = { ...live.touched };
    delete touchedNow[key];
    store().setDriveLive(conv.id, { touched: touchedNow });
  }
  soon(conv.id, 300);
}

function soon(convId: string, ms: number): void {
  window.clearTimeout(timers.get(convId));
  timers.set(convId, window.setTimeout(() => void syncConv(convId), ms));
}

/** Asks the relay what is in a channel's folder, deleted files included. */
async function list(sharedId: string): Promise<void> {
  const v = await teamRequest({ t: "files.list", conv: sharedId, deleted: true });
  store().setDrive(sharedId, fold(store().drive[sharedId] ?? {}, readList(v.files)));
  listed.add(sharedId);
}

const failOf = (e: unknown): DriveFail => (e && typeof e === "object" && "code" in e ? (e as DriveFail) : { code: "local", message: String(e) });

/** Brings one conversation's folder and the relay's copy in step. Does nothing unless the folder is shared and the relay is reachable. */
export async function syncConv(convId: string): Promise<void> {
  const conv = store().convs.find((c) => c.id === convId);
  if (!inTauri || !on(conv)) return;
  if (running.has(convId)) {
    again.add(convId);
    return;
  }
  running.add(convId);
  const sharedId = conv.shared!.id;
  const me = store().team.info!.pubkey;
  let changedHere = false;
  let relist = false;
  try {
    if (!listed.has(sharedId)) await list(sharedId);
    const local = (await driveScan(conv.dir)).map((f): Local => ({ rel: f.rel, size: f.size, mtime: f.mtime, ...(f.sha ? { sha: f.sha } : {}), ...(f.skip ? { skip: f.skip } : {}) }));
    const here = new Map(local.map((f) => [keyOf(f.rel), f]));
    lastLook.set(convId, here);
    const base = store().driveBase[convId] ?? {};
    for (const key of Object.keys(base)) {
      const id = `${convId}:${key}`;
      if (here.has(key)) absent.delete(id);
      else absent.set(id, (absent.get(id) ?? 0) + 1);
    }
    const now = Date.now();
    const steps = plan({ local, remote: store().drive[sharedId] ?? {}, base, me, now, gone: (key) => (absent.get(`${convId}:${key}`) ?? 0) >= 2, accepted: (key, sha) => accepted.has(`${convId}:${key}:${sha}`) });
    const held: { key: string; rel: string; remote: Remote }[] = [];
    let moving = 0;
    let done = 0;
    const view = () => store().drive[sharedId] ?? {};
    const settle = (key: string, sha: string | undefined) => store().setDriveBase(convId, key, sha);
    const failed = (step: Step & { rel: string }, sha: string, e: unknown) => {
      const f = failOf(e);
      const how = retry(f.code);
      if (how === "now") relist = true;
      else {
        refused.set(`${convId}:${step.key}`, { sha, until: how === "never" ? Infinity : Date.now() + 60_000 });
        if (how === "never") note(convId, `${step.rel} is not shared: ${f.message}`, step.rel);
      }
    };

    for (const step of steps) {
      if (step.do === "settle") {
        settle(step.key, step.sha || undefined);
        continue;
      }
      if (step.do === "hold") {
        held.push({ key: step.key, rel: step.rel, remote: step.remote });
        continue;
      }
      if (step.do === "wait") {
        moving++;
        announce(conv, step.key, step.path, step.rel);
        continue;
      }
      if (done >= PER_PASS) {
        moving++;
        again.add(convId);
        continue;
      }
      const mine = here.get(step.key)?.sha ?? "";
      const stop = refused.get(`${convId}:${step.key}`);
      if (stop && stop.sha === (step.do === "download" ? step.remote.sha : mine) && stop.until > Date.now()) continue;
      done++;
      try {
        if (step.do === "upload") {
          const by = madeHere(convId, step.rel);
          const put = await drivePut(sharedId, conv.dir, step.rel, step.path, step.base, by);
          settle(step.key, put.sha);
          store().setDrive(sharedId, fold(view(), [{ path: step.path, sha: put.sha, size: put.size, seq: put.seq, pubkey: me, at: Date.now(), ...(by ? { by } : {}) }]));
        } else if (step.do === "download") {
          const got = await driveGet(sharedId, conv.dir, step.rel, step.remote.sha, step.remote.size, step.expect);
          if (got.state === "written") {
            settle(step.key, step.remote.sha);
            changedHere = true;
          } else again.add(convId);
        } else if (step.do === "merge") {
          const merged = await driveMerge(sharedId, conv.dir, step.rel, step.base, step.remote.sha, step.remote.size, copyName(step.rel, store().team.me?.name || store().name || "mine"));
          // Either way this copy now starts from their version: what differs from it goes up as the next one.
          settle(step.key, step.remote.sha);
          changedHere = true;
          again.add(convId);
          if (merged.outcome === "copied" && merged.copy) note(convId, `Two people changed ${step.rel} at once. Your version is kept as ${merged.copy}.`, merged.copy);
        } else if (step.do === "drop") {
          const seq = await driveDrop(sharedId, conv.dir, step.rel, step.path, step.base);
          settle(step.key, undefined);
          store().setDrive(sharedId, fold(view(), [{ path: step.path, sha: "", size: 0, seq, pubkey: me, at: Date.now(), deleted: true }]));
        } else if (step.do === "remove") {
          if (await driveTrash(conv.dir, step.rel, step.expect)) {
            settle(step.key, undefined);
            changedHere = true;
          } else again.add(convId);
        }
      } catch (e) {
        failed(step, step.do === "download" ? step.remote.sha : mine, e);
      }
    }

    // Unsaved edits on the Stage are work in progress too.
    for (const [key, f] of here) {
      if (store().dirty[`${conv.dir}/${f.rel}`]) announce(conv, key, f.rel.normalize("NFC"), f.rel);
    }
    const live = store().driveLive[convId] ?? NO_DRIVE;
    const fresh = Object.fromEntries(Object.entries(live.touched).filter(([, t]) => t.until > Date.now()));
    const skipped = local.filter((f) => f.skip).map((f) => ({ rel: f.rel, why: f.skip! }));
    store().setDriveLive(convId, { held, skipped, moving, ...(Object.keys(fresh).length !== Object.keys(live.touched).length ? { touched: fresh } : {}) });
  } catch (e) {
    // The folder may not be there yet, or the relay not reachable: the next look tries again.
    const f = failOf(e);
    if (f.code !== "offline" && f.code !== "local") note(convId, f.message);
  } finally {
    running.delete(convId);
    if (changedHere) void look?.(convId);
    if (relist) {
      listed.delete(sharedId);
      again.add(convId);
    }
    if (again.delete(convId)) soon(convId, 600);
  }
}

/** Starts keeping shared folders in step. `rescan` has the Stage look at a folder again after files came down. */
export function startDrive(rescan?: (convId: string) => Promise<void> | void): void {
  look = rescan;
  if (!inTauri) return;
  window.setInterval(() => {
    for (const c of store().convs) if (on(c)) void syncConv(c.id);
  }, 5000);
  // A new connection may be to a relay that moved on while this Cube was away: ask again what is there.
  useCube.subscribe((now, before) => {
    if (now.teamLive.connected === before.teamLive.connected) return;
    listed.clear();
    if (now.teamLive.connected) for (const c of now.convs) if (c.shared?.files) soon(c.id, 1200);
  });
}

/** Makes a conversation's folder the channel's shared folder, or stops that. What is already on the relay stays there. */
export function setConvFiles(convId: string, files: boolean): void {
  const conv = store().convs.find((c) => c.id === convId);
  if (!conv?.shared) return;
  store().setConvShared(convId, { ...conv.shared, files });
  if (files) soon(convId, 50);
  else store().setDriveLive(convId, { ...NO_DRIVE });
}

/** The person looked at an instruction file a teammate changed and wants it: it comes down on the next look. */
export function acceptHeld(convId: string, key: string, sha: string): void {
  accepted.add(`${convId}:${key}:${sha}`);
  soon(convId, 50);
}

/** A file's versions, newest first, deletions included. */
export async function fileHistory(convId: string, path: string): Promise<Remote[]> {
  const conv = store().convs.find((c) => c.id === convId);
  if (!conv?.shared) return [];
  const v = await teamRequest({ t: "files.history", conv: conv.shared.id, path });
  return readList(v.versions).map((r) => ({ ...r, path: r.path || path }));
}

/**
 * Puts an earlier version of a file back in the folder. From there it is an ordinary change:
 * the next look sends it up as the newest version, so everyone gets it and the one it replaced
 * stays in the history.
 */
export async function restoreVersion(convId: string, rel: string, version: Remote): Promise<void> {
  const conv = store().convs.find((c) => c.id === convId);
  if (!conv?.shared || version.deleted) return;
  const key = keyOf(rel);
  const got = await driveGet(conv.shared.id, conv.dir, lastLook.get(convId)?.get(key)?.rel ?? rel, version.sha, version.size, lastLook.get(convId)?.get(key)?.sha);
  if (got.state !== "written") throw new Error("That file was just changed here. Try again in a moment.");
  void look?.(convId);
  soon(convId, 50);
}

/** Brings a deleted file back: its last version before the delete. */
export async function restoreDeleted(convId: string, path: string): Promise<void> {
  const last = (await fileHistory(convId, path)).find((v) => !v.deleted);
  if (!last) throw new Error("The relay has no earlier version of that file.");
  await restoreVersion(convId, path, last);
}

/** Forgets what this module remembers about a team, when the person leaves it. */
export function forgetDrive(): void {
  listed.clear();
  absent.clear();
  accepted.clear();
  refused.clear();
  for (const id of Object.keys(store().drive)) store().setDrive(id, undefined);
}
