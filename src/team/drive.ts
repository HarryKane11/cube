import type { TeamEvent, TeamMember } from "./events";
import { nameOf } from "./events";

/**
 * A channel's shared folder, as far as it can be decided without the app around it: what the
 * relay says is in the folder, what is on this computer, and what has to happen for the two to
 * agree. The folder is one folder for everyone in the channel: adding, changing and deleting a
 * file all travel, every version is kept on the relay, and nothing anyone wrote is lost when
 * two people change the same file at once.
 */

/** The latest version of one file in a channel's folder, as the relay tells it. */
export interface Remote {
  path: string;
  /** Empty when the latest thing that happened to the file is that it was deleted. */
  sha: string;
  size: number;
  seq: number;
  /** Whose key signed this version. */
  pubkey: string;
  /** When, in milliseconds. */
  at: number;
  /** The cube that made it, when one did. */
  by?: { agent: string; color?: string };
  deleted?: boolean;
}

/** A file in this computer's copy of the folder. `skip` says why it is never shared. */
export interface Local {
  rel: string;
  size: number;
  mtime: number;
  sha?: string;
  skip?: "name" | "secret" | "big";
}

/** One thing to do so that this computer and the relay agree about a file. */
export type Step =
  /** This side has something the relay lacks or has an older version of. `base` is the version it started from, "" for none. */
  | { do: "upload"; key: string; rel: string; path: string; base: string }
  /** The relay has a newer version and this copy is untouched (or absent): take it. */
  | { do: "download"; key: string; rel: string; remote: Remote; expect?: string }
  /** Both sides changed. Merge text; otherwise keep both. */
  | { do: "merge"; key: string; rel: string; remote: Remote; base?: string }
  /** Deleted here, unchanged there: tell the relay. */
  | { do: "drop"; key: string; rel: string; path: string; base: string }
  /** Deleted there, unchanged here: this copy goes to the Trash. */
  | { do: "remove"; key: string; rel: string; expect: string }
  /** Both sides agree: remember that. `sha` is "" when both agree the file is gone. */
  | { do: "settle"; key: string; sha: string }
  /** A teammate changed a file that cubes read as their instructions. It waits for the person's yes. */
  | { do: "hold"; key: string; rel: string; remote: Remote }
  /** Changed here a moment ago and probably still being written: looked at again shortly. */
  | { do: "wait"; key: string; rel: string; path: string };

/** How long a file must have been left alone before it is sent, so a half-written one is not. */
export const QUIET_MS = 2500;

/** One file under two spellings is one file: names are compared in one Unicode form and without regard to case. */
export const keyOf = (path: string) => path.normalize("NFC").toLowerCase();

/** A path as it may be written in a shared folder. The relay and the Rust side apply the same rule. */
export function validPath(path: unknown): path is string {
  if (typeof path !== "string" || !path || new TextEncoder().encode(path).length > 300) return false;
  const parts = path.split("/");
  if (parts.length > 8) return false;
  // eslint-disable-next-line no-control-regex
  return parts.every((p) => p && !p.startsWith(".") && !p.includes("..") && !p.startsWith("~$") && !["node_modules", "target", "__pycache__"].includes(p) && !/[\\\u0000-\u001f\u007f]/.test(p) && !p.endsWith(" ") && !p.endsWith("."));
}

const INSTRUCTIONS = new Set(["claude.md", "claude.local.md", "agents.md", "agents.override.md", "gemini.md", "soul.md"]);

/**
 * Files the agent programs read by themselves and take as instructions. One of these arriving
 * from someone else would steer this person's cubes without anyone having asked them to, so it
 * is the one kind of file that waits for a yes.
 */
export const isInstructions = (path: string) => INSTRUCTIONS.has(keyOf(path).split("/").pop() ?? "");

const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

function readBy(v: unknown): Remote["by"] {
  const by = v as { agent?: unknown; color?: unknown } | null | undefined;
  if (!by || typeof by.agent !== "string" || !by.agent.trim()) return undefined;
  const color = typeof by.color === "string" && /^#[0-9a-fA-F]{6}$/.test(by.color) ? by.color : undefined;
  return { agent: by.agent.slice(0, 80), ...(color ? { color } : {}) };
}

/** What a `file.put` or `file.drop` event says, or null when it is not one or is malformed. Our own count too: they are how this side learns its upload went through. */
export function readFileEvent(e: TeamEvent): { sharedId: string; remote: Remote } | null {
  if (e.redacted || (e.kind !== "file.put" && e.kind !== "file.drop")) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(e.body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body.conv !== "string" || !body.conv || !validPath(body.path)) return null;
  const base = { path: body.path.normalize("NFC"), seq: e.seq, pubkey: e.pubkey, at: e.created_at * 1000, ...(readBy(body.by) ? { by: readBy(body.by) } : {}) };
  if (e.kind === "file.drop") return { sharedId: body.conv, remote: { ...base, sha: "", size: 0, deleted: true } };
  if (!isSha(body.sha) || typeof body.size !== "number" || body.size < 0) return null;
  return { sharedId: body.conv, remote: { ...base, sha: body.sha, size: body.size } };
}

/** The entries of a `files` answer (and of a file's history), newest state per path. */
export function readList(list: unknown): Remote[] {
  if (!Array.isArray(list)) return [];
  const out: Remote[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw.seq !== "number" || typeof raw.pubkey !== "string") continue;
    const deleted = raw.deleted === true || raw.sha === null;
    if (!deleted && (!isSha(raw.sha) || typeof raw.size !== "number")) continue;
    const by = readBy(raw.by);
    out.push({ path: typeof raw.path === "string" ? raw.path.normalize("NFC") : "", sha: deleted ? "" : (raw.sha as string), size: deleted ? 0 : (raw.size as number), seq: raw.seq, pubkey: raw.pubkey, at: (typeof raw.created_at === "number" ? raw.created_at : 0) * 1000, ...(by ? { by } : {}), ...(deleted ? { deleted: true } : {}) });
  }
  return out;
}

