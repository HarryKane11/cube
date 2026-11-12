import { readOffer, type SharedAgent } from "@/agents/subagents";
import { validAvatar } from "@/lib/avatar";
import type { Msg } from "@/state/store";

/** What can be decided about team events without the app around it: what a teammate's event changes here, and what of ours goes out. */

export interface TeamMember {
  pubkey: string;
  name: string;
  role: "owner" | "admin" | "member";
  joined_at?: number;
}

/** An event as the Rust side hands it over: already checked to be signed by `pubkey` for this workspace. */
export interface TeamEvent {
  seq: number;
  id: string;
  pubkey: string;
  created_at: number;
  kind: string;
  body: string;
  redacted?: boolean;
}

export type Change =
  | { t: "conv"; sharedId: string; name: string; private: boolean }
  /** Someone was added to a channel, or left it or was taken out. `member` is their key. */
  | { t: "joined"; sharedId: string; member: string }
  | { t: "parted"; sharedId: string; member: string }
  | { t: "rename"; convId: string; name: string }
  | { t: "add"; msg: Msg }
  | { t: "edit"; id: string; text: string }
  | { t: "delete"; id: string }
  /** A teammate set their picture, or took it away. */
  | { t: "avatar"; pubkey: string; avatar?: string }
  | { t: "offer"; agent: SharedAgent }
  | { t: "withdraw"; key: string };

interface Ctx {
  /** This person's own key. */
  me: string;
  members: TeamMember[];
  /** The local conversation for a shared channel id, if there is one. */
  convOf(sharedId: string): string | undefined;
  msgOf(id: string): Msg | undefined;
}

const MAX_TEXT = 64_000;
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** A display name: the member's, with the start of the key added when two members share it. */
export function nameOf(pubkey: string, members: TeamMember[]): string {
  const m = members.find((x) => x.pubkey === pubkey);
  if (!m) return `Someone (${pubkey.slice(0, 6)})`;
  return members.some((x) => x.pubkey !== pubkey && x.name === m.name) ? `${m.name} (${pubkey.slice(0, 4)})` : m.name;
}

/** Remote images are not loaded for a teammate's text: an image becomes a plain link. */
export const withoutImages = (text: string) => text.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => `[${alt || "image"}](${url})`);

/**
 * What a teammate's event changes here, or null when it changes nothing: our own event coming
 * back, something we already have, something malformed, or something its sender had no right to.
 * The relay enforces the same rules; a client that trusted it blindly would be at its mercy.
 */
