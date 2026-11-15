/**
 * Whose memory a conversation's words go to.
 *
 * What the person says to their cubes on their own (a direct message with a cube, a chat, the
 * conversation with the whole team) goes to their personal memory, in the knowledge folder. It
 * stays on this computer, and a cube never sees it where other people read what it says.
 *
 * A channel keeps a memory of its own from the moment it is started, in `cube-memory/` inside its
 * folder. When the channel is shared, its folder goes to everyone in it, and with it that memory:
 * every member's Cube reads it and adds to it.
 */
import type { Conv, Msg } from "@/state/store";

/** The folder, inside a channel's folder, where what the channel has learned is kept. */
export const CHANNEL_MEMORY = "cube-memory";

/** Whether other people read this conversation: a channel shared with the team, or a direct one with a teammate. */
export const othersRead = (c: Pick<Conv, "shared" | "person">): boolean => Boolean(c.shared || c.person);

/** Whether what is learned here belongs to the conversation (and goes to everyone in it) rather than to the person's own memory. */
export const keepsOwnMemory = (c: Pick<Conv, "kind" | "chat" | "cube" | "shared" | "person">): boolean => othersRead(c) || (c.kind === "channel" && !c.chat && !c.cube);

export const channelMemoryDir = (c: Pick<Conv, "dir">): string => `${c.dir}/${CHANNEL_MEMORY}`;

/**
 * A line this person's side said: they, their cubes, or someone in Slack their cubes answered.
 * A teammate's line is learned from by the teammate's own Cube, so no note is written twice.
 */
export const saidHere = (m: Pick<Msg, "from" | "slack">): boolean => !m.from || Boolean(m.slack);

/** Session keys (`${convId}:…`) that belong to a conversation. */
export const ofConv = (key: string, convId: string): boolean => key.startsWith(`${convId}:`);

/**
 * The notes an agent is told in a conversation. Where the conversation keeps its own memory,
 * only what was learned there, and what the person wrote for the role by hand: a note an agent
 * proposed in a personal chat stays in personal chats.
 */
export function notesFor<N extends { convId?: string; self?: boolean }>(notes: N[], conv: Pick<Conv, "id" | "kind" | "chat" | "cube" | "shared" | "person">, byConv: (id: string) => Pick<Conv, "kind" | "chat" | "cube" | "shared" | "person"> | undefined): N[] {
  if (!keepsOwnMemory(conv)) {
    // A personal chat is told what was learned anywhere but in a conversation that keeps its own memory.
    return notes.filter((n) => !n.convId || n.convId === conv.id || !keepsOwnMemory(byConv(n.convId) ?? { kind: "dm" }));
  }
  return notes.filter((n) => n.convId === conv.id || (!n.convId && !n.self));
}

/**
 * Which member's Cube dreams over a shared channel's memory on a given day: one a day, a
 * different one from day to day, so that two Cubes do not rewrite the same notes at once. Every
 * member's Cube works out the same answer without asking anyone.
 */
export function dreamerOf(members: string[], convId: string, day: string): string | undefined {
  const score = (key: string) => {
    // FNV-1a: small, and the same everywhere.
    let h = 0x811c9dc5;
    for (const ch of `${key}:${convId}:${day}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return h;
  };
  return [...new Set(members)].sort((a, b) => score(a) - score(b) || (a < b ? -1 : 1))[0];
}