/** Folds what was just learned about files into the folder's view. A later version (a higher seq) replaces an earlier one, never the other way. */
export function fold(view: Record<string, Remote>, news: Remote[]): Record<string, Remote> {
  let next = view;
  for (const r of news) {
    if (!validPath(r.path)) continue;
    const key = keyOf(r.path);
    const have = next[key];
    if (have && have.seq >= r.seq) continue;
    if (next === view) next = { ...view };
    next[key] = r;
  }
  return next;
}

interface PlanInput {
  local: Local[];
  remote: Record<string, Remote>;
  /** The version each file here was when it last agreed with the relay: key → sha. */
  base: Record<string, string>;
  me: string;
  now: number;
  /** True once a file has been absent for more than one look, so that a save that replaces a file is not taken for a delete. */
  gone(key: string): boolean;
  /** True when the person said yes to this version of an instruction file. */
  accepted(key: string, sha: string): boolean;
}

/**
 * What has to happen for this computer and the relay to agree, file by file. Three things are
 * known about each: what is here (L), what the relay has (R), and what this copy was when the
 * two last agreed (B). Whichever side still equals B has not changed, so the other side's
 * version wins; when neither does, both changed.
 */
export function plan({ local, remote, base, me, now, gone, accepted }: PlanInput): Step[] {
  const steps: Step[] = [];
  const here = new Map<string, Local>();
  for (const f of local) if (validPath(f.rel)) here.set(keyOf(f.rel), f);
  const guarded = (r: Remote, key: string) => isInstructions(r.path) && r.pubkey !== me && !accepted(key, r.sha);

  for (const key of new Set([...here.keys(), ...Object.keys(remote), ...Object.keys(base)])) {
    const l = here.get(key);
    const r = remote[key];
    const b = base[key];
    const live = r && !r.deleted ? r : undefined;
    if (l?.skip) continue;
    // A file that could not be read this time is looked at again next time.
    if (l && !l.sha) continue;

    if (!l) {
      if (!live) {
        if (b !== undefined) steps.push({ do: "settle", key, sha: "" });
      } else if (b === live.sha) {
        if (gone(key)) steps.push({ do: "drop", key, rel: live.path, path: live.path, base: live.sha });
      } else if (guarded(live, key)) steps.push({ do: "hold", key, rel: live.path, remote: live });
      else steps.push({ do: "download", key, rel: live.path, remote: live });
      continue;
    }
    const sha = l.sha!;
    const path = live?.path ?? r?.path ?? l.rel.normalize("NFC");
    const fresh = now - l.mtime < QUIET_MS;
    if (!live) {
      // Deleted there and untouched here: it goes. Anything else here is new, or newer than the delete.
      if (r?.deleted && b === sha) steps.push({ do: "remove", key, rel: l.rel, expect: sha });
      else steps.push(fresh ? { do: "wait", key, rel: l.rel, path } : { do: "upload", key, rel: l.rel, path, base: "" });
    } else if (sha === live.sha) {
      if (b !== sha) steps.push({ do: "settle", key, sha });
    } else if (b === live.sha) {
      steps.push(fresh ? { do: "wait", key, rel: l.rel, path } : { do: "upload", key, rel: l.rel, path, base: live.sha });
    } else if (guarded(live, key)) {
      steps.push({ do: "hold", key, rel: l.rel, remote: live });
    } else if (b === sha) {
      steps.push({ do: "download", key, rel: l.rel, remote: live, expect: sha });
    } else {
      steps.push(fresh ? { do: "wait", key, rel: l.rel, path } : { do: "merge", key, rel: l.rel, remote: live, ...(b ? { base: b } : {}) });
    }
  }
  return steps;
}

/** The name this side's file is kept under when two versions could not be put together: `plan (Kane).md`. */
export function copyName(rel: string, who: string): string {
  const name = who.replace(/[\\/\u0000-\u001f\u007f]/g, "").trim().replace(/[. ]+$/, "").slice(0, 30) || "copy";
  const slash = rel.lastIndexOf("/");
  const dot = rel.lastIndexOf(".");
  return dot > slash + 1 ? `${rel.slice(0, dot)} (${name})${rel.slice(dot)}` : `${rel} (${name})`;
}

/** Who a version is from, for showing: a teammate, a teammate's cube, or one of this person's own. */
export function madeBy(r: Pick<Remote, "pubkey" | "by">, me: string, members: TeamMember[], lang: string): string {
  const owner = r.pubkey === me ? (lang === "ko" ? "나" : "You") : nameOf(r.pubkey, members);
  if (!r.by) return owner;
  if (r.pubkey === me) return r.by.agent;
  return lang === "ko" ? `${owner}의 ${r.by.agent}` : `${owner}'s ${r.by.agent}`;
}

/** A time for a file's version: today's as the hour, earlier ones with the day. */
export function when(at: number, now: number, lang: string): string {
  const d = new Date(at);
  const locale = lang === "ko" ? "ko-KR" : "en-US";
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) : d.toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** What the relay's refusal of a file means for trying again: `never` until the file changes, `later` soon, `now` after looking at the relay's list again. */
export function retry(code: string): "never" | "later" | "now" {
  if (code === "stale" || code === "unchanged" || code === "not_found") return "now";
  if (code === "too_big" || code === "quota" || code === "bad_body" || code === "secret" || code === "archived") return "never";
  return "later";
}
