import { readOffer, type SharedAgent } from "@/agents/subagents";
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
  | { t: "conv"; sharedId: string; name: string }
  | { t: "rename"; convId: string; name: string }
  | { t: "add"; msg: Msg }
  | { t: "edit"; id: string; text: string }
  | { t: "delete"; id: string }
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
    return convId ? { t: "rename", convId, name } : { t: "conv", sharedId, name };
  }
  if (!convId) return null;
  const from = (agent?: string) => ({ pubkey: e.pubkey, name: nameOf(e.pubkey, ctx.members), ...(agent ? { agent } : {}) });

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
    const agent = str((msg.agent as Record<string, unknown> | undefined)?.name, 80);
    const parent = str(msg.parent, 128);
    return { t: "add", msg: { id, convId, author: "peer", text, ts: e.created_at * 1000, from: from(agent), ...(parent && ctx.msgOf(parent)?.convId === convId ? { parentId: parent } : {}) } };
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
export function postBody(sharedId: string, id: string, text: string, first: boolean, agent?: { id: string; name: string }, parent?: string): string {
  const msg = { ...(first ? { id } : {}), text: text.slice(0, 60_000), ...(agent ? { agent } : {}), ...(parent ? { parent } : {}) };
  return JSON.stringify(first ? { conv: sharedId, msg } : { conv: sharedId, id, msg });
}

/** The link that lets someone join, from the token the relay made. The token sits after `#`, so it stays out of server logs. */
export function inviteLink(host: string, token: string): string {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `cube+${local ? "ws" : "wss"}://${host}/#invite=${token}`;
}