export function applyEvent(e: TeamEvent, ctx: Ctx): Change | null {
  if (e.redacted || e.pubkey === ctx.me) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(e.body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  // A teammate offers one of their sub-agents, or takes the offer back. It is theirs alone: the key that signed it is part of what it is called.
  if (e.kind === "agent.put") {
    const agent = readOffer(body, e.pubkey, nameOf(e.pubkey, ctx.members));
    return agent ? { t: "offer", agent } : null;
  }
  if (e.kind === "profile.put") {
    if (body.avatar === "") return { t: "avatar", pubkey: e.pubkey };
    return validAvatar(body.avatar) ? { t: "avatar", pubkey: e.pubkey, avatar: body.avatar } : null;
  }
  if (e.kind === "agent.drop") {
    const id = str(body.id, 128);
    return id ? { t: "withdraw", key: `${e.pubkey}:${id}` } : null;
  }
  const sharedId = str(body.conv, 128);
  if (!sharedId) return null;
  const convId = ctx.convOf(sharedId);

  if (e.kind === "conv.put") {
    const name = str(body.name);
    if (!name) return null;
    return convId ? { t: "rename", convId, name } : { t: "conv", sharedId, name, private: body.private === true };
  }
  // Who may add or remove whom is the relay's to enforce: it only delivers these to people who can read the channel.
  if (e.kind === "conv.add" || e.kind === "conv.remove") {
    const member = str(body.member, 128);
    if (!member || !/^[0-9a-f]{64}$/.test(member)) return null;
    return { t: e.kind === "conv.add" ? "joined" : "parted", sharedId, member };
  }
  if (!convId) return null;
  const from = (agent?: string, color?: string) => ({ pubkey: e.pubkey, name: nameOf(e.pubkey, ctx.members), ...(agent ? { agent } : {}), ...(agent && color ? { color } : {}) });

  if (e.kind === "msg.post" || e.kind === "msg.edit") {
    const msg = (body.msg ?? {}) as Record<string, unknown>;
    const id = str(e.kind === "msg.post" ? msg.id : body.id, 128);
    const text = typeof msg.text === "string" ? withoutImages(msg.text.slice(0, MAX_TEXT)) : "";
    if (!id || !text.trim()) return null;
    const have = ctx.msgOf(id);
    if (have) {
      // Only the key that posted a message may change it, and never one of our own.
      if (e.kind !== "msg.edit" || have.from?.pubkey !== e.pubkey || have.convId !== convId) return null;
      return have.text === text ? null : { t: "edit", id, text };
    }
    const wrote = msg.agent as Record<string, unknown> | undefined;
    const agent = str(wrote?.name, 80);
    const color = typeof wrote?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(wrote.color) ? wrote.color : undefined;
    const parent = str(msg.parent, 128);
    return { t: "add", msg: { id, convId, author: "peer", text, ts: e.created_at * 1000, from: from(agent, color), ...(parent && ctx.msgOf(parent)?.convId === convId ? { parentId: parent } : {}) } };
  }
  if (e.kind === "msg.delete") {
    const id = str(body.id, 128);
    const have = id ? ctx.msgOf(id) : undefined;
    // A teammate deletes their own message; an owner or admin may delete any teammate's. Nobody else's event removes ours.
    if (!have || !have.from || have.convId !== convId) return null;
    const role = ctx.members.find((m) => m.pubkey === e.pubkey)?.role;
    return have.from.pubkey === e.pubkey || role === "owner" || role === "admin" ? { t: "delete", id: have.id } : null;
  }
  return null;
}

/** True for a message of ours that belongs on the relay: said in the channel after it was shared, finished, and not a side note. */
export function shareable(m: Msg, since: number): boolean {
  return !m.from && !m.streaming && !m.aside && !m.error && m.ts >= since && Boolean(m.text.trim());
}

/** The body of the event that posts or edits one of our messages. */
export function postBody(sharedId: string, id: string, text: string, first: boolean, agent?: { id: string; name: string; color?: string }, parent?: string): string {
  const msg = { ...(first ? { id } : {}), text: text.slice(0, 60_000), ...(agent ? { agent } : {}), ...(parent ? { parent } : {}) };
  return JSON.stringify(first ? { conv: sharedId, msg } : { conv: sharedId, id, msg });
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * The link that lets someone join, from the token the relay made. The token sits after `#`, so it
 * stays out of server logs. A relay that serves the invite page gets a web address people can
 * click in a chat or a mail; the page hands the invite to Cube. Otherwise it is the form that is
 * pasted into Cube.
 */
export function inviteLink(host: string, token: string, page = false): string {
  const local = LOCAL_HOST.test(host);
  if (page) return `${local ? "http" : "https"}://${host}/join#invite=${token}`;
  return `cube+${local ? "ws" : "wss"}://${host}/#invite=${token}`;
}

/**
 * An invite in the one form Cube joins with (`cube+wss://host/#invite=token`), whichever way it
 * arrived: pasted as it is, as the web address of the invite page, or as the `cube://` link that
 * page opens. Undefined for anything else.
 */
export function normalizeInvite(text: string): string | undefined {
  const link = text.trim();
  const m = /^(cube\+wss|cube\+ws|cube|https|http):\/\/([A-Za-z0-9.\-[\]:]+)\/(join)?#invite=([A-Za-z0-9_-]{20,200})$/.exec(link);
  if (!m) return undefined;
  const [, scheme, host, page, token] = m;
  // The web form only exists as the invite page; the others have nothing before the `#`.
  if ((scheme === "https" || scheme === "http") !== Boolean(page)) return undefined;
  const local = LOCAL_HOST.test(host);
  // Without encryption only to this computer itself, however the link was written.
  if ((scheme === "http" || scheme === "cube+ws") && !local) return undefined;
  return `cube+${local ? "ws" : "wss"}://${host.toLowerCase()}/#invite=${token}`;
}

/** The relay id of the direct conversation between two people. Both sides arrive at the same one. */
export function dmId(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `dm.${x.slice(0, 20)}.${y.slice(0, 20)}`;
}

/**
 * The teammate a direct conversation is with, read from its id: the member whose key matches
 * the half that is not ours. Undefined for an id that is not one between this person and a member.
 */
export function dmPeer(sharedId: string, me: string, members: TeamMember[]): TeamMember | undefined {
  const [tag, x, y, more] = sharedId.split(".");
  if (tag !== "dm" || !x || !y || more !== undefined || !me) return undefined;
  const other = me.startsWith(x) ? y : me.startsWith(y) ? x : undefined;
  if (!other || other.length !== 20) return undefined;
  const found = members.filter((m) => m.pubkey !== me && m.pubkey.startsWith(other));
  return found.length === 1 ? found[0] : undefined;
}

/** The word a person is tagged by: their name as teammates see it, without the spaces. */
export const tagOf = (name: string) => name.replace(/\s+/g, "");

/** The members a text tags with `@Name`. A name that is the start of a longer word is not a tag. */
export function taggedIn(text: string, members: TeamMember[]): string[] {
  const lower = text.toLowerCase();
  return members
    .filter((m) => {
      const tag = `@${tagOf(m.name).toLowerCase()}`;
      if (tag.length < 2) return false;
      for (let at = lower.indexOf(tag); at >= 0; at = lower.indexOf(tag, at + 1)) {
        const before = at === 0 ? " " : lower[at - 1];
        const after = lower[at + tag.length] ?? " ";
        if (!/[\p{L}\p{N}@]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
      }
      return false;
    })
    .map((m) => m.pubkey);
}
