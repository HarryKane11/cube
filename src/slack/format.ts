/** Text on its way between Slack's own markup and the markdown the cubes write. */

/**
 * A Slack message as plain text for a cube to read: the mention of the bot taken out, other
 * mentions and links written out, Slack's escapes undone.
 */
export function fromSlack(text: string, botId: string): string {
  return text
    .replace(new RegExp(`<@${botId}>`, "g"), "")
    .replace(/<@([A-Z0-9]+)>/g, "@$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * A cube's markdown as Slack shows it: bold, links and headings in Slack's form, and the three
 * characters Slack reserves escaped. Code is left exactly as it is.
 */
export function toSlack(markdown: string): string {
  const pieces = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return pieces
    .map((piece, i) => {
      // Odd pieces are code: only the reserved characters change.
      const safe = piece.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (i % 2 === 1) return safe;
      return safe
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>")
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
        .replace(/^(\s*)[-*]\s+/gm, "$1• ")
        .replace(/^&gt;\s?/gm, ">");
    })
    .join("")
    .trim();
}

/** The id a Slack message has in Cube: the same message always gets the same one. */
export const slackId = (channel: string, ts: string) => `sl-${channel}-${ts}`;

/**
 * The message in Cube that a Slack thread hangs under: the request that started the team's part
 * in it. Undefined for a thread the team was never called into, whose replies are not for it.
 */
export function threadRoot<M extends { id: string; parentId?: string; slack?: { channel: string; ts: string } }>(messages: M[], channel: string, thread: string): M | undefined {
  if (!thread) return undefined;
  return messages.find((m) => !m.parentId && m.slack?.channel === channel && m.slack.ts === thread);
}

/** What the Slack app has to be allowed, and what stops working without each. */
export const SLACK_SCOPES: Record<string, string> = {
  "app_mentions:read": "hear mentions of the bot",
  "chat:write": "answer",
  "im:history": "hear direct messages",
  "users:read": "show who asked",
  "channels:history": "follow a thread without being mentioned again",
  "groups:history": "follow a thread in a private channel without being mentioned again",
  "files:write": "post pictures",
};

/** The permissions a Slack app lacks, given the ones it has. */
export const missingScopes = (have: string[]): string[] => Object.keys(SLACK_SCOPES).filter((s) => !have.includes(s));
